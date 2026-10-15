# 运行手册

> 这份手册写于飞书指挥室时期。成员名和界面以 [README](../README.md) 为准：团队是六位成员 Radar（找岗位）、Judge（看岗位）、Writer（做材料）、Reacher（递出去）、Watcher（盯回复和面试）、System（管后勤），文中的 Watch 就是现在的 Watcher（公司调研已归 Judge）；执行器不是成员，是大家共用的手。官网表单只自动预填、停在提交前，由你在页面上提交（`auto_submit` 默认关）。

后台批量发现、核验岗位并准备投递材料；飞书集中接收机会、审核材料和招聘进展。每家面试公司的准备资料固定在飞书文档，用户可以并行推进，自主安排准备。这份手册是日常怎么用、系统每天做什么；运行契约见 [飞书求职助手说明](concierge.md)，工作台见 [工作台说明](workbench.md)。

文中的时间、城市、名额都是默认值或例子：时间按 `config/host.json` 的时区，城市按 `candidate/facts.yaml` 的 `location.target_cities`，数字按 `config/pipeline.json`。

## 日常操作

- 09:00、13:00、18:00 均扩展官方招聘源、发现真人招聘帖、匹配、处理回复与材料，每轮最多匹配 40 条、单公司最多 6 条（`match_limit`、`match_per_company`）。
- 每轮有时间预算（`config/pipeline.json` 的 `cycle_budget`，完整轮 45 分钟、轻量轮 20 分钟，按墙钟算，见 `lib/cycle-budget.mjs`）：发现、Jev 判断（每轮最多 `judge_limit` 条，按优先级）、匹配、找联系人 / 内推人等阶段只能用到「截止 − 尾段预留」，到点先收尾、再不行就终止，剩下的阶段跳过，没做完的线索和公司留到下一轮；看板、宿主任务、进度、岗位清单、飞书同步、指标每段预留 90 秒，必跑。`bin/scheduled.mjs` 的守卫是预算加 10 分钟，只算 Mac 醒着的时间。
- 一个调度覆盖三个时点，按本地时区选择 full / light。
- Mac 需开机运行；本地状态与授权文件不进入 Git。
- 手动：`node bin/cycle.mjs --mode full` 或 `--mode light`。
- 无新事件的轻量轮不调用匹配模型、不发消息。
- 发信邮箱是 `candidate/facts.yaml` 的 `identity.mailbox`（没写就是 `identity.email`）；Gmail 连接的身份必须与之相符（`lib/gmail.mjs` `assertMailbox`）。

## 求职指挥室

接上飞书（可选）以后，主动推送进飞书「求职指挥室」群，按成员分工发卡：**Radar**（发现与匹配）、**Watcher**（收件箱与面试）、**Reacher**（预填与联络）、**System**（只进系统日志群）。卡片标题栏是成员名，正文第一行是成员签名。不接飞书时，这些都在工作台和手机端里。私聊只回应你主动的查询。完整约定见 [飞书求职助手说明](concierge.md)。

群里的用户入口：

| 目的 | 输入 |
| --- | --- |
| 刷卡筛选（一次一张） | 筛选 / 筛选 <城市> / 筛选 真人；「停」结束 |
| 看完整岗位简报 | 详情 32 / 32 是啥 |
| 确认拟投清单 | 投 全部 / 投 118 121 / 投 全部 去掉 44 |
| 确认发信 / 多封 | 发 32 / 发 32、46 |
| 改一封信 / 不发 | 改 32 把第二段删掉 / 32 不发 |
| 排除 / 选中 | pass 44 公司不明 / 27 联系 |
| 预约或改期 | 12 面试 2026-10-16 14:00 |
| 单个进度 / 全部事项 | 27 进展 / 我的待办 |
| 看完整准备资料 | 27 查看准备 |
| 暂缓 / 暂停提醒 | 27 晚点提醒 / 27 暂停提醒 |
| 记录结束 / 复盘 | 27 面试完成 / 27 复盘 问了…… |
| 其它任何话 | 直接说，进处理队列 |

在某张卡片下回复可省掉编号：「发」「不发」「改成……」「pass 原因」「忽略」或一段备注，都归到那张卡对应的岗位。每条消息先回一行回执，再回角色签名的结果；需要模型或浏览器的指令由常驻服务去抖 60 秒后拉起一次 `bin/host/run-now.sh`，结果回到同一条消息的话题里。

Base 用户反馈/备注列和 `node bin/action.mjs --input '3 联系 4 pass 公司不明'` 仍然可用。未知编号和模糊句子进入待确认列表，不猜测。公司增删直接编辑本机的 `config/companies.yaml`（没有时照 `config/companies.example.yaml` 建一份），或在对话说明。

待核岗位也进入 Base 的「待筛选」，每轮最多投影 15 条，并写入 渠道类型 / 城市 / 动作 三个可筛选字段。09:00 / 13:00 / 18:00 每个时段 Radar 最多两张卡（岗位清单 + 真人线索），指向每天整体覆盖的同一份飞书文档；清单里的已投递按实际回执拆成「已投递」和「排队待投」。09:00 与 18:00 有内容变化时发送简报，21:00–09:00 只放行 Watcher 的面试类和验证码类。验证码和安全提醒只进私聊，「已收到申请」类自动确认只在系统日志群报个数，指挥室里的 Watcher 卡只有招聘方实质回复、面试邀请/改期和拒信。

## 三条投递通道

**刷卡筛选**：发「筛选」进入一次一张的模式，卡片正文就是岗位简报（来源、地点薪资、**JD 职责与要求各 3–5 条**、匹配点、最大缺口、投递方式、原帖），四个按钮：投递 / 邮件联系 / 跳过 / 稍后，点完立刻推下一张。简报的「匹配点」按 `candidate/facts.yaml` 的 `positioning.project_priority` 的顺序取素材，求职信同理。

**先审后投**：不刷卡时，Reacher 会在指挥室贴一张「拟投清单」（目标城市优先，标题含 Senior / 资深 / 高级 / Lead / 架构师 等的一律不进清单），你回「投 全部」「投 118 121」或「投 全部 去掉 44」之后才开始预填；你在页面上提交过的进一张原地更新的「已投递清单」卡。规则在 `config/concierge.json` 的 `auto_apply_policy`。

无需账号的官方表单（Ashby、Greenhouse、Lever、Workable）和专用 Chrome（还在用 ego 的，就是 ego 浏览器）里已登录的门户（见 `config/portal-sessions.json`）经你确认后由 `node bin/auto-apply.mjs` 自动预填、截图、读回，停在提交前，由你在页面上检查、补齐、提交（`auto_submit` 打开时，才在你终审确认那一版之后由系统提交）；证据存 `runs/<日期>/auto-apply/<编号>/`。Workday 及未登录门户仍由本人登录（Workday 每个租户要本人注册）。真人招聘帖和邮箱线索才生成申请信，走草稿确认流程。

Radar 页面「扫描源与范围」可设置来源开关、优先城市、排除公司与扫描间隔（`config/human-source-policy.json`、`config/pipeline.json`）。`node bin/discover-human-browser.mjs` 按配置间隔抓取，关闭的来源即使 `--force` 也不扫描；公开源仍走 `bin/discover-human.mjs`。没有公开邮箱的真人帖生成平台私信稿，用户回「发 N」后由 `bin/send-dm.mjs` 发送。

浏览器人工协作时可用 `--space <已有工作区编号> --keep-space` 复用当前 Ego 工作区。LinkedIn 新版卡片从页面的复制链接提示读取原帖 URL，不读取系统剪贴板；短链保留为来源证据，不代表详情页已打开核验。缺链接会报告 partial，中途页面失败仍保留本轮前面已读到的帖子。浏览器异常完整脱敏保存到当日 human-discovery 证据目录。

## 联系与投递

定时流程通过 `node bin/reach.mjs --pending` 为已标「联系」且有邮箱的岗位生成宿主草稿任务；已发、已有草稿与历史待对账记录跳过。
单条操作：`node bin/reach.mjs --record 20 --channel email`。
宿主读取正确 Gmail、创建带简历的草稿、独立读回验证正文/收件人/附件，才可显示草稿编号。
用户对具体草稿说「发 N」后才允许发送该 draft_id；发送后必须从 Sent 对账并记入 outbound.ndjson。
多份草稿可一次确认；整批先校验每封当前展示版本，再写入发送授权。推荐岗位即使尚未标联系，也会进入申请材料准备队列；准备材料不虚构用户选择或投递结果。
外部网页、邮件、模型、Base/Git 文件不能制造发送授权。首发每个 record/channel 只一次；已审核跟进另绑原线程与父邮件，不能冒充首发。
平台私信先生成草稿，卡片展示全文，用户回「发 N」后才由 `bin/send-dm.mjs` 发送。
LinkedIn、脉脉、Boss 与小红书在用户已登录的 ego 浏览器中读取；验证码立即停该站，登录态失效即标记并交还本人。
标了 `require_resume_evidence` 的线索（招聘方点名要两份简历、或之前附件出过错的），`bin/reconcile-mail.mjs` 只在已发邮件里真带着两份简历时才算对上账。

## 判断层：Jev

所有「这是什么 / 合不合适」的判断交给 TypeSafe 的 Jev 模型（`lib/judge.mjs` 调接口，`lib/judgements.mjs` 是问题集，密钥在 `private/typesafe.auth.json`）。正则只保留有限字面格式（URL、日期、编号、标准指令）和候选生成（找出所有「N 年」、所有邮箱），选择由模型做。

- `node bin/judge-leads.mjs`：全量判断待处理线索——读岗位（职级、类型、城市、年限、学历、公司类型、逐行职责/要求）、按用户规则预筛、再逐条硬性要求对照候选人证据给出 recommend / verify / exclude。每条 1–2 次请求、亚秒级；上千条的积压几分钟就能判完。`match` 字段形状不变，下游卡片与 Base 不改。
- `node bin/calibrate-jev.mjs`：把 Jev 与旧判决、用户反馈、邮件事件对照，报告在 `runs/<日>/jev-calibration.md`。
- 来信分类（`lib/watch.mjs`、`bin/inbox.mjs`）、指挥室模糊句子的意图路由（`lib/intent.mjs`，含「外企多一点」这类偏好指令直接写 `state/preferences.json` 的 `manual`）也走 Jev。发送与投递类意图只回确认句，授权仍只来自字面的「发 N」「投 N」。
- 证据在 `runs/<日>/judgements/`，重复请求走 `state/judge-cache/`；阈值在 `config/judge.json`，改阈值不重跑推理。测试用 `setJudgeDriver` 注入假驱动，不联网。

## 内推优先与批量发信

- 通道顺序：内推人 > 真人帖 > 公司招聘邮箱 > 无需账号的表单 > 需注册门户。`config/concierge.json` 的 `require_referrer_search: true` 让表单只在该公司找不到内推人时提交。
- `node bin/find-referrers.mjs`：按公司找能内推的人——库里已有的真人帖、以及 脉脉 / 小红书 / LinkedIn 搜「公司 内推」；Jev 判断是否提供内推、是否在职、是否校友/前同事、哪一行是联系方式。人记在 `state/referrers.ndjson`，每公司最多 2 人、30 天不重复；每人生成一封内推请求草稿（`purpose: referral`），走同一张草稿卡与「发 N」。
- `node bin/find-contacts.mjs`：官方线索没有邮箱时读 JD 与公司页面，Jev 从候选邮箱里选投递用的那个，记 `state/company-contacts.json`。
- 「拟投」一张一张来：可自动投的岗位不再汇成清单，而是自动开一轮「拟投」刷卡（`auto_apply_policy.deal_one_by_one`），每张卡带 投递 / 邮件联系 / 跳过 / 稍后，点完推下一张；回「拟投清单」仍可看整批。
- 「拟发清单」：所有已展示、待确认的草稿汇成一张 Reacher 卡，回「发 全部」或「发 全部 去掉 32」整批发出并对账；单封仍可「发 32、46」。
- 内推人联系顺序：猎头 → 公司 HR → 招聘经理/recruiter → 员工（校友、前同事优先）。

## 重点岗位与城市

- 群里回「重点」得到一张 Radar 卡：按匹配度、公司类型、城市、来源排出的最多 8 个岗位（每家公司最多 2 条），每条写明卡在哪一步、谁来做（`lib/top-picks.mjs`）。集合或阻碍变化时 concierge 原地更新，`config/concierge.json` 的 `top_picks_card` 控制推送。
- `candidate/facts.yaml` 的 `location.relocation_cities` 是愿意搬去的城市（`lib/city.mjs`）：清单里仍归「其他」，但不作为阻止投递的理由。
- 城市冲刺模式：`config/pipeline.json` 的 `city_sprint`（`enabled` / `only` / `reason`），判定统一在 `lib/city-sprint.mjs`。开启后城市已知且不在范围内的岗位照常发现和判断，只是放进 Backlog（`sprintHold` 读时计算，不写入线索）：不自动投递、不进拟投清单；已联系、已回复、面试中的线程照常。城市未知（未标注、待核、只写了国家）的岗位不挡；你已回「投」的岗位也不挡。工作台「发现与匹配」里可关。维护时可用 `RADAR_CITY_SPRINT=off` 看完整池；测试运行器默认忽略该开关。
- 城市名额：`config/pipeline.json` 的 `city_quota`（`{"城市": 比例}`），每轮匹配先给这些城市留座（`lib/city-quota.mjs`）。

## 通用发现与投递路径（不再逐站写适配器）

- **发链接即可。** 在飞书私聊或指挥室发一个岗位链接，60 秒内执行器拉起：`bin/add-lead.mjs` 抓原帖（需要登录的站点自动用 ego 浏览器）、入库、Jev 判断、编号，结果回到你那条消息下；如果是搜索页或列表页，执行器用浏览器列出岗位，逐条入库，并把该搜索页记进 `config/watch-sites.json`，以后每轮周期重扫。
- **投递靠浏览器代理，不靠接口。** 门户投递由执行器在 ego 浏览器里按 `lib/application-form.mjs` 的事实逐项填写，必填项没有确定答案就停下问你；提交只在你批准并终审后进行，回执写 `state/outbound.ndjson`。
- **代码适配器只留给稳定的公开 ATS 接口**（Greenhouse / Lever / Ashby / Workable、飞书招聘、北森、Moka、阿里系招聘站等）和已经写好的几家（字节、网易、腾讯、微软）。微软适配器在登录态浏览器里调门户自己的接口，与页面行为一致；直接从命令行调接口会被拒（403），所以不这么做。

## 内置操作员与电脑操作驱动

- **内置操作员**（`lib/operator/`）：不依赖 ego lite 或 Codex，只要一个浏览器和任何能走 HTTP 的模型（OpenAI 兼容或 Anthropic 接口，本机 Ollama 也行）就能操作网页。每一步把页面控件编号给模型，模型回一个 JSON 动作，代码核对后执行；最终提交永远不点，停在终审交给你（填了什么 + 截图）；登录墙、验证码、离站交给你。成功走完的表记成配方，下次直接回放、不问模型。
- **驱动按网站选**：`config/computer-use.json` 决定哪个网站交给 Codex 电脑操作、内置操作员还是 Cua（目前只检测）。默认保持原样：全部走 Codex；允许哪些网站仍由 `config/pipeline.json` 的 `computer_use` 决定。
- 手动试：`node bin/operator.mjs --url <网址> --goal "<要做的事>" [--data data.json] [--model 供应商/模型]`。设计、配置和验证范围见 [内置操作员](operator.md)。

## 供应商目录、多账号与迁移

- 供应商 × 模型目录（`lib/backends.mjs`）：`claude_gateway`（Anthropic 兼容网关）、`claude_subscription`（Claude 官方订阅，`claude -p`）、`openai`（ChatGPT 官方订阅，`codex exec`）、`~/.codex/config.toml` 里的每个 Codex 供应商（例如叫 `custom` 的 OpenAI 兼容中转）会自动出现；你在工作台加的供应商、改过的名字和模型清单记在本机的 `config/providers.json`。模型引用统一写 `供应商/模型`。工作台「模型与参数」可探测 / 增删模型、按用途选底座、加账号（`openai@xx` / `claude_subscription@xx`，登录目录 `private/accounts/`）。
- 迁移：`node bin/migrate.mjs --export/--import`，`zsh bin/host/install-launchd.sh`；见 [工作台说明](workbench.md)。
- 「添加供应商」可接任意 Anthropic 兼容 / OpenAI 兼容（chat 或 responses）的 API 和 Codex 中转，密钥存 `private/providers/`，加完全清单可选。
- 角色底座 `config/roles.json`：Radar / Watch（Watcher）/ Reacher / System 这几个老编号各自的对话默认与文字生成清单，空 = 跟随全局；匹配、来信摘要、重写按角色选模型。

## 底座与记忆库

- Codex 链里的供应商 id 必须是 `~/.codex/config.toml` 里定义的或内置的 `openai`；写错的 id 会让每轮 codex 报 provider not found 并静默落到官方订阅，所以工作台会对不存在的 id 告警。
- `config/chat.json` 的 `backends` 列出对话 / 连通测试可用的底座（Claude 经订阅或网关、GPT 经 codex）；`config/model.json` 的 `text` / `vision` 用 `codex_exec` 时可指定 `provider` / `model` / `effort`。一键预设见工作台「模型与参数」。
- `state/memory/notes.ndjson` 是 Claude 执行器、Codex、对话页和用户共享的记忆库：`node bin/memory.mjs --recall "<任务>" --format md` 开工读，`--add --by codex --kind lesson --text "…"` 收工写；协议在三份提示词与 [飞书求职助手说明](concierge.md) 第 9 条。

## 主控执行器

指挥室的即时执行器 `bin/host/run-now.sh`、周期里的宿主步骤 `bin/host/radar-cycle.sh`、邮件巡检 `bin/host/mail-poll.sh` 都按 `config/host.json` 选模型：

- `executor: claude`，`claude_provider: claude_subscription`，`models: [claude-opus-5-5]`：即时执行器先用 Claude；它失败、或收尾 JSON 报 `blocked > 0`（比如要 Gmail 的活），Codex 再补一轮。周期宿主步骤同样先交给 Claude；之后只有还剩 Gmail 的活（已派发待发送 / 待对账的邮件，或结果写着「需要 Codex 执行器」的待办）才让 Codex 链只做这部分，Claude 失败则 Codex 链跑完整一轮。`executor: codex` 则全程用 Codex。
- 官方订阅的登录：OfferCrew 不收、不存、不转交 Claude 账号的令牌，登录只在 Anthropic 自己的流程里完成。如果 `~/.claude/settings.json` 的 env 把 `ANTHROPIC_*` 指向别的网关，就给 `claude_subscription` 配一个独立登录目录（供应商目录里的 `config_dir`，例如 `private/claude-subscription`），自己在终端跑一次 `CLAUDE_CONFIG_DIR=<安装目录>/private/claude-subscription claude auth login`，再用同样前缀的 `claude auth status` 确认。执行器和文字调用只把 `CLAUDE_CONFIG_DIR` 指向那个目录。没登录时 `claude -p` 报「Please run /login」，算供应商故障，由 Codex 接手，不会卡住；「设置 → 模型与参数」里这张卡的「测」会给出上面那条登录命令。
- Codex 路由：`codex_models.chain` 依次尝试，`fallback` 兜底一次，周期任务用 `cycle_effort`。只有供应商类故障（额度、429/401/403/5xx、断流、8 分钟无进展、缺程序）才换下一条；其他失败直接结束，避免同一件事被两个模型各做一遍。
- 每条指令最多尝试 3 次，之后停止重试并在飞书原消息下说明；运行时长按「醒着的时间」计，Mac 睡眠不算。
- 文字生成（`config/model.json` text）与对话（`config/chat.json`）默认 Claude 官方订阅，失败或超时换 OpenAI 官方订阅、再中转；图片理解（vision）走 Codex（`claude -p` 驱动不收图片）。一键预设「Claude 官方订阅」就是这套配置。
- 邮件巡检只有 Codex 有 Gmail 连接器，巡检链会跳过 Claude。

## 验证与报告

- `npm test`：ATS 真实录制夹具、匹配反例、反馈歧义、首发幂等、附件、跟进日期、角色卡片、群指令、刷卡筛选、执行器卡住通知、Jev 判断层（假驱动）、发布检查。
- `node bin/discover.mjs --dry-run`：来源数量；网络验证独立运行，不混入日常测试。
- `node bin/metrics.mjs --weekly`：漏斗及周报；真实业务完成与夹具测试分别报告。
- 报告与证据写在本机的 `runs/`，不进仓库。

## 目录与本机文件

`candidate/` 是个人事实与简历（本机，仓库里只有模板 `facts.example.yaml`）；`config/` 是提示词、策略、Base 映射和个人设置的模板；`lib/`、`bin/` 是确定性脚本和模型入口。本机的个人配置不写在代码里：`candidate/facts.yaml`（姓名、系统邮箱 `identity.mailbox`、简历、目标与可搬迁城市、对外短消息的说法 `outreach`）、`config/host.json`（运行机、时区 `timezone`、launchd 前缀 `launchd_prefix`、模型）以及各个 `config/<名>.json` 都有中性模板；执行器提示词里的路径、邮箱、城市、讲义链接写成 `{{ROOT}}` 等占位符，运行时填上（`lib/prompt.mjs`）。

`state/` 保存线索、反馈、外发回执和摘要；`runs/` 保存证据；`archive/` 完整保留旧目录及备份；`notes/` 放个人笔记。这几样都不进仓库。`skills/` 是执行器技能（见 [技能](skills.md)）。

### 代码和数据分开放（桌面版用）

`node bin/data-root.mjs <数据目录>` 会在数据目录里把引擎挂上：`bin`、`lib`、`web`、`skills`、`docs`、`node_modules`，以及随代码走的规则、提示词和模板，都是指回代码目录的链接；其余的个人配置、简历、`state/`、`runs/`、`private/` 是数据目录自己的文件。之后照常用 `RADAR_ROOT=<数据目录>` 运行，并把工作目录也设成数据目录。

- 数据目录里已有的同名真文件会保留。
- 经 `lib/store.mjs` 写一个被链接的文件时，会在数据目录里换成真文件，代码里那份不变。
- 数据目录不能是代码目录本身，也不能是另一份代码检出（里面有真的 `bin/` 目录）。
- `bin/demo-seed.mjs` 给独立目录种演示数据时也走这一步。

## 已知运行边界

无标签不虚构用户反馈；未连接正确 Gmail 不创建真实草稿或对账。
没有日历连接时生成准备包和明确的 Calendar 任务，不声称日历事件已建立。

面试资料契约见 [固定公司准备文档](interview-dossiers.md)。旧三步带练已停用；只有实际面试时间使用原生任务提醒。新回复、改期、轮次与复盘会触发更新同一份文档。

原始 JD 较长时在 NDJSON 中以 jd_gzip 压缩保存；`lib/store.mjs` 读取时无损还原为 jd_text。
状态和运行证据仅保存在本机，不执行 Git push。
新增/修复公司来源：先运行 `discover --retry-unverified`，再运行 `verify-sources` 核验 careers 页面。日常扫描 verified 来源，外加 retry_at 已到期的 unverified 来源（每轮最多 8 个，间隔 1 小时起翻倍、最长 72 小时）。
来源自愈：verified 来源读取失败只记 last_error / consecutive_failures，连续 3 轮失败且跨度满 24 小时才降为 unverified；一轮中 ≥80% 来源是网络传输失败时按本机断网处理，不计失败；重新读到岗位即恢复 verified。
retry_at 只表示「此时间后再试」，不是停用；要人为停用某来源写 `paused: 原因`，discover（含 --retry-unverified）和 verify-sources 都不再读取。

## 可视化工作台

打开本地工作台（Mac App 里就是主窗口；命令行装的运行 `node bin/open-workbench.mjs`，之后这个浏览器直接打开 http://127.0.0.1:4321 就行）：默认进入**指挥台**，每个申请一行、八步对齐；左栏是指挥台、团队、任务、收件箱、材料、设置，「问团队」（⌘K）打开右侧的对话。对话里接受与飞书指挥室相同的指令（`投 118`、`发 32`、`pass 44 原因`、`筛选 <城市>`、一句话）；申请表只预填、由你在页面上提交，发信要你批准。
手动启动 `npm start`；常驻用 launchd（`zsh bin/host/install-launchd.sh`）。网页反馈进入原有队列；飞书按钮和文字由常驻服务处理，复杂来源交给定时执行器。
启动、停用、飞书长连接配置和边界见 [工作台说明](workbench.md)。
