// 旧文件导进库（第 2 步·对外记录）：草稿、发送请求、回执三个 ndjson 共用的一套导入规矩，和线索（lib/leads.mjs）一样：
//   - 第一次用到时导进来：先把旧文件备份到 state/backups/<名>-<时间>.ndjson，再在一个事务里整份导入，记下文件签名；
//   - 之后旧文件只读、不再写（写都进库）；
//   - 旧文件在库外头被换掉了（演示数据重灌、测试写夹具），签名和上次导入时不一样：再备份、再整份导一遍；
//   - 可以重复跑：签名没变就什么都不做；导到一半出错整个事务回滚，下次再导。
// 坏行跳过（原文件有备份）。
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, toJson, fromJson } from './db.mjs';
import { file } from './paths.mjs';

export function parseNdjson(text) {
  const out = [];
  for (const s of String(text || '').split('\n')) {
    if (!s.trim()) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r);
  }
  return out;
}
const sigOf = p => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; /* 兜底：没有旧文件，不用导 */ } };
export const metaOf = (d, k) => fromJson(d.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null);
export const metaSet = (d, k, v) => d.prepare('INSERT INTO meta (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').run(k, toJson(v), new Date().toISOString());
export const newRev = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// legacy：'state/drafts.ndjson' 这样；name：备份文件名和 meta 键用的短名；load(d, rows, { reimport })：在事务里把这些行写进库。
// 返回 ensure()：要用之前调一次，返回这次导了几行（没导是 0）。
export function legacyImporter({ legacy, name, load }) {
  let checkedSig, checkedPath = null, checkedDb = null;
  const key = `${name}_import`;
  return function ensure() {
    const p = file(legacy), sig = sigOf(p), d = db();
    if (checkedPath === p && checkedSig === sig && checkedDb === d) return 0; // 库换了一个（文件被挪走、重建）也要再看一眼
    const last = metaOf(d, key);
    if (!sig || last?.sig === sig) { checkedSig = sig; checkedPath = p; checkedDb = d; return 0; }
    const text = fs.readFileSync(p, 'utf8');
    const dir = file('state/backups'); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(p, path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`));
    const rows = parseNdjson(text);
    const n = tx(d2 => {
      // 另一个进程可能刚导过同一份：拿到写锁以后再看一眼。
      if (metaOf(d2, key)?.sig === sig) return 0;
      load(d2, rows, { reimport: !!last });
      metaSet(d2, key, { sig, at: new Date().toISOString(), count: rows.length, bytes: text.length });
      return rows.length;
    });
    checkedSig = sig; checkedPath = p; checkedDb = d;
    return n;
  };
}
