// 数据目录里的路径、内容的指纹、「写完一个文件」的通知：最底下的一层，只引 node 自带的。
// lib/store.mjs 从这里转出去（老的调用方照旧 import { file } from './store.mjs'）；库那几个模块（db、leads、drafts……）和 lib/changes.mjs
// 直接引这里，不引 store：store 是它们的门面（老读法 lines('state/leads.ndjson') 转到库里），它们再引 store 就成了环（第 4 步 4b 解开）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = process.env.RADAR_ROOT || fileURLToPath(new URL('../', import.meta.url));
export const file = (p) => path.join(root, p);
export const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

// 写完一个文件告诉谁（lib/changes.mjs 挂上来；lib/store.mjs 每写完一份叫 wrote）。
const written = new Set();
export function onWrite(fn) { written.add(fn); return () => written.delete(fn); }
export const wrote = (p) => { for (const fn of written) try { fn(p); } catch (e) { console.error(`[store] 写完 ${p} 通知没送到：${e.message}`); } }; // 兜底：通知只是让视图缓存早一点失效，送不到的下一拍目录监听也会补上
// 只读一份 ndjson（不记原文、不合并：要写回的照旧用 lib/store.mjs 的 lines）。库那几个模块读还在文件里的旧记录用它。
export function readLines(p) {
  let t;
  try { t = fs.readFileSync(file(p), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return t.split('\n').filter(Boolean).map(s => JSON.parse(s));
}
