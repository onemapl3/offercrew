import { receiptCards } from './task-receipt.mjs';
import { TASK_CHOICES } from './task-control.mjs';
// 卡上的那几下（第 4 步收口，按卡的一生分层：cards 之上、开工之下）：按一句话建卡排路线（planTalk、startGoal、createTask），
// 挪卡、换人、改要求，答目标停下来问的那一问，确认开始预填。这些都不开工：真开跑在 lib/tasks.mjs（startCard、syncTasks）。
// 各成员的活（task-say 这类）引这一层，不引 lib/tasks.mjs。
import { specOf, listActions, cancel as cancelAction } from './actions.mjs';
import { lastRev, TERMINAL, iso, cut, coName, applyQuestion, readCards, saveCards, legacyCards, leadRef, makeCard, holdOnMac, macFrom, addStep, currentOwner, assignOf, leadInText } from './cards.mjs';
import { KINDS, crewOf, crewName, handlesKind, kindLabel, isMember } from './crew.mjs';
import { cancelQueued } from './op-queue.mjs';
import { lines, writeLines, read, write } from './store.mjs';
import { taskIntent } from './intent.mjs';
import * as J from './jobs.mjs';
import { jobOfCard, overlay, mirrorHostJobs } from './task-ledger.mjs';
import { requestRunNow } from './run-now.mjs';
import { localToolNeed, taskText } from './task-tools.mjs';

// ── 交接单（config/crew/shared.md 第 3 节的格式）──────────────────────────────
export const NEXT = {
  judge: '判断值不值得投；判断为排除时停下来问你',
  tailor: '对照 JD 改一版简历，每一句都要在原简历里找得到出处',
  apply: '找内推；没有就预填官网表单，停在提交前，你在页面上提交',
  referrers: '按猎头 → HR → 招聘经理 → 员工的顺序找内推人',
  draft: '写一条消息，发之前给你看',
  send: '你批准过的，按原样发出',
  research: '调研这家公司：业务、团队、最近的动静',
  prep: '写「怎么准备」：必考题和要补的点',
};
export function makeHandoff({ from, to, kind, lead = null, known = '', evidence = [], next = null, files = [], job_id = '', requirement = null }) {
  return {
    from, to, what: kindLabel(kind), job_id: job_id || '', ...(requirement ? { requirement } : {}),
    lead: lead ? `#${lead.number ?? '—'} · ${coName(lead.company)} · ${lead.role || ''}${lead.source ? ` · 来源 ${lead.source}` : ''}` : '',
    jd: lead ? `state/leads.ndjson · #${lead.number ?? '—'} 的 jd_text` : '',
    known: [known, evidence.length ? `（证据 ${evidence.join('，')}）` : ''].filter(Boolean).join(''),
    next: next || NEXT[kind] || kindLabel(kind), files,
  };
}
// 给人和短会话看的那一段：和岗位说明书里的一字不差（字段名、顺序、缩进）。
export function handoffText(h) {
  if (!h) return '';
  return [`交接单  ${crewName(h.from) || '你'} → ${crewName(h.to)}`, `  事：${h.what}      任务 id：${h.job_id || ''}`, `  线索：${h.lead || ''}`, `  JD 全文：${h.jd || ''}`, `  已经知道的：${h.known || ''}`, `  下一步：${h.next || ''}${h.requirement ? `（你的要求：${h.requirement}）` : ''}`, `  要用的文件：${(h.files || []).join(' ')}`].join('\n');
}

// ── 你说的话 → 目标和路线（规则，不靠模型）──────────────────────────────────────
// 这句话要开哪类活只在 lib/intent.mjs taskIntent 认（4a）；这里按认出来的那一类排路线。认不出就是 null（交给原来的分派）。
export function planTalk(text, { lead = null, tailoring = false, member = null } = {}) {
  const t = taskIntent(text, { lead, member });
  if (!t) return null;
  const { number, url } = t;
  if (t.intent === 'apply') {
    const route = [];
    if (url && !lead) route.push({ kind: 'intake', owner: 'scout', state: 'planned' });
    route.push({ kind: 'judge', owner: 'lens', state: t.judge_first ? 'planned' : 'skip', why: t.judge_first ? '' : '你已经说了要投，先跳过' });
    if (tailoring) route.push({ kind: 'tailor', owner: 'tailor', state: 'planned' });
    route.push({ kind: 'apply', owner: 'quill', state: 'planned' });
    return { type: 'apply', url, number, route, title: '投递' };
  }
  if (t.intent === 'contact') return { type: 'contact', number, url, title: '联系', route: [{ kind: 'referrers', owner: 'quill', state: 'planned' }, { kind: 'draft', owner: 'quill', state: 'planned' }, { kind: 'send', owner: 'quill', state: 'planned' }] };
  if (t.intent === 'research' || t.intent === 'prep') return { type: 'research', number, url, title: kindLabel(t.intent), route: [{ kind: t.intent, owner: 'lens', state: 'planned' }] };
  if (t.intent === 'resume' || t.intent === 'letters') return { type: 'materials', number, url, title: kindLabel(t.intent), route: [{ kind: t.intent, owner: 'tailor', state: 'planned' }] };
  if (t.intent === 'intake') return { type: 'intake', url, ...(t.email ? { email: t.email } : {}), number: null, title: '收录', route: [{ kind: 'intake', owner: 'scout', state: 'planned' }] };
  return null;
}
// 开一个目标（或者单独一张卡）：路线上第一棒真的开卡，后面的先画成虚线（planned）。
// origin：{ session_id, message_id, member }——接力那一行记回这个对话。single：单独跟一位成员说时不拆，只开一张卡。
export function startGoal(plan, { lead = null, origin = {}, text = '', now = Date.now(), single = false } = {}) {
  // origin.phone：{ device }——没被允许交给执行器的手机上说的，这件事里要开执行器、开浏览器的每一棒都停下等电脑确认。
  const from = { by: origin.member ? 'you' : 'team', ...(origin.session_id ? { session_id: origin.session_id, message_id: origin.message_id || null } : {}), ...(origin.member ? { member: origin.member } : {}), ...(origin.phone ? macFrom({ mac_confirm: true, device: origin.phone.device || null }) : {}) };
  const leads = lead ? [lead] : [];
  const first = plan.route.find(s => s.state === 'planned');
  if (single || plan.route.length === 1) {
    const card = makeCard({ kind: first.kind, leads, owner: origin.member && handlesKind(origin.member, first.kind) ? origin.member : first.owner, from: { ...from, by: 'you' }, auto: true, url: first.kind === 'intake' ? plan.url : null, email: first.kind === 'intake' ? plan.email || null : null, now, title: first.kind === 'intake' && !lead ? `收录并核验 · ${cut(plan.url, 60)}` : undefined });
    holdOnMac(card, card.from, now);
    saveCards([card]);
    return { goal: null, card };
  }
  const gtitle = `${plan.title} ${lead ? `#${lead.number} ${coName(lead.company)}${lead.role ? ` · ${lead.role}` : ''}` : plan.url ? cut(plan.url.replace(/^https?:\/\//, ''), 48) : ''}`.trim();
  const goal = makeCard({ kind: 'goal', title: gtitle, leads, owner: 'team', from, route: plan.route.map(s => ({ ...s, card: null })), now, url: plan.url || null, note: cut(text, 200) });
  const card = makeCard({ kind: first.kind, leads, owner: first.owner, from: { ...from, by: 'you' }, goal: goal.id, auto: true, url: first.kind === 'intake' ? plan.url : null, email: first.kind === 'intake' ? plan.email || null : null, now, title: first.kind === 'intake' && !lead ? `收录并核验 · ${cut(plan.url, 60)}` : undefined });
  holdOnMac(card, card.from, now);
  const step = goal.route.find(s => s === goal.route[plan.route.indexOf(first)]);
  step.state = 'open'; step.card = card.id;
  saveCards([goal, card]);
  return { goal, card };
}

// ── 跑一张卡 ──────────────────────────────────────────────────────────────────
export const DO = new Set(['ask', 'research', 'interview']); // lib/task-do.mjs DO_KINDS
// 新建一句话会按哪条路线开（createTask 和「先确认」confirmPlan 同一套）：话里的「#1」对上库里的那一条就是这件活的岗位。
export function taskPlan(raw, lead = null) {
  if (!lead) lead = leadInText(raw); // 话里写了「#1」：这件活就关联那一条岗位（卡头、目录上和别的活一样有岗位）
  let plan = lead ? planTalk(`${raw} #${lead.number}`, { lead }) || planTalk(raw, { lead }) : planTalk(raw);
  if (plan && !lead && plan.number != null) plan = null; // 话里的编号对不上库里的哪一条：当一句交代的事，不开空路线
  return { plan: plan && plan.type !== 'materials' && (lead || plan.url) ? plan : null, lead };
}
// 任务页新建的投递、联系要你先确认（主会话 10-03，和对话里「投 1」同一个确认框）：→ { type: 'apply' | 'contact', lead, url } 或 null。
export function confirmPlan(text, lead = null) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const t = taskPlan(raw, lead);
  return t.plan && ['apply', 'contact'].includes(t.plan.type) ? { type: t.plan.type, lead: t.lead, url: t.plan.url || null } : null;
}

// ── 你手动做的：建卡、挪卡、换人、成员给同事开卡、改成先判断、答目标的问题 ──────────────
export function createManual({ title = '', kind = null, lead = null, owner = undefined, now = Date.now() } = {}) {
  if (!String(title).trim() && !kind) throw Error('写一句要做什么，或者选一类事');
  if (owner && owner !== null && !isMember(crewOf(owner))) throw Error('没有这位成员');
  const card = makeCard({ kind: kind && KINDS[kind] ? kind : null, title: String(title).trim() || undefined, leads: lead ? [lead] : [], owner: owner === '' ? null : owner, from: { by: 'you' }, now });
  if (!kind) card.kind = 'ask';
  saveCards([card]);
  return card;
}
// confirmed：你在确认框里点了确认（投递、联系），目标直接开第一棒，不再停下来问一遍；没确认的投递照旧先停下来问你（子任务、命令行）。
export function createTask({ text = '', owner = undefined, lead = null, suggest = () => null, confirmed = false, now = Date.now() } = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) throw Object.assign(Error('写一句要做成什么'), { status: 400 });
  if (owner != null && owner !== '' && !isMember(crewOf(owner))) throw Object.assign(Error('没有这位成员'), { status: 400 });
  const from = { by: 'you', via: 'tasks' };
  const tp = taskPlan(raw, lead), plan = tp.plan;
  lead = tp.lead;
  if (plan) {
    const ref = lead ? leadRef(lead) : null, first = plan.route.find(x => x.state === 'planned');
    if (first.kind === 'apply' && !confirmed) {
      const goal = makeCard({ kind: 'goal', title: `${plan.title} ${lead ? `#${lead.number} ${coName(lead.company)}${lead.role ? ` · ${lead.role}` : ''}` : ''}`.trim(), leads: ref ? [ref] : [], owner: 'team', from, route: plan.route.map(x => ({ ...x, card: null })), now, note: cut(raw, 200) });
      goal.halt = { question: applyQuestion(lead), options: ['确认，开始预填', '不投了'], at: iso(now), card: null, from: 'quill' };
      saveCards([goal]);
      return goal;
    }
    const { goal, card } = startGoal(plan, { lead: ref, origin: {}, text: raw, now });
    const top = goal || card;
    top.from = { ...from }; if (goal) card.from = { ...from };
    if (goal && confirmed && plan.type === 'apply') goal.confirmed = iso(now); // 收录完接力到投递时不再问一遍
    saveCards(goal ? [goal, card] : [card]);
    return top;
  }
  const suggested = crewOf(suggest(raw)) || 'patch';
  const who = owner != null && owner !== '' ? crewOf(owner) : suggested;
  // 自己开跑（auto）：同步时照「你交代的事」的那条路做（lib/task-do.mjs，和对话里「交给团队去做」同一条）。
  const card = makeCard({ kind: null, title: raw, leads: lead ? [leadRef(lead)] : [], owner: who, from, auto: true, now });
  Object.assign(card, { kind: 'ask', suggested });
  saveCards([card]);
  return card;
}
export const findCard = id => { const c = readCards().find(x => x.id === id); if (!c) { if (String(id).startsWith('job:')) throw Object.assign(Error('旧记录只读，不能改'), { status: 409 }); throw Object.assign(Error('没有这张卡'), { status: 404 }); } return c; };
// ── 再试一次 ──────────────────────────────────────────────────────────────────
// 放回排队、照这类的做法再开一次：指着上一次的那几个链接要摘掉，不然同步时还是从上一次的结果推出「没做成」。
export const RESTART_LINKS = ['op', 'op_id', 'prep_at', 'do_at', 'queue_id'];
// 周期结果卡不是待发请求；没有具体业务绑定时，改成 queued 也没有执行者会接。
// 显示、显式重试和开工共用此边界，不能把旧结果变成一次新的批准。
export function routineSendReason(c) {
  if (!c?.routine || c.kind !== 'send') return null;
  if (c.leads?.some(l => l?.rid || l?.record_id || l?.id || l?.number != null) || c.links?.action_id || c.links?.job_id || c.links?.ledger_id) return null;
  const j = jobOfCard(c);
  if (j?.target || (j && J.actionsOf(j.id).length)) return null;
  return '这条定时发送记录没有具体发送对象，不能重新排队或运行；当前发送事项在收件箱处理。';
}
// 旧版把开工前的忙锁记为失败并耗尽重试；只有用户明确重排这一张未执行的内部卡才恢复预算。
export function legacyResourceWait(c) {
  if (c?.status !== 'stuck' || !KINDS[c.kind]?.op || ['send', 'apply'].includes(c.kind) || c.resource_recovery) return false;
  if (['op_id', 'queue_id', 'job_id', 'ledger_id', 'action_id', 'writer', 'do_at', 'apply_at', 'send_at'].some(k => c.links?.[k])) return false;
  const reason = String(c.detail || '');
  if (!/^「[^\n]+」还在运行，一次只跑一个$/.test(reason) && reason !== '另一个写入进程正在跑（周期或本机 AI），请等它结束') return false;
  const job = jobOfCard(c);
  return !!job && job.state === 'failed' && !job.started_at && !job.pid && !J.actionsOf(job.id).length && !J.events(job.id).some(e => ['running', 'done'].includes(e.to_state));
}
// 放回排队真能再开一次的卡：有固定做法（操作台的一步、「怎么准备」、引擎自己做的那几件）。Writer 的活状态看对话（再试一次是对话里那个按钮），
// 指着交办任务的跟着那条任务走，都不算。
export const restartable = c => { const k = KINDS[c?.kind]; return !!k && !c.links?.writer && !c.links?.job_id && (!!k.op || c.kind === 'prep' || c.kind === 'apply' || DO.has(c.kind)); };
export function moveCard(id, { status, note = '', now = Date.now() } = {}) {
  if (!['done', 'stuck', 'cancelled', 'unclaimed', 'queued'].includes(status)) throw Error('只能标为完成、卡住、取消，或者放回待认领 / 排队');
  const c = findCard(id);
  const blocked = status === 'queued' && routineSendReason(c);
  if (blocked) throw Object.assign(Error(blocked), { status: 409 });
  if (status === 'queued' && legacyResourceWait(c)) {
    c.resource_recovery = { kind: 'legacy_busy', at: iso(now), ignored_retries: (c.steps || []).filter(s => s.who === 'you' && /放回排队/.test(String(s.text || ''))).length, previous_tries: c.tries || 0, reason: c.detail };
    addStep(c, '旧记录因资源忙而未开工；按你的操作重新安排，保留此前记录', { who: 'system', at: now });
  }
  if (c.owner_control) c.owner_control = { action: 'resume', rev: c.owner_control.rev + 1, at: iso(now) };
  const word = { done: '标为完成', stuck: '标为卡住', cancelled: '取消了', unclaimed: '放回待认领', queued: '放回排队' }[status];
  Object.assign(c, { status, manual: ['done', 'stuck', 'cancelled'].includes(status), ...(status === 'unclaimed' ? { owner: null, claimed_at: null } : {}), ...(status === 'done' ? { done_at: iso(now), result: note ? cut(note, 140) : c.result || '你标为完成' } : {}), ...(status === 'queued' ? { manual: false, tries: 0 } : {}) });
  // 引擎自己做的那几件（lib/task-do.mjs）「再试一次」：放回排队就重新开跑。
  if (status === 'queued' && DO.has(c.kind) && !c.links?.job_id) { c.auto = true; c.links = { ...(c.links || {}) }; delete c.links.do_at; delete c.wait; c.detail = ''; }
  // 别的有固定做法的（脚本、「怎么准备」）也一样：摘掉上一次的链接，同步时照这类的做法再开一次（不然还是从上一次的结果推出「没做成」）。
  else if (status === 'queued' && restartable(c)) { c.auto = true; c.links = { ...(c.links || {}) }; for (const f of RESTART_LINKS) delete c.links[f]; c.detail = ''; }
  delete c.retry; // 你（或撤销）动过这张卡：不再说是 System 放回去的
  if (status === 'queued') c.retried_at = iso(now); // 账上那件活从失败重新排（lib/task-ledger.mjs）
  addStep(c, `你${word}${note ? `：${cut(note, 60)}` : ''}`, { who: 'you', at: now });
  // 取消：还在排队的交办任务一起撤回（和对话面板「撤回」同一个状态：dropped）。
  if (status === 'cancelled' && c.links?.job_id) {
    const jobs = lines('state/host-jobs.ndjson'), j = jobs.findLast(x => x.id === c.links.job_id);
    if (j && j.status === 'pending') { Object.assign(j, { status: 'dropped', dropped_at: iso(now), dropped_by: 'tasks', previous_status: 'pending', updated_at: iso(now) }); writeLines('state/host-jobs.ndjson', jobs); }
  }
  // 排着等的那一项（lib/op-queue.mjs）：取消（或者你直接标了完成 / 卡住）就从队列里拿掉，什么都不跑。
  if (['cancelled', 'done', 'stuck'].includes(status) && c.links?.queue_id && !c.links?.op_id) cancelQueued(c.links.queue_id, { now });
  if (status === 'cancelled') {
    const kids = descendants(c.id, readCards()).map(k => {
      if (k.links?.queue_id && !k.links?.op_id) cancelQueued(k.links.queue_id, { now });
      return addStep({ ...k, status: 'cancelled', manual: true, auto: false }, '上级任务取消了，一起取消', { who: 'you', at: now });
    });
    saveCards([c, ...kids]); return c;
  }
  saveCards([c]);
  return c;
}
// 改要求（接口第二节 POST /api/tasks/<id>/edit）：存在这件活最上面那张卡上，「做了什么」记一行「你改了要求」，从下一步起生效——
// 还没开始的那一棒跟着改：开出来、还排着的子卡（卡上的要求、交接单的「下一步」），还排着没人领的交办任务（details 后面接一句），
// Writer 先问的问题还没答的（这一问的 instruction，答了以后照它改）。已经开始的那一步不打断，做完的不重做。
export const notStarted = (c, jobs) => c.status === 'queued' && !c.links?.op_id && !c.links?.apply_at && !c.links?.prep_at && !c.links?.send_at && (!c.links?.job_id || jobs.find(j => j.id === c.links.job_id)?.status === 'pending');
export function assignCard(id, { owner = null, now = Date.now() } = {}) {
  const c = findCard(id);
  const to = owner ? crewOf(owner) : null;
  if (owner && !to) throw Error('没有这位成员');
  const a = assignOf(c);
  if (a.fixed) { const who = currentOwner(c) || KINDS[c.kind]?.member; throw Object.assign(Error(c.kind === 'goal' || !who ? '这件事由路线上的各位接着做，不能换人' : `这类活只有 ${crewName(who)} 能做`), { status: 409 }); }
  if (to && !a.options.some(o => o.id === to)) throw Object.assign(Error(`${crewName(to)} 不能做这件事`), { status: 409 });
  Object.assign(c, { owner: to, status: to ? (TERMINAL.has(c.status) ? c.status : c.status === 'unclaimed' ? 'queued' : c.status) : 'unclaimed', claimed_at: to ? iso(now) : null });
  addStep(c, to ? `你交给了 ${crewName(to)}` : '你放回了待认领', { who: 'you', at: now });
  saveCards([c]);
  return c;
}
export function editRequirement(id, { requirement = '', now = Date.now() } = {}) {
  const all = readCards(), c0 = findCard(id), top = c0.goal ? all.find(x => x.id === c0.goal) || c0 : c0;
  if (TERMINAL.has(top.status)) throw Object.assign(Error('这件已经结束了'), { status: 409 });
  const text = String(requirement ?? '').replace(/\s+$/g, '').trim().slice(0, 1000) || null;
  if ((top.requirement || null) === text) return top;
  const jobs = lastRev(lines('state/host-jobs.ndjson'));
  const parts = [top, ...all.filter(k => k.goal === top.id && !TERMINAL.has(k.status) && notStarted(k, jobs))];
  const out = [];
  for (const k of parts) {
    const x = { ...k, requirement: text };
    if (x.handoff) x.handoff = { ...x.handoff, requirement: text };
    out.push(x);
  }
  addStep(out[0], '你改了要求', { who: 'you', at: now });
  // 还排着的交办任务：要求接在说明后面（执行器领取时读到的就是新的）。
  const pending = out.map(k => k.links?.job_id).filter(j => j && jobs.find(x => x.id === j)?.status === 'pending');
  if (pending.length) {
    const rows = lines('state/host-jobs.ndjson');
    for (const jid of pending) { const j = rows.findLast(x => x.id === jid); if (j && j.status === 'pending') { const base = String(j.details || '').replace(/\n你的要求：[\s\S]*$/, ''); Object.assign(j, { details: text ? `${base}\n你的要求：${text}` : base, requirement: text, updated_at: iso(now) }); } }
    writeLines('state/host-jobs.ndjson', rows);
  }
  // Writer 先问的问题还没答：答完照这句改（lib/resume-talk.mjs writerButton 读这一问的 instruction）。
  if (top.links?.writer && top.session_id) {
    const s = read(`state/chat/${top.session_id}.json`, null), i = s ? s.messages.findIndex(m => m.id === top.links.writer) : -1;
    const asked = i < 0 ? null : s.messages.slice(i).filter(m => m.kind === 'writer' && m.writer?.kind === 'ask').at(-1);
    if (asked && top.status === 'needs_you') { asked.writer = { ...asked.writer, instruction: text || '' }; write(`state/chat/${s.id}.json`, s); }
  }
  saveCards(out);
  return out[0];
}
// 目标停下来问你（岗位下线、判断为排除、链接没收成）：「还投」接着开下一棒，「不投了」整个目标取消。
// phone：{ device }——没被允许交办的手机答的（卡上「下指令」、卡上的答、收件箱那一封）。它放行的这一棒照样回电脑确认：
// 目标记 mac_next，接力开出来的下一张要开浏览器或本机 AI 的卡记 mac_hold（holdOnMac），用掉就清；电脑上、允许交办的手机答的清掉它、照常往下走。
// fingerprint：你在收件箱那封里看到的预填那一版的指纹（goalAsks 的 preview），开出来的投递卡按它确认（startCard confirm_fp）。
export function answerGoal(goalId, option, { now = Date.now(), phone = null, fingerprint = null } = {}) {
  const g = findCard(goalId);
  if (!g.halt || g.halt.answered) throw Error('这件事现在不用你答');
  if (fingerprint && option === APPLY_GO) g.halt.fingerprint = String(fingerprint);
  if (option === '不投了') { g.halt = { ...g.halt, answered: option }; saveCards([g]); return moveCard(goalId, { status: 'cancelled', note: '你说不投了', now }); }
  g.halt = { ...g.halt, answered: option, answered_at: iso(now) };
  if (phone) g.mac_next = macFrom({ mac_confirm: true, device: phone.device || null }); else delete g.mac_next;
  // 停下来那一棒已经算做完：把它后面的那一棒放回待开，下一次同步照常接力。
  const i = g.halt.card ? g.route.findIndex(s => s.card === g.halt.card) : -1;
  if (i >= 0) g.route[i].state = 'open';
  // 还没开始就先问你的（任务页上新建的投递，createTask）：答了才开第一棒。
  if (!g.halt.card) {
    const first = g.route.find(s => s.state === 'planned');
    if (first) {
      const card = holdOnMac(makeCard({ kind: first.kind, leads: g.leads || [], owner: first.owner, from: { ...(g.from || { by: 'you' }), ...macFrom(g.mac_next) }, goal: g.id, auto: true, now }), undefined, now);
      if (card.mac_hold) delete g.mac_next;
      if (g.requirement) card.requirement = g.requirement;
      if (card.kind === 'apply' && g.halt.fingerprint) card.confirm_fp = g.halt.fingerprint;
      first.state = 'open'; first.card = card.id;
      addStep(g, `你答：${option}`, { who: 'you', at: now });
      saveCards([g, card]);
      return g;
    }
  }
  addStep(g, `你答：${option}`, { who: 'you', at: now });
  g.resume = true;
  saveCards([g]);
  return g;
}

// 目标停下来问你的那一句也是一封信（任务板遗留 #5，负责人 09-30）：收件箱里有，成员的「等你」里有，
// 和卡片上是同一件事（id goal:<目标 id>，答了走 answerGoal，两边一起消失）。谁问的：停下来那一棒的主人。
// 「确认，开始预填」那一问带上预填的预览和指纹（像发信的信那样）：你答的时候页面把指纹带回来，开出来的投递卡按它确认（J 10-04：
// 以前这一问不带预览，服务端没给你看过这一版，确认了也回「再看一眼」，卡记成失败）。
// 投递卡开跑时发现还没给你看过这一版（startCard 记 confirm_wait）：同样一封，答了接着填（confirmApply）。
export const APPLY_GO = '确认，开始预填';
export function prefillPreview(l) {
  const spec = specOf('prefill');
  if (!spec?.prepare || !l || (l.number == null && !l.rid)) return null;
  let p;
  try { p = spec.prepare(l.rid ? { record_id: l.rid } : { number: l.number }, { origin: 'inbox', now: Date.now() }); }
  catch (e) { console.error('[tasks] 预填预览没算出来：', String(e.message || e).slice(0, 120)); return null; }
  if (!p || p.blocked || typeof p.then === 'function') return null;
  return { kind: 'prefill', fingerprint: p.fingerprint, ...(p.preview || {}) };
}
export function goalAsks({ cards = null } = {}) {
  let all; try { all = cards || readCards(); } catch { return []; }
  const out = [];
  const leadOut = l => (l ? { lead: { number: l.number ?? null, company: l.company || '', role: l.role || '', record_id: l.rid || null } } : {});
  for (const g of all) {
    if (g.kind !== 'goal' || !g.halt || g.halt.answered || TERMINAL.has(g.status)) continue;
    const who = g.halt.from || all.find(c => c.id === g.halt.card)?.owner || 'lens', l = g.leads?.[0];
    const preview = (g.halt.options || []).includes(APPLY_GO) ? prefillPreview(l) : null;
    out.push({
      from: who, id: `goal:${g.id}`, type: 'decide', title: g.title, question: g.halt.question,
      context: [], facts: [],
      ...leadOut(l), ...(preview ? { preview, form_preview: l.rid || l.number } : {}),
      options: (g.halt.options || []).map((o, i) => ({ key: String(i + 1), label: o, steps: [{ type: 'goal', goal: g.id, option: o }], ...(i === 0 ? { primary: true } : {}) })),
      other: null, card: g.id,
    });
  }
  for (const c of all) {
    if (c.kind !== 'apply' || !c.confirm_wait || c.status !== 'needs_you' || TERMINAL.has(c.status)) continue;
    const l = c.leads?.[0], preview = prefillPreview(l), g = c.goal ? all.find(x => x.id === c.goal) : null;
    out.push({
      from: 'quill', id: `goal:${c.id}`, type: 'decide', title: g?.title || c.title, question: applyQuestion(l),
      context: [], facts: [],
      ...leadOut(l), ...(preview ? { preview, form_preview: l.rid || l.number } : {}),
      options: [APPLY_GO, '不投了'].map((o, i) => ({ key: String(i + 1), label: o, steps: [{ type: 'apply_confirm', card: c.id, option: o }], ...(i === 0 ? { primary: true } : {}) })),
      other: null, card: c.id,
    });
  }
  return out;
}
// 任务板上已经管着「投不投」的岗位：有一个带投递那一棒的目标，或者一张投递卡（不论还在问你、在做、做完、你说不投了）。
// 收件箱据此不再出系统建议的「投递」那一封（lib/ask-actions.mjs inboxView）：同一个岗位只问一次，问的是目标那一封——
// 它带着预填的预览和你交代的要求；你在那封上答了「确认」「不投了」，这一封也不会再冒出来（实测 10-05：#7 两封问同一件事）。
// 返回 { rids, numbers } 两个集合。
export function applyClaims({ cards = null } = {}) {
  let all; try { all = cards || readCards(); } catch { return { rids: new Set(), numbers: new Set() }; }
  const rids = new Set(), numbers = new Set();
  for (const c of all) {
    const owns = c.kind === 'apply' || (c.kind === 'goal' && (c.route || []).some(s => s.kind === 'apply'));
    if (!owns) continue;
    for (const l of c.leads || []) { if (l?.rid) rids.add(l.rid); if (l?.number != null) numbers.add(Number(l.number)); }
  }
  return { rids, numbers };
}
// 投递卡等你确认这一版（confirm_wait）：确认 → 记下你看到的指纹，卡放回排队，下一次同步接着填；不投了 → 卡取消。
export function confirmApply(cardId, option, { fingerprint = null, now = Date.now() } = {}) {
  const c = findCard(cardId);
  if (c.kind !== 'apply' || !c.confirm_wait || c.status !== 'needs_you') throw Object.assign(Error('这件事现在不用你答'), { status: 409 });
  if (option !== APPLY_GO) return moveCard(cardId, { status: 'cancelled', note: '你说不投了', now });
  const j = jobOfCard(c);
  if (j?.state === 'waiting_you' && j.what?.ask_id === `goal:${c.id}`) {
    if (J.actionsOf(j.id).some(a => ['approved', 'claimed', 'uncertain'].includes(a.state))) throw Object.assign(Error('这条投递还有未结束的动作，请刷新查看'), { status: 409 });
    // 明确确认才从这封信恢复；挂过旧动作的任务也能接上，不靠存卡覆盖动作状态。
    J.drive(j.id, 'queued', { now });
  }
  delete c.confirm_wait; delete c.need_title;
  if (c.links?.ask_id === `goal:${c.id}`) delete c.links.ask_id;
  Object.assign(c, { status: 'queued', auto: true, detail: '', ...(fingerprint ? { confirm_fp: String(fingerprint) } : {}) });
  addStep(c, `你答：${option}`, { who: 'you', at: now });
  saveCards([c]);
  return c;
}

// 只安排任务，不据此认定对外动作成功；继续运行仍走原来的批准与执行入口。
const TEMPORARY_CONTROL = new Set(['todo', 'later', 'self']);
function descendants(id, cards) {
  const found = new Set([id]);
  // 子任务自身可能是目标，下面还有执行卡；终态节点也要遍历，避免漏掉它未结束的后代。
  for (let size = 0; size !== found.size;) {
    size = found.size;
    for (const c of cards) if (found.has(c.goal) || found.has(c.parent_task)) found.add(c.id);
  }
  return cards.filter(c => c.id !== id && found.has(c.id) && !TERMINAL.has(c.status));
}
function restorePendingHost(c, control, now) {
  if (!c.links?.job_id) return false;
  const jobs = lines('state/host-jobs.ndjson'), h = jobs.findLast(j => j.id === c.links.job_id), pause = control.host_pause;
  if (!h) return false;
  if (c.legacy || c.id === `job:${h.id}`) {
    const old = J.byRef(`hostjob:${h.id}`);
    if (old && !jobOfCard(c)) J.rebind(old.id, `card:${c.id}`);
    delete c.legacy; // 显式恢复旧记录时接回同一件活，保留历史，不再当成只读投影。
  }
  // 兼容旧版 later 记录：必须是这次用户安排亲自停掉的 pending，后来另行取消/完成的不复活。
  const ours = pause ? h.task_pause?.card === c.id && h.task_pause.rev === pause.rev && h.dropped_at === pause.at
    : !h.task_pause && ['queued', 'unclaimed'].includes(control.previous?.status) && h.dropped_at === control.at && h.result === control.note;
  const restore = TEMPORARY_CONTROL.has(control.action) && ours && h?.status === 'dropped' && h.dropped_by === 'owner' && !h.moved_to_card;
  if (restore) {
    if (['research', 'interview'].includes(c.kind)) {
      // 这两类现在归引擎：恢复同一张卡，不再把普通调研交回旧 CLI 队列。
      c.links = { ...c.links, old_job_id: h.id }; delete c.links.job_id; delete c.links.do_at;
      c.auto = true;
      Object.assign(h, { dropped_by: 'engine', moved_to_card: c.id, migration_reason: '恢复原任务，改由引擎接着做', updated_at: iso(now) });
    } else {
      Object.assign(h, { status: 'pending', result: pause?.result ?? null, resumed_at: iso(now), resume_source: 'task_control', updated_at: iso(now) });
      delete h.dropped_at; delete h.dropped_by;
    }
    delete h.task_pause;
    writeLines('state/host-jobs.ndjson', jobs);
    if (h.status === 'pending' && (h.local_tool === true || localToolNeed(`${taskText(c)}；${h.details || ''}`))) requestRunNow({ reason: `[任务] 恢复 ${c.title || h.id}`, job_ids: [h.id], now });
  }
  // 挂起期间可能已有真实结果；恢复马上对账，不能先显示旧快照再等下一拍纠正。
  mirrorHostJobs(jobs, [{ ...c, owner_control: null, manual: false }], { now });
  return restore;
}
export function controlCard(id, { action, now = Date.now() } = {}) {
  if (action !== 'resume' && !TASK_CHOICES.some(x => x.action === action)) throw Object.assign(Error('没有这个任务选项'), { status: 400 });
  const c = readCards().find(x => x.id === id) || receiptCards().find(x => x.id === id) || legacyCards(lastRev(lines('state/host-jobs.ndjson')), readCards()).find(x => x.id === id) || findCard(id), label = TASK_CHOICES.find(x => x.action === action)?.label || '恢复原任务';
  if (action === 'resume') {
    const all=readCards(), list=[c, ...all.filter(k=>k.id!==c.id && k.owner_control?.group===c.id)];
    for(const x of list) {
      const o=x.owner_control; if(!o || o.action==='resume') continue;
      Object.assign(x,o.previous || {},{manual:false,auto:false});
      restorePendingHost(x, o, now);
      // 用户安排期间，已经开始的一步仍可能产生新结果；恢复时以任务账为准，不能把旧快照写回覆盖它。
      const actual = overlay({ ...x, owner_control: null });
      for (const key of ['status', 'detail', 'result', 'done_at']) if (actual[key] !== undefined) x[key] = actual[key];
      x.owner_control={action:'resume',rev:o.rev+1,at:iso(now)};
      addStep(x,'你恢复了原任务；按当前执行记录继续处理',{who:'you',at:now});
    }
    saveCards(list); return readCards().find(x=>x.id===id);
  }
  const note = { done: '你标为完成；外发与提交结果仍以回执为准', cancelled: '你决定不做了', todo: '你放回待做，尚未重新运行', later: '你选择晚点再说，明天再提醒', self: '这一步由你自己来，完成后可以标为完成' }[action];
  const list = [c, ...descendants(c.id, readCards())];
  for (const x of list) {
    const pause = TEMPORARY_CONTROL.has(action) && TEMPORARY_CONTROL.has(x.owner_control?.action) ? x.owner_control?.host_pause : null;
    x.owner_control = { action, group:c.id, previous:x.owner_control?.previous || { status:x.status, manual:x.manual, auto:x.auto, detail:x.detail, result:x.result, done_at:x.done_at }, rev: (x.owner_control?.rev || 0) + 1, at: iso(now), note, ...(pause ? { host_pause: pause } : {}), ...(action === 'later' ? { until: iso(now + 86400000) } : {}) };
    x.auto = false; x.manual = true;
    const j = jobOfCard(x);
    if (j?.state === 'running') x.owner_control.note += '；已经开始的这一步仍在收尾，结果以执行回执为准';
    if (j) for (const a of listActions({ job_id: j.id })) if (['requested','approved','claimed','uncertain'].includes(a.state)) {
      if (['requested','approved'].includes(a.state)) cancelAction(a.id, { reason: note, now });
      const requests=lines('state/send-requests.ndjson'); let changed=false;
      for(const r of requests) if ((r.id===a.payload?.request_id || r.id===a.payload?.id || (a.payload?.draft_id && r.draft_id===a.payload.draft_id)) && !['sent','cancelled'].includes(r.status)) {
        // 在途发送仍核实实际结果，但用户接管/结束后不能借“核实没发出”再发送。
        if (['claimed','uncertain'].includes(a.state) && r.channel !== 'platform_dm') continue;
        if (r.channel === 'platform_dm') r.retry_disabled='owner_control';
        if (['queued','approved'].includes(r.status)) Object.assign(r,{status:'cancelled',reason:'owner_control',cancelled_at:iso(now)});
        changed=true;
      }
      if(changed) writeLines('state/send-requests.ndjson',requests);
    }
    if (x.links?.job_id) {
      const jobs = lines('state/host-jobs.ndjson'), h = jobs.findLast(j => j.id === x.links.job_id);
      if (h?.status === 'pending') {
        if (TEMPORARY_CONTROL.has(action)) {
          x.owner_control.host_pause = { rev: x.owner_control.rev, at: iso(now), result: h.result ?? null };
          h.task_pause = { card: x.id, rev: x.owner_control.rev };
        }
        Object.assign(h, { status: 'dropped', dropped_at: iso(now), dropped_by: 'owner', result: note });
        writeLines('state/host-jobs.ndjson', jobs);
      } else if (h?.task_pause?.card === x.id && !TEMPORARY_CONTROL.has(action)) {
        delete h.task_pause; writeLines('state/host-jobs.ndjson', jobs);
      }
    }
    if (x.links?.queue_id && !x.links?.op_id) cancelQueued(x.links.queue_id, { now });
    addStep(x, `你选择：${label}`, { who: 'you', at: now });
  }
  saveCards(list);
  return readCards().find(x => x.id === id);
}
