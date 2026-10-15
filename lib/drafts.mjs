// 草稿（第 2 步·对外记录，契约 05 2.2）：草稿在数据库的 drafts 表里（lib/db.mjs 第 7 版），只有这个模块读写它。
// 发信红线也在这里（以前在 lib/gmail.mjs）：草稿指纹、首联不重复、回复和跟进要接在发过的那一条后面、同一份草稿不重复授权。
//
// 读：all()、get(draft_id)、byRecord(record_id)，以及老读法 lines('state/drafts.ndjson')（lib/store.mjs 转到 all()）。
// 写：saveAll(rows) 整份换掉、只写变了的行；老写法 writeLines('state/drafts.ndjson', rows) 转到它。
//   表里的列是从草稿拆出来给查询用的：全文（body）、指纹（这一版内容的 draftFingerprint）、渠道、字数、状态、线索（record_id）、
//   动作（action_id：批准发送时记下的那一条，lib/action-kinds.mjs）。doc 是整份草稿（不含 body）。
// 旧文件 state/drafts.ndjson：第一次用到时导进来（先备份），以后只读、不再写（lib/db-import.mjs）。
// 编辑、AI 重写、回退在 lib/draft-edit.mjs。
import { db, tx } from './db.mjs';
import { hash, readLines } from './paths.mjs';
import { legacyImporter, metaOf, metaSet, newRev } from './db-import.mjs';
import { merge3 } from './merge3.mjs';

export const LEGACY_FILE = 'state/drafts.ndjson';
const META_REV = 'drafts_rev';

// ── 发信红线 ────────────────────────────────────────────────────────────────
// 你批准的那一版：收件人、标题、正文、附件；跟进还绑着接在哪一封后面。
export const draftFingerprint = d => hash([d.draft_id, d.record_id, d.to, d.subject, d.body, d.attachments, ...(d.purpose === 'followup' ? [d.purpose, d.parent_thread_id, d.reply_message_id] : []), ...(d.review_revision ? [d.review_revision] : [])]);
// 首联保护（起草时）：这个渠道发过了、或者已经有一份没作废的草稿，就不再起一份首联。
export function assertFirstContact(record, channel, outbound, drafts = []) {
  if (outbound.some((x) => x.record_id === record && x.channel === channel)) throw Error('already_contacted');
  if (drafts.some((x) => x.record_id === record && x.channel === channel && x.status !== 'cancelled')) throw Error('draft_already_exists');
}
// 回复的锚点也可以是招聘方直接发来的那封信：内置邮箱读到、登记在 state/inbox-events.ndjson 里的（按 Message-ID 认，同一条线索）。
export const inboundAnchor = (d, events) => !!d?.reply_message_id && d.via === 'builtin-mail' && events.some(e => e.source === 'builtin-mail' && e.record_id === d.record_id && e.rfc_id === d.reply_message_id);
// 跟进只能接在同一渠道、同一会话的最新实发回执后面。旧回执没留下消息编号时不猜，避免重复跟进。
export function followupParent(d, outbound) {
  if (!d.parent_thread_id || !d.reply_message_id) return null;
  const thread = o => o.thread_id || o.to || null;
  const prior = outbound.filter(o => o.record_id === d.record_id && (o.channel || 'email') === (d.channel || 'email') && o.status !== 'corrected' && thread(o) === d.parent_thread_id);
  // 旧行没留时间时保留回执顺序，不能把未知时间当 0 丢到最前面放出重发。
  if (prior.every(o => Number.isFinite(Date.parse(o.at)))) prior.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const parent = prior.find(o => [o.external_id, o.message_id].filter(Boolean).includes(d.reply_message_id));
  if (parent?.to && d.to && parent.to !== d.to) return null;
  return parent ? { parent, duplicate: prior.at(-1) !== parent } : null;
}
// 「发 N, M」：一次批准几份（最多 20 份）；每一份都先核过再写任何授权。
export function bindSendBatch(input, source, messageId, drafts, requests, outbound) {
  const match = String(input).trim().match(/^发\s*(\d+(?:\s*[,，、]\s*\d+)+)\s*[。！!]?$/);
  if (!match) return null;
  const numbers = [...new Set(match[1].split(/\s*[,，、]\s*/).map(Number))];
  if (numbers.length > 20) throw Error('batch_too_large');
  return numbers.map(n => ({ ...bindSend('发 ' + n, source, hash([messageId || input, n]), drafts, requests, outbound), number: n }));
}
// 「发 N」：已经给你看过、还没发的那一份。
export function bindSend(input, source, messageId, drafts, requests, outbound, inbound = null) {
  const m = String(input).trim().match(/^发\s*(\d+)\s*[。！!]?$/);
  if (!m) return null;
  if (!['codex', 'feishu_im', 'dashboard'].includes(source)) throw Error('untrusted_send_source');
  const candidates = drafts.filter(d => d.number === Number(m[1]) && d.notified_at && !['sent', 'cancelled'].includes(d.status));
  if (candidates.length !== 1) throw Error('displayed_draft_ambiguous_or_missing');
  return bindDraft(candidates[0], { source, messageId, raw: input, requests, outbound, inbound });
}
// 一份草稿的发送授权（lib/action-kinds.mjs 按 draft_id 调，确认绑的指纹由 requestAction 核过）。
// 首联保护（按渠道：平台私信和邮件是两次不同的首联，谁的授权都放不出另一个）、回复和跟进要接在发过的那条后面、同一份草稿不重复授权，
// 都在这里；返回一条发送请求，或 { duplicate }。
export function bindDraft(d, { source, messageId, raw = null, requests, outbound, inbound = null }) {
  const input = raw || `draft:${d.draft_id}`;
  const channel = d.channel || 'email';
  const prior = outbound.filter(o => o.record_id === d.record_id && (o.channel || 'email') === channel);
  const followup = d.purpose === 'followup' ? followupParent(d, outbound) : null;
  if (d.purpose === 'followup' && !followup) throw Error('followup_parent_receipt_required');
  // 回复招聘方：和首联一样要你批准这一版（指纹），发在原会话里；它必须接在我们发过的那条消息后面（或招聘方直接来的那封信）。
  const reply = d.purpose === 'reply';
  if (reply && !prior.some(o => [d.parent_outbound_id, d.parent].filter(Boolean).includes(o.id) || (d.parent_thread_id && [o.thread_id, o.to, o.url].includes(d.parent_thread_id))) && !inboundAnchor(d, inbound ?? readLines('state/inbox-events.ndjson'))) throw Error('reply_parent_receipt_required');
  if ((d.purpose !== 'followup' && !reply && prior.length) || prior.some(o => o.draft_id === d.draft_id) || followup?.duplicate || requests.some(r => r.draft_id === d.draft_id))
    return { duplicate: true, draft_id: d.draft_id };
  if (d.status !== 'ready' || d.displayed_hash !== draftFingerprint(d)) throw Error('displayed_draft_changed');
  return { id: hash([source, messageId || input]), source, message_id: messageId, raw: input, at: new Date().toISOString(),
    draft_id: d.draft_id, record_id: d.record_id, channel, fingerprint: d.displayed_hash, status: 'queued', ...(d.purpose === 'followup' ? { purpose: 'followup', parent_thread_id: d.parent_thread_id, reply_message_id: d.reply_message_id } : {}),
    ...(reply ? { purpose: 'reply', parent_outbound_id: d.parent_outbound_id || d.parent || null, parent_thread_id: d.parent_thread_id || null, reply_message_id: d.reply_message_id || null } : {}) };
}

// ── 表 ──────────────────────────────────────────────────────────────────────
const chars = s => [...String(s ?? '')].length;
function docOf(x) { const o = { ...x }; delete o.body; return JSON.stringify(o); }
function fromRow(r, g = 0) { const d = JSON.parse(r.doc); if (r.body != null) d.body = r.body; BASE.set(d, { doc: r.doc, body: r.body ?? null }); if (g) GEN.set(d, g); return d; }
// 读出来的每一份记下原文（BASE）和是哪一次 all() 读的（GEN）：整份写回时只写我改了的，我读了以后别的进程改的、加的不被盖掉、不被删
// （全局 state 锁退役，第 2 步，和 lib/leads.mjs 同一个规矩；lib/merge3.mjs）。
const BASE = new WeakMap(), GEN = new WeakMap(), SEEN = [];
let gens = 0;
const num = v => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function writeAll(d, rows, { replace = false } = {}) {
  const old = replace ? new Map() : new Map(d.prepare('SELECT id, seq, doc, body FROM drafts').all().map(r => [r.id, r]));
  if (replace) d.exec('DELETE FROM drafts');
  const up = d.prepare(`INSERT INTO drafts (id, seq, number, record_id, action_id, channel, purpose, status, fingerprint, chars, to_addr, subject, body, doc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, number = excluded.number, record_id = excluded.record_id, action_id = excluded.action_id, channel = excluded.channel,
      purpose = excluded.purpose, status = excluded.status, fingerprint = excluded.fingerprint, chars = excluded.chars, to_addr = excluded.to_addr, subject = excluded.subject,
      body = excluded.body, doc = excluded.doc, updated_at = excluded.updated_at`);
  const seqOnly = d.prepare('UPDATE drafts SET seq = ? WHERE id = ?');
  const seen = new Map(), keep = new Set(), now = new Date().toISOString();
  const mineGens = new Set(rows.map(r => GEN.get(r)).filter(Boolean));
  const sawIt = (id, r) => SEEN.some(([g, m]) => mineGens.has(g) && m.get(id) === `${r.doc}\u0000${r.body ?? ''}`);
  rows.forEach((x, i) => {
    const base = String(x?.draft_id || `row:${i}`), n = (seen.get(base) || 0) + 1; seen.set(base, n);
    const id = n === 1 ? base : `${base}#${n}`;
    keep.add(id);
    let doc = docOf(x), body = x.body == null ? null : String(x.body);
    const was = old.get(id), b = replace ? null : BASE.get(x);
    if (b) {
      if (doc === b.doc && body === b.body) { if (was && was.doc === b.doc && was.body === b.body && was.seq !== i) seqOnly.run(i, id); return; } // 我没改：别人改的、删的照别人的
      if (was && (was.doc !== b.doc || was.body !== b.body)) { // 我改了、别人也改了：三方合并
        const m = merge3({ ...JSON.parse(b.doc), body: b.body }, x, { ...JSON.parse(was.doc), body: was.body });
        x = m; doc = docOf(m); body = m.body == null ? null : String(m.body);
      }
    }
    if (was && was.doc === doc && was.body === body) { if (was.seq !== i) seqOnly.run(i, id); return; }
    up.run(id, i, num(x.number), x.record_id ?? null, x.action_id ?? null, x.channel || 'email', x.purpose ?? null, x.status ?? null, draftFingerprint(x), chars(x.body),
      x.to == null ? null : String(x.to), x.subject == null ? null : String(x.subject), body, doc, x.created_at || x.at || now, now);
  });
  if (!replace) for (const [id, r] of old) if (!keep.has(id) && (!mineGens.size || sawIt(id, r))) d.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  metaSet(d, META_REV, newRev());
  cache = null;
  return rows.length;
}

export const ensureImported = legacyImporter({ legacy: LEGACY_FILE, name: 'drafts', load: (d, rows) => writeAll(d, rows, { replace: true }) });

let cache = null; // { rev, db, rows }：同一版只查一次
export const revision = () => { ensureImported(); return metaOf(db(), META_REV) || '0'; };
// 全部草稿，按原来的顺序；每次是新对象（可以改了再 saveAll）。
export function all() {
  const v = revision();
  if (!cache || cache.rev !== v || cache.db !== db()) { const rows = db().prepare('SELECT id, doc, body FROM drafts ORDER BY seq').all(); cache = { rev: v, db: db(), rows, seen: new Map(rows.map(r => [r.id, `${r.doc}\u0000${r.body ?? ''}`])) }; }
  const g = ++gens; SEEN.unshift([g, cache.seen]); SEEN.length = Math.min(SEEN.length, 8);
  return cache.rows.map(r => fromRow(r, g));
}
export function get(draftId) { ensureImported(); const r = db().prepare('SELECT doc, body FROM drafts WHERE id = ?').get(String(draftId)); return r ? fromRow(r) : null; }
export function byRecord(recordId) { ensureImported(); return db().prepare('SELECT doc, body FROM drafts WHERE record_id = ? ORDER BY seq').all(String(recordId)).map(r => fromRow(r)); }
// 老写法（writeLines('state/drafts.ndjson', rows)）：整份换掉，只写变了的行。
export function saveAll(rows) { ensureImported(); return tx(d => writeAll(d, rows)); }

// 写入前核对必须在真正拿到 SQLite 写锁后进行，不能用锁外的 all() 快照。
// change 同步修改本次最新的行；这里只允许本地检查，模型与网络必须在调用前完成。
export function mutateAll(change) {
  ensureImported();
  return tx(sql => {
    const rows = sql.prepare('SELECT doc, body FROM drafts ORDER BY seq').all().map(r => fromRow(r));
    const result = change(rows);
    if (result?.then) throw Error('draft_mutation_must_be_synchronous');
    writeAll(sql, rows);
    return result;
  });
}

// 明确取消旧暂停稿：读检查与写取消在同一写事务里，不能和发送领取交错。
// 调用方先完成 leads / requests / receipts 的旧文件导入；这里不嵌套 saveAll 的事务。
export function cancelPaused({ draft_id, record_id, fingerprint, source = 'dashboard', now = Date.now() } = {}) {
  const fail = message => { throw Object.assign(Error(message), { status: 409 }); };
  if (!draft_id || !record_id || !fingerprint) fail('取消需要指定草稿、岗位和刚看过的版本');
  ensureImported();
  return tx(sql => {
    const rows = sql.prepare("SELECT * FROM drafts WHERE id = ? OR json_extract(doc, '$.draft_id') = ?").all(draft_id, draft_id);
    if (rows.length !== 1) fail('这份草稿不存在或编号重复，请刷新材料');
    const row = rows[0], draft = fromRow(row), leadRow = sql.prepare('SELECT id, doc FROM leads WHERE id = ?').get(record_id);
    if (row.id !== draft_id || draft.draft_id !== draft_id || row.record_id !== record_id || draft.record_id !== record_id || row.status !== draft.status || !leadRow) fail('草稿与岗位对应关系已变化，请刷新材料');
    if (draftFingerprint(draft) !== fingerprint || row.fingerprint !== fingerprint) fail('草稿内容已变化，请重新查看后取消');
    if (draft.status === 'cancelled' && draft.cancellation?.from === 'paused' && draft.cancellation.fingerprint === fingerprint) return { draft, repeated: true };
    if (row.status !== 'paused' || draft.status !== 'paused') fail('只有暂停的旧稿可以从这里取消');
    if (draft.sent_at || draft.dispatched_at || draft.sending_at || draft.uncertain_at || draft.requires_verification || draft.retry_disabled) fail('这份草稿已有发送或待核实记录，请先核对结果');
    const linked = sql.prepare('SELECT * FROM actions').all().filter(a => {
      const p = JSON.parse(a.payload || '{}'), r = JSON.parse(a.delivery || 'null');
      return a.id === draft.action_id || a.target === `draft:${draft_id}` || p.draft_id === draft_id || r?.draft_id === draft_id || (a.request_id && [draft.request_id, draft.send_request_id].includes(a.request_id));
    });
    for (const a of linked) {
      const r = JSON.parse(a.delivery || 'null');
      if (!['requested', 'cancelled'].includes(a.state) || a.claimed_by != null || a.attempts > 0 || a.receipt ||
          (r && (r.status !== 'cancelled' || r.dispatched_at || r.sending_at || r.sent_at || r.uncertain_at || r.external_id || r.requires_verification || r.retry_disabled || r.tries > 0)))
        fail('这份草稿已有发送请求、执行记录或结果待核实，请先处理原任务');
    }
    const ids = new Set(linked.map(a => a.id));
    if (sql.prepare('SELECT draft_id, action_id, record_id, channel FROM receipts').all().some(r => r.draft_id === draft_id || ids.has(r.action_id) || (r.record_id === record_id && (r.channel || 'email') === (draft.channel || 'email')))) fail('这个岗位已有相关外发回执，不能按未发送草稿取消');
    const at = new Date(now).toISOString();
    Object.assign(draft, { status: 'cancelled', cancelled_at: at, cancellation: { from: 'paused', fingerprint, source, at, scope: 'local' } });
    // approved_at 与旧审批记录是历史证据；只撤销当前展示过的那版发送资格。
    delete draft.displayed_hash;
    sql.prepare('UPDATE drafts SET status = ?, doc = ?, updated_at = ? WHERE id = ?').run('cancelled', docOf(draft), at, row.id);
    metaSet(sql, META_REV, newRev()); cache = null;
    return { draft, repeated: false };
  });
}

// 仅重新计算自动城市暂停。检查和写入同处 SQLite 写事务；不创建、恢复或领取任何外发动作。
// eligible 在锁内按当前设置判定，返回 { ok, reason, policy }；不改候选人设置。
export function recheckCityPaused({ eligible, ids = null, dryRun = true, source = 'current_city_preferences', now = Date.now() } = {}) {
  if (typeof eligible !== 'function') throw Error('city_pause_check_required');
  ensureImported();
  return tx(sql => {
    const allRows = sql.prepare('SELECT * FROM drafts ORDER BY seq').all();
    const counts = new Map();
    for (const row of allRows) { const id = JSON.parse(row.doc).draft_id; counts.set(id, (counts.get(id) || 0) + 1); }
    const actions = sql.prepare('SELECT * FROM actions').all().map(a => ({ ...a, payload: JSON.parse(a.payload || '{}'), delivery: JSON.parse(a.delivery || 'null') }));
    const receipts = sql.prepare('SELECT draft_id, action_id, record_id FROM receipts').all();
    const selected = ids == null ? null : new Set(ids), items = [], skipped = [], at = new Date(now).toISOString();
    for (const row of allRows) {
      const draft = fromRow(row);
      if (selected && !selected.has(draft.draft_id)) continue;
      if (row.status !== 'paused' && draft.status !== 'paused') continue;
      const skip = reason => skipped.push({ row_id: row.id, draft_id: draft.draft_id || null, record_id: draft.record_id || null, number: draft.number ?? null, reason });
      if (!draft.draft_id || counts.get(draft.draft_id) !== 1 || row.id !== draft.draft_id || row.status !== draft.status || row.record_id !== draft.record_id || row.action_id !== (draft.action_id ?? null) || row.fingerprint !== draftFingerprint(draft)) { skip('草稿编号或版本不完整'); continue; }
      const leadRow = sql.prepare('SELECT id, doc FROM leads WHERE id = ?').get(draft.record_id);
      if (!leadRow) { skip('找不到对应岗位'); continue; }
      const lead = JSON.parse(leadRow.doc), decision = eligible(lead, draft);
      if (!decision?.ok) { skip(decision?.reason || '当前不能解除暂停'); continue; }
      if (!['ready', 'blocked', 'needs_platform_action'].includes(draft.paused_from)) { skip('原状态不是待审或待处理'); continue; }
      if (draft.sent_at || draft.dispatched_at || draft.sending_at || draft.uncertain_at || draft.requires_verification || draft.retry_disabled || draft.external_id || draft.sent_external_id || draft.approved_at || draft.approved === true || draft.approval) { skip('草稿已有批准、发送或待核实记录'); continue; }
      const records = new Set([draft.record_id, leadRow.id, lead.id, lead.record_id].filter(Boolean));
      const linked = actions.filter(a => a.id === draft.action_id || a.target === `draft:${draft.draft_id}` || records.has(a.target) || [...records].some(id => a.target === `lead:${id}`) || a.payload.draft_id === draft.draft_id || records.has(a.payload.record_id) || records.has(a.payload.lead?.record_id) || a.delivery?.draft_id === draft.draft_id || records.has(a.delivery?.record_id) || (a.request_id && [draft.request_id, draft.send_request_id].includes(a.request_id)));
      // 即使动作已取消，也不把旧草稿接回旧审批链；这批只恢复从未进入外发动作的稿。
      if (linked.length || draft.action_id || draft.request_id || draft.send_request_id) { skip('岗位或草稿已有动作记录，需另行核对'); continue; }
      if (receipts.some(r => r.draft_id === draft.draft_id || records.has(r.record_id))) { skip('岗位已有外发回执'); continue; }
      const before = draftFingerprint(draft), original = { from: draft.paused_from, reason: draft.paused_reason || draft.pause_reason, at: draft.paused_at,
        ...Object.fromEntries(['displayed_hash', 'displayed_on', 'notified_at'].filter(k => Object.hasOwn(draft, k)).map(k => [k, draft[k]])) };
      draft.status = draft.paused_from;
      draft.review_revision = hash([draft.draft_id, before, decision.policy, at]);
      draft.city_pause_review = { at, source, reason: decision.reason, policy: decision.policy, original, previous_fingerprint: before, requires_fresh_review: true };
      for (const key of ['displayed_hash', 'displayed_on', 'notified_at']) delete draft[key];
      const fingerprint = draftFingerprint(draft);
      items.push({ draft_id: draft.draft_id, record_id: draft.record_id, number: draft.number ?? null, from: 'paused', status: draft.status, reason: decision.reason, policy: decision.policy, previous_fingerprint: before, fingerprint });
      if (!dryRun) sql.prepare('UPDATE drafts SET status = ?, fingerprint = ?, doc = ?, updated_at = ? WHERE id = ?').run(draft.status, fingerprint, docOf(draft), at, row.id);
    }
    if (!dryRun && items.length) { metaSet(sql, META_REV, newRev()); cache = null; }
    return { dry_run: dryRun, checked_at: at, restored: dryRun ? 0 : items.length, items, skipped };
  });
}
