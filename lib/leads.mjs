// 线索（第 2 步，契约 05 2.1）：线索在数据库的 leads 表里（lib/db.mjs 第 6 版），只有这个模块读写它。
//
// 读：get(id)、byNumber(n)、list()、search(q)，以及老读法 lines('state/leads.ndjson')（lib/store.mjs 转到 all()）。
// 写：applyEvent(id, event, data) 改状态（规则是 lib/lead-state.mjs 的转移表，不合法的转移直接报错，每次转移记一条 lead_events）；
//     update(id, fn) 改别的字段；跑了很久的步骤合回去用 merge(id, before, after)；老写法 writeLines('state/leads.ndjson', rows) 转到 saveAll(rows)。
//     不管哪条路，都是一条一条写、只写调用方改了的字段（下面「按行写」）。
//     不管从哪条路写，state 变了都必须是 lead-state.applyEvent 带出来的（history 最后一条 to = 新 state），否则报错。
//
// 状态只有 state、auto_apply（投递子状态）、judgement 三样（lib/lead-state.mjs）。旧字段 stage、feedback、previous_stage：
//   升级（upgradeShape，库里 meta leads_shape < 1 时跑一次，先把整份线索备份到 state/backups/）把那时看到的状态定成 state，
//   旧字段收进 legacy_fields 留底；以后落库时，一条已经有 state 的线索又带着旧字段来写，说明有地方还在写旧字段，直接报错
//   （lead_legacy_field）。新加的一条、夹具整条换的（没写 state），按旧字段推一次 state，旧字段不进库。
//
// 旧文件 state/leads.ndjson：第一次用到时导进来（先备份到 state/backups/），以后只读、不再写。
// 这个文件要是在库外头被换掉了（演示数据重灌、测试写夹具），签名和上次导入时不一样，就重新导一遍（同样先备份）。
// JD 正文另存 lead_texts；读出来的线索上 jd_text 是用到才去取的。
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { db, tx, toJson, fromJson } from './db.mjs';
import { file } from './paths.mjs';
import { all as receiptsAll } from './receipts.mjs';
import * as J from './jobs.mjs';
import { leadFields } from './lead-fields.mjs';
import { merge3 } from './merge3.mjs';
import { applyEvent as stateEvent, leadState, legacyLeadState, TRANSITIONS, STATES, LEGACY_FIELDS } from './lead-state.mjs';

export const LEGACY_FILE = 'state/leads.ndjson';
const META_IMPORT = 'leads_import', META_REV = 'leads_rev', META_SHAPE = 'leads_shape', SHAPE = 2;
const keyOf = l => String(l?.record_id || l?.id || '');

// ── 旧文件导入 ─────────────────────────────────────────────────────────────
const sigOfFile = () => { try { const s = fs.statSync(file(LEGACY_FILE)); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; } }; // 兜底：旧文件不在（新装的、被删了）就没有要导的
const meta = (d, k) => fromJson(d.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null);
const setMeta = (d, k, v) => d.prepare('INSERT INTO meta (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').run(k, toJson(v), new Date().toISOString());

function parseLegacy(text) {
  const out = [];
  for (const s of text.split('\n')) {
    if (!s.trim()) continue;
    let l; try { l = JSON.parse(s); } catch { continue; } // 坏行跳过（旧读法 lines() 遇到坏行会整个抛错；这里不让一行坏的挡住导入，原文件有备份）
    if (l && l.jd_gzip) { try { l.jd_text = gunzipSync(Buffer.from(l.jd_gzip, 'base64')).toString('utf8'); } catch {} delete l.jd_gzip; } // 兜底：压缩的正文解不开就当没有正文，原文件有备份
    if (l && typeof l === 'object') out.push(l);
  }
  return out;
}
let checkedSig = undefined, checkedPath = null;
// 要用之前调一次：旧文件还没导过、或者在库外头被换掉了，就导进来。返回这次导了几条（没导是 0）。
export function ensureImported() {
  const sig = sigOfFile(), p = file(LEGACY_FILE);
  if (checkedPath === p && checkedSig === sig) return 0;
  const d = db();
  const last = meta(d, META_IMPORT);
  if (!sig || last?.sig === sig) { ensureShape(d); checkedSig = sig; checkedPath = p; return 0; }
  const text = fs.readFileSync(p, 'utf8');
  // 先备份（同一份内容只备份一次）。
  const dir = file('state/backups'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, path.join(dir, `leads-${stamp}.ndjson`));
  const rows = parseLegacy(text);
  const ctx = legacyContext();
  // 存储/迁移不分配展示编号；放行推荐或用户操作的入口才知道哪条会展示。
  for (const l of rows) { upgradeShape(l, ctx); Object.assign(l, leadFields(l)); }
  const n = tx(d2 => { writeAll(d2, rows, { imported: true }); setMeta(d2, META_IMPORT, { sig, at: new Date().toISOString(), count: rows.length, bytes: text.length }); setMeta(d2, META_SHAPE, SHAPE); return rows.length; });
  checkedSig = sig; checkedPath = p;
  return n;
}

// ── 升级：旧字段收口（第 2 步 2X）──────────────────────────────────────────────
// 一条线索升级成只有 state 的样子：state 定成升级前页面上看到的那个（legacyLeadState：记下的 state 和旧字段、回执、发送请求推出来的，
// 更靠后的算数），旧字段原样收进 legacy_fields（迁移不丢数据），「跟进」记成 follow_up_at。已经是新样子的不动。返回改没改。
export function upgradeShape(l, ctx = {}) {
  const legacy = LEGACY_FIELDS.filter(k => k in l);
  const want = legacyLeadState(l, ctx.of ? ctx.of(keyOf(l)) : {});
  if (!legacy.length && STATES[l.state] && want === l.state) return false;
  if (legacy.length) {
    l.legacy_fields = { ...(l.legacy_fields || {}), ...Object.fromEntries(legacy.map(k => [k, l[k]])) };
    if (l.feedback === '跟进' && !l.follow_up_at) l.follow_up_at = l.feedback_at || l.updated_at || null;
    for (const k of legacy) delete l[k];
  }
  if (l.state !== want) { if (STATES[l.state]) l.legacy_fields = { ...(l.legacy_fields || {}), state: l.state }; l.state = want; l.state_at ||= l.updated_at || l.discovered_at || null; }
  return true;
}
// 升级时推状态要看的回执（旧版：发出过就算已联系、投递回执就算已投递）。读不到就当没有。
// 发送请求不看：「发送中」「材料待确认」是草稿和发送自己的状态（页面上 lib/lead-state.mjs viewState 放在一起看），
// 抄进线索的 state 以后，请求被退回、取消了，线索会一直停在「发送中」。
function legacyContext() {
  const by = (rows) => { const m = new Map(); for (const r of rows) if (r?.record_id) m.set(r.record_id, [...(m.get(r.record_id) || []), r]); return m; };
  let outbound = [];
  try { outbound = receiptsAll(); } catch (e) { console.error(`[leads] 推旧线索的状态时回执读不了，按没发过推：${e.message}`); } // 兜底：回执读不了只少推「已联系 / 已投递」，线索照样导进来
  const o = by(outbound);
  return { of: id => ({ outbound: o.get(id) || [] }) };
}
// 回执在库里（lib/receipts.mjs）：读它可能要先导一次旧文件、开它自己的事务，所以都在线索的事务开始之前读好。
const needsContext = rows => rows.some(l => !STATES[l?.state] || LEGACY_FIELDS.some(k => k in (l || {})));
// 升级（工作台启动时经 ensureImported 跑；测试直接调）。返回升级了几条。
export const upgrade = () => ensureShape(db());
// 已经导过、还没升级的库：先把整份线索备份成旧文件的样子，再在一个事务里升级。可以重复跑：升过的不会再改。
function ensureShape(d) {
  if ((meta(d, META_SHAPE) || 0) >= SHAPE) return 0;
  const rows = d.prepare('SELECT id, doc FROM leads ORDER BY seq').all();
  const dir = file('state/backups'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `leads-before-shape${SHAPE}-${stamp}.ndjson`), rows.map(r => r.doc).join('\n') + (rows.length ? '\n' : ''));
  // doc 不含分表保存的 JD；整库快照也一起留，恢复时正文和投递历史完整。
  const snapshot = path.join(dir, `leads-database-before-shape${SHAPE}-${stamp}-${process.pid}.sqlite`);
  d.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const ctx = legacyContext();
  return tx(d2 => {
    if ((meta(d2, META_SHAPE) || 0) >= SHAPE) return 0;
    const rows = d2.prepare('SELECT id, doc FROM leads ORDER BY seq').all();
    const up = d2.prepare('UPDATE leads SET state = ?, number = ?, company = ?, role = ?, location = ?, doc = ?, updated_at = ? WHERE id = ?'), now = new Date().toISOString();
    let n = 0;
    for (const r of rows) {
      const l = JSON.parse(r.doc);
      upgradeShape(l, ctx);
      Object.assign(l, leadFields(l));
      if (JSON.stringify(l) === r.doc) continue;
      up.run(l.state, l.number ?? null, l.company, l.role, l.location, JSON.stringify(l), now, r.id); n++;
    }
    setMeta(d2, META_SHAPE, SHAPE);
    if (n) setMeta(d2, META_REV, newRev());
    cache = null;
    return n;
  });
}

// ── 读 ───────────────────────────────────────────────────────────────────
const rev = d => meta(d, META_REV) || '0';
export const revision = () => { ensureImported(); return rev(db()); };
// jd_text 用到才取（列表、看板从不碰它）。取过、或者被赋过值的，写回去时才动 lead_texts。
const textState = new WeakMap();
function withText(row, id) {
  const st = { loaded: false, value: undefined, set: false };
  textState.set(row, st);
  Object.defineProperty(row, 'jd_text', {
    configurable: true, enumerable: true,
    get() { if (!st.loaded && !st.set) { st.value = db().prepare('SELECT jd_text FROM lead_texts WHERE id = ?').get(id)?.jd_text ?? undefined; st.loaded = true; } return st.value; },
    set(v) { st.value = v; st.set = true; },
  });
  return row;
}
// 读出来的每一条记下原文（BASE）和是哪一次 all() 读的（GEN）：整份写回时（saveAll）分得清哪几条是我改的、
// 哪几条是我读了以后别的进程改的、加的（全局 state 锁退役以后，进程之间不再排队，第 2 步·锁退役）。最近 8 次读到的那一版记着（SEEN）。
const BASE = new WeakMap(), GEN = new WeakMap(), SEEN = [];
let gens = 0;
const fromRow = (r, g = 0) => { const l = withText(JSON.parse(r.doc), r.id); BASE.set(l, r.doc); if (g) GEN.set(l, g); return l; };
let cache = null; // { path, rev, rows } 同一进程里同一版只解析一次（cachedLines 共享，lines() 给副本）
function loadAll() {
  ensureImported();
  const d = db(), v = rev(d), p = file(LEGACY_FILE);
  if (cache && cache.rev === v && cache.path === p) return cache;
  const rows = d.prepare('SELECT id, doc FROM leads ORDER BY seq').all();
  cache = { path: p, rev: v, rows, keys: rows.map(r => r.id), docs: new Map(rows.map(r => [r.id, r.doc])) };
  return cache;
}
// 全部线索，按原来的顺序；每次是新对象（可以改了再 saveAll）。
export const all = () => { const c = loadAll(), g = ++gens; SEEN.unshift([g, c.docs]); SEEN.length = Math.min(SEEN.length, 8); return c.rows.map(r => fromRow(r, g)); };
export const list = ({ state = null } = {}) => all().filter(l => !state || leadState(l) === state);
export function get(id) {
  ensureImported();
  const r = db().prepare('SELECT id, doc FROM leads WHERE id = ?').get(String(id));
  return r ? fromRow(r) : null;
}
export function byNumber(n) {
  ensureImported();
  const rs = db().prepare('SELECT id, doc FROM leads WHERE number = ? ORDER BY seq').all(Number(n)).map(r => fromRow(r));
  return rs.find(l => !l.superseded) || rs.at(-1) || null;
}
export function search(q, { limit = 50 } = {}) {
  ensureImported();
  const like = `%${String(q || '').trim()}%`;
  return db().prepare('SELECT id, doc FROM leads WHERE company LIKE ? OR role LIKE ? OR url LIKE ? ORDER BY seq LIMIT ?').all(like, like, like, limit).map(r => fromRow(r));
}
// 表里那一列 state（查询用；导入时按 lib/lead-state.mjs LEGACY_STATE_MAP 映射）。
export const stateOf = id => (ensureImported(), db().prepare('SELECT state FROM leads WHERE id = ?').get(String(id))?.state ?? null);
export const lastUpdatedAt = id => (ensureImported(), db().prepare('SELECT updated_at FROM leads WHERE id = ?').get(String(id))?.updated_at ?? null);
export const events = id => (ensureImported(), db().prepare('SELECT at, event, from_state, to_state, source, note FROM lead_events WHERE lead_id = ? ORDER BY seq').all(String(id)));

// ── 写 ───────────────────────────────────────────────────────────────────
// 一条线索拆成表里的一行（doc 不含 JD 正文；读 jd_text 不经它的 getter，免得为了比较去取正文）。
function docOf(l) {
  const o = {};
  for (const k of Object.keys(l)) {
    if (k === 'jd_text' || k === 'jd_gzip') continue;
    o[k] = l[k];
  }
  return JSON.stringify(o);
}
function textOf(l) {
  const desc = Object.getOwnPropertyDescriptor(l, 'jd_text');
  if (!desc) return { touch: false };
  if ('value' in desc) return { touch: true, value: desc.value };
  const st = textState.get(l);
  return st?.set ? { touch: true, value: st.value } : { touch: false };
}
const lastStep = l => (Array.isArray(l.history) ? l.history.at(-1) : null);
// 落库前收拾一条：带着 state 的（读出来改过的）不许再写旧字段；没写 state 的（新加的、夹具整条换的）按旧字段推一次，旧字段不进库。
// 返回这一条有没有自己写 state（explicit）。
// 没写 state 的按升级同一套推（旧字段、回执，lib/lead-state.mjs legacyLeadState）；ctx 用到才读。
// 不改调用方手里的那一份：要收拾的另抄一份（连 jd_text 的取值器一起抄，不为了抄去取正文）。返回 { row, explicit }。
function normalize(id, l, before, ctx) {
  const explicit = !!STATES[l.state];
  const legacy = LEGACY_FIELDS.filter(k => k in l);
  if (legacy.length && explicit && before) throw Object.assign(Error(`lead_legacy_field:${id}:${legacy.join(',')}`), { code: 'lead_legacy_field' });
  if (explicit && !legacy.length) return { row: l, explicit };
  const row = Object.defineProperties({}, Object.getOwnPropertyDescriptors(l));
  if (!explicit) row.state = legacyLeadState(l, ctx().of(keyOf(l)));
  for (const k of legacy) delete row[k];
  return { row, explicit };
}
// state 变了：必须是 lead-state.applyEvent 带出来的（它同时写 state、state_at 和 history 最后一条）。
function checkState(id, before, after, imported, explicit) {
  if (imported || !before) return null; // 导入和新加的一条：照它写的状态收下
  const was = before?.state ?? null, now = after.state ?? null;
  if (was === now || !explicit) return null; // 没写 state 的（夹具重灌、旧写法整条换掉）：按旧字段推导，不算转移
  const h = lastStep(after);
  if (!h || h.to !== now || h.at !== after.state_at || !TRANSITIONS[h.event]) throw Object.assign(Error(`lead_state_outside_applyEvent:${id}:${was}->${now}`), { code: 'lead_state_outside_applyEvent' });
  return h;
}
const numberTaken = (d, n, id, other) => d.prepare('SELECT id, doc FROM leads WHERE number = ? AND id != ?').all(n, id).some(r => other(r.id, r.doc) && !JSON.parse(r.doc).superseded);
const newRev = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
// ── 按行写（10-10 rebuild7/row-writes）────────────────────────────────────────
// 以前整份写回（writeAll）先把整张表的 doc 读出来，一行行比；预填这类一跑几分钟的步骤开头读一次、最后写回，
// 两边改了同一个值时以写回的一方为准：你在这期间点的「不推进」、加的备注（state、history）被它几分钟前那份盖掉（复现见本分支的测试）。
// 现在每一条单独写：在一个事务里重读这一行，只把「我」从读出来到现在改了的字段合进现在那一行（mergeLeadDoc），别的行不碰。
//   history 只追加：两边新加的都留着，按时间排；
//   state 两边都改了：现在库里的为准（我的转移是按我读的旧状态算的，已经不成立），我的那几步转移不写进历史，投递子状态的 status 也跟着用现在的；
//   别的字段：我没改的用现在的，别人没改的用我的，两边都改了的普通对象往下一层合，两边都改了的值以我的为准（lib/merge3.mjs）。
// 「读出来时的样子」：读的时候记下的原文（BASE）；调用方另拼了一份（{ ...l, x }）记不到原文的，用同一次读到的那一版（SEEN）。
const TRANSITION_KEYS = ['state', 'state_at', 'offer_at', 'archived_at'];
const stepKey = h => JSON.stringify(h);
const isTransition = h => !!h && h.from !== h.to && !!TRANSITIONS[h.event];
export function mergeLeadDoc(base, mine, theirs) {
  const known = new Set((base.history || []).map(stepKey));
  const stateClash = mine.state !== base.state && theirs.state !== base.state && mine.state !== theirs.state;
  const mineNew = (mine.history || []).filter(h => !known.has(stepKey(h)) && !(stateClash && isTransition(h)));
  const strip = o => { const { history, ...rest } = o; return rest; };
  const b = strip(base), m = strip(mine), t = strip(theirs);
  if (stateClash) {
    for (const k of TRANSITION_KEYS) { if (k in b) m[k] = b[k]; else delete m[k]; }
    if (m.auto_apply && typeof m.auto_apply === 'object' && m.auto_apply.status !== b.auto_apply?.status) {
      m.auto_apply = { ...m.auto_apply };
      if (b.auto_apply && 'status' in b.auto_apply) m.auto_apply.status = b.auto_apply.status; else delete m.auto_apply.status;
    }
  }
  const out = merge3(b, m, t) ?? m;
  const have = new Set((theirs.history || []).map(stepKey));
  const history = [...(theirs.history || []), ...mineNew.filter(h => !have.has(stepKey(h)))].map((h, i) => [h, i])
    .sort((x, y) => String(x[0]?.at || '').localeCompare(String(y[0]?.at || '')) || x[1] - y[1]).map(([h]) => h).slice(-50);
  if (history.length || 'history' in theirs || 'history' in mine) out.history = history;
  return out;
}
// 一次写的公共部分：库、这一次的时间、要落定的投递活（moved）、编号撞没撞要和谁比（other）。
function writer(d, { imported = false, other = () => false } = {}) {
  return {
    d, imported, other, now: new Date().toISOString(), moved: [],
    up: d.prepare(`INSERT INTO leads (id, seq, number, company, role, location, url, source, channel, state, apply, judgement, doc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, number = excluded.number, company = excluded.company, role = excluded.role, location = excluded.location,
      url = excluded.url, source = excluded.source, channel = excluded.channel, state = excluded.state, apply = excluded.apply, judgement = excluded.judgement,
      doc = excluded.doc, updated_at = excluded.updated_at`),
    seqOnly: d.prepare('UPDATE leads SET seq = ? WHERE id = ?'),
    rowOf: d.prepare('SELECT seq, doc FROM leads WHERE id = ?'),
    text: d.prepare('INSERT INTO lead_texts (id, jd_text) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET jd_text = excluded.jd_text'),
    noText: d.prepare('DELETE FROM lead_texts WHERE id = ?'),
    ev: d.prepare('INSERT INTO lead_events (lead_id, at, event, from_state, to_state, source, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };
}
const saveText = (w, id, src) => { const t = textOf(src); if (t.touch) { if (t.value == null) w.noText.run(id); else w.text.run(id, String(t.value)); } };
// 写一条：src 是调用方手里的那一条，base 是它读出来时的原文（没有就 null：新加的、夹具整条换的，照它写），
// cur 是库里现在那一行：{ seq, load }（没有这一行就是 null；doc 要用到才读，cur.load()），seq 是它在调用方那一份里的位置。
// 返回写下的那一条（我没改、没写就 null）。
function writeRow(w, id, seq, src, base, cur, legacyCtx) {
  const { row, explicit } = w.imported ? { row: src, explicit: true } : normalize(id, src, cur, legacyCtx);
  let l = row;
  Object.assign(l, leadFields(l));
  if (!w.imported && base != null && docOf(l) === base) { // 我没改：别人改的、删的照别人的
    if (cur) { if (cur.seq !== seq) w.seqOnly.run(seq, id); saveText(w, id, src); }
    return null;
  }
  const was = cur ? cur.load() : undefined;
  const prev = was ? JSON.parse(was.doc) : null;
  let merged = false;
  if (!w.imported && base != null && was && was.doc !== base) { // 我读了以后别人也改了这一条：只把我改的合进现在那一行
    const b = JSON.parse(base), mine = JSON.parse(docOf(l));
    checkState(id, b, mine, false, explicit);
    l = mergeLeadDoc(b, mine, prev); merged = true;
  }
  if (was && !w.imported) { const pa = prev.auto_apply?.status; if (WAITING.has(pa)) w.moved.push({ id, was: pa, l }); }
  let doc = docOf(l);
  if (was && was.doc === doc) { if (was.seq !== seq) w.seqOnly.run(seq, id); saveText(w, id, src); return l; }
  // 编号撞了（两个进程各自按「现有最大编号 + 1」给推荐岗位编号，锁退役以后可能同时发生）：后写的这一条换成库里的下一个号。
  // 只和别人写进来、这次留着的那几条比（调用方那一份里的行由写的人自己管；这次要删掉的不算）；被合并掉的旧行（superseded）本来就和新行共用编号，不算撞。
  if (!w.imported && num(l.number) != null && num(l.number) !== num(prev?.number) && !l.superseded && numberTaken(w.d, num(l.number), id, w.other)) {
    l = { ...l, number: (w.d.prepare('SELECT MAX(number) AS n FROM leads').get().n || 0) + 1, numbered_at: w.now };
    doc = docOf(l);
  }
  const step = merged ? null : checkState(id, prev, l, w.imported, explicit);
  const judgement = l.judgement ?? l.match ?? null;
  w.up.run(id, seq, num(l.number), l.company ?? null, l.role ?? null, l.location ?? null, l.url ?? null, l.source ?? null, l.channel ?? null,
    leadState(l), toJson(l.auto_apply ?? null), toJson(judgement), doc, l.discovered_at || l.created_at || w.now, w.now);
  // 状态转移各记一条（lead_events）：这一次新加进历史的每一步转移，不只最后一步。
  if (step || merged) {
    const old = new Set((prev?.history || []).map(stepKey));
    for (const h of (l.history || []).filter(h => isTransition(h) && !old.has(stepKey(h)))) w.ev.run(id, h.at ?? null, h.event, h.from ?? null, h.to, h.source ?? null, h.note ?? null);
  }
  saveText(w, id, src);
  return l;
}
function writeAll(d, rows, { imported = false, ctx = null } = {}) {
  const legacyCtx = () => ctx || { of: () => ({}) };
  if (imported) d.exec('DELETE FROM leads; DELETE FROM lead_texts;');
  // 现在库里有哪些行、排在第几（不读 doc：哪一行要写才单独读那一行）。
  const seqs = imported ? new Map() : new Map(d.prepare('SELECT id, seq FROM leads').all().map(r => [r.id, r.seq]));
  // 我这份是哪几次读出来的：没在里头的那几条，只有我读的时候见过、之后也没人改过的才算我删的（我读了以后别人加的、改的留着）。
  const mineGens = new Set(rows.map(r => GEN.get(r)).filter(Boolean));
  const snaps = SEEN.filter(([g]) => mineGens.has(g)).map(([, m]) => m);
  const sawIt = (id, doc) => snaps.some(m => m.get(id) === doc);
  // 不在这一份里、这次也不删的（别的进程写的）：编号撞没撞只和它们比。
  const batch = new Set(), cnt = new Map();
  rows.forEach((l, i) => { const b = keyOf(l) || `row:${i}`, n = (cnt.get(b) || 0) + 1; cnt.set(b, n); batch.add(n === 1 ? b : `${b}#${n}`); });
  const w = writer(d, { imported, other: (id, doc) => !batch.has(id) && !(!mineGens.size || sawIt(id, doc)) });
  // 另拼出来的一条（没有 BASE）：用同一份里别的行是哪一次读的、那一次读到的这一条当原文。整份都是新拼的（夹具、演示数据重灌）就没有原文，照它写。
  const baseOf = (src, id) => BASE.get(src) ?? snaps.find(m => m.has(id))?.get(id) ?? null;
  const seen = new Map(), keep = new Set();
  rows.forEach((l, i) => {
    const key = keyOf(l) || `row:${i}`, n = (seen.get(key) || 0) + 1; seen.set(key, n);
    const id = n === 1 ? key : `${key}#${n}`;
    keep.add(id);
    const base = imported ? null : baseOf(l, id);
    const cur = !imported && seqs.has(id) ? { seq: seqs.get(id), load: () => w.rowOf.get(id) } : null;
    writeRow(w, id, i, l, base, cur, legacyCtx);
  });
  if (!imported) for (const id of seqs.keys()) {
    if (keep.has(id)) continue;
    if (mineGens.size && !sawIt(id, w.rowOf.get(id)?.doc)) continue;
    d.prepare('DELETE FROM leads WHERE id = ?').run(id); w.noText.run(id);
  }
  settleMoved(w);
  setMeta(d, META_REV, newRev()); // 每次写一个新的版本号（不是计数：库被删了重建，计数会撞上旧缓存）
  cache = null;
  return rows.length;
}
const settleMoved = w => pending.push(...w.moved.filter(x => x.l.auto_apply?.status !== x.was || ENDED.has(x.l.state)).map(x => ({ id: x.id, status: x.l.auto_apply?.status ?? null, state: x.l.state, number: x.l.number ?? null })));
// 老写法（writeLines('state/leads.ndjson', rows)）：每一条只写我改了的字段，一条一条在同一个事务里写。
export function saveAll(rows) { ensureImported(); pending = []; const ctx = needsContext(rows) ? legacyContext() : null; return afterWrite(tx(d => writeAll(d, rows, { ctx }))); }

// ── 投递停在提交前的那件活：你答了就落定（第 2 步 2X）───────────────────────────────
// 预填做完、停在终审 / 等你在页面上提交时，账上那件活记的是 waiting_you（lib/workers.mjs settleApply，what 指着 final:<rid> / prefilled:<rid>）。
// 这条线索的投递子状态离开那里（你提交了、自己投了、开始提交）或者线索结束了（不投了、归档），那件活跟着落定：做完 / 取消。
// 放回去重填（重新预填、补完一项）不在这里：那一侧自己把那件活放回排队（lib/apply-retry.mjs retryApplyCard）。在事务提交以后做，出错只打一行。
const WAITING = new Set(['prepared_for_user', 'awaiting_final_review']);
const ENDED = new Set(['passed', 'pass_pending', 'archived', 'rejected']);
const GONE_ON = new Set(['submitting', 'uncertain', 'submitted']);
let pending = [];
function afterWrite(r) {
  const list = pending; pending = [];
  for (const x of list) try { settleApplyWait(x); } catch (e) { console.error(`[jobs] 线索 ${x.id} 停在提交前的那件活没落定：${e.message}`); }
  return r;
}
export function settleApplyWait({ id, status, state, number }) {
  const done = GONE_ON.has(status) || state === 'applied', gone = ENDED.has(state) || status === 'closed';
  if (!done && !gone) return 0;
  const asks = new Set([`final:${id}`, `prefilled:${id}`]), n = number != null ? `#${number} ` : '';
  let k = 0;
  for (const j of J.list({ state: 'waiting_you', limit: 2000 })) {
    if (!asks.has(j.what?.ask_id)) continue;
    if (done) J.drive(j.id, 'done', { result: { summary: status === 'submitted' || state === 'applied' ? `${n}已提交` : `${n}交给提交那一步` } });
    else J.drive(j.id, 'cancelled', { reason: '这条不投了' });
    k++;
  }
  return k;
}

// 改一条：fn 原地改这条线索（或返回新的一条）。只读、只写这一行（事务里读、改、写，中间没人插得进来）。
export function update(id, fn) {
  ensureImported(); pending = [];
  return afterWrite(tx(d => {
    const r = d.prepare('SELECT id, seq, doc FROM leads WHERE id = ?').get(String(id));
    if (!r) throw Object.assign(Error(`lead_missing:${id}`), { code: 'lead_missing' });
    const l = fromRow(r), next = fn(l) || l;
    writeOne(d, r, next, r.doc);
    return next;
  }));
}
// 一个跑了很久的步骤把它这期间改的合回去：before 是它开始改之前那一份（或者上一次合回去的那一份），after 是它现在手里的。
// 只把 before → after 之间改了的字段合进库里现在那一行（规矩同上，mergeLeadDoc）。这条被删了就什么也不写，返回 null；否则返回写下的那一条。
export function merge(id, before, after) {
  ensureImported(); pending = [];
  return afterWrite(tx(d => {
    const r = d.prepare('SELECT id, seq, doc FROM leads WHERE id = ?').get(String(id));
    if (!r) return null;
    const base = docOf(before);
    return writeOne(d, r, after, base) ?? fromRow(d.prepare('SELECT id, doc FROM leads WHERE id = ?').get(r.id));
  }));
}
function writeOne(d, r, src, base) {
  const w = writer(d);
  const out = writeRow(w, r.id, r.seq, src, base, { seq: r.seq, load: () => r }, () => ({ of: () => ({}) }));
  settleMoved(w);
  setMeta(d, META_REV, newRev()); cache = null;
  return out;
}
// 改状态的唯一入口：不合法的转移直接报错。返回 { from, to }。
export function applyEvent(id, event, data = {}, { source = 'system', at } = {}) {
  let out = null;
  update(id, l => { out = stateEvent(l, event, data, { strict: true, source, ...(at ? { at } : {}) }); });
  return out;
}

// 看另一个数据目录里的线索（测试、体检用；只读）：lib/leads-read.mjs，不经 store，不定数据目录。
export { leadsAt } from './leads-read.mjs';
