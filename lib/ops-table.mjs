// 操作表（契约 05 第一节第 6 项「指挥台拆成操作表、分派、视图、自动修复」的第一块）：团队页、成员页、对话里能跑的脚本，每个是谁的、叫什么、跑什么、要什么。
// 只是一张表：只引 core（成员名、能力表），对话、团队页、System 读它不会把跑脚本那一套（lib/ops.mjs）带进来。
import { mailState } from './capabilities.mjs';
import { crewName, STEP_MEMBER } from './crew.mjs';
import { read } from './store.mjs';

const label = l => `${l.number ?? '待编号'} · ${l.company || '待核'} · ${l.role || ''}`;

// ── 操作台：手动触发 ───────────────────────────────────────────────────────────
// 每个操作都是仓库里已有的入口；这里只负责一次只跑一个、把输出落到 runs/<日>/ops/。
// 每个脚本归到它所属的角色：线索不够 → Radar 里扫描；收件箱 → Watch；材料 / 内推 / 投递 → Reacher；周期与同步 → System。
// 首轮判几个（op round-first → bin/cycle.mjs --match-limit → bin/match.mjs --limit）。
export const FIRST_ROUND_MATCH = 15;
export const OPS = {
  'discover': { role: 'scout', label: '扫描官方源', desc: '抓一遍 config/companies.yaml 里的官方招聘源，新岗位入库（不判断、不匹配）', args: [process.execPath, 'bin/discover.mjs'], timeout_ms: 20 * 60000, heavy: false },
  'discover-wide': { role: 'scout', label: '扫描官方源（全量）', desc: '同上，但连低频源一起抓；15–30 分钟', args: [process.execPath, 'bin/discover.mjs', '--wide'], timeout_ms: 40 * 60000, heavy: false },
  'discover-human': { role: 'scout', label: '抓真人帖', desc: 'V2EX / 阮一峰 / 电鸭 / HN 等真人招聘帖（被暂停的源见 config/human-source-policy.json）', args: [process.execPath, 'bin/discover-human.mjs'], timeout_ms: 15 * 60000, heavy: false },
  'match': { role: 'lens', label: '匹配', desc: '对已判断、未匹配的线索跑匹配模型（按 pipeline.match_limit）', args: [process.execPath, 'bin/match.mjs'], timeout_ms: 60 * 60000, heavy: true },
  'cycle-light': { role: 'patch', label: '轻量周期', desc: '拉反馈、起草首联、整理收件箱；不调匹配模型', args: [process.execPath, 'bin/cycle.mjs', '--mode', 'light'], timeout_ms: 30 * 60000, heavy: false },
  'cycle-full': { role: 'patch', label: '完整周期', desc: '官方源发现、真人帖、Jev 判断、匹配、内推与投递准备、同步；10–40 分钟，会调模型', args: [process.execPath, 'bin/cycle.mjs', '--mode', 'full'], timeout_ms: 60 * 60000, heavy: true },
  // 马上读一次信：引擎自己读（bin/mail-read.mjs → requestAction('read_mail')），不经 Codex、不经本机 AI。邮箱没接时 runOp 照能力表拦下、给「接上邮箱」。
  'mail-poll': { role: 'owl', label: '收件箱巡检', desc: '马上读一次邮箱：引擎自己读，不经本机 AI', args: [process.execPath, 'bin/mail-read.mjs'], timeout_ms: 20 * 60000, heavy: false },
  'judge-leads': { role: 'lens', label: 'Jev 全量判断', desc: '判断所有还没判断的线索（每条 1–2 次请求，亚秒级）', args: [process.execPath, 'bin/judge-leads.mjs'], timeout_ms: 30 * 60000, heavy: true },
  'linkedin-inbox': { role: 'owl', label: '检查 LinkedIn 消息', desc: '直接读取网页登录线程，保存对方完整来信；不发送消息，不依赖邮箱或模型', args: [process.execPath, 'bin/linkedin-inbox.mjs', '--now'], timeout_ms: 5 * 60000, heavy: false },
  'boss-inbox': { role: 'owl', label: '看 BOSS 消息', desc: '读 BOSS 直聘聊天列表：谁发来、最后一句、未读数；没读的对话不点开，招聘方主动找你的、你读过后才点开看岗位；设置里打开后才会跑', args: [process.execPath, 'bin/boss-inbox.mjs', '--now'], timeout_ms: 3 * 60000, heavy: false },
  'maimai-inbox': { role: 'owl', label: '看脉脉消息', desc: '脉脉消息同步暂不可用，请在脉脉聊天中手动查看；已有记录仍保留', args: [process.execPath, 'bin/maimai-inbox.mjs', '--now'], timeout_ms: 3 * 60000, heavy: false },
  'inbox': { role: 'owl', label: '收件箱增量（本机）', desc: '按已有邮件事件分类归档，不调 Codex', args: [process.execPath, 'bin/inbox.mjs'], timeout_ms: 10 * 60000, heavy: false },
  'find-contacts': { role: 'quill', label: '找联系人', desc: '为推荐岗位找 HR / 招聘经理的联系入口', args: [process.execPath, 'bin/find-contacts.mjs'], timeout_ms: 30 * 60000, heavy: true },
  'find-referrers': { role: 'quill', label: '找内推人', desc: '按猎头 → HR → 招聘经理 → 员工的顺序找内推人', args: [process.execPath, 'bin/find-referrers.mjs'], timeout_ms: 30 * 60000, heavy: true },
  'prepare-applications': { role: 'quill', label: '准备投递材料', desc: '为拟投岗位准备简历路由与求职信（不提交）', args: [process.execPath, 'bin/prepare-applications.mjs'], timeout_ms: 30 * 60000, heavy: true },
  // 「执行已批准的投递」不是一个操作：批准就是一条 prefill / submit 动作（lib/actions.mjs requestAction），worker 领走做（线 H 10-04）。
  'host-work': { role: 'patch', label: '整理宿主任务', desc: '把待处理事项写成 host-jobs，供本机 AI 领取', args: [process.execPath, 'bin/host-work.mjs'], timeout_ms: 5 * 60000, heavy: false },
  'metrics': { role: 'patch', label: '更新指标', desc: '重算漏斗与周报数据', args: [process.execPath, 'bin/metrics.mjs'], timeout_ms: 5 * 60000, heavy: false },
  'browser-tidy': { role: 'patch', label: '收拾浏览器', desc: '结束本机 AI 留下的任务空间、关掉它们的页面；保留「需要你处理」那个空间、预填好的申请页和你自己的页面', args: [process.execPath, 'bin/browser-tidy.mjs'], timeout_ms: 5 * 60000, heavy: false },
  'preferences-rebuild': { role: 'lens', label: '重算偏好', desc: '用全部历史重算 state/preferences.json；manual 手改值保留', args: [process.execPath, 'bin/preferences.mjs', '--rebuild'], timeout_ms: 5 * 60000, heavy: false },
  // 指挥台团队条 ⋯「立即跑一轮」：只跑这位成员在周期里的那几步（bin/cycle.mjs --only，lib/crew.mjs STAGE_MEMBERS）。不列在「单独跑一步」里。
  // 老的 round-radar / round-reacher / round-watch / round-system 还留在 state/ops.json 的历史里：页面按 op 查不到就只写它自己记下的名字。
  'round-scout': { role: 'scout', round: true, label: `${crewName('scout')} 跑一轮`, desc: `扫官方招聘源、真人帖（周期里 ${crewName('scout')} 的那几步）`, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'full', '--only', 'scout'], timeout_ms: 45 * 60000, heavy: false },
  // 新装走完引导时跑一次（web/onboarding.js FIRST_ROUND）：Radar 扫完，Judge 接着判断、匹配，指挥台上就有第一批岗位，不用等下一轮定时周期。
  // 首轮只判 FIRST_ROUND_MATCH 个（负责人 10-02：判一个推一个，几分钟内看到第一批），其余留在线索里，之后的周期接着判。
  'round-first': { role: 'scout', label: '找第一批岗位', desc: `${crewName('scout')} 扫官方招聘源和真人帖，${crewName('lens')} 接着判断、匹配（新装走完引导时跑一次）`, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'full', '--only', 'scout,lens', '--match-limit', String(FIRST_ROUND_MATCH), '--first-round'], timeout_ms: 60 * 60000, heavy: true },
  'round-lens': { role: 'lens', round: true, label: `${crewName('lens')} 跑一轮`, desc: `判断新岗位、匹配，排公司调研和「怎么准备」（周期里 ${crewName('lens')} 的那几步）`, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'full', '--only', 'lens'], timeout_ms: 60 * 60000, heavy: true },
  'round-tailor': { role: 'tailor', round: true, label: `${crewName('tailor')} 跑一轮`, desc: `给已批准、还没递出的岗位做定制版简历（打开了「按岗位定制」才有这一步）`, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'light', '--only', 'tailor'], timeout_ms: 20 * 60000, heavy: true },
  'round-quill': { role: 'quill', round: true, label: `${crewName('quill')} 跑一轮`, desc: `起草首联、找联系人和内推人、准备投递材料（周期里 ${crewName('quill')} 的那几步）`, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'full', '--only', 'quill'], timeout_ms: 60 * 60000, heavy: true },
  // 接了内置邮箱：这一轮先用引擎自己的读信读一遍（bin/cycle.mjs 的 mail-read 一步）；是你点的，--mail-now 不看巡检时段（0.1.4）。
  'round-owl': { role: 'owl', round: true, label: `${crewName('owl')} 跑一轮`, get desc() { return mailState().connected ? `读一遍邮箱、整理来信、准备面试资料（周期里 ${crewName('owl')} 的那几步）` : `整理已收到的邮件、准备面试资料（周期里 ${crewName('owl')} 的那几步；读 Gmail 用「收件箱巡检」）`; }, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'light', '--only', 'owl', '--mail-now'], timeout_ms: 20 * 60000, heavy: false },
  'round-patch': { role: 'patch', round: true, label: `${crewName('patch')} 跑一轮`, desc: `拉反馈、整理交办任务、重算进度、同步数据、更新指标（周期里 ${crewName('patch')} 的那几步）`, args: [process.execPath, 'bin/cycle.mjs', '--mode', 'full', '--only', 'patch'], timeout_ms: 30 * 60000, heavy: false },
};
export const OPS_PATH = 'state/ops.json';
// 「判断全部新岗位」（judge-leads）要 Jev；这台电脑上没有（App 里都没有：没有 Jev 的 key，也没开离线规则）就改跑匹配
// （bin/match.mjs，用文字模型：补给或你配的）。按钮（lib/crew-desk.mjs runMemberOp）、对话里的「运行 judge-leads」、任务卡都经 runOp；
// 团队页能不能点（opGate）也按它算。只此一处。
// judgeOk：调用方手上已经有「判断层能不能用」（lib/crew-desk.mjs capabilities 的 judge）就传进来，和页面上那一栏同一份。
// judgeOk：判断层（Jev 或离线规则）能不能用；不知道（null）就照原样。要按现在的情况认的，用 lib/ops.mjs 的 opFor（它去问判断层）。
export const opFor = (op, judgeOk = null) => (op === 'judge-leads' && judgeOk === false ? 'match' : op);
// 按钮上的名字：同上，OPS 的 label 里带内部名字的几项。
export const LABEL = {
  'judge-leads': '判断全部新岗位', 'mail-poll': '收件箱巡检', inbox: '整理已收到的邮件',
  'host-work': '整理交办的事', 'browser-tidy': '收拾浏览器',
};
export const opLabel = key => LABEL[key] || OPS[key]?.label || key;

// 要不要模型：
//   null       不用模型，本机脚本
//   model      文字模型（lib/model.mjs infer，config/model.json 和这位成员自己的底座）
//   judge      独立 Jev 接口（lib/judge.mjs；判断岗位在离线规则打开时也能跑）
//   contacts   文字模型或独立识别接口；联系人识别不依赖可选本机工具
//   mail       读信：能力表说谁读（lib/capabilities.mjs mailReader：接了内置邮箱是引擎；没接就跑不了，给「接上邮箱」）
//   some       有几步要模型：没有能用的模型时那几步跳过或记一条失败，其余照常，所以照样能跑
export const OP_NEEDS = {
  'round-scout': null, 'round-first': 'some', discover: null, 'discover-wide': null, 'discover-human': null,
  'round-lens': 'some', 'judge-leads': 'judge', match: 'model', 'preferences-rebuild': null,
  'round-tailor': 'some',
  'round-quill': 'some', 'find-contacts': 'contacts', 'find-referrers': 'contacts', 'prepare-applications': null,
  'round-owl': 'some', inbox: 'some', 'mail-poll': 'mail', 'linkedin-inbox': null, 'boss-inbox': null, 'maimai-inbox': null,
  'round-patch': null, 'cycle-light': null, 'cycle-full': 'some', 'host-work': null,
  'browser-tidy': null, metrics: null,
};

// ── 操作 ────────────────────────────────────────────────────────────────────
// 一次运行算谁的：OPS 写了 role 用它；不在 OPS 里的（任务板「收录并核验」起的 add-lead）按步骤归属（lib/crew.mjs STEP_MEMBER），
// 都没有才算 System（QA 第 2 轮 #15：收录是 Radar 的活，却写成「System 的『收录并核验』在跑」）。
export const opMember = op => OPS[op]?.role || STEP_MEMBER[op] || 'patch';
