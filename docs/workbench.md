# 本地招聘工作台

> 这份文档从 2026-09 上旬一路记下来，按日期的小节是当时的设计。成员名和界面以 [README](../README.md) 为准：团队是六位成员 Radar（找岗位）、Judge（看岗位）、Writer（做材料）、Reacher（递出去）、Watcher（盯回复和面试）、System（管后勤），文中的 Watch 就是现在的 Watcher（公司调研已归 Judge）；执行器不是成员，是大家共用的手。官网表单只自动预填、停在提交前，由你在页面上提交（`auto_submit` 默认关）。

打开 http://localhost:4321 。一个 Node 进程提供静态页面、SSE 和可选飞书长连接；只监听 127.0.0.1，不需要构建。

## 能做什么

- （总览页已于 2026-09-21 并入指挥台：今日进展漏斗在指挥台顶部，连接 / 调度状态在 System 页签，「刚刚发生」在 System 页签侧栏。）
- 实时处理流：按运行折叠，查看步骤、耗时、失败原因和文件证据。旧 cycle 日志明确标为历史。
- 看板：按阶段分列，搜索和公司／来源／投递入口筛选。草稿与投递凭证参与分列，停用记录不展示。
- 详情：完整 JD、逐项对照与引用、完整邮件正文、附件名称和大小、外部凭证、反馈记录。
- 运行与用量（System 的记账）：今天和这一周用了多少 token，按成员、按谁发起、按模型，命中缓存的和没命中的分开；用 API key 的估算花了多少钱（价格表 `config/prices.json`，写明日期）；Codex 订阅额度从它自己的会话记录读，Claude 的读不到就写「读不到」。每天的上限和三档花费也在这一页设。今天的花费上限到了时，每一页右上角出一条「今天的花费上限到了」，点它到这一页；平时页面上不挂用量。说明见 [cost.md](cost.md)。下面接着原来的运行记录：近 7 天运行、错误 Top 5、每次运行。

“联系 / pass / 跟进 / 备注 / 发”只追加 dashboard 反馈，工作台每 5 秒检查一次非空队列，通过已有 `apply-feedback` 处理（忙时顺延，失败延迟重试）；网页不直接写 Base 或发送。发送绑定展示过的具体草稿与指纹；草稿有变化会拒绝旧确认。ATS 提交、全投尚未接通，不提供假按钮。

## 启停

手工运行：`npm start`，需要 Node 22+。

常驻运行：`zsh bin/host/install-launchd.sh` 安装 launchd 项 `local.recruiting-radar-workbench`（标签前缀取 config/host.json 的 `launchd_prefix`，缺省 `local.recruiting-radar`，下同），系统登录后运行、退出后自动拉起。

```sh
launchctl print gui/$(id -u)/local.recruiting-radar-workbench
launchctl kickstart -k gui/$(id -u)/local.recruiting-radar-workbench
launchctl bootout gui/$(id -u)/local.recruiting-radar-workbench
```

日志：`runs/listener.log`、`runs/listener-error.log`，事件：`state/events.ndjson`。如果网页服务停止，已打开的网页保留内容，并把顶部连接状态变为红色。

## 飞书长连接

本机已配置 SDK 凭据，飞书事件订阅与发布状态已核验。连接是否在线以工作台实时状态为准。不要在聊天、报告或 Git 中粘贴密钥。

在本机私有文件 `private/feishu-listener.auth.json` 保存 `{ "app_id": "现有机器人 App ID", "app_secret": "应用密钥" }`，权限设为 600。也支持环境变量 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。复用原机器人和 `config/notify.json` 的本人 open_id；不接受其他用户或群消息作为授权。

按 [飞书官方 Node SDK](https://github.com/larksuite/node-sdk) 配置：开放平台启用机器人、事件订阅选择长连接并添加 `im.message.receive_v1`，核对 `im:message`、`im:message:send_as_bot`、`im:resource` 权限并发布版本。要在指挥室群里直接下指令，还需要 `im:message.group_msg`（群内所有消息）；只有 `im:message.group_at_msg` 时必须 @机器人。没有这两条，群消息事件根本不会推到本机，只能靠重连时的补拉（见 docs/concierge.md「群指令收不到？」）。配置完成后重启新工作台项，发一条真实测试消息验证。没有凭据时网页仍然可用。

当前 listener 能持久化本人消息、去重、重连后补拉，并把已支持的反馈交给同一个处理脚本。新链接和图片保存到 `runs/inbox/<id>/`，标为待来源处理器；公众号卡片识别、微软 JD 抓取和 ATS 预填尚未实现，不宣称转发自动投递已上线。

## 模型与边界

`config/model.json` 默认 vision / text 均走 `codex_exec`，使用本机订阅，串行、120 秒超时，`--ephemeral --output-schema`，图片参数 `--image`。旧 key 仅存于 `private/lowcost-legacy.auth.json`，不会回退使用。

`http_api` 为可选驱动，只有明确切换配置并提供 `private/http-api.auth.json` 时启用。工作台本身不调用模型；本轮仅一次真实图片冒烟调用，其余验证使用隔离夹具。

只允许打开事件中登记的 runs 文本、JSON、图片、PDF，拒绝 private、路径穿越和符号链接逃逸。反馈请求要求同源、会话 token 和本机 Host，并与现有状态写锁互斥。

## 演示 / 沙盒模式与「模型已开」（2026-09-30）

沙盒模式（`RADAR_SANDBOX=1`、`--sandbox`，或 `bin/demo-seed.mjs` 种过的目录里的 `state/sandbox.json`，见 `lib/sandbox.mjs`）默认什么都不发出去，也不调模型：对外的那一步跳过，在运行日志里记一行 `sandbox: skipped …`。截图、录屏、宣传片都用这个默认模式。

测试和演示要看到真的模型结果时（比如简历草稿由模型抽取，而不是只按版式整理），再加一个开关：

```sh
RADAR_ROOT=/tmp/offercrew-demo node bin/demo-seed.mjs
RADAR_ROOT=/tmp/offercrew-demo RADAR_SANDBOX=1 RADAR_SANDBOX_MODELS=1 node bin/serve.mjs --port 4399 --sandbox
# 或者：node bin/serve.mjs --sandbox --sandbox-models
```

开了之后页面上的小标是「演示 / 沙盒模式 · 模型已开」。

**放行的只有文字模型调用**（`lib/model.mjs` `infer`：简历抽取、匹配、草稿、评估；`lib/chat.mjs` `complete`；`lib/judge.mjs` 的 Jev；OfferCrew 补给中转的领令牌、查余额、列模型和经中转的调用）。它们在 `modelCall()` 里运行，闸只认这几种：

- `codex exec`：只读、文字调用的那组 feature 全关（没有 shell、网页搜索、浏览器、电脑操作、插件、MCP），并且供应商钉在 Codex 内置的官方 OpenAI（命令行 `-c model_provider="openai"`，`openai_base_url` 钉回官方的 ChatGPT Codex 地址）。切换供应商的工具把 `config.toml` 切到哪个中转，沙盒里的调用都不走它；环境里的 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 也不带进去。登录目录是环境里的 `CODEX_HOME`（没设就是 `~/.codex`），代码不读它里面的登录信息。演示目录的 `config/model.json` 列了 Codex 型号就按它来，没列就用 Codex 的默认型号。
- `claude -p`：一轮、没有工具、不连 MCP、不读设置、不留会话。
- 文字模型供应商的 HTTP 请求：自己的 key、Claude 网关、OfferCrew 补给的中转。中转地址可以用 `RADAR_FREE_RELAY_URL` 覆盖，可以是 `http://127.0.0.1:8787/model/v1` 这种本机的 `wrangler dev`，部署之前先在本机把整条路走一遍；覆盖了，已经领过的令牌也跟着走这个地址。

**永远不放行**：执行器和宿主脚本（`bin/host/*.sh`、要动手的 Codex / Claude）、内置操作员、ego 浏览器、电脑操作、飞书和 lark-cli、发邮件和私信、投递提交、System 自动修复、`open` / `osascript`。看图的模型调用也不放行。这些照旧只记一行 `sandbox: skipped …`。

**花的是跑的人自己的额度**：Codex 调用算在 `CODEX_HOME` 那个账号的订阅上，自己的 key 按 token 计费，OfferCrew 补给扣中转那边的补给。用量账照常记在这个目录的 `state/usage.ndjson` 里。

## Gmail 本机授权与手机回执（2026-09-10）

工作台左侧「手机与邮箱设置」打开 `/gmail-setup`。页面引导创建 Google OAuth 桌面应用、导入下载的 JSON 并完成 Google 授权。只接受 `candidate/facts.yaml` 的 `identity.mailbox`（`lib/gmail.mjs` expectedMailbox）；权限为 gmail.compose 和 gmail.readonly。回调使用 127.0.0.1、PKCE、一次性 state、10 分钟有效期；取得令牌后先独立读取 Gmail profile 核验账号，再保存刷新令牌。

客户端保存为 `private/gmail-oauth-client.json`，刷新令牌保存为 `private/gmail-token.auth.json`，均为 600 权限且不入 Git。访问令牌不落盘。不要把客户端 JSON 粘贴进聊天。Google External + Testing 的刷新令牌通常 7 天过期，详见 [Google OAuth 文档](https://developers.google.com/identity/protocols/oauth2)。

本次接通网页队列自动处理和飞书即时回执；飞书新消息的任务与回执可在重启后恢复、有限重试。回复使用稳定 UUID 去重，反馈执行成功但回执中断时只补回执。尚未完成真实 Google 授权；自动生成 / 发送邮件、转发来源解析与 ATS 提交仍未接通，授权成功也不会立即把历史队列当成可自动发送任务。


## 2026-09-12：飞书主动提醒入口

当前日常入口已升级为 [飞书求职助手](concierge.md)。上述本机 Gmail OAuth 是可选的独立接入方案；当前沿用 Codex 中已授权的 Gmail，不需要用户先完成该设置才能接收飞书通知。入口在「设置 → 高级邮箱接入」。卡片按钮、小步骤、任务提醒、真实调度状态与运行边界以新说明为准。

## 2026-09-21：指挥台（默认首页）

打开 http://localhost:4321/#command 。一页聚合系统现在的全部状态，并提供与飞书指挥室完全相同的操作入口；数据全部来自本机 `state/`、`runs/`、`config/`、`candidate/`，不调用模型，每次刷新约 1 秒。

**看板部分**

- 四个角色卡（Radar / Watch / Reacher / System）：正在做什么或最近一步、上一轮各阶段结果、关键数字（今日入库与判断、邮箱检查、待发草稿与拟投、飞书连接与同步）、最近 8 条事件。事件按步骤归到角色（`lib/command-center.mjs` 的 `roleOf`），周期任务的旧 actor 名（heartbeat / postman / nightwatch）不再暴露。
- 等我处理：进度视图（`lib/journey.mjs`）里等你决定的事项按类型分组（审核并发送、需本人提交、面试、补充信息、跟进、筛选……），加上拟发清单、拟投清单、待跟进、待对账邮件、刷卡进度。每行的按钮就是对应的指挥室指令。
- 阻塞的任务：执行器心跳里 blocked / 需要本人 / 失控的任务、宿主任务 blocked / waiting_user、自动预填失败或批准过期的线索。
- 异常告警：24 小时内失败事件按角色与消息分组计数；飞书未接通、飞书同步异常、即时执行器非正常退出、上一轮 degraded 的阶段、launchd 周期未按时启动、收件箱巡检超时、补发邮件未对账、官方源与真人帖来源失败、匹配多次失败的线索、状态写锁被谁持有。
- 线索集：在池 / 推荐 / 真人 / 今日入库 / 预筛排除 / 匹配失败，按阶段、城市、判断、来源的分布，重点岗位（`state/top-picks.json`）及每条卡在哪一步，今日新入库。
- 跟进情况：全部外发记录（渠道、天数、是否有回复、是否已对账）、收件箱最近事件、面试、内推人、今日邮件分流计数。
- 执行器与调度：即时执行器状态与队列、最近一次执行结果、执行器心跳任务、宿主任务队列、launchd 三个定时项与本进程的计划 / 下一次 / 最近一次 / 是否加载（读 `launchctl list`）。
- 个人信息与偏好：`candidate/facts.yaml` 的身份、城市、到岗、薪酬、偏好与排除、简历文件是否存在、待补的 TODO 项；`state/preferences.json` 的加权 / 降权 / 手改与学到的排除规则数。

**操作台部分**

- 指令框接受指挥室的全部语法（`lib/commands.mjs`）：`投 118`、`发 32`、`pass 44 原因`、`12 面试 2026-10-15 14:00`、`详情 32`、`筛选 杭州`、`我的待办`、`重点`、`拟发清单`、`拟投清单`，以及任意一句话。结构化指令走 `bin/action.mjs` / `bin/queue-apply.mjs`，来源记为 `dashboard`；需要模型或浏览器的指令写进 `state/run-now.json`，由常驻服务去抖 60 秒后拉起同一个即时执行器。
- 投递是自动预填，你在页面上检查后提交（2026-09-30）：`投 N` 确认后直接起确定性的预填脚本 `bin/auto-apply.mjs`（`lib/apply-kick.mjs`），不经即时执行器。脚本填好认得出的项，整页扫一遍还空着的必填项（`lib/apply-page-scripts.mjs` `REQUIRED_EMPTY`：输入框、单选 / 勾选组、Yes/No 按钮组），线索停在 `prepared_for_user`。收件箱的信写「#N 公司 已在浏览器里预填好 X 项。还要你补：……。检查后在页面上提交」，选项是打开申请页（ego 预填的那一页提到最前面）、我已在页面上提交了、这条不推进。认不出的题不在收件箱里问，列进「还要你补」；地点这类自动补全框只有候选和值完全一样才选，否则留空列出。系统不点提交：`config/pipeline.json` `auto_submit` 默认 `false`；打开后才恢复「终审确认 → 系统提交」，预填后读回有空着的必填项时不进终审（`prefill_incomplete`）。
- 发送与投递必须二次确认：`发 N` 先弹出该草稿的收件人、主题、全文和附件，`投 N` 先列出要批准的条目；确认后才落授权，指纹校验、首发幂等、职级与质量规则原样生效。未展示过的草稿不能从网页授权。
- 手动触发：轻量 / 完整周期、宿主整轮（含 Codex）、收件箱巡检、Jev 全量判断、收件箱增量、同步飞书、重算进度、整理宿主任务、更新指标、重算偏好。与 launchd 跑的是同一份脚本，一次只跑一个，状态写锁被占时拒绝启动，输出落在 `runs/<日>/ops/`，页面实时显示日志尾部。
- 阻塞处理：投递任务的「好了，恢复」与在飞书暂停卡片下回「好了」同一条路径（`bin/resume-executor.mjs`，保留原批准）；其它心跳记录只能清除；宿主任务可重试（回到 pending 并拉起执行器）或放弃。

接口：`GET /api/command-center`、`POST /api/command {text, confirm}`、`POST /api/ops {op}`、`GET /api/ops/log?id=`、`POST /api/unblock {key}`、`POST /api/host-job {id, action}`。POST 仍要求同源、会话 token 与本机 Host。改动后重启：`launchctl kickstart -k gui/$(id -u)/local.recruiting-radar-workbench`。

## 2026-09-21（下午）：可操作、可改、可聊、可换底座

在指挥台基础上补的四类能力，全部走已有入口，不新开发送 / 提交路径。

**点击即筛选。** 线索集里的每个数字（在池 / 推荐 / 真人 / 今日入库 / 预筛排除 / 匹配失败）、阶段条、城市 / 判断 / 来源标签都是筛选按钮，可叠加，结果表就地展开（`GET /api/leads`，`lib/command-center.mjs` 的 `leadsQuery`），每行带「联系 / pass / 投 / 原帖」。「在看板打开」把同一组条件带进岗位看板（看板新增城市、判断、只看真人三个筛选，并接受 `#board?city=杭州&verdict=recommend` 这样的地址）。告警旁的「看失败事件」跳到 `#stream?flow=fail`。

**草稿直接改、AI 重写、回退。** 等我处理、拟发清单、岗位详情页和发送确认框里都有「编辑 / 重写」，打开编辑器（`web/command.js` 的 `openDraftEditor`，接口 `/api/draft`，逻辑在 `lib/drafts.mjs`）：

- 本地草稿（平台私信、内推请求、脉脉附言）：改完立即生效，换一个 `edt-*` 的草稿 id，旧授权作废；因为这段文字就是你刚看过的版本，直接可「保存并发送」。脉脉附言 60 字、平台私信 300 字的上限在保存时校验。
- Gmail 草稿（id 形如 r4381…）：正文在 Gmail 里，发送前宿主会逐字核对，所以本地改动先记为 `pending_edit`、状态 `editing`，同时排一条 `revise_material` 宿主任务给即时执行器把 Gmail 草稿更新并独立回读，回读通过后才回到 ready、才能发。「恢复上一版」在同步前可撤回。
- 「AI 重写」只给提案不落盘：把岗位简报、`candidate/facts.yaml` 的证据、当前稿和你的要求交给 `config/model.json` 的文字模型（`lib/model.mjs`），返回主题 / 正文 / 改动说明，你看过再保存。

**对话（右侧面板）。** 原来的对话页（`#chat`）合进了右侧面板，见下面「2026-09-30：右侧面板」；旧的 `#chat` 链接打开面板里对应的那段对话。每轮把当前指挥台快照按成员裁剪后和提到的岗位简报、草稿一起交给模型（`lib/chat.mjs`，`config/chat.json`），模型以成员口吻回答；回答末尾的 `ACTIONS: […]` 变成按钮，走操作台同一条指令通道（发送 / 投递仍要二次确认）；`HANDOFF: …` 或「交给团队去做」把任务写成 `user_request` 宿主任务并拉起即时执行器，`thread.channel` 为 `web` 时执行器把回复追加到 `state/web-replies.ndjson`（见 `config/run-now-prompt.md` 5b）。会话存在 `state/chat/<id>.json`；模型只是在说，不会替你发送或提交。

**模型与参数面板。** 指挥台底部按文件分组（`lib/settings.mjs`，接口 `/api/settings`）：`config/host.json`（即时执行器 claude / codex、Claude 模型顺序、Codex 链与兜底、思考强度）、`config/model.json`（文字 / 视觉驱动与模型）、`config/judge.json`（Jev 开关、模型、阈值）、`config/chat.json`、`config/concierge.json`（静默时段、每卡行数、先审后投、内推优先、一张一张来）、`config/pipeline.json`（每轮匹配数、单公司上限、杭州名额）。只提交改过的字段，白名单之外不动，写前备份到 `state/backups/config/`；模型名旁的「测」向网关发一个最小请求验证可用。密钥文件只显示存在与否。

**个人事实与偏好。** 个人信息面板每一项旁的 ✎ 直接改 `candidate/facts.yaml`（白名单字段，`YAML.parseDocument` 保留注释，写前备份）；偏好学习里点任意一条设手动权重（-6…+6），× 撤销，＋ 添加新的键，写入 `state/preferences.json` 的 `manual`。

新接口：`GET /api/leads`、`GET/POST /api/draft`、`GET/POST /api/chat`、`POST /api/chat/handoff`、`POST /api/chat/delete`、`POST /api/settings`、`POST /api/settings/test`、`POST /api/facts`、`POST /api/preference`。测试：`tests/drafts.test.mjs`、`tests/chat.test.mjs`、`tests/settings.test.mjs`。

## 2026-09-21（晚）：底座可切换 + 共享记忆库

**底座（模型）现在是配置，不是代码。**

- 供应商 id 必须和 Codex 配置（`~/.codex/config.toml`）里的名字一致：`config/host.json` 的 Codex 链写了配置里不存在的 id（例如写成中转的品牌名，而配置里它叫 `custom`）时，每轮周期、巡检和兜底都会因 "Model provider `…` not found" 静默落到 OpenAI 官方订阅上。「模型与参数」面板顶部的「现在谁在用什么」会把不存在的供应商 id 标红并在告警里列出（`lib/settings.mjs` 的 `stackSummary`）。
- 供应商 id 从 `~/.codex/config.toml` 实时读取（`lib/backends.mjs` 的 `codexProviders`）：内置 `openai`（ChatGPT 官方订阅登录）+ 配置里的 `[model_providers.X]`（例如 `custom` = 一个 OpenAI 兼容中转，另一个中转用它自己的 id）。所有供应商下拉和校验都用它。
- 对话与 AI 重写的底座清单在 `config/chat.json` 的 `backends`：`anthropic_http`（Claude 经网关）或 `codex_exec`（GPT 经本机 `codex exec`，只读沙箱、临时目录，每轮固定开销约 3 万 token）。对话页右上可为每个会话单独选底座；`default` 是不选时的默认，网关类错误自动换下一个，点名的底座失败就失败。
- `config/model.json` 的 `text` / `vision` 在 `codex_exec` 驱动下新增 `provider` / `model` / `effort`，`lib/model.mjs` 会传给 codex。
- 一键预设（面板「一键切换底座」）：「网关 / 中转（按 token）」与「OpenAI 官方订阅（占 ChatGPT 额度）」，先预览会改哪些字段再写入，覆盖执行器、Codex 链与兜底、文字 / 图片模型、对话默认。定义在 `lib/settings.mjs` 的 `PRESETS`，接口 `POST /api/settings/preset {name, apply}`。
- 「测」按钮可测任一底座 id（`POST /api/settings/test {backend}`），GPT 经 codex 约 30–60 秒。

**记忆库：Claude / Codex / 对话 / 你共享的经验。**

- 文件 `state/memory/notes.ndjson`，一行一条：`{id, at, by(user|chat|claude|codex|system|dashboard), kind(decision|lesson|company|preference|todo|fact), subject, text, numbers, companies, tags, evidence, pinned}`；软删除。逻辑在 `lib/memory.mjs`，命令行 `bin/memory.mjs`（`--recall` / `--add` / `--list` / `--update` / `--delete` / `--stats`）。
- 检索不用向量：编号命中 +8、公司命中 +6、关键词（拉丁词 + 中文双字）命中 +1…+7、置顶 +2、时间衰减最多 −2；有查询时只返回命中的和置顶的，老经验命中了照样回来。
- 执行器协议已写进三份提示词（`config/run-now-prompt.md` 第 0 / 5c 步、`config/radar-cycle-prompt.md` 开头、`config/mail-poll-prompt.md` 第 0 步）和 `docs/concierge.md` 第 9 条：开工 `node bin/memory.mjs --recall "<任务>" --format md`（具体公司 / 编号再带 `--company` / `--number`），收工 `--add --by claude|codex`，每轮最多 5 条，只记以后会用到的教训、门户规则、公司特殊情况、用户明确的偏好或决定。
- 对话页：每轮把与消息、提到的编号和公司相关的条目放进系统提示；你说「记住：偏好｜…」直接入库（前缀可选 决定 / 教训 / 公司 / 偏好 / 待办 / 事实）；模型回复末尾的 `REMEMBER: …` 行落库并在气泡下显示「已记入记忆库」。AI 重写也会带上相关的公司备注和偏好。
- 指挥台「记忆库」面板：按类型 / 作者筛、搜关键词、新增、改正文、置顶、删除。接口 `GET /api/memory`、`POST /api/memory {action: add|update|delete}`（网页写入的作者固定为 `user`）。

## 2026-09-21（夜）：供应商目录、多账号、迁移

**供应商目录（`config/providers.json`，`lib/backends.mjs`）。** 每个供应商 = 一种驱动 + 一份凭据 / 登录态 + 一张模型清单：

| key | 驱动 | 登录 / 凭据 | 模型清单来源 |
| --- | --- | --- | --- |
| `claude_gateway` | `anthropic_http`（Claude 经网关） | `private/claude-api.auth.json` | 网关 `/v1/models`（探测得 11 个） |
| `claude_subscription` | `claude_code`（本机 `claude -p`） | `~/.claude` 的 Claude Code 登录态 | 手工维护，「测」验证 |
| `openai` | `codex_exec`（`codex exec`，内置 openai） | `~/.codex` 的 ChatGPT 登录态 | `~/.codex/models_cache.json`（官方订阅目录，含思考强度档） |
| `custom`（及其他中转的 id） | `codex_exec` | `~/.codex/config.toml` 里的中转 | 中转的 `/v1/models`（用 config.toml 里的 bearer） |

文件里没写的供应商按本机情况自动补；所有模型引用统一写成 `供应商/模型`（如 `openai/gpt-5.6-luna`），旧写法（`driver` + `models`）自动折算。目录里的模型可「探测」也可手工增删；每个模型旁「测」发一个最小请求验证。

**每个用模型的地方都从目录选**（「模型与参数」面板）：Claude Code 走哪个供应商（网关 / 官方订阅账号）、Codex 链与兜底（周期 / 巡检 / run-now 兜底）、文字生成清单、图片识别清单、对话可选底座与默认。清单编辑器按行选供应商 → 模型 → 强度，可上下移、加减、当场「测」。宿主脚本通过 `bin/host/resolve-provider.mjs` 把供应商 key 解析成 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `model_provider`。三个预设：网关 / 中转、OpenAI 官方订阅、Claude 官方订阅，先预览差异再写入。

**多账号。** 「添加账号」给 OpenAI 官方订阅或 Claude 官方订阅再开一个登录：新供应商 key 形如 `openai@work` / `claude_subscription@b`，登录目录 `private/accounts/<key>/`，界面给出 `CODEX_HOME=… codex login` / `CLAUDE_CONFIG_DIR=… claude auth login` 命令，在终端跑一次即可；状态栏实时显示每个账号是否已登录（`codex login status` / `claude auth status`）。任何清单都能选到这些账号，互不影响默认账号。

**迁移。** `node bin/migrate.mjs --export [--with-state] [--with-logins]`（或面板「迁移到另一台机器」三个下载按钮）导出 tar.gz：配置、个人事实、私有凭据、`~/.codex/config.toml`、记忆库、偏好表；`--with-state` 加业务状态，`--with-logins` 加 `~/.codex/auth.json` 与多账号目录。新机器 `node bin/migrate.mjs --import 包 [--dry-run] [--take-over] [--overwrite-codex-config]`，旧文件备份到 `state/backups/migration-<时间>/`；`--take-over` 改 run_host。`zsh bin/host/install-launchd.sh` 按新路径从 `config/launchd/*.plist` 模板生成并加载 4 个 launchd 项；宿主脚本已不含绝对路径。Claude 官方订阅的登录态在钥匙串里带不走，新机器上重新 `claude auth login`。包里有密钥，只经自己的通道传。

## 2026-09-21（夜）：角色底座

每个角色可以单独指定底座（`config/roles.json`，`lib/roles.mjs`，面板「模型与参数 → 角色底座」，角色卡片上也有一行「底座」和「改」）：

- **对话默认**：在对话页选到该角色时，不手选底座就用它（优先级：本轮点名 > 会话记住的 > 角色默认 > `config/chat.json` 的 default）。
- **文字生成清单**：该角色调模型生成文字时的尝试顺序——Radar = 岗位匹配（`bin/match.mjs`），Watch = 来信分类与摘要（`bin/inbox.mjs`），Reacher = 求职信 / 私信重写（`lib/drafts.mjs`）；`infer()` 带 `role` 参数，`lib/model.mjs` 按角色选清单，没设的跟随 `config/model.json` 的 `text.backends`。图片识别不按角色。
- 周期 / 巡检 / 即时执行器是一整个进程，不按角色拆，仍走 `config/host.json`。
- 空 = 跟随全局；解析不了的配置按跟随全局处理并在「现在谁在用什么」里告警。

## 2026-09-21（夜）：自己加供应商

「模型目录」底部的「添加供应商」可以接任意一家：

| 协议 | 适用 | 调用方式 | 凭据存放 |
| --- | --- | --- | --- |
| OpenAI 兼容 · chat/completions | DeepSeek、大多数中转、官方 OpenAI API key | 直接 HTTP `POST {base_url}/chat/completions` | `private/providers/<key>.auth.json`（600） |
| OpenAI 兼容 · responses | 官方 OpenAI、只支持 Responses 的 Codex 中转（不支持 chat/completions） | `POST {base_url}/responses`（`instructions` + `input`，`store: false`） | 同上 |
| Anthropic Messages 兼容 | 官方 Anthropic API key、别的 Claude 网关 | `POST {base_url}/v1/messages` | 同上 |
| Codex 供应商 | 要让 `codex exec` 跑的中转（必须支持 Responses） | OfferCrew 自己的 codex 目录 `private/accounts/codex@<key>/config.toml`，只含这一家（bearer），不碰 `~/.codex` | 该 config.toml（600） |

加完就是目录里的一个供应商：可「探测」（OpenAI 兼容走 `/models`）、手工增删模型、逐个「测」，在所有清单（Codex 链、文字、图片、对话、角色底座）里可选。卡片上「改地址 / 密钥」可换 key、换地址、切换 chat / responses；「删除」只对自己加的供应商和账号开放，凭据文件保留在 `private/` 下。驱动实现：`lib/chat.mjs` 的 `openaiComplete`、`lib/model.mjs` 的 `openaiHttp`（图片走 data URL）。Claude Code 无头执行器仍只能走 Anthropic 兼容或 Claude 官方订阅。

## 2026-09-21（夜）：按角色分页签、列表分页与同公司聚合

指挥台的操作台下面是五个页签，每个页签只放一个角色要处理的事：

| 页签 | 主栏 | 侧栏 |
| --- | --- | --- |
| Radar | 线索集（筛选 / 分页 / 按公司聚合） | Radar 的待办（刷卡）、阻塞、告警、偏好 |
| Watch | 收件箱与面试（面试、收件箱事件） | Watch 的待办（邮件对账）、阻塞、告警 |
| Reacher | Reacher 的待办（审核发送、投递、拟发 / 拟投清单、跟进） | 阻塞、投递与联络记录（外发、内推人）、告警 |
| System | 执行器（宿主任务、周期、模型链） | System 的待办（不确定项、问题）、阻塞、告警 |
| 我与设置 | 记忆库 | 个人信息、模型与参数、供应商、迁移 |

页签按钮上三个数字依次是：等我处理、阻塞、错误告警。阻塞任务的归属在 `lib/command-center.mjs` `blockedView` 里按来源和任务类型判定（投递 / 材料 / 联系 → Reacher，发现 / 转发 → Radar，面试 / 回复 → Watch，其余 → System）。

列表统一走 `web/command.js` 里的 `list(key, rows, render, {by, size, show})`：`by` 给出分组键（多数是公司），同一组默认只露 `show`（3）条，"展开全部"打开；分页按组翻，每页 5 / 8 / 15 / 30 组，页码与每页大小记在 `localStorage['radar.pages']`。面板 `max-height: 80vh`、内部滚动，所以页面高度不再随数据涨。

`/api/snapshot` 与 `/api/command-center` 的结果按被监视文件的 mtime+size 签名缓存（`bin/serve.mjs` `memo`），30 秒或文件一变就重算；指挥台 / 对话页不再拉整份快照。工作台进程的 RSS 在 System 卡上可见：一次全量重算的峰值约 1 GB，回收后堆只剩 ~10 MB，RSS 停在 500–600 MB 是 V8 不归还页面，不是泄漏。

## 2026-09-21（夜）：总览并入指挥台、运行日志可操作、交给 System 修

- 总览页删除。它的四块分别去了：今日进展漏斗 → 指挥台顶部一条 `funnel-strip`；连接 / 调度 / 模型状态 → System 卡与「执行器与调度」；等我处理 → 各角色页签；刚刚发生 → System 页签侧栏（链接到运行日志）。`#overview` 自动跳到 `#command`。
- 实时处理流改名「运行日志」：搜索框（消息 / 公司 / 步骤 / run id）、只看涉及岗位的、按运行分页（每页 20 次运行）。失败的运行在标题行有「交给 System 修」和「重跑轻量周期」；涉及岗位的事件行有 详情 / 联系 / 跟进 / pass 快捷指令，走的是与操作台相同的 `/api/command`。
- 阻塞的任务、错误告警、执行器心跳里卡住的项，都能「交给 System 修」（`POST /api/system-fix`，`lib/command-center.mjs` `handToSystem`）：写一条 `kind: system_fix` 的宿主任务（`target` 带来源、原因、证据、关联 id），排队即时执行器。执行器按 `config/run-now-prompt.md` 2a 查根因修复，结果写回 job，指挥台把状态和结果挂回原阻塞项（`system_job`）。同一目标只保留一条未完成任务。
- 执行器心跳从 5 列表格改为行式卡片，按执行器分组分页。
- 对话页不再提供「设为默认底座」：底座只在「我与设置 → 模型与参数 → 角色底座」里改（每个角色的对话底座与文字生成底座）；对话页的下拉只对本次会话生效。

## 2026-09-21（夜）：执行器与工作台解耦、System 修的第一次端到端

- 即时执行器 `bin/host/run-now.sh` 由工作台以独立进程组拉起（`spawn` + `detached`），工作台重启不再杀掉它；包装进程 pid 记在 `state/run-now.json`，`reconcileRunNow()` 在启动和每次 tick 用它判断执行器是否还活着（进程没了或超过 30 分钟就按中断收尾、清心跳）。run-now.sh 自己的互斥改为 `state/run-now.pid`（`claude -p` 的参数是提示词正文、`codex exec` 从 stdin 读，进程名里都没有提示词文件名，原来的 `pgrep -f run-now-prompt` 从不匹配）。
- 周期迟到告警改看全天的 `scheduled start`（原来只看最后 8 行日志，09:05 的周期 09:22 启动却被报"没有按时启动"）。
- 周期里 pull-feedback 超时 10 分钟、`--wide` discover 30 分钟（飞书网络抖动时原来的 5 / 15 分钟会 ETIMEDOUT）。
- 第一次真实的「交给 System 修」（2026-09-21 20:17，目标 discover-human degraded / linux.do 403）：按钮 → `system_fix` 宿主任务 → run-now → Claude 执行器 3 分钟内查明根因、新增 `config/human-source-policy.json`（linuxdo 暂停）、改 `bin/discover-human.mjs` 记 paused、跑测试并实跑一轮、写记忆、结果写回 job；指挥台告警行显示「System 已处理」和结果。告警行也挂 `system_job`（比对文案时去掉"（24 小时内 N 次）"）。
- 同一晚 cycle-host 的 Codex 自己修了岗位清单的 `DOC_TABLE_CELL_LIMIT`（每 200 行分表）并让清单也遵守城市冲刺；重点岗位（`lib/top-picks.mjs`）同样只看冲刺城市。

## 2026-09-21（深夜）：指挥台 v3 —— 一列到底、按部件划分、System 自动修复

设计方向：第一眼要看的是**系统概览**和**等我处理**；扫描之类的脚本放在它所属的部件下（线索不够再扫）；自定义指令只留在对话里，脚本做成模型可调用的工具；面板占满宽度、竖着排；设置与记忆是左侧导航的独立页；「阻塞」和「需要修复」要分开：流程设计里要用户确认的进「等我处理」，流程之外走不下去的归 System 自动修，只有 System 需要决策时才来问。

### 页面结构（`web/command.js` `commandPage`）

1. **系统概览**：四个部件各一格（状态、正在 / 最近、三个关键数字、「等你 N」「问题 N」），点格子滚到对应区块。
2. **等我处理**：「需要我确认 / 授权」（登录门户、重新批准、恢复任务，即 `blocked` 里 `needs === 'user'` 的）+ 待办组 + 拟发 / 拟投清单 + 跟进 / 对账 / 问题。这里的按钮全是确定性的指挥室指令；回执画在区块顶部的日志框。
3. **Radar**：状态条（正在、四个数字、阶段 chips、最近事件、底座）→ 线索集（筛选、结果、重点岗位、今日新入库）→ 告警（折叠）→ 脚本：扫描官方源 / 全量 / 抓真人帖 / 匹配 / Jev 全量判断。
4. **Watch**：收件箱与面试 → 告警 → 脚本：收件箱巡检（Codex）/ 收件箱增量。
5. **Reacher**：投递与联络记录 → 告警 → 脚本：找联系人 / 找内推人 / 准备材料 / 自动预填已批准的申请（你在页面上检查后提交）。
6. **System**：自动修复状态 → 修复记录（`system_fix` 任务：排队 / 处理中 / 已修 / 等你）→ 系统问题（`needs === 'system'` 的阻塞，System 会自动接手，也可「现在修」）→ 告警（折叠）→ 执行器与调度（折叠）→ 刚刚发生（折叠）→ 脚本：周期 / 同步 / 重算。

`#settings`（个人信息、偏好、模型与参数、供应商、迁移）和 `#memory`（记忆库）是独立页；右上「改 ✎」一类链接用 `#settings?jump=<表单 id>` 直接定位。

### 阻塞的两类（`lib/command-center.mjs` `blockedView` 的 `needs`）

| `needs` | 含义 | 去哪 |
| --- | --- | --- |
| `user` | 流程设计里就要用户：登录墙、验证码、重新批准（指纹变了）、恢复被暂停的任务、执行器提出的问题（`waiting_user`） | 等我处理 → 需要我确认 / 授权 |
| `system` | 流程之外走不下去：脚本抛错、宿主任务 `blocked`、执行器失败或卡死 | System → 系统问题；自动修复接手 |

### System 自动修复（`autoRepair`，`config/host.json` `system_auto_repair`）

工作台每 5 分钟（启动 90 秒后一次）把 `needs === 'system'` 的阻塞项和非瞬时网络的错误告警（`TRANSIENT` 正则排除飞书断连 / TLS / ETIMEDOUT / 周期迟到之类）自动 `handToSystem`。节流：同时最多 `max_open`（默认 1）条未完成，每小时最多 `per_hour`（默认 2）条，同一目标 `cooldown_hours`（默认 24）内不重复。执行器按 `config/system-fix-playbook.md`（工作流、分类处置表、禁区）处理；需要用户决策的置 `waiting_user`，会出现在「等我处理」。开关与阈值在设置页「主控执行器」里改。

### 脚本即工具（`OPS` 带 `role`，对话里「运行 <脚本>」）

`OPS` 每条带 `role`，新增 `discover` / `discover-wide` / `discover-human` / `match` / `find-contacts` / `find-referrers` / `prepare-applications` / `auto-apply`。对话页的系统提示里列出本角色可用的脚本；模型把要跑的写进 `ACTIONS: ["运行 discover"]`，网页上变成按钮，用户点了才经 `dispatchCommand` → `runOp` 真正运行（一次只跑一个）。模型不直接执行任何脚本。

### 模块切换与「需要我做的」（同晚补充）

- 概览五格是切换器：等我处理 / Radar / Watch / Reacher / System，点一格下面只显示那个模块（`localStorage['radar.module']` 记住），模块内部再竖排。不是把所有模块一路排到底。
- 每个角色模块开头是「需要我做的」：该角色的待办组 + 需要确认 / 授权的阻塞项（例如 Reacher 里的"需本人加好友 / 加微信"、门户登录、重新批准）。「等我处理」模块是全部角色的汇总。
- 需要登录 / 授权 / 本人提交的项有「打开登录 / 处理页」按钮：`POST /api/open-url` → `lib/ego-browser.mjs` `openForUser()` 在 ego 浏览器的固定任务空间（id 记在 `state/ego-user-space.json`，按名字「OfferCrew · 需要你处理」复用）里只打开那一个页面、`handOff()` 交给用户，并 `open -a "ego lite"` 拉到前台；做完回来点「好了，恢复」或「重试」。ego 的坑：交给用户后空间的 `ownership` 变成 `agentDelegatedToUser`，再动它之前必须 `takeOverTaskSpace(id)`，否则 ego 的 nodejs 直接以 code 1 退出。阻塞项的 `url` 由 `blockedView` 从线索的申请入口取。
- 执行器的浏览器纪律写进了 `config/run-now-prompt.md`：一轮只用一个任务空间、`goto()` 复用页面、结束 `finish({ keep: [] })`、只有要用户动手时才 `handOff()` 并把 URL 写回 job 与线索。之前满屏的 ego 窗口就是执行器每次新开空间又不收尾留下的。

### 收拾 ego 浏览器（`bin/browser-tidy.mjs`，System 模块「收拾 ego 浏览器」）

结束所有 Agent 创建的任务空间（`listTaskSpaces()` 里 `createdBy === "agent"`），委托给用户的先 `takeOverTaskSpace` 再 `finish({ keep: [] })`；只保留 `state/ego-user-space.json` 里那个「需要你处理」空间和用户自己的页面。2026-09-21 第一次运行：关掉 16 个空间，ego 渲染进程 31 → 13，内存 3.0 GB → 2.0 GB。

### 每一项都能归档（2026-09-21 深夜）

「需要我做的」里每一行右侧有「归档」：弹窗二选一。**只归档这一项**——待办项写 `state/action-overrides.json[action.id].archived_at`（`lib/journey.mjs` 见到 `archived_at` 就不再生成这项），阻塞 / 确认行写 `state/dismissed.json[dismiss_key]`（`blockedView` 过滤掉）；`POST /api/archive`。**结束整条线索**——指令「N 归档 [原因]」（`bin/action.mjs`）：线索阶段置「归档」、记 `previous_stage / archived_at / archive_reason`，它的全部待办在 overrides 里标 `completed_at + archived_at`，以后不再出现也不再提醒；线索保留，看板「归档」可查。拟发 / 拟投清单仍走原来的「不发」「pass」。

## 2026-09-30：右侧面板 —— 只放对话（布局 v3.1）

原来指挥台底部的指令栏说完只有一条提示，侧栏还有一个单独的对话页，申请详情是盖在表格上的抽屉。现在对话停靠在右边的一栏（`web/panel.js` 是骨架，「对话」由 `web/talk.js` 画，服务端 `lib/talk.mjs`）。它把主区域推开，不盖住表格；面板里的输入框是唯一说话的地方。面板里只有对话：没有成员头像排，也没有「详情」标签；在面板里点什么，主区都不跟着换页，所以可以一边看岗位页一边说话。岗位详情在主区的岗位页（下一节），任务卡在任务页上就地展开。

**开和关。** ⌘K / Ctrl+K 在任何一页打开它并把光标放进输入框；焦点不在输入框时按 `/` 也行（收件箱里 `/` 让给那一页）。⌘\ / Ctrl+\ 或标题行的 × 收起；光标在面板里时 Esc 也收起。面板关着时，右下角一个小圆按钮「问」打开它（页面上没有顶栏了；连接断了才在右上角出一条小条）。第一次打开页面时，窗口不窄于 1200 px 就默认开着。

**宽度。** 拖面板左边那条线：320 px 到窗口的一半，拖的时候旁边写着多宽；双击恢复 380 px。开没开、多宽记在这台电脑的浏览器里（`localStorage` 的 `oc.panel`），刷新后还是那样。标题行的 ⤢ 让面板铺满主区域（侧栏还在），再按一次还原。窗口不到 900 px 时面板是一整屏的 sheet，不推开主区域，没有拖宽和铺满。停靠以后主区要是窄于 600 px（窗口 − 左栏 − 面板，比如 960 px 宽的窗口），面板改成盖在主区上的一层（不盖左栏），不再把主区挤窄；窗口变宽后自动回到停靠（`layoutMode`）。

**成员只做署名。** 交给谁由系统判断，成员不是导航：面板上没有头像排，指挥台的表格也没有「成员 ▾」筛选。成员出现在岗位页「进展」的每一步（一个小头像，鼠标停上去是名字）和等你的那封信上（发信人的头像）。成员能做什么、在做什么在团队页 `#team/<id>`；老链接 `#command/<成员>` 转到那里。

**标题行和会话。** 每段对话都是和整个团队说。左边是当前对话的标题 ▾（还没有标题就用第一句话，都没有是「新对话」），不挂某一位成员的脸。点开是对话历史：搜索框（成员名也能搜）、按今天 / 昨天 / 更早分组、每行带回过话的成员的小头像（以前单人的会话，那位排最前）、每行的 × 删除这段、最下面「＋ 新对话」。右边三个按钮：+ 新对话、⤢ 铺满、× 收起。

**岗位页 `#lead/<rid>`（web/hq.js leadPage）。** 点指挥台表格的一行（或行上的 去补 / 去终审），主区换成这条的岗位页；原来的完整详情和右侧抽屉合成了这一页。
- 页头：「← 来处」回到你来的地方（指挥台的哪个标签、收件箱或任务页，标签、搜索和表格滚到的位置都还在）；公司、岗位、城市、#编号、薪资（有才写）、原帖、所处阶段；右边「‹ 1/3 ›」按来处那张表的顺序翻上一条、下一条，键盘 j / k 也行。来处记在这个标签页的 `sessionStorage`（`oc.leadFrom`）。
- 等你的那封信：整封放出来（和收件箱是同一封：选项、表单字段、要确认的第二下才生效），就地回答；答完这一块变成「✓ 做了什么」和「下一件 →」（来处列表里下一件还等你的）。没有等你的事时，这一行写现在的状态，放 pass 或重新打开。
- 四个页内标签：「JD 与判断」（判断和理由、主要缺口、逐项对照、一页评估、完整 JD 可展开、原帖和申请页）、「材料」（投递会用哪一份简历、Reacher 选的还是你选的，「换一份 ▾」，这个岗位的定制版；求职信、消息草稿、申请表拟填的内容；见 [docs/resume-assistant.md](resume-assistant.md)）、「进展」（每一步一个小头像、证据文件、联系记录和对方回复，下面是全部处理记录）、「公司」（点到才画；没有简报时是调研按钮）。
- 主区正在看的岗位（岗位页开着，或收件箱里选中了挂在岗位上的信）由 `focusLead()` 给出，形状 `{ rid, number, company, role }`；变了（进岗位页、收件箱换一封、离开）就发 `oc:viewing`，detail 是这个对象或 null。对话输入框上的「正在看 #12」跟着它。

**指挥台页头。** 和别的页一样的大标题「指挥台」加件数；右边「找新岗位」跑一轮 Radar（和团队页「立即跑一轮」同一个 op `round-scout`、同一个接口 `POST /api/team/run`）。表里一条都没有时它是主按钮；Radar 在跑时按钮写「在找… 已 N 分钟」，空表上写「正在找第一批岗位」和跑了多久（`/api/hq` 的 `op_now`）。第一次走完引导（`web/onboarding.js`）马上发起这一轮，不等下一轮定时任务。

**左栏六项。** 指挥台、团队、任务、收件箱、材料、设置。岗位看板（和指挥台同一份数据）、运行与用量、记忆库不在左栏了，网址照样能打开：`#board`、`#usage`（设置 → 花费 →「详细用量 ›」）、`#memory`（设置 → 高级 →「记忆库 ›」）。

**@。** 输入框里打 @ 弹出选人：成员按显示名或 id 都认。@ 只管这一条：这一句交给那位，会话不换、也不另开（POST /api/talk 带 member）；不 @ 就由系统分派，`@团队` 不算点名。`@#128`（或 @ 加编号、公司名）带上那一条岗位，等于「正在看 #128」。

**贴链接收录。** 贴一个岗位链接（前面可以加「收 / 看看」），开一张「收录并核验」卡。链接后面顺手写上 HR 邮箱（例如 `https://… hr@公司.com`），收录时记成这个岗位的联系邮箱（`email_source: owner`），之后「N 联系」就走邮件；只收你写的邮箱，不从网页上猜。

**一句话怎么走。** 面板上不用挑成员：
- `lib/commands.mjs` 认得的指令（投 12 13、pass 44 原因、12 联系、详情 9、运行 <脚本>……）走和 `/api/command` 同一个 `dispatchCommand`；发送 / 投递第一次只拿预览，弹同一个确认框（`web/command.js` `confirmPreview`），你确认了才执行。
- 别的话走对话（`chatTurn`），由 `lib/talk-route.mjs` 的关键词打分挑成员（确定的，同一句话永远同一位）。单独和一位说时跳过这一步。
- 回复里的按钮也走这条路（回执进同一段对话，确认框照旧）。模型建议交给团队时有「交给团队去做」；普通的一句回话、没交出任何事时，最新那条下面有一个小的「交给团队去做」（把你刚才那句原话交给执行器）。模型没回时，你的原话下面有「直接交给团队去做」。每条回话下面一行小字：哪个模型、多少 token、用了多久。

**回音三拍。**
- 收到：发出去的那一刻你的话先出现，下面是「<成员> 在看…」（指令是「在办…」）。指令的回执是管这件事的那位说的一句，列出动到的几行；「投」按 `bin/queue-apply.mjs` 自己报的去向写每一行。
- 进行中：交出去的事是一张任务卡：谁在做、一条四段的进度、执行器心跳里最新的一步（「<成员> · 用浏览器：填表 9/12」），「展开细节（N 步）」是带时间的每一步和证据链接。排队中（60 秒内可撤回）→ 在做 → 做完 / 需要你 / 卡住了，状态只看执行器自己的报告（`state/run-now.json`、`state/host-jobs.ndjson`、`state/web-replies.ndjson`、`state/ops.json`），从不显示模型的思考过程。
- 结果：一句话加链接。「查看 #12」在主区打开这一条的岗位页（面板不动）。需要你的就在卡片上答，和收件箱里是同一封信（`/api/inbox/answer`）。

**面板关着时。** 在做的事不闪、不数；有回音落地（执行器写回、做完、需要你、卡住了），右下角的「问」上一个不动的点，弹一条「<成员> 回复了 · 查看」，点了回到那条消息。

**表格变窄也好认。** 表格按自己的宽度收紧（CSS 容器查询，不看窗口宽度）：宽度 1000 px 以上是完整的表格；700–999 px 渠道并进行的第二行（「上海 · #11 · 私信」）；700 px 以下八个步骤点换成一条进度加当前这一步的名字。

**一个会话库。** 所有对话读写同一批 `state/chat/<id>.json`；不点名时接着用 6 小时内说过话的那段，更早的就开新的。指令的回执也记进会话（`kind: "receipt"`）。几路同时写同一个会话时，`saveSession` 先把磁盘上多出来的消息并进来再写。指令排给即时执行器时带 `thread: { channel: 'web', session_id, message_id, persona }`，执行器按 `config/run-now-prompt.md` 5b 把结果写回这个会话。

**旧链接。** `#chat`、`#chat/<会话>`、`#chat/<成员或旧角色>`、`#chat?persona=…` 都打开面板里对应的那段对话，页面回到原来那一页。

**从页面外面叫出来**（桌面壳的全局快捷键 ⌥⇧Space 用）：都只打开、预填，从不替你发——发出去永远要你按 Enter（`tests/talk-summon.test.mjs`）。
- 地址：任何一页的 hash 带 `talk=1`（`#command?talk=1`）就打开；`talk=<一句话>` 打开并填进输入框。读完就从地址里拿掉。
- 事件：`window.dispatchEvent(new CustomEvent('offercrew:talk', { detail: { text } }))`。
- 函数：`window.OfferCrew.openTalk(text)`；`window.OfferCrew.panel.open({ tab: 'talk', thread, member, text })` 打开某段对话；老的 `open({ tab: 'lead', rid })` 改成主区打开岗位页，`open({ tab: 'lead', card })` 改成任务页展开那张卡；还有 `close()`、`toggle()`、`isOpen()`。

接口：`GET /api/talk[?session=<id>|?member=<id>][&examples=1]`（会话、每件事的状态、团队在做几件、刚落地的回音、成员）、`GET /api/talk/parse?text=&previous=&member=&focus=`（预览，只读）、`POST /api/talk {session_id, text, member, focus, confirm, via}`、`POST /api/talk/withdraw {session_id, message_id}`；会话列表和删除用 `GET /api/chat`、`POST /api/chat/delete`。POST 和别的一样要同源、会话 token。

### 2026-09-30 晚：接上团队名册、成员工作台的位置、没有模型也能用

**名字和脸从名册来。** 面板上的成员表（`lib/members.mjs`）是 `lib/crew.mjs` 上的一层薄皮：显示名 Radar（scout）、Judge（lens）、Writer（tailor）、Reacher（quill）、Watcher（owl）、System（patch），加上「你」和「团队」；每位带 `face: { icon, fill, ink }`，由 `web/crew-faces.js` 画（`web/face.js` 只把服务端给的 face 交给它）。没有 emoji。`@` 选人和命令里的成员名认显示名、id 和老名字（Scout、Lens、Tailor、Quill、Owl、Patch）。

**一件事只有一位。** 问一条线索的团队、级别、公司（「查一下 #26 招的是哪个团队、什么级别」）交给 Judge。交出去的事，任务卡和执行器的回报都记在交出这件事的那位名下（`memberOfJob`）；做完的回报并进任务卡，不再单独重复一条，也只提示一次。

**下一步按钮说人话。** 「批准投递 #28、#29」「跟进 #18」，按钮背后还是那条指令（悬停能看到）。会话切换的搜索也搜说过的话，搜到内容时标题下面带一小段原话。筛选栏窄的时候标签横着滑、右边淡出，选中的那个总会滑进来；成员标签和搜索框一直在。

**成员不只是对话。** 成员能做的事、手上的任务都在团队页（`#team`、`#team/<id>`，web/team.js）；面板不放它们（负责人 09-30：面板只是对话）。**问不等于交办**：问一句（「#12 值得投吗」）只在对话里答，不开卡、不排任务，回话下面也不放「交给团队去做」；请它做事（「帮我投递 #12」「能帮我调研一下 #12 吗」）才开卡。排着的卡写明在等什么：演示 / 沙盒模式不会真的跑、后台任务关着不会自动跑、执行器暂停了、排队中等执行器领取、等模型。

**没有能用的模型时。** `lib/chat.mjs modelState()` 判断：演示 / 沙盒模式、一个能用的底座都没配，算没有；上一轮调模型失败算「没调通」（下一句还会再试）。没有时输入框上面一行「现在没有能用的模型：对话先停，按钮和命令照常能用」，自由的话不调模型，回一句说清楚哪些照常能用。不经模型照样能跑的命令：`投 N`、`跟进 N`（= `N 跟进`）、`暂停 <成员>` / `恢复 <成员>`（`lib/command-center.mjs agentAction`）、`<成员> 跑一轮`（= `运行 round-<id>`），成员名按名册认。`GET /api/talk` 带 `model: { ok, why, note }`。

## 2026-09-30：手机（设置 → 手机，接口 `/api/phone`）

手机是电脑上 OfferCrew 的遥控器：看进度、回收件箱里的信、跟团队说话。活还是在电脑上干。接口契约见桌面版方案附录 F；代码在 `lib/phone.mjs`（入口）和 `lib/phone/`，中转在 `relay/phone/`（Cloudflare Worker `offercrew-phone`，负责人自己部署，见 `relay/phone/DEPLOY.md`）。

**怎么连。** 电脑只往外连到中转上自己的「房间」，不开端口；手机打开 offercrew.onemaple.cc/app/（手机网页，可以「添加到主屏幕」；offercrew.onemaple.cc/ 本身是产品介绍页）进同一个房间。只有配过手机、或者正在配对时，电脑才连中转。

**配对。**
1. 「设置 → 手机」点「扫码配对手机」，出现二维码和 6 位配对码。10 分钟内有效，只能用一次；再点一次，前一个作废。
2. 手机扫码，或者输配对码。
3. 两边显示同一串 6 位核对数字，一样就在电脑上点「一样，确认配对」。不点这一步，配对不算成功。

二维码里的一次性密钥在 `#` 后面，浏览器不会把它发给服务器。

**加密。** 只用 WebCrypto：X25519 交换密钥，HKDF 派生，AES-GCM 加密；手机网页和电脑用的是同一份代码（`lib/phone/crypto.mjs`）。
- 中转只转发看不懂的密文。电脑不在线时，它把密文先存着，有上限，存一天，电脑醒来就收到。
- 电脑对每部手机的每一帧只收一次，被改过的、太旧的都不收。

**手机能做的只有四件事**（`lib/phone/api.mjs`）：
- 看进度。
- 看等你回的信：和收件箱是同一份，去掉了内部步骤和本机文件路径。
- 回信：走和工作台同一个 `answerAsk`，先核对你看到的是不是现在这一版。确认提交、发送、投递这类，手机上先看预览，拿到一次性确认码，点「确认」才执行，所以跳不过终审。
- 跟团队说话：进同一个对话面板，会话里标着来自手机。

没有设置，没有文件，没有密钥。

**交给执行器默认关着。** 这部手机没被允许时，指令一律不执行，只回一句说明，因为很多指令会拉起执行器。执行器在这台 Mac 上不带沙箱运行，所以只能在电脑上的「设置 → 手机」里打开。

**本机文件。** 都在 `private/phone/`，目录 700、文件 600，任何接口都不返回里面的密钥：
- `mac.json`：房间号、连中转的令牌、电脑的私钥。
- `devices.json`：每部手机的根密钥、令牌摘要、防重放记录。

「解除配对」会立刻删掉这部手机的密钥，并让中转断开它、清掉排队的帧。

**中转地址。默认开。**什么都不写，就用 OfferCrew 的中转（`https://offercrew.onemaple.cc`），装好就能配对手机。按下面的顺序认：
1. 环境变量 `OFFERCREW_PHONE_RELAY`。
2. 数据目录里的 `config/phone.json`（本机文件，不进仓库；模板是 `config/phone.example.json`），用自己部署的中转时写 `{ "relay": "https://你的域名" }`。
3. 都没有：默认的中转。
4. 不想用手机：`config/phone.json` 里写 `{ "relay": "off" }`（或 `""`）。关着的时候工作台不去探测、不联网，`reason` 是「手机中转还没开通」。

中转连不上时，`available` 是 `false`，`reason` 是「连不上中转服务」，界面照抄。

**演示 / 沙盒模式。** `available` 一律是 `false`（「演示 / 沙盒模式：不连手机」），`pair_start` 答 409。唯一的例外给测试和本机开发：`OFFERCREW_PHONE_RELAY` 指向 `127.0.0.1` 上的中转（`cd relay/phone && npm run dev`），东西出不了这台电脑。

**测试。**
- `tests/phone-crypto`：核对数字、中间人、改帧、重放。
- `tests/phone-relay`：中转本身，在假的 Durable Object 环境里跑。
- `tests/phone-api`：四件事和确认码。
- `tests/phone-service`：配对全流程，以及中转看不到明文。
- `tests/phone-e2e`：wrangler dev 起的中转、沙盒工作台和脚本手机，中间夹一个录音代理；relay/phone 里没装 wrangler 时跳过。
