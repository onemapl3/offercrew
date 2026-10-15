// 旧的对话和卡片怎么接到任务卡片上（任务卡片，L 线 10-03；前身是 T5 的「旧卡打开是现场拼的只读对话」）：只往上加，不改旧文件，不删东西。
//   做了什么    一件活的「做了什么」（historyOf）：起头那句（from.session_id + message_id 找回你说的那句，找不到按从哪来写一句）→
//               每一棒的交接单、每一步、跑一轮的几位做到哪 → Writer 在对话里问的、你答的 → 结果。旧的在上，读的时候拼，不写文件。
//               旧卡（没有 session_id 的、legacyCards 拼的 job:<id>）也一样拼。
//   Writer 的旧活 对话里 kind 'writer'、还没有卡的：没做完的（等你、在做），或者今天有动静的，补一张卡（adoptWriter，syncTasks 里调），
//               session_id 就是它起头的那段对话；更早的不补。卡号由「对话 id + 起头那条」定，同步几次都是那一张。
//   旧对话里的卡 goal / card 消息、task_link 小条带上 task（最上面那张）、title 和现算的六态（taskMessages），只加字段；不再带对话 id。
// 新字段旧代码不认：退回旧版照常能用，数据不用改回去。
import { dayOf, zonedTime } from './tz.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { file, lines } from './store.mjs';
import { lastRev, legacyCards } from './cards.mjs';
import { readCards, headline, relayHead, stuckText, waitLine } from './cards.mjs';
import { taskSessionId, readSession, taskStatus, topCard, shownCard, jobOrigin, pageWord } from './task-chat.mjs';
import { writerChain, writerState, writerCard, writerKind, letterKindOf } from './task-writer.mjs';
import { writerResults, writerTask } from './resume-talk.mjs';
import { crewName, crewOf, kindLabel } from './crew.mjs';
import { plainText } from './plain-words.mjs';
import { prepFor, prepSummary, prepHistoricalResult } from './company-brief.mjs';

const CHAT_DIR = 'state/chat';
const iso = t => new Date(t).toISOString();
const T = x => Date.parse(x || '') || 0;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const h = (s, n) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// ── 找卡：任务清单里的，加上 legacyCards 拼的旧记录 ─────────────────────────────────
const jobsNow = () => lastRev(lines('state/host-jobs.ndjson'));
export function allCards(cards = null, jobs = null) {
  const stored = cards || readCards();
  return [...stored, ...legacyCards(jobs || jobsNow(), stored)];
}
// 卡 id → 这件活最上面那张（子卡归到目标上）。
export function findTask(id, all = allCards()) {
  const c = all.find(x => x.id === id);
  return c ? topCard(c, all) : null;
}
// 这件活的对话现在有没有文件：卡上记的那段，或者按卡号算的那段（T2 / T5 留下的）。
export function liveSession(card) {
  if (!card) return null;
  for (const sid of [card.session_id, taskSessionId(card.id)]) if (sid && readSession(sid)) return sid;
  return null;
}
// GET /api/chat?task=<卡 id>：T2 / T5 留下的那段任务对话还在就给它的 id（只读着看）；没有就是 null。任务的全部在卡片上（GET /api/tasks/<id>/card）。
export function taskChat(id, { cards = null } = {}) {
  const all = allCards(cards), top = findTask(String(id || ''), all);
  const sid = top ? liveSession(top) : null;
  return sid ? { session_id: sid, task: top.id } : null;
}

// ── 做了什么 ──────────────────────────────────────────────────────────────────
// 一行：{ at, who, text, evidence? }。who 是成员 id、'you'，或者 null（系统那一行）。
// who 记成成员 id（老编号 reacher、radar 这类换成现在那一位，页面照它写显示名，不露编号）；你、本机 AI 照旧；认不出的不写是谁。
// 文字里的原始链接、成员编号也换掉（lib/plain-words.mjs，主会话实测 10-04 第 6、8 条）。
const whoOf = who => !who || who === 'team' ? null : ['you', 'ai', 'executor'].includes(who) ? who : crewOf(who) || null;
const row = (at, who, text, evidence = null) => ({ at: at || null, who: whoOf(who), text: cut(plainText(text, { nameOf: crewName }), 300), ...(evidence?.length ? { evidence: evidence.slice(0, 4) } : {}) });
const said = (s, id) => s && id ? (s.messages || []).find(x => x.id === id) || null : null;
// 起头那一行：你在哪段对话里说的那句（找回来引原话）；不是从对话里起的照来源写。
function openingRow(card, jobs = []) {
  const f = card.from || {}, at = card.created_at || card.updated_at;
  const m = said(f.session_id ? readSession(f.session_id) : null, f.message_id);
  if (m?.content && m.role === 'user') return row(m.at || at, 'you', `你在对话里说「${cut(m.content, 80)}」`);
  if (f.via === 'page') return row(at, 'you', card.links?.writer ? '你在岗位页上点了「按岗位定制」' : pageWord(card.kind === 'prep' ? 'prep' : 'brief'));
  if (card.links?.job_id) return row(at, f.by === 'repair' ? 'patch' : f.by === 'cycle' ? null : 'you', jobOrigin(jobs.find(j => j.id === card.links.job_id) || {}, card));
  if (f.by === 'cycle' || card.routine) return row(at, null, '定时周期排的');
  if (f.by === 'repair') return row(at, 'patch', jobOrigin({}, card));
  return row(at, 'you', `你新建了这件事：${headline(card.title)}`);
}
// Writer 的活：在发起它的那段对话里，这件活自己的那几条 Writer 消息（lib/task-writer.mjs writerChain：再试一次、点按钮开出来的跟着来源走），
// 和引出它们的你那几句（点的是这件活上的按钮，或者紧跟着的是这件活的 Writer 消息）。
function writerRows(card) {
  const s = card.session_id ? readSession(card.session_id) : null, msgs = s?.messages || [];
  const i = msgs.findIndex(m => m.id === card.links?.writer);
  if (i < 0) return [];
  const own = new Set(writerChain(s, card.links.writer, card.links.writer_next).map(m => m.id));
  const nextWriter = k => { for (const m of msgs.slice(k + 1)) { if (m.role === 'user') return null; if (m.kind === 'writer' && m.writer) return m; } return null; };
  const out = [];
  msgs.forEach((m, k) => {
    if (k < i) return;
    if (m.role === 'user') { if (own.has(m.action?.message_id) || own.has(nextWriter(k)?.id)) out.push(row(m.at, 'you', m.action ? `你点了「${cut(m.content, 40)}」` : `你说「${cut(m.content, 80)}」`)); return; }
    if (!own.has(m.id)) return;
    const t = writerTask(m, s) || {};
    out.push(row(m.at, 'tailor', t.questions?.length ? `先问：${t.questions.map(q => q.text).join(' ')}` : String(t.result || t.short || m.content || '').split('\n')[0]));
  });
  return out;
}
// 以前记下的接力那一行，两棒是同一位的写成了「Reacher → Reacher：…，交给你预填申请表」：现在读的时候换成两步的名字（文件不改）。
function relayText(c, cards) {
  const r = c.relay, t = String(r.text || ''), same = r.from && r.from === r.to, head = same ? `${crewName(r.from)} → ${crewName(r.to)}：` : null;
  const prev = same && c.from?.card ? cards.find(x => x.id === c.from.card) : null;
  if (!head || !prev || !t.startsWith(head)) return t;
  const tail = `，交给你${kindLabel(c.kind)}`, rest = t.slice(head.length);
  return `${relayHead(prev, c)}：${rest.endsWith(tail) ? rest.slice(0, -tail.length) : rest}`;
}
// asks：收件箱里现在的信（问你的那一句拿它的原话）；不给就用卡上的说法。jobs：交办任务（补出来的卡写来源用）。
export function historyOf(top, { all = null, asks = null, jobs = null } = {}) {
  const cards = all || allCards(), shown = shownCard(top, cards);
  const parts = top.kind === 'goal' ? [top, ...cards.filter(c => c.goal === top.id).sort((a, b) => T(a.created_at) - T(b.created_at))] : [top];
  const out = [openingRow(top, jobs || [])];
  for (const c of parts) {
    const h0 = c.handoff;
    // 接力那一行（card.relay：哪位交给哪位、交的是什么）比交接单的「事」说得具体，有就用它。
    if (c.relay?.text) out.push(row(c.created_at, c.relay.from || h0?.from || c.owner, relayText(c, cards)));
    else if (h0) out.push(row(c.created_at, h0.from || c.owner, `${crewName(h0.from) || '你'} → ${crewName(h0.to) || '团队'}：${h0.what || '接着做'}${h0.known ? `。已经知道的：${h0.known}` : ''}`));
    // 「认领了」是建卡时自动记的一笔，不算做了什么。
    // Writer 的活上 System 记过的「放回排队再试一次」（0.1.1 以前）：它的状态看对话，那一下其实什么也没再做，不列。
    for (const st of c.steps || []) if (!/认领了$/.test(String(st.text || '')) && !(c.links?.writer && st.who === 'patch' && /放回排队再试一次/.test(String(st.text || '')))) out.push(row(st.at || c.updated_at, st.who || c.owner, prepHistoricalResult(c, st.text), st.evidence));
    for (const st of c.run_steps || []) out.push(row(st.at, st.who, prepHistoricalResult(c, st.text)));
    if (c.links?.writer) out.push(...writerRows(c));
    if (c !== top && c.status === 'done' && c.result) out.push(row(c.done_at || c.updated_at, c.owner, prepHistoricalResult(c, c.prep_recorded_result || c.result), c.evidence));
  }
  const last = shown.done_at || shown.updated_at || top.created_at;
  if (shown.status === 'done' && shown.result && !top.links?.writer) out.push(row(last, top.owner, prepHistoricalResult(shown, shown.prep_recorded_result || shown.result), top.evidence));
  if (shown.status === 'stuck') { const bad = parts.find(c => c.status === 'stuck') || shown; if ((bad.detail || shown.detail) && !out.some(r => r.text === (bad.detail || shown.detail))) out.push(row([bad.updated_at || last, ...(bad.steps || []).map(x => x.at)].filter(Boolean).sort().pop(), bad.owner, stuckText(bad, bad.detail || shown.detail), bad.evidence)); } // 不早于它的最后一步（System 放回去那一行之后才又没做成） // Writer 那一行已经说了没改成的，不再记一遍
  // 等你的那一句：收件箱里那封信的原话（目标停下来问的是 goal:<id>）；Writer 在对话里问的上面已经有了。
  // 进等你的时候已经记了一行（lib/tasks.mjs syncTasks）：不再拼一行收件箱的原话。
  const wc = parts.find(c => c.status === 'needs_you') || top, marked = !!wc.detail && wc.steps?.at(-1)?.text === waitLine(wc);
  if (shown.status === 'needs_you' && !top.links?.writer && !marked) {
    const id = top.halt && !top.halt.answered ? `goal:${top.id}` : (parts.find(c => c.status === 'needs_you')?.links?.ask_id || top.links?.ask_id || null);
    const a = id && asks ? asks.find(x => x.id === id) : null;
    const q = a?.question || a?.title || (id?.startsWith('goal:') ? top.halt.question : shown.detail || shown.need_title);
    if (q) out.push(row(a?.at || top.halt?.at || last, a?.from || top.halt?.from || (parts.find(c => c.status === 'needs_you') || top).owner, `等你：${q}`));
  }
  const seen = new Set();
  const prepCard = parts.find(c => c.kind === 'prep'), rid = prepCard?.leads?.[0]?.rid;
  const prep = rid && prepFor(rid), lead = prep && lines('state/leads.ndjson').find(l => (l.record_id || l.id) === rid);
  if (lead) out.push(row(prep.updated_at, 'lens', `当前有效准备：${prepSummary(lead, prep)}`));
  return out.filter(r => r.text && !seen.has(`${r.who}|${r.text}`) && seen.add(`${r.who}|${r.text}`)).sort((a, b) => T(a.at) - T(b.at));
}

// ── Writer 的旧活补卡 ─────────────────────────────────────────────────────────
// 一段对话里的 Writer 消息怎么分成几件：点了回复里的按钮开出来的、「再试一次」的、同一类同一个岗位接着说的，都算上一件；别的另起一件。
const family = w => `${writerKind(w)}|${letterKindOf(w) || ''}|${w?.lead?.rid || w?.lead?.number || ''}|${w?.letter || ''}`;
function writerGroups(s, cards) {
  const msgs = s.messages || [], covered = new Set();
  for (const c of cards) if (c.session_id === s.id && c.links?.writer) for (const m of writerChain(s, c.links.writer, c.links.writer_next)) covered.add(m.id);
  const groups = [];
  let cur = null, said = null;
  for (const m of msgs) {
    if (m.role === 'user') { said = m; continue; }
    if (m.kind !== 'writer' || !m.writer) continue;
    if (covered.has(m.id)) { if (cur) cur.next ??= m.id; cur = null; continue; }
    const follow = cur && (said?.action || (m.writer.retry_of && cur.ids.includes(m.writer.retry_of)) || family(m.writer) === cur.family);
    if (follow) { cur.ids.push(m.id); continue; }
    if (cur) cur.next = m.id;
    cur = { first: m, said, family: family(m.writer), ids: [m.id], next: null };
    groups.push(cur);
  }
  return groups;
}
// 看过、没变的对话文件不再读（按文件的修改时间）：同步很勤，对话文件一多就慢。
const seen = new Map();
export const writerCardId = (sid, mid) => `t-w${h(`writer|${sid}|${mid}`, 11)}`;
export function adoptWriter(cards = [], { now = Date.now() } = {}) {
  const dir = file(CHAT_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const today = new Date(zonedTime(dayOf(now))); // 本地时区的今天零点（lib/tz.mjs），不按这台电脑的时区
  const ids = new Set(cards.map(c => c.id)), firsts = new Set(cards.map(c => c.links?.writer).filter(Boolean));
  let results = null;
  const out = [];
  for (const n of names) {
    const fp = `${dir}/${n}`;
    let mt = 0;
    try { mt = fs.statSync(fp).mtimeMs; } catch { continue; }
    if (seen.get(fp) === mt) continue;
    const s = readSession(n.slice(0, -5));
    // 属于一件活的对话（T2 以后建的、补卡开的、例行的）不归这里管：那里的 Writer 消息一开口就有卡。
    if (!s || s.task || s.origin || s.routine) { seen.set(fp, mt); continue; }
    let open = false;
    for (const g of writerGroups(s, cards)) {
      const id = writerCardId(s.id, g.first.id);
      if (ids.has(id) || firsts.has(g.first.id)) continue;
      const links = { writer: g.first.id, ...(g.next ? { writer_next: g.next } : {}) };
      const st = writerState({ session_id: s.id, links }, { session: s, results: (results ??= writerResults()), now });
      if (!st) continue;
      const live = ['running', 'needs_you'].includes(st.status);
      if (live) open = true; // 还没做完的：这段对话下次还要看
      if (!live && T(st.at) < today.getTime()) continue; // 更早做完的（没做成的也一样）不补
      const card = writerCard(g.first, s, { said: g.said, now: T(g.first.at) || now, cardId: id, nextWriter: g.next });
      Object.assign(card, { status: st.status, detail: st.detail || '', result: st.result ?? null, backfill: true, updated_at: st.at || card.updated_at, ...(st.status === 'done' ? { done_at: st.at || iso(now) } : {}) });
      card.steps = []; // 不编「认领了」：这件活当时没有卡
      ids.add(id); firsts.add(g.first.id); out.push(card);
    }
    // 今天做完的明天就不补了，所以有今天的消息也得再看；只剩更早的、都做完的，看过就记下。
    if (!open && T(s.updated_at) < today.getTime()) seen.set(fp, mt);
  }
  return out;
}

// ── 对话里的小条：每件活一行，点了打开它的卡片 ─────────────────────────────────────
// GET /api/talk、/api/chat?session= 返回前：task_link 小条、旧对话里的 goal / card 消息带上 task（最上面那张）、title、status（六态）、status_word。
// 只加字段；task_link 不再带对话 id（以前另开一段时记的 session_id 读的时候去掉）。
export function taskMessages(session, { cards = null } = {}) {
  if (!session?.messages?.some(m => m.goal || m.card || m.kind === 'task_link')) return session;
  let all;
  try { all = allCards(cards); } catch { return session; }
  const byId = new Map(all.map(c => [c.id, c]));
  const messages = session.messages.map(m => {
    const id = m.kind === 'task_link' ? m.task : ['goal', 'card'].includes(m.kind) ? m.goal || m.card : null;
    const c = id ? byId.get(id) : null;
    if (!c) return m;
    const top = topCard(c, all), st = taskStatus(shownCard(top, all)), { session_id, task_session, ...rest } = m;
    return { ...rest, task: top.id, title: m.title || headline(top.title), status: st.status, state: st.state, word: st.word, tone: st.tone, ...(st.withdrawn ? { withdrawn: true } : {}) };
  });
  return { ...session, messages };
}
