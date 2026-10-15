// 回执（第 2 步·对外记录，契约 05 2.2）：每次对外动作的回执——发出去的信、私信、平台打招呼、投递提交（系统交的、你自己交的）。
// 在数据库的 receipts 表里（lib/db.mjs 第 7 版），只追加：改、删一律被触发器挡住。
//
// 一行回执：id（回执自己的号，以前 outbound.ndjson 那一行的 id）、rev（同一条回执再记一次就是新的一行，rev + 1）、
//   record_id、channel、kind、action_id、draft_id、verified（核对结果）、evidence（证据：路径或核对的出处）、at、doc（整条）。
//   读的时候同一个 id 取最新的那一行，位置按它第一次出现的顺序。
// 读：all()、byRecord(record_id)、history(id)，以及老读法 lines('state/outbound.ndjson')（lib/store.mjs 转到 all()）。
// 写：append(row)；老写法 writeLines('state/outbound.ndjson', rows) 转到 saveAll(rows)：新的 id 追加，内容变了的追加一个新版本，
//   不在 rows 里的照旧留着（只追加，不删）。
// 旧文件 state/outbound.ndjson：第一次用到时导进来（先备份），以后只读、不再写（lib/db-import.mjs）。
import { db, tx } from './db.mjs';
import { legacyImporter, metaSet } from './db-import.mjs';

export const LEGACY_FILE = 'state/outbound.ndjson';
const UNLOCK = 'receipts_unlock';

// 核对结果：一句短的记号，从回执里认（发信：「已发送」里找到 / SMTP 收下；私信：对话里读回；投递：门户确认页；你说的）。
export function verifiedOf(o = {}) {
  if (o.verified != null) return String(o.verified);
  if (o.manual || o.submitted_by === 'user' || /^user/.test(String(o.evidence || ''))) return 'user';
  if (o.evidence === 'sent-folder') return 'sent_folder';
  if (/^smtp/.test(String(o.evidence || ''))) return 'smtp_accepted';
  if (o.readback || o.verified_at) return 'read_back';
  if (o.confirmation || o.status === 'submitted') return 'portal';
  return null;
}
const kindOf = o => String(o.kind || (o.status === 'submitted' ? 'submit' : /email|mail/.test(String(o.channel || 'email')) ? 'email' : 'message'));
const evidenceOf = o => (o.evidence == null ? (o.screenshot || o.receipt_path || null) : typeof o.evidence === 'string' ? o.evidence : JSON.stringify(o.evidence));

function insert(d, o, id, rev) {
  d.prepare(`INSERT INTO receipts (id, rev, record_id, channel, kind, action_id, draft_id, verified, evidence, at, doc, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, rev, o.record_id ?? null, o.channel ?? null, kindOf(o), o.action_id ?? null, o.draft_id ?? null, verifiedOf(o), evidenceOf(o), o.at || o.sent_at || o.submitted_at || null, JSON.stringify(o), new Date().toISOString());
}
// 旧文件整份导入：只在这里开一下锁（meta receipts_unlock），清掉再导，同一个事务里关上。旧文件先备份过（lib/db-import.mjs）。
function load(d, rows) {
  metaSet(d, UNLOCK, true);
  try { d.exec('DELETE FROM receipts'); rows.forEach((o, i) => insert(d, o, String(o.id || `row:${i}`), 1)); }
  finally { d.prepare('DELETE FROM meta WHERE key = ?').run(UNLOCK); }
}
export const ensureImported = legacyImporter({ legacy: LEGACY_FILE, name: 'outbound', load });

// 每个 id 的最新一行，按第一次出现的顺序。
const LATEST = `SELECT r.doc FROM receipts r JOIN (SELECT id, MIN(seq) AS first, MAX(seq) AS last FROM receipts GROUP BY id) g ON r.seq = g.last`;
let cache = null; // { db, last, rows }
export function all() {
  ensureImported();
  const d = db(), last = d.prepare('SELECT MAX(seq) AS s FROM receipts').get().s ?? 0;
  if (!cache || cache.db !== d || cache.last !== last) cache = { db: d, last, rows: d.prepare(`${LATEST} ORDER BY g.first`).all().map(r => r.doc) };
  return cache.rows.map(s => JSON.parse(s));
}
export const revision = () => { ensureImported(); return String(db().prepare('SELECT MAX(seq) AS s FROM receipts').get().s ?? 0); };
export const byRecord = recordId => { ensureImported(); return db().prepare(`${LATEST} WHERE r.record_id = ? ORDER BY g.first`).all(String(recordId)).map(r => JSON.parse(r.doc)); };
export const history = id => { ensureImported(); return db().prepare('SELECT rev, doc, recorded_at FROM receipts WHERE id = ? ORDER BY seq').all(String(id)).map(r => ({ rev: r.rev, recorded_at: r.recorded_at, ...JSON.parse(r.doc) })); };

function appendRows(d, rows) {
  const cur = new Map(d.prepare('SELECT r.id, r.rev, r.doc FROM receipts r JOIN (SELECT id, MAX(seq) AS last FROM receipts GROUP BY id) g ON r.seq = g.last').all().map(r => [r.id, r]));
  let n = 0;
  rows.forEach((o, i) => {
    if (!o || typeof o !== 'object') return;
    const id = String(o.id || `row:${i}`), doc = JSON.stringify(o), was = cur.get(id);
    if (was && was.doc === doc) return;
    insert(d, o, id, (was?.rev || 0) + 1);
    cur.set(id, { id, rev: (was?.rev || 0) + 1, doc });
    n++;
  });
  return n;
}
// 记一条（或几条）回执。返回追加了几行。
export function append(...rows) { ensureImported(); return tx(d => appendRows(d, rows.flat())); }
// 老写法：整份给过来，只追加新的和变了的。
export function saveAll(rows) { ensureImported(); return tx(d => appendRows(d, rows)); }
