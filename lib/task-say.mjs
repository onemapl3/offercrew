// 卡片上接着做（任务卡片第四节，负责人 10-03 在 4404 上试过以后定）：输入框里下一句指令（say），「+ 子任务」（subtask）。
// 一句指令按这件活现在的状态办（第四节第 1 条）：
//   在做    从下一步起照它做，不打断已经开始的那一步；等你    直接答它在等的事（收件箱那封信的「其他」）；
//   做完、没做成  重新打开，照它再做一轮；排队    存下，开始时照它做；撤回    回 409。
// 每类活实际怎么照它做（第六条，做不到的照实说，回应写进「做了什么」）：
//   Writer      在做：这一版出来以后照这句再改一版（say_next，同步时接上）；做完、没做成：马上照这句改一版（简历先问几句，信直接改）；
//               等你：这句就是对它那几问的回答。
//   本机 AI（交办任务） 排着、卡住、等你：记进任务的 user_feedback 接着做（lib/command-center.mjs updateHostJob feedback）；
//               正在跑：这一轮做完以后带着这句接着做（say_next）；做完：另起一件同类的，带上这句，卡指向新的那件。
//   脚本类      照固定步骤做，不认自由的话：这句记下，回一句「这类活照固定步骤做，这句记下了」；做完、没做成的接着做 = 再跑一次。
//   投递        「先别投 / 暂停 / 不投了」这类：撤回这次投递（从不替你提交，也收不回已经提交的）；别的照实说投递照固定步骤走。
//   目标        记在目标上，下一棒的交接单带上；没做成的那一棒照它那类重新打开；做完的照实说。
// 没被允许交办的手机（limited）：要开本机 AI 或浏览器的那一下不开，卡上记 mac_hold，回电脑确认（releaseCard）以后同步时接上。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { file, lines, read } from './store.mjs';
import { lastRev } from './cards.mjs';
import { moveCard, answerGoal, createTask } from './card-ops.mjs';
import { readCards, saveCards, addStep, sixOf, macRunLabel, applied } from './cards.mjs';
import { KINDS, crewName } from './crew.mjs';
import { writerChain } from './task-writer.mjs';

const iso = t => new Date(t).toISOString();
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const err = (msg, status) => Object.assign(Error(msg), { status });
const jobOf = c => c?.links?.job_id ? lastRev(lines('state/host-jobs.ndjson')).find(j => j.id === c.links.job_id) || null : null;
// 这件活归哪一类做法。
export const sayKind = c => c.kind === 'goal' ? 'goal' : c.links?.writer ? 'writer' : c.kind === 'apply' ? 'apply' : c.links?.job_id ? 'job' : KINDS[c.kind]?.op || ['script', 'model', 'browser'].includes(KINDS[c.kind]?.how) && c.kind !== 'ask' ? 'script' : 'plain';
const STOP = /先别投|别投|不投了?|暂停|先停|等等再投|先不投/;
const FIXED = '这类活照固定步骤做，这句记下了';

// ── 一句指令 ────────────────────────────────────────────────────────────────
// shown：同步推好的那张（状态以它为准）。deps：{ answer(input) 收件箱答信, hostJob(id, action, o) 改交办任务, writer(o) 照这句让 Writer 改一版,
// writerAnswer(o) 答 Writer 先问的 }。→ { card, reply: { who, text } }
export async function sayTask(id, text, { shown = null, deps = {}, limited = false, device = null, now = Date.now() } = {}) {
  const raw = cut(text, 500);
  if (!raw) throw err('写一句要它怎么做', 400);
  if (String(id).startsWith('job:')) throw err('旧记录只读', 409);
  const c0 = readCards().find(x => x.id === id);
  if (!c0) throw err('没有这件事', 404);
  const cur = { ...c0, ...(shown ? { status: shown.status, halt: shown.halt ?? c0.halt, links: { ...c0.links, ...(shown.links || {}) }, waiting_card: shown.waiting_card } : {}) };
  const st = sixOf(cur.status);
  if (st === 'cancelled') throw err('这件撤回了，不能再下指令', 409);
  saveCards([addStep({ ...c0, says: [...(c0.says || []), { at: iso(now), text: raw }] }, `你：${raw}`, { who: 'you', at: now })]);
  const reply = await act(cur, st, raw, { deps, limited, device, now });
  const out = readCards().find(x => x.id === id);
  if (reply?.text) saveCards([addStep(out, reply.text, { who: reply.who || out.owner, at: now + 1 })]);
  return { card: readCards().find(x => x.id === id), reply };
}
const ownerOf = c => c.owner && c.owner !== 'team' ? c.owner : 'patch';
const patch = (id, fn) => { const c = readCards().find(x => x.id === id); if (c) saveCards([fn({ ...c, links: { ...(c.links || {}) } }) || c]); };
// 卡上记一笔「回电脑确认」（手机上开的卡同一个规矩，lib/tasks.mjs holdOnMac）。
const hold = (c, device, now) => ({ ...c, mac_hold: { label: macRunLabel(c.kind) || '接着做这件事', at: iso(now), ...(device ? { device } : {}) } });

async function act(c, st, raw, o) {
  const k = sayKind(c), who = ownerOf(c), name = crewName(who);
  if (k === 'apply' && STOP.test(raw) && !['done', 'cancelled'].includes(st)) { moveCard(c.id, { status: 'cancelled', note: raw }); return { who: 'quill', text: '好，先停下：这次投递撤回了（没有提交过）。要投时再说一次' }; }
  if (st === 'needs_you') return answer(c, raw, o);
  if (st === 'running' || st === 'queued') return nextStep(c, k, st, raw, o);
  return reopen(c, k, st, raw, o);
}
// 等你：直接答它在等的事。
async function answer(c, raw, { deps, limited = false, device = null, now }) {
  if (c.kind === 'goal' && c.halt && !c.halt.answered) {
    const opt = (c.halt.options || []).find(x => raw.includes(x));
    // 没被允许交办的手机答的：放行的下一棒照样停在电脑确认（lib/tasks.mjs answerGoal phone）。
    if (opt) { answerGoal(c.id, opt, { now, phone: limited ? { device } : null }); return { who: c.halt.from || 'quill', text: `好，${opt}` }; }
    return { who: c.halt.from || 'quill', text: `这一步要你定：${(c.halt.options || []).join(' / ')}` };
  }
  const kid = c.kind === 'goal' ? readCards().find(x => x.id === c.waiting_card) || null : null, t = kid || c;
  if (t.links?.ask_id && deps.answer) {
    try { const r = await deps.answer({ id: t.links.ask_id, option: 'other', text: raw }); return { who: ownerOf(t), text: cut(r?.receipt || '收到，照这句接着做', 200) }; }
    catch (e) { return { who: ownerOf(t), text: /不接受自由输入/.test(e.message) ? '这一步要点卡片上的选项回答，这句记下了' : cut(e.message, 160) }; }
  }
  if (t.links?.writer && deps.writerAnswer) {
    const s = read(`state/chat/${t.session_id}.json`, null), m = writerChain(s, t.links.writer, t.links.writer_next).filter(x => ['ask', 'letter_ask'].includes(x.writer?.kind)).at(-1);
    if (m) { const r = await deps.writerAnswer({ session_id: s.id, message_id: m.id, kind: 'resume_answers', text: raw, now }); return { who: 'tailor', text: r?.redirected ? r.reply?.content || (r.reply?.writer?.kind === 'check' ? '开始体检简历' : '按这次指定的材料处理') : '照你的回答接着改' }; }
  }
  const j = jobOf(t);
  if (j && ['waiting_user', 'blocked'].includes(j.status) && deps.hostJob) { await deps.hostJob(j.id, 'feedback', { note: raw, now }); return { who: ownerOf(t), text: '记进这件任务了，本机 AI 照这句接着做' }; }
  if (t.wait === 'input' && ['ask', 'research', 'interview'].includes(t.kind) && !t.links?.job_id) return reopen(t, sayKind(t), 'needs_you', raw, { deps, limited, device, now });
  return { who: ownerOf(t), text: '这句记下了' };
}
// 在做、排队：从下一步起照它做。
async function nextStep(c, k, st, raw, { deps, now }) {
  const who = ownerOf(c), name = crewName(who);
  if (k === 'writer') { patch(c.id, x => ({ ...x, say_next: raw })); return { who: 'tailor', text: '这一版出来以后，照这句再改一版' }; }
  if (k === 'job') {
    const j = jobOf(c);
    if (j?.status === 'working') { patch(c.id, x => ({ ...x, say_next: raw })); return { who, text: '本机 AI 正在做这一轮，做完以后带着这句接着做' }; }
    if (j && deps.hostJob) { await deps.hostJob(j.id, 'feedback', { note: raw, now }); return { who, text: '记进这件任务了，本机 AI 领取时照这句做' }; }
  }
  if (k === 'goal') {
    // 下一棒的交接单带上（lib/tasks.mjs syncTasks 接力时把 says 拼进 requirement）；已经开出来、还排着的那一棒也带上。
    const rest = readCards().filter(x => x.goal === c.id && x.status === 'queued' && !x.links?.op_id && !x.links?.apply_at);
    if (rest.length) saveCards(rest.map(x => ({ ...x, says: [...(x.says || []), { at: iso(now), text: raw }], ...(x.handoff ? { handoff: { ...x.handoff, requirement: [x.handoff.requirement, raw].filter(Boolean).join('；') } } : {}) })));
    const nxt = (c.route || []).find(s => s.state === 'planned' || (s.state === 'open' && rest.some(x => x.id === s.card)));
    return { who: nxt?.owner || who, text: nxt ? `${crewName(nxt.owner)} 下一棒照这句做` : '后面没有还没开始的一棒了，这句记下了' };
  }
  if (k === 'script' || k === 'apply') return { who, text: k === 'apply' ? '投递照固定步骤走（预填，停在提交前等你），这句记下了' : FIXED };
  // 引擎自己用模型做的（lib/task-do.mjs）：在做的这一轮做完以后照这句接着做；排着的马上照这句开始（同步时开跑，模型读得到这句）。
  if (c.links?.do_at && st === 'running') return { who, text: `${name} 照这句接着做` }; // 这一轮的模型没读到的，做完以后照它再做一轮（lib/task-do.mjs）
  if (st === 'queued' && ['ask', 'research'].includes(c.kind)) { patch(c.id, x => ({ ...x, auto: true, tries: 0 })); return { who, text: `${name} 照这句开始做` }; }
  return { who, text: st === 'queued' ? `${name} 开始时照这句做` : '这句记下了' };
}
// 做完、没做成：重新打开，照它再做一轮。
async function reopen(c, k, st, raw, o) {
  const { deps, limited, device, now } = o, who = ownerOf(c);
  if (k === 'goal') {
    const bad = readCards().find(x => x.goal === c.id && x.status === 'stuck');
    if (st === 'stuck' && bad) return reopen(bad, sayKind(bad), 'stuck', raw, o);
    return { who, text: '这件已经做完了，这句记下了；要接着做别的，加一件子任务' };
  }
  if (k === 'writer') {
    if (!deps.writer) return { who: 'tailor', text: '这句记下了' };
    const r = await deps.writer({ card: c, text: raw, now });
    return { who: 'tailor', text: r?.bad || r?.redirected ? cut(r.content || (r.writer?.kind === 'check' ? '开始体检简历' : '按这次指定的材料处理'), 160) : '照这句再改一版' };
  }
  if (k === 'apply' && (st === 'done' || applied(c))) return { who: 'quill', text: '这次投递已经提交了，收不回来；这句记下了' };
  if (k === 'job') {
    const j = jobOf(c);
    if (limited) { patch(c.id, x => hold({ ...x, say_next: raw }, device, now)); return { who, text: '要开本机 AI：回电脑确认以后接着做' }; }
    if (j && ['blocked', 'waiting_user', 'pending'].includes(j.status) && deps.hostJob) { await deps.hostJob(j.id, 'feedback', { note: raw, now }); patch(c.id, x => ({ ...x, manual: false })); return { who, text: '记进这件任务了，本机 AI 照这句接着做' }; }
    if (j) { const nj = againJob(j, raw, now); patch(c.id, x => ({ ...x, manual: false, done_at: null, result: null, links: { ...x.links, job_id: nj.id } })); return { who, text: '另起了一件同类的，带上这句交给本机 AI' }; }
  }
  // 脚本类、投递没做成、你交代的事：放回排队，同步时照这类的做法再开一次（不算一次「再试一次」）。
  const heavy = ['browser', 'executor'].includes(KINDS[c.kind]?.how);
  // 你交代的事也自己开跑（auto）：引擎用模型做的，照这句接着做一轮（上一轮的结果模型看得到，lib/task-do.mjs）。
  patch(c.id, x => { const links = { ...x.links }; for (const f of ['op', 'op_id', 'apply_at', 'prep_at', 'send_at', 'do_at']) delete links[f]; const y = { ...x, links, status: 'queued', manual: false, tries: 0, done_at: null, result: null, detail: '', auto: true }; delete y.wait; delete y.retry; return limited && heavy ? hold(y, device, now) : y; });
  if (limited && heavy) return { who, text: '要开浏览器或本机 AI：回电脑确认以后再做一次' };
  return { who, text: k === 'script' ? `${FIXED}，再跑一次` : k === 'apply' ? '照固定步骤再预填一次，停在提交前' : '重新排上了，这句记下了' };
}
// 做完的交办任务另起一件同类的：同样的种类、岗位和说明，带上你这句（user_feedback），排给本机 AI。
function againJob(j, raw, now) {
  const keep = ['kind', 'record_id', 'number', 'company', 'role', 'title', 'details', 'target', 'source', 'thread', 'persona'];
  const nj = { ...Object.fromEntries(keep.filter(f => j[f] != null).map(f => [f, j[f]])), id: `job-${crypto.randomBytes(6).toString('hex')}`, status: 'pending', again_of: j.id, user_feedback: [{ id: crypto.randomUUID(), text: raw, at: iso(now), source: 'task_card' }], created_at: iso(now), updated_at: iso(now) };
  fs.appendFileSync(file('state/host-jobs.ndjson'), JSON.stringify(nj) + '\n');
  return nj;
}
// 同步时接上（lib/tasks.mjs syncTasks）：say_next 留着的那句，等这一版 / 这一轮做完了照它接着做。cards：推好的卡。
export async function followUps(cards, deps = {}) {
  for (const c of cards.filter(x => x.say_next && !x.mac_hold)) {
    const k = sayKind(c), st = sixOf(c.status), j = k === 'job' ? jobOf(c) : null;
    if (st === 'running' || st === 'cancelled' || (j && j.status === 'working')) continue;
    patch(c.id, x => { delete x.say_next; return x; });
    try { const r = st === 'needs_you' ? await answer(c, c.say_next, { deps, now: Date.now() }) : await reopen(c, k, st === 'queued' ? 'stuck' : st, c.say_next, { deps, now: Date.now() }); if (r?.text) patch(c.id, x => addStep(x, r.text, { who: r.who })); } catch {}
  }
}

// ── 子任务 ──────────────────────────────────────────────────────────────────
// 挂在这件下面的一张卡（parent_task），规矩和新建一样（lib/tasks.mjs createTask：认得出的照规则，认不出的是「你交代的事」，带 System 建议）。
// 岗位跟着上一级。这件的子任务那一块多出这一步（lib/task-card.mjs routeOf）。
// 子任务这一件对着哪一条岗位（跟着上一级）：确认框（lib/task-api.mjs）也要用。
export function subtaskLead(id) {
  const all = readCards(), p0 = all.find(x => x.id === id), parent = p0?.goal ? all.find(x => x.id === p0.goal) || p0 : p0, ref = parent?.leads?.[0];
  return ref ? lines('state/leads.ndjson').filter(l => !l.superseded && ((ref.rid && (l.record_id === ref.rid || l.id === ref.rid)) || (!ref.rid && l.number === ref.number))).at(-1) || null : null;
}
export function addSubtask(id, { text = '', owner = undefined, suggest = () => null, confirmed = false, now = Date.now() } = {}) {
  const all = readCards(), p0 = all.find(x => x.id === id);
  if (!p0) throw err('没有这件事', 404);
  const parent = p0.goal ? all.find(x => x.id === p0.goal) || p0 : p0;
  if (parent.status === 'cancelled') throw err('这件撤回了，不能再加子任务', 409);
  const ref = parent.leads?.[0], lead = ref ? lines('state/leads.ndjson').filter(l => !l.superseded && ((ref.rid && (l.record_id === ref.rid || l.id === ref.rid)) || (!ref.rid && l.number === ref.number))).at(-1) || null : null;
  const sub = createTask({ text, owner, lead, suggest, confirmed, now });
  saveCards([{ ...sub, parent_task: parent.id, from: { ...(sub.from || {}), parent: parent.id } }, addStep({ ...parent, subtasks: [...(parent.subtasks || []), sub.id] }, `你加了子任务：${cut(sub.title, 40)}`, { who: 'you', at: now })]);
  return readCards().find(x => x.id === sub.id);
}
