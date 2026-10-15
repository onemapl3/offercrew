// 线索状态机（2026-09-22；第 2 步收口 10-04）。一份状态枚举、一张转移表、一个入口 applyEvent。
// 队列和状态机共存：「处理中」本身是状态（decide_* 先进 *_pending，队列确认后 decision_applied 落到终态）。
//
// 一条线索的状态只有三样（契约 05 2.1）：
//   state       生命周期，只经 applyEvent 改（落库经 lib/leads.mjs，不合法的转移报错）；
//   auto_apply  投递子状态（库里的 apply 列）。改它用 setApply：status 变了，同时按 APPLY_EVENT 走一次转移，两样不会对不上；
//   judgement / match  Judge 的判断。
// 旧字段 stage、feedback、previous_stage 不再写（lib/leads.mjs 升级时把它们收进 legacy_fields 留底）。
// 读的一侧用 leadState(lead)：有 state 就是它；只有旧库导进来、还没升级的那种（没有 state）才按旧字段推导。
// 判断「结束了没有、pass 了没有」用下面的几个小函数，不再看阶段文字。
import { delivered } from './delivery.mjs';
// 岗位本身是否关闭，和投递/往来生命周期分开。官网的新鲜结果优先于旧 JD 的判断。
export const postingClosed = (l = {}) => typeof l?.posting_closed === 'boolean' ? l.posting_closed : l?.prefilter_reason === 'posting_closed' || l?.judgement?.posting?.still_open === false;
export const STATES = {
  new: '新线索', contact_pending: '处理中 · 联系', pass_pending: '不投了', passed: '不投了',
  contacting: '准备联系', outreach_ready: '材料待确认', sending: '发送中', contacted: '已联系',
  apply_review: '待确认投递', apply_paused: '投递已暂停', apply_queued: '待投递', applying: '投递中', apply_needs_user: '需本人投递', applied: '已投递',
  replied: '已回复', interview_scheduled: '面试已安排', interview_done: '面试完成 · 等结果',
  offer: 'Offer', rejected: '已拒绝', archived: '已归档',
};
// 8 色组：给行上的色条 / 标签用（web/style.css .st-*）。
export const STATE_GROUP = {
  new: 'new', contact_pending: 'new', pass_pending: 'closed', passed: 'closed',
  contacting: 'contacted', outreach_ready: 'contacted', sending: 'contacted', contacted: 'contacted',
  apply_review: 'applied', apply_paused: 'applied', apply_queued: 'applied', applying: 'applied', apply_needs_user: 'applied', applied: 'applied',
  replied: 'replied', interview_scheduled: 'interviewing', interview_done: 'interviewing',
  offer: 'offer', rejected: 'rejected', archived: 'closed',
};
const ANY = '*';
const APPLYING = new Set(['apply_review', 'apply_paused', 'apply_queued', 'applying', 'apply_needs_user']);
// event → { from: [states] | '*', to: state | (lead, payload) => state }
export const TRANSITIONS = {
  decide_contact: { from: ['new', 'passed', 'pass_pending', 'contact_pending'], to: 'contact_pending' },
  decide_pass: { from: ANY, guard: s => !['offer', 'archived'].includes(s), to: 'pass_pending' },
  decision_applied: { from: ['contact_pending', 'pass_pending'], to: s => s === 'pass_pending' ? 'passed' : 'contacting' },
  draft_ready: { from: ['contacting', 'contact_pending', 'new'], to: 'outreach_ready' },
  send_queued: { from: ['outreach_ready', 'contacting'], to: 'sending' },
  sent: { from: ANY, to: 'contacted' },
  apply_approved: { from: ANY, guard: s => !['offer', 'archived', 'rejected'].includes(s), to: 'apply_queued' },
  // apply_review 也能开始提交：终审确认过的那一版（awaiting_final_review → submitting，lib/auto-apply.mjs）。以前这一步被转移表拒了、
  // 只靠旧推导把状态拽到「投递中」；状态只按表走以后要写进表里。
  apply_started: { from: ['apply_queued', 'apply_needs_user', 'applying', 'apply_review'], to: 'applying' },
  apply_needs_user: { from: ANY, to: 'apply_needs_user' },
  apply_review: { from: ANY, to: 'apply_review' },
  apply_paused: { from: ANY, to: 'apply_paused' },
  apply_submitted: { from: ANY, to: 'applied' },
  owner_submission_corrected: { from: ['applied'], to: 'apply_needs_user' },
  // 批准收起来了（不在方向里、公司排除、资深岗规则，lib/inbox-recheck.mjs、lib/runtime-recovery.mjs 把 auto_apply 记成 closed）：
  // 投递那一支退回「新线索」，等你再定；本来就不在投递那一支（已 pass、已归档……）的不动。
  apply_withdrawn: { from: ANY, to: s => APPLYING.has(s) ? 'new' : s },
  // 跟进（「N 跟进」）：只记一笔，不改状态（以前写 feedback = '跟进'）。
  follow_up: { from: ANY, to: s => s },
  reply: { from: ANY, to: (s, p) => p?.category === '面试邀约' ? 'interview_scheduled' : p?.category === '拒绝' ? 'rejected' : 'replied' },
  interview_scheduled: { from: ANY, to: 'interview_scheduled' },
  interview_completed: { from: ANY, to: 'interview_done' },
  offer: { from: ANY, to: 'offer' },
  reject: { from: ANY, to: 'rejected' },
  archive: { from: ANY, to: 'archived' },
  reopen: { from: ['passed', 'pass_pending', 'archived', 'rejected'], to: 'new' },
  note: { from: ANY, to: s => s },
};
// 旧字段 → 状态（没有 lead.state 的存量线索，也是导进数据库时的映射，lib/leads.mjs）。映射表是数据：从上往下，第一条对上的算。
//   stage：阶段文字里含这个；feedback：用户反馈等于它；apply：auto_apply.status 是其中之一；has：这条线索有这个字段；
//   delivered：发出过对应的回执（ats_form/portal 算投递，任何渠道算联系）；request：有处在这些状态的发送请求。
export const LEGACY_STATE_MAP = [
  { state: 'offer', stage: /Offer/i, has: 'offer_at' },
  { state: 'archived', stage: /归档/ },
  { state: 'rejected', stage: /拒绝/ },
  { state: 'passed', feedback: 'pass', stage: /已排除/ },
  { state: 'interview_done', has: 'interview_completed_at' },
  { state: 'interview_scheduled', has: 'interview_at', stage: /面试/ },
  { state: 'replied', has: 'replied_at', stage: /回复/ },
  { state: 'applied', apply: ['submitted'], stage: /已投递/, delivered: 'apply' },
  { state: 'apply_review', apply: ['awaiting_batch_review'] },
  { state: 'apply_paused', apply: ['paused'] },
  { state: 'apply_needs_user', apply: ['needs_login', 'failed', 'prepared_for_user'] },
  { state: 'applying', apply: ['submitting', 'uncertain'] },
  { state: 'apply_queued', apply: ['approved', 'queued', 'pending'] },
  { state: 'contacted', stage: /已联系/, delivered: 'any' },
  { state: 'sending', request: ['queued', 'dispatched', 'uncertain'] },
  { state: 'outreach_ready', request: ['needs_review', 'failed', 'sent'], stage: /材料就绪/ },
  { state: 'contacting', feedback: '联系', stage: /准备联系/ },
];
// 旧字段：不再写，升级时收进 legacy_fields（lib/leads.mjs upgradeShape）。
export const LEGACY_FIELDS = ['stage', 'feedback', 'previous_stage'];
export function deriveState(l = {}, { outbound = [], requests = [] } = {}) {
  const id = l.record_id || l.id, stage = l.stage || '', a = l.auto_apply?.status;
  const hit = r => (r.stage && r.stage.test(stage)) || (r.feedback && l.feedback === r.feedback) || (r.has && l[r.has]) || (r.apply && r.apply.includes(a))
    || (r.delivered === 'apply' && outbound.some(o => o.record_id === id && /ats_form|portal/.test(o.channel || '') && delivered(o, l)))
    || (r.delivered === 'any' && outbound.some(o => o.record_id === id))
    || (r.request && requests.some(q => q.record_id === id && r.request.includes(q.status)));
  return LEGACY_STATE_MAP.find(hit)?.state || 'new';
}
// 现在的状态：记下的 state。没有 state 的（旧库导进来还没升级、测试里手搭的旧样子）才按旧字段推导。
export function leadState(l = {}, ctx = {}) {
  return l && STATES[l.state] ? l.state : deriveState(l || {}, ctx);
}
// 升级前那套推法：记下的 state 和旧字段、回执、发送请求推出来的放在一起比，更靠后的算数。
// 只给升级用（lib/leads.mjs upgradeShape）：把那时页面上看到的状态定成记下的 state，以后只按转移表走。
const RANK = { new: 0, contacting: 1, outreach_ready: 2, sending: 3, contacted: 4, apply_review: 2, apply_paused: 2, apply_queued: 2, applying: 3, apply_needs_user: 2, applied: 4, replied: 6, interview_scheduled: 7, interview_done: 8, offer: 10, rejected: 10, archived: 10, passed: 10 };
export function legacyLeadState(l = {}, ctx = {}) {
  const observed = deriveState(l, ctx);
  if (!l.state || !STATES[l.state]) return observed;
  if (['contact_pending', 'pass_pending', 'offer', 'archived', 'rejected', 'passed'].includes(l.state)) return l.state;
  if (l.auto_apply && /^(apply_|applying)/.test(observed) && /^(apply_|applying)/.test(l.state)) return observed;
  if ((RANK[observed] ?? 0) > (RANK[l.state] ?? 0)) return observed;
  return l.state;
}
// 页面上看的状态（视图层，lib/command-center.mjs、lib/workflow.mjs、lib/dashboard.mjs）：还在联系那一支上的线索，
// 草稿批准了、发送请求排着的显示「发送中」，被退回的显示「材料待确认」。草稿和发送各有各的记录（草稿、动作），
// 不再往线索的 state 里抄一份；这里只是给人看时把两样放在一起。
const OUTREACH = new Set(['new', 'contact_pending', 'contacting', 'outreach_ready', 'sending']);
export function viewState(l = {}, { requests = [] } = {}) {
  const s = leadState(l), id = l.record_id || l.id;
  if (!OUTREACH.has(s) || !requests.length) return s;
  const mine = requests.filter(q => q.record_id === id);
  if (mine.some(q => ['queued', 'dispatched', 'uncertain'].includes(q.status))) return 'sending';
  if (mine.some(q => ['needs_review', 'failed', 'sent'].includes(q.status))) return 'outreach_ready';
  return s;
}
export const stateLabel = s => STATES[s] || s;
export const stateGroup = s => STATE_GROUP[s] || 'new';
// 给人看的那一格「阶段」（接口里还叫 stage 的那几处：线索详情、看板、对话里引用的岗位）。只从 state 来。
export const stageText = l => stateLabel(leadState(l));
// 同上，接口里还叫 feedback 的那一格（你对这条说过什么）：pass、联系、跟进，或者 null。只从 state 来。
export const feedbackText = l => { const s = leadState(l); return PASSED.has(s) ? 'pass' : CONTACT.has(s) ? '联系' : l?.follow_up_at ? '跟进' : null; };

// ── 读：结束了没有、pass 了没有（以前看 stage 的阶段文字和 feedback）────────────────────────
export const PASSED = new Set(['passed', 'pass_pending']);
// 你结束了、或者这条走完了：pass、归档、被拒、Offer（以前 /归档|已排除|拒绝|Offer/.test(stage) 或 feedback === 'pass'）。
export const ENDED = new Set(['passed', 'pass_pending', 'archived', 'rejected', 'offer']);
// 你说过「联系」、还在联系那一支上（以前 feedback === '联系'，它一直留到回复以后；这里到「已联系」为止）。
export const CONTACT = new Set(['contact_pending', 'contacting', 'outreach_ready', 'sending', 'contacted']);
export const passedLead = l => PASSED.has(leadState(l));
export const archivedLead = l => leadState(l) === 'archived';
export const endedLead = l => ENDED.has(leadState(l));
export const contactLead = l => CONTACT.has(leadState(l));
// 投过了：状态是已投递，或者投递子状态记着提交了（回复、面试以后状态往前走了，投递子状态还在）。
export const appliedLead = l => leadState(l) === 'applied' || l?.auto_apply?.status === 'submitted';
// 你对这条做过决定（以前 !!feedback）：联系、pass、投都算；还是「新线索」就是没定。
export const decidedLead = l => leadState(l) !== 'new';
// 你说过「联系」或「pass」（以前 feedback 有值；「投」不记在 feedback 上，投递那一支不算）。
export const saidLead = l => { const s = leadState(l); return PASSED.has(s) || CONTACT.has(s); };
// 你自己结束了的线索（pass / 归档）。批准过、还没发出去的发送不再发出（bin/send-dm.mjs、lib/mail/send.mjs）。
export const closedByUser = l => ['passed', 'pass_pending', 'archived'].includes(leadState(l));

export function canApply(l, event) {
  const t = TRANSITIONS[event]; if (!t) return { ok: false, reason: `unknown_event:${event}` };
  const from = leadState(l);
  if (t.from !== ANY && !t.from.includes(from)) return { ok: false, reason: `invalid_transition:${from}->${event}`, from };
  if (t.guard && !t.guard(from)) return { ok: false, reason: `guarded:${from}->${event}`, from };
  return { ok: true, from };
}
// 原地修改 lead，返回 { ok, from, to, reason }。strict 时不合法的转移抛错；不 strict 时不改，调用方看 ok。
// 只写 state、state_at、history；旧字段 stage / feedback 不再同步（lib/leads.mjs 落库时也不收它们）。
export function applyEvent(l, event, payload = {}, { at = new Date().toISOString(), source = 'system', strict = false } = {}) {
  const check = canApply(l, event);
  if (!check.ok) { if (strict) throw Error(check.reason); return { ...check, to: leadState(l) }; }
  const t = TRANSITIONS[event];
  const to = typeof t.to === 'function' ? t.to(check.from, payload) : t.to;
  l.state = to; l.state_at = at;
  l.history = [...(l.history || []).slice(-49), { at, event, from: check.from, to, source, ...(payload.note ? { note: String(payload.note).slice(0, 200) } : {}), ...(payload.category ? { category: payload.category } : {}) }];
  if (to === 'offer' && !l.offer_at) l.offer_at = at;
  if (to === 'archived' && !l.archived_at) l.archived_at = at;
  return { ok: true, from: check.from, to };
}

// ── 投递子状态 ───────────────────────────────────────────────────────────────
// auto_apply.status → 状态要走的那一步（数据，不是分支）。没列的（cancelled、withdrawn、not_started 这类）只改子状态，不走转移。
export const APPLY_EVENT = {
  approved: 'apply_approved', queued: 'apply_approved', pending: 'apply_approved',
  awaiting_batch_review: 'apply_review', awaiting_final_review: 'apply_review',
  paused: 'apply_paused',
  needs_login: 'apply_needs_user', failed: 'apply_needs_user', prepared_for_user: 'apply_needs_user', waiting_user: 'apply_needs_user',
  submitting: 'apply_started', uncertain: 'apply_started',
  submitted: 'apply_submitted',
  closed: 'apply_withdrawn',
};
// 改投递子状态的唯一写法：next 是整份新的 auto_apply（或者 (old) => new）。status 变了就按 APPLY_EVENT 走一次转移（strict：
// 走不通直接报错，说明调用方在一条不该投的线索上改投递）。status 没变只改子状态里的别的字段。返回 applyEvent 的结果或 null。
export function setApply(l, next, { at = new Date().toISOString(), source = 'system', note = null } = {}) {
  const was = l.auto_apply?.status ?? null;
  const value = typeof next === 'function' ? next(l.auto_apply || {}) : next;
  l.auto_apply = value;
  const now = value?.status ?? null, ev = APPLY_EVENT[now];
  if (now === was || !ev) return null;
  return applyEvent(l, ev, note ? { note } : {}, { at, source, strict: true });
}
