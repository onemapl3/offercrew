// 跨执行器共享的记忆库。
//
// Claude Code（即时执行器）、Codex（周期 / 巡检）、对话页和用户本人各自有会话记忆，
// 互不可见；状态文件只记"现在是什么"，不记"为什么、踩过什么坑、用户怎么说的"。
// 这里就是那份共享的经验：一行一条，纯文本可读可改，谁都能在开工前 recall、收工后 add。
// 检索不上向量库：编号、公司、关键词（含中文双字）、置顶与时间衰减打分，够用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { file, lines, hash } from './store.mjs';
import { event } from './events.mjs';
import { TZ } from './tz.mjs';

export const MEMORY_PATH = 'state/memory/notes.ndjson';
export const KINDS = { decision: '决定', lesson: '教训', company: '公司备注', preference: '个人偏好', todo: '待办', fact: '事实' };
export const AUTHORS = ['user', 'chat', 'claude', 'codex', 'system', 'dashboard'];
export const MAX_TEXT = 2000;
const iso = x => new Date(x).toISOString();
const DAY = 86400000;
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const companyKey = s => norm(s).replace(/（.*?）|\(.*?\)/g, '').replace(/有限公司|股份|集团|科技|信息|网络|technolog(?:y|ies)|inc\.?|ltd\.?|co\.?|corp\.?|limited|group|\s+/gi, '').trim();

export const loadNotes = () => lines(MEMORY_PATH).filter(n => !n.deleted_at);
const writeAll = rows => { fs.mkdirSync(file('state/memory'), { recursive: true }); fs.writeFileSync(file(MEMORY_PATH), rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : '')); };
const toInts = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、]+/)).map(Number).filter(n => Number.isInteger(n) && n > 0))];
const toList = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,，、\n]+/)).map(x => String(x).trim()).filter(Boolean))];

export function validateNote({ by, kind, text, subject, numbers, companies, tags, evidence } = {}) {
  if (!AUTHORS.includes(by)) throw Error(`by 只能是 ${AUTHORS.join(' / ')}`);
  if (!KINDS[kind]) throw Error(`kind 只能是 ${Object.keys(KINDS).join(' / ')}`);
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) throw Error('正文不能为空');
  if (t.length > MAX_TEXT) throw Error(`正文最多 ${MAX_TEXT} 字`);
  const ev = evidence == null || evidence === '' ? null : String(evidence).trim();
  if (ev && !/^(runs\/|state\/|docs\/|plans\/|https?:\/\/)/.test(ev)) throw Error('evidence 只能是 runs/ state/ docs/ plans/ 下的路径或 URL');
  return { by, kind, text: t, subject: String(subject || '').trim().slice(0, 120) || null, numbers: toInts(numbers), companies: toList(companies).slice(0, 8), tags: toList(tags).slice(0, 10).map(x => x.toLowerCase()), evidence: ev };
}
export async function addNote(input = {}, { now = Date.now() } = {}) {
  const n = validateNote(input);
  const all = lines(MEMORY_PATH);
  const dup = all.find(x => !x.deleted_at && x.kind === n.kind && norm(x.text) === norm(n.text));
  if (dup) return { status: 'duplicate', note: dup };
  const note = { id: hash([n.by, n.kind, n.text, now, crypto.randomBytes(4).toString('hex')]).slice(0, 16), at: iso(now), ...n, pinned: !!input.pinned };
  fs.mkdirSync(file('state/memory'), { recursive: true });
  fs.appendFileSync(file(MEMORY_PATH), JSON.stringify(note) + '\n');
  event(n.by === 'user' || n.by === 'dashboard' ? 'user' : n.by === 'codex' ? 'heartbeat' : 'listener', 'memory', 'ok', `记忆库新增 ${KINDS[n.kind]}：${n.text.slice(0, 60)}`, { refs: n.evidence && n.evidence.startsWith('runs/') ? [{ file: n.evidence }] : [] });
  return { status: 'added', note };
}
export async function updateNote(id, patch = {}, { now = Date.now() } = {}) {
  const all = lines(MEMORY_PATH), n = all.find(x => x.id === id && !x.deleted_at);
  if (!n) throw Error('没有这条记忆');
  // 网页只送它改了的字段（serve.mjs 把没送的也传成 undefined）：没给的保持原值。
  patch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = validateNote({ ...n, ...patch, by: n.by });
  Object.assign(n, next, { pinned: patch.pinned == null ? !!n.pinned : !!patch.pinned, updated_at: iso(now) });
  writeAll(all);
  return { status: 'updated', note: n };
}
export async function deleteNote(id, { now = Date.now() } = {}) {
  const all = lines(MEMORY_PATH), n = all.find(x => x.id === id && !x.deleted_at);
  if (!n) throw Error('没有这条记忆');
  n.deleted_at = iso(now);
  writeAll(all);
  return { status: 'deleted', id };
}

// 查询词切成：拉丁单词 + 中文双字（"字节门户登录" → 字节 节门 门户 户登 登录）。
export function tokens(text) {
  const t = norm(text);
  const latin = t.match(/[a-z0-9][a-z0-9.+_-]{1,}/g) || [];
  const out = new Set(latin);
  for (const run of t.match(/[一-鿿]{2,}/g) || []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return [...out];
}
const STOP = new Set(['的', '了', '是', '在', '和', '有', '这', '那', '一', '不', '我', '你', '他', '要', '把', '给', '就', '也', '都', '吗', '呢', '吧', '啊', '一下', '什么', '怎么', '可以', '需要', '现在', '这个', '那个', '一个', 'the', 'and', 'for', 'with', 'this', 'that']);
// 有查询时只返回真的沾边的（编号 / 公司 / 关键词命中）加上置顶的；没有查询时按置顶与时间。
// 命中的分数至少为 1，时间衰减只用来在命中的条目之间排先后，不会把老经验挤掉。
export function scoreNote(n, { text = '', numbers = [], companies = [], kinds = null, now = Date.now() } = {}) {
  if (kinds && !kinds.includes(n.kind)) return 0;
  let s = 0, matched = false;
  if (numbers.length && (n.numbers || []).some(x => numbers.includes(x))) { s += 8; matched = true; }
  const cs = companies.map(companyKey).filter(Boolean);
  if (cs.length) { const mine = (n.companies || []).map(companyKey); const hay = norm(`${n.subject || ''} ${n.text}`); if (cs.some(c => mine.some(m => m === c || m.includes(c) || c.includes(m)) || hay.includes(c))) { s += 6; matched = true; } }
  const q = tokens(text).filter(t => !STOP.has(t));
  if (q.length) { const hay = norm(`${n.subject || ''} ${n.text} ${(n.tags || []).join(' ')}`); const hits = q.filter(t => hay.includes(t)).length; if (hits) { s += 1 + Math.min(6, hits); matched = true; } }
  const hasQuery = !!(String(text).trim() || numbers.length || companies.length);
  if (hasQuery && !matched && !n.pinned) return 0;
  // 置顶只保证"总会带上"，不抢真正命中的条目的位置。
  if (n.pinned) s += 2;
  if (n.kind === 'lesson' || n.kind === 'decision' || n.kind === 'preference') s += 1;
  const age = (now - Date.parse(n.updated_at || n.at)) / DAY;
  s -= Math.min(2, age / 60);
  return matched || n.pinned ? Math.max(s, 1) : s;
}
export function recall({ text = '', numbers = [], companies = [], kinds = null, limit = 12, chars = 6000, now = Date.now() } = {}) {
  const hasQuery = !!(String(text).trim() || numbers.length || companies.length);
  const scored = loadNotes().map(n => ({ n, s: scoreNote(n, { text, numbers, companies, kinds, now }) }))
    .filter(x => (hasQuery ? x.s > 0 : (!kinds || kinds.includes(x.n.kind))))
    .sort((a, b) => b.s - a.s || String(b.n.at).localeCompare(String(a.n.at)));
  const out = [];
  let used = 0;
  for (const { n, s } of scored) { if (out.length >= limit) break; const len = n.text.length + 40; if (used + len > chars) continue; used += len; out.push({ ...n, score: Math.round(s * 10) / 10 }); }
  return out;
}
const day = at => new Date(at).toLocaleDateString('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit' });
export const renderNotes = (notes = []) => notes.map(n => `- [${KINDS[n.kind] || n.kind} · ${n.by} · ${day(n.at)}${n.pinned ? ' · 置顶' : ''}]${n.subject ? ' ' + n.subject + '：' : ' '}${n.text}${(n.numbers || []).length ? `（#${n.numbers.join(' #')}）` : ''}${n.evidence ? ` ← ${n.evidence}` : ''}`).join('\n');
export function memoryStats() {
  const all = loadNotes();
  const count = fn => { const c = {}; for (const n of all) { const k = fn(n) || '?'; c[k] = (c[k] || 0) + 1; } return c; };
  return { total: all.length, by_kind: count(n => n.kind), by_author: count(n => n.by), pinned: all.filter(n => n.pinned).length, last_at: all.map(n => n.updated_at || n.at).sort().at(-1) || null };
}
// 给你看的时候换掉代号（10-01 开箱测试：记忆库页把执行器记下的原文「waiting_user」直接露了出来）。
// 只换显示，原文不动：执行器 recall 读到的还是它自己写的那句。你自己记的（user / dashboard）原样显示。
const PLAIN = [
  [/\bportal-sessions(?:\.json)?\b/g, '登录记录'], [/\b(?:state|runs)\/[\w./-]+/g, '本地记录'], [/\b(?:config|candidate)\/[\w./-]+/g, '本地设置'], [/\bbin\/[\w.-]+\.mjs\b/g, '脚本'],
  [/\bwaiting_user\b/gi, '等你回复'], [/\bneeds_login\b/gi, '要登录'], [/\bawaiting_batch_review\b/gi, '等你重新确认'], [/\bawaiting_final_review\b/gi, '等你终审'],
  [/\bprepared_for_user\b/gi, '已预填、等你提交'], [/\bsystem_fix\b/gi, '系统修复'], [/\b(?:queue[_-])?auto[_-]apply\b/gi, '投递'],
  [/\bhost[_ -]?jobs?\b/gi, '任务'], [/\brequestRunNow\b|\brun-now\b/g, '叫本机 AI 马上跑'], [/\brecord_id\b/g, '线索编号'], [/\bapplication_url\b/g, '申请链接'],
  [/\bneeds 字段/g, '要你做的事'], [/\brecall\b/gi, '查记忆库'],
];
// 换上去的是中文词：两边的空格去掉（「状态是 waiting_user 时」→「状态是等你回复时」）。
export const plainNote = t => PLAIN.reduce((x, [re, to]) => x.replace(re, `\u0001${to}\u0001`), String(t ?? '')).replace(/\s*\u0001\s*/g, '').replace(/\s{2,}/g, ' ').trim();
const MINE = new Set(['user', 'dashboard']);
const withShown = n => { if (MINE.has(n.by)) return n; const shown = plainNote(n.text); return shown === n.text ? n : { ...n, shown }; };
export function listNotes({ q = '', kind = null, by = null, number = null, company = null, limit = 50 } = {}) {
  let rows = loadNotes();
  if (kind) rows = rows.filter(n => n.kind === kind);
  if (by) rows = rows.filter(n => n.by === by);
  if (number) rows = rows.filter(n => (n.numbers || []).includes(Number(number)));
  if (company) rows = rows.filter(n => (n.companies || []).some(c => companyKey(c) === companyKey(company)) || norm(n.text).includes(norm(company)));
  if (String(q).trim()) { const qs = tokens(q).filter(t => !STOP.has(t)); rows = rows.filter(n => { const hay = norm(`${n.subject || ''} ${n.text} ${(n.tags || []).join(' ')}`); return (qs.length && qs.every(t => hay.includes(t))) || hay.includes(norm(q)); }); }
  rows.sort((a, b) => (b.pinned - a.pinned) || String(b.updated_at || b.at).localeCompare(String(a.updated_at || a.at)));
  return { total: rows.length, rows: rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map(withShown) };
}
// 一句话里带的「记住：…」「记一下 …」直接入库，不用经过模型。
export function parseRememberCommand(text) {
  const m = String(text || '').trim().match(/^(?:记住|记一下|记下|记录|remember)[：:，,\s]+([\s\S]{2,})$/i);
  if (!m) return null;
  let body = m[1].trim(), kind = 'lesson';
  const k = body.match(/^(决定|教训|公司|偏好|待办|事实)[：:｜|\s]+([\s\S]+)$/);
  if (k) { kind = { 决定: 'decision', 教训: 'lesson', 公司: 'company', 偏好: 'preference', 待办: 'todo', 事实: 'fact' }[k[1]]; body = k[2].trim(); }
  return { kind, text: body };
}
// 模型回复末尾的 REMEMBER 行：`REMEMBER: 偏好｜用户不想投外包公司`。
export function parseRememberLines(text) {
  const out = [], keep = [];
  for (const row of String(text || '').split('\n')) {
    const m = row.match(/^\s*REMEMBER\s*[:：]\s*(.+)$/);
    if (!m) { keep.push(row); continue; }
    const r = parseRememberCommand('记住：' + m[1].trim());
    if (r) out.push(r);
  }
  return { content: keep.join('\n').trim(), remembers: out.slice(0, 3) };
}
