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
│   ├── xuyuanchi-reminder.txt      一期固定文案（改文案只改这里）
│   └── xuyuanchi-settle.txt        二期结算文案模板（{{SETTLE_BODY}} + 文档链接占位符）
├── scripts/
│   ├── qq-bot-api.mjs              共享封装：access_token / 网关 / 发群消息 / 群信息 / env 文件解析
│   ├── qq-broadcast.mjs            共享封装：群列表解析 / 群名查询 / 主动推送预检 / 逐群广播
│   ├── qq-doc-smartsheet.mjs       共享封装：腾讯文档智能表字段、记录查询（含 fileID 转换、翻页）
│   ├── qq-capture-openid.mjs       一次性：抓群 group_openid（WebSocket 监听群事件）
│   ├── qq-check-env.mjs            环境自检，可 --send-test 实测发送
│   ├── group-digest.mjs            一期：向多个群发送固定文本
│   └── group-settle.mjs            二期：拉智能表 → 分组排序 → 发送结算文案
├── workflows/
│   ├── group-digest.yml            一期定时任务
│   ├── group-settle.yml            二期定时任务
│   ├── doc-token-reminder.yml      腾讯文档 token 到期提醒（定时）
│   └── keepalive.yml               保活：定时向 keepalive 分支推空提交
└── messages/
```

根目录的 [wechat-notify.py](wechat-notify.py)：腾讯文档 access_token 到期检测 + Server酱微信提醒。

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
分批抓群时加 `--merge .local/qq-openids.json` 把之前的结果并进来、`--out` 写回同一文件，就能累积成完整清单。

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

**当前 cron 已做「提前 7 小时」补偿**：GitHub 的 `schedule` 触发器自 2026-08 起排队严重，
实测稳定晚到约 6.2–8.3 小时（`created_at == run_started_at`，即延迟全在调度器排队，不是 runner 慢；
GitHub Status 不报 incident，社区同症状很多）。所以表里的 cron 是「目标北京时间 − 7h」的等价 UTC，
**实际到达时间才≈目标时间**。

| 目标（北京时间） | 实际 cron 触发（北京） | cron（UTC） |
| --- | --- | --- |
| 09:24 | 02:24 | `24 18 * * *` |
| 15:47 | 08:47 | `47 0 * * *` |
| 20:23 | 13:23 | `23 5 * * *` |
| 22:14（结算） | 15:14 | `14 7 * * *` |
| 10:12（token 提醒） | 03:12 | `12 19 * * *` |

换算公式：`cron(UTC) = 目标北京时间 − 8h（转 UTC）− 7h（补偿）`。

**补偿是权宜之计，不是终点**，因为延迟不是常数（两天内从 6h13m 漂到 7h55m），也不保证不丢触发：

- **定期复查**（建议每两周）：`gh run list -R penglb3/qq-doc-group-automation --limit 10 --json name,event,createdAt`
  对比 cron 和目标时间。如果实际到达明显**偏早**，说明 GitHub 恢复了，把 cron 换回 `目标 − 8h` 并删掉注释里的补偿说明；
  如果延迟涨到 9h 以上，消息会越拖越晚，此时应改用外部定时器。
- **更稳的做法**：外部定时器（cron-job.org / Cloudflare Workers Cron）准点 `POST .../actions/workflows/<file>/dispatches`
  触发 `workflow_dispatch`（秒级启动，不受 GitHub cron 影响），保留这些 cron 只作兜底。需要 fine-grained PAT（仅本仓库 + Actions: write）。

（分钟数本来就刻意错开整点和整 5 分；但自 2026-08 起 `:17`/`:23` 也一样延迟，错分钟帮助有限。）

注意事项：

- `schedule` 只在**默认分支**上生效；刚改完工作流要先合并/推送到默认分支，否则改的 cron 不生效。
- 同一个时间点建议不要配置重复 cron，本实现没有跨运行的去重状态，重复 cron 会重复发消息。
- 补偿后 cron 触发时的「当前时间」不是目标时间；脚本里没有基于当前时间的内容逻辑（只有日志），改 cron 不影响文案。

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
- **群主开关（最常见的 40034105）**：新版 QQ 默认关闭机器人的「主动推送」，需要群主/管理员在群内找到机器人 → 资料页右上角设置 → 打开推送开关。
  可用 `GET /v2/groups/{group_openid}/bot_state` 查看 `allow_proactive_msg`；脚本已内置预检，会直接点名哪个群没开（`--no-preflight` 可关）。
- 有群被跳过/失败时脚本返回非 0（Actions 变红提醒）；如果只想在“至少一个群成功”时算通过，加 `--allow-partial`。

## 三、二期：许愿池自动结算

每天北京时间 **22:14** 跑 [group-settle.yml](.github/workflows/group-settle.yml)（cron 已提前 7h 补偿，见「定时时间」）：拉智能表 → 过滤已立项 → 按「类别」分组 → 按「总想要人数」降序取每组前 3 → 拼文案 → 发到 `QQ_GROUP_OPENID` 里的所有群。

```
今日许愿池结算：
复刻：
🥇40cm花园多惠: 25人
🥈原尺寸 ksm 大趴趴: 13人
🥉40cm 彩彩: 7人

同人原创：
🥇凑友希那17cm花冠娃: 15人
🥈17cm 947: 10人
🥉今井莉莎17cm花冠娃: 10人

许愿池：可以在这里许愿想要的娃，想要人数多的娃会优先推动饼饼立项开团。
https://docs.qq.com/smartsheet/{{QQ_DOC_FILE_ID}}?tab={{QQ_DOC_SHEET_ID}}&viewId=vQSJ4P
```

### 额外需要的 Secrets（二期）

| Name | 说明 |
| --- | --- |
| `QQ_DOC_ACCESS_TOKEN` | 腾讯文档 OAuth2 access_token（**有有效期**，见下方提醒） |
| `QQ_DOC_CLIENT_ID` | 应用 Client-Id |
| `QQ_DOC_OPEN_ID` | 授权用户 Open-Id |
| `SCT_SENDKEY` | Server酱 SendKey（仅 token 到期提醒用） |

`QQ_DOC_FILE_ID` / `QQ_DOC_SHEET_ID` 一期已配，二期复用。

### 接口与数据口径（踩坑记录）

- 链路：`GET /openapi/drive/v2/util/converter?type=2&value=<URL里的ID>` 换成真实 `fileID`（形如 `300000000$xxxx`），
  再 `POST /openapi/smartbook/v2/files/{fileID}/sheets/{sheetID}`，body 为 `{"getFields":{...}}` / `{"getRecords":{...}}`；鉴权是 `Access-Token` / `Client-Id` / `Open-Id` 三个 header，不是 Bearer。
- 记录接口 `limit` **最大 100**，脚本按 `hasMore`/`next` 自动翻页。
- **`总想要人数（含创建人）` 是公式列**（公式为 `COUNTA({取补集}) + 1`，其中 `取补集 = {+1 我也想要！}.FILTER(本行创建人不在其中)`），
  智能表 API **不返回公式值**，所以脚本用 `+1 我也想要！` 的 userId 去重计数 `+ 1（创建人）` 推算；如果以后某行能直接读到公式值则优先用返回值。
  如果某条记录是创建人自己点的 +1，理论口径会比推算值少 1（脚本可用 `--no-count-creator` 改成只数 +1）。
- **已立项的娃会被过滤**：娃名或「状态通知」列命中关键字 `已立项` 就跳过（`--exclude-keyword` 可改、`--keep-established` 可关）。
- 类别按**每组第一名的人数降序**排列；组内按人数降序、同人数保持表内原顺序。
- 每日 API 配额（免费版 20000 次）：一次结算 ≈ 1 次转换 + 1 次字段 + 1 次记录，随便跑。

### 本地验证

```bash
# 只计算 + 打印，不发消息（会真实读表）
node .github/scripts/group-settle.mjs --env-file ../env-secrets.sh --dry-run

# 看每类前 N 明细、把计算结果落盘
node .github/scripts/group-settle.mjs --env-file ../env-secrets.sh --dry-run --print-table --out-json .local/settle.json

# 真发
node .github/scripts/group-settle.mjs --env-file ../env-secrets.sh
```

### ⚠️ access_token 到期提醒（已有定时任务）

`QQ_DOC_ACCESS_TOKEN` 是 OAuth2 凭证，会过期（当前这支的 JWT `exp` 是 **2026-12-21**）。过期后二期接口返回 `37019 Token 校验失败`。

[doc-token-reminder.yml](.github/workflows/doc-token-reminder.yml) 每天北京时间 **10:12** 跑一次 [wechat-notify.py](wechat-notify.py)（cron 已提前 7h 补偿，见「定时时间」）：

- 到期日**直接从 token 的 JWT `exp` 解析**，不用手工维护日期（`QQ_DOC_ACCESS_TOKEN_EXPIRE_DATE` 只作兜底）；
- 剩余 ≤ 3 天（或已过期）时推送微信，附带更新步骤；其余时间只打印一行“还早，跳过”；
  （access_token 本身只有 30 天有效期，阈值取 3 天，避免提醒过于频繁）
- 阈值可用 `QQ_DOC_TOKEN_WARN_DAYS` / 手动触发的 `warn_days` 调整，`dry_run` 可先看推送内容。

本地验证（不会真推送）：

```bash
python wechat-notify.py --dry-run                  # 剩余 > 3 天：只打印“还早”
python wechat-notify.py --dry-run --warn-days 400  # 强制走提醒分支，看文案
```

## 四、保活（防止定时任务被自动禁用）

公开仓库如果 **60 天内没有任何提交**，GitHub 会自动禁用所有 `schedule` 触发的 workflow
（Actions 页面会显示 “This scheduled workflow is disabled because there hasn't been activity in this repository for at least 60 days”）。
一期/二期的 daily 运行本身不算“仓库活动”，所以需要保活。

[keepalive.yml](.github/workflows/keepalive.yml) 每 **5 天**（UTC `17 3 */5 * *`，北京 11:17）向专门的 `keepalive` 分支推一个**空提交**：

- 首次运行自动创建 orphan **空树**分支（不含任何文件），之后只在该分支追加空提交，不污染 `main`；
- 用默认 `GITHUB_TOKEN` 推送（`permissions: contents: write`），不会触发其它 workflow；
- 60 天内至少 12 次，偶尔漏跑一次也远不到 60 天阈值。

注意事项：

- 仓库 **Settings → Actions → General → Workflow permissions** 需要允许写，否则 push 会 403；只读的话改成 “Read and write permissions”。
- 合并后建议在 Actions 里手动 **Run workflow** 一次，先把 `keepalive` 分支建出来并确认能 push。
- 保险起见可以加一个仓库 Variable **`KEEPALIVE_BRANCH=main`**：改成就向默认分支推空提交（5 天一个空提交，不动代码），
  避免“GitHub 的仓库活动是否认非默认分支”这种不确定性；确认分支方案有效的话删掉这个 Variable 即可。
- 万一以后还是被禁用，也可以在 Actions 页面点 “Enable workflow” 一键恢复后观察。
