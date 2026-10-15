// The immediate executor, debounced.
//
// A command that needs a model or a browser used to wait for the 09/13/18 Codex
// run. Now the resident service raises one `codex exec` for it — but not one per
// message: a request parks in state/run-now.json and only fires once 60 seconds
// have passed with nothing new arriving, so `投 118`, `投 121` and a sentence
// typed in the same minute become a single run (plans/20260915-command-room.md §四).
import { execFileSync } from './spawn.mjs';
import fs from 'node:fs';
import { read, write, lines, file } from './store.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { event } from './events.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';
import { localAiGate, heldText } from './capabilities.mjs';
import { factsBlocker } from './facts-gate.mjs';

export const STATE_PATH = 'state/run-now.json';
export const DEBOUNCE_MS = 60000;
// Live overdue wrappers are terminated before releasing the queue.
export const STALE_RUN_MS = 30 * 60000;
const MAX_REASONS = 20;
// An instruction is tried this many times across failed / interrupted runs, then
// dropped from the queue into `failed` with an explicit failure note (2026-09-23:
// the old shared retry_count was reset by every new request, so a failing
// instruction was retried for ever).
export const MAX_ATTEMPTS = 3;
const bump = (q = []) => q.map(r => ({ ...r, attempts: (r.attempts || 0) + 1 }));
function settle(current, requeue, error, now) {
  const keep = requeue.filter(r => (r.attempts || 0) < MAX_ATTEMPTS), dropped = requeue.filter(r => (r.attempts || 0) >= MAX_ATTEMPTS);
  const at = new Date(now).toISOString();
  if (dropped.length) {
    event('system', 'run-now', 'fail', `即时执行器连续 ${MAX_ATTEMPTS} 次没有完成，已停止重试 ${dropped.length} 条指令：${dropped.map(r => r.reason).join(' / ').slice(0, 160)}（${String(error || '').slice(0, 80)}）`);
    // Web threads get the failure as their reply; Feishu threads are listed in `failed` for the concierge.
    for (const r of dropped.filter(r => r.thread?.channel === 'web' && r.thread.session_id))
      fs.appendFileSync(file('state/web-replies.ndjson'), JSON.stringify({ session_id: r.thread.session_id, message_id: r.thread.message_id, persona: r.thread.persona || 'system', text: `这条指令连续 ${MAX_ATTEMPTS} 次执行失败，已停止自动重试：${String(error || '原因见运行日志').slice(0, 160)}。需要的话请重新下达。`, at }) + '\n');
  }
  return { reasons: [...keep, ...(current.reasons || [])].slice(-MAX_REASONS), failed: [...(current.failed || []), ...dropped.map(r => ({ ...r, failed_at: at, last_error: String(error || '').slice(0, 200) }))].slice(-MAX_REASONS), kept: keep.length };
}
// Wall-clock time minus monotonic progress between two checks is time the Mac
// slept. Only the awake time of a run counts toward STALE_RUN_MS; before, a run
// was killed right after wake.
// But Node's performance.now() on this macOS (node 25 / libuv 1.52) is
// mach_continuous_time and keeps running in sleep (hrtime = wall time since boot
// across sleeps), so that difference stays 0. The service checks every `tick`
// ms; a check that arrives long after the previous one means the Mac slept in
// between (2026-09-23: runs started in 2-second DarkWakes were
// SIGTERMed as "over 30 minutes" after ~10 awake seconds).
export const RUN_NOW_TICK_MS = 5000;
const TICK_SLACK_MS = 60000;
const clocks = new Map();
function sleptSince(path, now, mono, tick = 0) {
  if (mono == null) return 0;
  const prev = clocks.get(path); clocks.set(path, { now, mono });
  if (!prev) return 0;
  const wall = now - prev.now, awake = mono - prev.mono;
  const late = tick && awake > tick + TICK_SLACK_MS ? awake - tick : 0;
  const gap = Math.max(wall - awake, 0) + late;
  return gap > 30000 ? gap : 0;
}

export function requestRunNow({ reason, thread = null, job_ids = null, now = Date.now(), path = STATE_PATH } = {}) {
  if (job_ids !== null && (!Array.isArray(job_ids) || !job_ids.length || job_ids.some(id => typeof id !== 'string' || !id.trim()))) throw Error('invalid_run_now_job_ids');
  // 演示 / 沙盒模式：请求照常排进队列（页面上是"排队中"），但工作台不会拉起执行器（bin/serve.mjs），这里记一行（lib/sandbox.mjs）。
  if (sandboxed()) sandboxSkip(`即时执行器（Codex / Claude）：${String(reason || '指令').slice(0, 120)}`, { actor: 'system' });
  const state = read(path, {});
  const reasons = [...(state.reasons || []), { reason: String(reason || '指令'), at: new Date(now).toISOString(), ...(thread ? { thread } : {}), ...(job_ids ? { job_ids: [...new Set(job_ids)] } : {}) }].slice(-MAX_REASONS);
  const next = { ...state, reasons, requested_at: new Date(now).toISOString(), pending: true, retry_after: null };
  write(path, next);
  return next;
}

// 桌面版本机 AI 没打开（lib/capabilities.mjs localAiGate）：到点了也不拉起，排着的留在队列里，打开后接着做。
// 每一批只记一条事件（又排进新的，requested_at 变了，才再记）；text 是 heldText() 那一句。返回这次记没记。
export function holdRunNow(text, { now = Date.now(), path = STATE_PATH } = {}) {
  const state = read(path, {});
  if (!runNowDue(state, now) || state.held === state.requested_at) return false;
  write(path, { ...state, held: state.requested_at });
  event('system', 'run-now', 'skip', `${text}（排着 ${(state.reasons || []).length} 件事）`);
  return true;
}

// 即时执行器这一拍（bin/serve.mjs 每 5 秒）能不能拉起 bin/host/run-now.sh：桌面版只认 lib/capabilities.mjs 那一道。
// 不能：不拉起，排着的留在队列里（holdRunNow 每批记一条），返回 null；能：返回给 spawn 的选项，桌面版带上 App 自己的账号和受限运行的变量。
export function runNowLaunch({ root, gate = localAiGate({ root }), now = Date.now(), path = STATE_PATH } = {}) {
  if (!gate.allowed) { holdRunNow(heldText(gate), { now, path }); return null; }
  // 资料挡住了（lib/facts-gate.mjs）：一样不拉起、队列留着，修好以后接着做（每批记一条，说法就是横条那句）。
  // 不然 run-now.sh 以 78 退出：每条指令白算一次失败、飞书话题里说一次「没跑完」，三次就丢了。
  // 只在到点时看（工作台每 5 秒问一次 runNowLaunch）。
  const facts = runNowDue(read(path, {}), now) && factsBlocker();
  if (facts) { holdRunNow(facts.text, { now, path }); return null; }
  return { cwd: root, detached: true, stdio: 'ignore', ...(gate.env ? { env: { ...process.env, ...gate.env } } : {}) };
}

export function runNowDue(state = {}, now = Date.now(), { delayMs = DEBOUNCE_MS } = {}) {
  if (!state.pending || !state.requested_at) return false;
  if (state.running) return false;
  if (state.retry_after && now < Date.parse(state.retry_after)) return false;
  return now - Date.parse(state.requested_at) >= delayMs;
}

// Called on a timer by bin/serve.mjs. `spawn(state)` starts the executor and
// resolves when it exits; nothing here ever runs codex directly, so tests pass a
// fixture and assert the debounce instead of launching a model.
function requestedJobs(queue = [], jobs = []) {
  // Legacy/free-text requests retain the full pending-job check. Explicit host
  // requests must not be retried because an unrelated background job is pending.
  const ids = queue.flatMap(r => r.job_ids || []);
  if (!queue.length || queue.some(r => !r.job_ids?.length)) ids.push(...jobs.filter(j => ['pending', 'working'].includes(j.status)).map(j => j.id));
  return [...new Set(ids)];
}
function hasUnfinishedJobs(ids = []) {
  const jobs = lines('state/host-jobs.ndjson');
  return ids.some(id => {
    const job = jobs.findLast(j => j.id === id);
    return !job || ['pending', 'working'].includes(job.status);
  });
}
// 本机 AI 为什么停下（负责人 10-10 第 7 条：超时以后照实说）。退出码来自 bin/host/run-now.sh 的看门狗：
//   124 跑满了时间预算（config/host.json timeout_minutes，默认 25 分钟），125 太久没有任何输出（idle_minutes，默认 8 分钟），
//   127 找不到程序；overdue 是工作台按 30 分钟（STALE_RUN_MS，只算醒着的时间）终止的（reconcileRunNow），退出码多半是 143 / 137。
// 以前一律写「本机 AI 退出码 124」，30 分钟终止的还写成「工作台重启期间结束」。
// 只接当前进程本次运行的结果；旧 403 不能盖住后来成功或另一轮的退出。
export function runtimeFailure(state, code) {
  const last = read('state/local-ai-attempts.json', {}).last;
  if (!last || !Number.isFinite(Date.parse(state.running_since)) || !Number.isFinite(Date.parse(last.at)) || last.ok || last.code !== code || last.pid !== state.pid || Date.parse(last.at) < Date.parse(state.running_since || '')) return null;
  return [last.reason, last.remedy].filter(Boolean).join('；');
}
export function exitWords(code, { overdue = false, signal = null, host = null } = {}) {
  const c = host || read('config/host.json', {}) || {}, min = (v, d) => (Number(v) > 0 ? Number(v) : d);
  if (overdue) return `本机 AI 跑了 ${STALE_RUN_MS / 60000} 分钟还没结束，停下了；没做完的指令下一轮重试`;
  if (code === 124) return `本机 AI 跑满 ${min(c.timeout_minutes, 25)} 分钟没做完，停下了；没做完的指令下一轮重试`;
  if (code === 125) return `本机 AI 连续 ${min(c.idle_minutes, 8)} 分钟没有任何进展，停下了；没做完的指令下一轮重试`;
  if (code === 127) return '找不到本机 AI 的程序（Claude Code / Codex 没装好或不在路径里）';
  if (code === 143 || code === 137 || /signal/.test(String(signal || ''))) return '本机 AI 被中途终止了（工作台退出、重启或被手动停下）；没做完的指令下一轮重试';
  return `本机 AI 出错退出（退出码 ${code}）`;
}
export function tickRunNow({ now = Date.now(), spawn, delayMs = DEBOUNCE_MS, path = STATE_PATH } = {}) {
  const state = read(path, {});
  if (!runNowDue(state, now, { delayMs })) return null;
  const started = { ...state, run_id: randomUUID(), job_ids: requestedJobs(state.reasons, lines('state/host-jobs.ndjson')), reasons: [], pending: false, running: true, running_since: new Date(now).toISOString(), slept_ms: 0, last_run_at: new Date(now).toISOString(), queue: state.reasons || [] };
  write(path, started);
  const finish = result => {
    const current = read(path, {});
    if (current.run_id !== started.run_id) return; // A late exit cannot finish another run.
    let code = result?.code ?? 0;
    const unfinished = code === 0 && hasUnfinishedJobs(started.job_ids);
    if (unfinished) code = 1;
    const retry = code !== 0;
    const error = runtimeFailure(current, code) || (code === 75 ? '本机 AI 仍被上一轮占用，等待重试' : unfinished ? '本机 AI 退出了，但任务没有完成回执' : code ? (/^exit \d+$|^signal /.test(result?.error || 'exit') ? exitWords(code, { overdue: !!current.overdue, signal: result?.error }) : result.error) : null);
    // A busy lock (75) is not an attempt; every other failure counts per instruction.
    const q = retry ? settle(current, code === 75 ? started.queue : bump(started.queue), error, Date.now()) : { reasons: current.reasons || [], failed: current.failed, kept: 0 };
    write(path, { ...current, running: false, running_since: null, pid: null, overdue: false, termination_at: null,
      last_exit: code, last_error: error, last_finished_at: new Date().toISOString(), reasons: q.reasons, ...(q.failed ? { failed: q.failed } : {}),
      pending: !!current.pending || q.kept > 0, retry_count: retry ? Math.max(0, ...q.reasons.map(r => r.attempts || 0)) : 0,
      retry_after: retry ? new Date(Date.now() + DEBOUNCE_MS).toISOString() : null });
  };
  try {
    const p = spawn(started);
    if (p && typeof p.then === 'function') p.then(finish, e => finish({ code: 1, error: String(e.message || e).slice(0, 200) }));
    else finish({ code: 0 });
  } catch (e) {
    finish({ code: 1, error: String(e.message || e).slice(0, 200) });
  }
  return started;
}

// The workbench restarted (or died) while an executor was in flight: the
// `finish` callback above never ran, so `running` stays true and the heartbeat
// row stays "working" forever (seen after a 2026-09-21 restart). On start-up and on
// every tick the service checks whether a `run-now-prompt` process still
// exists; if not, the run is closed as interrupted and the queue moves on.
// `alive` is injectable so tests never call pgrep.
export function reconcileRunNow({ now, mono = null, tick = 0, alive = executorAlive, path = STATE_PATH, exitPath = EXIT_PATH, stop = stopExecutor } = {}) {
  // The service calls this without `now`: real time, with sleep accounting.
  if (now === undefined) { now = Date.now(); mono ??= performance.now(); tick ||= RUN_NOW_TICK_MS; }
  let state = read(path, {});
  if (!state.running) {
    // Recover the old bug: the UI was cleared while its wrapper still owned the lock.
    if (path !== STATE_PATH) return null;
    let pid; try { pid = Number(fs.readFileSync(file('state/run-now.pid'), 'utf8').trim()); } catch {}
    if (!wrapperIdentity(pid)) return null;
    state = { ...state, running: true, pid, running_since: new Date(fs.statSync(file('state/run-now.pid')).mtimeMs).toISOString(), job_ids: state.job_ids ?? requestedJobs(state.queue, lines('state/host-jobs.ndjson')) };
    write(path, state);
  }
  const slept = sleptSince(path, now, mono, tick);
  if (slept && state.running) { state = { ...state, slept_ms: (state.slept_ms || 0) + slept }; write(path, state); }
  const stale = now - Date.parse(state.running_since || 0) - (state.slept_ms || 0) >= STALE_RUN_MS;
  // 优先看记录里的包装进程 pid（bin/host/run-now.sh）；老记录没有 pid 才退回 pgrep。
  const isAlive = state.pid ? pidAlive(state.pid) : alive();
  if (isAlive) {
    if (!stale) return null;
    if (!state.overdue) {
      const evidence = `runs/${new Date(now).toISOString().slice(0,10).replaceAll('-', '')}/run-now/timeout-${now}.json`;
      write(evidence, {at:new Date(now).toISOString(),run_id:state.run_id,pid:state.pid,started_at:state.running_since,job_ids:state.job_ids,heartbeat:read('state/executor-heartbeat.json', {}),reason:'executor_timeout', note:'终止前保存现场；进程退出原因不代表上游停滞根因'});
      state = {...state,timeout_evidence:evidence};
    }
    const signalled = state.pid && stop(state.pid, state.termination_at && now - Date.parse(state.termination_at) >= 10000 ? 'SIGKILL' : 'SIGTERM');
    write(path, { ...state, overdue: true, ...(signalled ? { termination_at: state.termination_at || new Date(now).toISOString() } : {}), last_error: `本机 AI 跑了 ${STALE_RUN_MS / 60000} 分钟还没结束，正在停下；停下以后没做完的指令下一轮重试` });
    if (state.overdue) return null;
    return { since: state.running_since, queue: state.queue || [], reason: `本机 AI 跑了 ${STALE_RUN_MS / 60000} 分钟还没结束，正在停下`, still_running: true };
  }
  // 工作台重启期间执行器可能自己正常跑完了（2026-09-21：exit 0 却被记成"进程已不在"，
  // System 白排了一次修复）。包装脚本退出时把退出码写进 exitPath，pid 对得上就按真实退出码收尾。
  const exited = !isAlive ? normalExit(state, exitPath) : null;
  if (exited) {
    const unfinished = hasUnfinishedJobs(state.job_ids);
    if (unfinished && exited.code === 0) exited.code = 1;
    const retry = exited.code !== 0;
    const error = runtimeFailure(state, exited.code) || (exited.code === 0 ? null : unfinished ? '本机 AI 退出了，但任务没有完成回执' : exitWords(exited.code, { overdue: !!state.overdue }));
    const q = retry ? settle(state, bump(state.queue), error, now) : { reasons: state.reasons || [], failed: state.failed, kept: 0 };
    const closed = { ...state, running: false, running_since: null, pid: null, overdue: false, termination_at: null, pending: !!state.pending || q.kept > 0, reasons: q.reasons, ...(q.failed ? { failed: q.failed } : {}), ...(retry ? { requested_at: new Date(now).toISOString() } : {}), last_exit: exited.code, last_error: error, last_finished_at: exited.at };
    write(path, closed);
    return { since: state.running_since || null, queue: state.queue || [], reason: exited.code === 0 ? '本机 AI 已正常结束' : closed.last_error, interrupted: false, exit: exited.code };
  }
  const error = stale && isAlive ? '本机 AI 超过 30 分钟仍在运行，记录已放开' : '本机 AI 进程已不在（工作台重启或被杀），本轮按中断处理';
  const q = settle(state, bump(state.queue), error, now);
  const closed = { ...state, pending: !!state.pending || q.kept > 0, reasons: q.reasons, failed: q.failed, requested_at: new Date(now).toISOString(), overdue: false, termination_at: null, running: false, running_since: null, pid: null, last_exit: 1, last_error: error, last_finished_at: new Date(now).toISOString() };
  write(path, closed);
  return { since: state.running_since || null, queue: state.queue || [], reason: closed.last_error, interrupted: true, exit: 1 };
}
// bin/host/run-now.sh 的 EXIT trap 写的 {pid, code, at}；只认同一个 pid、且晚于本轮拉起时间的记录。
export const EXIT_PATH = 'state/run-now-exit.json';
function normalExit(state, exitPath) {
  const rec = read(exitPath, null);
  if (!rec || !state.pid || Number(rec.pid) !== Number(state.pid)) return null;
  const at = Date.parse(rec.at || 0);
  if (!(at >= Date.parse(state.running_since || 0))) return null;
  return { code: Number.isInteger(Number(rec.code)) ? Number(rec.code) : 1, at: new Date(at).toISOString() };
}
export function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// 拉起后把包装进程的 pid 记进状态文件，reconcile 用它判断执行器是否还活着。
export function notePid(pid, path = STATE_PATH) {
  const state = read(path, {});
  if (state.running) write(path, { ...state, pid });
}
// 兜底：老记录没有 pid 时用进程名判断；`claude -p` 的参数是提示词正文、`codex exec` 从 stdin 读，
// 所以这个匹配只能靠 bin/host/run-now.sh 自己的命令行。
export function executorAlive() {
  try { return execFileSync('pgrep', ['-f', 'bin/host/run-now.sh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { return false; }
}

// Only our detached wrapper's own process group may be terminated.
function wrapperIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { const output = execFileSync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8' }).trim(); const match = output.match(/^(\d+)\s+(.+)$/); return Number(match?.[1]) === pid && /^(?:\/bin\/)?zsh bin\/host\/run-now\.sh$/.test(match?.[2] || ''); } catch { return false; }
}
export function stopExecutor(pid, signal = 'SIGTERM') {
  if (!wrapperIdentity(Number(pid))) return false;
  try { process.kill(-Number(pid), signal); return true; } catch { return false; }
}
