// 登录状态系统自己去看，不等你回来报告。
//
// 以前的问题：用户明明已经登录（浏览器里的登录 cookie 都是新的），系统的记录却停在几天前的"未登录"，
// 反反复复来要人登录——只有点收件箱那封信上的「我登好了」才会更新记录，在别处登录系统永远不知道。
//
// 专用 Chrome 只有一份登录档案，ego 的所有任务空间也共用一份 cookie，所以你在任何一个标签页里登录，
// 系统新开的检查页都看得到。现在：
//   - 有登录信在等、并且配了检查方法（config/accounts.json 的 probe）的账号：每 10 分钟看一次；
//   - 你刚点过「打开登录页」的账号：接下来 10 分钟每 20 秒看一次；
//   - 看到已登录：和你点「我登好了」完全一样（记下登录、让挂着的任务继续、放行压着的私信），信自动消失；
//   - 登录记录已经比任务停下来的时间新、任务却还停着的（resumable）：直接让它继续；
//   - 同一个账号 6 小时内自动继续了 3 次还在喊要登录：不再自动继续，信里写明"看到你已登录，
//     但任务还是说要登录"（多半是平台要再验证一次），交给你看。
// 夜里（免打扰时段）只看你刚点过的账号，不做定时检查。
// 检查本身在 lib/login-probe.mjs（专用 Chrome 或 ego）。它说「登录页还开着」（你还在登录）的这一轮不记结果，
// 20 秒后再看；说「网站要先验证」的，这个账号歇一阵再看（平时一小时，你正在登录时两分钟）——不去反复敲一个
// 已经拦下来的网站，验证由你来做。
import { read, write } from './store.mjs';
import { event } from './events.mjs';
import { loadAccounts } from './accounts.mjs';

export const WATCH_PATH = 'state/login-watch.json';
// 你刚点过「打开登录页」的账号：每 5 秒看一次、看 15 分钟（第 6b 轮负责人：登好了 App 要几秒内自己知道，不用回来点「我登好了」）。
// 登录页还开着的那几秒不去开检查页（lib/login-probe.mjs stillLoggingIn），所以看得勤也不多打扰网站。
export const EVERY_MS = 10 * 60000, FOCUS_EVERY_MS = 5000, FOCUS_FOR_MS = 15 * 60000;
const LOOP_WINDOW_MS = 6 * 3600000, LOOP_MAX = 3;
// 网站拦下来要验证时歇多久：平时一小时；你刚点过「打开登录页」（多半正在页面上做验证）两分钟。
const BLOCKED_REST_MS = 3600000, BLOCKED_FOCUS_REST_MS = 2 * 60000;
const focus = new Map(); // 账号 → 盯到什么时候（内存里，重启就清掉，无妨）

const recent = (list = [], now) => list.filter(t => now - Date.parse(t) < LOOP_WINDOW_MS);
// stuck 随时间自己解除：6 小时窗口里的自动继续少于 3 次就不算卡住。
export function loginWatchState(now = Date.now()) {
  const st = read(WATCH_PATH, {});
  for (const v of Object.values(st)) if (v && typeof v === 'object') v.stuck = recent(v.auto, now).length >= LOOP_MAX;
  return st;
}
// 你自己点了「我登好了」：自动继续的次数清零（你看过了，再给它机会）。
export function resetLoginWatch(key) {
  const st = read(WATCH_PATH, {});
  if (!st[key]) return;
  st[key] = { ...st[key], auto: [], stuck: false };
  write(WATCH_PATH, st);
}
export function focusLogin(key, { now = Date.now(), ms = FOCUS_FOR_MS } = {}) { if (key) focus.set(String(key), now + ms); }
export const focused = (key, now = Date.now()) => (focus.get(key) || 0) > now;
// 有没有账号正在被盯着：工作台按它决定 5 秒还是 20 秒跑一轮（bin/serve.mjs loginTick）。
export const watchingAny = (now = Date.now()) => [...focus.values()].some(t => t > now);

// 这一轮该看哪些账号。
export function dueAccounts(asks = [], state = {}, { now = Date.now(), quiet = false } = {}) {
  const due = [];
  for (const a of asks) {
    if (a.type !== 'login' || !a.account?.probe || a.account?.checked?.stuck) continue;
    const k = a.account.key, f = focused(k, now), last = Date.parse(state[k]?.checked_at || '') || 0;
    if (quiet && !f) continue;
    if (now - (Date.parse(state[k]?.blocked_at || '') || 0) < (f ? BLOCKED_FOCUS_REST_MS : BLOCKED_REST_MS)) continue;
    if (now - last >= (f ? FOCUS_EVERY_MS : EVERY_MS)) due.push(k);
  }
  return due;
}

// 跑一轮。probeMany(keys) → { key: { checked, logged_in, reason, url } }；
// ready(step, now, { probe, by }) 就是「我登好了」那一段（lib/ask-actions.mjs accountReady）；
// resume(item, now) 让一个登录已确认、却还停着的任务 / 投递继续。
export async function tickLoginWatch({ asks: given = [], resumable = [], now = Date.now(), quiet = false, probeMany, ready, resume, cfg = null } = {}) {
  const state = loginWatchState(now), done = [];
  // 你在设置里直接点了「打开登录页」、没有登录信在等的账号：这 10 分钟照样看，登好了就记下（和「我登好了」同一段）。
  const asks = [...given];
  for (const [k, until] of focus) {
    if (until <= now || asks.some(a => a.type === 'login' && a.account?.key === k)) continue;
    const fam = (cfg || loadAccounts()).families?.[k.split(':')[0]];
    if (!fam?.probe) continue;
    asks.push({ id: `login:${k}`, type: 'login', account: { key: k, label: fam.label || k, probe: true }, options: [{ key: '1', steps: [{ type: 'account_ready', account: k, hosts: [], jobs: [], superseded: [] }] }] });
  }
  const allow = k => recent(state[k]?.auto, now).length < LOOP_MAX;
  const note = (k, patch) => { state[k] = { ...(state[k] || {}), ...patch }; };
  const bump = k => {
    const auto = [...recent(state[k]?.auto, now), new Date(now).toISOString()];
    note(k, { auto, stuck: auto.length >= LOOP_MAX });
  };

  // 1) 登录已经确认过、任务还停着：让它继续（按账号限次）。
  if (!quiet && resume) {
    for (const item of resumable) {
      const keys = item.families || [];
      if (!keys.length || !keys.every(allow)) continue;
      try { await resume(item, now); keys.forEach(bump); done.push({ kind: 'resumed', keys, item: item.job_id || item.record_id }); }
      catch (e) { done.push({ kind: 'resume_failed', keys, error: String(e.message || e).slice(0, 160) }); }
    }
  }

  // 2) 还在等登录的账号：去浏览器里看一眼。
  const due = dueAccounts(asks, state, { now, quiet });
  if (due.length && probeMany) {
    let results = {};
    try { results = await probeMany(due); }
    catch (e) { for (const k of due) note(k, { checked_at: new Date(now).toISOString(), logged_in: null, reason: `没能检查（${String(e.message || e).replace(/^(ego_browser_failed|chrome_[a-z_]+|cdp_[a-z_]+)[:：]\s*/, '').split('\n')[0].slice(0, 80)}）` }); }
    for (const k of due) {
      const v = results[k];
      if (!v || v.skipped) continue;
      note(k, { checked_at: new Date(now).toISOString(), logged_in: v.checked ? v.logged_in : null, reason: v.checked ? (v.logged_in ? '已登录' : v.reason) : v.error || '没能检查',
        ...(v.blocked ? { blocked_at: new Date(now).toISOString(), blocked_url: v.url || null } : state[k]?.blocked_at ? { blocked_at: null, blocked_url: null } : {}) });
      if (!(v.checked && v.logged_in)) continue;
      const ask = asks.find(a => a.type === 'login' && a.account?.key === k);
      const step = ask?.options?.flatMap(o => o.steps || []).find(s => s.type === 'account_ready');
      if (!step) continue;
      if (!allow(k)) { note(k, { stuck: true }); continue; }
      try {
        const receipt = await ready(step, now, { probe: async () => v, by: 'login_watch' });
        bump(k); focus.delete(k);
        done.push({ kind: 'logged_in', keys: [k], label: ask.account.label || k, receipt });
        event('system', 'login-watch', 'ok', `检测到 ${ask.account.label} 已登录：${receipt}`);
      } catch (e) { done.push({ kind: 'ready_failed', keys: [k], error: String(e.message || e).slice(0, 160) }); }
    }
  }
  if (done.length || due.length) write(WATCH_PATH, state);
  return { due, done, changed: done.some(d => ['resumed', 'logged_in'].includes(d.kind)) };
}
