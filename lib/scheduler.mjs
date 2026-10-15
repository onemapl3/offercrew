// 调度器（05 第二节 2.4）：工作台里所有定时的事由这一个计时器驱动，代替以前各自的 setInterval。
//
//   register(name, { every, at, first, when, run, backoff, timeout, label })
//     every    间隔（毫秒）。
//     at       每天的钟点 ['09:05', …]（按 lib/tz.mjs 的时区）；睡过去错过的，醒来第一拍补一次。可以和 every 一起给。
//     first    第一次在多久以后跑（毫秒，默认等于 every；0 是马上）。
//     when     () => 布尔：这一拍该不该跑（后台任务关着、沙盒、成员暂停……）。false 就跳过，不算失败，下一拍再问。
//     run      ({ now, late, signal, attempt }) => 结果，可以是 async。late：这一拍比该跑的时候晚了多少毫秒（刚醒来会很大）。
//              抛错就算失败。返回 { again: 毫秒 } 是「这次没轮到，过这么久再来」（比如写锁被别人拿着），不算失败。
//     backoff  失败以后等多久再试：{ min, max }，默认 min = every（至少 1 秒），max = 10 分钟；连错一次翻一倍，成功就回到 every。
//     timeout  跑超过这么久：记一条「卡住了」，signal 发 abort。不另起一份（同名的不叠着跑），等它自己结束。
//     label    运行日志里的名字（中文，默认用 name），「<label>没做成：<原因>」。
//     reach    这一项要连的东西（「专用 Chrome」「邮箱服务器」）：连不上时原因写「连不上<reach>」，不写就是「连不上网络」。
//     explain  (error) => 一句原因或 null：这一项自己认得的错，先问它。
//
//   同名的不叠着跑：上一次还没完，这一拍跳过。
//   谁在跑、上次结果：status() 列出每一项；出错、恢复、卡住记进运行日志（state/events.ndjson，System · scheduler）。
//   一项连着出同样的错只记第一次（等它恢复记一句「好了」），不刷屏。
//   失败那一条只写人话的原因（reasonOf）；原始报错（去掉钥匙、口令）存成证据文件 runs/<日期>/scheduler-<name>-<时间>.json，挂在这一条的 refs 上。
import { event } from './events.mjs';
import { TZ } from './tz.mjs';
import { write, today } from './store.mjs';
import { errorEvidence } from './error-evidence.mjs';

const MIN = 60000;
const clip = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// 原始报错 → 一句人话的原因。顺序：这一项自己认得的（explain）→ 已经是人话的中文原样用 → 下面这张表 → 中文里夹着报错码的去掉码 → 认不出来。
const HAN = /[一-龥]{2,}/;
const RAW = /[A-Za-z]+_[A-Za-z0-9_]+|\b[A-Z][A-Z0-9]{2,}\b|Error:|\bat \S+\.m?js|https?:\/\/|\{|\}/;
const TOKEN = /\b[A-Za-z]*Error:[^，。；\n]*|\bat \S+\.m?js\S*|https?:\/\/\S+|[A-Za-z]+_[A-Za-z0-9_]+|\b[A-Z][A-Z0-9]{2,}\b/g;
const REASONS = [
  [/another_radar_writer_running|写锁/, () => '别的程序正在写数据，等它写完'],
  [/SQLITE_BUSY|database is locked/i, () => '数据库正忙'],
  [/SQLITE_CORRUPT|malformed|not a database/i, () => '数据库文件坏了'],
  [/ENOSPC|no space left/i, () => '磁盘满了'],
  [/EACCES|EPERM|permission denied/i, () => '没有权限读写数据目录里的文件'],
  [/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|socket hang up|\bsocket\b|\bTLS\b|certificate|websocket/i, t => `连不上${t.reach || '网络'}`],
  [/timeout|timed out|aborted|超时/i, () => '太久没有做完'],
  [/ENOENT|no such file/i, () => '要用的文件不见了'],
  [/Unexpected token|Unexpected end of JSON|in JSON|JSON\.parse/i, () => '有一份记录的内容坏了，读不出来'],
  [/SIGTERM|SIGKILL|SIGINT|\bkilled\b/i, () => '做事的进程被中途停掉了'],
  [/Command failed|exit(?:ed)?(?: with)?(?: code)? \d+|exit code/i, () => '做事的进程没有正常结束'],
];
export function reasonOf(error, task = {}) {
  const raw = String(error?.message ?? error ?? '').trim();
  try { const own = task.explain?.(error); if (own) return clip(own, 80); } catch {} // 兜底：任务自己的说法出错就按下面的通用规则说原因
  if (!raw) return '没有留下原因';
  if (HAN.test(raw) && !RAW.test(raw)) return clip(raw, 80);
  for (const [re, say] of REASONS) if (re.test(raw) || re.test(String(error?.code || ''))) return say(task);
  const left = raw.replace(TOKEN, '').replace(/[（(][\s:：,，]*[）)]/g, '').replace(/[\s:：,，;；]+$/, '').replace(/\s+/g, ' ').trim();
  if (HAN.test(left) && !RAW.test(left)) return clip(left, 80);
  return '原因没认出来，原文记在证据里';
}
// 原文存成证据文件（errorEvidence 去掉了钥匙、口令），返回相对路径；存不下来就不挂。
function saveEvidence(task, error, at) {
  try {
    const e = error instanceof Error ? error : Object.assign(Error(String(error)), { code: null });
    const ref = `runs/${today()}/scheduler-${task.name}-${at}.json`;
    write(ref, { task: task.name, label: task.label, at: new Date(at).toISOString(), failures: task.failures, ...errorEvidence(e), stack: String(e.stack || '').split('\n').filter(l => /^\s+at /.test(l)).slice(0, 8).join('\n') }); // 只留调用位置：第一行是报错原文，上面已经去掉钥匙记过
    return ref;
  } catch { return null; } // 兜底：证据存不下来就不挂（上面的注释），原因照样记在运行日志里
}
const hhmm = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
// (prev, now] 之间到了的钟点（最多往回看 36 小时）：有就返回最后那一个的时间。
function lastAt(at, prev, now, tz) {
  let hit = null;
  for (let t = Math.floor(Math.max(prev, now - 36 * 60 * MIN) / MIN) * MIN + MIN; t <= now; t += MIN) if (at.includes(hhmm(t, tz))) hit = t;
  return hit;
}

export function createScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = (status, msg, extra) => event('system', 'scheduler', status, msg, extra), evidence = saveEvidence, tz = TZ } = {}) {
  const tasks = new Map();
  let timer = null, stopped = false, waking = false;

  function register(name, opts = {}) {
    if (!name || typeof opts.run !== 'function') throw Error('scheduler.register 要名字和 run');
    if (tasks.has(name)) throw Error(`调度器里已经有 ${name} 了`);
    const { every = 0, at = null, when = null, run, backoff = {}, timeout = 0, label = name, reach = null, explain = null } = opts;
    if (!(every > 0) && !(Array.isArray(at) && at.length)) throw Error(`${name}：every 和 at 至少给一个`);
    const t0 = now();
    const first = opts.first ?? (every > 0 ? every : null);
    tasks.set(name, {
      name, label, every, at, when, run, timeout, reach, explain,
      backoff: { min: Math.max(1000, backoff.min ?? every ?? 1000), max: backoff.max ?? 10 * MIN },
      due: first == null ? Infinity : t0 + first, atPrev: t0,
      running: null, runs: 0, failures: 0, last: null, logged: null, stuck: false,
    });
    arm();
    return () => unregister(name);
  }
  function unregister(name) { tasks.delete(name); arm(); }

  // 下一次该醒的时候：最早到期的那一项；有按钟点的，最多一分钟醒一次看钟。
  function arm() {
    if (stopped || waking) return;
    if (timer) { clearTimer(timer); timer = null; }
    if (!tasks.size) return;
    let next = Infinity;
    for (const t of tasks.values()) { next = Math.min(next, t.due); if (t.at) next = Math.min(next, now() + MIN - (now() % MIN) + 50); }
    if (next === Infinity) return;
    timer = setTimer(wake, Math.max(20, next - now()));
    timer?.unref?.();
  }

  function wake() {
    timer = null;
    waking = true;
    try {
      const t = now();
      for (const task of [...tasks.values()]) {
        let late = null;
        if (task.due <= t) late = t - task.due;
        if (task.at) { const hit = lastAt(task.at, task.atPrev, t, tz); task.atPrev = t; if (hit != null && late == null) late = t - hit; }
        if (late == null) continue;
        if (task.running) { task.due = t + (task.every || MIN); continue; }   // 上一次还没完：不叠着跑
        let go = true;
        if (task.when) { try { go = !!task.when(); } catch (e) { go = false; note(task, 'fail', e); } }
        if (!go) { task.due = task.every ? t + task.every : Infinity; continue; }
        start(task, t, late);
      }
    } finally { waking = false; arm(); }
  }

  function start(task, t, late) {
    const ctl = new AbortController(), attempt = task.failures + 1;
    task.running = { since: t, ctl };
    task.due = Infinity;
    let killer = null;
    if (task.timeout > 0) {
      killer = setTimer(() => {
        if (!task.running) return;
        task.stuck = true;
        ctl.abort(Error('timeout'));
        // 连着几次都超时只记第一次；哪一次按时跑完了记一句「好了」。
        if (task.logged !== 'stuck') { task.logged = 'stuck'; log('fail', `${task.label}跑了 ${Math.round((now() - task.running.since) / 1000)} 秒还没完，等它自己结束再排下一次`, { task: task.name }); }
      }, task.timeout);
      killer?.unref?.();
    }
    let p;
    try { p = Promise.resolve(task.run({ now: t, late, signal: ctl.signal, attempt })); } catch (e) { p = Promise.reject(e); }
    p.then(value => finish(task, t, killer, null, value), e => finish(task, t, killer, e));
  }

  function finish(task, t, killer, error, value) {
    if (killer) clearTimer(killer);
    const end = now();
    task.running = null; task.runs++;
    const ms = end - t;
    if (!tasks.has(task.name)) return;   // 跑的时候被注销了
    if (error) {
      task.stuck = false;
      task.failures++;
      task.last = { ok: false, at: new Date(end).toISOString(), ms, error: clip(error?.message || error) };
      const wait = Math.min(task.backoff.max, task.backoff.min * 2 ** (task.failures - 1));
      task.due = end + wait;
      note(task, 'fail', error, wait);
    } else {
      const wasStuck = task.stuck;
      task.stuck = false;
      if (!(wasStuck && task.logged === 'stuck')) {
        if (task.logged) log('ok', `${task.label}好了${task.failures > 1 ? `（之前连着 ${task.failures} 次没成）` : ''}`, { task: task.name });
        task.logged = null;
      }
      task.failures = 0;
      task.last = { ok: true, at: new Date(end).toISOString(), ms, ...(summary(value) ? { result: summary(value) } : {}) };
      const again = Number(value?.again);
      task.due = again > 0 ? end + again : task.every ? end + task.every : Infinity;
    }
    arm();
  }

  // 出错记一条；同样的错只记第一次。
  function note(task, _status, error, wait) {
    const msg = clip(error?.message || error, 120);
    if (task.logged === msg) return;
    task.logged = msg;
    const ref = evidence(task, error, now());
    log('fail', `${task.label}没做成：${reasonOf(error, task)}${wait ? `。${wait >= MIN ? `${Math.round(wait / MIN)} 分钟` : `${Math.max(1, Math.round(wait / 1000))} 秒`}后再试` : ''}`, { task: task.name, refs: ref ? [{ file: ref }] : [] });
  }

  function status() {
    const t = now();
    return [...tasks.values()].map(x => ({
      name: x.name, label: x.label,
      running: x.running ? { since: new Date(x.running.since).toISOString(), s: Math.round((t - x.running.since) / 1000), stuck: x.stuck } : null,
      last: x.last, failures: x.failures, runs: x.runs,
      next: x.due === Infinity ? null : new Date(x.due).toISOString(),
    }));
  }
  const running = name => !!tasks.get(name)?.running;
  // 马上跑一次（不等下一拍）：比如写库以后要尽快推；正在跑的不叠。
  function kick(name) { const x = tasks.get(name); if (!x || x.running) return false; x.due = now(); arm(); return true; }
  function stop() { stopped = true; if (timer) clearTimer(timer); timer = null; for (const x of tasks.values()) x.running?.ctl.abort(Error('stopped')); }

  return { register, unregister, status, running, kick, stop, wake };
}

// 结果里只留一句短的（计数、状态），完整的结果不进状态。
function summary(v) {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v !== 'object') return clip(v, 60);
  const keep = Object.entries(v).filter(([, x]) => typeof x === 'number' || (typeof x === 'string' && x.length <= 40)).slice(0, 4);
  return keep.length ? Object.fromEntries(keep) : null;
}

// 工作台用的那一个。
export const scheduler = createScheduler();
export const register = (name, opts) => scheduler.register(name, opts);
