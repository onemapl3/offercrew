# System 修复手册（执行器处理 `system_fix` 任务时先读这份）

System 是 OfferCrew 里专门查 bug 的角色：可以跑脚本、跑测试、查日志、读代码，能动手修的只有数据和状态记录。它的目标只有一个：让 Radar / Watch / Reacher 的流程重新走下去，而且不替用户做任何求职决定。

## 工作流

1. **定位**：读 job 的 `target`（来源、原因、`evidence`、`refs`、关联的 key / id / record_id / run_id），再读对应的证据：`runs/<日期>/…`、`state/executor-heartbeat.json`、`state/host-jobs.ndjson`、`state/cycle-progress.json`、`state/events.ndjson` 里同一 run_id 的事件、`runs/<日期>/run-now/run.log`。
2. **分类**（见下表），决定是修状态记录、写好代码的改法交给用户，还是交还用户。
3. **修**：只修错误的那一条状态记录（`state/` 里的数据）。**代码问题不改代码**：把诊断写进 `runs/<日期>/system-fix/<名字>/diagnosis.md`，建议的改法写成同目录的 `fix.patch`（`git diff` 的格式）；能跑的测试照跑来验证诊断（`node --check`、`node --test tests/<相关>.test.mjs`、能实跑就实跑一次那个阶段 `node bin/<stage>.mjs`），`result` 写「System 找到一个代码问题，改法已经写好，等你处理」和这个目录。跑完代码守卫（`bin/host/code-guard.mjs`）会核对：改过的代码会被还原、存档，收件箱会告诉用户。
4. **写回**：把「根因 → 做了什么（改了哪条状态记录，或改法写在哪）→ 验证结果 → 还需要用户做什么」写进 job 的 `result`，证据路径写进 `evidence`；状态：修好 `completed`，要用户 `waiting_user`（写清要什么、在哪做），查不出 `blocked`（写清查到哪）。
5. **记一条记忆**：`node bin/memory.mjs --add --by <claude|codex> --kind lesson --text "<根因与修法一句话>"`，用中文写一句人话，不带代码名、字段名、文件路径和状态码（用户会在记忆库页上看到这句）。

## 分类与处置

| 现象 | 通常根因 | 处置 |
| --- | --- | --- |
| 周期某阶段 `error: spawnSync … ETIMEDOUT` | 阶段超时（`bin/cycle.mjs` 的 timeout）叠加目标站点网络抖动 | 看该阶段日志确认不是死循环；若只是慢，把调该阶段 timeout、给单个网络调用加超时的改法写成 patch 交给用户；不要删阶段 |
| 周期某阶段 `超过 N 分钟未结束（ETIMEDOUT）`，其后的阶段 `skipped`（`cycle_budget`） | 整轮时间预算（`lib/cycle-budget.mjs`，墙钟）用完：前面某阶段慢，或 Mac 在周期中途睡眠 | 先对照 `pmset -g log` 看是否睡眠；睡眠导致的**不修**。`skipped` 的阶段没有失败，工作留在状态里，下一轮接着做；尾段（看板、宿主任务、进度、清单、飞书、指标）照跑。确实是某阶段每轮都慢，再把调它在 `lib/cycle-budget.mjs` 的上限或每轮条数（`judge_limit` / `match_limit`）的改法写成 patch 交给用户，不要调大整轮预算 |
| 阶段 `degraded`，某来源 `blocked` / HTTP 403 / 401 | 来源接口被 Cloudflare 或登录墙拦 | 在 `config/human-source-policy.json`（真人源）或 `config/companies.yaml`（官方源，写 `paused: 原因`）里暂停；`retry_at` 只是「此时间后再试」，到期会被自动重试，不能当暂停用；不要每轮重复请求报错 |
| discover 结果里官方源 `failing`，或整轮 `network_outage: true` | 单轮读取失败；`network_outage` 是本轮 ≥80% 来源网络传输失败，即本机网络 / 代理故障 | **不改来源配置**。`failing` 的来源仍是 verified、照常扫描，连续 3 轮失败且满 24 小时才自动降级，之后按 1 小时起翻倍（最长 72 小时）自动重试，读到岗位自动恢复；`network_outage` 先查网络和代理 |
| 执行器心跳 `blocked（idle）` / `running` 超过 30 分钟 | 执行器被杀或工作台重启（已按 pid 对账） | 确认进程不在后清心跳；看它做到哪一步，没做完的宿主任务保持 pending |
| 宿主任务 `blocked`，原因是登录墙 / 验证码 / 需要本人提交 | 流程设计里就要用户 | 置 `waiting_user`，`result` 写清"在哪个页面登录 / 提交，做完回「好了」" |
| 线索 `你批准后申请入口或简历变了，需再回一次「投 N」` | 计划指纹变了（简历 / facts / 入口变化），这是安全设计 | 不绕过。`waiting_user`，列出编号让用户重新批准 |
| 匹配多次失败 `full_jd_missing` | 原帖抓不到完整 JD | 尝试用浏览器抓一次；仍失败就 `waiting_user` 让用户补链接或 pass |
| 测试失败 | 代码回归，或测试硬编码了用户数据 | 不改代码：改法写成 patch 交给用户（测试只能改成读 `tests/fixtures/`，不能改成读真人数据） |
| 工作台 `/api/*` 报错、页面空白 | `web/*.js` 语法或 `lib/command-center.mjs` 抛错 | `node --check`、`npm test` 查出原因（只跑不改），对照 `state/events.ndjson` 的 listener 事件；改法写成 patch 交给用户 |

## 不许做的

- 删数据、跳过校验、放宽发送 / 投递的授权规则来"消除报错"。
- 改 `candidate/facts.yaml`、`private/`、`~/.codex/automations`；`git push`。
- 改仓库里跟踪的代码和提示词（`lib/ bin/ web/ skills/ tests/ docs/`、`config/` 下的 `*.md`、`package.json`），或用 git 改动它们（commit、checkout、reset、stash、apply）：代码问题只写改法交给用户。
- 替用户登录、填验证码、注册账号、做求职决定（投谁、发谁、pass 谁）。
- 发任何邮件 / 私信 / 群消息（通知铁律不变）。
