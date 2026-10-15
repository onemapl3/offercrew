// 操作台排队（0.1.3，L 线）：一次只跑一个（大家写同一套本地文件，lib/command-center.mjs opBusy）。以前别的在跑时按钮灰着、
// 写「跑完再点」，要你守着回头再点；现在点了就排到后面，手上那一项跑完（写锁放开）工作台自己接着起。
//   state/op-queue.json  { items: 排着的（先来先跑）, done: 最近结束排队的（起了 / 取消了 / 没跑），留 30 条 }
//   只有工作台进程写它（成员页、团队页按钮、对话里的「运行 X」「Radar 跑一轮」、bin/serve.mjs 每 3 秒的 queueTick）。
//   同一项操作只排一次（成员的「立即跑一轮」就是 round-<成员>，同一位也只排一次）；取消了就从队列里拿掉，什么都不跑。
//   工作台重启了排着的还在（文件里）；排了 12 小时还没轮上就不跑了，说清楚为什么。
// 这里只管队列本身：要不要跑、开跑前再过一遍哪道闸、怎么起，都由调用方传进来（lib/crew-desk.mjs runOrQueue / queueTick）。
import crypto from 'node:crypto';
import { read, write } from './store.mjs';
import * as J from './jobs.mjs';
import { noteSwallowed } from './swallow.mjs';
import { readCards } from './cards.mjs';
import { controlled } from './task-control.mjs';

export const QUEUE_PATH = 'state/op-queue.json';
export const QUEUED_LINE = '排在这一轮后面，跑完自动接着跑';
export const MAX_WAIT_MS = 12 * 3600000;
const iso = t => new Date(t).toISOString();
const load = () => { let q = null; try { q = read(QUEUE_PATH, null); } catch (e) { noteSwallowed('op-queue.load', e, { doing: '读排队记录', then: '当没有排着的活' }); } return { items: Array.isArray(q?.items) ? q.items : [], done: Array.isArray(q?.done) ? q.done : [] }; };
const save = q => write(QUEUE_PATH, { items: q.items, done: q.done.slice(0, 30) });
// 排着的那一项挂着任务卡：取消了、没跑（开跑前闸没过、排太久）直接记在卡的那件活上（线 S，账是唯一的出处）；起了由 runOp 记。
const ledger = (item, status, extra) => {
  if (!item.card_id || !['cancelled', 'dropped'].includes(status)) return;
  try { const j = J.byRef(`card:${item.card_id}`); if (j) J.drive(j.id, status === 'cancelled' ? 'cancelled' : 'failed', status === 'cancelled' ? {} : { reason: `没跑：${extra.why || '开跑前没过闸'}` }); }
  catch (e) { console.error(`[jobs] 排队记账出错：${e.message}`); }
};
const end = (q, item, status, now, extra = {}) => { q.items = q.items.filter(x => x.id !== item.id); q.done.unshift({ ...item, status, ended_at: iso(now), ...extra }); ledger(item, status, extra); };

export const queued = () => load().items;
export const queueState = () => load();
export const queuedOp = op => load().items.find(x => x.op === op) || null;
// 一条排队记录：还排着的 status 是 queued；结束了的是 started（带 op_id）/ cancelled / dropped（带 why）。
export function queueRecord(id) {
  const q = load(), item = q.items.find(x => x.id === id);
  return item ? { ...item, status: 'queued' } : q.done.find(x => x.id === id) || null;
}
// 这一项最近一次排着却没跑（开跑前闸没过、排太久）：成员页那一行写原因。
export const lastDropped = op => load().done.find(x => x.op === op && x.status === 'dropped') || null;

// 排上：同一项已经排着就不再排（dup），返回已经排着的那条。ahead：前面还有几个。
export function enqueue(op, { label = op, member = null, by = 'you', now = Date.now(), record_id = null, card_id = null, url = null, email = null } = {}) {
  const q = load(), have = q.items.findIndex(x => x.op === op && (card_id ? x.card_id === card_id : !x.task_bound) && (x.record_id || null) === record_id && (x.url || null) === url && (x.email || null) === email);
  if (have >= 0) return { item: q.items[have], dup: true, ahead: have };
  const item = { id: `q-${now}-${crypto.randomBytes(3).toString('hex')}`, op, label, member, by, at: iso(now), expires_at: iso(now + MAX_WAIT_MS), ...(record_id ? { record_id } : {}), ...(card_id ? { card_id, task_bound: true } : {}), ...(url ? { url } : {}), ...(email ? { email } : {}) };
  q.items.push(item); save(q);
  return { item, dup: false, ahead: q.items.length - 1 };
}
export function setCard(id, card_id) {
  const q = load(), item = q.items.find(x => x.id === id);
  if (!item || item.card_id === card_id) return;
  item.card_id = card_id; save(q);
}
// 取消：还排着就拿掉（什么都不跑），返回那一条；已经起了 / 不在队列里：null。
export function cancelQueued(id, { now = Date.now(), by = 'you' } = {}) {
  const q = load(), item = q.items.find(x => x.id === id || x.op === id);
  if (!item) return null;
  end(q, item, 'cancelled', now, { by_cancel: by }); save(q);
  return item;
}

// 轮到下一个：手上没有在跑的（busy() 为空）就起排在最前面的那一个，一次只起一个。
// 开跑前再过一遍 gate(op) → { ok, why }（模型、本机 AI 开关……）：过不了就不跑，记下原因（dropped），接着看下一个。
// start(op, { now, record_id }) 起它，返回运行记录（有 id）；起的时候又撞上别的在跑（busy 又有了）就照旧排着。
// 返回 { started, item } / { waiting: 原因 } / { dropped: [...] } / null（队列是空的）。同步执行：同一进程里两次调用不会交错。
export function queueTick({ busy, gate = () => ({ ok: true }), start, now = Date.now(), maxWaitMs = MAX_WAIT_MS } = {}) {
  const q = load();
  if (!q.items.length) return null;
  const dropped = [];
  const drop = (item, why) => { end(q, item, 'dropped', now, { why }); dropped.push({ ...item, why }); };
  let cancelled = 0;
  const cards = readCards();
  for (const item of [...q.items]) if (item.card_id) {
    const c = cards.find(x => x.id === item.card_id);
    if ((!c && item.task_bound) || c && (controlled(c) || c.manual || ['cancelled', 'done'].includes(c.status))) { end(q, item, 'cancelled', now, { by_cancel: 'task_state' }); cancelled++; }
  }
  for (const item of [...q.items]) if (now - Date.parse(item.at) >= maxWaitMs) drop(item, '排了太久还没轮上，这次不跑了');
  const why = q.items.length ? busy() : null;
  if (why) { if (dropped.length || cancelled) save(q); return { waiting: why, dropped }; }
  while (q.items.length) {
    const item = q.items[0];
    let g; try { g = gate(item.op) || { ok: true }; } catch (e) { g = { ok: false, why: String(e.message || e) }; }
    if (!g.ok) { drop(item, g.why || '现在跑不了'); continue; }
    let rec;
    try { rec = start(item.op, { now, ...(item.record_id ? { record_id: item.record_id } : {}), ...(item.card_id ? { card_id: item.card_id } : {}), ...(item.url ? { url: item.url } : {}), ...(item.email ? { email: item.email } : {}) }); }
    catch (e) {
      const still = busy();
      if (still || e.code === 'OP_BUSY') { save(q); return { waiting: still || e.message, dropped }; }
      drop(item, String(e.message || e).slice(0, 160)); continue;
    }
    end(q, item, 'started', now, { op_id: rec?.id || null });
    save(q);
    return { started: rec, item, dropped };
  }
  save(q);
  return { dropped };
}
