// 监工每做一件事写两处（方案-System监工-第2批.md 第三节）：
//   运行日志  一行人话（state/events.ndjson，actor system、step supervise），团队页、运行记录照常读得到；
//   动作账    state/system-actions.ndjson：哪一条标准做法、对谁、为什么、做之前的状态、怎么撤销。
// 一行：{ id, at, play, hand, member, why, before, undo: { how, until? } | null, text, undone_at? }
// 撤销也记一行（undo_of 指回原来那一行），原来那一行不改：账只往后加。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lines, file, read } from '../store.mjs';
import { event } from '../events.mjs';
import { noteSwallowed } from '../swallow.mjs';

export const ACTIONS_PATH = 'state/system-actions.ndjson';
// 监工自己的错（lib/system/watch.mjs watchTick 写）：{ day, said, tick_errors: { streak, since, last_at, why } }。
export const WATCH_STATE = 'state/system-watch.json';
export const WATCH_DOWN_TICKS = 3;
export const loadWatch = () => { try { const s = read(WATCH_STATE, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch (e) { noteSwallowed('system.loadWatch', e, { doing: '读监工自己的记录', then: '从空的重新记' }); return {}; } };
// 「监工停了」：连着 WATCH_DOWN_TICKS 拍以上抛错、最近一拍在十分钟内（停了 System 或关了服务，就不算还在错）。没有就是 null。
export function watchDown({ now = Date.now(), state = loadWatch() } = {}) {
  const t = state.tick_errors;
  if (!t || (Number(t.streak) || 0) < WATCH_DOWN_TICKS || now - Date.parse(t.last_at || 0) > 10 * 60e3) return null;
  return { streak: Number(t.streak), since: t.since || null, why: t.why || null };
}
const append = (p, row) => { fs.mkdirSync(path.dirname(file(p)), { recursive: true }); fs.appendFileSync(file(p), JSON.stringify(row) + '\n'); };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function recordAction({ play, hand, member = 'patch', why, before = null, undo = null, text, now = Date.now() } = {}) {
  if (!play || !text) throw Error('监工的动作要写清是哪一条标准做法、做了什么');
  const row = { id: `sa-${now}-${crypto.randomUUID().slice(0, 8)}`, at: new Date(now).toISOString(), play, hand: hand || null, member, why: cut(why, 300), before, undo, text: cut(text, 200) };
  append(ACTIONS_PATH, row);
  event('system', 'supervise', 'ok', `System：${row.text}`, { play, hand: row.hand, member, action_id: row.id });
  return row;
}

export function undoAction(id, { by = 'you', now = Date.now(), text = null } = {}) {
  const all = lines(ACTIONS_PATH), row = all.find(r => r.id === id && !r.undo_of);
  if (!row) throw Error('没有这一条');
  if (!row.undo) throw Error('这一条不用撤销');
  if (all.some(r => r.undo_of === id)) return { already: true, row };
  const back = { id: `sa-${now}-${crypto.randomUUID().slice(0, 8)}`, at: new Date(now).toISOString(), undo_of: id, play: row.play, hand: row.hand, member: row.member, by, text: cut(text || `撤销了：${row.text}`, 200) };
  append(ACTIONS_PATH, back);
  event(by === 'you' ? 'user' : 'system', 'supervise', 'ok', back.text, { play: row.play, hand: row.hand, member: row.member, action_id: back.id, undo_of: id });
  return { already: false, row, back };
}

// 最近做过的几件（新的在前），撤销过的标上 undone_at。
export function recentActions({ limit = 10 } = {}) {
  const all = lines(ACTIONS_PATH), undone = new Map(all.filter(r => r.undo_of).map(r => [r.undo_of, r.at]));
  return all.filter(r => !r.undo_of).slice(-limit).reverse().map(r => (undone.has(r.id) ? { ...r, undone_at: undone.get(r.id) } : r));
}
