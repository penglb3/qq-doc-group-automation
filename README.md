# QQ文档-QQ群消息自动化

## 一期需求：许愿池定时提醒
**基于github actions，支持定时向多个QQ群发送固定文本消息**。

参考 https://github.com/Aik358/dsh-auto-memory 中 /.github/workflows/group-digest.yml 和 .github/scripts/group-digest.mjs ，实现定时向QQ群发送固定文本消息。
QQ_BOT_APP_ID 和 QQ_BOT_APP_SECRET 已经写入本地 ../env-secrets.sh 或 github secrets 中。

所需的群 openid 需要先用 .github/scripts/qq-capture-openid.mjs 抓取。

官方 API 参考文档，可用于检验参考repo中的脚本是否符合需求：
- 获取access_token： https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
- API 调用指南： https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
- 发送群聊消息： https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html

消息文本：
```
许愿池：可以在这里许愿想要的娃，想要人数多的娃会优先推动饼饼立项开团
https://docs.qq.com/smartsheet/{{QQ_DOC_FILE_ID}}?tab={{QQ_DOC_SHEET_ID}}&viewId=vQSJ4P
```


## 二期需求：许愿池自动结算

**基于一期需求，添加自动查询处理特定腾讯文档智能表中的信息**。

使用腾讯文档官方API获取 https://docs.qq.com/smartsheet/{{QQ_DOC_FILE_ID}}?tab={{QQ_DOC_SHEET_ID}}&viewId=vQSJ4P 这个 sheet 中的所有记录信息。
然后按照 "类别" 一列分组，基于"总想要人数"一列排序，获取每组的前3条记录信息。
将每组的信息拼成一个字符串，附加上文档链接本身，发送到QQ群。

官方 API 参考文档，由于没有现成的脚本或者封装，你应该需要自己写脚本：
- 在线智能表-概念介绍：https://docs.qq.com/open/document/app/openapi/v2/smartsheet/common/concept.html#fileid
- 在线智能表-记录接口-查询记录：https://docs.qq.com/open/document/app/openapi/v2/smartsheet/record/get_records.html
- 在线智能表-字段接口-查询字段：https://docs.qq.com/open/document/app/openapi/v2/smartsheet/field/get_fields.html


⚠注意腾讯文档免费版每日API查询次数限制每日20000次，调试时注意频控。

消息文本：
```
今日许愿池结算：
${类别1}：
🥇${娃名1}: ${总想要人数1}人
🥈${娃名2}: ${总想要人数2}人
🥉${娃名3}: ${总想要人数3}人

${类别2}：
🥇${娃名4}: ${总想要人数4}人
🥈${娃名5}: ${总想要人数5}人
🥉${娃名6}: ${总想要人数6}人

许愿池：可以在这里许愿想要的娃，想要人数多的娃会优先推动饼饼立项开团。
https://docs.qq.com/smartsheet/{{QQ_DOC_FILE_ID}}?tab={{QQ_DOC_SHEET_ID}}&viewId=vQSJ4P
```

---

# 实现说明

零依赖（Node ≥ 22 自带 `fetch` / `WebSocket`，不需要 `npm install`）。

## 目录结构

```
.github/
├── messages/
│   └── xuyuanchi-reminder.txt      一期固定文案（改文案只改这里）
├── scripts/
│   ├── qq-bot-api.mjs              共享封装：access_token / 网关 / 发群消息 / 群信息 / env 文件解析
│   ├── qq-capture-openid.mjs       一次性：抓群 group_openid（WebSocket 监听群事件）
│   ├── qq-check-env.mjs            环境自检，可 --send-test 实测发送
│   └── group-digest.mjs            一期：向多个群发送固定文本
├── workflows/
│   └── group-digest.yml            一期定时任务
└── messages/
```

## 一、抓取群 openid（一次性，本机执行）

`group_openid` 只在群内有事件时才下发（如有人 @机器人、机器人被拉进群），开放平台控制台不展示，所以要监听一次网关：

```bash
# 本机（Node ≥ 22）；--env-file 会读取 ../env-secrets.sh，不覆盖已有环境变量
node .github/scripts/qq-capture-openid.mjs --env-file ../env-secrets.sh --out .local/qq-openids.json

# 或者显式传凭据
QQ_BOT_APP_ID=xxx QQ_BOT_APP_SECRET=xxx node .github/scripts/qq-capture-openid.mjs
```

然后在**每个**目标群里发一条「@机器人 任意内容」（机器人刚进群的话会收到 `GROUP_ADD_ROBOT`，无需 @）。
脚本会自动去重、查询并打印群名，结束时输出可直接粘贴的一行 `QQ_GROUP_OPENID=openid1,openid2,...`。
默认最长监听 900s，抓到群后 240s 没有新群自动结束；`--expect N` 可抓够 N 个就退出。

环境自检（可选，`--send-test` 会真的发一条到已配置的群）：

```bash
node .github/scripts/qq-check-env.mjs --env-file ../env-secrets.sh
node .github/scripts/qq-check-env.mjs --env-file ../env-secrets.sh --send-test "联调测试"
```

## 二、一期：许愿池定时提醒

### 仓库 Secrets

> 仓库是公开的，所以**文档链接不落明文**：模板里用 `{{QQ_DOC_FILE_ID}}` / `{{QQ_DOC_SHEET_ID}}` 占位，
> 运行时由 Secrets 注入；Actions 日志里也会把这两个值打码（拼出来的 URL 本身不是 secret，不会被自动隐藏）。

Settings → Secrets and variables → Actions → **Secrets**：

| Name | 说明 |
| --- | --- |
| `QQ_BOT_APP_ID` | 机器人 AppID |
| `QQ_BOT_APP_SECRET` | 机器人 AppSecret |
| `QQ_GROUP_OPENID` | 群 openid，多个群用英文逗号分隔，例如 `A1B2...,C3D4...` |
| `QQ_DOC_FILE_ID` | 腾讯文档智能表 fileId（拼文档链接用） |
| `QQ_DOC_SHEET_ID` | 智能表 sheetId（拼文档链接用） |

### 文案与链接占位符

- 文案在 [.github/messages/xuyuanchi-reminder.txt](.github/messages/xuyuanchi-reminder.txt)，改文案只改这个文件。
- 支持 `{{变量名}}` 占位符，运行时从环境变量/Secrets 取值；**缺变量会直接报错退出**，不会把半截链接发出去。
- 目前 `viewId` 仍是明文（单独一个 viewId 无法定位到文档，不构成可访问链接）；如果也要藏起来，加一个 `QQ_DOC_VIEW_ID` secret，再把模板里 `vQSJ4P` 换成 `{{QQ_DOC_VIEW_ID}}` 即可，脚本无需改动。
- 公开仓库的 Actions 日志默认对 file/sheet id 打码；本地跑默认显示全文，可用 `--show-text` 强制显示。

可选 **Variables**：`QQ_API_BASE`（默认 `https://api.bot.qq.com`）。

### 定时时间

[group-digest.yml](.github/workflows/group-digest.yml) 的 cron 按 UTC 写，对应北京时间：

| 北京时间 | UTC cron |
| --- | --- |
| 09:25 | `25 1 * * *` |
| 15:45 | `45 7 * * *` |
| 20:25 | `25 12 * * *` |

注意事项：

- `schedule` 只在**默认分支**上生效；刚改完工作流要先合并/推送到默认分支。
- GitHub 的调度可能延迟几分钟到半小时，属正常现象；如需更强的准点性，可把定时任务放到自建 cron/云函数里调用 workflow_dispatch。
- 同一个时间点建议不要配置重复 cron，本实现没有跨运行的去重状态，重复 cron 会重复发消息。

### 本地验证

```bash
# 只打印不发
node .github/scripts/group-digest.mjs --env-file ../env-secrets.sh --dry-run

# 真实发送（群列表取 QQ_GROUP_OPENID，缺省时回退读 .local/qq-openids.json）
node .github/scripts/group-digest.mjs --env-file ../env-secrets.sh

# 只发指定群 / 临时文案
node .github/scripts/group-digest.mjs --env-file ../env-secrets.sh --group EEE7... --text "测试"
```

### 平台限制（2026-11 官方文档）

- 主动消息频控：Bot 维度 60 qpm（企业/个人身份证认证）或 30 qpm（未认证）；单个群 20 qpm、每群每天最多接收 1000 条。
- 被动回复（带 `msg_id`）：有效期 60 分钟，每条消息最多回复 5 次；机器人账号的管理员是群主/管理员时 50 次。
- 文本消息含 URL 一般可用（已在真实群验证 `docs.qq.com` 链接可发）；若遇到 `40054010 不允许发送URL` 需要换文案形式。
- 常见错误码：`40034105` 无主动消息权限、`40034101/40054003` 机器人不在群、`40054100` 主动消息超频、`40054005` 消息被去重（脚本会自动换 `msg_seq` 重试）。

## 三、二期：许愿池自动结算（实现中）

待办：调用腾讯文档智能表 OpenAPI 拉取全部记录 → 按「类别」分组、按「总想要人数」排序取每组前 3 → 拼成结算文案 → 复用房一期的发送逻辑发到 QQ 群。
