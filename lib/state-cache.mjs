// 工作台进程内的只读缓存：按文件签名（mtime + size + inode）记住解析结果。
//
// 20 MB 的 leads.ndjson 每解析一次要 0.2–0.5 秒、上百 MB 临时内存；指挥台、线索查询、
// 看板在一次请求里会各读好几遍。这里让同一份文件只在它真的变了之后才重新解析。
//
// 约定：cachedLines() 返回的对象在多个视图之间共享，只能读、不能改。要改线索请照旧
// 用 store.mjs 的 lines() 读一份自己的副本再 writeLines()。压缩的 JD（jd_gzip）不在
// 读取时解压，第一次访问 jd_text 才解压并记住（列表视图从不碰它）。
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { file, dbFile } from './store.mjs';

export function fileSig(p) {
  const m = dbFile(p);
  if (m) { try { return `db:${m.revision()}`; } catch { return '-'; } } // 进了库的（线索、草稿、发送请求、回执，lib/store.mjs dbFile）：签名是库里那一版
  try { const s = fs.statSync(file(p)); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return '-'; }
}
export const sigOf = paths => paths.map(fileSig).join('|');

function lazyJd(row) {
  const gz = row.jd_gzip;
  delete row.jd_gzip;
  let value;
  Object.defineProperty(row, 'jd_text', {
    configurable: true, enumerable: true,
    get() { if (value === undefined) { try { value = gunzipSync(Buffer.from(gz, 'base64')).toString('utf8'); } catch { value = ''; } } return value; },
    set(v) { value = v; },
  });
  return row;
}

const linesCache = new Map();
export function parseLines(text) {
  const out = [];
  for (const s of text.split('\n')) {
    if (!s) continue;
    let row;
    try { row = JSON.parse(s); } catch { continue; }
    out.push(row && row.jd_gzip ? lazyJd(row) : row);
  }
  return out;
}
// 同一签名返回同一批对象（数组是新的浅拷贝，调用方排序不会影响别人）。
export function cachedLines(p) {
  const sig = fileSig(p);
  const hit = linesCache.get(p);
  if (hit && hit.sig === sig) return hit.rows.slice();
  const rows = dbFile(p) ? dbFile(p).all() : sig === '-' ? [] : parseLines(fs.readFileSync(file(p), 'utf8'));
  linesCache.set(p, { sig, rows });
  return rows.slice();
}
const jsonCache = new Map();
export function cachedRead(p, fallback = null) {
  const sig = fileSig(p);
  if (sig === '-') return fallback;
  const hit = jsonCache.get(p);
  if (hit && hit.sig === sig) return hit.value;
  let value;
  try { value = JSON.parse(fs.readFileSync(file(p), 'utf8')); } catch { return fallback; }
  jsonCache.set(p, { sig, value });
  return value;
}

// 视图结果的记忆：签名由调用方给的文件列表 + 额外的键组成；文件没变就直接复用上次的结果。
const memoCache = new Map();
export function memoize(key, paths, compute, { extra = '', maxAgeMs = Infinity, now = Date.now() } = {}) {
  const sig = sigOf(paths) + '|' + extra;
  const hit = memoCache.get(key);
  if (hit && hit.sig === sig && now - hit.at < maxAgeMs) return hit.value;
  const started = Date.now();
  const value = compute();
  memoCache.set(key, { sig, value, at: now, ms: Date.now() - started });
  return value;
}
export function memoStats() {
  return Object.fromEntries([...memoCache].map(([k, v]) => [k, { ms: v.ms, at: new Date(v.at).toISOString() }]));
}
export function clearStateCache() { linesCache.clear(); jsonCache.clear(); memoCache.clear(); }
