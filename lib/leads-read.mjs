// 看某个数据目录里的线索（测试、体检用；只读，不导入、不建库，也不加载 lib/store.mjs，所以不会定下进程的数据目录）。
// 有库、而且旧文件没在库外头换过：读库；否则读旧文件 state/leads.ndjson。
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const parse = text => text.split('\n').filter(s => s.trim()).flatMap(s => { try { const l = JSON.parse(s); if (l?.jd_gzip) { try { l.jd_text = gunzipSync(Buffer.from(l.jd_gzip, 'base64')).toString('utf8'); } catch { /* 兜底：只读的体检、测试用；JD 解不开就当没有 */ } delete l.jd_gzip; } return l && typeof l === 'object' ? [l] : []; } catch { return []; } });
const json = s => { try { return s == null ? null : JSON.parse(s); } catch { return null; /* 兜底：meta 里坏的值当没导过 */ } };

export function leadsAt(dir) {
  const dbFile = path.join(dir, 'state/offercrew.db');
  if (fs.existsSync(dbFile)) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const has = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leads'").get();
      const imp = has && json(d.prepare("SELECT value FROM meta WHERE key = 'leads_import'").get()?.value);
      let sig = null; try { const s = fs.statSync(path.join(dir, 'state/leads.ndjson')); sig = `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { /* 兜底：没有旧文件，签名就是空 */ }
      const fileNewer = sig && imp?.sig !== sig; // 旧文件在库外头换过、还没人导：照 ensureImported 的规矩，读文件
      if (has && !fileNewer && (imp || d.prepare('SELECT COUNT(*) AS n FROM leads').get().n)) {
        const texts = new Map(d.prepare('SELECT id, jd_text FROM lead_texts').all().map(r => [r.id, r.jd_text]));
        return d.prepare('SELECT id, doc FROM leads ORDER BY seq').all().map(r => { const l = JSON.parse(r.doc); if (texts.has(r.id)) l.jd_text = texts.get(r.id); return l; });
      }
    } finally { d.close(); }
  }
  try { return parse(fs.readFileSync(path.join(dir, 'state/leads.ndjson'), 'utf8')); } catch { return []; /* 兜底：没有旧文件就是空 */ }
}
// 同上，写成旧文件的样子（一行一条）：测试里拿它比较前后有没有变。
export const leadsText = dir => leadsAt(dir).map(l => JSON.stringify(l)).join('\n') + '\n';

// 草稿、发送请求、回执（第 2 步·对外记录）：同样只读、不导入、不建库。有库、而且旧文件没在库外头换过：读库；否则读旧文件。
const DB_ROWS = {
  'state/drafts.ndjson': { table: 'drafts', meta: 'drafts_import', sql: 'SELECT doc, body FROM drafts ORDER BY seq', row: r => { const d = JSON.parse(r.doc); if (r.body != null) d.body = r.body; return d; } },
  'state/send-requests.ndjson': { table: 'actions', meta: 'send-requests_import', column: 'delivery', sql: 'SELECT id, delivery FROM actions WHERE delivery IS NOT NULL ORDER BY rowid', row: r => ({ ...JSON.parse(r.delivery), action_id: r.id }) },
  'state/outbound.ndjson': { table: 'receipts', meta: 'outbound_import', sql: 'SELECT r.doc FROM receipts r JOIN (SELECT id, MIN(seq) AS first, MAX(seq) AS last FROM receipts GROUP BY id) g ON r.seq = g.last ORDER BY g.first', row: r => JSON.parse(r.doc) },
};
export function rowsAt(dir, rel) {
  if (rel === 'state/leads.ndjson') return leadsAt(dir);
  const spec = DB_ROWS[rel], dbFile = path.join(dir, 'state/offercrew.db');
  if (spec && fs.existsSync(dbFile)) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const d = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const cols = d.prepare(`PRAGMA table_info(${spec.table})`).all().map(c => c.name);
      if (cols.length && (!spec.column || cols.includes(spec.column))) {
        const imp = json(d.prepare('SELECT value FROM meta WHERE key = ?').get(spec.meta)?.value);
        let sig = null; try { const s = fs.statSync(path.join(dir, rel)); sig = `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { /* 兜底：没有旧文件，签名就是空 */ }
        if (!(sig && imp?.sig !== sig)) return d.prepare(spec.sql).all().map(spec.row);
      }
    } finally { d.close(); }
  }
  try { return parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return []; /* 兜底：没有旧文件就是空 */ }
}
