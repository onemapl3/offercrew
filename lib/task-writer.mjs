// Writer 的活也是一张卡（方案-任务即对话 第二节 4、负责人 10-03 定）：Writer 一开口（先问几句、体检、改一句、写信）就建卡，
// kind 用 resume / letters，links.writer = 起头那条 Writer 消息的 id，卡上的 session_id 就是这段对话。
// 状态记在这张卡的那件活上（线 S 10-04，写的那一侧记）：Writer 开口建卡时、对话存下来时（lib/chat.mjs onSessionSaved：接着说、再试一次、答了问题）、
// 一条消息的结果记下来时（lib/resume-talk.mjs onWriterResult）、改的那份简历存下来时（lib/resume-store.mjs onDocSaved），按这段对话里从那条起最后一条 Writer 消息现在怎样（writerTask，和对话里的卡同一份）
// 经 jobs 记账（recordWriter）。读的时候不推，卡照账（lib/task-ledger.mjs driven）。
//   先问的问题出来了、还没答        等你（needs_you）
//   在想问题、在改、在写            在做（running）
//   出了版本卡 / 信的卡、体检做完…   做完（done）
//   没做成、程序重启没做完          卡住了（stuck）
import { read } from './store.mjs';
import { writerTask, writerResults, leadOfLetter, onWriterResult } from './resume-talk.mjs';
import { makeCard, readCards, headline } from './cards.mjs';
import { onSessionSaved } from './chat.mjs';
import { onDocSaved } from './resume-store.mjs';
import * as J from './jobs.mjs';
import { jobOfCard, CARD_STATE, cardSpec } from './task-ledger.mjs';

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const writerKind = w => /^letter_/.test(String(w?.kind || '')) ? 'letters' : 'resume';
// 信是哪一类：求职信和自我介绍是两类活（写新的看 letter_kind，改已有的看信的 key：intro-… 是自我介绍）。简历不分。
export const letterKindOf = w => w?.kind === 'letter_write' ? w.letter_kind || 'cover_letter' : /^letter_/.test(String(w?.kind || '')) ? (/^intro-/.test(String(w.letter || '')) ? 'self_intro' : 'cover_letter') : null;
// 这件活在这段对话里的那几条 Writer 消息：从起头那条往后（答完问题开的那一版、接着说的「再短一点」都算这件活）。
// next：补出来的旧活（lib/task-migrate.mjs adoptWriter）一段对话里有好几件，到下一件起头的那条为止（不含）。
// 只认这件活自己的（0.1.2，第 6b 轮开箱：一张卡做出来的东西算到了另一张卡头上）：「再试一次」（retry_of）、点了回复里的按钮
// （你那句的 action.message_id）、卡片上的指令（follow_of）开出来的那条，跟着它从哪条来的走——它们记在对话末尾，可能已经过了下一件起头的那条；
// 别的照位置算（起头那条到下一件起头之前）。
const sourceOf = (m, said) => m.writer?.retry_of || m.writer?.follow_of || said?.action?.message_id || null;
export function writerChain(session, first, next = null) {
  const msgs = session?.messages || [], i = msgs.findIndex(m => m.id === first);
  if (i < 0) return [];
  const j = next ? msgs.findIndex((m, k) => k > i && m.id === next) : -1;
  const writerIds = new Set(msgs.filter(m => m.kind === 'writer' && m.writer).map(m => m.id)), own = new Set(), out = [];
  let said = null;
  msgs.forEach((m, k) => {
    if (m.role === 'user') { said = m; return; }
    if (m.kind !== 'writer' || !m.writer || k < i) return;
    const src = k === i ? null : sourceOf(m, said);
    if (src && writerIds.has(src) && src !== m.id ? own.has(src) : k === i || j < 0 || k < j) { own.add(m.id); out.push(m); }
  });
  return out;
}
// 一张 Writer 卡现在是什么样：→ { status, detail, result, at, need_title } 或 null（那条消息不在了）。
export function writerState(card, { session = null, results = null, now = Date.now() } = {}) {
  const s = session || (card.session_id ? read(`state/chat/${card.session_id}.json`, null) : null);
  const chain = writerChain(s, card.links?.writer, card.links?.writer_next);
  const last = chain.at(-1);
  if (!last) return null;
  const t = writerTask(last, s, { results: results || writerResults(), now });
  if (!t) return null;
  const answered = (t.buttons || []).some(b => b.kind === 'resume_answers' && b.used);
  if (t.questions?.length && !answered) return { status: 'needs_you', detail: cut(t.head || '先问你几句', 140), result: null, at: t.updated_at, need_title: '答几个问题' };
  if (t.status === 'running' || (t.questions?.length && answered)) return { status: 'running', detail: '', result: null, at: t.updated_at };
  if (t.status === 'stuck' || t.bad) return { status: 'stuck', detail: cut(t.result, 140), result: null, at: t.updated_at };
  return { status: 'done', detail: '', result: cut(String(t.short || t.result || '做完了').split('\n')[0], 140), at: t.updated_at };
}
// ── 写的那一侧记账 ──────────────────────────────────────────────────────────────
// 把这张卡的那件活记到 Writer 现在的样子：在做（start，pid 记这个进程——Writer 在这个进程里跑，进程没了看门判「进程意外退出」）、
// 做完（带那一句结果）、没做成（带原因）、等你答（what：对话里起的去卡上答，别处起的是收件箱那封 writer:<卡 id>）。
// 已经停了的（做完、失败）只在这件活停下以后又有了新的一条（接着说、再试一次）时才翻回在做 / 等你（看门判的「进程意外退出」不被旧消息翻回去）；
// 停了的换一种停法（结果晚到、以前算错了的）照 Writer 自己的记录改。取消了的不碰。
const T = x => Date.parse(x || '') || 0;
export function recordWriter(card, { session = null, results = null, now = Date.now(), pid = process.pid } = {}) {
  if (!card?.id || !card.links?.writer || card.legacy) return null;
  try {
    const st = writerState(card, { session, results, now });
    if (!st) return null;
    let j = jobOfCard(card) || J.create({ ...cardSpec(card), now: T(card.created_at) || now });
    const to = CARD_STATE[st.status] || 'running';
    if (j.state === 'cancelled' || (j.state === to && to !== 'waiting_you')) return j;
    if (['done', 'failed'].includes(j.state) && ['running', 'waiting_you'].includes(to) && (T(st.at) || now) <= T(j.finished_at || j.updated_at)) return j;
    if (j.state === 'done') j = J.again(j.id, { now }) || j;
    const label = cut(st.need_title || '答几个问题', 40), data = { now, pid };
    if (to === 'done') data.result = { summary: cut(st.result || '做完了', 200) };
    if (to === 'failed') data.reason = cut(st.detail || st.result || '没做成', 200);
    if (to === 'waiting_you') { data.reason = cut(st.detail || '先问你几句', 400); data.what = card.from?.session_id ? { label, href: `#tasks?card=${encodeURIComponent(card.id)}` } : { label, ask_id: writerAskId(card) }; }
    return J.drive(j.id, to, data) || j;
  } catch (e) { console.error(`[jobs] Writer 的卡 ${card.id} 记账出错：${e.message}`); return null; }
}
// 这段对话里的 Writer 卡都记一遍（对话存下来时）。没有 Writer 消息的对话不读卡。
export function noteSession(s, { now = Date.now() } = {}) {
  if (!s?.id || !(s.messages || []).some(m => m.kind === 'writer')) return [];
  const cards = readCards().filter(c => c.session_id === s.id && c.links?.writer && c.status !== 'cancelled');
  if (!cards.length) return [];
  const results = writerResults();
  return cards.map(c => recordWriter(c, { session: s, results, now })).filter(Boolean);
}
// Writer 一条消息的结果记下来了（mid），或者 Writer 改的那份简历存了（doc：改出来的新版做完、没做成记在简历里）：
// 在最近三天动过的 Writer 卡的对话里找用到它的那几段，那几段的卡记一遍。
export function noteWhere(hit, { now = Date.now() } = {}) {
  const seen = new Set(), out = [];
  for (const c of readCards()) {
    if (!c.links?.writer || !c.session_id || c.status === 'cancelled' || seen.has(c.session_id) || T(c.updated_at) < now - 3 * 86400000) continue;
    seen.add(c.session_id);
    const s = read(`state/chat/${c.session_id}.json`, null);
    if ((s?.messages || []).some(m => m.kind === 'writer' && hit(m))) out.push(...noteSession(s, { now }));
  }
  return out;
}
onSessionSaved(s => noteSession(s));
onWriterResult(mid => noteWhere(m => m.id === mid));
onDocSaved(doc => { if ((doc.proposals || []).length) noteWhere(m => m.writer?.doc === doc.id && m.writer?.proposal_id); });
// Writer 一开口：给这条消息建卡。session：它所在的对话（卡上的 session_id）；said：你说的那句（卡的来源）。
export function writerCard(reply, session, { said = null, now = Date.now(), cardId = null, nextWriter = null } = {}) {
  const t = writerTask(reply, session, { now }) || {};
  // 改信的那条以前没记岗位（10-03 之前开的）：照信自己对着的岗位补上。
  if (!(t.leads || []).length && reply.writer?.letter) { const l = leadOfLetter(reply.writer.letter); if (l) t.leads = [l]; }
  const card = makeCard({ kind: writerKind(reply.writer), title: t.title || '', leads: (t.leads || []).filter(l => l.rid || l.number != null).map(l => ({ rid: l.rid, number: l.number ?? null, company: l.company || '', role: l.role || '' })), owner: 'tailor', from: { by: 'you', session_id: session.id, message_id: said?.id || null, ...(said?.via === 'page' ? { via: 'page' } : {}) }, how: 'model', links: { writer: reply.id, ...(nextWriter ? { writer_next: nextWriter } : {}) }, status: 'running', now });
  // 补旧卡时先定最终身份和消息边界，再建账；记账后换 id 会留下永远收不到结果的运行中任务。
  if (cardId) card.id = cardId;
  card.session_id = session.id;
  card.started_at = card.created_at;
  if (card.kind === 'letters') card.letter_kind = letterKindOf(reply.writer);
  const st = writerState(card, { session, now });
  if (st) Object.assign(card, { status: st.status, detail: st.detail || '', ...(st.result ? { result: st.result } : {}) });
  recordWriter(card, { session, now }); // 开工：卡的那件活由这里建、记在做（存卡时不再照卡上的状态改它）
  return card;
}
// ── 不是在对话里起的 Writer 的活：要问你的进收件箱（任务卡片，L 线 10-03）────────────────────
// 岗位页「按岗位定制」、信页「改一版」、任务页上新建的（卡上没有 from.session_id）没有发起它的对话：Writer 先问的那几句在它自己的那段（不进对话历史，
// lib/chat.mjs taskOnly）里，这里变成一封信（id writer:<卡 id>），卡片上「接下来」的「回答」和收件箱是同一封。
// 选项：「直接改」（不答，照原来的要求改）；写一句（其他）当回答；页面带了逐题的 answers 就照它。答了这封自己消失（问题答过了）。
export const writerAskId = card => `writer:${card.id}`;
export function writerAsks({ cards = null, now = Date.now() } = {}) {
  let all; try { all = cards || readCards(); } catch { return []; }
  const out = [];
  let results = null;
  for (const c of all) {
    if (!c.links?.writer || c.from?.session_id || ['done', 'cancelled'].includes(c.status) || c.manual || !c.session_id) continue;
    const s = read(`state/chat/${c.session_id}.json`, null);
    const st = writerState(c, { session: s, results: (results ??= writerResults()), now });
    if (st?.status !== 'needs_you') continue;
    const m = writerChain(s, c.links.writer, c.links.writer_next).filter(x => ['ask', 'letter_ask'].includes(x.writer?.kind)).at(-1);
    const t = m ? writerTask(m, s, { results, now }) : null;
    if (!t?.questions?.length) continue;
    const l = c.leads?.[0], step = kind => ({ type: 'writer', card: c.id, session_id: s.id, message_id: m.id, kind });
    out.push({
      from: 'tailor', id: writerAskId(c), type: 'decide', title: headline(c.title), question: cut(t.result || t.head, 600),
      context: ['Writer · 任务'], facts: [], questions: t.questions,
      ...(l ? { lead: { number: l.number ?? null, company: l.company || '', role: l.role || '', record_id: l.rid || null } } : {}),
      options: [{ key: '1', label: '直接改', steps: [step('resume_skip')], primary: true }],
      other: { steps: [step('resume_answers')] }, card: c.id,
    });
  }
  return out;
}
