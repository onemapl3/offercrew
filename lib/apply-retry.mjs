// 投递卡「再试一次」、预填好的那一页关了「重新预填」、旧版投递卡的升级收尾（线 R，10-04 主会话实测 #444、#482）。
//
// 再试一次（任务卡、手机、收件箱的「重新预填」都走这里）：
//   1. 清掉线索上上一次的失败：次数归零、停下来那一页的记录摘掉（失败的码留着，新的批准记下时才换掉）；
//      预填好的那一页关了（closed）：线索记成「那一页关了」（page_closed），不再停在「预填好了 / 等终审」。已提交、提交中的不碰。
//   2. 这条线索上做完 / 失败 / 取消了的预填让出 idem_key，requestAction 才会另起一条（lib/actions.mjs retireDone）。
//   3. 卡那件活：失败 / 等你 → 重新排（retry），做完 / 取消 → 另起一件（again）。卡摘掉上一次的链接（apply_at、旧版的交办任务）。
//   4. 照新卡的路开跑（lib/tasks.mjs startCard → 「投 N」→ requestAction('prefill')，动作挂在卡那件活上），一键投递的识别在预填里。
//      确认：你早先批准的那一版和现在的一样（批准按岗位、入口、简历和资料认，lib/submission-policy.mjs approvalFor），点「再试一次」
//      就是按那一版再批准一次；不一样了卡「等你」，收件箱来一封带预览的「确认，开始预填」（和新卡同一条路）。
// 手机上点的：照手机的规矩，回电脑确认后才开浏览器（holdOnMac），1–3 步先做。
//
// 升级收尾（settleLegacyApplyCards，工作台启动时跑一次）：旧版没挂动作的投递卡（links.apply_at、账上那件活没有动作）——
//   这条线索账上有预填 / 提交动作：卡改跟最近那一件（followJob）；
//   从没有：按线索落定一次——已提交 → 做完；预填好了 / 等终审 → 做完（预填这一步做完了，后面是收件箱里你的那一步，和新卡一样）；
//   没做成 → 没做成（能再试一次）；等登录 / 等你一步 → 等你（那封信）；别的 → 取消，写明「旧版的投递卡，状态对不上了」。
//   以后这条线索上有了新动作（登好了接着预填、你在收件箱确认），lib/task-ledger.mjs adoptActionJobs 把它挂回这张卡。
import { lines, writeLines } from './store.mjs';
import { setApply } from './lead-state.mjs';
import * as J from './jobs.mjs';
import { retireDone, openFor, isStaleHeld, release, listActions } from './actions.mjs';
import { jobOfCard, followJob, driven, cardRef } from './task-ledger.mjs';
import { startCard, taskContext } from './tasks.mjs';
import { readCards, saveCards, addStep, holdOnMac, applied, makeCard, leadRef } from './cards.mjs';
import { leadKey } from './journey.mjs';
import { lostPage } from './application-page.mjs';
import { applicationPlan, loadFacts } from './application-form.mjs';
import { approvalFor, approvalOf, planFingerprint } from './submission-policy.mjs';
import { prefillFingerprint } from './apply-approve.mjs';
import { leadApplyWords } from './apply-words.mjs';
import { applyWaitOf } from './workers.mjs';
import { familyOf, accountKey } from './accounts.mjs';
import { lastRev } from './cards.mjs';
import { upgradeCards } from './task-upgrade.mjs';
import { clearTask } from './executor-heartbeat.mjs';

const iso = t => new Date(t ?? Date.now()).toISOString();
const err = (message, status = 409) => Object.assign(Error(message), { status });
const findLead = (leads, ref) => {
  const rid = ref?.rid || ref?.record_id;
  return leads.find(l => !l.superseded && ((rid && leadKey(l) === rid) || (!rid && ref?.number != null && l.number === Number(ref.number)))) || null;
};
const NEVER_AGAIN = new Set(['submitted', 'submitting', 'uncertain']);
const DONE_PREFILL = new Set(['prepared_for_user', 'awaiting_final_review']);

// 1. 线索上上一次的失败清掉。closed：预填好的那一页关了，线索记成 page_closed。→ { lead } 或 { lead, refuse }。
export async function reopenLead(rid, { now = Date.now(), closed = false } = {}) {
  const leads = lines('state/leads.ndjson'), l = leads.find(x => !x.superseded && leadKey(x) === rid);
  if (!l) return { lead: null };
  const a = l.auto_apply || {};
  if (applied(l) || NEVER_AGAIN.has(a.status)) return { lead: l, refuse: a.status === 'submitted' || applied(l) ? '这条已经投过了，不再投' : '上次提交的结果还没核对上，先不重来' };
  let next = null;
  if (a.status === 'failed') next = { ...a };
  else if (closed && DONE_PREFILL.has(a.status)) next = { ...a, status: 'failed', error: 'page_closed', previous_status: a.status };
  if (!next) return { lead: l };
  delete next.stop; delete next.one_click;
  setApply(l, { ...next, attempts: 0, retry_at: iso(now) }, { at: iso(now), source: 'apply-retry', note: closed ? 'page_closed' : null });
  writeLines('state/leads.ndjson', leads);
  return { lead: l };
}

// 你早先批准的那一版：还对得上现在的申请材料就是它的指纹（预填动作确认用的那个：不在方向里的带上那一句，你当时批准就是答过了），
// 对不上（或者从没批准过）是 null。
export function approvedFingerprint(l) {
  try {
    const plan = applicationPlan(l, loadFacts());
    if (!approvalFor(plan, [approvalOf(l)])) return null;
    const fp = planFingerprint(plan);
    return l.auto_apply?.approved_plan_fingerprint === fp ? prefillFingerprint(l, fp) : null;
  } catch { return null; } /* 兜底：材料算不出来（资料读不了、岗位缺字段）就当对不上：要你重新确认，不会拿旧批准直接做 */
}

const dispatchFor = origin => (t, o) => import('./dispatch.mjs').then(m => m.dispatchCommand(t, { origin, ...o }));
const RESET_LINKS = ['apply_at', 'op', 'op_id', 'queue_id', 'ask_id'];

// 任务卡上的「再试一次」（lib/task-api.mjs move → queued）。deps：taskDeps（dispatch、referrersFor、asks……）。→ 改好的卡。
export async function retryApplyCard(id, deps = {}, { now = Date.now(), phone = null, closed = false, origin = 'card' } = {}) {
  const c = readCards().find(x => x.id === id);
  if (!c) throw err('没有这张卡', 404);
  if (c.kind !== 'apply') throw err('这张卡不是投递');
  const ctx = deps.ctx || taskContext({ asks: deps.asks });
  const l0 = findLead(ctx.leads, c.leads?.[0]);
  if (!l0) throw err('这条岗位找不到了（归档或合并了）');
  const rid = leadKey(l0), target = `lead:${rid}`;
  const { lead, refuse } = await reopenLead(rid, { now, closed });
  if (refuse) throw err(refuse);
  retireDone('prefill', target, { now });
  c.links = { ...(c.links || {}) };
  // 这条线索上已经有一条开着的预填 / 提交（排着、压着等你）：不另开，卡跟它；压着的（不是批准太久的）放开。
  // 重新预填（closed）：你这一点就是重新确认。批准太久压着等你再确认的（stale）不跟——下面照新卡的路走，requestAction 按你这次确认原地刷新它（批准时间是现在）。
  const open = ['prefill', 'submit'].flatMap(k => openFor(k, target)).filter(a => !(closed && isStaleHeld(a)));
  if (open.length) {
    const last = open.at(-1);
    if (followJob(c, last.job_id) === 'other') throw err(`#${l0.number} 正在另一张卡上投`);
    // 你点了再试：上次失败的执行器阻塞不能继续压住这次。正在执行的不清；历史由 clearTask 留底。
    if (!open.some(a => a.state === 'claimed')) clearTask({ executor: 'auto-apply', task: l0.number, now });
    const held = open.filter(a => a.state === 'approved' && a.hold && !isStaleHeld(a)).map(a => a.id);
    if (held.length) release({ ids: held, now });
    addStep(c, '你放回排队', { who: 'you', at: now });
    Object.assign(c, { manual: false, auto: false, retried_at: iso(now) });
    c.links.apply_at = c.links.apply_at || iso(now);
    saveCards([c]);
    return c;
  }
  // 卡那件活：失败 / 等你 → 重新排；做完 / 取消 → 另起一件。没有的，存卡时建。
  const j = jobOfCard(c);
  if (j && ['failed', 'waiting_you'].includes(j.state)) J.drive(j.id, 'queued', { now, note: 'retry' });
  else if (j && ['done', 'cancelled'].includes(j.state)) J.again(j.id, { now });
  for (const f of RESET_LINKS) delete c.links[f];
  if (c.links.job_id) { c.links.old_job_id = c.links.job_id; delete c.links.job_id; } // 旧版的交办任务：不再跟它
  for (const f of ['confirm_wait', 'wait', 'login_label', 'need_title', 'retry', 'proof', 'go']) delete c[f];
  Object.assign(c, { status: 'queued', manual: false, auto: true, tries: 0, detail: '', result: null, done_at: null, retried_at: iso(now) });
  const fp = approvedFingerprint(lead || l0);
  if (fp) c.confirm_fp = fp; else delete c.confirm_fp;
  // 重新预填：步骤里写那一页为什么没了（和收件箱那封同一句，lib/application-page.mjs lostPage）。
  const why = closed ? lostPage(l0) : null;
  addStep(c, closed ? `你放回排队：之前预填好的那一页没了${why ? `（${why}）` : ''}，重新预填` : '你放回排队', { who: 'you', at: now });
  if (phone) { holdOnMac(c, { mac_confirm: true, ...(phone.device ? { device: phone.device } : {}) }, now); saveCards([c]); return c; }
  saveCards([c]);
  clearTask({ executor: 'auto-apply', task: l0.number, now });
  const out = await startCard({ ...c, links: { ...c.links }, steps: [...(c.steps || [])] }, { ...deps, dispatch: deps.dispatch || dispatchFor(origin) }, taskContext({ asks: deps.asks }));
  saveCards([out]);
  return out;
}

// 收件箱 / 卡上的「重新预填」（之前填好的那一页关了）：照这条岗位那张投递卡的「再试一次」做；没有卡（周期里批准、旧版留下的）就补一张
// （和收件箱批准补出来的卡一样，一件活一张卡），要你再确认这一版时卡「等你」、收件箱来一封带预览的。→ { receipt, card }。
export async function refillApply(rid, { now = Date.now(), origin = 'inbox', deps = {} } = {}) {
  const mine = c => c.kind === 'apply' && !c.legacy && c.status !== 'cancelled' && (c.leads || []).some(l => l.rid === rid);
  let card = readCards().filter(mine).sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0];
  if (!card) {
    const l = lines('state/leads.ndjson').find(x => !x.superseded && leadKey(x) === rid);
    if (!l) throw err('这条岗位找不到了（归档或合并了）');
    card = makeCard({ kind: 'apply', leads: [leadRef(l)], owner: 'quill', from: { by: 'you', via: origin === 'card' ? 'tasks' : origin }, now });
    saveCards([card]);
  }
  const c = await retryApplyCard(card.id, deps, { now, closed: true, origin });
  return { card: c, receipt: ['needs_you', 'stuck'].includes(c.status) ? c.detail : '重新预填排上了，填好停在提交前给你' };
}

// ── 升级收尾 ──────────────────────────────────────────────────────────────────
const OPEN_HOST = new Set(['pending', 'working', 'waiting_user', 'blocked']);
const askKind = code => (/^cover_letter/.test(code || '') ? 'letter' : /^unanswered/.test(code || '') ? 'info' : 'approve');
// 一张旧版投递卡按线索落定成什么（不改原来的）。
export function legacySettle(c, l) {
  const n = l?.number != null ? `#${l.number} ` : '', a = l?.auto_apply || {}, rid = l ? leadKey(l) : null;
  if (!l) return { status: 'cancelled', result: '这条岗位找不到了（归档或合并了）' };
  if (applied(l)) return { status: 'done', result: `${n}已提交` };
  // 预填做完、停在提交前：等你（终审，或者在页面上检查后自己提交），挂收件箱那封信；你答了由 lib/leads.mjs settleApplyWait 落定。
  if (a.status === 'prepared_for_user') { const w = applyWaitOf(l); return { status: 'needs_you', detail: w.reason, ask_id: w.what.ask_id }; }
  if (a.status === 'awaiting_final_review') return { status: 'needs_you', detail: '表填好了，停在「提交」前，等你终审', ask_id: `final:${rid}`, wait: 'final' };
  if (a.status === 'failed') return { status: 'stuck', detail: leadApplyWords(a).line };
  if (a.status === 'needs_login') {
    const u = l.application_url || l.url, fam = familyOf(u), key = fam?.key || (a.domain ? accountKey(a.domain) : accountKey(u)), who = fam?.label || a.domain || '招聘门户';
    return { status: 'needs_you', detail: `先登录 ${who}，登好了接着预填`, ask_id: key ? `login:${key}` : null, wait: 'login', login_label: who };
  }
  if (a.status === 'waiting_user') return { status: 'needs_you', detail: a.error ? leadApplyWords(a).line : '门户要你处理一步', ask_id: `need:lead:${rid}:${askKind(a.error)}` };
  return { status: 'cancelled', result: `${n}这条现在没有在投` };
}
export function settleLegacyApplyCards({ now = Date.now() } = {}) {
  const leads = lines('state/leads.ndjson'), hostJobs = lastRev(lines('state/host-jobs.ndjson')), out = [];
  for (const c0 of readCards()) {
    if (c0.kind !== 'apply' || c0.legacy || !c0.links?.apply_at || ['done', 'cancelled'].includes(c0.status)) continue;
    if (driven(c0, jobOfCard(c0))) continue;
    const c = { ...c0, links: { ...c0.links } };
    if (c.links.job_id) {
      const h = hostJobs.find(x => x.id === c.links.job_id);
      if (h && OPEN_HOST.has(h.status)) continue; // 还开着的交办任务照它走（工作台启动时 legacy-hands 已经收掉旧版的投递任务）
      c.links.old_job_id = c.links.job_id; delete c.links.job_id;
    }
    const l = findLead(leads, c.leads?.[0]), rid = l ? leadKey(l) : c.leads?.[0]?.rid || null;
    const acts = rid ? listActions({ kind: ['prefill', 'submit'], limit: 5000 }).filter(a => a.target === `lead:${rid}`) : [];
    // 最近那条动作挂在这张卡早先的一件活上（ref 是 card:<这张>#<那件>：做完以后另起了一轮，比如停在提交前等你）：还是这张卡的，不另落定。
    if (acts.length && String(J.get(acts.at(-1).job_id)?.ref || '').startsWith(`${cardRef(c0)}#`)) continue;
    if (acts.length) {
      const f = followJob(c, acts.at(-1).job_id);
      if (f !== 'other') { if (JSON.stringify(c.links) !== JSON.stringify(c0.links)) out.push(c); continue; }
      Object.assign(c, { status: 'cancelled', result: `${l?.number != null ? `#${l.number} ` : ''}在另一张卡上接着投`, detail: '' });
    } else {
      const s = legacySettle(c, l);
      const was = JSON.stringify([c.status, c.detail || '', c.result || '', c.links.ask_id || null]);
      Object.assign(c, { status: s.status, manual: false, auto: false, detail: s.detail || '', result: s.result || null, ...(s.status === 'done' ? { done_at: c.done_at || iso(now) } : {}) });
      if (s.ask_id) c.links.ask_id = s.ask_id; else delete c.links.ask_id;
      if (s.wait) Object.assign(c, { wait: s.wait, ...(s.login_label ? { login_label: s.login_label } : {}) }); else { delete c.wait; delete c.login_label; }
      if (was === JSON.stringify([c.status, c.detail || '', c.result || '', c.links.ask_id || null]) && JSON.stringify(c.links) === JSON.stringify(c0.links)) continue;
    }
    addStep(c, `接着上次的投递：${c.result || c.detail || c.status}`, { who: 'patch', at: now });
    out.push(c);
  }
  if (out.length) saveCards(out);
  // 别的旧数据（停在提交前却记成做完、旧发送卡、重复卡）一起升级（lib/task-upgrade.mjs）。出错只打一行，不挡工作台起来。
  let more = {};
  try { more = upgradeCards({ now }); } catch (e) { console.error(`[tasks] 旧卡升级出错（下次启动再试）：${e.message}`); }
  return { settled: out.length + Object.values(more).reduce((n, v) => n + (Number(v) || 0), 0), ...more };
}
