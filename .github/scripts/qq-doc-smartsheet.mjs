#!/usr/bin/env node
/**
 * qq-doc-smartsheet.mjs — 腾讯文档「在线智能表」OpenAPI 封装（零依赖）。
 *
 * 文档：
 *   - 概念介绍     https://docs.qq.com/open/document/app/openapi/v2/smartsheet/common/concept.html
 *   - 查询记录     https://docs.qq.com/open/document/app/openapi/v2/smartsheet/record/get_records.html
 *   - 查询字段     https://docs.qq.com/open/document/app/openapi/v2/smartsheet/field/get_fields.html
 *
 * 约定：
 *   - 接口是 POST /openapi/smartbook/v2/files/{fileID}/sheets/{sheetID}
 *   - 鉴权靠三个 header：Access-Token / Client-Id / Open-Id（不是 Bearer）
 *   - 响应 { ret, msg, data: { getRecords | getFields } }，ret === 0 才算成功
 *   - 记录里的 values 以「字段标题」为 key，值的形态随字段类型不同（文本是 [{text,type}]）
 *
 * 频控：官方按 fileID 限流（免费版每天 20000 次），这里默认每页 200 条、串行翻页，正常一天几次调用。
 */
import process from 'node:process'

export const DOC_API_BASE = process.env.QQ_DOC_API_BASE || 'https://docs.qq.com'
const SMARTBOOK_PATH = '/openapi/smartbook/v2'

/** 从环境变量读腾讯文档凭据与目标表 */
export function readDocConfig(env = process.env) {
  return {
    accessToken: env.QQ_DOC_ACCESS_TOKEN || '',
    clientId: env.QQ_DOC_CLIENT_ID || '',
    openId: env.QQ_DOC_OPEN_ID || '',
    fileId: env.QQ_DOC_FILE_ID || '',
    sheetId: env.QQ_DOC_SHEET_ID || '',
  }
}

export function assertDocConfig(cfg) {
  const missing = []
  if (!cfg.accessToken) missing.push('QQ_DOC_ACCESS_TOKEN')
  if (!cfg.clientId) missing.push('QQ_DOC_CLIENT_ID')
  if (!cfg.openId) missing.push('QQ_DOC_OPEN_ID')
  if (!cfg.fileId) missing.push('QQ_DOC_FILE_ID')
  if (!cfg.sheetId) missing.push('QQ_DOC_SHEET_ID')
  if (missing.length) {
    throw new Error(`缺少腾讯文档配置：${missing.join(', ')}`)
  }
}

function sheetPath(cfg) {
  return `${SMARTBOOK_PATH}/files/${encodeURIComponent(cfg.fileId)}/sheets/${encodeURIComponent(cfg.sheetId)}`
}

/**
 * 调一次腾讯文档 OpenAPI（内部通用）。
 * 返回 { ok, ret, msg, data, status }；网络异常/重试耗尽时抛错。
 */
async function docFetch(cfg, path, { method = 'POST', body, retries = 3, timeout = 20_000, log = () => {} } = {}) {
  const url = `${DOC_API_BASE}${path}`
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Access-Token': cfg.accessToken,
          'Client-Id': cfg.clientId,
          'Open-Id': cfg.openId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON，下面按错误处理 */ }
      const ret = json?.ret
      if (res.ok && ret === 0) {
        return { ok: true, ret, msg: json?.msg || '', data: json?.data ?? null, status: res.status }
      }
      const msg = json?.msg || text.slice(0, 300)
      // 频控 / 临时错误重试
      if ([429, 500, 502, 503, 504].includes(res.status) || [20001, 20002, 20003].includes(ret)) {
        lastErr = new Error(`HTTP ${res.status} ret=${ret} ${msg}`)
        if (attempt < retries) {
          const wait = 1500 * attempt
          log(`[doc-api] 触发限频/临时错误（${lastErr.message}），${wait}ms 后重试`)
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
      }
      return { ok: false, ret, msg, data: json?.data ?? null, status: res.status, text }
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        const wait = 1000 * attempt
        log(`[doc-api] 网络错误（${err.message}），${wait}ms 后重试`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
    }
  }
  throw new Error(`腾讯文档接口调用失败：${lastErr?.message || '未知错误'}`)
}

/** 调智能表接口（字段/记录） */
export function docRequest(cfg, body, opts = {}) {
  return docFetch(cfg, sheetPath(cfg), { ...opts, method: 'POST', body })
}

/** encodedID（URL 里那串）→ 真正的 fileID（形如 `300000000$AAAA`） */
export async function encodedIdToFileId(cfg, encodedId, { log = () => {} } = {}) {
  const r = await docFetch(cfg, `/openapi/drive/v2/util/converter?type=2&value=${encodeURIComponent(encodedId)}`, { method: 'GET', log })
  if (!r.ok || !r.data?.fileID) {
    throw new Error(`fileID 转换失败：ret=${r.ret} ${r.msg || ''}`)
  }
  return r.data.fileID
}

/**
 * 解析 fileID：URL 里的是 encodedID，智能表接口要的是转换后的 fileID。
 * 已经带 `$` 的视为真实 fileID，直接返回。解析结果写回 cfg.fileId，避免重复转换。
 */
export async function resolveFileId(cfg, { log = () => {} } = {}) {
  if (!cfg.fileId) throw new Error('缺少 QQ_DOC_FILE_ID')
  if (cfg.fileId.includes('$')) return cfg.fileId
  const real = await encodedIdToFileId(cfg, cfg.fileId, { log })
  log(`[doc-api] fileID 转换：${cfg.fileId} → ${real}`)
  cfg.fileId = real
  return real
}

/**
 * 拉全部字段定义（自动翻页）。
 * 字段结构：{ fieldID, fieldTitle, fieldType, propertyText/propertyNumber/... }
 */
export async function getAllFields(cfg, { pageSize = 100, log = () => {}, maxPages = 50 } = {}) {
  await resolveFileId(cfg, { log })
  const fields = []
  let offset = 0
  for (let page = 0; page < maxPages; page += 1) {
    const r = await docRequest(cfg, { getFields: { offset, limit: pageSize } }, { log })
    if (!r.ok) throw new Error(`查询字段失败：ret=${r.ret} ${r.msg}`)
    const got = r.data?.getFields
    fields.push(...(got?.fields || []))
    if (!got?.hasMore) return fields
    const next = Number(got.next)
    offset = Number.isFinite(next) && next > offset ? next : offset + pageSize
  }
  throw new Error(`查询字段翻页超过 ${maxPages} 页，疑似 hasMore 一直为 true`)
}

/**
 * 拉全部记录（自动翻页）。
 * 记录结构：{ recordID, createTime, updateTime, values: { 字段标题: 值 } }
 */
export async function getAllRecords(cfg, { pageSize = 100, log = () => {}, maxPages = 200 } = {}) {
  await resolveFileId(cfg, { log })
  const records = []
  let offset = 0
  let total = null
  for (let page = 0; page < maxPages; page += 1) {
    const r = await docRequest(cfg, { getRecords: { offset, limit: pageSize } }, { log })
    if (!r.ok) throw new Error(`查询记录失败：ret=${r.ret} ${r.msg}`)
    const got = r.data?.getRecords
    const batch = got?.records || []
    records.push(...batch)
    if (got?.total !== undefined) total = Number(got.total)
    log(`[doc-api] 已拉取第 ${page + 1} 页：${batch.length} 条（累计 ${records.length}${total !== null ? `/${total}` : ''}）`)
    if (!got?.hasMore || batch.length === 0) return { records, total }
    const next = Number(got.next)
    offset = Number.isFinite(next) && next > offset ? next : offset + pageSize
  }
  throw new Error(`查询记录翻页超过 ${maxPages} 页，疑似 hasMore 一直为 true`)
}

/** 把智能表的单元格值归一化成字符串（文本/选项/链接/多选都兼容） */
export function cellText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return ''
        if (typeof item === 'string') return item
        if (typeof item === 'number') return String(item)
        return item.text ?? item.link ?? item.title ?? item.name ?? ''
      })
      .filter(Boolean)
      .join(', ')
      .trim()
  }
  if (typeof value === 'object') {
    return String(value.text ?? value.link ?? value.title ?? value.name ?? '').trim()
  }
  return String(value).trim()
}

/** 把单元格值归一化成数字（支持 "1,234"、纯数字、数字型字符串） */
export function cellNumber(value) {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (Array.isArray(value)) {
    // 数字字段一般不会数组化，兜底取第一个能解析的
    for (const item of value) {
      const n = cellNumber(item)
      if (n) return n
    }
    return 0
  }
  if (typeof value === 'object') {
    const n = Number(value.text ?? value.value ?? NaN)
    return Number.isFinite(n) ? n : 0
  }
  const cleaned = String(value).replace(/[,，\s]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

/** 按标题找字段（忽略前后空格，精确匹配优先，其次包含匹配） */
export function findField(fields, title) {
  if (!title) return null
  const want = title.trim()
  return (
    fields.find((f) => (f.fieldTitle || '').trim() === want) ||
    fields.find((f) => (f.fieldTitle || '').trim().includes(want)) ||
    null
  )
}
