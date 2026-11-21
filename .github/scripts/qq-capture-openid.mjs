#!/usr/bin/env node
/**
 * qq-capture-openid.mjs — 一次性工具：抓取 QQ 群的 group_openid。
 *
 * 背景：QQ 官方机器人发群消息需要 group_openid，而它只在「群里有事件」时才下发给机器人
 *（例如有人 @机器人），开放平台控制台不直接展示。
 *
 * 本脚本连接官方 WebSocket 网关，订阅 GROUP_AND_C2C_EVENT(1<<25)：
 *   1. 把机器人拉进群（或在群里发任意一条「@机器人 你好」）
 *   2. 脚本打印 group_openid（顺带查一下群名），拿去配 GitHub secrets：QQ_GROUP_OPENID
 *   3. 多个群：在各群分别 @机器人 一次即可，脚本会去重收集；也可用 --expect N 提前结束
 *
 * 用法（Node >= 22）：
 *   node .github/scripts/qq-capture-openid.mjs --env-file ../env-secrets.sh
 *   QQ_BOT_APP_ID=xxx QQ_BOT_APP_SECRET=xxx node .github/scripts/qq-capture-openid.mjs
 *   node .github/scripts/qq-capture-openid.mjs <APP_ID> <APP_SECRET>
 *
 * 常用参数：
 *   --seconds N      最长监听秒数（默认 900）
 *   --expect N       抓够 N 个群就自动退出（默认 0 = 不限，直到超时）
 *   --idle-exit N    至少抓到 1 个群后，N 秒没有新群就退出（默认 240，0 = 关闭）
 *   --out FILE       把结果写成 JSON（默认不写）
 *   --verbose        打印完整事件 JSON（排查用，含昵称等，注意隐私）
 *   --env-file FILE  读取 `export KEY="VALUE"` 形式的 env 文件（不覆盖已有环境变量）
 *
 * 退出码：0 = 抓到；2 = 超时/空闲退出但一个都没抓到；1 = 凭证或连接错误。
 */
import process from 'node:process'
import { writeFileSync } from 'node:fs'
import {
  getAccessToken,
  getGatewayUrl,
  getGroupInfo,
  loadEnvFile,
  parseArgs,
  mask,
  INTENT_GROUP_AND_C2C_EVENT,
} from './qq-bot-api.mjs'

const HELP = `用法：node .github/scripts/qq-capture-openid.mjs [选项]
  --env-file FILE  读取 export KEY="VALUE" 形式的 env 文件
  --seconds N      最长监听秒数（默认 900）
  --expect N       抓够 N 个群后退出（默认 0 = 不限）
  --idle-exit N    抓到群之后 N 秒无新群则退出（默认 240，0 = 关闭）
  --out FILE       结果写入 JSON 文件
  --verbose        打印完整事件 JSON
  -h, --help       显示本帮助
也支持：QQ_BOT_APP_ID=xxx QQ_BOT_APP_SECRET=xxx 环境变量，或 <APP_ID> <APP_SECRET> 位置参数。`

const args = parseArgs()
if (args.help || args.h) {
  console.log(HELP)
  process.exit(0)
}

if (typeof args['env-file'] === 'string') {
  try {
    const keys = loadEnvFile(args['env-file'])
    console.log(`[capture] 从 ${args['env-file']} 载入：${keys.join(', ') || '(无新变量)'}`)
  } catch (err) {
    console.error(`[capture] 读取 env 文件失败：${err.message}`)
    process.exit(1)
  }
}

const APP_ID = args._[0] || process.env.QQ_BOT_APP_ID || process.env.QQ_APP_ID || ''
const APP_SECRET = args._[1] || process.env.QQ_BOT_APP_SECRET || process.env.QQ_APP_SECRET || ''
if (!APP_ID || !APP_SECRET) {
  console.error(HELP)
  process.exit(1)
}

const SECONDS = Math.max(10, Number(args.seconds ?? 900) || 900)
const EXPECT = Math.max(0, Number(args.expect ?? 0) || 0)
const IDLE_EXIT = Math.max(0, Number(args['idle-exit'] ?? 240) || 0)
const OUT_FILE = typeof args.out === 'string' ? args.out : ''
const VERBOSE = Boolean(args.verbose)

const startedAt = Date.now()
const deadline = startedAt + SECONDS * 1000

/** groupOpenid -> { groupOpenid, groupName, source, member, firstSeenAt } */
const captured = new Map()
let lastCaptureAt = 0
let finished = false
let ws = null
let heartbeatTimer = null
let tickTimer = null
let reconnectTimer = null
let latestSeq = null
let token = ''
let gatewayUrl = ''
let connectionAttempt = 0

const log = (msg) => console.log(`[capture] ${msg}`)

function nowIso() {
  return new Date().toISOString().replace('T', ' ').replace('Z', 'Z')
}

function remaining() {
  return Math.max(0, Math.round((deadline - Date.now()) / 1000))
}

async function registerGroup(groupOpenid, source, detail = {}) {
  if (!groupOpenid) return
  if (captured.has(groupOpenid)) return
  captured.set(groupOpenid, {
    groupOpenid,
    groupName: '',
    source,
    member: detail.member || '',
    firstSeenAt: new Date().toISOString(),
  })
  lastCaptureAt = Date.now()

  const index = captured.size
  console.log('')
  console.log('┌──────────────────────────────────────────────────────────────')
  console.log(`│ ✅ 抓到第 ${index} 个群`)
  console.log(`│    事件来源 : ${source}`)
  if (detail.member) console.log(`│    触发成员 : ${detail.member}`)
  console.log(`│    group_openid = ${groupOpenid}`)

  // 查群名，方便确认是哪个群（接口 30 QPM，正常场景无压力）
  const info = await getGroupInfo({ token, groupOpenid, log })
  const name = info?.group_name || info?.groupName || ''
  if (name) {
    captured.get(groupOpenid).groupName = name
    console.log(`│    群名称     : ${name}`)
  } else if (info) {
    console.log(`│    群名称     : （接口未返回群名，字段：${Object.keys(info).join('/')}）`)
  } else {
    console.log('│    群名称     : （查询失败，不影响 openid 使用）')
  }
  console.log('└──────────────────────────────────────────────────────────────')
  console.log('')

  if (EXPECT > 0 && captured.size >= EXPECT) {
    finish(0, `已抓够 ${EXPECT} 个群`)
  }
}

function dumpSummary() {
  console.log('')
  console.log('================ 抓取结果 ================')
  if (captured.size === 0) {
    console.log('（一个群都没抓到）')
    return
  }
  let i = 0
  for (const g of captured.values()) {
    i += 1
    const label = g.groupName ? `${g.groupName}` : '(未知群名)'
    console.log(`${i}. ${label}`)
    console.log(`   group_openid : ${g.groupOpenid}`)
    console.log(`   来源         : ${g.source}${g.member ? ` / ${g.member}` : ''}  @ ${g.firstSeenAt}`)
  }
  console.log('')
  console.log('配置到 GitHub：Settings → Secrets and variables → Actions → Secrets')
  console.log('  Name : QQ_GROUP_OPENID')
  console.log(`  Value: ${[...captured.keys()].join(',')}`)
  console.log('（多个群用英文逗号分隔，一行即可）')
  console.log('==========================================')
}

async function finish(code, reason = '') {
  if (finished) return
  finished = true
  if (reason) log(`结束：${reason}`)
  clearInterval(heartbeatTimer)
  clearInterval(tickTimer)
  clearTimeout(reconnectTimer)
  try { ws?.close() } catch { /* ignore */ }

  dumpSummary()

  const result = {
    appId: APP_ID,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    reason: reason || (code === 0 ? 'ok' : 'timeout'),
    groups: [...captured.values()].map((g) => ({
      group_openid: g.groupOpenid,
      group_name: g.groupName,
      source: g.source,
      member: g.member,
      first_seen_at: g.firstSeenAt,
    })),
    qq_group_openid: [...captured.keys()].join(','),
  }
  if (OUT_FILE) {
    try {
      writeFileSync(OUT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      console.log(`[capture] 结果已写入 ${OUT_FILE}`)
    } catch (err) {
      console.error(`[capture] 写入 ${OUT_FILE} 失败：${err.message}`)
    }
  }
  process.exit(code)
}

function extractDetail(t, d) {
  const author = d?.author || {}
  const member = author.member_nickname || author.username || author.member_openid || author.id || ''
  return { member, eventType: t }
}

function handleDispatch(t, d) {
  if (VERBOSE) console.log(`[capture] 事件 ${t}：${JSON.stringify(d)}`)
  else log(`收到事件 ${t}${d?.group_openid ? `（群 ${mask(d.group_openid)}）` : ''}`)

  // 任何带 group_openid 的事件都能用来取群 openid：
  // GROUP_AT_MESSAGE_CREATE / GROUP_ADD_ROBOT / GROUP_MSG_RECEIVE / GROUP_MESSAGE_CREATE ...
  const groupOpenid = d?.group_openid
  if (!groupOpenid) return
  const { member } = extractDetail(t, d)
  registerGroup(groupOpenid, t, { member }).catch((err) => {
    console.error(`[capture] 登记群失败：${err.message}`)
  })
}

function send(payload) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload))
  } catch (err) {
    log(`发送失败：${err.message}`)
  }
}

function identify() {
  log(`鉴权中（intents=${INTENT_GROUP_AND_C2C_EVENT}，shard=[0,1]）…`)
  send({
    op: 2,
    d: {
      token: `QQBot ${token}`,
      intents: INTENT_GROUP_AND_C2C_EVENT,
      shard: [0, 1],
      properties: { $os: process.platform, $browser: 'qq-doc-group-automation', $device: 'qq-capture-openid' },
    },
  })
}

function startHeartbeat(intervalMs) {
  clearInterval(heartbeatTimer)
  const period = Math.max(5000, intervalMs - 3000)
  heartbeatTimer = setInterval(() => send({ op: 1, d: latestSeq }), period)
}

function connect() {
  if (finished) return
  if (Date.now() >= deadline) {
    finish(captured.size > 0 ? 0 : 2, '监听窗口结束')
    return
  }
  connectionAttempt += 1
  const urls = [gatewayUrl, 'wss://api.bot.qq.com/websocket', 'wss://api.sgroup.qq.com/websocket'].filter(Boolean)
  const url = urls[(connectionAttempt - 1) % urls.length]
  log(`连接网关 ${url}（第 ${connectionAttempt} 次）…`)

  let socket
  try {
    socket = new WebSocket(url)
  } catch (err) {
    log(`创建 WebSocket 失败：${err.message}`)
    scheduleReconnect()
    return
  }
  ws = socket

  socket.onopen = () => log('WebSocket 已连接，等待 Hello…')

  socket.onmessage = (ev) => {
    let p
    try {
      p = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (p.s !== undefined && p.s !== null) latestSeq = p.s

    switch (p.op) {
      case 10: {
        const interval = Number(p.d?.heartbeat_interval) || 45000
        log(`Hello 收到，心跳周期 ${interval}ms`)
        startHeartbeat(interval)
        identify()
        break
      }
      case 11:
        // 心跳 ACK，静默
        break
      case 0: {
        if (p.t === 'READY') {
          const name = p.d?.user?.username || '(未知)'
          log(`✅ 已上线：${name}（session ${p.d?.session_id ?? '-'}）`)
          log(`请现在到群里发「@机器人 任意内容」；机器人刚进群的话会自动收到 GROUP_ADD_ROBOT。`)
          log(`监听中… 最长 ${remaining()}s；Ctrl+C 可提前结束并打印结果。`)
          break
        }
        if (p.t === 'RESUMED') {
          log('会话已恢复')
          break
        }
        handleDispatch(p.t, p.d)
        break
      }
      case 7:
        log('服务端要求重连（op=7），3s 后重连…')
        teardownSocket()
        reconnectTimer = setTimeout(connect, 3000)
        break
      case 9:
        log(`鉴权失败/invalid session（op=9, d=${JSON.stringify(p.d)}）`)
        break
      default:
        if (p.op !== 1) log(`收到未处理的 op=${p.op}`)
        break
    }
  }

  socket.onerror = (ev) => {
    log(`WebSocket 错误：${ev?.message || ev?.error?.message || '(无详情)'}`)
  }

  socket.onclose = (ev) => {
    clearInterval(heartbeatTimer)
    if (finished) return
    const code = ev?.code
    const reason = ev?.reason || ''
    if (code === 4014 || code === 4914 || code === 4915) {
      const hint = code === 4014
        ? 'intent 无权限：请确认机器人已获得群聊能力/已上线，或改用 Webhook 方式。'
        : code === 4914
          ? '机器人已下架，只允许连接沙箱环境。'
          : '机器人已封禁，需先解封。'
      console.error(`[capture] 网关拒绝连接：${code} ${reason}。${hint}`)
      finish(1, `网关关闭 ${code}`)
      return
    }
    log(`连接关闭（code=${code} ${reason}），3s 后重连…`)
    scheduleReconnect()
  }
}

function teardownSocket() {
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
  try {
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
    }
  } catch { /* ignore */ }
  ws = null
}

function scheduleReconnect() {
  if (finished) return
  teardownSocket()
  clearTimeout(reconnectTimer)
  const wait = Math.min(5000 * connectionAttempt, 20000)
  reconnectTimer = setTimeout(connect, wait)
}

async function main() {
  log(`启动：appId=${APP_ID}，最长监听 ${SECONDS}s，目标群数 ${EXPECT || '不限'}，空闲退出 ${IDLE_EXIT || '关闭'}`)
  log(`时间：${nowIso()}`)

  token = await getAccessToken({ appId: APP_ID, appSecret: APP_SECRET, log })
  const gw = await getGatewayUrl({ token, log })
  gatewayUrl = gw.url
  log(`网关地址：${gatewayUrl}（建议分片数 ${gw.shards}）`)
  if (gw.sessionStartLimit) {
    log(`会话配额：剩余 ${gw.sessionStartLimit.remaining}/${gw.sessionStartLimit.total}，max_concurrency=${gw.sessionStartLimit.max_concurrency}`)
  }

  tickTimer = setInterval(() => {
    if (finished) return
    if (Date.now() >= deadline) {
      finish(captured.size > 0 ? 0 : 2, `达到最长监听 ${SECONDS}s`)
      return
    }
    if (IDLE_EXIT > 0 && captured.size > 0 && Date.now() - lastCaptureAt >= IDLE_EXIT * 1000) {
      finish(0, `抓完后 ${IDLE_EXIT}s 没有新群`)
    }
  }, 1000)

  connect()
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C，打印当前结果后退出')
  finish(captured.size > 0 ? 0 : 2, '手动中断')
})

main().catch((err) => {
  console.error(`[capture] 启动失败：${err.message}`)
  process.exit(1)
})
