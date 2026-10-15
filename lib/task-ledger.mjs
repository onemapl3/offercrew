import { ownerState, controlled } from './task-control.mjs';
// 任务卡和账（线 S）：一张卡就是一件活（jobs 里 ref = card:<卡 id> 的那一行），卡上给人看的状态只从那一行来。
//   写   卡存下来时（lib/tasks.mjs saveCards）按卡现在的样子经 jobs.drive 改那件活（只用转移表里的事件）；
//        卡还从旧记录推状态的那几类（deriveCard）只在排队循环里推（settle，bin/serve.mjs），不在读请求里推。
//   读   overlay(card)：把那件活的 { state, word, tone, reason } 盖到卡上；页面不自己换算。
import * as J from './jobs.mjs';
import { view } from './status.mjs';
import { waitReason } from './wait-reason.mjs';
import { needTitle, shortTitle } from './short-title.mjs';

const T = x => Date.parse(x || '') || 0;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const MEMBER = new Set(['scout', 'lens', 'tailor', 'quill', 'owl', 'patch']);

// 收录做完的那一句（bin/add-lead.mjs 记进账）：编号、还在不在招；判断没推荐的没有编号，照实说（09-30：卡上曾写「#undefined 收好了」）。
export function intakeResult(l = {}) {
  const tag = l.number != null ? `#${l.number} ` : '', none = l.number == null ? '（没推荐，还没编号）' : '';
  const closed = l.posting_closed === true || l.closed === true || !!l.closed_at;
  return closed ? `${tag}已下线${none}` : `${tag}收好了，还在招${none}`;
}

// ── 卡 → 活 ──────────────────────────────────────────────────────────────────
export const CARD_STATE = { unclaimed: 'queued', queued: 'queued', running: 'running', needs_you: 'waiting_you', stuck: 'failed', done: 'done', cancelled: 'cancelled' };
export const cardRef = c => `card:${c.id}`;
// 只有本机 AI 能做的那一步：收件箱里那封信的 id（lib/legacy-hands.mjs localAiAsks 同一个）。ref 是那件活的 ref（没有就用活的 id）。
export const localAiAskId = ref => `localai:${ref}`;
export function cardOrigin(c) {
  const f = c.from || {};
  if (f.via === 'phone' || f.mac_confirm) return 'phone';
  if (f.by === 'cycle') return 'schedule';
  if (f.by === 'repair' || f.by === 'member') return 'system';
  if (f.session_id) return 'chat';
  return 'card';
}
export const cardTarget = c => { const l = c.leads?.[0]; return l?.rid ? `lead:${l.rid}` : l?.number != null ? `lead#${l.number}` : c.url ? `url:${c.url}` : null; };
// 建这张卡的那件活要的字段。
export const cardSpec = (c, parent = null) => ({ kind: c.kind || 'ask', member: MEMBER.has(c.owner) ? c.owner : null, title: cut(c.title, 200), target: cardTarget(c), origin: cardOrigin(c), parent, ref: cardRef(c) });
// 这张卡现在的样子 → 活该在的状态和要带的话（失败的原因、等你的事、做完的结果）。
export function cardState(c) {
  // 待认领（没派给谁）、手机上开的要回电脑确认才跑（mac_hold）：都是在等你，不是「排着没人领」。
  if (c.status === 'unclaimed' || (c.status === 'queued' && c.mac_hold)) {
    const label = c.mac_hold ? '在电脑上确认运行' : '派给一位成员';
    return { state: 'waiting_you', data: { now: T(c.updated_at) || undefined, reason: c.mac_hold ? `在电脑上确认后才运行：${c.mac_hold.label}` : '还没派给谁', what: { label, href: `#tasks?card=${encodeURIComponent(c.id)}` } } };
  }
  const state = CARD_STATE[c.status] || 'queued';
  const data = { now: T(c.updated_at) || undefined };
  if (state === 'done') data.result = { summary: cut(c.result || (c.nothing_new ? '没有新的' : '做完了'), 200) };
  if (state === 'failed') data.reason = cut(c.detail || c.result || '原因没记下来', 200);
  // 只有本机 AI 能做的那一步（lib/task-do.mjs computerHold）：原因带码，等你的那件事是收件箱里那封信（lib/legacy-hands.mjs localAiAsks）。
  if (state === 'waiting_you' && c.wait === 'local_ai') {
    const w = c.wait_code === 'needs_local_ai' && c.detail ? { code: 'needs_local_ai', text: c.detail } : waitReason('needs_local_ai', { need: c.computer_need });
    data.reason = { code: w.code, text: cut(w.text, 400) };
    data.what = { label: cut(`这一步要${c.computer_need || '在这台电脑上操作'}，等你定怎么办`, 40), ask_id: localAiAskId(cardRef(c)) };
    return { state, data };
  }
  if (state === 'waiting_you') {
    data.reason = cut(c.detail || c.need_title || '要你看一下', 400);
    const label = cut(c.need_title || shortTitle(c.detail, { max: 40, ask: true }) || '去看看', 40);
    data.what = c.links?.ask_id ? { label, ask_id: c.links.ask_id } : { label, href: c.go?.href || (c.kind === 'send' ? '#inbox' : `#tasks?card=${encodeURIComponent(c.id)}`) };
  }
  return { state, data };
}


// 活的状态 → 卡上的旧状态码（还在读 card.status 的代码用；词和色调不从这里来）。
export const CARD_OF = { queued: 'queued', running: 'running', waiting_you: 'needs_you', failed: 'stuck', done: 'done', cancelled: 'cancelled' };
export const jobOfCard = c => c?.links?.ledger_id ? J.get(c.links.ledger_id) : (c?.id ? J.byRef(cardRef(c)) : null);

// 这张卡的那件活由别人带着走（一件活一个写的人）：操作台的运行（runOp 记账）、排队（op-queue 记账）、对外动作（lib/actions.mjs settle 带动）、
// 「怎么准备」和 Writer 写的那一侧（writesOwnJob）。
// 这种卡只照账（lib/tasks.mjs deriveCard），存卡时不拿卡上的状态去改那件活——只认你在卡上做的取消、再试一次。
// 例行卡跟的是周期那一步的子活（有父活，lib/cycle-ledger.mjs 记）：也只照账。
// 指着交办任务（links.job_id，旧版的 host-jobs）的卡：那条任务由 mirrorHostJobs 记进这张卡的活（bin/job.mjs 报结果时、排队循环里），卡也只照账。
export const driven = (c, j) => !!(c?.links?.ledger_id || c?.links?.op_id || c?.links?.queue_id || c?.links?.job_id || writesOwnJob(c) || (c?.routine && j?.parent) || (j && J.actionsOf(j.id).length));
// 写的那一侧直接记卡的那件活（不靠读的时候推）：「怎么准备」由写它的 Judge 记（lib/role-prep.mjs、lib/company-brief.mjs savePrep），
// Writer 由 lib/task-writer.mjs recordWriter 记。所以这两类卡也只照账。
const writesOwnJob = c => !!(c?.links?.writer || (c?.kind === 'prep' && c?.links?.prep_at));
// 发送卡（startCard 记了 send_at）等你在收件箱批准草稿：存卡时先记一件「等你批准」的活（卡上存的 needs_you），批准时对外动作建的那件
// 由 adoptActionJobs 挂到这张卡上、「等你批准」那件取消（bindHome），以后照账。

// 存卡时带着改那件活：没有就建（目标卡先，子卡挂在它下面），有就走到卡现在的状态。走不到的（做完了又放回排队）不改，记一笔。
// 目标卡：存下来的 status 是建卡、上次存时的旧值（接力、你答了一句时整张存回去），它的状态由下面的卡推（lib/tasks.mjs deriveGoal，
// syncTasks 最后用 goals: 'derived' 记）。所以存卡时目标只建那件活、只认你手动改的（取消、标完成这类 manual），
// 不拿旧 status 去改——以前每个目标接力时都报一次「想从 running 改成 queued，走不到」（线 F，10-04）。
export function syncCardJobs(list = [], { goals = 'stored' } = {}) {
  const order = [...list.filter(c => c.kind === 'goal'), ...list.filter(c => c.kind !== 'goal')];
  const out = [];
  for (const c of order) {
    if (!c?.id || c.legacy || c.links?.ledger_id || controlled(c)) continue;
    try {
      let j = J.byRef(cardRef(c));
      const fresh = !j; // 刚建的：照卡现在的样子记一次（补记旧卡），以后才只照账
      if (!j) j = J.create({ ...cardSpec(c, c.goal ? J.byRef(`card:${c.goal}`)?.id || null : null), now: T(c.created_at) || Date.now() });
      else if (j.title !== cut(c.title, 200) || (MEMBER.has(c.owner) ? c.owner : null) !== j.member) j = J.annotate(j.id, { title: cut(c.title, 200), member: MEMBER.has(c.owner) ? c.owner : null });
      if (c.kind === 'goal' && goals === 'stored' && !fresh && !c.manual && c.status !== 'cancelled') { out.push(j); continue; }
      const { state, data } = cardState(c);
      // 做完 / 取消了又放回排队（重新打开、再跑一轮）：另起一件（jobs.again），卡跟着新的这件。
      if (!driven(c, j) && (state === 'queued' || state === 'running') && ['done', 'cancelled'].includes(j.state)) j = J.again(j.id) || j;
      if (!fresh && driven(c, j) && !(state === 'cancelled' || (state === 'queued' && j.state === 'failed' && T(c.retried_at) > T(j.finished_at)))) { out.push(j); continue; }
      // 看门判了失败（排太久没人领、进程没了）：卡上推出来的还是「排着 / 在做」时不自己翻回去，等你点「再试一次」（moveCard 记 retried_at）
      // 或者 System 照标准做法放回去（card.retry）。不然看门判一次、下一轮又排回去，来回翻。
      if (j.state === 'failed' && (state === 'queued' || state === 'running') && /^watch:/.test(J.events(j.id).at(-1)?.data?.note || '') && !(Math.max(T(c.retried_at), T(c.retry?.at)) > T(j.finished_at))) { out.push(j); continue; }
      // 记在卡上那一刻（推出来的 at 会推进 updated_at），不早于这件活上一次改、不晚于现在：补记的旧卡不显示成「刚刚」。
      const at = Math.min(Date.now(), Math.max(data.now || 0, T(j.updated_at))) || Date.now();
      const moved = J.drive(j.id, state, { ...data, now: at });
      if (!moved) console.error(`[jobs] 卡 ${c.id} 想从 ${j.state} 改成 ${state}，转移表里走不到，没改`);
      out.push(moved || j);
    } catch (e) { console.error(`[jobs] 卡 ${c.id} 记账出错：${e.message}`); }
  }
  return out;
}

// 读：卡上盖那件活的状态。没有那一行（还没记账）就照卡自己存的，不另推。
export function overlay(c, job = jobOfCard(c)) {
  if (controlled(c)) { c = ownerState(c); const state = CARD_STATE[c.status], v = view({ state, reason: c.detail, result: { summary: c.result } }); return { ...c, state, word: c.owner_control.action === 'todo' || c.owner_control.action === 'later' ? '待做' : v.word, tone: v.tone, reason: c.detail }; }
  if (!job) { const { state, data } = cardState(c), v = view({ state, ...data }); return { ...c, state: v.state, word: v.word, tone: v.tone, reason: v.reason }; }
  const v = view(job), x = { ...c, job_id: job.id, state: v.state, word: v.word, tone: v.tone, reason: v.reason };
  // 待认领、回电脑确认的卡：账上是「等你」，卡上的旧状态码留着（派人、「在这台电脑上运行」按钮认它）。
  x.status = job.state === 'waiting_you' && (c.status === 'unclaimed' || (c.status === 'queued' && c.mac_hold)) ? c.status : CARD_OF[job.state];
  if (job.state === 'failed' || job.state === 'waiting_you') x.detail = job.reason || x.detail;
  if (job.state === 'done' && job.result?.summary) x.result = job.result.summary;
  if (job.what?.ask_id) x.links = { ...(x.links || {}), ask_id: job.what.ask_id };
  if (job.state === 'waiting_you' && job.what?.label) {
    const self = job.what.href?.startsWith('#tasks') && !job.what.ask_id;
    x.what = self && /…|\.\.\./.test(job.what.label) && job.reason ? { ...job.what, label: shortTitle(job.reason, { max: 40, ask: true }) } : job.what;
  }
  return x;
}

// ── 没挂卡的对外动作 → 补一张卡 ─────────────────────────────────────────────────
// 收件箱、对话、手机上批准的对外动作（lib/actions.mjs requestAction 自己建的那件活，ref 空着）：任务页上也要有它的一张卡，只有一张。
//   发送：这条岗位有一张等着批准的发送卡（目标里那一棒）就挂到它上面；没有就补一张。
//   预填、提交：这条岗位已有投递卡就让卡改跟这件（终审提交另起的那件也是），没有才补一张。
//   读信：补一张，卡照那件活的账走。
// 定时、系统自己起的（周期里读信这类）不补：它们在周期那件活下面，有自己的例行卡。只看最近两天的。
// makeCard 由调用方（lib/tasks.mjs）传进来，免得两个模块互相引用。返回要存的卡（新补的，和改跟了新那件的投递卡）。
const ACTION_CARD = { send_email: 'send', send_dm: 'send', prefill: 'apply', submit: 'apply', read_mail: 'mail' };
const FROM = { inbox: { by: 'you', via: 'inbox' }, chat: { by: 'you', via: 'chat' }, phone: { by: 'you', via: 'phone' }, card: { by: 'you', via: 'tasks' } };
export function adoptActionJobs(cards, { makeCard, leadOf = () => null, now = Date.now() } = {}) {
  const out = [];
  for (const j of J.list({ kind: Object.keys(ACTION_CARD), unbound: true, origin: Object.keys(FROM), since: now - 2 * 86400000, limit: 200 }).reverse()) { // 先来的先挂：预填在前、提交在后
    try {
      const a = J.actionsOf(j.id)[0], rid = a?.payload?.record_id || (String(j.target || '').startsWith('lead:') ? j.target.slice(5) : null);
      const kind = ACTION_CARD[j.kind];
      const waiting = kind === 'send' && rid && [...cards, ...out].find(c => c.kind === 'send' && c.links?.send_at && !['done', 'cancelled'].includes(c.status) && (c.leads || []).some(l => l.rid === rid) && !J.actionsOf(J.byRef(cardRef(c))?.id).length);
      if (waiting) { const b = bindHome(j, waiting, { now }); if (b) { out.push(b); continue; } }
      // 预填、提交：一个岗位的投递是一张卡。这条岗位已有投递卡、它跟的那件已经停了（预填做完等终审、失败、做完）：
      // 卡改跟这件新的（jobs.rebind，道理和 again 一样），卡上的状态就是最新那件的；不另补一张「提交 #N」。
      // 那张卡的活还开着（排着、在做、等你）就不抢，照旧补一张——两件都在动，各看各的。
      // 那张卡的活只是建卡时记的一件、没挂过动作（对话里「投 12」开的卡、等你确认这一版的卡）：也改跟这件，建卡时那件取消（bindApplyHome）。
      const home = kind === 'apply' && rid && applyHome([...cards, ...out], rid);
      if (home) { const b = bindApplyHome(j, home, { now }); if (b) { out.push(b); continue; } }
      const lead = rid ? leadOf({ rid }) || { rid, number: a?.payload?.number ?? null } : null;
      // 投递卡和别的投递卡一个叫法（「#12 Relecloud · 预填申请表」，makeCard 按岗位起），不用动作那件的「预填 #12 …」。
      const c = makeCard({ kind, title: kind === 'apply' && lead?.company ? '' : j.title, leads: lead ? [lead] : [], owner: MEMBER.has(j.member) ? j.member : undefined, from: FROM[j.origin], now: T(j.created_at) || now });
      if (J.adopt(j.id, { ref: cardRef(c) })) out.push({ ...c, adopted: true });
    } catch (e) { console.error(`[jobs] 给动作 ${j.id} 补卡出错：${e.message}`); }
  }
  return out;
}

// 这条岗位的投递卡（一个岗位的投递是一张卡）：没取消的、最新开的那张。
export const applyHome = (cards, rid) => cards.filter(c => c.kind === 'apply' && !c.legacy && c.status !== 'cancelled' && (c.leads || []).some(l => l.rid === rid)).sort((a, b) => T(b.created_at) - T(a.created_at))[0] || null;
// 预填、提交那件活挂到这张投递卡上（一件活一张卡，主会话实测 10-04 第 7 条：同一时刻两张「#444 · 预填申请表 · 失败」）。
//   卡还没有活、或者它那件已经停了（做完、失败、取消）：卡改跟这件（jobs.rebind，道理和 again 一样）。
//   卡那件活还开着、可从没挂过动作（建卡时记的一件：对话里「投 12」开的卡、等你确认这一版的卡）：那件取消，卡改跟这件。
//   卡那件活自己挂着动作、还没停（另一份批准在跑）：不抢，返回 null；列表上同一个岗位的两张并成一张（lib/tasks.mjs foldSame）。
// → 挂好的卡（记上 apply_at：这件已经开跑，同步时不再替它发一次「投」；等你确认这一版的那一问也收掉），或者 null。
export const bindApplyHome = (j, home, opts) => bindHome(j, home, { ...opts, apply: true });
// 同上，不分投递和发送：发送卡批准前那件「等你批准」的活也是建卡时记的一件、没挂动作（取消，卡改跟发送那件）。
//   卡那件活停在等你提交（预填做完，what 指着终审 / 预填好了那封信，lib/workers.mjs）：提交那件来了，预填这一件就算做完，卡改跟提交那件。
export function bindHome(j, home, { now = Date.now(), apply = false } = {}) {
  const ref = cardRef(home), parent = home.goal ? J.byRef(`card:${home.goal}`)?.id || null : null;
  let was = J.byRef(ref);
  if (was && was.id !== j.id && was.state === 'waiting_you' && /^(final|prefilled):/.test(was.what?.ask_id || '')) {
    try { was = J.drive(was.id, 'done', { result: { summary: '预填好了，交给提交那一步' }, now }) || was; } catch (e) { console.error(`[jobs] 卡 ${home.id} 预填那件没收尾：${e.message}`); return null; }
  }
  if (was && was.id !== j.id && !['done', 'failed', 'cancelled'].includes(was.state)) {
    if (J.actionsOf(was.id).length) return null;
    try { J.drive(was.id, 'cancelled', { reason: apply ? '并进了这张卡上的投递' : '你批准了，交给发送那一步', note: `merged:${j.id}`, now }); } catch (e) { console.error(`[jobs] 卡 ${home.id} 建卡时那件没取消：${e.message}`); return null; }
  }
  if (was?.id !== j.id && !J.rebind(j.id, ref, { parent })) return null;
  const c = { ...home, links: { ...(home.links || {}) } };
  if (apply) c.links.apply_at ||= j.created_at || new Date(now).toISOString();
  if (c.confirm_wait) { delete c.confirm_wait; delete c.need_title; if (c.links.ask_id === `goal:${c.id}`) delete c.links.ask_id; }
  return c;
}

// 卡改跟一件已经在动的活（线 R 10-04）：任务卡发「投 N」时这条线索已经有一条开着的动作、挂在别的活上（requestAction 回 duplicate），
// 或者旧版的投递卡（升级收尾，lib/apply-retry.mjs）。那件活没挂卡、或者挂的就是这张：改跟它（jobs.rebind）→ 'mine' | 'moved'；
// 挂在另一张卡上：不抢 → 'other'。活不在 → null。
export function followJob(c, jobId) {
  if (!c?.id || !jobId) return null;
  const j = J.get(jobId);
  if (!j) return null;
  if (j.ref === cardRef(c)) return 'mine';
  if (String(j.ref || '').startsWith('card:')) return 'other';
  return J.rebind(jobId, cardRef(c), { parent: c.goal ? J.byRef(`card:${c.goal}`)?.id || null : null }) ? 'moved' : null;
}

// ── 写的那一侧记卡的活：按种类和目标找 ─────────────────────────────────────────────
// 「怎么准备」（kind prep，target lead:<rid>）写的人不知道是哪张卡起的、也可能是周期或者执行器在写：这条岗位上排着、在做的卡的活
// 都跟着这一次写走（开写 running、写好 done、没写成 failed）。不是卡的活（ref 不是 card:）不碰。记账出错只打一行，不挡写。
export function moveCardJobs({ kind, target }, to, data = {}) {
  if (!kind || !target) return [];
  const out = [];
  try {
    for (const j of J.list({ kind, target, state: ['queued', 'running'] })) {
      if (!String(j.ref || '').startsWith('card:')) continue;
      try { const m = J.drive(j.id, to, { now: Date.now(), ...data }); if (m) out.push(m); } catch (e) { console.error(`[jobs] ${j.id} 记成 ${to} 出错：${e.message}`); }
    }
  } catch (e) { console.error(`[jobs] 找 ${kind} ${target} 的卡出错：${e.message}`); }
  return out;
}

// ── 交办任务（旧版的 host-jobs）→ 卡的那件活 ──────────────────────────────────────────
// 本机 AI 经 bin/job.mjs 报进度、别处改交办任务（取消、补一句）时，指着它的卡（links.job_id）那件活跟着记一笔；卡只照账（deriveCard 不再读 host-jobs）。
// bin/job.mjs 报完就记；排队循环里（lib/tasks.mjs syncTasks）再对一遍，盖住还在直接写文件的旧写法。重复记不出事：同一个状态、同一句原因不动。
// running：工作台「马上跑」正在跑的那几条交办任务（state/run-now.json job_ids），排着的算在做。
const HOST_STATE = { pending: 'queued', working: 'running', waiting_user: 'waiting_you', blocked: 'failed', completed: 'done', done: 'done', dropped: 'cancelled' };
// 等你的那封信：执行器用 need 报的那一种（need:job:<id>:<kind>），只有登录的就是登录那封，老样子（只有一句话）是 job:<id>。
export function hostJobAsk(h) {
  const needs = (h.needs || []).filter(Boolean), n = needs.find(x => x.kind !== 'login'), login = needs.find(x => x.kind === 'login');
  if (n) return { ask_id: `need:job:${h.id}:${n.kind}`, label: needTitle(n) || '回答' }; // 不是登录的那一种：和 lib/needs.mjs needShort 同一句（账号名只有登录才用）
  if (login) return { ask_id: `login:${login.account}`, label: `登录 ${login.account}` };
  return { ask_id: `job:${h.id}`, label: '回答' };
}
const firstLine = s => cut(String(s || '').split('\n')[0], 140);
export function mirrorHostJobs(hostJobs = [], cards = [], { running = [], now = Date.now() } = {}) {
  const byId = new Map(); for (const h of hostJobs) if (h?.id) byId.set(h.id, h);
  const out = [];
  for (const c of cards) {
    const h = c?.links?.job_id && byId.get(c.links.job_id);
    if (!h || c.legacy || c.manual || c.kind === 'goal' || c.status === 'cancelled') continue;
    const want = running.includes(h.id) && h.status === 'pending' ? 'running' : HOST_STATE[h.status];
    if (!want) continue;
    try {
      let j = J.byRef(cardRef(c)) || J.create({ ...cardSpec(c, c.goal ? J.byRef(`card:${c.goal}`)?.id || null : null), now: T(c.created_at) || now });
      const q = typeof h.waiting_user === 'string' ? h.waiting_user : h.waiting_user?.question || h.required_action;
      const data = { now: Math.min(Date.now(), Math.max(T(h.updated_at || h.completed_at), T(j.updated_at))) || now };
      if (want === 'done') data.result = { summary: firstLine(h.result) || '做完了' };
      if (want === 'failed') data.reason = firstLine(h.blocked_reason || h.result) || '交办任务停下了，没写停在哪';
      if (want === 'waiting_you') { const a = hostJobAsk(h); data.reason = cut(q, 400) || a.label; data.what = { label: cut(a.label, 40), ask_id: a.ask_id }; }
      if (want === 'cancelled') data.reason = '交办任务撤回了';
      if (want === j.state && want !== 'waiting_you') continue;
      if (['done', 'cancelled'].includes(j.state) && !['done', 'cancelled'].includes(want)) j = J.again(j.id, { now: data.now }) || j; // 做完了又被放回去（重新打开）：另起一件
      const moved = J.drive(j.id, want, data);
      if (!moved) console.error(`[jobs] 交办任务 ${h.id} 想把卡 ${c.id} 从 ${j.state} 记成 ${want}，转移表里走不到，没改`);
      else if (moved !== j) out.push(moved);
    } catch (e) { console.error(`[jobs] 交办任务 ${h.id} 记账出错：${e.message}`); }
  }
  return out;
}
