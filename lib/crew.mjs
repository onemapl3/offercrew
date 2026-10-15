// 团队名册（2026-09-29，design/团队与工作流.md 第 3 节）：6 个小组，一组一位成员。成员是一份职责——
// 管周期里哪几步、请执行器做哪几类事、用不用模型、预设的岗位说明书（config/crew/<id>.md，crewPrompt 读），都在这张表里。
//   scout  找岗位  扫官网和真人招聘帖、收下你交来的岗位、核验
//   lens   看岗位  判断、公司调研和「怎么准备」、一页评估、学你的偏好
//   tailor 做材料  简历体检、改写、版本、按岗位定制；自我介绍和求职信
//   quill  递出去  定路线、找联系人和内推人、写和回消息、填表停在终审、守门规则
//   owl    回复与面试  看邮箱、直接读 LinkedIn 网页来信（通知邮件作补充）、认出回复和面试、提醒跟进、面试资料；打开后隔一段时间只读看 BOSS 聊天列表；脉脉消息同步暂不可用；以后当教练
//   patch  后勤    定时运行、同步数据、自动修复、记账
// 执行器不是成员：它是大家共用的手（开浏览器、上网查）。它做的事、花的钱记在请它做事的那位名下（JOB_MEMBER）；
// 它的监督（lib/executor-heartbeat.mjs、lib/runtime-recovery.mjs）照旧，开关还是 state/agent-pause.json 的 executor。
//
// 老编号只在这里换成成员（crewOf）：radar / reacher / watch / system / executor，和事件里更老的 actor
// （postman、nightwatch、listener、heartbeat、concierge）。事件、飞书卡片、对话会话、暂停记录、config/roles.json
// 里存着的老编号一律不改写，读的时候经这里换。对话（feat/talk）和记账（feat/cost-meter）也从这里认成员。
import fs from 'node:fs';

export const CREW_IDS = ['scout', 'lens', 'tailor', 'quill', 'owl', 'patch'];
// 小组：一组一位，顺序就是一条岗位从发现到面试的顺序，后勤在最后。
export const GROUPS = [
  { key: 'find', label: '找岗位' }, { key: 'review', label: '看岗位' }, { key: 'materials', label: '做材料' },
  { key: 'outreach', label: '递出去' }, { key: 'interview', label: '回复与面试' }, { key: 'ops', label: '后勤' },
];
// 显示名和脸（2026-09-30 01:05 负责人定的）：名字一眼看出干什么；脸是一枚圆片，底色 fill、图标线条 ink，
// 图标是 Tabler Icons 的 outline 图标名（SVG 在 web/crew-faces.js，随代码发，不从网上加载）。没有 emoji。
// 改名、换脸只改这两张表（lib/brand.mjs 的 CREW 从这里来）；内部 id 和 LEGACY 不动。
export const NAMES = { scout: 'Radar', lens: 'Judge', tailor: 'Writer', quill: 'Reacher', owl: 'Watcher', patch: 'System' };
export const FACES = {
  scout: { icon: 'radar-2', fill: '#E6F1FB', ink: '#0C447C' },
  lens: { icon: 'scale', fill: '#EEEDFE', ink: '#3C3489' },
  tailor: { icon: 'writing', fill: '#FBEAF0', ink: '#72243E' },
  quill: { icon: 'send', fill: '#E1F5EE', ink: '#085041' },
  owl: { icon: 'eye', fill: '#FAECE7', ink: '#712B13' },
  patch: { icon: 'settings', fill: '#F1EFE8', ink: '#444441' },
  // 你和整个团队是中性的圆片（页面的底色 + 一圈细线），fill / ink 为 null。
  you: { icon: 'user', fill: null, ink: null },
  team: { icon: 'users', fill: null, ink: null },
};
// 09-29 那一版的显示名：@ 提到、存着的文字里还会出现，和新名字一样认成同一位（大小写要对上：小写的 radar / reacher /
// system 是老编号，走下面的 LEGACY）。
export const FORMER_NAMES = { Scout: 'scout', Lens: 'lens', Tailor: 'tailor', Quill: 'quill', Owl: 'owl', Patch: 'patch' };
const BY_NAME = { ...FORMER_NAMES, ...Object.fromEntries(Object.entries(NAMES).map(([id, n]) => [n, id])) };
export const OWNER = { id: 'you', name: '你', ...FACES.you };
export const TEAM = { id: 'team', name: '团队', ...FACES.team };
// 一位一行。name 来自 NAMES；icon / color 来自 FACES。
//   skills   技能的 id：config/crew/<id>.md 第 7 节「技能清单」里每个技能一个小标题（### <skill> · 名字），crewPrompt 按它挑
//   models   用不用模型：yes 用 · some 有时用 · little 很少用；models_for 写用在哪
//   legacy   老编号：这位的模型设置（config/roles.json）没设时沿用谁的（lib/roles.mjs）
//   plain    给人看的一句白话：他帮你做什么（成员页、任务卡片用；任务卡片 L 线 10-03）。duty 是给成员和提示词看的，不动
export const MEMBERS = {
  scout: { id: 'scout', group: 'find', title: '侦察', name: NAMES.scout, icon: FACES.scout.icon, color: { fill: FACES.scout.fill, ink: FACES.scout.ink }, duty: '扫官网和真人招聘帖，收下你交来的岗位，核验还在不在招', plain: '帮你找岗位：扫官网和招聘帖，收下你发来的链接，看看还招不招',
    skills: ['scan-ats', 'scan-posts', 'intake', 'verify'], models: 'some', models_for: '读真人帖、截图', legacy: 'radar' },
  lens: { id: 'lens', group: 'review', title: '参谋', name: NAMES.lens, icon: FACES.lens.icon, color: { fill: FACES.lens.fill, ink: FACES.lens.ink }, duty: '判断值不值得投，调研公司、写「怎么准备」和一页评估，从你的决定里学偏好', plain: '帮你看值不值得投，查这家公司，告诉你面试怎么准备',
    skills: ['judge', 'research', 'prep', 'evaluate', 'preferences'], models: 'yes', models_for: '判断和匹配；公司调研（抓官网、招聘页，用模型整理）', legacy: 'radar' },
  tailor: { id: 'tailor', group: 'materials', title: '简历师', name: NAMES.tailor, icon: FACES.tailor.icon, color: { fill: FACES.tailor.fill, ink: FACES.tailor.ink }, duty: '简历体检、逐条改写、版本、按岗位定制；自我介绍和求职信', plain: '改你的简历，写求职信和自我介绍',
    skills: ['resume', 'tailor', 'letters'], models: 'yes', models_for: '简历改写、按岗位定制', legacy: 'reacher' },
  quill: { id: 'quill', group: 'outreach', title: '联络', name: NAMES.quill, icon: FACES.quill.icon, color: { fill: FACES.quill.fill, ink: FACES.quill.ink }, duty: '定路线、找联系人和内推人、写和回消息、填表停在终审，守门规则', plain: '帮你找人、找内推、写消息、填申请表，发出和提交之前都先给你看',
    skills: ['route', 'contacts', 'messages', 'apply', 'guard'], models: 'yes', models_for: '首联、私信、回复的起草和改写', legacy: 'reacher' },
  owl: { id: 'owl', group: 'interview', title: '跟进', name: NAMES.owl, icon: FACES.owl.icon, color: { fill: FACES.owl.fill, ink: FACES.owl.ink }, duty: '看邮箱，通过已登录的专用浏览器直接读取 LinkedIn 来信（不依赖邮箱，通知邮件作补充），认出回复、面试邀请，记时间、提醒你跟进，备面试资料；打开后隔一段时间只读看一眼 BOSS 聊天列表，不点开未读、不回复；脉脉消息同步暂不可用', plain: '看你的邮箱和招聘消息，有回复、有面试就提醒你，帮你备面试',
    skills: ['mail', 'interview', 'coach'], models: 'yes', models_for: '来信分类与摘要；面试资料', legacy: 'watch' },
  patch: { id: 'patch', group: 'ops', title: '管家', name: NAMES.patch, icon: FACES.patch.icon, color: { fill: FACES.patch.fill, ink: FACES.patch.ink }, duty: '定时运行、同步数据、自动修复、记账', plain: '按时叫大家开工，同步数据，出了问题先修，记下花了多少',
    skills: ['schedule', 'sync', 'repair', 'ledger'], models: 'little', models_for: '状态问答', legacy: 'system' },
};
export const isMember = id => typeof id === 'string' && Object.hasOwn(MEMBERS, id);
export const groupOf = id => GROUPS.find(g => g.key === MEMBERS[id]?.group) || null;
export const crewName = id => { const m = crewOf(id); return m ? MEMBERS[m].name : String(id || ''); };
// 一位的完整一行（页面、对话、记账都用这一份）：名字、脸、小组、职责、技能、用不用模型。
export function crewMember(id) {
  const k = crewOf(id);
  if (!k) return null;
  const m = MEMBERS[k], g = groupOf(k);
  return { ...m, key: k, face: faceOf(k), group: g.key, group_label: g.label, label: `${m.name} · ${g.label}` };
}
// 给 lib/brand.mjs 的 CREW（桌面 App 的通知等只要名字和脸的地方）：{ scout: { name, icon, fill, ink }, … }。
export const CREW = Object.fromEntries(CREW_IDS.map(id => [id, { name: NAMES[id], ...FACES[id] }]));
export const crewList = () => CREW_IDS.map(crewMember);
// 任何一张脸：成员（老编号、新旧显示名也认）、你（you / user）、整个团队（team）。
// 返回 { id, name, icon, fill, ink }（你和团队的 fill / ink 是 null：中性圆片）；认不出是 null。页面用 web/crew-faces.js 画。
// 只要圆片本身（{ icon, fill, ink }）：/api/hq、/api/team、快照里的成员、你、团队都带这个 face 字段。
export const faceOf = id => { const f = crewFace(id); return f ? { icon: f.icon, fill: f.fill, ink: f.ink } : null; };
export function crewFace(id) {
  if (id === 'you' || id === 'user') return { ...OWNER };
  if (id === 'team') return { ...TEAM };
  const k = crewOf(id);
  return k ? { id: k, name: MEMBERS[k].name, ...FACES[k] } : null;
}
// 按小组排（右侧面板、筛选条用）：一组一位，以后一组可以有几位。
export const crewGroups = () => GROUPS.map(g => ({ ...g, members: CREW_IDS.filter(id => MEMBERS[id].group === g.key) }));

// ── 老编号 → 成员（只有这一处）─────────────────────────────────────────────────
//   member   没有别的线索时换成谁
//   split    同一个老编号，按步骤分给几位：radar 发现的事归 Scout、判断的事归 Lens；watch 的公司调研归 Lens；
//            system 名下的简历导入归 Tailor
//   pause    老的暂停记录（state/agent-pause.json 里按老编号写的）显示成谁暂停了（lib/agents.mjs）
// executor 不是成员：请它做事的那位（按交办任务的种类，JOB_MEMBER）；认不出就记在 Patch 名下。
export const LEGACY = {
  radar: { name: 'Radar', member: 'scout', split: ['scout', 'lens'], pause: ['scout', 'lens'] },
  reacher: { name: 'Reacher', member: 'quill', split: ['quill', 'tailor'], pause: ['quill', 'tailor'] },
  watch: { name: 'Watch', member: 'owl', split: ['owl', 'lens'], pause: ['owl'] },
  system: { name: 'System', member: 'patch', split: ['patch', 'tailor'], pause: ['patch'] },
  executor: { name: '本机 AI', member: null, split: [], pause: [] },
  // 事件里更老的 actor（bin/cycle.mjs 还在写，web/app.js 的运行日志按它们筛过）。
  postman: { name: 'Postman', member: 'quill', split: ['quill'], pause: [] },
  nightwatch: { name: 'Nightwatch', member: 'owl', split: ['owl'], pause: [] },
  listener: { name: '消息与服务', member: 'patch', split: ['patch'], pause: [] },
  heartbeat: { name: '定时运行', member: 'patch', split: CREW_IDS, pause: [] },
  concierge: { name: '同步', member: 'patch', split: ['patch'], pause: [] },
};
export const isLegacy = id => typeof id === 'string' && Object.hasOwn(LEGACY, id);

// 事件和周期的步骤 → 成员（lib/command-center.mjs 的运行记录归属、团队条的「上次做了什么」都按它）。
// 周期阶段的归属在下面 STAGE_MEMBERS；这里是事件里出现的全部步骤名。
const STEPS_OF = {
  scout: ['discover', 'discover-human', 'discover-human-browser', 'add-lead', 'verify-sources', 'backfill-jd', 'extract', 'capture', 'verify', 'fix-alitalent-urls'],
  lens: ['judge-leads', 'judge', 'match', 'match-recalibrate', 'evaluate', 'flashcard', 'flashcard-start', 'preferences', 'company-brief', 'role-prep', 'research'],
  tailor: ['tailor-resumes', 'tailor-resume', 'resume', 'resume-import'],
  quill: ['reach', 'send-approved', 'send-dm', 'auto-apply', 'find-contacts', 'find-referrers', 'prepare-applications', 'queue-apply', 'queue-auto-apply', 'contacts', 'referrers', 'send', 'submit', 'send-authorization', 'draft', 'reconcile-mail', 'computer-use'],
  owl: ['inbox', 'mail-read', 'boss-chat', 'boss-inbox', 'maimai-chat', 'maimai-inbox', 'linkedin-mail', 'mail-poll', 'gmail-check', 'gmail-auth', 'prepare-interviews', 'interview', 'reply', 'mail', 'register-dossier'],
  patch: ['cycle', 'host-work', 'project-journey', 'metrics', 'concierge', 'web', 'run-now', 'sync', 'connection', 'connect', 'feedback-queue', 'catchup', 'cycle-catchup', 'notify', 'digest', 'message', 'route', 'room', 'pull-feedback', 'ops', 'auto-repair', 'login-watch', 'project-base', 'job-list', 'base-fields', 'base-views', 'settings', 'setup', 'migrate', 'memory', 'ask-card', 'card-action', 'chat', 'feedback', 'feedback-applied', 'feedback-retry', 'feedback-sync', 'supervise', 'system-watch', 'fallback-ledger'],
};
export const STEP_MEMBER = Object.fromEntries(Object.entries(STEPS_OF).flatMap(([m, steps]) => steps.map(s => [s, m])));
const stepOwner = step => typeof step === 'string' && Object.hasOwn(STEP_MEMBER, step) ? STEP_MEMBER[step] : null;

// 周期（bin/cycle.mjs）的每一步归谁。一步可以分给两位：prepare-interviews 里面试资料是 Owl 的，公司调研和
// 「怎么准备」的排队是 Lens 的——两位都暂停才整步跳过，只停一位就只跳过它那一段（bin/prepare-interviews.mjs）。
// project-base、job-list 是同步飞书（原来记在 Radar 名下），归 Patch。
export const STAGE_MEMBERS = {
  discover: ['scout'], 'discover-human': ['scout'], 'discover-human-browser': ['scout'],
  'judge-leads': ['lens'], match: ['lens'], evaluate: ['lens'],
  'tailor-resumes': ['tailor'],
  reach: ['quill'], 'send-approved': ['quill'], 'send-dm': ['quill'], 'find-contacts': ['quill'], 'find-referrers': ['quill'], 'prepare-applications': ['quill'], 'auto-apply': ['quill'],
  inbox: ['owl'], 'mail-read': ['owl'], 'prepare-interviews': ['owl', 'lens'],
  'pull-feedback': ['patch'], 'host-work': ['patch'], metrics: ['patch'],
};
// 2026-09-29 之前每一步归哪个老编号：老的暂停记录照旧管它原来那几步，一步不多、一步不少（lib/agents.mjs）。
export const LEGACY_STAGE = {
  discover: 'radar', 'discover-human': 'radar', 'discover-human-browser': 'radar', 'judge-leads': 'radar', match: 'radar', evaluate: 'radar',
  reach: 'reacher', 'send-approved': 'reacher', 'send-dm': 'reacher', 'find-contacts': 'reacher', 'find-referrers': 'reacher', 'prepare-applications': 'reacher', 'tailor-resumes': 'reacher', 'auto-apply': 'reacher',
  inbox: 'watch', 'mail-read': 'watch', 'prepare-interviews': 'watch',
  'pull-feedback': 'system', 'host-work': 'system', metrics: 'system',
};
// 周期每一步是哪一类活（任务卡的类型，下面 KINDS）、给人看的名字：例行卡、周期记账（lib/cycle-ledger.mjs）、告警的「同一类活」都按它。
export const STAGE_KIND = { discover: 'scan-ats', 'discover-human': 'scan-posts', 'discover-human-browser': 'scan-posts', 'judge-leads': 'judge', match: 'judge', evaluate: 'judge', 'tailor-resumes': 'tailor', reach: 'draft', 'send-approved': 'send', 'send-dm': 'send', 'find-contacts': 'contacts', 'find-referrers': 'referrers', 'prepare-applications': 'apply', 'auto-apply': 'apply', inbox: 'mail', 'mail-read': 'mail', 'prepare-interviews': 'interview', concierge: 'sync', 'project-base': 'sync', 'job-list': 'sync', metrics: 'ledger' };
export const STAGE_LABEL = { discover: '扫官方源', 'discover-human': '扫真人帖', 'judge-leads': '判断新岗位', match: '匹配', 'tailor-resumes': '按岗位定制简历', reach: '起草首联', 'send-approved': '发出已批准的', 'find-contacts': '找联系人', 'find-referrers': '找内推人', 'prepare-applications': '准备投递材料', 'auto-apply': '执行已批准的投递', inbox: '整理收件箱', 'mail-read': '读邮件', 'prepare-interviews': '面试资料', concierge: '同步飞书', metrics: '更新指标' };
export const stageMembers = stage => STAGE_MEMBERS[stage] || [];
// 这位成员在给定的这几步里管哪几步（「立即跑一轮」只跑这些，bin/cycle.mjs --only）。
export const stagesOfMember = (id, stages) => stages.filter(s => stageMembers(s).includes(id));

// 任务卡的类型（lib/tasks.mjs，design/task-board/spec.md 附录 C）→ 成员、做法、底下接的交办任务种类。**唯一的换算表**：
// 卡片按类型自动认领（KIND_MEMBER），交给执行器的任务按种类归成员（JOB_MEMBER）都从这里推出来，不另写一份。
//   member  管这类卡的成员（null：看情况定——你交代的事按说话的那位，跑一轮按按钮的主人）
//   how     script 脚本 · browser 浏览器 · model 要模型（引擎加文字模型做，和 lib/capabilities.mjs MODEL_WORK 一致） · executor 执行器（开会话上网、操作浏览器）
//   op      脚本类的卡「▶ 运行」时跑的操作台脚本（lib/command-center.mjs OPS）
//   jobs    执行器接的交办任务种类（state/host-jobs.ndjson 的 kind；只剩以前排的旧任务按它归成员）
//   cap     能力表里的那一类（lib/capabilities.mjs whoDoes 的 kind）：MODEL_WORK 的是 model，只有 LOCAL_AI_OK 的（你交代的事、修复）
//           本机 AI 打开时可以接手，写 executor；两边一致由 tests/engine-research.test.mjs 对账
export const KINDS = {
  intake: { member: 'scout', label: '收录并核验', how: 'script', op: 'add-lead', jobs: ['read_forwarded_source', 'read_incremental'] },
  verify: { member: 'scout', label: '核验', how: 'script', op: null, jobs: [] },
  'scan-ats': { member: 'scout', label: '扫官方源', how: 'script', op: 'discover', jobs: [] },
  'scan-posts': { member: 'scout', label: '扫真人帖', how: 'script', op: 'discover-human', jobs: ['discover_human_opportunities'] },
  judge: { member: 'lens', label: '判断', how: 'model', op: 'judge-leads', jobs: [], cap: 'judge' },
  research: { member: 'lens', label: '公司调研', how: 'model', op: null, jobs: ['company_brief'], cap: 'company_research' }, // 引擎抓公开页面、模型整理（lib/company-research.mjs）；company_brief 只剩以前排的旧任务
  prep: { member: 'lens', label: '怎么准备', how: 'model', op: null, jobs: ['role_prep'] }, // Judge 自己写（lib/role-prep.mjs，L 线第 1b 批）；role_prep 只剩以前排的旧任务
  preferences: { member: 'lens', label: '学你的偏好', how: 'script', op: 'preferences-rebuild', jobs: [] },
  resume: { member: 'tailor', label: '改简历', how: 'model', op: null, jobs: [] },
  tailor: { member: 'tailor', label: '按岗位定制简历', how: 'model', op: 'round-tailor', jobs: [], cap: 'tailor_resume' },
  letters: { member: 'tailor', label: '求职信和自我介绍', how: 'model', op: null, jobs: [], cap: 'draft_letter' },
  contacts: { member: 'quill', label: '找联系人', how: 'script', op: 'find-contacts', jobs: ['verify_contact_entry'] },
  referrers: { member: 'quill', label: '找内推', how: 'script', op: 'find-referrers', jobs: [] },
  draft: { member: 'quill', label: '写消息', how: 'model', op: null, jobs: ['reply_on_thread', 'prepare_followup', 'revise_material'], cap: 'draft_letter' },
  apply: { member: 'quill', get label() { return autoSubmitLabel(); }, how: 'browser', op: null, jobs: ['prepare_application_packet', 'queue_auto_apply', 'sync_application_review'] },
  send: { member: 'quill', label: '发出已批准的', how: 'script', op: null, jobs: [] }, // 不跑脚本：草稿等你批准，周期按原样发出（lib/tasks.mjs startCard / deriveCard）
  mail: { member: 'owl', label: '看邮箱', how: 'script', op: 'inbox', jobs: [], cap: 'read_mail' },
  interview: { member: 'owl', label: '面试资料', how: 'model', op: null, jobs: ['research_interview_dossier', 'prepare_interview', 'interview_review'], cap: 'interview_prep' }, // 引擎加模型写（lib/interview-dossier.mjs）；jobs 是命令行版（飞书文档）的旧任务，App 里不再排
  repair: { member: 'patch', label: '修复', how: 'executor', op: null, jobs: ['system_fix', 'host_cycle_review'], cap: 'system_repair' },
  cycle: { member: 'patch', label: '周期', how: 'script', op: null, jobs: [] },
  sync: { member: 'patch', label: '同步数据', how: 'script', op: null, jobs: [] },
  ledger: { member: 'patch', label: '记账', how: 'script', op: 'metrics', jobs: [] },
  round: { member: null, label: '跑一轮', how: 'script', op: null, jobs: [] },
  ask: { member: null, label: '你交代的事', how: 'executor', op: null, jobs: [], cap: 'user_task' },
};
export const KIND_MEMBER = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.member]));
// 投递卡的名字跟着自动提交开关（09-30 #26）：关着（默认）系统只预填、你在页面上提交，卡叫「预填申请表」。
// 直接读 config/pipeline.json，不引 lib/apply-channel.mjs（那边间接引用这里），也不引 lib/store.mjs（引进来会提前定下数据目录）。
function autoSubmitLabel() { let on = false; try { const base = process.env.RADAR_ROOT || new URL('../', import.meta.url).pathname; on = JSON.parse(fs.readFileSync(`${base.replace(/\/$/, '')}/config/pipeline.json`, 'utf8')).auto_submit === true; } catch {} return on ? '填表并提交' : '预填申请表'; } // 兜底：没有 pipeline.json 就当没开自动提交
export const kindLabel = k => KINDS[k]?.label || String(k || '');
// 这位成员管不管这类卡（换人时只把管这类事的排在前面；bin/task.mjs pass 只能交给管这类事的）。
export const handlesKind = (member, kind) => !!KINDS[kind] && (KINDS[kind].member == null || KINDS[kind].member === crewOf(member));
// 交给执行器的任务（state/host-jobs.ndjson 的 kind）→ 请它做事的成员（由 KINDS 的 jobs 推出来）。执行器做的事、卡住等你的事、花的钱都记在这位名下。
// 认不出的种类记在 Patch 名下（它管运行）。你交代的事（user_request）记在你当时说话的那位名下（thread.persona）。
export const JOB_MEMBER = Object.fromEntries(Object.values(KINDS).flatMap(k => k.jobs.map(j => [j, k.member])));
export const JOB_CARD_KIND = Object.fromEntries(Object.entries(KINDS).flatMap(([id, k]) => k.jobs.map(j => [j, id])));
const jobOwner = kind => typeof kind === 'string' && Object.hasOwn(JOB_MEMBER, kind) ? JOB_MEMBER[kind] : null;
export const memberOfJob = (job = {}) => jobOwner(job?.kind) || (job?.kind === 'user_request' ? crewOf(job.thread?.persona || job.persona, { fallback: 'patch' }) : 'patch');

// 任何编号（加上步骤或交办任务的种类）→ 成员 id。**唯一的换算函数**：事件、暂停、页面、对话（feat/talk）、
// 记账（feat/cost-meter 的 crewMember）都问它。按这个顺序：
//   1. 新编号原样（成员自己写的就算它的）；
//   2. 交办任务的种类认得出（JOB_MEMBER）：请执行器做这件事的那位——调用方写的是执行器、老编号还是没写，都按活算；
//   3. 老编号：步骤在它的 split 里就归那一步的主人（radar + judge → Lens，system + resume-import → Tailor），否则归它的 member；
//   4. executor、没写编号、认不出的编号：按步骤（STEP_MEMBER）；还认不出，executor 记在 Patch 名下（它管运行），
//      其余给 fallback（默认 null：调用方自己决定记到谁名下）。
// 你（user / you）不是成员：给 fallback。
export function crewOf(id, { step = null, job_kind = null, fallback = null } = {}) {
  if (isMember(id)) return id;
  if (typeof id === 'string' && Object.hasOwn(BY_NAME, id)) return BY_NAME[id];
  if (id === 'user' || id === 'you') return fallback;
  const byJob = jobOwner(job_kind), byStep = stepOwner(step);
  if (byJob) return byJob;
  if (isLegacy(id) && id !== 'executor') { const L = LEGACY[id]; return byStep && L.split.includes(byStep) ? byStep : L.member || fallback; }
  return byStep || (id === 'executor' ? fallback || 'patch' : fallback);
}
// 一条运行事件（state/events.ndjson）是谁的：先看步骤，再看 actor；你自己的操作是「you」。
export function memberOfEvent(e = {}) {
  if (e.actor === 'user') return 'you';
  return stepOwner(e.step) || crewOf(e.actor, { step: e.step, fallback: 'patch' });
}
// 老编号 → 换过去的那几位（设置页、暂停记录、对话会话说「原来的 Radar 现在是 Scout 和 Lens」用）。
export const legacyMembers = id => isLegacy(id) ? [...new Set([LEGACY[id].member, ...LEGACY[id].split].filter(Boolean))] : isMember(id) ? [id] : [];

// ── 岗位说明书（预设提示词）─────────────────────────────────────────────────────
// config/crew/<id>.md：七节（你是谁、负责什么 / 你不做什么 / 你会收到什么 / 你要交出什么 / 你能用什么工具 / 铁律 / 技能清单），
// 六位共用的规矩在 config/crew/shared.md（同样七节）：说明书任何一节里写 {{共同}} 的地方换成 shared.md 同号那一节，
// {{共同铁律}} 换成 shared.md 第 6 节。成员的名字不写死：{{scout}} 这类占位换成名册里的显示名（NAMES），{{scout:组}} 换成
// 小组名（GROUPS），改名只改名册。说明书跟代码一起发（读这份代码树里的，不看 RADAR_ROOT）。旧提示词里每一条规矩落在哪一份、哪一节，见 config/crew/rules-map.json（tests/crew-rules.test.mjs 对账）。
// 现在还没有会话用它：一件事一个短会话（design/团队与工作流.md 2.2，工作流 C）接上之前，执行器照旧读 config/*-prompt.md。
export const CREW_DIR = new URL('../config/crew/', import.meta.url);
export const SECTIONS = ['你是谁、负责什么', '你不做什么', '你会收到什么', '你要交出什么', '你能用什么工具', '铁律', '技能清单'];
const ANCHOR = /\s*〔[^〕]*〕/g;
const readCrewFile = name => fs.readFileSync(new URL(name, CREW_DIR), 'utf8');
// 一份说明书切成节：{ n: 1–7, title, body }；第 7 节再切成技能：{ id, name, body }。
export function parseCrewDoc(text) {
  const out = { head: '', sections: [] };
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^## (\d)\. (.+)$/.exec(line);
    if (m) { cur = { n: Number(m[1]), title: m[2].trim(), lines: [] }; out.sections.push(cur); continue; }
    if (cur) cur.lines.push(line); else out.head += line + '\n';
  }
  for (const s of out.sections) {
    s.body = s.lines.join('\n').trim(); delete s.lines;
    if (s.n !== 7) continue;
    s.skills = [];
    let sk = null;
    for (const line of s.body.split('\n')) {
      const m = /^### ([a-z][a-z0-9-]*) · (.+)$/.exec(line);
      if (m) { sk = { id: m[1], name: m[2].trim(), lines: [] }; s.skills.push(sk); continue; }
      if (sk) sk.lines.push(line);
    }
    for (const k of s.skills) { k.body = k.lines.join('\n').trim(); delete k.lines; }
    s.intro = s.body.split(/\n### /)[0].trim();
  }
  out.head = out.head.trim();
  return out;
}
export const crewDoc = id => parseCrewDoc(readCrewFile(`${crewOf(id) || id}.md`));
export const sharedDoc = () => parseCrewDoc(readCrewFile('shared.md'));
export const sharedRules = () => sharedDoc().sections.find(s => s.n === 6)?.body || '';
// 成员的名字和小组名：{{lens}} → Judge，{{lens:组}} → 看岗位。认不出的原样留着（测试会抓）。
const MEMBER_TAG = new RegExp(`\\{\\{(${CREW_IDS.join('|')})(:组)?\\}\\}`, 'g');
export const fillNames = text => String(text).replace(MEMBER_TAG, (m, id, g) => (g ? groupOf(id).label : NAMES[id]));
// 交给短会话的那一份：七节全文，{{共同}} / {{共同铁律}} 展开；skill 给了就只带那一个技能（其余技能只列名字），不给就全带。
// 对账用的〔编号〕默认去掉（anchors: true 留着）；vars 给了就填占位符（lib/prompt.mjs renderPrompt，{{MAILBOX}} 这类）。
export function crewPrompt(id, { skill = null, anchors = false, vars = null } = {}) {
  const k = crewOf(id);
  if (!k) throw Error(`没有这位成员：${id}`);
  const doc = crewDoc(k), shared = sharedDoc().sections;
  const common = n => shared.find(s => s.n === n)?.body || '';
  const expand = (n, body) => body.replace(/\{\{共同铁律\}\}/g, () => common(6)).replace(/\{\{共同\}\}/g, () => common(n));
  const s7 = doc.sections.find(s => s.n === 7);
  if (skill && !s7?.skills.some(x => x.id === skill)) throw Error(`${crewName(k)} 没有这个技能：${skill}`);
  const parts = [doc.head];
  for (const s of doc.sections) {
    let body = expand(s.n, s.body);
    if (s.n === 7 && skill) {
      const pick = s7.skills.find(x => x.id === skill), others = s7.skills.filter(x => x.id !== skill);
      body = [expand(7, s7.intro), `### ${pick.id} · ${pick.name}\n${pick.body}`, others.length ? `（其余技能这次用不上：${others.map(x => x.name).join('、')}）` : ''].filter(Boolean).join('\n\n');
    }
    parts.push(`## ${s.n}. ${s.title}\n${body}`);
  }
  let text = fillNames(parts.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (!anchors) text = text.replace(ANCHOR, '');
  if (vars) text = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (vars[key] ? String(vars[key]) : m));
  return text;
}
