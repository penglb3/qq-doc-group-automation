#!/usr/bin/env node
/**
 * group-digest.mjs — 一期：定时向多个 QQ 群发送固定文本「许愿池提醒」。
 *
 * 群列表来自 secrets QQ_GROUP_OPENID（英文逗号分隔，支持任意多个群）；
 * 文本默认读 .github/messages/xuyuanchi-reminder.txt，可用 --text / --text-file / DIGEST_TEXT 覆盖。
 *
 * 本地用法：
 *   node .github/scripts/group-digest.mjs --env-file ../env-secrets.sh --dry-run
 *   node .github/scripts/group-digest.mjs --env-file ../env-secrets.sh
 *   node .github/scripts/group-digest.mjs --text "测试" --group EEE7... --dry-run
 *
 * 常用参数：
 *   --dry-run          只打印将要发送的内容与群，不实际发送
 *   --text TEXT        覆盖消息文本
 *   --text-file FILE   从文件读消息文本（默认 .github/messages/xuyuanchi-reminder.txt）
 *   --group ID         指定群（可重复，也可逗号分隔），默认取 QQ_GROUP_OPENID
 *   --from-capture F   从 qq-capture-openid.mjs 产出的 JSON 里读群列表
 *   --env-file FILE    读取 export KEY="VALUE" 形式的 env 文件
 *   --no-lookup        不查询群名（省一次 API 调用）
 *   --show-text        日志里显示完整文案（默认在 GitHub Actions 里对链接打码）
 *
 * 环境变量：QQ_BOT_APP_ID / QQ_BOT_APP_SECRET（兼容 QQ_APP_ID / QQ_APP_SECRET）
 *           QQ_GROUP_OPENID 或 QQ_GROUP_OPENIDS（逗号/换行分隔）
 *           QQ_API_BASE 可选，默认 https://api.bot.qq.com
 *
 * 退出码：0 全部成功；1 有失败或有群发送失败；2 配置缺失。
 */
import process from 'node:process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fillTemplate,
  getAccessToken,
  getGroupInfo,
  loadEnvFile,
  parseArgs,
  parseGroupOpenids,
  readCredentials,
  redactEnvValues,
  sendGroupText,
  sleep,
  mask,
} from './qq-bot-api.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_TEXT_FILE = resolve(REPO_ROOT, '.github', 'messages', 'xuyuanchi-reminder.txt')
const DEFAULT_CAPTURE_FILE = resolve(REPO_ROOT, '.local', 'qq-openids.json')

const args = parseArgs()
const log = (m) => console.log(m)
const warn = (m) => console.warn(m)

if (args.help || args.h) {
  log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
  process.exit(0)
}

if (typeof args['env-file'] === 'string') {
  try {
    const keys = loadEnvFile(args['env-file'])
    log(`[digest] 从 ${args['env-file']} 载入：${keys.join(', ') || '(无新变量)'}`)
  } catch (err) {
    console.error(`[digest] 读取 env 文件失败：${err.message}`)
    process.exit(2)
  }
}

/** 统一的换行归一化：Windows 的 CRLF 在 QQ 里多出来的 \r 会造成显示异常 */
function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
}

function resolveText() {
  if (typeof args.text === 'string') return { text: normalizeText(args.text), from: '--text' }
  if (typeof args['text-file'] === 'string') {
    return { text: normalizeText(readFileSync(args['text-file'], 'utf8')), from: args['text-file'] }
  }
  if (process.env.DIGEST_TEXT) return { text: normalizeText(process.env.DIGEST_TEXT), from: 'env:DIGEST_TEXT' }
  if (!existsSync(DEFAULT_TEXT_FILE)) {
    console.error(`[digest] 找不到默认消息文件 ${DEFAULT_TEXT_FILE}`)
    process.exit(2)
  }
  return { text: normalizeText(readFileSync(DEFAULT_TEXT_FILE, 'utf8')), from: DEFAULT_TEXT_FILE }
}

function resolveGroups() {
  const fromArg = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--group' && process.argv[i + 1]) fromArg.push(process.argv[i + 1])
    else if (process.argv[i].startsWith('--group=')) fromArg.push(process.argv[i].slice('--group='.length))
  }
  if (fromArg.length) return { groups: parseGroupOpenids(fromArg.join(',')), from: '--group' }

  const fromEnv = parseGroupOpenids(process.env.QQ_GROUP_OPENID || process.env.QQ_GROUP_OPENIDS)
  if (fromEnv.length) return { groups: fromEnv, from: 'QQ_GROUP_OPENID' }

  const captureFile = typeof args['from-capture'] === 'string' ? args['from-capture'] : DEFAULT_CAPTURE_FILE
  if (existsSync(captureFile)) {
    try {
      const json = JSON.parse(readFileSync(captureFile, 'utf8'))
      const ids = parseGroupOpenids(
        json.qq_group_openid || (json.groups || []).map((g) => g.group_openid).join(','),
      )
      if (ids.length) return { groups: ids, from: captureFile }
    } catch (err) {
      warn(`[digest] 读取抓取结果 ${captureFile} 失败：${err.message}`)
    }
  }
  return { groups: [], from: '未配置' }
}

const { appId, appSecret } = readCredentials()
if (!appId || !appSecret) {
  console.error('[digest] 缺少 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET')
  process.exit(2)
}

const { text: rawText, from: textFrom } = resolveText()
// 文案里的文档链接用 {{QQ_DOC_FILE_ID}} / {{QQ_DOC_SHEET_ID}} 占位，运行时从 Secrets 注入，
// 仓库里不出现明文链接（仓库是公开的）。
const DOC_ENV_NAMES = ['QQ_DOC_FILE_ID', 'QQ_DOC_SHEET_ID']
let text = rawText
try {
  text = fillTemplate(rawText)
} catch (err) {
  console.error(`[digest] ${err.message}`)
  process.exit(2)
}
const { groups, from: groupsFrom } = resolveGroups()
const dryRun = Boolean(args['dry-run'])
const lookupNames = !args['no-lookup']
// 公开仓库的 Actions 日志是公开的：默认在 CI 里把链接里的 file/sheet id 打码，本地照常显示
const showFullText = Boolean(args['show-text']) || process.env.GITHUB_ACTIONS !== 'true'
const displayText = showFullText ? text : redactEnvValues(text, DOC_ENV_NAMES)

if (!text) {
  console.error('[digest] 消息文本为空')
  process.exit(2)
}
if (groups.length === 0) {
  console.error('[digest] 没有可发送的群：请配置 secrets QQ_GROUP_OPENID（英文逗号分隔），或用 --group 指定')
  process.exit(2)
}

log('================ 群消息推送（一期：许愿池提醒） ================')
log(`时间     : ${new Date().toISOString()}（本地 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`)
log(`模式     : ${dryRun ? 'DRY-RUN（只打印不发）' : '真实发送'}`)
log(`文本来源 : ${textFrom}`)
log(`群来源   : ${groupsFrom}，共 ${groups.length} 个群`)
log('---------------- 消息内容 ----------------')
log(displayText)
if (displayText !== text) log('（日志已对链接里的 file/sheet id 打码；本地运行时默认显示全文）')
log('------------------------------------------')

let token = ''
if (!dryRun) {
  try {
    token = await getAccessToken({ appId, appSecret, log })
  } catch (err) {
    console.error(`[digest] 取 access_token 失败：${err.message}`)
    process.exit(1)
  }
}

const results = []
for (const [index, groupOpenid] of groups.entries()) {
  const tag = `[${index + 1}/${groups.length}] ${mask(groupOpenid)}`
  let name = ''
  if (token && lookupNames) {
    const info = await getGroupInfo({ token, groupOpenid, log: () => {} })
    name = info?.group_name || info?.groupName || ''
    if (name) log(`${tag} 群名：${name}`)
  }
  if (dryRun) {
    log(`${tag} → 跳过发送（dry-run）`)
    results.push({ groupOpenid, ok: true, skipped: true })
    continue
  }
  const r = await sendGroupText({ token, groupOpenid, content: text, log })
  if (r.ok) {
    log(`${tag} ✅ 已发送（msg id=${r.json?.id ?? '-'}，msg_seq=${r.msgSeqUsed}）`)
  } else {
    warn(`${tag} ❌ 发送失败：err_code=${r.errCode ?? '-'} message=${r.message || '(无)'}`)
    if (r.errors) for (const e of r.errors) warn(`        ${e}`)
  }
  results.push({ groupOpenid, ok: r.ok, errCode: r.errCode, message: r.message, id: r.json?.id })
  // 群维度限流是 20 条/分钟，多个群之间留一点间隔，避免瞬间打满
  if (index < groups.length - 1) await sleep(1200)
}

const okCount = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
log('================ 汇总 ================')
log(`成功 ${okCount}/${results.length}${dryRun ? '（dry-run，未真实发送）' : ''}`)
for (const f of failed) {
  log(`失败：${mask(f.groupOpenid)} err_code=${f.errCode ?? '-'} ${f.message || ''}`)
}
if (!dryRun && failed.length) {
  log('提示：')
  log('  - 40034105/40034106 → 机器人无主动消息权限或该群被管理员关闭了通知')
  log('  - 40054100 → 主动消息超频，降低频率或稍后重试')
  log('  - 40054010 → 不允许发送 URL，需要把链接换成平台允许的形式')
  log('  - 40034101/40054003 → 机器人不在该群')
}
log('=====================================')
process.exit(failed.length ? 1 : 0)
