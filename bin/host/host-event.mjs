// 宿主脚本（run-now.sh、radar-cycle.sh、mail-poll.sh）记一条运行事件（state/events.ndjson）。
// 出错就停的那几道闸（兜底清单 E05 执行器权限档、E06 代码守卫、I05 run_host）停下时记 fail：指挥台的严重告警和顶上
// 「挡路大事」就看得到。
// 执行器链换了下一个（E01）走统一的「换了」记录 lib/fallback.mjs noteFallback（计数 + 一天一行事件，System 的健康账本读它）；
// lib/ 读不了（执行器把它改坏了之类）就退回自己写一行 fallback 事件，不丢。
// 写 fail 那条只用 node 自带的模块（和 code-guard.mjs 一样）：执行器要是把 lib/ 改坏了，这里照样能记。
// 用法（cwd = 数据目录）：
//   node bin/host/host-event.mjs <step> fail <说明…>
//   node bin/host/host-event.mjs --fallback <kind> <from> <to> <原因>
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const append = row => { fs.mkdirSync('state', { recursive: true }); fs.appendFileSync(path.join('state', 'events.ndjson'), JSON.stringify(row) + '\n'); };
const base = { ts: new Date().toISOString(), run_id: process.env.RADAR_RUN_ID || `host-${process.ppid}`, actor: 'system', refs: [] };

if (args[0] === '--fallback') {
  const [, kind, from, to, ...why] = args;
  if (!kind || !from || !to) { console.error('usage: host-event.mjs --fallback <kind> <from> <to> <why>'); process.exit(2); }
  try {
    process.env.RADAR_ROOT ||= process.cwd();
    const { noteFallback } = await import(new URL('../../lib/fallback.mjs', import.meta.url));
    noteFallback({ kind, from, to, why: why.join(' ') });
  } catch {
    append({ ...base, step: 'fallback', status: 'ok', msg: `${from} 没调通，改用 ${to}`.slice(0, 500), kind, from, to });
  }
} else {
  const [step, status, ...words] = args;
  if (!step || status !== 'fail' || !words.length) { console.error('usage: host-event.mjs <step> fail <msg> | --fallback <kind> <from> <to> <why>'); process.exit(2); }
  append({ ...base, step, status, msg: words.join(' ').slice(0, 500) });
}
