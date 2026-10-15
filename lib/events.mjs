import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { file as rootFile } from './paths.mjs';
const file=p=>path.join(process.env.RADAR_ROOT||fileURLToPath(new URL('../',import.meta.url)),p);
export const runId = process.env.RADAR_RUN_ID || `run-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
const scope = new AsyncLocalStorage();
export const eventRunId = () => scope.getStore() || runId;
export function withEventRun(label, work) {
  return scope.getStore() ? work() : scope.run(`${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, work);
}
export function event(actor, step, status, msg, extra = {}) {
  const row = { ts: new Date().toISOString(), run_id: eventRunId(), actor, step, status, msg, refs: [], ...extra };
  fs.mkdirSync(file('state'), { recursive: true });
  fs.appendFileSync(file('state/events.ndjson'), JSON.stringify(row) + '\n');
  return row;
}

// 事件日志的尾部：跳过飞书心跳行（历史文件里 80% 以上是它们），按文件签名缓存。
// 调用方只读；需要的行数不够时把读取窗口从 2 MB 逐步放大到 16 MB。
const tailCache = new Map();
export function tailEvents(limit = 1500) {
  const p = rootFile('state/events.ndjson');
  let st; try { st = fs.statSync(p); } catch { return []; } // 兜底：日志还没有就是空的
  const sig = `${st.mtimeMs}:${st.size}:${st.ino}`, hit = tailCache.get(limit);
  if (hit && hit.sig === sig) return hit.rows.slice();
  let bytes = 2 * 1024 * 1024, rows = [];
  for (;;) {
    const start = Math.max(0, st.size - bytes), b = Buffer.alloc(st.size - start);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, b, 0, b.length, start); } finally { fs.closeSync(fd); }
    const raw = b.toString('utf8').split('\n');
    if (start) raw.shift();
    rows = raw.filter(x => x && !x.includes('"step":"heartbeat"')).flatMap(x => { try { return [JSON.parse(x)]; } catch { return []; } }); // 兜底：一行坏了跳过这一行
    if (rows.length >= limit || !start || bytes >= 16 * 1024 * 1024) break;
    bytes *= 2;
  }
  rows = rows.slice(-limit);
  tailCache.set(limit, { sig, rows });
  return rows.slice();
}


// 完整历史按行读，不受快照的条数或 16 MB 尾窗限制；不将整份账本塞进页面快照。
export async function* scanEvents() {
  const p = rootFile('state/events.ndjson');
  if (!fs.existsSync(p)) return;
  const input = fs.createReadStream(p, { encoding: 'utf8' }), reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      let row;
      try { row = JSON.parse(line); } catch { continue; } // 坏行不挡后面的真实记录。
      if (row && typeof row === 'object' && !Array.isArray(row) && row.step !== 'heartbeat' && typeof row.ts === 'string') yield row;
    }
  } finally { reader.close(); input.destroy(); }
}
