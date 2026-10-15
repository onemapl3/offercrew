// 桌面版的定时周期（lib/app-schedule.mjs 到点拉起）：只跑引擎自己的周期，不拉起执行器（10-02 开箱第 2 轮 X1，负责人定）。
// 和 bin/host/radar-cycle.sh 的前半段一样：合盖用电池时这一轮跳过、留补跑标记（lib/cycle-catchup.mjs，和 bin/cycle-gate.mjs
// 同一条规则），然后跑 bin/scheduled.mjs；输出也放在同一处（runs/<日期>/cycle-host/ 的 scheduled-<时分>.json、log-<时分>.txt，
// poll.log 记「scheduled start / scheduled exit=N」，指挥台和晚报读它）。radar-cycle.sh 跑完这一段还会用
// --dangerously-bypass-approvals-and-sandbox 拉起这台电脑上的 Codex / Claude（用户自己的 ~/.codex 和连接器）——这里不跑。
import fs from 'node:fs';
import { spawnSync } from '../lib/spawn.mjs';
import { root, file } from '../lib/store.mjs';
import { skipIfAsleep } from '../lib/cycle-catchup.mjs';
import { TZ } from '../lib/tz.mjs';

const clock = (t = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(t).map(x => [x.type, x.value]));
  return { day: `${p.year}${p.month}${p.day}`, hhmm: `${p.hour}${p.minute}`, stamp: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}` };
};
const { day, hhmm } = clock();
const dir = file(`runs/${day}/cycle-host`);
fs.mkdirSync(dir, { recursive: true });
const poll = line => fs.appendFileSync(`${dir}/poll.log`, `[${clock().stamp}] ${line}\n`);

// 补跑标记记的是错过的那一档（App 定时给的 RADAR_SLOT，lib/app-schedule.mjs），不是这一拍的钟点：醒来补的那一轮按它定带不带判断。
const slot = /^\d{8}-\d{4}$/.test(process.env.RADAR_SLOT || '') ? process.env.RADAR_SLOT : `${day}-${hhmm}`;
let skipped = null;
try { skipped = skipIfAsleep({ slot }); } catch (e) { console.error(`app-cycle: ${e.message}`); }
if (skipped) { poll(skipped); process.exit(0); }

poll('scheduled start');
const out = fs.openSync(`${dir}/scheduled-${hhmm}.json`, 'w'), err = fs.openSync(`${dir}/log-${hhmm}.txt`, 'a');
const r = spawnSync(process.execPath, ['bin/scheduled.mjs'], { cwd: root, stdio: ['ignore', out, err] });
const rc = r.status ?? 1;
poll(`scheduled exit=${rc}`);
process.exitCode = rc;
