import { receiptCards, receiptWords } from './task-receipt.mjs';
// 成员的工作台（「团队」页 #team、#team/<id>，和右侧面板里成员那一栏）：每位成员不只能对话，还有它自己能跑的事、
// 手上的任务和日志——模型不可用的时候照样能用（负责人 2026-09-30：「还是要保留传统的软件入口」）。
//
//   deskList(center, inbox)       六张成员卡：脸、名字、岗位、一句状态、等你几件、「立即跑一轮」（GET /api/team）
//   deskView(id, center, inbox)   点开一位（GET /api/team/<id>）：在 lib/team.mjs workerDetail 上加
//                                 status   现在在做 / 等你 / 暂停 / 出错 / 空闲
//                                 groups   能做的事：OPS（lib/command-center.mjs）按这位的技能（lib/crew.mjs MEMBERS[id].skills）分组，
//                                          分不进技能的放「其它」；每项写要多久、要不要模型、现在能不能跑、在不在跑、上次结果
//                                 tasks    running（在跑的操作、周期步骤、执行器在做的）· queued · waiting（等你，带问题）· done（今天做完的）
//                                 log      最近 10 条事件 + 运行日志按这位筛的链接
//                                 done     做了什么（lib/member-done.mjs）：做出来的东西（每行指到岗位、材料、证据）、一行事实、最近的运行
//   runMemberOp(id, op)           「▶ 运行」（POST /api/team/run）：只收这位名下的操作；要模型而现在没有能用的就不跑、说原因
//
// 每个按钮都直接跑脚本（runOp / agentAction），不经过对话，也不经过模型：「要模型」的那几项只是先查一遍模型能不能用。
// 模型能不能用只看本机文件（沙盒标记、config/model.json 的底座、凭据文件、登录目录），不起子进程、不联网，所以每次请求都能算。
import { runOp, agentAction, opFor, lockHeld, capabilities, opGate, runOrQueue, newOpCard } from './ops.mjs';
import { OPS, OP_NEEDS, LABEL, opLabel, opMember } from './ops-table.mjs';
import { plainText } from './jargon.mjs';
import { href } from './routes.mjs';
import * as J from './jobs.mjs';
import { cleanReason } from './wait-reason.mjs';
import { legacyChip, wordOf } from './status.mjs';
import { queueState, QUEUED_LINE } from './op-queue.mjs';
import { workerDetail, teamView } from './team.mjs';
import { MEMBERS, CREW_IDS, crewMember, isMember, memberOfJob } from './crew.mjs';
import { agentPaused, EXECUTOR } from './agents.mjs';
import { mailState } from './capabilities.mjs';
import { cachedLines } from './state-cache.mjs';
import { viewCard, memberCards, holdReason } from './tasks.mjs';
import { goalAsks } from './card-ops.mjs';
import { readCards, saveCards } from './cards.mjs';
import { sandboxed } from './sandbox.mjs';
import { shortTitle } from './short-title.mjs';
import { dropModelIds } from './event-words.mjs';
import { needShort } from './needs.mjs';
import { dayOf, T, ago, clock, STEP, askForJob, plainReason } from './workflow.mjs';
import { lastRev, JOB_KIND } from './cards.mjs';
import { noteSwallowed } from './swallow.mjs';
import { discoverLine } from './discover-fresh.mjs';
import { loadWorkspace } from './resume-store.mjs';
import { memberDone } from './member-done.mjs';
import { sourceContacts } from './source-contacts.mjs';

// 技能的中文名（lib/crew.mjs 的技能 id；说明书 config/crew/<id>.md 第 7 节的小标题用同一套 id）。
export const SKILL_LABEL = {
  'scan-ats': '扫官方招聘源', 'scan-posts': '扫真人招聘帖', intake: '收下你交来的岗位', verify: '核验还在不在招',
  judge: '判断和匹配', research: '公司调研', prep: '怎么准备', evaluate: '一页评估', preferences: '学你的偏好',
  resume: '简历', tailor: '按岗位定制', letters: '求职信和自我介绍',
  route: '定路线', contacts: '找联系人和内推人', messages: '写和回消息', apply: '投递', guard: '守门规则',
  mail: '看邮箱', interview: '面试', coach: '面试教练',
  schedule: '定时运行', sync: '同步数据', repair: '修复', ledger: '记账',
};
// 每个操作（OPS 的 key）归这位的哪个技能。一位的「跑一轮」单独放最前面（round）；分不进任何技能的写 null，放「其它」。
// 加了新操作就在这里补一行（tests/crew-desk.test.mjs 查：每个操作都有一行、技能是它那位成员的）。
export const OP_SKILL = {
  'round-scout': 'round', 'round-first': null, discover: 'scan-ats', 'discover-wide': 'scan-ats', 'discover-human': 'scan-posts',
  'round-lens': 'round', 'judge-leads': 'judge', match: 'judge', 'preferences-rebuild': 'preferences',
  'round-tailor': 'round',
  'round-quill': 'round', 'find-contacts': 'contacts', 'find-referrers': 'contacts', 'prepare-applications': 'apply',
  'round-owl': 'round', inbox: 'mail', 'mail-poll': 'mail', 'linkedin-inbox': 'mail', 'boss-inbox': 'mail', 'maimai-inbox': 'mail',
  'round-patch': 'round', 'cycle-light': 'schedule', 'cycle-full': 'schedule', 'host-work': 'schedule',
  'browser-tidy': 'repair', metrics: null,
};
// 一般要多久（没跑过时显示；跑过就用最近几次的实际用时）。
export const USUAL = {
  'round-scout': '5–30 分钟', 'round-first': '15–60 分钟', discover: '3–10 分钟', 'discover-wide': '15–30 分钟', 'discover-human': '2–5 分钟',
  'round-lens': '10–40 分钟', 'judge-leads': '1–5 分钟', match: '10–40 分钟', 'preferences-rebuild': '不到 1 分钟',
  'round-tailor': '2–10 分钟',
  'round-quill': '10–40 分钟', 'find-contacts': '5–15 分钟', 'find-referrers': '5–15 分钟', 'prepare-applications': '1–3 分钟',
  'round-owl': '1–5 分钟', inbox: '不到 1 分钟', 'mail-poll': '3–10 分钟', 'linkedin-inbox': '1–4 分钟', 'boss-inbox': '不到 1 分钟', 'maimai-inbox': '不到 1 分钟',
  'round-patch': '2–10 分钟', 'cycle-light': '5–15 分钟', 'cycle-full': '10–40 分钟', 'host-work': '不到 1 分钟',
  'browser-tidy': '不到 1 分钟', metrics: '不到 1 分钟',
};
// 页面上那一行说明：OPS 的 desc 里带文件名和配置项的几条换成人话，其余用 OPS 的（经 plainText）。
// 界面上不说「执行器」「Codex」「launchd」「Jev」「ego」这些内部名字（负责人：说成员名，或者说「这台电脑」；QA 第 2 轮 #11）。
const DESC = {
  discover: '读取关注公司的招聘页，收下新岗位',
  'round-first': '找岗位，接着判断和匹配',
  'round-quill': '起草首联，找联系人和内推人，准备投递材料',
  'round-tailor': '给已批准的岗位写定制版简历',
  'round-lens': '判断岗位，准备公司调研和面试资料',
  'round-patch': '处理反馈，整理任务，同步进度',
  'discover-human': 'V2EX、电鸭、HN 等真人招聘帖（你关掉的来源不抓）',
  match: '对已判断、还没匹配的岗位跑匹配模型（每次有数量上限）',
  'preferences-rebuild': '用你全部的决定重算偏好；你手动改过的值保留',
  'judge-leads': '判断所有还没判断的岗位（每条 1–2 次请求，不到 1 秒）',
  // 接了内置邮箱：点了就读，不看巡检时段（bin/mail-read.mjs 不带 --patrol）。
  'mail-poll': '马上读一遍邮箱、分好类',
  inbox: '把已经收到的邮件分类、归档',
  'cycle-full': '扫官方源和真人帖、判断、匹配、找内推、准备投递、同步；10–40 分钟，会用模型',
  'host-work': '把待处理的事排成任务，等这台电脑接手',
  'browser-tidy': '关掉团队在浏览器里留下的任务窗口和页面；「需要你处理」那个窗口和你自己的页面不动',
};
// 换了跑法的那几项（opFor：没有 Jev 时「判断全部新岗位」跑匹配）的说明。
const DESC_VIA = { 'judge-leads': '用文字模型判断还没判断的岗位（每次有数量上限）' };
const NEED_LABEL = { model: '要模型', judge: '独立判断接口', contacts: '文字模型 / 独立识别接口', some: '部分要模型' };
// 面板里那一栏的几个主按钮（最多 4 个，按这个顺序；跑一轮总在第一个）。
export const MAIN_OPS = {
  scout: ['round-scout', 'discover', 'discover-human'], lens: ['round-lens', 'judge-leads', 'match'], tailor: ['round-tailor'],
  quill: ['round-quill', 'find-contacts', 'find-referrers'], owl: ['round-owl', 'inbox', 'mail-poll', 'linkedin-inbox'], patch: ['round-patch', 'cycle-light'],
};
// 不在 OPS 里、在别的页面上做的事（传统入口：简历在简历页、公司调研在岗位详情里）。
const LINKS = {
  scout: [{ label: '全部岗位', href: href.jobs() }, { label: '网站账号', href: href.settings('accounts') }],
  lens: [{ label: '新线索筛选（指挥台）', href: '#command' }],
  tailor: [{ label: '材料', href: '#materials' }],
  // 登录与核对走账号页现有的引擎流程，不把旧 Codex 诊断脚本列作成员能力。
  quill: [{ label: '起草跟进', href: href.command({ tab: 'waiting' }) }, { label: '草稿和投递', href: href.inbox() }, { label: '联系人', href: href.team('scout', { section: 'contacts' }) }, { label: '网站账号和登录', href: href.settings('accounts') }],
  owl: [{ label: '收件箱', href: '#inbox' }, { label: '面试资料', href: '#materials?tab=interviews' }, { label: '邮箱与网站账号', href: href.settings('accounts') }],
  patch: [{ label: '团队设置', href: '#settings/crew' }, { label: '定时与通知', href: '#settings/notify' }, { label: '账号与连接', href: '#settings/accounts' }],
};
const mins = ms => { const m = Math.round(ms / 60000); return m < 1 ? '不到 1 分钟' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`; };
const took = h => h.started_at && h.finished_at ? T(h.finished_at) - T(h.started_at) : null;
// 一次运行的结果词从 lib/status.mjs 来（ok / fail / lost / running 认成六种之一）。
const RESULT = s => legacyChip(s)?.word || s;
// 这位成员名下的操作（按 OPS 的 role；老记录没写 role 的算 Patch）。
export const memberOpKeys = id => Object.entries(OPS).filter(([, o]) => (o.role || 'patch') === id).map(([k]) => k);
// 按钮没点过、可周期里跑过这一步（事件的步骤名和操作同名）：「上次」写周期里那一次，不写「还没跑过」（QA 第 2 轮 #14）。
const CYCLE_STEP_OF = op => ({ 'mail-poll': ['mail-read', 'mail-poll'], 'round-owl': ['owl-round'], 'round-scout': ['scout-round'], 'round-lens': ['lens-round'], 'round-tailor': ['tailor-resumes'], 'round-quill': ['quill-round'], 'round-patch': ['cycle'], 'cycle-light': ['cycle'], 'cycle-full': ['cycle'] }[op] || [op]);
function cycleLast(key, events = [], now = Date.now()) {
  const steps = CYCLE_STEP_OF(key);
  const ledger = J.list({ member: opMember(key), state: ['done', 'failed'], limit: 200 }).find(j => j.kind === key || (['cycle', 'round'].includes(j.kind) && /^round-|^cycle-/.test(key) && (key !== 'cycle-light' || /轻量/.test(j.title)) && (key !== 'cycle-full' || /完整/.test(j.title))));
  const e = events.find(x => {
    if (!steps.includes(x.step)) return false;
    const run = x.step === 'cycle' ? J.forRun(x.run_id) : null;
    return (!run || run.member === opMember(key)) && ['ok', 'fail', 'skip'].includes(x.status) && (key !== 'cycle-light' || /轻量周期/.test(x.detail || '')) && (key !== 'cycle-full' || /完整周期/.test(x.detail || ''));
  });
  if (ledger && T(ledger.finished_at || ledger.updated_at) >= T(e?.at)) return { id: null, status: ledger.state === 'failed' ? 'fail' : 'ok', text: ledger.state === 'failed' ? cleanReason(ledger.reason) || '失败' : ledger.result?.summary || '做完了', at: ledger.finished_at || ledger.updated_at, ago: ago(ledger.finished_at || ledger.updated_at, now), took: ledger.started_at && ledger.finished_at ? mins(T(ledger.finished_at) - T(ledger.started_at)) : '', cycle: true };
  return e ? { id: null, status: e.status, text: e.status === 'skip' ? '跳过了' : wordOf(e.status === 'fail' ? 'failed' : 'done'), at: e.at, ago: ago(e.at, now), took: '', cycle: true } : null;
}
// 写定制版的开关决定这一轮有没有工作；按钮和实际开跑共用这一道门。
function memberGate(key, caps) {
  if (key === 'round-tailor' && !loadWorkspace().tailoring.enabled) return { ok: false, why: '按岗位定制关着，这一轮没有要做的事', go: { label: '材料', href: href.materials() } };
  return opGate(key, caps);
}
// 排着的（lib/op-queue.mjs）：这一项排在第几、最近一次排着却没跑的原因（比它上一次运行新才算）。
function queueOf(key, Q = { items: [], done: [] }, last = null) {
  const i = Q.items.findIndex(x => x.op === key), d = Q.done.find(x => x.op === key && x.status !== 'started');
  const lastAt = last ? T(last.finished_at || last.started_at) : 0;
  return { queued: i >= 0 ? { id: Q.items[i].id, ahead: i, line: QUEUED_LINE } : null, dropped: d?.status === 'dropped' && T(d.ended_at) > lastAt ? d : null };
}
// Watcher 读信的两项（lib/watcher-mail.mjs opSummary）：「上次」写读了几封、有没有新的，或者没读、为什么；没读的不算「完成」。
const lastWords = h => h.summary ? { status: h.status === 'ok' && h.read === false ? 'skip' : h.status, text: h.summary, ...(h.go ? { go: h.go } : {}) } : { status: h.status, text: RESULT(h.status) };
const droppedLast = (d, now) => ({ id: null, status: 'dropped', text: `没跑：${d.why}`, at: d.ended_at, ago: ago(d.ended_at, now), took: '' });
const ledgerOfRun = (h, key) => h?.id ? (h.job_id ? J.get(h.job_id) : null) || J.byRef(`op:${h.id}`) || J.list({ member: OPS[key].role, kind: key, limit: 20 }).find(j => T(j.started_at) === T(h.started_at)) : null;
function usefulRun(h, key) {
  const job = ledgerOfRun(h, key), summary = h.summary || job?.result?.summary || '';
  // 没有具体结果的旧退出记录，无法证明这次真的做过事，仍用公开的时间范围。
  return h.status === 'ok' && !h.sandbox && h.read !== false && job?.state !== 'failed' && summary && !/没有新的|没有要|跳过|^跑完了|^做完了|^完成$/.test(summary);
}
function opRow(key, { center, caps, now, events = [], held = null, Q = queueState() }) {
  const o = OPS[key], history = center.ops?.history || [];
  // 写锁被别的进程拿着（定时周期之类，操作台上看不到是哪一项）：和「有一项在跑」一样算在跑；点了就排到后面（runOrQueue），不灰着。
  const cur = center.ops?.current || (held ? { op: null, label: null, held: true } : null);
  const mine = history.filter(h => h.op === key).sort((a, b) => T(b.finished_at || b.started_at) - T(a.finished_at || a.started_at)), last = mine[0] || null, runs = mine.filter(h => usefulRun(h, key)).map(took).filter(x => x != null).slice(0, 5).sort((a, b) => a - b);
  // 接了内置邮箱的收件箱巡检不要本机 AI：不挂「用这台电脑」。
  const gate = memberGate(key, caps), eff = opFor(key, caps.judge?.ok), need = gate.builtin ? null : OP_NEEDS[eff] ?? null;
  const running = cur?.op === key;
  const { queued, dropped } = queueOf(key, Q, last);
  const ledger = ledgerOfRun(last, key);
  const cycle = cycleLast(key, events, now);
  const latestRun = last ? { ...last, ...(ledger?.state === 'failed' ? { status: 'fail', summary: cleanReason(ledger.reason) || '没做成' } : ledger?.result?.counts?.partial ? { status: 'ok', summary: ledger.result.summary } : {}) } : null;
  return {
    key, label: opLabel(key), desc: (eff !== key && DESC_VIA[key]) || DESC[key] || plainText(o.desc), heavy: !!o.heavy, round: !!o.round,
    usual: runs.length ? `一般 ${mins(runs[Math.floor(runs.length / 2)])}` : `一般 ${USUAL[eff] || USUAL[key] || '几分钟'}`, max: `最长 ${mins(o.timeout_ms)}`,
    need, need_label: need ? NEED_LABEL[need] : '', can_run: gate.ok && !cur && !queued, why_not: !gate.ok ? gate.why : cur && !running ? `${cur.label ? `「${cur.label}」` : '这一轮'}还在跑，结束后可以运行` : '', go: gate.ok ? null : gate.go || null, busy: gate.ok && !!cur && !running, note: gate.ok ? gate.why : '',
    running, started_at: running ? cur.started_at : null, run_id: running ? cur.id : null, queued,
    last: dropped ? droppedLast(dropped, now) : cycle && T(cycle.at) > T(last?.finished_at || last?.started_at) ? cycle : last ? { id: last.id, ...lastWords(latestRun), at: last.finished_at || last.started_at, ago: ago(last.finished_at || last.started_at, now), took: took(last) != null ? mins(took(last)) : '', sandbox: !!last.sandbox } : cycleLast(key, events, now),
  };
}
// 能做的事：按技能分组（跑一轮在最前，其它在最后，没有操作的技能不列）。
export function opGroups(id, { center = {}, caps, now = Date.now(), events = [], held = busyLine(center), Q = queueState() } = {}) {
  const keys = memberOpKeys(id), skills = MEMBERS[id].skills;
  const skillOf = k => { const s = OP_SKILL[k]; return s === 'round' ? 'round' : skills.includes(s) ? s : 'other'; };
  const order = ['round', ...skills, 'other'];
  return order.map(s => ({ key: s, label: s === 'round' ? '整轮' : s === 'other' ? '其它' : SKILL_LABEL[s] || s, ops: keys.filter(k => skillOf(k) === s).map(k => opRow(k, { center, caps, now, events, held, Q })) })).filter(g => g.ops.length);
}

// ── 状态和任务 ──────────────────────────────────────────────────────────────
const OPEN = ['pending', 'working', 'waiting_user', 'blocked'];
const jobTitle = j => `${j.number != null ? '#' + j.number + ' ' : ''}${j.company ? j.company + ' · ' : ''}${JOB_KIND[j.kind] || '交办任务'}`;
const stepName = s => STEP[s] || s || '';
// 周期那一句里的模式名（bin/cycle.mjs「开始 full 运行（只跑 …）」）说成人话。
const cycleWords = t => t.replace(/开始 full 运行/, '完整周期').replace(/开始 light 运行/, '轻量周期').replace(/开始 host 运行/, '宿主整轮');
// 任务板上的卡（lib/tasks.mjs）：这一栏就是任务板按这位成员筛出来的卡；指向交办任务、脚本运行的那几件不再另算一遍。
function boardCards(id, { center, jobs, now }) {
  let all;
  try { all = readCards(); all.push(...receiptCards(all)); } catch { return { halts: [], cards: null, askIds: new Set(), jobIds: new Set(), opIds: new Set() }; }
  const ctx = { now, jobs: lastRev(jobs), ops: center.ops || {}, leads: cachedLines('state/leads.ndjson'), runNow: {}, asks: () => [], model: { ok: true }, sandbox: sandboxed(), executorPaused: agentPaused(EXECUTOR), workers: process.env.RADAR_WORKERS === 'off' ? false : undefined };
  const derived = all.filter(c => c.kind !== 'goal').map(c => viewCard(c, ctx)); // 状态读账（lib/task-ledger.mjs），不在这里推
  // 停下来问你「还投吗」的目标：算在停下来那一棒的主人名下（和收件箱里 goal:<id> 那封信是同一件事）。
  const halts = goalAsks({ cards: all }).filter(a => a.from === id).map(a => ({ kind: 'card', card: a.card, title: a.title, step: '', ask: a.question, type: '等你', ask_id: a.id, href: `#tasks?card=${encodeURIComponent(a.card)}` }));
  return { halts, cards: memberCards(id, derived, { now }), askIds: new Set(derived.map(c => c.links?.ask_id).filter(Boolean)), jobIds: new Set(derived.map(c => c.links?.job_id).filter(Boolean)), opIds: new Set(derived.map(c => c.links?.op_id).filter(Boolean)) };
}
// 卡名里的链接只留网站名（「收录并核验 · jobs.example.com」），整条链接不上页头（QA 第 2 轮 #15）。
const noUrl = t => String(t || '').replace(/https?:\/\/([^/\s]+)\S*/g, '$1');
// 任务板那边的「等执行器领取」在成员页上说成「这台电脑」（负责人：界面上不说执行器）。
const plainHand = t => String(t || '').replace(/执行器/g, '这台电脑');
const cardRow = (c, extra = {}) => ({ kind: 'card', card: c.id, title: noUrl(c.title), step: plainHand(plainReason(c.status === 'done' ? c.result : c.detail || c.wait_note || '', 80)), since: ['running'].includes(c.status) ? c.started_at || c.updated_at : null, ago: c.status === 'queued' ? ago(c.created_at, Date.now()) : null, from: c.from?.by === 'member' ? c.from.member : null, from_name: c.from?.by === 'member' ? crewMember(c.from.member)?.name || null : null, href: `#tasks?card=${encodeURIComponent(c.id)}`, ...extra });
function tasksOf(id, { center, inbox, detail, now, jobs }) {
  const today = dayOf(now), asks = inbox.asks || [];
  const board = boardCards(id, { center, jobs, now });
  const mine = lastRev(jobs).filter(j => memberOfJob(j) === id && !board.jobIds.has(j.id));
  const cur = center.ops?.current, role = center.roles?.[id] || {};
  const running = [];
  // 周期步骤在跑（事件里有「开始」没「结束」）：步骤名 + 它那句话去掉重复的部分。
  const stepNow = role.running ? stepName(role.running.step) : '', stepMsg = role.running ? plainReason(dropModelIds(cycleWords(String(role.running.msg || ''))).split(' · ').filter(x => x && x !== stepNow && x !== role.running.step && x !== '开始' && x !== '模型调用' && !new RegExp(`^开始 ${role.running.step}$`).test(x)).join(' · '), 80) : '';
  // 别人按钮起的周期（「找第一批岗位」是 Radar 的）：周期本身的「开始」记在 System 名下，但那是别人的事，System 不算在做。
  const othersCycle = cur && opMember(cur.op) !== id && role.running?.step === 'cycle';
  if (cur && opMember(cur.op) === id) running.push({ kind: 'op', title: cur.label, step: [OPS[cur.op]?.round || /^cycle-/.test(cur.op) ? stepNow : '', stepMsg].filter(Boolean).join(' · '), since: cur.started_at, run_id: cur.id, op: cur.op });
  else if (role.running && !othersCycle) running.push({ kind: 'step', title: stepNow, step: stepMsg, since: role.running.ts });
  const beats = center.executor?.heartbeat?.tasks || [];
  for (const j of mine.filter(j => j.status === 'working')) {
    const hb = beats.find(t => t.status === 'working' && (String(t.task).includes(j.id) || (j.number != null && String(t.detail || '').includes('#' + j.number))));
    running.push({ kind: 'job', title: jobTitle(j), step: plainReason(hb?.detail || j.details, 80), since: j.started_at || j.created_at, rid: j.record_id || null });
  }
  // 排着的交办任务写明在等什么（沙盒不跑、后台任务关着、执行器暂停、等执行器领取），和任务板、对话里同一句。
  const hold = holdReason({ executor: true }, { sandbox: sandboxed(), executorPaused: agentPaused(EXECUTOR), workers: process.env.RADAR_WORKERS === 'off' ? false : undefined });
  const queued = mine.filter(j => j.status === 'pending').map(j => ({ kind: 'job', title: jobTitle(j), step: plainHand(hold) || plainReason(j.details, 80), since: j.created_at, ago: ago(j.created_at, now), rid: j.record_id || null }));
  // 等你：算在这位名下的信（lib/team.mjs workerDetail 已经按 lib/hq.mjs memberOf 分好），再加上等你、卡住但还没成信的交办任务。
  const waiting = (detail.letters || []).map(l => ({ kind: 'ask', title: l.title, ask: l.question, type: l.type, href: `#inbox?ask=${encodeURIComponent(l.id)}` }));
  for (const j of mine.filter(j => ['waiting_user', 'blocked'].includes(j.status))) {
    const aid = askForJob(asks, j.id), href = aid ? `#inbox?ask=${encodeURIComponent(aid)}` : '#inbox';
    // 已经成了信的不再算一件：成员页里信就在上面；团队页的卡片按 teamView 的 letters 数过了（detail 没有 letters）。
    if (aid && (!detail.letters || waiting.some(w => w.href === href))) continue;
    const q = typeof j.waiting_user === 'string' ? j.waiting_user : j.waiting_user?.question;
    const said = String(q || j.required_action || j.result || j.details || '').trim();
    const short = jobNeedTitle(j);
    waiting.push({ kind: 'job', title: jobTitle(j), ask: short, ...(said && said.replace(/[。.]$/, '') !== short ? { full: said } : {}), href, type: j.status === 'blocked' ? '卡住了' : '等你' });
  }
  if (detail.triage_total) waiting.push({ kind: 'triage', title: `${detail.triage_total} 条新线索等你筛`, ask: '推荐的岗位投不投、要不要联系，在指挥台的行上答', href: '#command', type: '筛选' });
  const done = [];
  for (const h of (center.ops?.history || []).filter(h => opMember(h.op) === id && dayOf(h.finished_at || h.started_at) === today)) done.push({ kind: 'op', title: h.label, result: `${h.summary || RESULT(h.status)}${took(h) != null ? ` · 用了 ${mins(took(h))}` : ''}${h.sandbox ? '（沙盒里没真跑）' : ''}`, tone: h.status === 'ok' ? 'ok' : 'bad', at: h.finished_at || h.started_at, time: clock(h.finished_at || h.started_at), run_id: h.id });
  for (const j of mine.filter(j => ['completed', 'done'].includes(j.status) && dayOf(j.completed_at) === today)) done.push({ kind: 'job', title: jobTitle(j), result: plainReason(j.result, 140), tone: 'ok', at: j.completed_at, time: clock(j.completed_at), rid: j.record_id || null });
  const bc = board.cards;
  if (bc) {
    for (let i = done.length - 1; i >= 0; i--) if (done[i].kind === 'op' && board.opIds.has(done[i].run_id)) done.splice(i, 1);
    if (running[0]?.kind === 'op' && board.opIds.has(running[0].run_id)) running.shift();
    running.push(...bc.running.map(c => cardRow(c)));
    // 同一件事既是周期里在跑的一步，又是任务板上在跑的卡（「判断新岗位」写了两遍，C 线 10-01）：留卡。
    for (let i = running.length - 1; i >= 0; i--) if (running[i].kind === 'step' && running.some(r => r.kind === 'card' && (r.title === running[i].title || String(r.title).includes(running[i].title)))) running.splice(i, 1);
    queued.unshift(...bc.incoming.map(c => cardRow(c)), ...bc.queued.map(c => cardRow(c)));
    // 卡上等你的那一封信（终审……）就是这张卡：信不再单列一行。
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].kind === 'ask' && board.askIds.has(decodeURIComponent(String(waiting[i].href || '').replace(/^#inbox\?ask=/, '')))) waiting.splice(i, 1);
    const waitRow = (c, type) => { const short = c.need_title || headline(c.detail); return cardRow(c, { type, step: '', ask: short, ask_id: c.links?.ask_id || null, job_id: c.links?.job_id || null, ...(c.wait ? { wait: c.wait } : {}), ...(c.detail && String(c.detail).replace(/[。.]$/, '') !== short ? { full: c.detail } : {}) }); };
    waiting.unshift(...bc.needs_you.map(c => waitRow(c, '等你')), ...bc.stuck.map(c => waitRow(c, '卡住了')));
    done.push(...bc.done.map(c => cardRow(c, { step: '', result: plainReason(c.result, 140), tone: 'ok', at: c.done_at, time: clock(c.done_at) })));
  }
  waiting.unshift(...board.halts);
  done.sort((a, b) => T(b.at) - T(a.at));
  // card_asks：卡上已经有的那几封信（终审、还投吗……），「等你」合并时不再另列一行。
  const card_asks = [...board.askIds, ...board.halts.map(h => h.ask_id)];
  const out = { running, queued, waiting, done: done.slice(0, 12), passed: bc ? bc.passed.map(c => cardRow(c, { to: c.owner, to_name: crewMember(c.owner)?.name || null, from_name: null })) : [] };
  Object.defineProperty(out, 'card_jobs', { value: [...board.jobIds], enumerable: false });
  return Object.defineProperty(out, 'card_asks', { value: card_asks, enumerable: false });
}
// 一句状态：key ∈ paused / running / waiting / error / idle（暂停最先说，它是一种模式；等你的件数另外有角标）。
// waiting：等你的件数（不含新线索筛选），first：第一件的标题（没有就只写件数）。
// 出错只看最近一次（第 6 轮：Radar 新跑的一轮已经做完，首页还挂着早上那次的「今天有失败」，分不清新旧）：
// 最近一次没做成（成员最后一条记录是失败，或者它最近跑完的那个脚本失败了）才是「出错」；后来又做成了就是正常，
// 只在后面带一句今天早些时候失败过几次。
// 一行「等你」里真要你做的（卡住了的不算）。
const youDo = w => w?.type !== '卡住了';
export function failState(id, { card = {}, center = {}, now = Date.now() } = {}) {
  // 账上这位最近结束的那件活（lib/jobs.mjs）：失败了就是「出错」，原因是那件活自己的（不说「看日志」）。
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const last = J.latest({ member: id, state: ['done', 'failed'] });
  const failsToday = Math.max(center.roles?.[id]?.fails_today || 0, J.list({ member: id, state: 'failed', since: day.getTime(), limit: 500 }).length);
  const why = last?.state === 'failed' ? receiptWords(cleanReason(last.reason)) : '';
  return { now: card.state === 'warn' || last?.state === 'failed', today: failsToday, reason: why || null, title: last?.state === 'failed' ? last.title || null : null };
}
export function statusOf(id, { card, running, waiting, first = '', paused, center, now = Date.now() }) {
  const f = failState(id, { card, center, now });
  const earlier = !f.now && f.today ? `；今天早些时候失败过 ${f.today} 次，后来好了` : '';
  if (paused) return { key: 'paused', label: '暂停', text: `已暂停：定时工作先不做${waiting ? `；${waiting} 件等你` : ''}` };
  const busy = running.length ? null : J.latest({ member: id, state: 'running' }); // 账上在做的（任务卡、操作）：和任务页同一件
  if (busy) return { key: 'running', label: '现在在做', text: `正在${/^[#A-Za-z0-9]/.test(busy.title) ? ' ' : ''}${busy.title || busy.kind}`, since: busy.started_at || busy.updated_at };
  if (running.length) { const r = running[0]; return { key: 'running', label: '现在在做', text: `正在${/^[#A-Za-z0-9]/.test(r.title) ? ' ' : ''}${r.title}${r.step && r.kind !== 'job' ? ` · ${r.step}` : ''}`, since: r.since }; }
  if (waiting) return { key: 'waiting', label: waiting > 1 ? `等你 ${waiting}` : '等你', text: first ? headline(first) : `${waiting} 件等你` };
  // 原因没留下来（L2，主会话实测：卡上写「等你：原因没记下来」）：不是等你做什么，照实说没留下原因，附上这一次的日志。
  if (f.now) return { key: 'error', label: '出错', text: `${f.reason ? `失败：${f.reason}` : `${f.title ? `「${f.title}」` : '最近一次'}没做成，没留下原因`}${f.today > 1 ? `（今天失败 ${f.today} 次）` : ''}`, ...(f.reason ? {} : { log: { label: '看日志', href: `#stream?flow=${id}` } }) };
  return { key: 'idle', label: '空闲', text: `${card.now || '空闲'}${earlier}` };
}

// Radar 上一次真的找过岗位是什么时候（lib/discover-fresh.mjs）：团队卡和成员页头上各一行；超过一天没找就直说（10-10 负责人：
// 4 天没找新岗位，卡上只写着 10-06 那次「扫真人帖没跑成」）。别的成员没有这一行。
function foundOf(id, now) {
  if (id !== 'scout') return {};
  try { return { found: discoverLine({ now }) }; } catch (e) { noteSwallowed('crew-desk.found', e, { member: 'scout', doing: '看上次找岗位是什么时候', then: '卡上先不写这一行' }); return {}; }
}
// 六张卡（团队页）。等你的件数 = 算在这位名下的信（lib/team.mjs teamView 的 letters）+ 等你、卡住但还没成信的交办任务。
// 等你的事只有一份（2026-09-30）：lib/hq.mjs hqView 的 waiting（按成员分的卡点信，和右侧面板的灯、「你」的收件箱同一份）。
// 传了 hq 就只看它：团队卡片的角标、成员页的「等你」、右侧面板的工位卡片说的是同几件事。没传（老调用、测试）照旧自己数。
// 成员的「等你」= 任务板上等你 / 卡住的卡（终审、还投吗……，QA E6）+ hq 按成员分的信（去掉卡上已经有的那几封）。
// 两处说的是同几件事：卡片是那件事本身，信是它在收件箱里的样子。
// 落在某条线索上、由交办任务问的信（hq 的 scope: lead，指挥台那一行的「现在」一格）也算这位等你的事：任务板上它是这位那一栏的一张卡，
// 收件箱里是这位发的信（QA 第 2 轮复核 13：Reacher 的 #10 核实联系入口，看板、收件箱都有，团队卡和成员页却说没有等你的事）。
// 卡上已经有的（卡上记着的信，或者卡指向的那件交办任务的信）不再算一件。
// 成员的「等你」= 收件箱里算在这位名下的那几件（lib/hq.mjs waiting[id].ids，和收件箱同一张单子；rebuild7/one-source）。
// 一件在任务板上有卡（卡上记着这封信、或者卡指向的交办任务问的就是它）就画成那张卡，别的画成信。
// 任务板上等你、却没进收件箱的卡不算（等你的事只在收件箱一处）；卡住了的卡照旧列在「没做成」里，不算等你。
export function mergedWaiting(id, hq, tasks, jobs = []) {
  const ids = hq?.waiting?.[id]?.ids || [], want = new Set(ids);
  const jobAsk = (aid, j) => aid === `job:${j}` || aid.startsWith(`need:job:${j}:`);
  const asksOf = t => ids.filter(aid => aid === t.ask_id || (t.job_id && jobAsk(aid, t.job_id)));
  const cards = tasks.waiting.filter(t => t.kind === 'card' && t.type !== '卡住了' && asksOf(t).length);
  const stuck = tasks.waiting.filter(t => t.kind === 'card' && t.type === '卡住了');
  const covered = new Set(cards.flatMap(asksOf));
  return [...cards, ...hqWaiting(id, hq, jobs).filter(w => want.has(w.ask_id) && !covered.has(w.ask_id)), ...stuck];
}
// 等你的那件事的一句短标题（10-01：团队卡片和 Radar 页上是执行器的原话，两三行、被截断，「等你」说了四遍）。
// 和任务页同一句（C 线 lib/short-title.mjs、lib/needs.mjs needShort）：执行器写了 need.title 就用它，没写的从原话里推；
// 原话放在 full 里，页面上点「全文」看。
export const headline = (text, max = 22) => shortTitle(String(text || ''), { max, ask: true }) || '';
const jobNeedTitle = j => { const n = (j.needs || []).find(x => x.kind !== 'login') || (j.needs || [])[0]; return n ? needShort(n) : headline(typeof j.waiting_user === 'string' ? j.waiting_user : j.waiting_user?.question || j.required_action || j.details); };
// 卡片和横幅上那一行：任务板的卡说要你做什么（need 的短标题），不说卡本身是什么事。
const waitLine = w => !w ? '' : ((w.kind === 'card' || w.job) && w.ask) || w.title || '';
export function hqWaiting(id, hq, jobs = []) {
  const w = hq?.waiting?.[id];
  const ids = w ? w.ids || [w.id] : [];
  if (!ids.length) return [];
  const byJob = new Map(lastRev(jobs).map(j => [`job:${j.id}`, j]));
  return ids.map(aid => {
    const a = hq.asks?.[aid] || {}, full = a.question || a.line || w?.title || '', job = byJob.get(aid) || byJob.get(`job:${/^need:job:([^:]+):/.exec(aid)?.[1] || ''}`);
    const title = a.need_title || (job ? jobNeedTitle(job) : '') || headline(a.line || full) || a.title || '';
    // 交办任务落在某条线索上（还没同步成卡）：和卡一样，标题写「#10 Fabrikam · 核实联系入口」，下面一行写要你做什么。
    if (job && (job.number != null || job.company)) return { kind: 'ask', job: true, title: jobTitle(job), ask: title, ...(full && full.replace(/[。.]$/, '') !== title ? { full } : {}), href: href.inbox(aid), ask_id: aid, type: '等你' };
    return { kind: 'ask', title, ...(full && full.replace(/[。.]$/, '') !== title ? { full } : {}), href: href.inbox(aid), ask_id: aid, type: '等你' };
  });
}
export function deskList(center = {}, inbox = {}, { now = Date.now(), jobs = cachedLines('state/host-jobs.ndjson'), team = null, hq = null } = {}) {
  const T0 = team || teamView(center, inbox, { now, jobs }), Q = queueState(), held = busyLine(center);
  return CREW_IDS.map(id => {
    const card = T0.workers.find(w => w.key === id) || {}, m = crewMember(id);
    const tasks = tasksOf(id, { center, inbox, detail: {}, now, jobs });
    const mine = hq ? mergedWaiting(id, hq, tasks, jobs) : null;
    // 卡住了的（没做成）不算等你：你什么也做不了，它在「出错」那一句里说（L2）。
    const yours = (mine || tasks.waiting).filter(youDo);
    // 等你几件：收件箱里算在这位名下的件数（lib/tally.mjs 的口径），不在这里另数。
    const paused = agentPaused(id), waiting = hq ? hq.waiting?.[id]?.count || 0 : (card.letters || 0) + yours.length;
    const firstWait = waitLine(mine ? yours[0] : card.letters ? null : yours[0]);
    const status = statusOf(id, { card, running: tasks.running, waiting, first: firstWait, paused, center, now });
    const round = opRow(`round-${id}`, { center, caps: capabilities(id), now, held, Q });
    return { key: id, name: m.name, face: m.face, title: m.title, group: m.group_label, duty: m.duty, plain: m.plain, status, ...foundOf(id, now), waiting, wait_title: firstWait ? headline(firstWait) : '', triage: card.triage || 0, paused, running: tasks.running.length > 0, stats: card.stats || [],
      round };
  });
}

// 点开一位（成员页和面板那一栏）。
export function deskView(id, center = {}, inbox = {}, { now = Date.now(), jobs = cachedLines('state/host-jobs.ndjson'), events = null, caps = null, hq = null } = {}) {
  if (!isMember(id)) throw Error('没有这位成员');
  const detail = workerDetail(id, center, inbox, { now, ...(events ? { events } : {}), tally: hq?.tally || null });
  const m = crewMember(id), C = caps || capabilities(id);
  const card = { state: detail.state, now: detail.now };
  const tasks = tasksOf(id, { center, inbox, detail, now, jobs });
  if (hq) tasks.waiting = mergedWaiting(id, hq, tasks, jobs);
  const paused = agentPaused(id), asked = tasks.waiting.filter(t => t.kind !== 'triage' && youDo(t)), waitN = hq ? hq.waiting?.[id]?.count || 0 : asked.length;
  const groups = opGroups(id, { center, caps: C, now, events: detail.events || [] });
  const byKey = new Map(groups.flatMap(g => g.ops.map(o => [o.key, o])));
  return {
    ...detail, key: id, name: m.name, face: m.face, title: m.title, group: m.group_label, duty: m.duty, plain: m.plain, skills: m.skills.map(s => ({ id: s, label: SKILL_LABEL[s] || s })),
    paused, status: statusOf(id, { card, running: tasks.running, waiting: waitN, first: waitLine(asked[0]), paused, center, now }), ...foundOf(id, now), waiting: waitN,
    caps: { model: C.model, judge: C.judge, executor: C.executor, sandbox: C.sandbox },
    groups, main: (MAIN_OPS[id] || []).map(k => byKey.get(k)).filter(Boolean).slice(0, 4), links: LINKS[id] || [],
    ...(id === 'scout' ? { contacts: sourceContacts() } : {}),
    tasks, log: { rows: (detail.events || []).slice(0, 10), href: `#stream?flow=${id}` },
    running_op: runningOp(center, id), busy_line: busyLine(center), mail_line: id === 'owl' ? mailLine(byKey) : null,
    // 做了什么（lib/member-done.mjs）：做出来的东西和运行日志里的运行，定时跑的也在（10-03 只剩任务卡以后成员页是空的）。
    done: memberDone(id, { now, center, ...(events ? { events } : {}) }),
  };
}
// Watcher 成员页顶上那一行（0.1.4）：Mac 版没接邮箱时，收件箱巡检跑不了、这一轮也读不了信——一行说没读、带「接上邮箱」。
// 最近一轮正是因此没读的写那一轮的结果，否则写巡检跑不了的原因。接上以后不出现。
function mailLine(byKey) {
  const poll = byKey.get('mail-poll'), round = byKey.get('round-owl');
  if (!poll || poll.can_run || !poll.go || mailState().connected) return null;
  const last = round?.last?.go?.href === poll.go.href ? round.last.text : null;
  return { text: last || poll.why_not, go: poll.go };
}
// 操作台上没有在跑的、可写锁被别的进程拿着（App 定时起的周期、本机 AI）：成员页、团队页按钮旁边留这一行，锁放开了就没了（页面跟着定时刷新）。
// 这时点了照样排到后面（runOrQueue）。有一项在跑时那一行是 running_op 的，这里不给。
export const BUSY_LINE = '这一轮还在跑';
export function busyLine(center = {}) {
  if (center.ops?.current) return null;
  return lockHeld() ? BUSY_LINE : null;
}

// 现在在跑的那一项（一次只跑一个）：团队页顶上、成员页「能做的事」第一行都写它。
export function runningOp(center = {}, id = null) {
  const c = center.ops?.current;
  if (!c) return null;
  const member = opMember(c.op);
  return { op: c.op, label: c.label, member, name: crewMember(member).name, mine: member === id, started_at: c.started_at };
}
// 「▶ 运行」：只收这位名下的操作；要模型的先查一遍。
export function runMemberOp(id, op, { caps = null, run = runOp, agent = agentAction, record_id = null, url = null } = {}) {
  if (!isMember(id)) throw Error('没有这位成员');
  if (!OPS[op] || (OPS[op].role || 'patch') !== id) throw Error(`${crewMember(id).name} 没有这一项`);
  const gate = memberGate(op, caps || capabilities(id));
  if (!gate.ok) throw Error(`「${opLabel(op)}」${['model', 'some'].includes(OP_NEEDS[opFor(op)]) ? '要模型，' : ''}现在跑不了：${gate.why}`);
  const pre = newOpCard(id, op);
  const C = caps || null, go = (o, x = {}) => runOrQueue(o, { ...x, member: id, caps: C, run, ...(pre ? { card_id: pre.id } : {}) });
  if (op === `round-${id}`) { const a = agent(id, 'run', { run: go }); if (!a?.queued) cardForOp(id, op, a?.op || a, pre); return a; }
  const r = go(op, { ...(record_id ? {record_id} : {}), ...(url ? {url} : {}) });
  if (r.queued) return { ok: true, op: r, queued: true, receipt: queuedReceipt(r) };
  if (r.already) return { ok: true, op: null, receipt: `「${opLabel(op)}」正在跑` };
  const card = cardForOp(id, op, r, pre);
  return { ok: true, op: r, ...(card ? { card: card.id } : {}), receipt: `已开始「${opLabel(op)}」${gate.why ? `；${gate.why}` : ''}` };
}
const queuedReceipt = r => `「${r.label}」${r.dup ? '已经排着了，' : ''}${QUEUED_LINE}${r.ahead ? `（前面还有 ${r.ahead} 个）` : ''}`;
function cardForOp(id, op, rec, pre = null) {
  if (!rec?.id || rec.queued || /^q-/.test(rec.id)) return null; // 排上的（q- 是排队 id）：卡由 runOrQueue 开，用 queue_id 指着
  try {
    const c = pre || newOpCard(id, op);
    if (!c) return null;
    c.links = { ...(c.links || {}), op, op_id: rec.id };
    if (rec.label && !pre) c.title = LABEL[op] || OPS[op]?.label || rec.label;
    c.status = rec.status === 'ok' ? 'done' : 'running'; c.started_at = c.created_at;
    saveCards([c]);
    return c;
  } catch (e) { noteSwallowed('crew-desk.cardForOp', e, { member: id, doing: `把「${LABEL[op] || op}」这次运行记到任务卡上`, then: '这次照常跑，任务页上没有这张卡' }); return null; }
}
