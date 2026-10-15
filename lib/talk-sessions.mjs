// 对话的会话（第 4 步收口，从 lib/talk.mjs 挪下来）：最近说过话的几段、手上那一段是哪段，Writer 在手上那段说一句（writerNote）。
// 只读写会话文件（lib/chat.mjs），不认话、不派活：Writer 的活（lib/resume-talk.mjs）提醒你时引这里，不往上引对话面板。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadSession, newSession, saveSession, sessionExists, mergeReplies, validId, listSessions, CHAT_DIR, REPLIES_PATH } from './chat.mjs';
import { read, lines, file } from './store.mjs';
import { madeElsewhere } from './task-chat.mjs';

const iso = t => new Date(t).toISOString();
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const rid = () => crypto.randomBytes(6).toString('hex');
const rid_ = rid; // 参数叫 rid（线索编号）的地方用它
export const RECENT_MS = 6 * 3600000; // 「团队」接着用 6 小时内说过话的会话；更早的就开新的
export const WATCH_MS = 24 * 3600000; // 「团队在做 N 件」和回复提醒看最近一天动过的会话
// 最近一天动过的会话（按文件修改时间先筛，再读），执行器的回复一并并进去。
export function recentSessions({ now = Date.now(), within = WATCH_MS, limit = 12 } = {}) {
  const dir = file(CHAT_DIR);
  if (!fs.existsSync(dir)) return [];
  const replies = lines(REPLIES_PATH);
  return fs.readdirSync(dir).filter(n => /^[a-z0-9]{8,32}\.json$/.test(n)).map(n => ({ n, t: fs.statSync(file(`${CHAT_DIR}/${n}`)).mtimeMs })).filter(x => now - x.t < within).sort((a, b) => b.t - a.t).slice(0, limit)
    .map(x => { try { const s = read(`${CHAT_DIR}/${x.n}`, null); return s?.id ? mergeReplies(s, replies) : null; } catch { return null; } }).filter(Boolean) /* 兜底：这份会话文件坏了或正在写：这一份不列，别的照常 */
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
// 手上的会话：给了 session_id 就是它；member（老接口，面板不再传）接着和这位单独说过的最近那段；
// 不给就接着 6 小时内最近的那段（会话都是团队的，老的单人会话也算），没有就是 null（第一句话时新建）。
export function pickSession({ session_id, member, recent, now }) {
  if (session_id) return recent.find(s => s.id === session_id) || (sessionExists(session_id) ? loadSession(session_id) : null);
  if (member) { const x = listSessions().find(s => s.member === member); return x ? recent.find(s => s.id === x.id) || loadSession(x.id) : null; }
  // 不是从对话里起的活（岗位页、补的卡、定时周期，lib/task-chat.mjs origin）不算手上那段。
  return recent.find(s => !madeElsewhere(s) && now - Date.parse(s.updated_at || 0) < RECENT_MS) || null;
}
// Writer 在手上那段对话里说一句（不跑模型）：你自己写的字找不到出处时的提醒（lib/resume-talk.mjs yourTextNote）。
// 没有 6 小时内的对话就新开一段。kind:'writer_note'：页面上是 Writer 的一句话，下面不挂「交给团队去做」。
// session_id：你正看着的那段对话（材料页改字时带来的）；认不出就照旧用手上那段。
export function writerNote(content, { now = Date.now(), session_id = null } = {}) {
  const recent = recentSessions({ now }), own = session_id && validId(session_id) ? pickSession({ session_id, recent, now }) : null;
  const session = own || pickSession({ recent, now }) || newSession({ persona: 'tailor', now });
  const at = iso(now), msg = { id: rid_(), role: 'assistant', persona: 'tailor', kind: 'writer_note', at, content: cut(content, 300) };
  session.messages.push(msg);
  session.updated_at = at;
  saveSession(session);
  return { session_id: session.id, message_id: msg.id };
}
