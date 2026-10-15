#!/usr/bin/env node
// 引擎里的 worker（lib/workers.mjs）：lib/actions.mjs kickWorker 起它，一种动作一个进程。领完这一种可领的就退出；
// 做的时候又有新批准的，再领一轮（最多 5 轮）。输出一行 JSON。
import { runWorker } from '../lib/workers.mjs';
import { KINDS } from '../lib/actions.mjs';
import { sandboxed } from '../lib/sandbox.mjs';

const i = process.argv.indexOf('--kind'), kind = i < 0 ? null : process.argv[i + 1];
if (!KINDS.includes(kind)) { console.error(`--kind 要是 ${KINDS.join(' / ')}`); process.exit(2); }
if (sandboxed()) { console.log(JSON.stringify({ kind, status: 'skipped', reason: 'sandbox' })); process.exit(0); }
let total = 0;
for (let round = 0; round < 5; round++) {
  const r = await runWorker(kind);
  total += r.claimed;
  if (!r.claimed) break;
}
console.log(JSON.stringify({ kind, status: total ? 'changed' : 'no_change', claimed: total }));
