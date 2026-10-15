import { receiptCards } from './task-receipt.mjs';
import { controlled } from './task-control.mjs';
import { discoveryOutcome, DISCOVERY_STAGES } from './discovery-outcome.mjs';
import { prepTaskResult } from './company-brief.mjs';
// 任务板（2026-09-30，design/task-board/spec.md，负责人 03:00 批的三条）：团队手上的每一件事都是一张卡。
//   卡片清单  state/tasks.ndjson：一行一张卡，同一个 id 以最后一行为准（和 state/host-jobs.ndjson 一样读）；
//             存卡是在末尾追加（不拿锁）；压旧版本只在工作台启动时做（compactCards）。
//   状态      卡片指向交办任务（links.job_id）、操作台脚本（links.op_id）或一条岗位的投递（apply 卡看 lead.auto_apply）时，
//             状态由那条记录推出来（读的时候算），卡上存的只是缓存；没有链接的卡（手动卡、待认领、目标卡）用自己存的。
//             目标卡的状态由它下面的卡推出来。你手动挪过的卡（manual）照你挪的算。
//   接力      只开第一棒；一张有目标的卡做完，按目标的路线开下一张，附交接单（config/crew/shared.md 第 3 节的格式），
//             并在开始这件事的那个对话里记一行「Radar → Writer：…」。你已经说了「投」，判断那一棒跳过（能一键改成先判断）。
//   旧记录    任务板上线（BOARD_SINCE）之前的交办任务没有卡：读的时候合成只读的「旧记录」卡（id job:<任务 id>），不回写。
//   收卡      上线之后建的交办任务（批准投递、交给 System 修、公司调研……建任务的地方很多）没有卡的，同步时补一张真卡
//             （adoptJobs），能挪、能取消；标题和来源照实写（jobTitle / jobFrom，10-01 开箱测试 #25）。
//   例行      定时周期每位成员每一步一张卡（upsertRoutine），做完的在「完成」里默认收起。
// 卡片本身不用模型：没模型时照样能建、能挪、能换人；脚本类的卡能直接跑，要模型的卡排着、写明在等模型。
// 从不替你提交或发出：投递卡走现有的自动投递，停在终审（收件箱同一封信）；沙盒里提交本来就被挡住。
import { dayOf, zonedTime } from './tz.mjs';
import crypto from 'node:crypto';
import { lines, read } from './store.mjs';
import { lastRev, macFrom } from './cards.mjs';
import { shortTitle } from './short-title.mjs';
import { sandboxed } from './sandbox.mjs';
import { agentPaused } from './agents.mjs';
import { localAiGate, heldText } from './capabilities.mjs';
import { KINDS, crewOf, crewName, memberOfJob, JOB_CARD_KIND, handlesKind, kindLabel, isMember, memberOfEvent, STAGE_KIND, STAGE_LABEL } from './crew.mjs';
import { eventWords, dedupeEvents } from './event-words.mjs';
import { errorReason } from './say-error.mjs';
import { cachedLines } from './state-cache.mjs';
import { judgeAvailable } from './judge.mjs';
import { queueRecord, QUEUED_LINE } from './op-queue.mjs';
import { MAIL_SETUP } from './capabilities.mjs';
import { syncCardJobs, overlay, CARD_OF, jobOfCard, driven, adoptActionJobs, cardState, applyHome, bindApplyHome, cardRef, followJob, mirrorHostJobs } from './task-ledger.mjs';
import { view as jobView } from './status.mjs';
import * as J from './jobs.mjs';
import { plainText, leadWord } from './plain-words.mjs';
import { SIX, sixOf, TERMINAL, iso, cut, T, coName, applyQuestion, readCards, saveCards, headline, leadTag, leadRef, makeCard, holdOnMac, addStep, leadOf, leadByUrl, appliedBefore, closed, deriveGoal, currentOwner, waitLine, relayHead, relayGist, jobTitle, jobFrom, coveredJob, isOld, legacyCards } from './cards.mjs';
import { makeHandoff, handoffText, DO, findCard, routineSendReason } from './card-ops.mjs';
import { proofOf } from './apply-words.mjs';
import { answeredApplyInfo } from './apply-resume.mjs';

// ── 读的时候推状态 ─────────────────────────────────────────────────────────────
// ctx：{ jobs, leads, asks(), outbound(), requests(), model, runNow, now }。taskContext() 从本机状态读一份；测试直接传。
// workers：这个工作台开没开后台任务（bin/serve.mjs 的 workersOff 取反；不知道就是 undefined，不说）。
export function taskContext({ now = Date.now(), asks = null, model = null, workers = undefined } = {}) {
  let cached = null;
  let events = null, outbound = null, requests = null;
  return {
    now, sandbox: sandboxed(), workers: typeof workers === 'function' ? workers() : workers, executorPaused: agentPaused('executor'), jobs: lastRev(lines('state/host-jobs.ndjson')),
    events: () => (events ??= cachedLines('state/events.ndjson')),
    // 「发出已批准的」卡看这条线索的发送请求和回执（deriveCard）；用到才读。
    outbound: () => (outbound ??= cachedLines('state/outbound.ndjson')),
    requests: () => (requests ??= lastRev(cachedLines('state/send-requests.ndjson'))),
    leads: lines('state/leads.ndjson').filter(l => !l.superseded), runNow: read('state/run-now.json', {}) || {},
    asks: () => (cached ??= (typeof asks === 'function' ? asks() : asks) || []),
    model: model || { ok: true },
  };
}
const askForLead = (ctx, rid) => rid ? ctx.asks().find(a => (a.lead?.record_id || a.lead?.rid) === rid && !['triage', 'apply', 'reach', 'followup'].includes(a.kind)) || null : null;

// 收录那一棒收成了哪一条（接力用，不改卡的状态）：→ { leads, title, found, closed }（没找到就只有 found: false）。
export function intakeOutcome(c, ctx) {
  const res = (ctx.jobOf ? ctx.jobOf(c) : jobOfCard(c))?.result, rid = String(res?.links?.lead || '').replace(/^lead:/, '') || null;
  const h = c.links?.job_id ? ctx.jobs.find(x => x.id === c.links.job_id) : null;
  const l = (rid && leadOf(ctx, { rid })) || leadByUrl(ctx, c.url) || leadOf(ctx, c.leads?.[0]) || (h && (leadOf(ctx, h.record_id ? { rid: h.record_id } : null) || (h.number != null ? leadOf(ctx, { number: Number(h.number) }) : null)));
  if (!l) return { found: !!h || !!rid, closed: false }; // 交办任务说做完了、线索里找不到：照实说收好了，不写编号
  return { leads: [leadRef(l)], title: `${leadTag(l)} · 收录并核验`, found: true, closed: closed(l) };
}
// 一张非目标卡现在是什么状态：返回一份新的（不改原来的）。只读账（契约 05 第一节第 10 项，第 2 步 2X）：
//   那件活由别人带着走的卡（lib/task-ledger.mjs driven：操作台的运行、排队、对外动作、写的那一侧自己记账的、交办任务）
//   状态、原因、结果、要你做的那一件都照账上那件活；别的卡（手动卡、待认领、发送卡批准前）用卡自己存的，存卡时记进账。
// 以前这里还从领域记录推：交办任务（host-jobs）、发送请求和回执、收录的线索、投递停在终审（applyWait）、停下来的证据。
// 现在它们各由写的那一侧记账：交办任务经 lib/task-ledger.mjs mirrorHostJobs（bin/job.mjs 报结果时、排队循环里），
// 发送卡批准前就有一件「等你批准」的活、批准后动作那件挂上来（adoptActionJobs），收录由 bin/add-lead.mjs 记结果，
// 预填停在提交前由 worker 记 waiting_you（lib/workers.mjs settleApply），证据和标题这些给人看的在 decorate 里算。
export function deriveCard(card, ctx) {
  const c = { ...card, links: { ...(card.links || {}) } };
  if (c.kind === 'goal' || c.manual || c.status === 'cancelled' || c.legacy) return c;
  // 列表上的时间（updated_at）跟着这次的状态走：手动回过一句（addStep）以后，跑完时还停在回那句的时候（第 5 轮：列表 12:08「做完」，时间线 12:12 还在判）。
  const set = (status, extra = {}) => { Object.assign(c, { status, ...extra }); if (extra.at && T(extra.at) > T(c.updated_at)) c.updated_at = extra.at; if (status === 'running' && !c.started_at) c.started_at = extra.at || iso(ctx.now); if (status === 'done' && !c.done_at) c.done_at = extra.at || iso(ctx.now); };
  const job = ctx.jobOf ? ctx.jobOf(c) : jobOfCard(c);
  if (driven(c, job)) {
    // 排着的那一项轮到了：卡接上那次运行（op_id，做了什么从它的运行记录里看），状态还是照账。
    if (c.links.queue_id && !c.links.op_id) { const q = (ctx.queue || queueRecord)(c.links.queue_id); if (q?.status === 'started' && q.op_id) c.links.op_id = q.op_id; }
    const j = job;
    if (j && CARD_OF[j.state] && !(j.state === 'waiting_you' && (c.status === 'unclaimed' || c.mac_hold))) {
      const v = jobView(j);
      if (j.state !== 'done') c.done_at = null; // 做完以后又开了一轮、或者改记成没做成：卡上的「做完」时间不留
      set(CARD_OF[j.state], { at: j.finished_at || j.started_at || j.updated_at, ...(j.state === 'done' ? { result: v.reason || c.result || '做完了', detail: '' } : {}), ...(j.state === 'failed' ? { detail: v.reason || c.detail || '', result: null } : {}), ...(j.state === 'waiting_you' ? { detail: j.reason || v.reason || c.detail || '', result: null } : {}) });
      // 等你去接邮箱（Watcher 这一轮没读信，runOp 收尾记的 what 是接邮箱那一处）：卡上一步是「接上邮箱」，不是一个要回答的问题。
      if (c.wait === 'mail' || c.wait === 'login' || c.wait === 'final') delete c.wait;
      // 等你的那一件（what）：收件箱里那封信、登录、终审，或者一处设置。
      if (j.state === 'waiting_you' && j.what?.label) c.need_title = j.what.label; // 等你的那一句短的（交办任务的 need、登录、终审……），记账时写好的
      if (j.state === 'waiting_you' && j.what?.ask_id) { c.links.ask_id = j.what.ask_id; if (j.what.ask_id.startsWith('login:')) { c.wait = 'login'; c.login_label = j.what.label?.replace(/^登录\s*/, '') || j.what.ask_id.slice(6); } if (j.what.ask_id.startsWith('final:')) c.wait = 'final'; }
      if (j.state === 'waiting_you' && j.what?.href && !j.what.href.startsWith('#tasks')) { c.go = { href: j.what.href, label: j.what.label }; if (j.what.href.startsWith(MAIL_SETUP)) c.wait = 'mail'; }
      // 别处起的活问的那封信（writer:<卡 id>、终审、预填好了）答过了：卡上不再挂着它。
      if (j.state !== 'waiting_you' && /^(writer|final|prefilled):/.test(String(c.links.ask_id || ''))) delete c.links.ask_id;
    }
  }
  return c;
}
// 操作台跑的那一轮（links.op_id）实际做了什么：它自己的运行记录（run_id = ops-<op_id>，lib/command-center.mjs runOp）里
// 每位成员做完的每一步、调了几次模型、用了多少 token（10-02 开箱第 2 轮 N06：首轮调了 31 次模型，卡上写「脚本 / 没用模型」，
// 步骤只有「Radar：认领了」，看不出 Judge 判断到第几个）。读的时候算，不存（run_steps、used_model 在 DERIVED_ONLY 里）。
const NTH = /（第\s*(\d+)\s*\/\s*(\d+)\s*个）/;
const runRows = (c, ctx = {}) => { const run = c.links?.op_id ? `ops-${c.links.op_id}` : null; return run && typeof ctx.events === 'function' ? ctx.events().filter(e => e && e.run_id === run) : []; };
export function runTrail(c, ctx = {}) {
  const rows = runRows(c, ctx);
  if (!rows.length) return c;
  // 这次运行的日志（runOp 开跑那一行带着）：放进证据，只当备用；卡上的原因是账上那一句。
  const log = rows.find(e => e.step === 'ops' && e.refs?.[0]?.file)?.refs[0].file;
  if (log && !(c.evidence || []).includes(log)) c.evidence = [...(c.evidence || []), log];
  const calls = rows.filter(e => e.step === 'model' && e.status !== 'start');
  if (calls.length) {
    const tokens = calls.reduce((n, e) => n + (Number(e.model_usage?.input_tokens) || 0) + (Number(e.model_usage?.output_tokens) || 0), 0);
    c.used_model = true;
    c.cost = { ...(c.cost || {}), calls: calls.length, ...(tokens ? { tokens } : {}) };
  }
  // 各阶段的结果（「扫官方招聘源 · 有更新」）：开始、整轮、操作台那几条不列；同一步记了两条的只留一条。
  const steps = dedupeEvents(rows.filter(e => !['model', 'cycle', 'ops', 'web', 'heartbeat'].includes(e.step) && e.status !== 'start'))
    .map(e => ({ at: e.ts, who: memberOfEvent(e), text: eventWords(e.msg, 80) })).filter(s => s.text && isMember(s.who));
  // 调模型的那几位：一位一行。Judge 写判断到第几个（还在跑）或判断了几个（跑完了）。
  const byWho = new Map();
  for (const e of rows.filter(e => e.step === 'model')) { const w = memberOfEvent(e); if (isMember(w)) byWho.set(w, [...(byWho.get(w) || []), e]); }
  for (const [who, es] of byWho) {
    const done = es.filter(e => e.status === 'ok').length, failed = es.filter(e => e.status === 'fail').length, last = es.at(-1), nth = NTH.exec(String([...es].reverse().find(e => NTH.test(String(e.msg || '')))?.msg || ''));
    const busy = c.status === 'running';
    const text = who === 'lens'
      ? busy && nth ? `判断到第 ${nth[1]}/${nth[2]} 个${Number(nth[1]) !== done ? `，做完 ${done} 个` : ''}` : `判断了 ${done} 个岗位${failed ? `，${failed} 个没判成` : ''}`
      : `调了 ${done + failed} 次模型${busy ? '，还在做' : ''}`;
    steps.push({ at: last.ts, who, text });
  }
  c.run_steps = steps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = c.run_steps.at(-1)?.at;
  if (last && T(last) > T(c.updated_at)) c.updated_at = last;
  return c;
}
// 排着的卡在等什么（负责人 09-30「后面真实在流转吗」）：卡上写真话，不只写「排队」。
// env：{ sandbox, workers, executorPaused, model }（taskContext）。不是排着的卡、你手动建的待认领卡没有这一句。
// who：接手的成员名（卡的主人）；不说「执行器」（第 2 轮新 38）。
// holdOf 多给一个 go：桌面版本机 AI 没打开（lib/capabilities.mjs localAiGate），卡上带直达开关的链接（10-02 主会话）。
// local：这件事真要交给本机 AI（宿主任务）；false 是引擎自己做的（「你交代的事」「公司调研」没排宿主任务时，lib/task-do.mjs），
// 那就不看本机 AI 的开关（能力表 whoDoes：本机 AI 只是可选的加速）。
export function holdOf({ executor = false, local = executor, model = false, who = '' }, env = {}) {
  if (executor) {
    if (env.sandbox) return { text: '演示 / 沙盒模式不会真的跑' };
    if (env.workers === false) return { text: '后台任务关着，不会自动跑' };
    if (local && env.executorPaused) return { text: '暂停中，恢复后才会接手' };
    const gate = local ? env.gate || localAiGate() : { allowed: true };
    if (!gate.allowed) return { text: heldText(gate), go: gate.go };
    return { text: who ? `排队中：等 ${who} 接手` : '排队中：等人接手' };
  }
  if (model && env.model && !env.model.ok) return { text: env.sandbox && env.model.why === 'sandbox' ? '演示 / 沙盒模式不会真的跑' : `排队中：等模型（${env.model.note || '现在没有能用的模型'}）` };
  return null;
}
export const holdReason = (what, env = {}) => holdOf(what, env)?.text ?? null;
export function waitNote(c, env = {}) {
  if (c.status !== 'queued' || c.kind === 'goal' || c.manual) return null;
  const blocked = routineSendReason(c);
  if (blocked) return blocked;
  if (c.mac_hold) return `在电脑上确认后才运行：${c.mac_hold.label}`;
  if (c.links?.queue_id && !c.links?.op_id) return QUEUED_LINE;
  const k = KINDS[c.kind] || {}, how = c.how || k.how;
  const executor = !!c.links?.job_id || how === 'executor', local = !!c.links?.job_id || (executor && !DO.has(c.kind));
  const hold = holdReason({ executor, local, model: how === 'model' && !c.links?.op_id, who: c.owner && c.owner !== 'team' ? crewName(c.owner) : '' }, env);
  if (hold) return hold;
  if (c.auto && !c.links?.op_id && !c.links?.apply_at) return c.detail ? `排队中：${c.detail}` : '排队中：马上开始';
  return null;
}
const ENGINE_WORK = new Set(['research', 'interview']); // lib/task-do.mjs ENGINE_WORK：你点「运行」也开跑
// deps：{ runOp(op, opts), dispatch(text, opts), referrersFor(lead), model }。服务端传真的，测试传假的。
// 脚本和浏览器类的卡直接跑；要模型的卡有模型才跑；执行器类的卡等执行器（v0.1 不自动交给执行器，卡上写明）。
export async function startCard(card, deps = {}, ctx = null) {
  const c = card, k = KINDS[c.kind] || {}, model = deps.model || ctx?.model || { ok: true };
  const blocked = routineSendReason(c);
  if (blocked) throw Object.assign(Error(blocked), { status: 409 });
  const lead = c.leads?.[0] ? (ctx ? leadOf(ctx, c.leads[0]) : null) || c.leads[0] : null;
  // 手机上开的、要开执行器或浏览器的一棒：电脑上确认之前哪条路都不开跑（自动开工、「运行」、建卡时 run）。
  if (c.mac_hold) { c.wait_note = waitNote({ ...c, status: 'queued' }); return c; }
  try {
    if (c.kind === 'apply') {
      if (!lead?.number) throw Error('这张卡还没对上岗位编号');
      const refs = deps.referrersFor ? await deps.referrersFor(lead) : [];
      addStep(c, refs.length ? `查内推：找到 ${refs.length} 位可能的内推人（${refs.slice(0, 2).map(r => r.name || r.title || '一位').join('、')}），先走官网表单，内推另说` : `查内推：你的联系人里没有 ${coName(lead.company)} 的人，改走官网表单`, { tool: 'script' });
      if (!deps.dispatch) throw Error('没有投递通道');
      // 你已经说了「投」：批准投递（填好停在终审，从不直接提交）。
      // 一件活一张卡：动作挂在这张卡自己的那件活上（job_id），不另开（主会话 10-04）。
      // 确认绑你看到的那一版：收件箱里那封带着预览的指纹（confirm_fp，answerGoal / confirmApply 记下的），没有就认服务端上一次给你看的。
      const r = await deps.dispatch(`投 ${lead.number}`, { confirm: c.confirm_fp || true, job_id: jobOfCard(c)?.id || null });
      // 还没给你看过这一版（换了进程、从没经服务端给你看过预览）、或者这一版和你确认的不一样：卡「等你」，收件箱来一封带预览的
      // 「确认开始预填」（goalAsks 里的 apply 卡那一封），不记失败（J 10-04）。
      if (r?.needs_confirm) {
        delete c.confirm_fp;
        Object.assign(c, { status: 'needs_you', auto: false, confirm_wait: { at: iso(Date.now()), ...(r.changed ? { changed: true } : {}) }, detail: r.changed ? `#${lead.number} 的申请材料和你确认时不一样了，再确认一次` : `填表前等你确认这一版（投 ${lead.number}）`, need_title: '确认这一版' });
        c.links = { ...(c.links || {}), ask_id: `goal:${c.id}` };
        // 旧预填已挂过动作：存卡只照任务账，不会替动作改状态。这里没有开新动作，明确记下当前这一问。
        const j = jobOfCard(c);
        if (j) J.drive(j.id, 'waiting_you', { reason: c.detail, what: { label: c.need_title, ask_id: c.links.ask_id } });
        addStep(c, c.detail, { tool: 'script' });
        return c;
      }
      delete c.confirm_fp;
      if (r?.ok === false) throw Error(r.error || r.receipt || '投递没排上');
      const queued = r?.applied && [...(r.applied.queued || []), ...(r.applied.waiting_login || [])];
      if (r?.data?.frozen || (queued && !queued.some(n => Number(n?.number ?? n) === Number(lead.number)))) {
        Object.assign(c, { status: 'stuck', auto: false, detail: cut(r.receipt || '投递没排上，请检查岗位的投递入口', 120) });
        addStep(c, c.detail, { tool: 'script' });
        return c;
      }
      // 这条线索已经有一条开着的动作、挂在别的活上（duplicate）：卡改跟那一件；那件挂在另一张卡上就不抢，这张取消（F 交接第 3 条）。
      const other = r?.jobs?.[lead.number] ?? r?.jobs?.[String(lead.number)];
      if (other && followJob(c, other) === 'other') {
        Object.assign(c, { status: 'cancelled', manual: false, auto: false, detail: '', result: `#${lead.number} 已经在另一张卡上投了` });
        addStep(c, c.result, { tool: 'script' });
        return c;
      }
      c.links.apply_at = iso(Date.now());
      addStep(c, '用浏览器打开申请页填表，填好停在「提交」前', { tool: 'browser' });
      Object.assign(c, { status: 'running', started_at: c.started_at || iso(Date.now()), detail: '' });
      return c;
    }
    // 发出已批准的：不跑脚本（操作台没有「发出」这个操作，以前调 runOp 报「未知操作」、试 5 次卡住）。
    // 草稿要你在收件箱里批准，批准了周期按原样发出；走到哪了由 deriveCard 看这条线索的发送请求和回执（links.send_at）。
    // 批准前账上就有这张卡的一件活，记「等你批准」（存卡时 syncCardJobs 记）；你一批准，发送那件挂上来、这一件取消（lib/task-ledger.mjs bindHome）。
    if (c.kind === 'send') {
      c.links.send_at = iso(Date.now());
      addStep(c, '草稿等你批准，批准后按原样发出', { tool: 'script' });
      Object.assign(c, { status: 'needs_you', started_at: c.started_at || iso(Date.now()), detail: '草稿等你批准', need_title: '批准草稿' });
      return c;
    }
    if (k.how === 'model' && !model.ok) { c.wait_note = holdReason({ model: true }, { ...(ctx || {}), model }); return c; }
    // 「怎么准备」：Judge 自己写（lib/role-prep.mjs，L 线第 1b 批），和岗位页上的按钮同一条路（lib/role-prep.mjs requestPrep）。
    // 写到哪了由写的那一侧记在这张卡的活上（lib/role-prep.mjs、savePrep → task-ledger moveCardJobs），卡照账。没有 JD 正文：卡住，写明要先回填原帖。deps.prep：测试传假的。
    if (c.kind === 'prep') {
      const rid = lead?.record_id || lead?.rid;
      if (!rid) throw Error('这张卡还没对上岗位');
      const r = await (deps.prep || (async o => (await import('./role-prep.mjs')).requestPrep(o)))({ record_id: rid, source: 'tasks' });
      if (r?.status === 'ready') { Object.assign(c, { status: 'done', result: r.receipt || `写好了：${r.items} 条`, done_at: iso(Date.now()), auto: false }); return c; }
      if (r?.status === 'no_jd') { Object.assign(c, { status: 'stuck', auto: false, detail: cut(r.receipt, 120) }); addStep(c, c.detail); return c; }
      if (r?.status === 'no_model') { c.wait_note = holdReason({ model: true }, { ...(ctx || {}), model: { ok: false, note: '现在没有能用的模型' } }); c.detail = cut(r.receipt, 120); return c; }
      c.links.prep_at = iso(Date.now());
      addStep(c, `${crewName('lens')} 对着 JD 和缺口写怎么准备`, { tool: 'model' });
      Object.assign(c, { status: 'running', started_at: c.started_at || iso(Date.now()), detail: '' });
      return c;
    }
    // 「你交代的事」、公司调研（第 5 轮开箱 B3，lib/task-do.mjs）：本机 AI 能跑就照老路交给它（一条宿主任务）；
    // 跑不了（桌面版开关没开、演示 / 沙盒）就引擎自己用文字模型做，要动电脑的停下说清。自己交代的才开跑（auto），你手动建的待认领卡不动。
    if (DO.has(c.kind) && (c.auto || ENGINE_WORK.has(c.kind)) && !c.links?.job_id && !c.links?.do_at) {
      // 主会话 10-03：本机 AI 开着也先让文字模型做（省你的 Claude、Codex 额度），只有要动电脑的交给它（startDo 里分）。
      // 公司调研也由引擎加模型做（能力表 company_research：本机 AI 只接 user_task、system_repair，契约 2.4）。
      const D = await import('./task-do.mjs'), env = { sandbox: deps.sandbox ?? ctx?.sandbox, gate: deps.gate };
      const r = await D.startDo(c, { ...(deps.doDeps || {}), ...env, kickHost: deps.kickHost || null }, { now: Date.now() });
      if (r.kick) { if (Array.isArray(deps.later)) deps.later.push(r.kick); else setImmediate(r.kick); }
      return r.card;
    }
    // 内推判断支持已选择的文字模型；没有可用模型就是未完成，不能当成找过了。
    if (c.kind === 'referrers' && !judgeAvailable({ textOk: true })) {
      Object.assign(c, { status: 'stuck', auto: false, wait: 'model', detail: '还没有能用的判断或文字模型，内推检索尚未开始' });
      addStep(c, c.detail, { tool: 'model' });
      return c;
    }
    if (k.how === 'executor' || !k.op) return c; // 在等什么由 waitNote 写（沙盒 / 后台任务关着 / 等执行器领取）
    if (!deps.runOp) throw Error('没有脚本通道');
    const rec = await deps.runOp(k.op, { record_id: lead?.rid || lead?.record_id || null, url: c.url || null, email: c.email || null, card_id: c.id });
    if (rec?.queued) {
      Object.assign(c.links, { op: k.op, queue_id: rec.id });
      Object.assign(c, { status: 'queued', detail: QUEUED_LINE });
      if (!rec.dup) addStep(c, QUEUED_LINE, { tool: 'script' });
    }
    if (rec?.id && !rec.queued && !/^q-/.test(rec.id)) { c.links.op = k.op; c.links.op_id = rec.id; addStep(c, `开始跑「${rec.label || kindLabel(c.kind)}」`, { tool: 'script' }); Object.assign(c, { status: rec.status === 'ok' ? 'done' : 'running', started_at: iso(Date.now()) }); if (rec.status === 'ok') c.done_at = rec.finished_at || iso(Date.now()); }
    return c;
  } catch (e) {
    // 忙碌由持久队列接手；这里只记录真正未能启动的错误。
    c.detail = errorReason(e); c.tries = (c.tries || 0) + 1; // 卡上只说人话；脚本通道忙这类本来就是中文的原样留着
    // 投递没有建出动作就不能一直说排上了。卡落成失败，保留原因，用户可以再试。
    if (c.kind === 'apply') { c.status = 'stuck'; c.auto = false; }
    if (c.tries >= 5 && c.kind !== 'apply') { c.status = 'stuck'; c.auto = false; }
    return c;
  }
}

// ── 同步：推状态、接力、开工 ───────────────────────────────────────────────────
// 读的时候调（GET /api/tasks、对话面板刷新、bin/job.mjs 报完结果）；幂等。返回推好的全部卡和这次的接力。
// deps.relayLine(r)：接力那一行的回调（lib/talk.mjs 传进来；卡上已经记了 relay，它不再写进对话）。deps.persist=false 时只算不写。
export async function syncTasks(deps = {}) {
  const ctx = deps.ctx || taskContext({ asks: deps.asks, model: deps.model, workers: deps.workers });
  const stored = readCards(), byId = new Map(stored.map(c => [c.id, c]));
  const changed = new Map(), relays = [];
  // 交办任务（旧版 host-jobs）记进卡的那件活：bin/job.mjs 报完已经记过，这里盖住还在直接写文件的旧写法（lib/task-ledger.mjs mirrorHostJobs）。
  if (deps.persist !== false) mirrorHostJobs(ctx.jobs, stored, { running: ctx.runNow?.running ? ctx.runNow.job_ids || [] : [], now: ctx.now });
  let cards = stored.map(c => c.kind === 'goal' ? c : deriveCard(c, ctx));
  const put = c => { changed.set(c.id, c); const i = cards.findIndex(x => x.id === c.id); if (i >= 0) cards[i] = c; else cards.push(c); };
  // 上线之后建的交办任务没有卡的，补一张（批准投递、自动修复、公司调研……）。不开对话：卡片「做了什么」第一行写清是怎么来的。
  const adopted = adoptJobs(ctx.jobs, cards, { now: ctx.now });
  if (deps.persist !== false && adopted.length) { saveCards(adopted); mirrorHostJobs(ctx.jobs, adopted, { running: ctx.runNow?.running ? ctx.runNow.job_ids || [] : [], now: ctx.now }); } // 补出来的卡先存下、记账，再照账
  for (const c of adopted) put(deriveCard(c, ctx));
  // 收件箱、对话、手机上批准的对外动作（那件活还没挂卡）：挂到等着它的发送卡上，或者补一张卡（lib/task-ledger.mjs，一件活一张卡）。
  if (deps.persist !== false) {
    for (const c of adoptActionJobs(cards, { makeCard, leadOf: r => leadOf(ctx, r), now: ctx.now })) put(deriveCard(c, ctx));
  }
  // Writer 的旧活（对话里有、还没有卡的）：没做完的、今天做完的补一张卡，对话就是它起头的那段（lib/task-migrate.mjs adoptWriter）。只算不写时不补。
  if (deps.persist !== false) try { for (const c of (await import('./task-migrate.mjs')).adoptWriter(cards, { now: ctx.now })) put(deriveCard(c, ctx)); } catch {}
  // 等你的那一步记进「做了什么」（第 6 轮开箱 C7：等登录时时间线只有开工那一条）：进了等你记一行等的是什么，
  // 等的那一步过了（登好了、答了）再记一行。Writer 的活不记：它问的、你答的在对话里（lib/task-migrate.mjs writerRows）。
  // 还在等你、等的换了一件（登好了，又要你重新确认材料）：登好了那一行和新等的那一行都记。
  for (const c of cards) {
    const s = byId.get(c.id);
    if (!s || c.kind === 'goal' || c.links?.writer || (s.status === c.status && (c.status !== 'needs_you' || (s.detail || '') === (c.detail || '')))) continue;
    const loggedIn = s.status === 'needs_you' && s.wait === 'login' && c.wait !== 'login';
    if (loggedIn && ['running', 'queued', 'needs_you'].includes(c.status)) addStep(c, `登录好了，接着${kindLabel(c.kind)}`, { who: c.owner, at: ctx.now });
    if (c.status === 'needs_you') { const t = waitLine(c); if (c.steps?.at(-1)?.text !== t) addStep(c, t, { who: c.owner, at: ctx.now }); }
    else if (s.status === 'needs_you' && !loggedIn && ['running', 'queued'].includes(c.status)) addStep(c, '不用再等了，接着做', { who: c.owner, at: ctx.now });
  }
  // 缓存下来：推出来的状态和存的不一样就存。
  for (const c of cards) { const s = byId.get(c.id); if (s && c.kind !== 'goal' && ['status', 'result', 'detail', 'title', 'done_at', 'started_at'].some(f => (s[f] ?? null) !== (c[f] ?? null))) changed.set(c.id, c); }
  // 目标停在「确认，开始预填」，可这条岗位已经投过了（线索上已投递，或者账上这条线索的提交做完了）：不再问一遍，
  // 投递那一棒记成做完（J 的旅程 10-04：收件箱里「投递 #7」还等你确认，#7 早就投过了）。
  for (const g0 of cards.filter(c => !controlled(c) && c.kind === 'goal' && !TERMINAL.has(c.status) && c.halt && !c.halt.answered && (c.halt.options || []).includes('确认，开始预填'))) {
    const l = leadOf(ctx, g0.leads?.[0]);
    if (!appliedBefore(ctx, g0.leads?.[0])) continue;
    const g = { ...g0, halt: { ...g0.halt, answered: '已经投过了', answered_at: iso(ctx.now) }, route: g0.route.map(s => s.kind === 'apply' && ['planned', 'open'].includes(s.state) && !s.card ? { ...s, state: 'done' } : { ...s }) };
    addStep(g, `${l?.number != null ? `#${l.number} ` : ''}已经投过了，不再问`, { at: ctx.now });
    put(g);
  }
  // 接力：每个没结束的目标，看开着的那一棒是不是做完了。
  for (const g0 of cards.filter(c => !controlled(c) && c.kind === 'goal' && !TERMINAL.has(c.status) && !(c.halt && !c.halt.answered))) {
    const g = { ...g0, route: g0.route.map(s => ({ ...s })) };
    let touched = false;
    for (let i = 0; i < g.route.length; i++) {
      const s = g.route[i];
      if (s.state !== 'open' || !s.card) continue;
      const child = cards.find(c => c.id === s.card);
      if (!child || child.status !== 'done') continue;
      s.state = 'done'; touched = true;
      const asked = g.halt?.answered && g.halt.card === child.id; // 你已经答过「还投」「确认，开始预填」：不再停
      // 收录完：岗位编号记到目标上；收不成 / 已下线就停下来问你，不接着开卡。收成了哪一条看那件活的结果（bin/add-lead.mjs 记的 links.lead），
      // 旧的（结果里没记）按链接、卡上的岗位、交办任务记的 record_id / number 找。
      if (child.kind === 'intake') {
        const got = intakeOutcome(child, ctx);
        Object.assign(child, got); put(child);
        if (child.leads?.[0]) { g.leads = child.leads; g.title = g.title.replace(/\s.*$/, '') + ` #${child.leads[0].number} ${child.leads[0].company}${child.leads[0].role ? ` · ${child.leads[0].role}` : ''}`; }
        if ((!child.found || child.closed) && !asked) { g.halt = { question: child.closed ? `#${child.leads[0].number} 已经下线了。还投吗？` : '链接没收成线索。还投吗？', options: ['还投', '不投了'], at: iso(ctx.now), card: child.id }; break; }
      }
      if (child.kind === 'judge') {
        const l = leadOf(ctx, g.leads?.[0]), v = l?.judgement?.verdict || l?.verdict;
        if (v === 'exclude' && !asked) { g.halt = { question: `Judge 判断 #${l.number} 为排除（${cut((l.judgement?.reasons || [])[0] || '', 40)}）。还投吗？`, options: ['还投', '不投了'], at: iso(ctx.now), card: child.id }; break; }
      }
      const nxt = g.route.slice(i + 1).find(x => x.state === 'planned');
      if (!nxt) break;
      const lead = leadOf(ctx, g.leads?.[0]) || g.leads?.[0] || null;
      // 投递这一棒不替你批准（09-30 #21）：和「投 N」一样，先把这一条给你看、等你点确认，再开卡预填。
      // 已经投过了：这一棒不开、不问，记成做完（J 的旅程「投递 #7」）。
      if (nxt.kind === 'apply' && appliedBefore(ctx, lead)) { nxt.state = 'done'; addStep(g, `${lead?.number != null ? `#${lead.number} ` : ''}已经投过了，不再问`, { at: ctx.now }); continue; }
      if (nxt.kind === 'apply' && !asked && !g.confirmed) { g.halt = { question: applyQuestion(lead), options: ['确认，开始预填', '不投了'], at: iso(ctx.now), card: child.id, from: 'quill' }; break; }
      const handoff = makeHandoff({ from: child.owner, to: nxt.owner, kind: nxt.kind, lead: lead ? { ...leadRef(lead), source: lead.source === 'forwarded' || g.url ? '你贴的链接' : lead.source || '' } : null, known: child.result || '', evidence: (child.evidence || []).slice(0, 2), job_id: child.links?.job_id || '', requirement: [g.requirement, ...(g.says || []).map(x => x.text)].filter(Boolean).join('；') || null }); // 你改的要求、卡片上下的指令
      const card = holdOnMac(makeCard({ kind: nxt.kind, leads: lead ? [lead] : [], owner: nxt.owner, from: { by: 'member', member: child.owner, card: child.id, ...(g.from?.session_id ? { session_id: g.from.session_id } : {}), ...macFrom(g.from), ...macFrom(g.mac_next) }, goal: g.id, handoff, auto: true, now: ctx.now }), undefined, ctx.now);
      if (card.mac_hold) delete g.mac_next; // 没被允许交办的手机答的那一问（answerGoal）：放行的这一棒停在电脑确认，用掉了
      if (g.requirement) card.requirement = g.requirement; // 你改过的要求：下一棒读的是新的
      if (card.kind === 'apply' && asked && g.halt?.fingerprint) card.confirm_fp = g.halt.fingerprint; // 你在收件箱那封里确认的那一版
      nxt.state = 'open'; nxt.card = card.id;
      const parent = { ...child, next: [...(child.next || []), card.id] };
      addStep(parent, `开了一张卡给 ${crewName(nxt.owner)}`, { at: ctx.now });
      put(parent); put(card);
      const line = `${relayHead(child, nxt)}：${relayGist(child, lead)}${child.owner === nxt.owner ? '' : `，交给你${kindLabel(nxt.kind)}`}`;
      card.relay = { from: child.owner, to: nxt.owner, text: line }; // 进任务卡片的「做了什么」，不写进对话
      relays.push({ goal: g.id, from: child.owner, to: nxt.owner, card: card.id, text: line, session_id: g.session_id || g.from?.session_id || null });
      break;
    }
    if (touched) put(g);
  }
  // 引擎自己做的那几件（lib/task-do.mjs）：等着打开本机 AI 的，打开了就放回排队；在做却丢了的（工作台重启），算没做成。
  if (deps.start !== false && cards.some(c => DO.has(c.kind) && (c.wait === 'local_ai' || c.links?.do_at || (c.kind === 'ask' && c.from?.via === 'tasks' && !c.auto)))) for (const c of (await import('./task-do.mjs')).settleDo(cards.filter(c => !controlled(c)), { now: ctx.now, env: { sandbox: deps.sandbox ?? ctx.sandbox, gate: deps.gate } })) put(c);
  // 旧版交办与修复卡（指向还没人领的宿主任务）：转回引擎（lib/task-do.mjs migrateHanded）。能重复跑。
  if (deps.start !== false && deps.persist !== false && cards.some(c => ['ask', 'repair'].includes(c.kind) && c.links?.job_id)) try { for (const c of await (await import('./task-do.mjs')).migrateHanded(cards, ctx, { sandbox: deps.sandbox ?? ctx.sandbox, gate: deps.gate })) put(c); } catch (e) { if (e.message !== 'another_radar_writer_running') throw e; }
  // 开工：自己开出来的卡（auto）还没跑的，按类型跑起来。一次最多开几张，脚本通道一次只跑一个。
  // later：在后台做的那几件（引擎用模型做的），等这一轮的卡存好以后再开始，免得这里存的「在做」盖掉它做完的结果。
  const later = [];
  if (deps.start !== false) {
    for (const c of cards.filter(c => !controlled(c) && c.auto && c.status === 'queued' && !c.mac_hold && !c.links?.queue_id && !c.links?.op_id && !c.links?.apply_at && !c.links?.job_id && !routineSendReason(c)).slice(0, 4)) {
      const before = JSON.stringify(c);
      const after = await startCard({ ...c, links: { ...c.links }, steps: [...(c.steps || [])] }, { ...deps, later }, ctx);
      if (JSON.stringify(after) !== before) put(after);
    }
  }
  if (deps.persist !== false && changed.size) { try { saveCards([...changed.values()]); } catch (e) { if (e.message !== 'another_radar_writer_running') throw e; } }
  if (deps.persist !== false) for (const f of later) try { f(); } catch {}
  for (const r of relays) try { deps.relayLine?.(r); } catch {}
  // 卡片上下的指令等这一版 / 这一轮做完再接着做的（lib/task-say.mjs say_next）：做完了就接上。
  if (deps.persist !== false && deps.say && cards.some(c => c.say_next)) try { await (await import('./task-say.mjs')).followUps(cards, deps.say); } catch {}
  const derived = cards.map(c => c.kind === 'goal' ? deriveGoal(c, cards) : c);
  // 目标卡的状态由下面的卡推：推出来的和账上那件活不一样的，记进它那件活（目标卡本身不重写；存下来的 status 是旧值，不拿它比）。
  if (deps.persist !== false) { const moved = derived.filter(g => g.kind === 'goal' && !g.legacy && cardState(g).state !== jobOfCard(g)?.state); if (moved.length) syncCardJobs(moved, { goals: 'derived' }); }
  // 给读的人（页面、对话、手机）的那一份：和 viewTasks 一样带上给人看的字段（等什么、短标题、证据、这一轮做了什么）。
  return { cards: derived.map(c => c.kind === 'goal' ? c : decorate({ ...c, links: { ...(c.links || {}) } }, ctx)), relays, ctx };
}
// 读请求用（GET /api/tasks、对话面板、成员页、手机）：只读，不推、不写、不开工。卡上的状态是账上那件活的（overlay），
// 别的是给人看的（短标题、对应的信、这一轮做了哪几步）。推状态、接力、开工在排队循环里（settleTasks，bin/serve.mjs）。
export function viewTasks(deps = {}) {
  const ctx = deps.ctx || taskContext({ asks: deps.asks, model: deps.model, workers: deps.workers });
  const stored = readCards();
  const cards = [...stored, ...receiptCards(stored)].map(c => c.kind === 'goal' ? plainCard(overlay(c), ctx) : decorate(overlay(c), ctx));
  return { cards: cards.map(c => c.kind === 'goal' ? { ...deriveGoal(c, cards), status: c.status, state: c.state, word: c.word, tone: c.tone, reason: c.reason } : c), relays: [], ctx };
}
// 一张卡给页面的样子：账上的状态 + 给人看的东西（成员页、对话面板也用它，不再各推一遍）。
export const viewCard = (c, ctx) => decorate(overlay(c), ctx);
// 给人看的那几行（标题、要做成什么、原因、结果、等你的那一句）：原始链接换成人名和岗位、跟踪参数不露，成员编号换成显示名
// （lib/plain-words.mjs，主会话实测 10-04 第 6、8 条）。只换读出来的这一份，存着的卡和账不改。
const PLAIN = ['title', 'requirement', 'detail', 'result', 'need_title', 'wait_note'];
export function plainCard(c, ctx = null) {
  const ref = c.leads?.[0], lead = ref ? (ctx?.leads ? leadOf(ctx, ref) : null) || ref : null, label = leadWord(lead);
  for (const f of PLAIN) if (typeof c[f] === 'string' && c[f]) c[f] = plainText(c[f], { label: f === 'title' || f === 'requirement' ? label : '', nameOf: crewName });
  if (c.halt?.question) c.halt = { ...c.halt, question: plainText(c.halt.question, { label, nameOf: crewName }) };
  return c;
}
function decorate(c, ctx) {
  if (c.kind === 'prep' && c.status === 'done') c = { ...c, prep_recorded_result: c.prep_recorded_result || c.result, result: prepTaskResult(c) };
  // 投递卡的名字跟着现在的自动提交开关读（「填表并提交」「预填申请表」，09-30 #26）。
  if (c.kind === 'apply' && c.title) c.title = c.title.replace(/填表并提交|预填申请表/, kindLabel('apply'));
  // 投递停下来的那一页（截图、地址、停在哪一步、原始的码）：卡片「详情与证据」里列（lib/task-card.mjs cardView）。给人看的，读的时候算。
  if (c.kind === 'apply' && c.leads?.[0] && ctx?.leads) { const p = proofOf(leadOf(ctx, c.leads[0])); if (p) c.proof = p; else delete c.proof; }
  if (c.links?.ask_id?.startsWith('final:') && c.status === 'needs_you') c.wait = 'final';
  if (c.wait === 'login' && c.links?.ask_id) c.login_label = ctx.asks().find(a => a.id === c.links.ask_id)?.account?.label || c.login_label || c.links.ask_id.slice(6);
  plainCard(c, ctx);
  c.links = { ...(c.links || {}) };
  if (c.links.op_id) runTrail(c, ctx);
  c.wait_note = waitNote(c, ctx);
  if (c.links.ask_id && c.status === 'needs_you') c.ask = ctx.asks().find(a => a.id === c.links.ask_id) || null;
  delete c.resume_prefill;
  if (c.kind === 'apply' && c.status === 'needs_you' && !c.legacy && !c.mac_hold) {
    const lead = leadOf(ctx, c.leads?.[0]);
    const saved = answeredApplyInfo(lead);
    if (saved) {
      c.resume_prefill = saved;
      c.detail = `答案簿里已有这 ${saved.labels.length} 项信息；上次预填停下后还没有继续。继续预填会重新核对申请页，停在提交前，同意框由你自己勾。`;
    }
  }
  c.short = headline(c.title);
  if (c.status === 'needs_you') c.need_title = plainText(c.what?.label || c.need_title || shortTitle(c.ask?.question || c.detail, { max: 22, ask: true }) || '', { nameOf: crewName }) || null;
  if (c.resume_prefill) c.need_title = '继续预填';
  return c;
}
// 排队循环里调（bin/serve.mjs，几秒一次）：推状态、接力、开工、回写，都在这里，不在读请求里。
let settling = null;
export function settleTasks(deps = {}) { if (!settling) settling = syncTasks(deps).finally(() => { settling = null; }); return settling; }
// 成员给同事开一张卡（bin/task.mjs pass）：只能交给管这类事的那位，附交接单；原卡记一笔，对话里一行。
export function passCard(id, { to, kind, next = '', files = [], now = Date.now() } = {}) {
  const c = findCard(id), who = crewOf(to);
  if (!KINDS[kind]) throw Object.assign(Error(`认不出这类事：${kind}`), { code: 2 });
  if (!who || !handlesKind(who, kind) || KINDS[kind].member == null) throw Object.assign(Error(`${crewName(to) || to} 不管「${kindLabel(kind)}」这类事${KINDS[kind].member ? `，该交给 ${crewName(KINDS[kind].member)}` : ''}`), { code: 2 });
  const lead = c.leads?.[0] || null;
  const handoff = makeHandoff({ from: c.owner, to: who, kind, lead, known: c.result || '', next: next || null, files, job_id: c.links?.job_id || '' });
  const card = holdOnMac(makeCard({ kind, leads: lead ? [lead] : [], owner: who, from: { by: 'member', member: c.owner, card: c.id, ...(c.from?.session_id ? { session_id: c.from.session_id } : {}), ...macFrom(c.from) }, goal: c.goal || null, handoff, now }), undefined, now);
  c.next = [...(c.next || []), card.id];
  addStep(c, `开了一张卡给 ${crewName(who)}`, { at: now });
  saveCards([c, card]);
  return { card, from: c, line: `${relayHead(c, { owner: who, kind })}：${lead?.number != null ? `#${lead.number} ` : ''}${cut(next || kindLabel(kind), 40)}` };
}
export function judgeFirst(goalId, { now = Date.now() } = {}) {
  const g = findCard(goalId);
  if (g.kind !== 'goal') throw Error('这不是一个目标');
  const i = g.route.findIndex(s => s.kind === 'judge');
  if (i < 0 || g.route[i].state !== 'skip') throw Error('这件事的路线里没有跳过的判断');
  const after = g.route.slice(i + 1), started = readCards().filter(c => after.some(s => s.card === c.id));
  if (after.some(s => s.state === 'done') || started.some(c => c.status !== 'queued' || c.links?.op_id || c.links?.apply_at)) throw Object.assign(Error('已经往下做了，来不及先判断'), { status: 409 });
  const out = [];
  for (const c of started) { out.push(addStep({ ...c, status: 'cancelled', manual: true }, '改成先判断，这一棒等判断完再开', { who: 'you', at: now })); }
  for (const s of after) if (s.state === 'open') { s.state = 'planned'; s.card = null; }
  g.route[i] = { ...g.route[i], state: 'planned', why: '你改成了先判断' };
  // 前面都做完了：判断马上开卡。
  const prevOpen = g.route.slice(0, i).some(s => s.state === 'open' || s.state === 'planned');
  if (!prevOpen) {
    const card = makeCard({ kind: 'judge', leads: g.leads || [], owner: 'lens', from: { by: 'team', ...(g.from?.session_id ? { session_id: g.from.session_id } : {}) }, goal: g.id, auto: true, now });
    g.route[i].state = 'open'; g.route[i].card = card.id; out.push(card);
  }
  addStep(g, '你改成了先判断', { who: 'you', at: now });
  saveCards([g, ...out]);
  return g;
}

// 电脑上确认（「在这台电脑上运行」）：只清这一张卡的 mac_hold，记下谁、什么时候；下一次同步照常开跑。
// by：'you'（工作台）。手机网关不放行这个接口（lib/phone/gateway.mjs ROUTES），工作台也拒绝带 x-radar-phone 来的（bin/serve.mjs）。
export function releaseCard(id, { now = Date.now(), by = 'you' } = {}) {
  const c = findCard(id);
  if (!c.mac_hold) throw Object.assign(Error('这张卡不用在电脑上确认'), { status: 409 });
  if (TERMINAL.has(c.status)) throw Object.assign(Error('这张卡已经结束了'), { status: 409 });
  const label = c.mac_hold.label;
  c.mac_released = { at: iso(now), by, on: 'mac', label, ...(c.mac_hold.device ? { device: c.mac_hold.device } : {}) };
  delete c.mac_hold;
  c.tries = 0;
  addStep(c, `你在电脑上确认运行：${label}`, { who: 'you', at: now });
  saveCards([c]);
  return c;
}
// 上线之后建的、还没有卡的交办任务：补一张真卡（指向这条任务，状态照它推）。
// 卡号取任务 id 的前 12 位；两条任务前 12 位一样时（job_seed_long_1 / _2），后来的那张换成按整条 id 算的号，
// 不然两张卡同号互相顶掉，看板上一会儿是这张、一会儿是那张（第 2 轮新 40）。已经存下的卡号不变。
export function adoptJobs(jobs = [], cards = [], { now = Date.now() } = {}) {
  // old_job_id：迁到引擎做的卡原来指向的那条（lib/task-do.mjs migrateHanded），也算有卡了，不再补。
  const used = new Set(cards.flatMap(c => [c.links?.job_id, c.links?.old_job_id]).filter(Boolean)), taken = new Set(cards.map(c => c.id));
  const cardId = j => { const short = `t-${String(j.id).slice(0, 12)}`, id = taken.has(short) ? `t-${crypto.createHash('sha1').update(String(j.id)).digest('hex').slice(0, 14)}` : short; taken.add(id); return id; };
  return jobs.filter(j => j.id && !used.has(j.id) && !j.moved_to_card && !isOld(j) && !coveredJob(j, cards)).slice(0, 200).map(j => {
    const kind = JOB_CARD_KIND[j.kind] || 'ask';
    const c = makeCard({ kind, title: jobTitle(j), owner: memberOfJob(j), from: jobFrom(j), how: 'executor', links: { job_id: j.id, ...(j.kind === 'queue_auto_apply' ? { apply_at: j.created_at } : {}) }, now: T(j.created_at) || now });
    c.kind = kind; c.leads = j.record_id ? [{ rid: j.record_id, number: j.number ?? null, company: coName(j.company) || '', role: j.role || '' }] : [];
    c.id = cardId(j); c.adopted = true;
    return c;
  });
}

// ── 例行卡：定时周期每位成员每一步一张，同一轮重跑时更新那一张 ──────────────────────
export function routineId(run, stage, member) { return `cycle-${crypto.createHash('sha1').update(`${run}|${stage}|${member}`).digest('hex').slice(0, 10)}`; }
export function upsertRoutine({ cycle_run, stage, member, status = 'running', items = null, result = null, label = null, detail = null, now = Date.now() } = {}) {
  const all = readCards(), id = routineId(cycle_run, stage, member), cur = all.find(c => c.id === id);
  // 新的一天的这一步：前面几轮这一步没跑成、还开着的那几张不再开着（同一步只看最新那一轮，体检的重复卡不再攒，F 节第 5 条）。
  if (!cur) { const old = all.filter(c => c.routine && c.links?.stage === stage && c.owner === member && !['done', 'cancelled'].includes(c.status)).map(c => { const x = { ...c, status: 'cancelled', result: c.detail || c.result || null, detail: '' }; addStep(x, '后来又跑过了，这一轮的不再算', { who: member, at: now }); return x; }); if (old.length) saveCards(old); }
  const c = cur || { ...makeCard({ kind: STAGE_KIND[stage] || 'cycle', title: label || STAGE_LABEL[stage] || stage, owner: member, from: { by: 'cycle' }, links: { cycle_run, stage }, now }), id, routine: true };
  c.status = status; c.updated_at = iso(now);
  if (status === 'running' && !c.started_at) c.started_at = iso(now);
  if (status === 'done') c.done_at = iso(now);
  if (items) c.items = items;
  if (result) c.result = result;
  if (label) c.title = label;
  if (detail) c.detail = detail; // 没跑成的原因要和状态一起存：账在这次 saveCards 里就记下「失败 + 原因」，不能先记、后补
  saveCards([c]);
  return c;
}
// 定时周期跑完（bin/cycle.mjs）：每一步建或更新一张例行卡（一天一步一张，同一天再跑更新那一张），每一轮的结果记成卡上的一步
// （卡片「做了什么」里一行；不开对话）。没变化、跳过的那几步不建（目录里默认收起来，免得每轮几十张空卡）。results：周期的 results。
const ROUTINE_WORD = { changed: '有更新', sent: '发出了', prepared: '准备好了', error: '没跑成', degraded: '没跑全', failed: '没跑成', ok: '跑完了' };
export const stageLabel = stage => STAGE_LABEL[stage] || kindLabel(STAGE_KIND[stage]) || stage;
// 周期一步的结果（bin/cycle.mjs 的 results 一行）→ 账上那件活该怎么收：failed 带原因（说成人话，lib/say-error.mjs），
// done 带结果那一句。例行卡（cycleRoutines）和周期记账（lib/cycle-ledger.mjs）用同一份。
// 周期里一步的报错（lib/stage-runner.mjs 的原话）先认这两种，别的交给 errorReason：
//   「bin/x.mjs 超过 15 分钟未结束（ETIMEDOUT），已终止」→ 跑了 15 分钟没跑完，到点停下了（以前原样露出脚本名；超时也不再被当成「模型太久没回」）
//   「bin/x.mjs exit 1: <stderr 最后一行>」→ 看最后那一行
export function stageError(raw) {
  const m = String(raw || '');
  const late = /超过 (\d+ (?:分钟|秒))未结束/.exec(m);
  if (late) return `跑了 ${late[1]}没跑完，到点停下了`;
  const exit = /^\S+\.m?js exit \S+?(?:: (.*))?$/s.exec(m);
  if (exit) return exit[1] ? errorReason(exit[1]) : '中途出错停了';
  return errorReason(m);
}
export function stageOutcome(r = {}) {
  const label = stageLabel(r.stage), bad = ['error', 'degraded', 'failed'].includes(r.status);
  if (DISCOVERY_STAGES.has(r.stage) && Array.isArray(r.sources)) {
    const scan = discoveryOutcome([r]);
    if (scan.status === 'partial') return { state: 'done', label, word: '部分完成', summary: scan.text, counts: { ...scan.counts, partial: true } };
    if (scan.status === 'failed') return { state: 'failed', label, word: '没跑成', reason: scan.text };
  }
  const word = r.applied > 0 && !bad ? `排上 ${r.applied} 个投递` : r.status === 'no_change' ? '没有新的' : ROUTINE_WORD[r.status] || '跑完了';
  if (!bad) return { state: 'done', label, word, summary: `${label}：${r.review_summary || word}` };
  const e = (r.errors || [r.error]).filter(Boolean)[0], why = e ? stageError(typeof e === 'string' ? e : e.error || e.message || '') : '';
  const reason = why && !/原因在运行日志里|原因没写下来/.test(why) ? `${r.status === 'degraded' ? '没跑全' : '没跑成'}：${why}` : r.status === 'degraded' ? '没跑全：有几项出错，下一轮会再试' : '没跑成：中途出错停了';
  return { state: 'failed', label, word, reason: [reason, r.review_summary].filter(Boolean).join('；') };
}
// cycle：这一轮周期在账上的那件（lib/cycle-ledger.mjs openCycle）。例行卡就是那一步的子活（一件活一张卡）：卡改跟这一轮那一步的子活
// （jobs.rebind；同一天前一轮那件改名留作历史），卡的状态照它。没有子活（记账出错、演示数据）才由存卡另建一件。
export async function cycleRoutines(results = [], { now = Date.now(), day = null, cycle = null } = {}) {
  const run = day || new Date(now).toLocaleDateString('en-CA');
  const out = [];
  let kids = null;
  for (const r of results) {
    if (!r?.stage || ['skipped', 'no_change'].includes(r.status) || (!ROUTINE_WORD[r.status] && !(r.applied > 0))) continue;
    const kind = STAGE_KIND[r.stage], member = KINDS[kind]?.member || 'patch', o = stageOutcome(r), bad = o.state === 'failed';
    if (cycle) try { const step = (kids ??= J.list({ parent: cycle })).find(j => j.kind === r.stage); if (step) J.rebind(step.id, `card:${routineId(run, r.stage, member)}`); } catch (e) { console.error(`[jobs] 例行卡挂到${o.label}那一步出错：${e.message}`); }
    const c = upsertRoutine({ cycle_run: run, stage: r.stage, member, status: bad ? 'stuck' : 'done', result: o.summary, label: o.label, detail: bad ? o.reason : null, now });
    addStep(c, `这一轮${o.word}`, { who: member, at: now });
    saveCards([c]);
    out.push(c);
  }
  return out;
}

// ── 对话、指挥台里的「投 12」：卡就是动作那件活 ─────────────────────────────────────────
// 每个编号的投递就是 requestAction 刚建的那件活（一件活一张卡）。这条岗位已经有投递卡就挂到那张上（lib/task-ledger.mjs bindApplyHome），
// 没有才开一张、开的时候就挂上——以前这里另开一张跟着线索推的卡，补卡（adoptActionJobs）又给同一件活补一张，
// 同一时刻两张「#444 · 预填申请表 · 失败」（主会话实测 10-04 第 7 条）。rows：回执里排上的那几条（rid、number、company、role）。
// 开出来、挂上的卡在这里存好。→ 第一个编号的那张（对话里的小条指着它），或者 null。
export function applyCards(rows = [], { from = { by: 'you' }, now = Date.now() } = {}) {
  const cards = readCards(), save = [];
  let first = null;
  for (const x of rows) {
    const rid = x?.rid;
    if (!rid) continue;
    const j = J.list({ kind: ['prefill', 'submit'], target: `lead:${rid}`, limit: 1 })[0] || null;
    const mine = j && T(j.created_at) >= now - 10 * 60000 ? j : null; // 这一句刚批准的那件
    const owned = mine?.ref?.startsWith('card:') ? [...cards, ...save].find(c => cardRef(c) === mine.ref) : null; // 补卡已经给它补过了
    const home = owned || applyHome([...cards, ...save], rid);
    if (home) {
      const b = mine && !owned ? bindApplyHome(mine, home, { now }) : null;
      if (b) save.push(b);
      first ??= b || home;
      continue;
    }
    const card = makeCard({ kind: 'apply', leads: [x], owner: 'quill', from, links: { apply_at: iso(now) }, status: 'running', now });
    if (mine && !mine.ref) J.adopt(mine.id, { ref: cardRef(card) });
    save.push(card);
    first ??= card;
  }
  if (save.length) saveCards(save);
  return first;
}
// 同一条岗位的投递只出一张卡（主会话实测 10-04 第 7 条）：以前两个入口各开过一张的（对话里「投 12」开的、补卡补的），
// 列表上并成一张。目标里的那张、子任务不收（它们在目标、上一级底下）；单列的那几张留一张——这条岗位有目标里的投递卡就都收起来，
// 没有就留最近动过的。收起来的那几张记在留下那张的 merged 上，点它们的链接照样打得开。账和卡都不改。
export function foldSame(cards = []) {
  const key = c => c.kind === 'apply' && !c.legacy && c.status !== 'cancelled' && (c.leads || []).length === 1 ? String(c.leads[0].rid || `#${c.leads[0].number}`) : null;
  const groups = new Map();
  for (const c of cards) { const k = key(c); if (k) groups.set(k, [...(groups.get(k) || []), c]); }
  const hide = new Map();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const top = g.filter(c => !c.goal && !c.parent_task);
    const keep = g.find(c => c.goal || c.parent_task) || [...top].sort((a, b) => T(b.updated_at) - T(a.updated_at))[0];
    for (const c of top) if (c !== keep) hide.set(c.id, keep.id);
  }
  if (!hide.size) return cards;
  const merged = new Map();
  for (const [id, to] of hide) merged.set(to, [...(merged.get(to) || []), id]);
  return cards.filter(c => !hide.has(c.id)).map(c => (merged.has(c.id) ? { ...c, merged: merged.get(c.id) } : c));
}

// ── 给页面的查询 ──────────────────────────────────────────────────────────────
// q：{ owner, status, lead, goal, from, routine: '0'|'1', since, q }。今天以前做完的卡不给（since 给了按它）；做完的例行卡默认收起（folded 里只数数）。
export function queryTasks(cards, q = {}, { now = Date.now(), ctx = null } = {}) {
  const today = new Date(zonedTime(dayOf(now))); // 本地时区的今天零点（lib/tz.mjs），不按这台电脑的时区
  const since = q.since ? T(q.since) : 0;
  // 并进别的卡的那几张（merged_into，lib/task-upgrade.mjs）不单独列出来；点进去还看得到。
  const all = foldSame([...cards.filter(c => !c.merged_into), ...(ctx ? legacyCards(ctx.jobs, cards) : [])]);
  const lead = q.lead ? String(q.lead).replace(/^#/, '') : '';
  const text = String(q.q || '').trim().toLowerCase();
  // 搜编号（「444」「#444」）：只认对着这一条的卡，和标题、结果里完整的 #444——不连 #4441、「14:44」一起带出来（第 6 轮）。别的词照文字找。
  const num = /^#?\s*(\d{1,6})$/.exec(text)?.[1] || null, numRe = num ? new RegExp(`#\\s*${num}(?!\\d)`) : null;
  const textHit = c => num
    ? (c.leads || []).some(l => String(l.number) === num) || numRe.test(`${c.title || ''} ${c.result || ''}`)
    : [c.title, c.result, c.detail, ...(c.leads || []).map(l => `#${l.number} ${l.company} ${l.role}`)].join(' ').toLowerCase().includes(text);
  // member：成员页（接活的一头）就是按负责成员筛的同一份；目标卡看路线上现在那一棒。
  let out = all.filter(c => (!q.owner || c.owner === q.owner || (q.owner === 'unclaimed' && !c.owner)) && (!q.member || currentOwner(c) === q.member) && (!q.goal || c.goal === q.goal || c.id === q.goal) && (!q.from || c.from?.by === q.from)
    && (!lead || (c.leads || []).some(l => String(l.number) === lead || l.rid === lead)) && (!text || textHit(c)));
  const old = out.filter(c => TERMINAL.has(c.status) && T(c.done_at || c.updated_at) < since);
  out = out.filter(c => !old.includes(c));
  const routineDone = out.filter(c => c.routine && TERMINAL.has(c.status));
  const folded = q.routine === '1' ? 0 : routineDone.length;
  if (q.routine !== '1') out = out.filter(c => !routineDone.includes(c));
  out.sort((a, b) => T(b.updated_at) - T(a.updated_at));
  // 数字按筛状态之前算（六态，排队和在做分开数）：点了一个，别的数字还在。一件活算一个：目标卡算它自己，它下面的卡不另算。
  // status 也按六态筛（queued 连待认领一起）；active = 排队 + 在做（还没结束、也不等你）。
  const counts = Object.fromEntries(SIX.map(s => [s, 0]));
  for (const c of out) if (!c.goal && !c.parent_task) counts[sixOf(c.status)] += 1;
  if (q.status) out = out.filter(c => q.status === 'active' ? ['queued', 'running'].includes(sixOf(c.status)) : sixOf(c.status) === q.status || c.status === q.status);
  return { cards: out.filter(c => c.kind !== 'goal'), goals: out.filter(c => c.kind === 'goal'), counts, folded, earlier: old.filter(c => c.kind !== 'goal').length };
}
// 一张卡的全部：交接单文字、它的目标、同一个目标下的卡、对应的信。
export function cardDetail(id, cards, ctx) {
  const all = [...cards, ...legacyCards(ctx.jobs, cards)];
  const c = all.find(x => x.id === id);
  if (!c) throw Object.assign(Error('没有这张卡'), { status: 404 });
  const goal = c.kind === 'goal' ? c : c.goal ? all.find(x => x.id === c.goal) || null : null;
  const siblings = goal ? all.filter(x => x.goal === goal.id) : [];
  const parent = c.from?.card ? all.find(x => x.id === c.from.card) || null : null;
  const lite = x => x && { id: x.id, title: x.title, owner: x.owner, status: x.status, kind: x.kind, result: x.result || null };
  return { card: { ...c, handoff_text: handoffText(c.handoff), ask: c.ask || (c.links?.ask_id ? ctx.asks().find(a => a.id === c.links.ask_id) || null : null) }, goal: goal && { ...goal, route: goal.route }, siblings: siblings.map(lite), parent: lite(parent), next: (c.next || []).map(n => lite(all.find(x => x.id === n))).filter(Boolean) };
}
// 成员工作台的「任务」一栏：任务板按这位成员筛出来的卡（lib/crew-desk.mjs 用）。
export function memberCards(id, cards, { now = Date.now() } = {}) {
  const today = new Date(zonedTime(dayOf(now))); // 本地时区的今天零点（lib/tz.mjs），不按这台电脑的时区
  const mine = cards.filter(c => c.kind !== 'goal' && c.owner === id);
  const pick = st => mine.filter(c => st.includes(c.status));
  return {
    incoming: mine.filter(c => c.status === 'queued' && c.from?.by === 'member'),
    needs_you: pick(['needs_you']), running: pick(['running']), queued: mine.filter(c => c.status === 'queued' && c.from?.by !== 'member'), stuck: pick(['stuck']),
    passed: cards.filter(c => c.from?.by === 'member' && c.from.member === id && !TERMINAL.has(c.status)),
    done: mine.filter(c => c.status === 'done' && T(c.done_at || c.updated_at) >= today.getTime() && !c.routine),
  };
}
