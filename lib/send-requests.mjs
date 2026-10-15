// 发送请求并进动作（第 2 步·对外记录，契约 05 2.2）：一条发送请求就是发信、发私信那一条动作（actions 表）的投递记录，
// 存在它的 delivery 列里（request_id 列是请求自己的号，唯一）。不再单独存 state/send-requests.ndjson。
//
// 读：all()（全部发送请求，样子和以前文件里的一行一样，多一个 action_id）、forAction(id)、byId(request_id)，
//     以及老读法 lines('state/send-requests.ndjson')（lib/store.mjs 转到 all()）。
// 写：saveAll(rows)，老写法 writeLines('state/send-requests.ndjson', rows) 转到它：
//   - 每一行挂到 row.action_id 那条动作上；没写 action_id 的挂回原来那一条；
//   - 同一条请求挂到了另一条动作上（你说「再发一次」，lib/action-kinds.mjs 把原来那条请求放回队列、记新动作的 id），就从旧动作上挪走；
//   - rows 里没有了的，从动作上摘掉（整份换掉的老写法；动作本身和它的回执、原因都留着）；
//   - 哪条动作都挂不上的（旧文件里的、命令行时代的）：按 adopt() 补一条动作，见下。
// 顺序：按动作建的先后（rowid）；挪到新动作上的请求排到后面。
// 旧文件：第一次用到时导进来（先备份），以后只读、不再写（lib/db-import.mjs）。
import { db, tx, toJson, fromJson } from './db.mjs';
import { legacyImporter, metaOf, metaSet, newRev } from './db-import.mjs';
import crypto from 'node:crypto';
import { merge3 } from './merge3.mjs';

export const LEGACY_FILE = 'state/send-requests.ndjson';
const META_REV = 'requests_rev';
const T = x => Date.parse(x || '') || 0;
const iso = t => new Date(t).toISOString();
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// 和 lib/jobs.mjs newJobId 一样的号（不引它：lib/store.mjs 经这里加载，不能把 jobs、status 一串拉进 import 环）。
const newJobId = now => `j_${Math.floor(now).toString(36).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`;
export const kindOfRequest = r => (/email|mail/.test(String(r?.channel || 'email')) ? 'send_email' : 'send_dm');

// ── 没有动作的发送请求补一条动作（和 lib/jobs-migrate.mjs 以前迁发送请求的规矩一样）────────────────────────
// 还没完结的（排着、在发、要复核）：一件活 + 一条动作。排着的记 approved，批准时间是请求记下的那一刻（再批准过的看 requeued_at）；
//   不知道就空着——一律算太久，不自动发，等你再确认（lib/actions.mjs STALE_MS）。在发的那一半拿不准发没发出，记 uncertain，由对账去核对。
// 已经完结的（发出了、不发了、失败了、不确定）：只补一条历史动作（job_id 是空串，不另开活、不出卡），记录留着给页面和对账看。
const OPEN_ACT = { queued: 'approved', approved: 'approved', dispatched: 'uncertain', sending: 'uncertain', needs_review: 'requested' };
const DONE_ACT = { sent: 'done', cancelled: 'cancelled', failed: 'failed', uncertain: 'uncertain' };
function insertJob(d, { kind, title, target, ref, state, reason = null, what = null, at }) {
  const have = d.prepare('SELECT id FROM jobs WHERE ref = ?').get(ref);
  if (have) return have.id;
  const id = newJobId(T(at) || Date.now());
  d.prepare(`INSERT INTO jobs (id, kind, member, title, target, origin, state, reason, what, attempt, ref, created_at, updated_at, started_at)
             VALUES (?, ?, 'quill', ?, ?, 'inbox', ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, kind, title, target, state, reason, toJson(what), ref, at, at, state === 'running' ? at : null);
  d.prepare('INSERT INTO job_events (job_id, event, from_state, to_state, at, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'create', null, 'queued', at, toJson({ note: `legacy:sendreq:${ref.slice(8)}` }));
  if (state !== 'queued') d.prepare('INSERT INTO job_events (job_id, event, from_state, to_state, at, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, state === 'running' ? 'start' : 'wait', 'queued', state, at, toJson(reason ? { reason, ...(what ? { what } : {}) } : null));
  return id;
}
// 发信、发私信动作的 payload 里记着的请求号 → 动作（一次写里只扫一遍表，几千行的旧文件不按行扫）。
function knownActions(d) {
  const m = new Map();
  for (const a of d.prepare("SELECT id, idem_key, payload FROM actions WHERE kind IN ('send_email', 'send_dm') ORDER BY created_at").all()) {
    const p = fromJson(a.payload) || {};
    for (const k of [p.request_id, p.id, String(a.idem_key || '').startsWith('legacy:sendreq:') ? a.idem_key.slice(15) : null]) if (k) m.set(String(k), a.id);
  }
  return m;
}
function adopt(d, r, now, known) {
  const have = known.get(String(r.id));
  if (have) return have;
  const kind = kindOfRequest(r), at = iso(T(r.at || r.created_at) || now);
  const target = r.draft_id ? `draft:${r.draft_id}` : r.record_id || r.to || null;
  const payload = { legacy: 'send-requests', id: r.id, request_id: r.id, channel: r.channel || null, draft_id: r.draft_id || null, record_id: r.record_id || null, number: r.number ?? null };
  let jobId = '', state = DONE_ACT[r.status] || 'failed', approved = T(r.at || r.created_at) || null;
  if (OPEN_ACT[r.status]) {
    state = OPEN_ACT[r.status];
    approved = Math.max(T(r.at || r.created_at), T(r.requeued_at)) || null;
    const title = cut(`${kind === 'send_email' ? '发邮件' : '发私信'}${r.number != null ? ` #${r.number}` : ''}${r.company ? ` ${r.company}` : ''}`, 200);
    jobId = insertJob(d, { kind, title, target: r.record_id ? `lead:${r.record_id}` : null, ref: `sendreq:${r.id}`, at,
      ...(r.status === 'needs_review' ? { state: 'waiting_you', reason: '草稿改过，要你重新看一遍', what: { label: '重新看草稿', href: '#inbox' } } : { state: state === 'approved' ? 'queued' : 'running' }) });
  }
  const id = jobId ? `a_${jobId.slice(2)}` : `a_req_${String(r.id).slice(0, 40)}`;
  d.prepare(`INSERT INTO actions (id, kind, job_id, target, payload, fingerprint, idem_key, state, worker, attempts, approved_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'engine', 0, ?, ?, ?)`).run(id, kind, jobId, target, toJson(payload), r.fingerprint || null, `legacy:sendreq:${r.id}`, state, approved ? iso(approved) : null, at, at);
  known.set(String(r.id), id);
  return id;
}

// ── 写 ───────────────────────────────────────────────────────────────────
function writeAll(d, rows, { replace = false } = {}) {
  const now = Date.now();
  if (replace) d.exec('UPDATE actions SET delivery = NULL, request_id = NULL WHERE request_id IS NOT NULL');
  const holders = new Map(d.prepare('SELECT id, request_id, delivery FROM actions WHERE request_id IS NOT NULL').all().map(a => [a.request_id, a]));
  const exists = d.prepare('SELECT id, request_id FROM actions WHERE id = ?');
  const clear = d.prepare('UPDATE actions SET delivery = NULL, request_id = NULL WHERE id = ?');
  const set = d.prepare('UPDATE actions SET delivery = ?, request_id = ? WHERE id = ?');
  const keep = new Set(), taken = new Map();
  let known = null;
  const wanted = new Set(rows.map(x => x?.id && String(x.id)));
  // 全局 state 锁退役（第 2 步）：我读出来以后没改的那几条，别人这期间改了、删了照别人的；我改了别人也改了，三方合并（lib/merge3.mjs）；
  // 我这份里没有的，只有我读的时候见过、之后也没人动过的才算我删的。和 lib/leads.mjs、lib/drafts.mjs 同一个规矩。
  const mineGens = new Set(rows.map(x => GEN.get(x)).filter(Boolean));
  const sawIt = (rid, a) => SEEN.some(([g, m]) => mineGens.has(g) && m.get(rid) === a.delivery);
  for (let r of rows) {
    if (!r || typeof r !== 'object' || !r.id || keep.has(String(r.id))) continue;
    const rid = String(r.id);
    keep.add(rid);
    const holder = holders.get(rid), b = replace ? null : BASE.get(r);
    if (b != null) {
      if (toJson(r) === b.s) continue;
      if (holder && holder.delivery !== b.delivery) r = merge3(fromJson(b.s), r, out(holder));
    }
    let target = r.action_id ? exists.get(String(r.action_id)) : null;
    // 那条动作已经挂着另一条这次也要留的请求：这一行另补一条动作，不顶掉别人。
    if (target?.request_id && target.request_id !== rid && wanted.has(target.request_id)) target = null;
    let to = target?.id || holder?.id || null;
    if (!to || taken.has(to)) to = adopt(d, { ...r, id: rid }, now, known ||= knownActions(d));
    taken.set(to, rid);
    const doc = toJson({ ...r, id: rid, action_id: to });
    if (holder && holder.id === to && holder.delivery === doc) continue;
    if (holder && holder.id !== to) clear.run(holder.id);
    const other = exists.get(to);
    if (other?.request_id && other.request_id !== rid) clear.run(to); // 顶掉的那一条不在这次的 rows 里（整份换掉的老写法：等于删了）
    set.run(doc, rid, to);
  }
  if (!replace) for (const [rid, a] of holders) if (!keep.has(rid) && (!mineGens.size || sawIt(rid, a))) clear.run(a.id);
  metaSet(d, META_REV, newRev());
  cache = null;
  return rows.length;
}
export const ensureImported = legacyImporter({ legacy: LEGACY_FILE, name: 'send-requests', load: (d, rows) => writeAll(d, rows, { replace: true }) });
export function saveAll(rows) { ensureImported(); return tx(d => writeAll(d, rows)); }

// ── 读 ───────────────────────────────────────────────────────────────────
const out = a => ({ ...fromJson(a.delivery), action_id: a.id });
const BASE = new WeakMap(), GEN = new WeakMap(), SEEN = [];
let gens = 0;
let cache = null; // { db, rev, rows }
export const revision = () => { ensureImported(); return metaOf(db(), META_REV) || '0'; };
export function all() {
  const v = revision(), d = db();
  if (!cache || cache.rev !== v || cache.db !== d) { const rows = d.prepare('SELECT id, request_id, delivery FROM actions WHERE delivery IS NOT NULL ORDER BY rowid').all(); cache = { rev: v, db: d, rows, seen: new Map(rows.map(a => [String(a.request_id), a.delivery])) }; }
  const g = ++gens; SEEN.unshift([g, cache.seen]); SEEN.length = Math.min(SEEN.length, 8);
  return cache.rows.map(a => { const x = out(a); BASE.set(x, { s: toJson(x), delivery: a.delivery }); GEN.set(x, g); return x; });
}
export function forAction(actionId) { ensureImported(); const a = db().prepare('SELECT id, delivery FROM actions WHERE id = ? AND delivery IS NOT NULL').get(String(actionId)); return a ? out(a) : null; }
export function byId(requestId) { ensureImported(); const a = db().prepare('SELECT id, delivery FROM actions WHERE request_id = ?').get(String(requestId)); return a ? out(a) : null; }
