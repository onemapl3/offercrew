// 任务板的接口（bin/serve.mjs 接进来，design/task-board/spec.md 附录 E）：
// 任务卡片（L 线 10-03，design/handoff/L-任务卡片-接口.md 第二节）加的：卡片、目录上的几个字段、新建一句话、改要求、派给谁收紧。
//   GET  /api/tasks?owner=&member=&status=&lead=&goal=&from=&routine=0|1&since=&q=   { cards, goals, counts, folded, earlier, members, model }
//                                         每一行加 status（六态）、state / word / tone（lib/status.mjs，页面只用这几个）、owner_name、lead_tag、need、origin_by；member：成员页
//   GET  /api/tasks/<id>                  一张卡的全部：交接单、步骤、对应的信、目标和同一目标下的卡
//   GET  /api/tasks/<id>/card             任务卡片（lib/task-card.mjs cardView）；手机也能看
//   POST /api/tasks                       { text, owner?, lead? }：说一句话，System 建议由谁做（lib/tasks.mjs createTask）→ { id, card }
//                                         老的 { title, kind, lead, owner, run }（手动建卡，不用模型）照旧
//   POST /api/tasks/<id>/edit             { requirement }：改要求，从下一步起生效 → { card }（新卡片）
//   POST /api/tasks/<id>/why              看原因：System 用这件活自己的事实答（lib/talk.mjs taskWhy）→ { content, why }
//   POST /api/tasks/<id>/move             { status: done|stuck|cancelled|unclaimed|queued, note }；Writer 的活「再试一次」照对话里那个按钮做
//                                         看板用 { column: queued|running|done|cancelled }，读 board.moves 知道哪些可移及原因；running 接真实开始/继续
//   POST /api/tasks/<id>/assign           { owner }：只接受卡片 assign.options 里的成员；fixed 的回 409
//   POST /api/tasks/<id>/run              脚本类的卡直接跑；要模型的卡没模型时返回原因
//   POST /api/tasks/<id>/answer           等你的卡：就是收件箱的 answerAsk（同一个 ask id）；目标停下来问你的：还投 / 不投了
//   POST /api/tasks/<id>/judge-first      路线上「改成先判断」
//   POST /api/tasks/<id>/release          电脑上确认：手机上开的、要开执行器或浏览器的那一棒（mac_hold）现在可以跑了。只在这台电脑上：
//                                         手机网关不放行，带 x-radar-phone 来的一律拒绝（opts.phone）

// 每次读之前先同步一次（推状态、接力、开工），同一时间只跑一次，1.5 秒内的重复读直接用上一次的结果。
import { coName } from './vocab.mjs';
import { lines, read } from './store.mjs';
import { sixOf, shownCard, taskTries, MAX_TRIES } from './task-chat.mjs';
import { syncTasks, viewTasks, queryTasks, judgeFirst, releaseCard, startCard, taskContext, cardDetail } from './tasks.mjs';
import { confirmPlan, createManual, createTask, editRequirement, controlCard, moveCard, assignCard, answerGoal, legacyResourceWait, DO } from './card-ops.mjs';
import { holdOnMac, saveCards, readCards, leadRef, leadOf, legacyCards } from './cards.mjs';
import { cardView, rowFields, boardOf, boardStart } from './task-card.mjs';
import { BOARD_CONTROLS, controlled } from './task-control.mjs';
import { syncCardJobs } from './task-ledger.mjs';
import { routePersona } from './talk-route.mjs';
import { writerChain } from './task-writer.mjs';
import { KINDS, CREW_IDS, crewMember, handlesKind } from './crew.mjs';
import { dispatchCommand } from './dispatch.mjs';
import { runOrQueue } from './ops.mjs';
import { modelState } from './chat.mjs';
import { relayLine, writerAnswer, writerTaskFromText, writerFollow } from './talk.mjs';
import { sayTask, addSubtask, subtaskLead } from './task-say.mjs';
import { updateHostJob } from './dispatch.mjs';
import { taskFailure } from './task-failure.mjs';
import { appSchedule, nextSchedule, MAIL_POLL_HOURS, mailPollScheduleText } from './app-schedule.mjs';
import { mailReader } from './capabilities.mjs';
import { TZ } from './tz.mjs';
import { sandboxed } from './sandbox.mjs';
import { resumeSavedPrefill } from './apply-resume.mjs';
import { jobOfCard } from './task-ledger.mjs';

// 这条岗位有没有已知的内推人（state/referrers.ndjson，找内推人那一步写的）。
const referrersFor = lead => lines('state/referrers.ndjson').filter(r => (r.record_id || r.lead_id) === (lead.record_id || lead.id || lead.rid) && r.status !== 'rejected');
// workers：() => 后台任务开着没有（bin/serve.mjs）；卡上写「后台任务关着，不会自动跑」要用。
export function taskDeps({ asks = () => [], workers = undefined, overrides = {} } = {}) {
  const d = { runOp: (op, o) => runOrQueue(op, o), dispatch: (t, o) => dispatchCommand(t, { origin: 'card', ...o }), referrersFor, model: modelState(), asks, workers, relayLine, ...overrides };
  // 卡片上的指令（lib/task-say.mjs）要用到的几条路：收件箱答信、改交办任务、Writer 照这句改 / 答它先问的。
  d.say ??= { answer: b => d.answer?.(b), hostJob: (id, a, o) => updateHostJob(id, a, o), writer: o => writerFollow(o, { writerModel: d.writerModel || null }), writerAnswer: o => writerAnswer(o, { writerModel: d.writerModel || null }) };
  return d;
}
// 投递、联系的确认框（web/command.js confirmPreview，指挥台和对话共用的那个）：投递的预览就是「投 N」不带确认时那一份（什么都不做）；
// 联系、贴链接的投递照岗位写一行。→ { needs_confirm, confirm_text, preview, plan }
async function confirmFor(g, text, deps = {}) {
  const l = g.lead, n = l?.number;
  if (g.type === 'apply' && n != null && deps.dispatch) {
    try { const r = await deps.dispatch(`投 ${n}`, { confirm: false }); if (r?.needs_confirm && r.preview) return { needs_confirm: true, confirm_text: text, preview: r.preview, plan: 'apply' }; } catch {}
  }
  const rows = l ? [{ number: n, company: coName(l.company), role: l.role || '', city: l.location || '', channel: g.type === 'contact' ? '找内推、写消息' : '', reason: '' }] : [];
  return { needs_confirm: true, confirm_text: text, preview: { kind: g.type === 'contact' ? 'contact' : 'queue_apply', rows, missing: [], ...(g.url && !l ? { url: g.url } : {}) }, plan: g.type };
}
let running = null, last = null;
export async function syncNow(deps) {
  if (last && Date.now() - last.at < 1500 && !deps?.force) return last.r;
  if (running) return running;
  running = syncTasks(deps).then(r => { last = { at: Date.now(), r }; return r; }).finally(() => { running = null; });
  return running;
}
export const forget = () => { last = null; };
const members = () => CREW_IDS.map(id => { const m = crewMember(id); return { key: id, name: m.name, face: m.face, group: m.group_label, plain: m.plain }; });
const kinds = () => Object.entries(KINDS).filter(([k]) => !['round', 'cycle'].includes(k)).map(([k, v]) => ({ key: k, label: v.label, member: v.member, how: v.how }));
// 不能手动建的那几类（跑一轮、周期）也有中文名：卡上、详情里不露 round、cycle 这种代号（10-02 开箱第 2 轮 N06）。
const kindLabels = () => Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label]));

export async function tasksGet(pathname, params = {}, deps) {
  const r = viewTasks(deps); // 只读：推状态、开工在排队循环里（lib/tasks.mjs settleTasks）
  if (pathname === '/api/tasks') {
    const q = queryTasks(r.cards, params, { ctx: r.ctx }), row = c => rowFields(c, { jobs: r.ctx.jobs, all: r.cards });
    const schedules = appSchedule({ mail: mailReader().worker === 'engine' }).map(s => ({ name: s.name, label: s.name === 'cycle' ? '团队周期' : '读招聘回信', schedule: s.hourly ? mailPollScheduleText() : (s.times || []).join('、'), times: s.times || null, hourly: !!s.hourly, hours: s.hourly ? MAIL_POLL_HOURS : null, timezone: TZ, next_at: nextSchedule(s, { tz: TZ }) }));
    return { ...q, schedules, cards: q.cards.map(row), goals: q.goals.map(row), members: members(), kinds: kinds(), kind_labels: kindLabels(), model: deps.model || { ok: true }, sandbox: sandboxed() };
  }
  const cm = /^\/api\/tasks\/([^/]+)\/card$/.exec(pathname);
  if (cm) return cardView(decodeURIComponent(cm[1]), { all: [...r.cards, ...legacyCards(r.ctx.jobs, r.cards)], asks: r.ctx.asks(), jobs: r.ctx.jobs });
  const id = decodeURIComponent(pathname.slice('/api/tasks/'.length));
  return { ...cardDetail(id, r.cards, r.ctx), members: members(), kind_labels: kindLabels(), model: deps.model || { ok: true } };
}
// 移动之前按这件活现在的状态核对（任务即对话 第六节、主会话 10-03）：
//   没做成的「再试一次」（放回排队）：同一件连着 MAX_TRIES 次没成就不再接，电脑和手机一样。
//   手机：只认没做成 → 再试一次、在做 → 撤回两种（lib/phone/gateway.mjs PHONE_MOVE 先挡一道），别的回电脑。
export function checkMove(id, status, { phone = false } = {}) {
  const all = readCards(), c = all.find(x => x.id === id);
  if (!c) return; // 没有这张卡：moveCard 自己报
  const st = sixOf((c.kind === 'goal' ? shownCard(c, all) : c).status);
  if (status === 'queued' && c.status === 'stuck' && !legacyResourceWait(c) && taskTries(c) + 1 >= MAX_TRIES) throw Object.assign(Error(`已经连着 ${taskTries(c) + 1} 次没做成，先看看原因`), { status: 409 });
  if (!phone) return;
  const ok = (status === 'queued' && c.status === 'stuck') || (status === 'cancelled' && ['queued', 'running'].includes(st)); // 排队不算在做，但一样撤得回
  if (!ok) throw Object.assign(Error(status === 'queued' ? '这件现在不是没做成，不用再试' : status === 'cancelled' ? '这件现在不在做，撤不了' : '回电脑处理'), { status: status === 'queued' || status === 'cancelled' ? 409 : 403 });
}
// Writer 的活没做成，「再试一次」：状态看的是对话里那几条 Writer 消息，放回排队没用——照对话里那个「再试一次」按钮做
// （同样的输入再做一次，连着 3 次没成不再接，lib/talk.mjs writerAnswer）。→ writerAnswer 的参数，或者 null（不是 Writer 的活）。
function writerRetry(id) {
  const c = readCards().find(x => x.id === id);
  if (!c?.links?.writer || c.status !== 'stuck' || !c.session_id) return null;
  const last = writerChain(read(`state/chat/${c.session_id}.json`, null), c.links.writer, c.links.writer_next).at(-1);
  return last ? { session_id: c.session_id, message_id: last.id, kind: 'resume_retry' } : null;
}
const boardStarting = new Set();
async function moveOnBoard(id, column, deps, opts) {
  if (opts.phone) throw Object.assign(Error('回电脑安排任务'), { status: 403 });
  const view = viewTasks(deps), c = view.cards.find(x => x.id === id);
  if (!c) throw Object.assign(Error('没有这张卡'), { status: 404 });
  const move = boardOf(c, view.cards).moves.find(x => x.column === column);
  if (!move) throw Object.assign(Error('没有这个任务状态'), { status: 400 });
  if (move.disabled) throw Object.assign(Error(move.reason), { status: 409 });
  if (BOARD_CONTROLS[column]) {
    const card = controlCard(id, { action: BOARD_CONTROLS[column] });
    forget();
    return { card, moved: true };
  }
  const plan = boardStart(c, view.cards), target = plan.task_id;
  if (!target || plan.reason) throw Object.assign(Error(plan.reason || '打开任务，查看下一步'), { status: 409 });
  if (boardStarting.has(target)) throw Object.assign(Error('这件任务正在开始，请稍等'), { status: 409 });
  boardStarting.add(target);
  try {
    if (controlled(c)) controlCard(c.id, { action: 'resume' });
    const child = readCards().find(x => x.id === target);
    if (controlled(child)) controlCard(target, { action: 'resume' });
    let result = {};
    if (plan.action === 'retry') {
      result = await tasksPost(`/api/tasks/${encodeURIComponent(target)}/move`, { status: 'queued' }, deps, opts);
      // Writer 和预填的重试有自己的确认/执行通道；其他类型放回排队后马上走原有开工入口。
      if (!child?.links?.writer && child?.kind !== 'apply') result = await tasksPost(`/api/tasks/${encodeURIComponent(target)}/run`, {}, deps, opts);
    } else if (plan.action !== 'existing') result = await tasksPost(`/api/tasks/${encodeURIComponent(target)}/${plan.action}`, {}, deps, opts);
    // 目标这一列由当前子任务决定：开工后立即记下真实汇总，后台暂停时也不用等下一轮才显示。
    if (c.kind === 'goal') {
      const current = viewTasks(deps), goal = current.cards.find(x => x.id === id);
      if (goal && !controlled(goal)) syncCardJobs([shownCard(goal, current.cards)], { goals: 'derived' });
    }
    const fresh = viewTasks(deps), shown = fresh.cards.find(x => x.id === id);
    const state = shown ? rowFields(shown, { all: fresh.cards }).state : null;
    const why = result.why || (state === 'queued' ? '已排队，轮到后开始' : state === 'waiting_you' ? shown?.detail || '还需要你处理一步，打开任务继续' : state === 'failed' ? shown?.detail || '没能开始，打开任务查看原因' : null);
    forget();
    return { ...result, card: shown || result.card, moved: true, ...(why ? { why } : {}) };
  } finally { boardStarting.delete(target); }
}
export async function tasksPost(pathname, body = {}, deps, { phone = false, limited = false, device = null } = {}) {
  forget();
  if (pathname === '/api/tasks' && typeof body.text === 'string') {
    const ctx = taskContext({ asks: deps.asks });
    const n = body.lead == null || body.lead === '' ? null : Number(String(body.lead).replace(/^#/, ''));
    const lead = n != null ? ctx.leads.find(l => l.number === n) : null;
    if (n != null && !lead) throw Object.assign(Error(`没有 #${n} 这条岗位`), { status: 400 });
    // 投递、联系：先回确认框要的预览（needs_confirm，和 /api/talk「投 1」同一个），带 confirm: true 再来一次才开目标（主会话 10-03）。
    const gate = confirmPlan(body.text.slice(0, 500), lead);
    if (gate && body.confirm !== true) return confirmFor(gate, body.text.slice(0, 500), deps);
    // 改简历、写求职信或自我介绍：Writer 自己做（和岗位页上起的一样，先问的几句进收件箱）；别的照规则建（createTask）。
    const w = lead || gate ? null : await writerTaskFromText(body.text.slice(0, 500), { writerModel: deps.writerModel || null });
    const card = w ? readCards().find(c => c.id === w.task) : createTask({ text: body.text.slice(0, 500), owner: body.owner || undefined, lead, suggest: t => routePersona(t), confirmed: !!gate });
    try { await syncNow({ ...deps, force: true }); } catch {} // 第一棒马上开跑（脚本通道忙就下一次同步再试）
    forget();
    return { id: card.id, card: readCards().find(c => c.id === card.id) || card };
  }
  if (pathname === '/api/tasks') {
    const ctx = taskContext({ asks: deps.asks });
    const n = body.lead == null || body.lead === '' ? null : Number(String(body.lead).replace(/^#/, ''));
    const lead = n != null ? ctx.leads.find(l => l.number === n) : null;
    if (n != null && !lead) throw Object.assign(Error(`没有 #${n} 这条岗位`), { status: 400 });
    const kind = body.kind && KINDS[body.kind] ? String(body.kind) : null;
    let card = createManual({ title: String(body.title || '').slice(0, 120), kind, lead: lead ? leadRef(lead) : null, owner: body.owner === undefined ? undefined : body.owner || null });
    if (body.run === true && card.owner) { card = await startCard(card, deps, ctx); saveCards([card]); }
    return { card };
  }
  const m = /^\/api\/tasks\/([^/]+)\/(move|assign|run|answer|judge-first|release|edit|why|say|subtask|resume-prefill)$/.exec(pathname);
  if (!m) throw Object.assign(Error('没有这个操作'), { status: 404 });
  const id = decodeURIComponent(m[1]), act = m[2];
  if (act === 'resume-prefill') {
    if (phone) throw Object.assign(Error('回电脑继续预填'), { status: 403 });
    const view = viewTasks(deps), card = view.cards.find(c => c.id === id);
    if (card?.status !== 'needs_you' || !card.resume_prefill) throw Object.assign(Error('这件任务现在不能直接继续预填，请刷新'), { status: 409 });
    const lead = leadOf(view.ctx, card.leads?.[0]), rid = lead?.record_id || lead?.id;
    const result = await resumeSavedPrefill(rid, { job_id: jobOfCard(card)?.id, origin: 'card' });
    if (!result.continued && lines('state/leads.ndjson').find(l => (l.record_id || l.id) === rid)?.auto_apply?.status === 'awaiting_batch_review') {
      // 当前材料与旧批准对不上：沿原任务的确认流程给新预览，不把旧回答链接挂回来。
      const { retryApplyCard } = await import('./apply-retry.mjs');
      await retryApplyCard(id, deps, { origin: 'card' });
    }
    forget();
    return result;
  }
  if (act === 'move') {
    if (body.column) return moveOnBoard(id, String(body.column), deps, { phone, limited, device });
    if (body.control) { if (phone) throw Object.assign(Error('回电脑安排任务'), { status: 403 }); const card = controlCard(id, { action: body.control }); forget(); return { card }; }
    const status = String(body.status || '');
    checkMove(id, status, { phone });
    if (status === 'done' && body.confirm !== true) return { ok: true, needs_confirm: true, preview: { kind: 'record', text: '确认这件事已经做完？标为完成会让后续步骤接着做。' } };
    const w = status === 'queued' ? writerRetry(id) : null;
    if (w) { const r = await writerAnswer(w); forget(); return { card: readCards().find(c => c.id === id), reply: r.reply }; }
    // 投递卡「再试一次」：真的再试——清掉线索上上一次的失败，经 requestAction('prefill') 在卡那件活上建一个新动作（lib/apply-retry.mjs）。
    if (status === 'queued' && readCards().find(c => c.id === id)?.kind === 'apply') {
      const { retryApplyCard } = await import('./apply-retry.mjs');
      const card = await retryApplyCard(id, deps, { phone: phone ? { device } : null });
      forget();
      return { card };
    }
    return { card: moveCard(id, { status, note: String(body.note || '').slice(0, 200) }) };
  }
  if (act === 'assign') return { card: assignCard(id, { owner: body.owner || null }) };
  if (act === 'edit') {
    if (phone) throw Object.assign(Error('回电脑处理'), { status: 403 });
    editRequirement(id, { requirement: typeof body.requirement === 'string' ? body.requirement : '' });
    const r = await syncNow({ ...deps, force: true });
    return { card: cardView(id, { all: r.cards, asks: r.ctx.asks(), jobs: r.ctx.jobs }) };
  }
  if (act === 'why') return taskFailure(id, readCards());
  // 卡片上的输入框：一句指令按这件活现在的状态办（lib/task-say.mjs）。没被允许交办的手机（limited）要开本机 AI 或浏览器的停在「回电脑确认」。
  if (act === 'say') {
    const shown = (await syncNow({ ...deps, force: true })).cards.find(c => c.id === id) || null;
    const say = deps.say || taskDeps({ overrides: deps }).say;
    const { reply } = await sayTask(id, String(body.text || ''), { shown, deps: say, limited, device });
    forget();
    const r = await syncNow({ ...deps, force: true });
    return { card: cardView(id, { all: [...r.cards, ...legacyCards(r.ctx.jobs, r.cards)], asks: r.ctx.asks(), jobs: r.ctx.jobs }), reply };
  }
  if (act === 'subtask') {
    const gate = confirmPlan(String(body.text || '').slice(0, 500), subtaskLead(id));
    if (gate && body.confirm !== true) return confirmFor(gate, String(body.text || '').slice(0, 500), deps);
    let sub = addSubtask(id, { text: String(body.text || '').slice(0, 500), owner: body.owner || undefined, suggest: t => routePersona(t), confirmed: !!gate });
    // 没被允许交办的手机：要开本机 AI 或浏览器的那一棒回电脑确认。子任务拆成目标的（找内推、投递……）：目标记上 mac_confirm，
    // 第一棒当场停，后面接力开的照目标的 from 一样停（lib/tasks.mjs macFrom）。
    if (limited) {
      const mark = c => holdOnMac({ ...c, from: { ...(c.from || {}), via: 'phone', mac_confirm: true, ...(device ? { device } : {}) } });
      const touched = readCards().filter(c => c.id === sub.id || (sub.kind === 'goal' && c.goal === sub.id)).map(mark);
      saveCards(touched); sub = touched.find(c => c.id === sub.id) || sub;
    }
    try { await syncNow({ ...deps, force: true }); } catch {}
    forget();
    return { id: sub.id, card: sub };
  }
  if (act === 'judge-first') return { card: judgeFirst(id) };
  if (act === 'release') {
    if (phone) throw Object.assign(Error('要在电脑上确认'), { status: 403 });
    const card = releaseCard(id);
    try { await syncNow({ ...deps, force: true }); } catch {} // 马上开跑（脚本通道忙就下一次同步再试）
    forget();
    return { card: readCards().find(c => c.id === id) || card, released: true };
  }
  const card = readCards().find(c => c.id === id);
  if (!card) throw Object.assign(Error(String(id).startsWith('job:') ? '旧记录只读' : '没有这张卡'), { status: 404 });
  if (act === 'run') {
    const k = KINDS[card.kind];
    if (!k || !card.owner) throw Object.assign(Error('先交给一位成员再跑'), { status: 409 });
    if (k.how === 'model' && !deps.model?.ok) return { card, ran: false, why: `要模型：${deps.model?.note || deps.model?.why || '现在没有能用的模型'}` };
    if (card.mac_hold) return { card, ran: false, why: '先在电脑上确认运行', mac_hold: card.mac_hold.label };
    if (card.links?.job_id) return { card, ran: false, why: '这件事已交到后台，等它领取' }; // 指向交办任务的卡（补出来的投递卡等）：再跑一次就是再批准一次
    const ctx = taskContext({ asks: deps.asks });
    const out = await startCard({ ...card, links: { ...card.links }, steps: [...(card.steps || [])], auto: DO.has(card.kind) }, deps, ctx);
    saveCards([out]);
    const ran = !!(out.links?.op_id || out.links?.apply_at || out.links?.do_at || out.links?.prep_at || out.links?.send_at || out.status === 'done');
    return { card: out, ran, why: ran ? null : out.detail || null };
  }
  // 答：目标停下来问你的就在卡上答；别的就是收件箱那一封（同一个 ask id，答完两边一起消失）。
  // 没被允许交办的手机答的：放行的下一棒照样停在电脑确认（lib/tasks.mjs answerGoal phone）。
  if (card.kind === 'goal' && card.halt && !card.halt.answered) return { card: answerGoal(id, String(body.option || ''), { phone: limited ? { device } : null, fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 200) : null }) };
  const ask = card.links?.ask_id || (await syncNow(deps)).cards.find(c => c.id === id)?.links?.ask_id;
  if (!ask || !deps.answer) throw Object.assign(Error('这张卡现在不用你答'), { status: 409 });
  return deps.answer({ ...body, id: ask });
}
export { handlesKind };
