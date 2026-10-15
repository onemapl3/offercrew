// Runs one stage of bin/cycle.mjs as a child process with a deadline.
//
// 2026-09-29: every stage runs in its own process group (spawned detached, so
// its pid is the group id) and a timeout signals the whole group: SIGTERM, then
// SIGKILL for whatever is left after STAGE_KILL_GRACE_MS. The promise settles
// once the stage has exited and nothing in its group is left; it never waits for
// pipes that something else may still hold. Before, only the stage's own pid was
// signalled (tests/stage-runner.test.mjs):
//   - what the stage had started (lark-cli, a script it ran) outlived it, and a
//     child that ignores SIGTERM stayed for good;
//   - a stage that exited on its own while such a child still held its
//     stdout/stderr kept the cycle waiting for 'close' past any deadline: the
//     watchdog's kill went to a pid that had already exited.
// A process that makes its own group (spawn detached, e.g. the discover fetch
// helper or a codex call) is out of reach here; whoever starts it ends it.
import { spawn } from './spawn.mjs';

// SIGTERM → SIGKILL for a timed-out stage's group.
export const STAGE_KILL_GRACE_MS = 5000;
// A stage has exited; how long its stdout/stderr may stay open before whatever
// still holds them (something it started) is ended the same way.
export const PIPE_DRAIN_MS = 2000;
// After SIGKILL, settle at the latest this much later, even if the stage has
// not been seen to exit (a process stuck in the kernel).
export const KILL_CONFIRM_MS = 1000;
// The most a stage can run past its timeout.
export const STAGE_OVERRUN_MS = PIPE_DRAIN_MS + STAGE_KILL_GRACE_MS + KILL_CONFIRM_MS;
const TICK_MS = 10000, POLL_MS = 100;

// Process groups of the stages still running.
const running = new Set();

// Whether anything in the group can still be signalled. macOS answers EPERM when
// the only member left is an exited, not yet reaped stage, ESRCH when none is left.
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch { return false; } // 兜底：进程组不在了就是 false
}
const signalGroup = (pgid, signal) => { try { process.kill(-pgid, signal); } catch {} }; // 兜底：进程组已经退了就不用再发信号

// For a process 'exit' handler (the cycle is being terminated): end every running
// stage group now, synchronously. SIGTERM, up to graceMs for the groups to go,
// then SIGKILL.
export function killStagesSync(graceMs = STAGE_KILL_GRACE_MS) {
  const groups = [...running];
  if (!groups.length) return;
  for (const g of groups) signalGroup(g, 'SIGTERM');
  const nap = new Int32Array(new SharedArrayBuffer(4)), until = Date.now() + graceMs;
  while (groups.some(groupAlive) && Date.now() < until) Atomics.wait(nap, 0, 0, 50);
  for (const g of groups) if (groupAlive(g)) signalGroup(g, 'SIGKILL');
}

// Resolves with the stage's stdout. Rejects with the same messages as before:
// "<script> exit <code>: <last stderr line>" or
// "<script> 超过 N 分钟/秒未结束（ETIMEDOUT），已[强制]终止".
// The deadline is wall-clock and checked at least every 10 seconds: a timer set
// before the Mac sleeps fires only after enough awake time (bin/cycle.mjs).
// `signal` (optional AbortSignal): aborting it is the deadline arriving now — same ending, same message. Without it
// nothing changes. Tests use it to end a stage once it is really up, instead of racing a short timeout against a
// loaded machine starting node.
export function execStage(args, { timeout, maxBuffer = 4 * 1024 * 1024, graceMs = STAGE_KILL_GRACE_MS, drainMs = PIPE_DRAIN_MS, signal: abort = null, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const group = child.pid, deadline = Date.now() + timeout, timers = new Set();
    if (group) running.add(group);
    let stdout = '', stderr = '', settled = false, exited = false, code = null, signal = null, forced = false, ending = null;
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const onAbort = () => { if (!exited && !ending && !settled) end(timeoutError); };
    const done = (settle) => {
      if (settled) return;
      settled = true;
      abort?.removeEventListener('abort', onAbort);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      running.delete(group);
      child.stdout?.destroy(); child.stderr?.destroy();
      settle();
    };
    // The stage's own result.
    const outcome = () => code !== 0
      ? reject(Object.assign(Error(`${args[0]} exit ${code ?? signal}${stderr.trim() ? ': ' + stderr.trim().split('\n').pop().slice(0, 200) : ''}`), { stderr, status: code }))
      : resolve(stdout);
    const timeoutError = () => reject(Object.assign(Error(`${args[0]} 超过 ${timeout >= 120000 ? Math.round(timeout / 60000) + ' 分钟' : Math.round(timeout / 1000) + ' 秒'}未结束（ETIMEDOUT），已${forced || signal === 'SIGKILL' ? '强制' : ''}终止`), { stderr, killed: true }));
    const check = () => { if (ending && exited && !groupAlive(group)) done(ending); };
    // End the whole group, then settle with `result`: once the stage has exited
    // and its group is empty, or KILL_CONFIRM_MS after SIGKILL whatever happened.
    const end = (result) => {
      if (ending || settled) return;
      ending = result;
      signalGroup(group, 'SIGTERM');
      const poll = () => { check(); if (!settled) later(poll, POLL_MS); };
      later(poll, POLL_MS);
      later(() => {
        if (groupAlive(group)) { forced = true; signalGroup(group, 'SIGKILL'); }
        later(() => done(ending), KILL_CONFIRM_MS);
      }, graceMs);
    };
    const watch = () => {
      if (exited || ending) return;
      const left = deadline - Date.now();
      if (left > 0) return later(watch, Math.min(left, TICK_MS));
      end(timeoutError);
    };
    watch();
    if (abort) { if (abort.aborted) onAbort(); else abort.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > maxBuffer) { signalGroup(group, 'SIGKILL'); done(() => reject(Object.assign(Error(`stage_output_too_large:${args[0]}`), { stderr }))); }
    });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('error', (e) => done(() => reject(Object.assign(e, { stderr }))));
    child.on('exit', (c, s) => {
      exited = true; code = c; signal = s;
      if (ending) return check();
      // Finished on its own: stdout/stderr close right after, unless something it
      // started still holds them. Then end that and keep the stage's own result.
      later(() => {
        process.stderr.write(`[cycle] ${args[0]} 已退出，但它启动的进程仍占着输出，已一并结束\n`);
        end(outcome);
      }, drainMs);
    });
    child.on('close', () => { if (ending) check(); else done(outcome); });
  });
}

// How long this process could not run, which on a laptop means the Mac slept.
// Node's clocks on macOS count sleep too (lib/run-now.mjs), but a timer cannot
// fire during sleep: a tick that comes much later than it was due says the
// process was frozen for about that long (at most one step less). Ticks later
// than `slack` count, so a busy machine is not mistaken for a sleeping one.
export function sleepMeter({ step = 1000, slack = 5000 } = {}) {
  let due = Date.now() + step, slept = 0, timer = null, stopped = false;
  const measure = () => { const late = Date.now() - due; if (late > slack) slept += late; };
  const tick = () => { measure(); due = Date.now() + step; timer = setTimeout(tick, step); timer.unref(); };
  timer = setTimeout(tick, step); timer.unref();
  return {
    stop() {
      if (!stopped) { stopped = true; clearTimeout(timer); measure(); }
      return slept;
    },
  };
}
