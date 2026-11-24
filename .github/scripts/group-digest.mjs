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
 *   --dry-run          只做预检并打印将要发送的内容与群，不实际发送
 *   --text TEXT        覆盖消息文本
 *   --text-file FILE   从文件读消息文本（默认 .github/messages/xuyuanchi-reminder.txt）
 *   --group ID         指定群（可重复，也可逗号分隔），默认取 QQ_GROUP_OPENID
 *   --min-members N    只通知 group_member_num >= N 的群（默认 0 = 不限制；也可用环境变量 MIN_MEMBERS）
 *   --from-capture F   从 qq-capture-openid.mjs 产出的 JSON 里读群列表
 *   --env-file FILE    读取 export KEY="VALUE" 形式的 env 文件
 *   --no-lookup        不查询群名（省一次 API 调用）
 *   --no-preflight     不预检群内状态（默认会查 allow_proactive_msg，提前挑出没开主动推送的群）
 *   --allow-partial    有群被跳过/失败时仍返回 0（默认返回 1，让 Actions 变红提醒）
 *   --show-text        日志里显示完整文案（默认在 GitHub Actions 里对链接打码）
 *
 * 环境变量：QQ_BOT_APP_ID / QQ_BOT_APP_SECRET（兼容 QQ_APP_ID / QQ_APP_SECRET）
 *           QQ_GROUP_OPENID 或 QQ_GROUP_OPENIDS（逗号/换行分隔）
 *           QQ_DOC_FILE_ID / QQ_DOC_SHEET_ID（拼文案里的文档链接）
 *           QQ_API_BASE 可选，默认 https://api.bot.qq.com
 *
 * 退出码：0 全部成功；1 有失败或有群被跳过；2 配置缺失。
 */
import process from 'node:process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAccessToken, fillTemplate, loadEnvFile, parseArgs, readCredentials, redactEnvValues } from './qq-bot-api.mjs'
import { broadcastText, parseMinMembers, printBroadcastSummary, resolveGroupList } from './qq-broadcast.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_TEXT_FILE = resolve(REPO_ROOT, '.github', 'messages', 'xuyuanchi-reminder.txt')

const args = parseArgs()
const log = (m) => console.log(m)
const warn = (m) => console.warn(m)

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
const { groups, from: groupsFrom } = resolveGroupList({ argv: process.argv.slice(2), args })
const dryRun = Boolean(args['dry-run'])
const preflight = !args['no-preflight']
const allowPartial = Boolean(args['allow-partial'])
const lookupNames = !args['no-lookup']
let minMembers = 0
try {
  minMembers = parseMinMembers(args['min-members'] ?? process.env.MIN_MEMBERS)
} catch (err) {
  console.error(`[digest] ${err.message}`)
  process.exit(2)
}
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
log(`人数阈值 : ${minMembers > 0 ? `>= ${minMembers} 人（低于阈值的群不通知）` : '不限制'}`)
log('---------------- 消息内容 ----------------')
log(displayText)
if (displayText !== text) log('（日志已对链接里的 file/sheet id 打码；本地运行时默认显示全文）')
log('------------------------------------------')

let token = ''
if (!dryRun || preflight || minMembers > 0) {
  try {
    token = await getAccessToken({ appId, appSecret, log })
  } catch (err) {
    if (!dryRun) {
      console.error(`[digest] 取 access_token 失败：${err.message}`)
      process.exit(1)
    }
    warn(`[digest] 预检跳过：${err.message}`)
  }
}

const { okCount, blocked, skippedBySize, failed, exitCode } = await broadcastText({
  token,
  groups,
  text,
  dryRun,
  preflight,
  lookupNames,
  allowPartial,
  minMembers,
  log,
  warn,
})

printBroadcastSummary({ okCount, blocked, skippedBySize, failed, total: groups.length, dryRun, allowPartial, log })
process.exit(exitCode)
