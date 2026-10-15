// 任务和对话怎么连着（任务卡片，L 线 10-03，design/handoff/L-任务卡片-接口.md）：任务是任务页里的一张卡，对话栏只放对话。
//   普通聊天里起的活    聊天还是那段聊天（不变成任务对话，也不另开一段）；起活的那句后面原地一条 kind 'task_link' 的小条：
//                       活的 id、标题，状态读的时候从卡现算（taskMessages）。卡上 from.session_id / message_id 记从哪句起的。
//   没有发起对话的活    岗位页、收件箱、定时周期、补出来的卡：不开对话，要问你的进收件箱（lib/task-writer.mjs writerAsks 等）。
//   T2 / T5 建的任务对话 文件留着不删，不进对话历史（lib/chat.mjs taskOnly）。
// 状态只在卡上（deriveCard / deriveGoal）；任务目录、卡片、对话里的小条都用这里的六态换算（taskStatus）。
import crypto from 'node:crypto';
import { read, write, lines } from './store.mjs';
import { readCards, saveCards, makeCard, deriveGoal, headline, leadRef, sixOf } from './cards.mjs';
import { crewName } from './crew.mjs';
import { taskSessionId, taskOnly } from './chat.mjs';
import { chipOf } from './status.mjs';
export { taskSessionId, taskOnly };

const CHAT_DIR = 'state/chat';
const iso = t => new Date(t).toISOString();
const rid = () => crypto.randomBytes(6).toString('hex');
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ── 六态（lib/tasks.mjs TASK_STATUS，接口第一节第 2 条）：任务目录、卡片、对话小条上用同一个换算。排队不算在做。──
export { TASK_STATUS, SIX, sixOf } from './cards.mjs';
export function taskStatus(card) {
  if (!card) return null;
  return { status: sixOf(card.status), ...chipOf(card), ...(['todo','later'].includes(card.owner_control?.action) ? {word:'待做'} : {}), ...(card.status === 'cancelled' ? { withdrawn: true } : {}) };
}
// 没做成的那一张：目标卡是它下面没做成的那一棒，单卡就是自己。
export const failingCard = (top, all = []) => top?.kind === 'goal' ? all.find(c => c.goal === top.id && c.status === 'stuck') || top : top;
// 「再试一次」点过几次：每次「放回排队」是你点的一次再试（web/talk.js retriesOf 同一个算法）。同一件连着 MAX_TRIES 次没成就不再接。
export const MAX_TRIES = 3;
export const taskTries = c => Math.max(0, (c?.steps || []).filter(s => s.who === 'you' && /放回排队/.test(String(s.text || ''))).length - (c?.resource_recovery?.kind === 'legacy_busy' ? c.resource_recovery.ignored_retries || 0 : 0));
// 一件活最上面那张卡：子卡归到它的目标上。
export const topCard = (card, all) => card?.goal ? all.find(c => c.id === card.goal) || card : card;
// 卡现在的状态：目标卡由它下面的卡推（子卡存的就是同步时推好的那一份）；别的卡用存下的（syncTasks 推出来变了就存）。
export const shownCard = (card, all) => card?.kind === 'goal' ? deriveGoal(card, all) : card;

// ── 对话文件 ─────────────────────────────────────────────────────────────────
const pathOf = id => `${CHAT_DIR}/${id}.json`;
export const readSession = id => /^[a-z0-9]{8,32}$/.test(String(id || '')) ? read(pathOf(id), null) : null;
// 一件活的那句「怎么来的」：对话里第一条（system 说的，不是哪位成员）。
export const originLine = (text, now = Date.now()) => ({ id: rid(), role: 'system', kind: 'task_origin', content: cut(text, 200), at: iso(now) });
// 给一件活开它自己的对话（已经有了就不再开）。T2 留下来的：现在只有演示数据（bin/demo-seed.mjs）还用它造旧样子的数据。origin：怎么来的（第一条消息）；extra：asked_in、routine 之类。→ 对话 id
export function openTaskSession(card, { origin = '', id = null, now = Date.now(), messages = null, extra = {} } = {}) {
  const sid = id || card.session_id || taskSessionId(card.id);
  if (readSession(sid)) return sid;
  const at = iso(now), persona = card.owner && card.owner !== 'team' ? card.owner : 'scout';
  write(pathOf(sid), { id: sid, persona, backend: null, title: headline(card.title) || '新对话', title_by: 'task', created_at: at, updated_at: at, messages: messages || (origin ? [originLine(origin, now)] : []), task: card.id, ...extra });
  return sid;
}
// 往一段对话后面加一条（读了马上写；lib/chat.mjs saveSession 写之前会把磁盘上多出来的消息并进来，谁也不覆盖谁）。
export function appendMessage(sid, msg, { touch = true } = {}) {
  const s = readSession(sid);
  if (!s) return false;
  s.messages = [...(s.messages || []), msg];
  if (touch) s.updated_at = msg.at || iso(Date.now());
  write(pathOf(sid), s);
  return true;
}
// 普通聊天里起了一件活：原地留的那一行小条（旧页面不认这一类，照样把 content 当一句话画出来）。不带对话 id：点了打开这件的卡片。
export const taskLink = (card, { now = Date.now(), after = null } = {}) => ({ id: rid(), role: 'system', kind: 'task_link', task: card.id, title: headline(card.title), content: headline(card.title), at: iso(now), ...(after ? { after } : {}) });

// ── 不是从对话里起的活 ─────────────────────────────────────────────────────────
// 补出来的卡（交办任务没卡的，lib/tasks.mjs adoptJobs）是怎么来的：卡片「做了什么」的第一行按任务的来源写。
const SOURCE_WORD = { inbox: '你在收件箱里答了一封信，开了这件事', room: '你交代的', dashboard: '你在工作台上点的', talk: '你在对话里交代的' };
export function jobOrigin(job = {}, card = {}) {
  if (card.from?.by === 'repair') return `${crewName('patch')} 排的修复`;
  if (card.from?.by === 'cycle') return '定时周期排的';
  const said = job.source === 'room' && job.details ? `：「${cut(job.details, 60)}」` : '';
  return (SOURCE_WORD[job.source] || '你交代的') + said;
}
// 岗位页上点的「怎么准备」「公司调研」（POST /api/company，lib/company-brief.mjs requestPrep / requestBrief）：
// 排上了就建卡（不开对话：卡片的底写「来自岗位页」）；这件事已经有一张没结束的卡了就用那张。→ { task }，或者 null（没排上：没有 JD、没有模型、公司不明）。
const PAGE_WORD = { prep: '你在岗位页上点了「怎么准备」', brief: '你在岗位页上点了「公司调研」' };
export function pageTask({ action, record_id = null, company = '', result = {}, asked_at = Date.now(), now = Date.now() } = {}) {
  const ok = action === 'prep' ? ['writing', 'ready', 'already'].includes(result.status) : ['queued', 'already'].includes(result.status) && !!result.job_id;
  if (!ok) return null;
  const l = record_id ? lines('state/leads.ndjson').filter(x => (x.record_id === record_id || x.id === record_id) && !x.superseded).at(-1) || null : null;
  const all = readCards(), kind = action === 'prep' ? 'prep' : 'research', ref = l ? leadRef(l) : null;
  const live = c => !['done', 'cancelled'].includes(c.status);
  let card = action === 'prep'
    ? all.find(c => c.kind === 'prep' && live(c) && ref && (c.leads || []).some(x => x.rid === ref.rid))
    : all.find(c => c.links?.job_id === result.job_id);
  if (card) card = topCard(card, all);
  if (!card) {
    card = makeCard({ kind, leads: ref ? [ref] : [], from: { by: 'you', via: 'page' }, links: action === 'prep' ? { prep_at: iso(asked_at) } : { job_id: result.job_id }, status: 'running', now, ...(action === 'brief' && !ref && company ? { title: `${company} · 公司调研` } : {}) });
    if (action === 'prep') card.started_at = iso(now);
    saveCards([card]);
  }
  return { task: card.id };
}
export const pageWord = action => PAGE_WORD[action] || '你在岗位页上点的';

// ── 读的时候：对话历史的每一行、收件箱的每一封信带上这件活 ─────────────────────────────
// 收件箱的信 → 它属于哪件活（卡的 links.ask_id 反查；目标停下来问的那封是 goal:<目标 id>）。加 task、task_title、task_session。
export function askTasks(view = {}, cards = null) {
  let all; try { all = cards || readCards(); } catch { return view; }
  const byAsk = new Map();
  for (const c of all) if (c.links?.ask_id && !byAsk.has(c.links.ask_id)) byAsk.set(c.links.ask_id, topCard(c, all));
  const asks = (view.asks || []).map(a => {
    const g = /^goal:(.+)$/.exec(String(a.id || ''))?.[1];
    const c = (g && all.find(x => x.id === g)) || byAsk.get(a.id) || (a.card && all.find(x => x.id === a.card)) || null;
    return c ? { ...a, task: c.id, task_title: headline(c.title), task_session: c.session_id || null } : { ...a, task: a.task || null };
  });
  return { ...view, asks };
}
// 页面打开对话面板时默认接着的那段（lib/talk.mjs pickSession）：不是从对话里起的活（岗位页、补的卡、定时周期）、任务专用的对话不算。
export const madeElsewhere = s => !!s?.origin || taskOnly(s);
