// 状态词（线 S，契约 2.6）：一件活的状态 → 给人看的词和色调，全系统只有这一张表。
// 页面和手机不再自带「状态 → 词」的对照表：服务端每个视图直接带 { state, word, tone, reason }（view()）。
// 用户看得到的只有这几种：没有（没有这一行）、排队中、进行中、做完了（「没有新的」也算，结果写清）、
// 失败（一定带一句人话原因）、等你（写清要你做什么）、已取消。
// 色调就是页面上小标的样式名（web 的 .tb-st.is-<tone>，手机的 .st.t-<tone>）。

import { TZ } from './tz.mjs';
import { cleanReason } from './wait-reason.mjs';

export const STATES = ['queued', 'running', 'done', 'failed', 'waiting_you', 'cancelled'];
export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
export const ACTIVE = new Set(['queued', 'running']);

export const STATE = {
  none: { word: '没有', tone: 'mute' },
  queued: { word: '排队中', tone: 'queued' },
  running: { word: '进行中', tone: 'run' },
  done: { word: '做完了', tone: 'done' },
  failed: { word: '失败', tone: 'bad' },
  waiting_you: { word: '等你', tone: 'you' },
  cancelled: { word: '已取消', tone: 'cancel' },
};
export const wordOf = state => (STATE[state] || STATE.none).word;
export const toneOf = state => (STATE[state] || STATE.none).tone;

// 一件活 → 给视图的那一份。job 可以是 lib/jobs.mjs 的一行，也可以是 { state, reason, result, what }；没有 → 「没有」。
//   reason：失败时是原因，等你时是要你做什么，做完时是结果那一句（result.summary），别的没有。
export function view(job, { now } = {}) {
  if (!job || !STATE[job.state]) return { state: 'none', word: STATE.none.word, tone: STATE.none.tone, reason: null };
  const s = job.state, r = job.result && typeof job.result === 'object' ? job.result : null;
  const reason = s === 'queued' && job.not_before && Date.parse(job.not_before) > (now ?? Date.now()) ? `${whenText(job.not_before, now)}${/^send_/.test(job.kind || '') ? '发' : '开始'}`
    : s === 'failed' ? cleanReason(job.reason) || null // 没有原因就不写原因，不拿兜底词充数（lib/wait-reason.mjs）
    : s === 'waiting_you' ? job.what?.label || job.reason || null
    : s === 'done' ? r?.summary || null
    : null;
  const partial = s === 'done' && r?.counts?.partial === true;
  return { state: s, word: partial ? '部分完成' : STATE[s].word, tone: partial ? 'wait' : STATE[s].tone, reason, ...(s === 'waiting_you' && job.what ? { what: job.what } : {}) };
}
// 到点时间说成人话（本地时区，lib/tz.mjs）：「早上 9:00」「明天早上 9:00」「10月6日 下午 2:30」。
const PART = [[5, '凌晨'], [10, '早上'], [12, '上午'], [13, '中午'], [18, '下午'], [24, '晚上']];
export function whenText(t, now = Date.now(), tz = TZ) {
  const at = new Date(t), f = o => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format;
  const day = f({ year: 'numeric', month: '2-digit', day: '2-digit' }), hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const [h, m] = hm.split(':').map(Number), part = PART.find(([end]) => h < end)[1], h12 = h > 12 && part !== '中午' ? h - 12 : h;
  const d0 = day(now), d1 = day(at), tomorrow = day(new Date(now).getTime() + 86400000);
  const head = d1 === d0 ? '' : d1 === tomorrow ? '明天' : `${Number(d1.slice(5, 7))}月${Number(d1.slice(8, 10))}日 `;
  return `${head}${part} ${h12}:${String(m).padStart(2, '0')} `;
}
// 一句完整的话（卡片、通知、手机上一行用）：失败带原因，等你带要你做的事，做完带结果。
export function line(job, opts) {
  const v = view(job, opts);
  if (!v.reason) return v.word;
  if (v.state === 'failed') return `失败：${v.reason}`;
  if (v.state === 'waiting_you') return `等你：${v.reason}`;
  return v.reason;
}
// 一组活的计数（任务页顶上那排数字）：六种各几件。
export function counts(jobs = []) {
  const out = Object.fromEntries(STATES.map(s => [s, 0]));
  for (const j of jobs) if (out[j?.state] != null) out[j.state] += 1;
  return out;
}

// ── 旧写法 → 六种（只给迁移和接线过渡用）────────────────────────────────────────
// 旧代码里同一个意思有好多写法（done / completed / finished / ok、waiting_user / needs_you、blocked / stuck / fail……）。
// 认这一张表；认不出的返回 null（调用方决定，不猜）。
const LEGACY = {
  queued: 'queued', pending: 'queued', unclaimed: 'queued', waiting: 'queued', planned: 'queued', approved: 'queued',
  running: 'running', working: 'running', started: 'running', start: 'running', dispatched: 'running', sending: 'running', claimed: 'running',
  done: 'done', completed: 'done', finished: 'done', ok: 'done', sent: 'done', skip: 'done', no_change: 'done',
  failed: 'failed', fail: 'failed', error: 'failed', blocked: 'failed', stuck: 'failed', lost: 'failed', dropped_failed: 'failed', degraded: 'failed',
  waiting_you: 'waiting_you', waiting_user: 'waiting_you', needs_you: 'waiting_you', needs_review: 'waiting_you', needs_login: 'waiting_you', awaiting_final_review: 'waiting_you',
  cancelled: 'cancelled', canceled: 'cancelled', dropped: 'cancelled', withdrawn: 'cancelled', skipped: 'cancelled',
  // 周期一步的结果（bin/cycle.mjs results 的 status）：有更新、准备好了是做完了；超时、预算用完停下是失败。
  changed: 'done', prepared: 'done', budget_exceeded: 'failed', timeout: 'failed',
  // 投递执行（线索上的 auto_apply.status，还没进账的老记录）：提交了是做完了，在填是进行中，停下等你看页面、审材料、核实结果是等你。
  submitted: 'done', submitting: 'running', awaiting_batch_review: 'waiting_you', prepared_for_user: 'waiting_you', uncertain: 'waiting_you', paused: 'waiting_you',
};
export const fromLegacy = s => LEGACY[String(s ?? '').trim()] || null;
// 旧写法的词（运行记录、交给这台电脑的事、自动修复、上一轮各步的结果这些还没进账的历史行用）：认得的给六种的词和色调，认不得的 null。
export const legacyChip = s => { const st = fromLegacy(s); return st ? { state: st, word: STATE[st].word, tone: STATE[st].tone } : null; };
// 页面行上只有色调（bad / wait / work / ok / mute，收件箱「进行中」那几行）：认成六种之一，词从上面那张表拿。
export const STATE_OF_TONE = { bad: 'failed', wait: 'waiting_you', work: 'running', ok: 'done', mute: 'cancelled' };
// 卡、子任务、对话小条上的小标：有账上的 state（lib/task-ledger.mjs overlay 盖上的）就用它，没有就认旧状态码。页面只用 word、tone。
export const chipOf = x => { const s = STATE[x?.state] && x.state !== 'none' ? x.state : fromLegacy(x?.status) || 'none'; return { state: s, word: STATE[s].word, tone: STATE[s].tone }; };

// ── 收件箱四档（负责人 10-04「系统通知要用不同的颜色去提示」）────────────────────────
//   block  挡路：不处理，有活就停在那儿（要你登录、批准了的邮件发不出去、花费上限、扫描暂停、卡住的活）；
//   reply  等你回：有人在等你（对方回复、面试邀约、BOSS / 脉脉 / LinkedIn 新消息）；
//   decide 要你拍板：你不点，那件事就不往下走，但别的活照跑；
//   note   知会：只是告诉你一声。
// 一封信归哪一档按它的类别（lib/hq.mjs askKind）定，一类只在一档里。tone 是页面上的样式名（.tier-<tone>）。
export const TIERS = {
  block: { rank: 0, word: '挡路', tone: 'block' },
  reply: { rank: 1, word: '等你回', tone: 'reply' },
  decide: { rank: 2, word: '要你拍板', tone: 'decide' },
  note: { rank: 3, word: '知会', tone: 'note' },
};
export const TIER_OF_KIND = {
  login: 'block', budget: 'block', paused: 'block', blocked: 'block', mailblock: 'block',
  reply: 'reply', interview: 'reply', bosschat: 'reply', maimaichat: 'reply', linkedinmsg: 'reply',
  final: 'decide', reapprove: 'decide', stale: 'decide', page: 'decide', fields: 'decide', route: 'decide', question: 'decide', goal: 'decide', skim: 'decide', stalled: 'decide', unlock: 'decide',
  draft: 'decide', apply: 'decide', followup: 'decide', triage: 'decide',
  recovered: 'note', codeguard: 'note', mailnote: 'note', applywork: 'note',
};
export const tierOfKind = kind => TIER_OF_KIND[kind] || 'decide';
export const tierView = tier => { const t = TIERS[tier] ? tier : 'decide'; return { tier: t, tier_word: TIERS[t].word, tier_rank: TIERS[t].rank }; };
