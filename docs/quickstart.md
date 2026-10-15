# 快速上手（v0.1）

这份说明写给第一次装 OfferCrew 的人：从一台只装了 Node 的 Mac 开始，到收件箱里出现第一批岗位。
它按一次真实的「陌生人第一次装」演练写成：干净的 `git archive` 副本、空的 HOME，没有飞书、Gmail、ego 浏览器、
TypeSafe，也没有作者本机的任何配置。下面每一步都在那个环境里跑过。

## v0.1 能做到什么

不接飞书、Gmail、登录态浏览器，本机工作台也能走完这条主线：

**导入简历 → 补齐资料和求职方向 → 选几家公司 → 扫公开招聘接口 → 模型逐条判断 → 在收件箱里决定（投递 / pass / 晚点再看）**

替你预填申请表、发邮件、发平台私信、读真人招聘帖、在飞书里处理，要更多东西，见下面的「可选」表。

## 需要准备什么

**必需**

| 项 | 说明 |
| --- | --- |
| macOS | 演练环境是 macOS 15。定时任务用 launchd；读 PDF 用系统自带的 PDFKit（不必装 poppler），读 Word 用 textutil。 |
| Node.js ≥ 22 和 npm | 演练用 22.21.0。 |
| 网络 | 能访问 npm registry（装依赖）和公开招聘接口（Greenhouse、Lever、Ashby……）。 |
| 一个文字模型 | 导入简历时整理资料草稿、给每个岗位下判断都靠它。没有模型也能手填资料、扫岗位，但岗位不会被判断，收件箱一直是空的。三选一，见下。 |

**文字模型，三选一**

1. **Claude Code**：`claude` 命令已登录（Claude 订阅）。默认的文字模型清单第一个就是它，不用再配。文字调用只当纯文字模型用：
   不给工具、不连 MCP、不读 `~/.claude/settings.json`（也就不读那里的网关变量和钩子），还会去掉 shell 里的 `ANTHROPIC_*`；
   靠网关或 `ANTHROPIC_API_KEY` 才能用 claude 的，直接走第 3 种。
   登录只在 Anthropic 自己的流程里完成（在终端运行 `claude auth login`）；这套系统只看 `claude auth status` 说登没登录，
   不收、不存、不转交 Claude 账号的任何令牌。
2. **Codex CLI**：`codex` 命令已 `codex login`。默认清单的第二个。
3. **任何 OpenAI 兼容或 Anthropic 兼容的 API key**（没有 key？见 [怎么拿到一个 API key](api-key.md)，以 DeepSeek 为例，判断 100 个岗位约 2–4 元）：工作台「设置 → 模型与参数 → 添加供应商」填 base_url 和 key，
   再把「文字生成」选成它。key 存在 `private/providers/`（不进 Git）。

模板里的模型写的是通用的：Claude 写别名 `sonnet`（Claude Code 会换成你账号里有的型号），Codex 写 `default`（用 codex
自己的默认模型）。要用具体型号，在「设置 → 模型与参数」里换。
「设置 → 检查清单」的「模型」一项会告诉你这台电脑上有没有一个能用的文字模型。

**可选（没有也能跑主线）**

| 集成 | 用来做什么 | 没有它会怎样 |
| --- | --- | --- |
| TypeSafe Jev（`private/typesafe.auth.json`） | 判断层：`bin/judge-leads.mjs`、来信分类、收录转发的链接、找联系人 / 内推人 | 由上面的文字模型逐条匹配（`bin/match.mjs`）；这几项功能不可用 |
| ego 浏览器（`ego-browser` 命令，登录好的浏览器） | **预填申请表**（不用登录的官网表单也可以改用内置浏览器，见 [operator.md](operator.md)）、需要登录的门户、LinkedIn / 脉脉 / BOSS / 小红书真人帖、平台私信、收件箱里「打开登录页 / 打开申请页」 | 系统不能替你投递，只能扫公开招聘接口；这些选项会失败 |
| Codex CLI 作执行器 | 收件箱和对话页里交给执行器的事（打开网页核实、准备材料）、周期里的宿主步骤、每小时的邮件巡检（Gmail 连接器）、看图 | 这些事做不了；主线不受影响 |
| 飞书（lark-cli + 你自己的应用） | 指挥室群、成员卡片、多维表格 | 只在本机工作台和手机端里看。v0.1 建议先不接；手机上用 OfferCrew 的手机端（「设置 → 通知与手机」扫码配对） |
| Gmail | 首联邮件草稿、发信、对账 | 不发邮件 |
| launchd 定时任务 | 每天 09:05 / 13:05 / 18:05 自动跑一轮、每小时查邮箱、20:35 战报 | 自己在工作台或命令行手动跑 |

## 安装

下载 Mac 安装包：https://offercrew.onemaple.cc（Apple 芯片，macOS 13 及以上）。拖进「应用程序」打开，第一次打开会先走引导。

**工作台起来的不只是网页。** 默认还会在后台处理反馈队列、拉起即时执行器、监视登录、发你批准过的私信。
你在收件箱或对话页交给执行器的事，会由 Codex / Claude 在这台电脑上直接执行：不带沙箱、会读写安装目录里的数据（代码不许它改：跑完有代码守卫核对，改了的会被还原），
发送和提交之前会停下来等你确认。只想看页面、什么都不让它自动做，用 `node bin/serve.mjs --no-workers`；
想连你点的按钮也什么都不发出去，用 `--sandbox`（演示 / 沙盒模式：对外的每一步都跳过，见下面的已知限制）。

## 引导和「设置 → 检查清单」：从上往下做

左侧导航没有「开始使用」了：第一次打开工作台自动进引导（可以「跳过，先看看」，指挥台上会留一张小卡片请你回来），走完或跳过以后不再自己弹出。选过的东西都在「设置 → 求职方向与偏好」里直接改，存的是结构化字段，不调模型；检查清单、花费、手机也都在「设置」里。

1. **你的方向**：新装的机器（还没有 `candidate/facts.yaml`）打开工作台先走一遍引导：一屏一个问题——你是在校生、应届生还是职场人，
   想做什么（工程师可以再选后端、前端、AI 应用与大模型……；还有产品经理、数据分析、UI/UX 设计、运营），期望的城市、薪资、工作方式，
   简历、模型、真人渠道和公司包；每一屏都能跳过。已经有资料的人看下面这张清单，顶上有「重新走一遍引导」。
2. **简历**：「导入简历」，上传 PDF / Word（.docx）/ TXT / Markdown，10 MB 以内。文字在本机读出，交给文字模型整理成草稿；
   你核对、勾选、点保存之后才写进 `candidate/facts.yaml`。顺手选上「设为英文 / 中文简历」和「匹配用的文字版」。
   没有能用的模型时（或在演示 / 沙盒模式里），会按简历的版式用规则整理一份草稿，写明「没调用模型」，照样逐项核对；也可以点「直接手填」。
3. **个人资料**：点「编辑」补齐清单列出来的缺项（比如工作许可）。
4. **求职方向与排除**：目标城市、方向、硬排除（碰到就不推的）。
5. **岗位来源**：没有自己的清单时，读 `config/companies.example.yaml` 里的 14 家示例公司（演练里扫一遍约 20 秒、收进约 500 条，
   不需要浏览器）。换成你自己的：新建
   `config/companies.yaml`（或先 `cp config/companies.example.yaml config/companies.yaml` 再删改），每家一段：

   ```yaml
   - name: Example Co            # 公司名
     ats_type: greenhouse        # 适配器：greenhouse / lever / ashby / workday / smartrecruiters / larkhire / moka / beisen ……
     board: exampleco            # 该 ATS 上的公司标识，例如 boards.greenhouse.io/<board>
     careers_url: https://job-boards.greenhouse.io/exampleco
   ```

   新加的公司下一次扫描就会读；扫过一次之后跑 `node bin/verify-sources.mjs` 核验招聘页，以后每轮都会扫它。
   扫描会回写这个文件的健康字段，文件里的注释会被去掉。
6. **花费档位与每天上限**：用 API key 的话先选一档（省钱 / 标准 / 高级），再决定要不要给每天设个上限（钱或 token，空 = 不限）。
   到了上限，新的判断和调研留到明天，已经批准的事照常做完。token 是什么、钱怎么估，见 [docs/cost.md](cost.md)。
   也可以直接在「设置 → 花费」里改；走完引导时，按你选的方向先记一个默认档（你自己选过的不动）。
7. **平台账号、通知与手机、电脑操作方式、定时运行**：按上面的「可选」表决定。主线只要「模型」一项是「好了」。

## 跑第一轮

```bash
node bin/discover.mjs              # 扫公开招聘接口，新岗位入库（不调模型）
node bin/verify-sources.mjs        # 只在加了新公司之后需要
node bin/match.mjs --limit 10      # 用文字模型判断 10 条，每条一次模型调用
```

工作台里一样能做：指挥台 → Radar →「手动跑一次」→「扫描官方源」「匹配」。有 TypeSafe 的话再跑 `node bin/judge-leads.mjs`
（「Jev 全量判断」）。

然后打开「收件箱」：推荐和待核的岗位一条一问——投递 / pass / 晚点再看，或者写一句你的想法。

- **pass** 和 **晚点再看** 只改本机状态。pass 时选的固定原因（方向不对、城市不对……）记成结构化反馈，用来学你的偏好；
  用你自己的话写的原因会记进 `candidate/profile.md`，以后匹配时参考。
- **投递** 是自动预填，你来提交：浏览器按你的资料填好认得出的项、截图、读回，列出还要你补的，停在提交前；你在页面上检查、补齐、自己点提交，再点「我已在页面上提交了」。没有能用的浏览器就停在这一步。

## v0.1 已知限制

- **入库前的硬筛按你的资料来，但方向靠关键词。** 年限取 `candidate/facts.yaml` 的 `experience_summary.years`，没写就按
  工作经历的起止日期推算（都没有按 2.5 年）；不到 5 年，标题带 Senior / Staff / Lead / 资深 / 高级 / 专家 这类的岗位入库前就排除，
  5–8 年只排除管理岗，8 年以上只排除总监 / VP；JD 硬性要求超过「你的年限 + 5.5 年」的排除。方向看 `preferences.role_families`：
  写到前端、移动端、测试、产品经理、算法 / 研究、硬件 / 嵌入式、销售 / 运营、量化、实习这些词，对应方向才不会被筛掉；其它写法按软件研发来筛。
- 演示 / 沙盒模式（`RADAR_SANDBOX=1` 或 `--sandbox`；`bin/demo-seed.mjs` 种过的目录自带）什么都不发出去、也不调模型：它把对外的那一步跳过并记一行，不是演练。不开这个模式时，手动跑的脚本都会真的写状态、真的调模型；`--no-workers` 只是不跑后台任务。
- 收件箱里「打开…」类的选项只认 ego 浏览器，不会退回系统默认浏览器。
- BOSS、脉脉、LinkedIn 真人帖和每天的真人帖扫描在模板里默认关着（都要 ego 浏览器和执行器）。装好、登录好之后，在
  `config/human-source-policy.json` 里把对应来源的 `enabled` 改成 `true`，在 `config/pipeline.json` 里把 `human_discovery_daily` 改成 `true`
  （没有这两个文件就先从同名的 `.example.json` 复制）。

---

## English

**What v0.1 does without Feishu, Gmail or a logged-in browser:** import a résumé → complete your profile and targets →
pick companies → scan public ATS APIs → have a model judge each posting → decide in the inbox (apply / pass / later).
Everything below was run in a clean `git archive` copy with an empty HOME and none of the author's configuration.

**Required:** macOS (tested on 15; launchd, PDFKit, textutil), Node.js ≥ 22 with npm, network access to npm and to public
ATS APIs, and one text model: a logged-in `claude` CLI (used as is, first in the default chain), a logged-in `codex`
CLI (second), or any OpenAI- or Anthropic-compatible API key added under 设置 → 模型与参数 → 添加供应商 and selected for
文字生成. The templates use the Claude alias `sonnet` and Codex's `default` model; pick exact models in 设置 → 模型与参数. The 设置 → 检查清单 section's
模型 step tells you whether one is usable on this machine.

**Optional:** TypeSafe Jev (judgment layer; without it `bin/match.mjs` uses your text model), the `ego-browser` CLI
(prefills application forms, which you then check and submit yourself; account-free ATS forms can use the built-in browser
instead; needed for LinkedIn / 脉脉 / BOSS / 小红书 and logged-in portals), Codex as the executor (hands-on tasks, cycle host step, Gmail mail poll, vision), Feishu, Gmail, launchd schedules.

**Install:** download the Mac installer at https://offercrew.onemaple.cc (Apple silicon, macOS 13 or later), drag it into Applications and open it; the first launch opens the guide.

**Setting up:** work down 设置 → 检查清单. Do not copy `candidate/facts.example.yaml` verbatim; let the guide or the checklist create `candidate/facts.yaml`. The workbench
also runs background workers, and work you hand to the executor runs as Codex/Claude on your machine without a sandbox
(forms are only prefilled for you to submit, and sends still stop for your confirmation). `RADAR_SANDBOX=1` (or `--sandbox`) sends nothing and calls no model:
it skips each outside step and logs one `sandbox: skipped` line — it does not rehearse them.

**Your direction:** the first guide step (also 设置 → 求职方向与偏好), picks your field: software & AI engineering (what you get when none is
written, the old rules), finance (with tracks such as investment banking or asset management), consulting, marketing,
product, operations or data analytics, plus any others to look at too. Recommendations and the checklist's hints follow it.
Each direction has a fictional example profile to compare against (`candidate/templates/`, see `candidate/README.md`).
Without a usable text model (or in sandbox mode) a résumé import falls back to a draft organised by the résumé's layout;
the draft says no model was used, and you check it item by item as usual.

**First round:** `node bin/discover.mjs`, then `node bin/verify-sources.mjs` if you added companies, then
`node bin/match.mjs --limit 10`; open the inbox.

**Known limits:** the pre-match screening follows your facts (years from `experience_summary.years` or your dated
work entries; role families unlocked by keywords in `preferences.role_families`); inbox "open page" options and every
submission need ego-browser; the BOSS / 脉脉 / LinkedIn human sources and the daily human-post scan are off in the
templates until you install ego; Claude text calls don't read `~/.claude/settings.json`, so a gateway-only `claude`
setup should be added as an API provider instead.
