// 合盖睡眠时不跑定时周期，醒来后补一轮（2026-09-29）。
//
// 09-29 13:07 那轮：合盖用电池，Mac 只在每 16–17 分钟一次、每次约 2 秒的 DarkWake 里醒着，周期墙钟
// 跑了 80 分钟，发现、判断、匹配、投递都被预算挤掉（bin/cycle.mjs 的 slept_ms）。现在 launchd 的定时
// 周期先过一道门（bin/cycle-gate.mjs，由 bin/host/radar-cycle.sh 调用；手动 --now 不过门）：合盖且用
// 电池就不跑，在 poll.log 和事件里记一行，留下补跑标记 state/cycle-catchup.json。合盖但插着电（外接
// 显示器的合盖模式）照常跑；读不到状态也照常跑。
//
// 工作台（bin/serve.mjs）醒着时看到标记，就经操作台补跑一轮轻量周期（runOp('cycle-light')）：开盖或
// 插着电，这一拍准时到（没有刚睡过的空档），没有周期在跑，而且在定时周期的时段里（08:30–19:30，与
// radar-cycle.sh 相同，夜里醒来不发东西）。每个错过的时段最多补一轮：开跑前先在标记上记下认领时间。
// 之后任何一轮周期开始（bin/cycle.mjs）都会清掉标记，所以已经有新一轮就不补。沙盒里这些都不跑。
//
// 10-02 开箱第 3 轮 D：错过的是完整周期那一档（09:05 / 13:05 / 18:05，lib/cycle-mode.mjs），补的轻量周期带上判断和匹配
// （runOp('cycle-catchup')，bin/cycle.mjs --mode light --judge）；以前只补轻量，那一档的判断就丢了。
import { execFileSync } from './spawn.mjs';
import fs from 'node:fs';
import { read, write, file } from './store.mjs';
import { event } from './events.mjs';
import { sandboxed } from './sandbox.mjs';
import { TZ } from './tz.mjs';
import { missedFullSlot } from './cycle-mode.mjs';
import { discoverDue, lastDiscover, lastFullSlot, whenText } from './discover-fresh.mjs';

export const CATCHUP_PATH = 'state/cycle-catchup.json';
export const SKIP_LINE = '电脑合盖睡眠中，本轮跳过，醒来后补一轮';
// A workbench tick this much later than due came right after a sleep, or in a
// DarkWake: wait for a tick that comes on time before starting anything.
export const CATCHUP_SLACK_MS = 15000;
// Scheduled cycles run 08:30–19:30 local time (bin/host/radar-cycle.sh); so does a catch-up.
const WINDOW = [830, 1930];

// `ioreg -r -k AppleClamshellState -d 4`: "AppleClamshellState" = Yes when the lid is closed.
export function parseClamshell(ioreg) {
  const m = String(ioreg ?? '').match(/"AppleClamshellState"\s*=\s*(Yes|No)\b/);
  return m ? m[1] === 'Yes' : null;
}
// `pmset -g batt`: Now drawing from 'Battery Power' (or 'AC Power').
export function parseBattery(pmset) {
  const m = String(pmset ?? '').match(/drawing from '([^']+)'/);
  return m ? m[1] === 'Battery Power' : null;
}
const run = (bin, args) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } // 兜底：系统命令读不到就当没有睡眠记录
};
// The lid and the power source now; null where it could not be read.
export function powerState({ exec = run } = {}) {
  return {
    lidClosed: parseClamshell(exec(process.env.RADAR_IOREG_BIN || '/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'])),
    onBattery: parseBattery(exec(process.env.RADAR_PMSET_BIN || '/usr/bin/pmset', ['-g', 'batt'])),
  };
}
// Lid closed on battery: the Mac is asleep and a cycle would only crawl through
// DarkWakes. Lid closed on AC is clamshell mode and runs; unknown runs too.
export const asleepOnBattery = (s) => s?.lidClosed === true && s?.onBattery === true;

// 'YYYYMMDD-HHMM'（本地时区），和 lib/app-schedule.mjs 的 slotKey 同一个写法。
const dayKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms).replaceAll('-', '');
const slotKey = (ms) => `${dayKey(ms)}-${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms).replace(':', '')}`;
// 错过的那一档：今天的只写钟点；不是今天的带上日期（10-10 09:08 卡上写「13:05 那一轮合盖跳过」，其实是前一天的 13:05）。
export const slotLabel = (m, now = Date.now()) => {
  const s = String(m?.slot || '');
  if (!/^\d{8}-\d{4}$/.test(s)) return s || '上一个时段';
  const hm = `${s.slice(9, 11)}:${s.slice(11)}`, d = s.slice(0, 8);
  if (d === dayKey(now)) return hm;
  if (d === dayKey(now - 24 * 3600000)) return `昨天 ${hm}`;
  return `${d.slice(0, 4) === dayKey(now).slice(0, 4) ? '' : `${d.slice(0, 4)}-`}${d.slice(4, 6)}-${d.slice(6, 8)} ${hm}`;
};
// 补跑标记是早一档留下的，刚刚又到了一档定时周期（App 的定时这一拍就会拉起它，09:05 这种是完整周期，自己会找岗位）：
// 先让它跑，它开始时清掉标记（bin/cycle.mjs clearCatchup）；它要是又因为合盖跳过，标记换成新的这一档，下一拍照常补。
// 10 分钟里它还没开始（App 刚重启，错过的那一档定时不会再拉起），就照常补。
export const SCHEDULED_GRACE_MS = 10 * 60000;

// The scheduled cycle's gate. Returns the line to log when this run is skipped, else null.
export function skipIfAsleep({ slot = '', now = Date.now(), power = powerState } = {}) {
  if (sandboxed()) return null;
  if (!asleepOnBattery(typeof power === 'function' ? power() : power)) return null;
  write(CATCHUP_PATH, { missed_at: new Date(now).toISOString(), slot: String(slot) });
  event('heartbeat', 'cycle', 'skip', SKIP_LINE, { slot: String(slot) });
  return SKIP_LINE;
}

// A cycle is starting (bin/cycle.mjs): it covers the missed one, so the marker goes.
export function clearCatchup() {
  if (sandboxed()) return null;
  const marker = read(CATCHUP_PATH, null);
  if (!marker) return null;
  fs.rmSync(file(CATCHUP_PATH), { force: true });
  if (!marker.catchup_started_at) event('heartbeat', 'cycle', 'skip', `新一轮周期已开始，不再补跑 ${slotLabel(marker)} 合盖跳过的那一轮`, { slot: marker.slot ?? null });
  return marker;
}

function cycleRunning() {
  try {
    const pid = Number(fs.readFileSync(file('private/cycle.lock'), 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) { return e.code === 'EPERM'; }
}
function inWindow(now) {
  const hhmm = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).replace(':', ''));
  return hhmm >= WINDOW[0] && hhmm <= WINDOW[1];
}

// One workbench tick. `late`: how much later than due this tick came. `start({ judge })`
// starts the light cycle (runOp('cycle-light')), with judging when the missed
// slot was a full one (runOp('cycle-catchup')), and throws when it cannot.
//
// 10-10：上一次读通的找岗位早于最近一档完整周期（lib/discover-fresh.mjs discoverDue）就带上找岗位（start({ discover })，
// 带找岗位就一定带判断）。插着电、开着盖用电池都照常补（笔记本多半用电池，不补就天天不找）；合盖用电池上面已经在等。
// 找岗位没读通不在这里另起重试：下一档定时周期、下一次补跑看的还是「上次读通」，没读通就一直带上，直到读通为止。
export function tickCatchup({ now = Date.now(), late = 0, start, power = powerState, running = cycleRunning, pipeline = () => read('config/pipeline.json', {}), last = null } = {}) {
  if (sandboxed()) return { action: 'none' };
  const marker = read(CATCHUP_PATH, null);
  if (!marker?.missed_at || marker.catchup_started_at) return { action: 'none' };
  if (late > CATCHUP_SLACK_MS) return { action: 'wait', reason: 'just_woke' };
  if (!inWindow(now)) return { action: 'wait', reason: 'outside_hours' };
  if (running()) return { action: 'wait', reason: 'cycle_running' };
  if (asleepOnBattery(typeof power === 'function' ? power() : power)) return { action: 'wait', reason: 'asleep' };
  const pipe = typeof pipeline === 'function' ? pipeline() : pipeline;
  const due = lastFullSlot(now, pipe);
  if (due != null && now - due < SCHEDULED_GRACE_MS && slotKey(due) > String(marker.slot || '')) return { action: 'wait', reason: 'scheduled_due' };
  // Claim the slot first: whatever happens to the run, it is not started twice.
  write(CATCHUP_PATH, { ...marker, catchup_started_at: new Date(now).toISOString() });
  const L = last || lastDiscover({ now });
  const discover = discoverDue({ now, pipeline: pipe, last: L });
  const judge = discover || missedFullSlot(marker.slot, pipe);
  let op;
  try { op = start({ judge, discover }); } catch (e) {
    // Nothing was started (another op or writer was running): the next tick tries again.
    write(CATCHUP_PATH, { ...marker, last_error: String(e.message || e).slice(0, 200) });
    return { action: 'wait', reason: 'busy', error: String(e.message || e) };
  }
  const lastFound = discover ? (L.at ? `；上次找岗位是 ${whenText(L.at, now)}` : '；还没找到过岗位') : '';
  event('heartbeat', 'cycle', 'start', `电脑醒了，补跑一轮轻量周期${discover ? '，带上找岗位和判断' : judge ? '，带上判断' : ''}（${slotLabel(marker, now)} 那一轮合盖跳过${lastFound}）`, { slot: marker.slot ?? null, op: op?.id ?? null, ...(judge ? { judge: true } : {}), ...(discover ? { discover: true } : {}) });
  return { action: 'started', op, judge, discover };
}
