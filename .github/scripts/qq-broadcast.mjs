#!/usr/bin/env node
/**
 * qq-broadcast.mjs — 把一段文本广播到多个 QQ 群（一期提醒 / 二期结算共用）。
 *
 * 负责：解析群列表（--group / QQ_GROUP_OPENID / 抓取结果 JSON）、查群名、
 *      按群人数阈值过滤（--min-members / MIN_MEMBERS）、预检 allow_proactive_msg、
 *      逐群发送（带间隔）、汇总结果与退出码。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getGroupBotState,
  getGroupInfo,
  parseGroupOpenids,
  sendGroupText,
  sleep,
  mask,
} from './qq-bot-api.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
export const DEFAULT_CAPTURE_FILE = resolve(REPO_ROOT, '.local', 'qq-openids.json')

/**
 * 解析要发往哪些群，优先级：--group 参数 > QQ_GROUP_OPENID/QQ_GROUP_OPENIDS > 抓取结果 JSON。
 * 返回 { groups: string[], from: string }
 */
export function resolveGroupList({ argv = [], args = {}, env = process.env } = {}) {
  const fromArg = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--group' && argv[i + 1]) fromArg.push(argv[i + 1])
    else if (a.startsWith('--group=')) fromArg.push(a.slice('--group='.length))
  }
  if (fromArg.length) return { groups: parseGroupOpenids(fromArg.join(',')), from: '--group' }

  const fromEnv = parseGroupOpenids(env.QQ_GROUP_OPENID || env.QQ_GROUP_OPENIDS)
  if (fromEnv.length) return { groups: fromEnv, from: 'QQ_GROUP_OPENID' }

  const captureFile = typeof args['from-capture'] === 'string' ? args['from-capture'] : DEFAULT_CAPTURE_FILE
  if (existsSync(captureFile)) {
    try {
      const json = JSON.parse(readFileSync(captureFile, 'utf8'))
      const ids = parseGroupOpenids(
        json.qq_group_openid || (json.groups || []).map((g) => g.group_openid).join(','),
      )
      if (ids.length) return { groups: ids, from: captureFile }
    } catch { /* 读坏了就当没配置 */ }
  }
  return { groups: [], from: '未配置' }
}

/**
 * 解析「群人数阈值」：--min-members / MIN_MEMBERS。
 * 0（或空）= 不限制；非法值直接抛错，避免把 500 写成 5oo 后静默变成“不限制”。
 */
export function parseMinMembers(value) {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`群人数阈值需要非负整数，收到：${value}`)
  }
  return Math.floor(n)
}

/**
 * 逐群广播文本。
 * - minMembers：只发给 group_member_num >= 阈值的群（0 = 不限制；查不到人数时按不限制处理）
 * - preflight：先查 allow_proactive_msg，群主没开主动推送的直接跳过（避免 40034105）
 * - dryRun：只预检 + 打印，不发
 * 返回 { results, okCount, blocked, skippedBySize, failed, exitCode }
 */
export async function broadcastText({
  token,
  groups,
  text,
  dryRun = false,
  preflight = true,
  lookupNames = true,
  allowPartial = false,
  minMembers = 0,
  gapMs = 1200,
  log = () => {},
  warn = () => {},
} = {}) {
  const results = []
  for (const [index, groupOpenid] of groups.entries()) {
    const tag = `[${index + 1}/${groups.length}] ${mask(groupOpenid)}`

    // 群名和群人数来自同一个 info 接口，需要时只查一次
    let info = null
    if (token && (lookupNames || minMembers > 0)) {
      info = await getGroupInfo({ token, groupOpenid, log: () => {} })
      const name = info?.group_name || info?.groupName || ''
      if (name) log(`${tag} 群名：${name}`)
    }
    const rawMemberNum = info?.group_member_num
    const memberNum = rawMemberNum === undefined || rawMemberNum === null || rawMemberNum === ''
      ? null
      : (Number.isFinite(Number(rawMemberNum)) ? Number(rawMemberNum) : null)

    if (minMembers > 0) {
      if (memberNum === null) {
        // 查不到就按“不限制”走，宁可多打扰一次也不要漏掉大群的通知
        warn(`${tag} ⚠ 没拿到 group_member_num，按不限制处理，继续发送`)
      } else if (memberNum < minMembers) {
        log(`${tag} ⏭ 跳过：群人数 ${memberNum} < 阈值 ${minMembers}`)
        results.push({
          groupOpenid,
          groupName: info?.group_name || '',
          memberNum,
          ok: false,
          skippedBySize: true,
        })
        continue
      } else {
        log(`${tag} 群人数 ${memberNum} ≥ 阈值 ${minMembers}`)
      }
    }

    let botState = null
    if (token && preflight) {
      botState = await getGroupBotState({ token, groupOpenid, log: warn })
      if (botState) {
        log(`${tag} 群内状态：allow_proactive_msg=${botState.allow_proactive_msg} recv_msg_setting=${botState.recv_msg_setting || '(空)'} role=${botState.member_role || '-'}`)
      }
    }

    if (botState && botState.allow_proactive_msg === false) {
      warn(`${tag} ⛔ 跳过：该群未允许机器人主动推送（allow_proactive_msg=false）`)
      warn('        需要群主/管理员在群内找到机器人 → 资料页右上角设置 → 打开「主动推送/消息推送」开关')
      results.push({
        groupOpenid,
        groupName: info?.group_name || '',
        memberNum,
        ok: false,
        blocked: true,
        errCode: 40034105,
        message: '群主未开启主动消息（allow_proactive_msg=false）',
      })
      continue
    }

    if (dryRun) {
      log(`${tag} → 跳过发送（dry-run）`)
      results.push({ groupOpenid, groupName: info?.group_name || '', memberNum, ok: true, skipped: true })
      continue
    }

    const r = await sendGroupText({ token, groupOpenid, content: text, log })
    if (r.ok) {
      log(`${tag} ✅ 已发送（msg id=${r.json?.id ?? '-'}，msg_seq=${r.msgSeqUsed}）`)
    } else {
      warn(`${tag} ❌ 发送失败：err_code=${r.errCode ?? '-'} message=${r.message || '(无)'}`)
      if (r.errors) for (const e of r.errors) warn(`        ${e}`)
    }
    results.push({
      groupOpenid,
      groupName: info?.group_name || '',
      memberNum,
      ok: r.ok,
      errCode: r.errCode,
      message: r.message,
      id: r.json?.id,
    })

    // 群维度限流是 20 条/分钟，多个群之间留一点间隔
    if (index < groups.length - 1) await sleep(gapMs)
  }

  const okCount = results.filter((r) => r.ok).length
  const blocked = results.filter((r) => r.blocked)
  // 人数不足是“按配置主动跳过”，不算失败，不影响退出码
  const skippedBySize = results.filter((r) => r.skippedBySize)
  const failed = results.filter((r) => !r.ok && !r.blocked && !r.skippedBySize)
  const hardFail = failed.length > 0 || (blocked.length > 0 && (!allowPartial || okCount === 0))
  return { results, okCount, blocked, skippedBySize, failed, exitCode: hardFail ? 1 : 0 }
}

/** 打印统一的汇总块（各脚本共用，文案略有差别） */
export function printBroadcastSummary({
  okCount,
  blocked,
  failed,
  skippedBySize = [],
  total,
  dryRun,
  allowPartial,
  log = console.log,
}) {
  log('================ 汇总 ================')
  log(
    `成功 ${okCount}/${total}${dryRun ? '（dry-run，未真实发送）' : ''}` +
      (blocked.length ? `，跳过 ${blocked.length} 个未开主动推送的群` : '') +
      (skippedBySize.length ? `，${skippedBySize.length} 个群人数低于阈值未通知` : ''),
  )
  for (const s of skippedBySize) {
    log(`跳过（人数不足）：${mask(s.groupOpenid)}${s.groupName ? ` ${s.groupName}` : ''}，${s.memberNum ?? '?'} 人`)
  }
  for (const b of blocked) {
    log(`跳过：${mask(b.groupOpenid)} 群主未开启主动消息（allow_proactive_msg=false）`)
  }
  for (const f of failed) {
    log(`失败：${mask(f.groupOpenid)} err_code=${f.errCode ?? '-'} ${f.message || ''}`)
  }
  if (failed.length) {
    log('提示：')
    log('  - 40034105/40034106 → 机器人无主动消息权限或该群被管理员关闭了通知')
    log('  - 40054100 → 主动消息超频，降低频率或稍后重试')
    log('  - 40054010 → 不允许发送 URL，需要把链接换成平台允许的形式')
    log('  - 40034101/40054003 → 机器人不在该群')
  }
  if (blocked.length && !allowPartial) log('（有群被跳过时退出码为 1；只想“至少一个群成功”就算通过可加 --allow-partial）')
  log('=====================================')
}
