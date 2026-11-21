#!/usr/bin/env node
/**
 * qq-bot-api.mjs — QQ 机器人 OpenAPI 的零依赖封装（Node >= 22，用内置 fetch/WebSocket）。
 *
 * 只做四件事：
 *   1. 取 access_token      POST /app/getAppAccessToken     （凭证 7200s，进程内缓存）
 *   2. 取网关地址            GET  /gateway/bot
 *   3. 发群聊文本消息        POST /v2/groups/{group_openid}/messages
 *   4. 查群基本信息          GET  /v2/groups/{group_openid}/info
 *
 * 官方文档：
 *   - 获取 access_token  https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 *   - API 调用指南       https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
 *   - 发送群聊消息       https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 *
 * 注意：2026-08-10 起官方把接口域名统一成 https://api.bot.qq.com；
 *       旧域名 https://api.sgroup.qq.com 仍作为兜底（可用 QQ_API_BASE 覆盖）。
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'

/** 统一域名（2026-08-10 起） */
export const DEFAULT_API_BASE = 'https://api.bot.qq.com'
/** 旧域名，仅作网络抖动/域名调整时的兜底 */
export const LEGACY_API_BASE = 'https://api.sgroup.qq.com'
/** 群聊 / 单聊事件（含 GROUP_AT_MESSAGE_CREATE、GROUP_ADD_ROBOT） */
export const INTENT_GROUP_AND_C2C_EVENT = 1 << 25

const TOKEN_HOSTS = [DEFAULT_API_BASE, 'https://bots.qq.com']
const TOKEN_SAFETY_WINDOW_MS = 60_000
const tokenCache = new Map()

/** 从环境变量里读凭据，兼容参考仓库的 QQ_APP_ID / QQ_APP_SECRET 命名 */
export function readCredentials(env = process.env) {
  return {
    appId: env.QQ_BOT_APP_ID || env.QQ_APP_ID || '',
    appSecret: env.QQ_BOT_APP_SECRET || env.QQ_APP_SECRET || '',
  }
}

/**
 * 解析 `export KEY="VALUE"` 形式的 shell env 文件（本地调试用，GitHub Actions 里不需要）。
 * 已存在的环境变量不会被覆盖。
 */
export function loadEnvFile(file, env = process.env) {
  const text = readFileSync(file, 'utf8')
  const loaded = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    const quoted = value.match(/^(['"])([\s\S]*)\1$/)
    if (quoted) value = quoted[2]
    // 去掉未加引号时的行尾注释
    else value = value.replace(/\s+#.*$/, '')
    if (env[key] === undefined) {
      env[key] = value
      loaded.push(key)
    }
  }
  return loaded
}

/**
 * 群 openid 列表：支持逗号/分号/空白/换行分隔，兼容多个存放位置。
 * 例：QQ_GROUP_OPENID="A,B" 或 QQ_GROUP_OPENIDS="A\nB"
 */
export function parseGroupOpenids(raw) {
  if (!raw) return []
  const seen = new Set()
  const out = []
  for (const item of String(raw).split(/[\s,;，；]+/)) {
    const id = item.trim()
    if (!id || id.startsWith('#')) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 从环境变量读群 openid（多个） */
export function readGroupOpenids(env = process.env) {
  return parseGroupOpenids(
    env.QQ_GROUP_OPENID || env.QQ_GROUP_OPENIDS || env.QQ_GROUPS || '',
  )
}

function mask(id) {
  if (!id) return '(空)'
  const s = String(id)
  return s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`
}

/**
 * 取 access_token（进程内缓存到过期前 60s）。
 * 失败时优先依据响应体 code 判断，不依赖 HTTP 状态码（官方文档明确 HTTP 仍可能是 200）。
 */
export async function getAccessToken({ appId, appSecret, force = false, log = () => {} } = {}) {
  if (!appId || !appSecret) {
    throw new Error('缺少 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET（也兼容 QQ_APP_ID / QQ_APP_SECRET）')
  }
  const cacheKey = appId
  const cached = tokenCache.get(cacheKey)
  if (!force && cached && cached.expiresAt - TOKEN_SAFETY_WINDOW_MS > Date.now()) {
    return cached.token
  }

  const errors = []
  for (const host of TOKEN_HOSTS) {
    const url = `${host}/app/getAppAccessToken`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
      if (json?.access_token) {
        const expiresIn = Number(json.expires_in) || 7200
        tokenCache.set(cacheKey, {
          token: json.access_token,
          expiresAt: Date.now() + expiresIn * 1000,
        })
        log(`[qq-api] access_token 获取成功（appId=${appId}，有效期 ${expiresIn}s，来自 ${host}）`)
        return json.access_token
      }
      errors.push(`${host} → HTTP ${res.status} ${json ? `code=${json.code} ${json.message ?? ''}` : text.slice(0, 200)}`)
    } catch (err) {
      errors.push(`${host} → 网络错误：${err?.message || err}`)
    }
  }
  throw new Error(`获取 access_token 失败：\n  ${errors.join('\n  ')}`)
}

/**
 * 调 OpenAPI：网络层失败时在统一域名与旧域名之间兜底重试。
 * 返回 { ok, status, json, base, path }；ok 只认 err_code（缺省视为成功）。
 */
export async function callOpenApi(path, {
  method = 'GET',
  token,
  body,
  bases = null,
  timeout = 20_000,
  log = () => {},
} = {}) {
  if (!token) throw new Error('callOpenApi 需要 token')
  const baseList = bases || [process.env.QQ_API_BASE || DEFAULT_API_BASE, LEGACY_API_BASE].filter(Boolean)
  const errors = []
  for (const base of baseList) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* 空包体/非 JSON */ }
      const errCode = json?.err_code
      const ok = res.ok && (errCode === undefined || errCode === 0)
      if (!ok) {
        const where = `${base}${path}`
        errors.push(`${where} → HTTP ${res.status}, err_code=${errCode ?? '-'}, message=${json?.message ?? text.slice(0, 300)}`)
      }
      return { ok, status: res.status, json, text, base, path, errors }
    } catch (err) {
      errors.push(`${base}${path} → 网络错误：${err?.message || err}`)
      log(`[qq-api] ${base} 不可达，尝试下一个域名：${err?.message || err}`)
    }
  }
  const e = new Error(`OpenAPI 调用失败：\n  ${errors.join('\n  ')}`)
  e.errors = errors
  throw e
}

/** 取网关地址：GET /gateway/bot（失败时退回官方默认 wss 地址） */
export async function getGatewayUrl({ token, log = () => {} } = {}) {
  try {
    const r = await callOpenApi('/gateway/bot', { token, log })
    if (r.ok && r.json?.url) {
      return {
        url: r.json.url,
        shards: Number(r.json.shards) || 1,
        sessionStartLimit: r.json.session_start_limit || null,
      }
    }
    log(`[qq-api] /gateway/bot 返回异常，使用默认网关地址：${JSON.stringify(r.json)}`)
  } catch (err) {
    log(`[qq-api] /gateway/bot 调用失败，使用默认网关地址：${err.message}`)
  }
  return { url: `wss://${new URL(process.env.QQ_API_BASE || DEFAULT_API_BASE).host}/websocket`, shards: 1, sessionStartLimit: null }
}

/** 查群基本信息（群名等）。失败返回 null，不影响主流程。 */
export async function getGroupInfo({ token, groupOpenid, log = () => {} } = {}) {
  try {
    const r = await callOpenApi(`/v2/groups/${encodeURIComponent(groupOpenid)}/info`, { token, log })
    if (r.ok && r.json) return r.json
    log(`[qq-api] 获取群信息失败（${groupOpenid}）：${(r.errors || []).join('; ') || JSON.stringify(r.json)}`)
    return null
  } catch (err) {
    log(`[qq-api] 获取群信息异常（${groupOpenid}）：${err.message}`)
    return null
  }
}

/** 随机 msg_seq：主动推送时避免 "相同 msg_id + msg_seq" 去重（40054005） */
export function nextMsgSeq() {
  return (Math.floor(Math.random() * 2_000_000_000) % 2_000_000_000) + 1
}

const RETRYABLE_ERR_CODES = new Set([429, 500, 50055001, 1100300, 1100499, 40054100])

/**
 * 给一个群发文本消息（msg_type=0）。
 * - 有 msgId 时为被动回复（60 分钟内有效，每消息最多 5 次；群主/管理员管理机器人时 50 次）
 * - 无 msgId 时为主动推送（受频控：Bot 维度 60qpm/30qpm，单群 20qpm、1000 条/天）
 * 返回 { ok, status, json, errCode, message }；不会抛异常（网络异常除外，异常也被捕获成 ok=false）。
 */
export async function sendGroupText({
  token,
  groupOpenid,
  content,
  msgId,
  msgSeq,
  apiBase,
  retries = 3,
  log = () => {},
} = {}) {
  if (!groupOpenid) throw new Error('sendGroupText 需要 groupOpenid')
  if (typeof content !== 'string' || !content.trim()) throw new Error('sendGroupText 需要非空 content')
  const bases = apiBase ? [apiBase] : null
  let last = null
  let seq = msgId ? (msgSeq ?? 1) : (msgSeq ?? nextMsgSeq())

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const body = { msg_type: 0, content }
    if (msgId) {
      body.msg_id = msgId
      body.msg_seq = seq
    } else {
      // 主动推送也带上 msg_seq，降低平台侧按序去重的概率
      body.msg_seq = seq
    }
    let r
    try {
      r = await callOpenApi(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
        method: 'POST',
        token,
        body,
        bases,
        log,
      })
    } catch (err) {
      last = { ok: false, errCode: null, message: err.message }
      if (attempt < retries) {
        await sleep(1000 * attempt)
        continue
      }
      return last
    }
    if (r.ok) {
      return { ok: true, status: r.status, json: r.json, errCode: 0, message: '', msgIdUsed: msgId || null, msgSeqUsed: seq }
    }
    const errCode = r.json?.err_code ?? null
    const message = r.json?.message ?? r.text?.slice(0, 300) ?? ''
    last = { ok: false, status: r.status, errCode, message, errors: r.errors, msgSeqUsed: seq }

    // 40054005 消息被去重 → 换一个 msg_seq 重试
    if (errCode === 40054005 && attempt < retries) {
      seq = nextMsgSeq()
      log(`[qq-api] ${mask(groupOpenid)} 消息被去重（40054005），换 msg_seq=${seq} 重试`)
      continue
    }
    if ((RETRYABLE_ERR_CODES.has(errCode) || r.status === 429) && attempt < retries) {
      const wait = 1500 * attempt
      log(`[qq-api] ${mask(groupOpenid)} 触发限频/临时错误（err_code=${errCode ?? r.status}），${wait}ms 后重试`)
      await sleep(wait)
      continue
    }
    return last
  }
  return last
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 解析常见 CLI 参数：--key value / --key=value / --flag，返回 { _: 位置参数, ...键值 } */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      args._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      args[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = true
    }
  }
  return args
}

export { mask }

/**
 * 渲染 {{VAR}} 占位符（消息文案里的文档链接不落明文，运行时由 Secrets 填进来）。
 * 缺变量直接抛错，绝不把半截链接发出去。
 */
export function fillTemplate(text, { env = process.env } = {}) {
  const missing = new Set()
  const rendered = String(text).replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (whole, name) => {
    const value = env[name]
    if (value === undefined || value === '') {
      missing.add(name)
      return whole
    }
    return value
  })
  if (missing.size > 0) {
    const err = new Error(`文案里有未配置的变量：${[...missing].join(', ')}（请配置对应的 Secrets / 环境变量）`)
    err.missing = [...missing]
    throw err
  }
  return rendered
}

/**
 * 日志脱敏：把指定环境变量的真实值替换成 ***NAME***。
 * 公开仓库的 Actions 日志是公开的，而「拼装出来的 URL」本身不是 secret 不会自动打码，所以要手动遮。
 */
export function redactEnvValues(text, names, env = process.env) {
  let out = String(text)
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.length >= 4) {
      out = out.split(value).join(`***${name}***`)
    }
  }
  return out
}
