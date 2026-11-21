#!/usr/bin/env node
/**
 * group-settle.mjs — 二期：许愿池自动结算。
 *
 * 流程：
 *   1. 腾讯文档智能表 OpenAPI 拉字段 + 全部记录
 *   2. 按「类别」分组，按「总想要人数」降序取每组前 N（默认 3）条
 *   3. 按 .github/messages/xuyuanchi-settle.txt 模板拼文案（文档链接占位符运行时注入）
 *   4. 广播到 QQ_GROUP_OPENID 里的所有群
 *
 * 关于「总想要人数」——实测该列是公式列（COUNTA({取补集}) + 1），智能表 API 不返回公式值，
 * 所以这里用「+1 我也想要！」字段的 userId 去重计数 + 1（创建人）推算；若某行直接返回值则优先用返回值。
 * 需要“只算 +1、不加创建人”时加 --no-count-creator。
 *
 * 本地用法：
 *   node .github/scripts/group-settle.mjs --env-file ../env-secrets.sh --dry-run
 *   node .github/scripts/group-settle.mjs --env-file ../env-secrets.sh            # 真发
 *   node .github/scripts/group-settle.mjs --env-file ../env-secrets.sh --dry-run --print-table
 *
 * 常用参数：
 *   --dry-run           只计算 + 打印文案，不发送（仍会调用腾讯文档接口）
 *   --top N             每组取前 N 条（默认 3）
 *   --category-field S  类别列标题（默认 类别）
 *   --name-field S      娃名列标题（默认 娃名）
 *   --count-field S     人数列标题（默认 总想要人数，含公式列）
 *   --plusone-field S   +1 字段标题（默认 +1 我也想要！）
 *   --status-field S    状态列标题（默认 状态通知）
 *   --exclude-keyword S 已立项关键字，命中娃名或状态就跳过（默认 已立项）
 *   --keep-established  不过滤已立项（默认过滤）
 *   --no-count-creator  人数只数 +1，不再 +1 个创建人
 *   --text-file FILE    结算文案模板（默认 .github/messages/xuyuanchi-settle.txt）
 *   --group ID          指定群（可重复/逗号分隔），默认取 QQ_GROUP_OPENID
 *   --env-file FILE     读取 export KEY="VALUE" 形式的 env 文件
 *   --print-table       打印每个类别的前 N（调试用）
 *   --out-json FILE     把计算结果写成 JSON（调试用）
 *   --no-preflight / --no-lookup / --allow-partial / --show-text  同一期脚本
 *
 * 环境变量：QQ_BOT_APP_ID / QQ_BOT_APP_SECRET / QQ_GROUP_OPENID
 *           QQ_DOC_ACCESS_TOKEN / QQ_DOC_CLIENT_ID / QQ_DOC_OPEN_ID / QQ_DOC_FILE_ID / QQ_DOC_SHEET_ID
 *
 * 退出码：0 成功；1 发送失败/被跳过；2 配置或数据异常。
 */
import process from 'node:process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fillTemplate,
  getAccessToken,
  loadEnvFile,
  parseArgs,
  readCredentials,
  redactEnvValues,
} from './qq-bot-api.mjs'
import { broadcastText, printBroadcastSummary, resolveGroupList } from './qq-broadcast.mjs'
import {
  assertDocConfig,
  cellNumber,
  cellText,
  findField,
  getAllFields,
  getAllRecords,
  readDocConfig,
} from './qq-doc-smartsheet.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_TEMPLATE = resolve(REPO_ROOT, '.github', 'messages', 'xuyuanchi-settle.txt')
const MEDALS = ['🥇', '🥈', '🥉']

const args = parseArgs()
const log = (m) => console.log(m)
const warn = (m) => console.warn(m)

if (typeof args['env-file'] === 'string') {
  try {
    const keys = loadEnvFile(args['env-file'])
    log(`[settle] 从 ${args['env-file']} 载入：${keys.join(', ') || '(无新变量)'}`)
  } catch (err) {
    console.error(`[settle] 读取 env 文件失败：${err.message}`)
    process.exit(2)
  }
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
}

const { appId, appSecret } = readCredentials()
if (!appId || !appSecret) {
  console.error('[settle] 缺少 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET')
  process.exit(2)
}

const docCfg = readDocConfig()
try {
  assertDocConfig(docCfg)
} catch (err) {
  console.error(`[settle] ${err.message}`)
  process.exit(2)
}

const TOP_N = Math.max(1, Number(args.top ?? 3) || 3)
const COUNT_CREATOR = !args['no-count-creator']
const TEMPLATE_FILE = typeof args['text-file'] === 'string' ? args['text-file'] : DEFAULT_TEMPLATE
const DRY_RUN = Boolean(args['dry-run'])
const PREFLIGHT = !args['no-preflight']
const LOOKUP = !args['no-lookup']
const ALLOW_PARTIAL = Boolean(args['allow-partial'])
const PRINT_TABLE = Boolean(args['print-table'])
const OUT_JSON = typeof args['out-json'] === 'string' ? args['out-json'] : ''
const SHOW_TEXT = Boolean(args['show-text']) || process.env.GITHUB_ACTIONS !== 'true'
const DOC_ENV_NAMES = ['QQ_DOC_FILE_ID', 'QQ_DOC_SHEET_ID']
const FIELD_NAMES = {
  category: typeof args['category-field'] === 'string' ? args['category-field'] : '类别',
  name: typeof args['name-field'] === 'string' ? args['name-field'] : '娃名',
  count: typeof args['count-field'] === 'string' ? args['count-field'] : '总想要人数',
  plusOne: typeof args['plusone-field'] === 'string' ? args['plusone-field'] : '+1 我也想要！',
  status: typeof args['status-field'] === 'string' ? args['status-field'] : '状态通知',
}
// 已立项的娃不再进许愿池结算（默认按「已立项」关键字过滤娃名和状态通知两列）
const KEEP_ESTABLISHED = Boolean(args['keep-established'])
const EXCLUDE_KEYWORD = typeof args['exclude-keyword'] === 'string' ? args['exclude-keyword'] : '已立项'

/** 「+1 我也想要！」字段是 userId 数组，按 userId 去重 */
function plusOneUsers(value) {
  if (!Array.isArray(value)) return []
  const ids = new Set()
  for (const item of value) {
    const id = typeof item === 'object' && item ? (item.userId ?? item.id ?? JSON.stringify(item)) : String(item)
    if (id) ids.add(String(id))
  }
  return [...ids]
}

async function main() {
  log('================ 许愿池结算（二期） ================')
  log(`时间     : ${new Date().toISOString()}（本地 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`)
  log(`模式     : ${DRY_RUN ? 'DRY-RUN（只计算不发）' : '真实发送'}`)
  log(`每组 Top : ${TOP_N}；人数口径：${COUNT_CREATOR ? '+1 去重人数 + 创建人' : '仅 +1 去重人数'}`)

  // 1. 拉字段与记录
  const fields = await getAllFields(docCfg, { log })
  log(`[settle] 字段 ${fields.length} 个：${fields.map((f) => f.fieldTitle).join(' / ')}`)

  const categoryField = findField(fields, FIELD_NAMES.category)
  const nameField = findField(fields, FIELD_NAMES.name)
  const countField = findField(fields, FIELD_NAMES.count)
  const plusOneField = findField(fields, FIELD_NAMES.plusOne)
  const statusField = findField(fields, FIELD_NAMES.status)

  if (!categoryField) throw new Error(`找不到「类别」字段（${FIELD_NAMES.category}）`)
  if (!nameField) throw new Error(`找不到「娃名」字段（${FIELD_NAMES.name}）`)
  if (!plusOneField) throw new Error(`找不到「+1」字段（${FIELD_NAMES.plusOne}）`)
  log(`[settle] 使用字段：类别=${categoryField.fieldTitle} / 娃名=${nameField.fieldTitle} / 人数=${countField ? countField.fieldTitle : '(用 +1 推算)'} / +1=${plusOneField.fieldTitle} / 状态=${statusField ? statusField.fieldTitle : '(无)'}`)
  log(`[settle] 已立项过滤：${KEEP_ESTABLISHED ? '关闭（保留全部记录）' : `开启（关键字「${EXCLUDE_KEYWORD}」）`}`)

  const { records, total } = await getAllRecords(docCfg, { log })
  log(`[settle] 记录 ${records.length} 条（total=${total ?? '-'}）`)

  // 2. 归一化
  let fromFormula = 0
  let computed = 0
  let skippedEmptyName = 0
  let skippedNoCategory = 0
  let skippedEstablished = 0
  const rows = []
  for (const r of records) {
    const values = r.values || {}
    const name = cellText(values[nameField.fieldTitle])
    if (!name) {
      skippedEmptyName += 1
      continue
    }
    const category = cellText(values[categoryField.fieldTitle])
    if (!category) {
      skippedNoCategory += 1
      continue
    }
    // 已立项的娃不再参与许愿池结算（娃名或状态通知命中关键字即跳过）
    const status = statusField ? cellText(values[statusField.fieldTitle]) : ''
    if (!KEEP_ESTABLISHED && EXCLUDE_KEYWORD && (name.includes(EXCLUDE_KEYWORD) || status.includes(EXCLUDE_KEYWORD))) {
      skippedEstablished += 1
      continue
    }
    let count
    const rawCount = countField ? values[countField.fieldTitle] : undefined
    const formulaValue = rawCount === undefined || rawCount === null ? NaN : cellNumber(rawCount)
    if (Number.isFinite(formulaValue) && rawCount !== undefined && rawCount !== null && formulaValue > 0) {
      count = formulaValue
      fromFormula += 1
    } else {
      const users = plusOneUsers(values[plusOneField.fieldTitle])
      count = users.length + (COUNT_CREATOR ? 1 : 0)
      computed += 1
    }
    rows.push({ recordID: r.recordID, category, name, count })
  }
  log(`[settle] 有效记录 ${rows.length} 条；人数来源：公式值 ${fromFormula} 条 / +1 推算 ${computed} 条`)
  if (skippedEstablished) log(`[settle] 跳过已立项 ${skippedEstablished} 条`)
  if (skippedEmptyName) log(`[settle] 跳过无娃名 ${skippedEmptyName} 条`)
  if (skippedNoCategory) log(`[settle] 跳过无类别 ${skippedNoCategory} 条`)
  if (rows.length === 0) throw new Error('没有可用记录（检查字段名是否匹配）')

  // 3. 分组 + 排序（组内按人数降序，稳定排序保留表内原有顺序；类别按第一名人数降序）
  const groups = new Map()
  for (const row of rows) {
    if (!groups.has(row.category)) groups.set(row.category, [])
    groups.get(row.category).push(row)
  }
  const ranked = [...groups.entries()].map(([category, list], index) => {
    const sorted = [...list].sort((a, b) => b.count - a.count)
    return { category, total: list.length, top: sorted.slice(0, TOP_N), firstIndex: index }
  })
  ranked.sort((a, b) => (b.top[0]?.count ?? 0) - (a.top[0]?.count ?? 0) || a.firstIndex - b.firstIndex)
  log(`[settle] 类别 ${ranked.length} 个（按第一名人数降序）：${ranked.map((g) => `${g.category}(${g.total} 条/最高 ${g.top[0]?.count ?? 0})`).join(' / ')}`)

  if (PRINT_TABLE || DRY_RUN) {
    for (const g of ranked) {
      log(`--- ${g.category}（共 ${g.total} 条，前 ${g.top.length}）---`)
      g.top.forEach((row, i) => log(`  ${MEDALS[i] || `${i + 1}.`} ${row.name}: ${row.count}人`))
    }
  }

  // 4. 拼文案
  const body = ranked
    .map((g) =>
      [
        `${g.category}：`,
        ...g.top.map((row, i) => `${MEDALS[i] || `${i + 1}.`}${row.name}: ${row.count}人`),
      ].join('\n'),
    )
    .join('\n\n')

  if (!existsSync(TEMPLATE_FILE)) throw new Error(`找不到结算文案模板：${TEMPLATE_FILE}`)
  const template = normalizeText(readFileSync(TEMPLATE_FILE, 'utf8'))
  let text
  try {
    text = fillTemplate(template, { vars: { SETTLE_BODY: body } })
  } catch (err) {
    throw new Error(`${err.message}（结算文案需要 QQ_DOC_FILE_ID / QQ_DOC_SHEET_ID）`)
  }

  const displayText = SHOW_TEXT ? text : redactEnvValues(text, DOC_ENV_NAMES)
  log('---------------- 消息内容 ----------------')
  log(displayText)
  if (displayText !== text) log('（日志已对链接里的 file/sheet id 打码）')
  log('------------------------------------------')

  if (OUT_JSON) {
    const payload = {
      generatedAt: new Date().toISOString(),
      top: TOP_N,
      countMode: COUNT_CREATOR ? 'plusone+creator' : 'plusone',
      groups: ranked.map((g) => ({
        category: g.category,
        total: g.total,
        top: g.top.map((row) => ({ recordID: row.recordID, name: row.name, count: row.count })),
      })),
      text,
    }
    writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    log(`[settle] 计算结果已写入 ${OUT_JSON}`)
  }

  // 5. 发送
  const { groups: targetGroups, from: groupsFrom } = resolveGroupList({ argv: process.argv.slice(2), args })
  if (targetGroups.length === 0) {
    console.error('[settle] 没有可发送的群：请配置 secrets QQ_GROUP_OPENID，或用 --group 指定')
    process.exit(2)
  }
  log(`[settle] 群来源：${groupsFrom}，共 ${targetGroups.length} 个群`)

  let token = ''
  if (!DRY_RUN || PREFLIGHT) {
    try {
      token = await getAccessToken({ appId, appSecret, log })
    } catch (err) {
      if (!DRY_RUN) {
        console.error(`[settle] 取 access_token 失败：${err.message}`)
        process.exit(1)
      }
      warn(`[settle] 预检跳过：${err.message}`)
    }
  }

  const { okCount, blocked, failed, exitCode } = await broadcastText({
    token,
    groups: targetGroups,
    text,
    dryRun: DRY_RUN,
    preflight: PREFLIGHT,
    lookupNames: LOOKUP,
    allowPartial: ALLOW_PARTIAL,
    log,
    warn,
  })
  printBroadcastSummary({ okCount, blocked, failed, total: targetGroups.length, dryRun: DRY_RUN, allowPartial: ALLOW_PARTIAL, log })
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(`[settle] 失败：${err.message}`)
  process.exit(2)
})
