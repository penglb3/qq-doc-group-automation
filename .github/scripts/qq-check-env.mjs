#!/usr/bin/env node
/**
 * qq-check-env.mjs — 本地/CI 环境自检：凭证、access_token、网关、群列表，可选发一条测试消息。
 *
 * 用法：
 *   node .github/scripts/qq-check-env.mjs --env-file ../env-secrets.sh
 *   node .github/scripts/qq-check-env.mjs --env-file ../env-secrets.sh --send-test "测试消息"
 *
 * 退出码：0 全部通过；1 有硬失败（凭证/网络/网关）。
 */
import process from 'node:process'
import {
  getAccessToken,
  getGatewayUrl,
  getGroupInfo,
  loadEnvFile,
  parseArgs,
  readGroupOpenids,
  sendGroupText,
  mask,
} from './qq-bot-api.mjs'

const args = parseArgs()
const log = (m) => console.log(m)
let hardFail = false
const fail = (m) => {
  hardFail = true
  console.log(`❌ ${m}`)
}

if (typeof args['env-file'] === 'string') {
  try {
    const keys = loadEnvFile(args['env-file'])
    log(`[env] 从 ${args['env-file']} 载入：${keys.join(', ') || '(无新变量)'}`)
  } catch (err) {
    fail(`读取 env 文件失败：${err.message}`)
  }
}

const appId = args._[0] || process.env.QQ_BOT_APP_ID || process.env.QQ_APP_ID || ''
const appSecret = args._[1] || process.env.QQ_BOT_APP_SECRET || process.env.QQ_APP_SECRET || ''

console.log('================ 环境自检 ================')
console.log(`Node    : ${process.version} (${process.platform}/${process.arch})`)
console.log(`fetch   : ${typeof fetch === 'function' ? 'OK' : '不可用（需要 Node >= 18）'}`)
console.log(`WebSocket: ${typeof WebSocket === 'function' ? 'OK' : '不可用（需要 Node >= 22）'}`)
if (typeof fetch !== 'function' || typeof WebSocket !== 'function') {
  fail('当前 Node 版本过低，请使用 Node >= 22')
}

console.log(`AppID   : ${appId || '(缺失)'}`)
console.log(`AppSecret: ${appSecret ? `已配置（${appSecret.length} 字符）` : '(缺失)'}`)
if (!appId || !appSecret) {
  fail('缺少 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET')
}

let token = ''
if (!hardFail) {
  try {
    token = await getAccessToken({ appId, appSecret, log })
    console.log(`✅ access_token: ${mask(token)}（长度 ${token.length}）`)
  } catch (err) {
    fail(err.message)
  }
}

if (token) {
  try {
    const gw = await getGatewayUrl({ token, log })
    console.log(`✅ 网关地址: ${gw.url}（建议分片 ${gw.shards}）`)
    if (gw.sessionStartLimit) {
      console.log(`   会话配额: 剩余 ${gw.sessionStartLimit.remaining}/${gw.sessionStartLimit.total}`)
    }
  } catch (err) {
    fail(`网关获取失败：${err.message}`)
  }

  const groups = readGroupOpenids()
  if (groups.length === 0) {
    console.log('ℹ️  未配置 QQ_GROUP_OPENID（先用 qq-capture-openid.mjs 抓取）')
  } else {
    console.log(`ℹ️  已配置 ${groups.length} 个群：`)
    for (const id of groups) {
      const info = await getGroupInfo({ token, groupOpenid: id, log })
      if (info) console.log(`   - ${id} → ${info.group_name || '(无群名)'}`)
      else console.log(`   - ${id} → ⚠️ 查询失败（可能不是这个 bot 的群 openid）`)
    }
  }

  if (typeof args['send-test'] === 'string') {
    const text = args['send-test']
    if (groups.length === 0) {
      fail('--send-test 需要先配置 QQ_GROUP_OPENID')
    } else {
      for (const id of groups) {
        const r = await sendGroupText({ token, groupOpenid: id, content: text, log: console.log })
        if (r.ok) console.log(`✅ 测试消息已发送到 ${mask(id)}（id=${r.json?.id ?? '-'}）`)
        else fail(`发送到 ${mask(id)} 失败：err_code=${r.errCode} ${r.message}`)
      }
    }
  }
}

console.log('==========================================')
console.log(hardFail ? '结论：❌ 有失败项，见上。' : '结论：✅ 环境 OK。')
process.exit(hardFail ? 1 : 0)
