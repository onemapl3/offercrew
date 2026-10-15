// 按网站排队：判断取岗位详情（bin/judge-leads.mjs）、旧匹配取详情（bin/match.mjs）、扫描读来源（bin/discover.mjs），
// 同一个网站同时最多 2 路，robots.txt 写了 Crawl-delay 的，两次请求的开始时间至少隔这么久。不同网站之间照旧并行。
//
// 2026-10-02 三人试跑：判断 6 路并发取详情，大易、Moka、德勤这些站会被 6 路同时打；以前只有 Oleeo 在适配器里
// 按它的 Crawl-delay: 10 自己排队。现在它也用这里（lib/ats/oleeo.mjs 的 crawl 是它的下限，仍是 10 秒）。
//
// 用法：politely(fn, { max, robots, min_ms }) 里发出的每一跳请求（lib/ats/http.mjs request）都按「网站」（主机名）
// 排队；不在 politely() 里的请求不受影响。politely() 可以套：取最小的 max、最大的 min_ms，robots 有一层要读就读。
//   max     同一网站同时最多几路（不写不限）
//   robots  读这个网站的 robots.txt，照它的 Crawl-delay（每个网站一轮只读一次，缓存在进程里）
//   min_ms  不管 robots.txt 怎么写，两次请求至少隔这么久（Oleeo 的 10 秒）
//
// robots.txt 不存在（4xx）就是没有间隔要求；读不到（5xx、超时、连不上）也只按「最多几路」来，不卡住判断。
//
// Crawl-delay 超过 60 秒的网站跨轮隔开，一轮里不干等：每个网站上一次请求的时间记在 state/site-visits.json
// （按主机，store 的原子写，private/visits.lock 管着几个进程同时改）。离上次已经够久，这一轮给第一个来要的
// politely()（一条线索的详情、一个扫描来源）放行，它的几跳请求（跳转、分页）都照常发，发完记下时间；同一轮里别的、
// 或者还没到间隔的，都抛 CrawlDelayTooLong，调用的一方原样留到下一轮，不算失败。Crawl-delay 3600 的网站一天三轮
// 能取 3 条。60 秒以内的照常在一轮里按间隔排队。
// 读到什么、跳过了哪些都记在 robotsReport() 里，那一轮的日志带上它。
//
// 扫描每个来源在子进程里读（lib/discovery-source.mjs fetchSource）：在 politely() 里调用时，子进程的每一跳请求
// 都经 IPC 回到这里排队（gateThroughParent / parentGate），所以几个来源同时读同一个网站也照样最多 2 路、照样隔开。
//
// siteQueue() 按网站分队列：几路并发从里面领活时，先领现在就能开始的网站，等某个网站名额的时候去做别的网站。
import { AsyncLocalStorage } from 'node:async_hooks';
import { useGate } from './http.mjs';
import { fetchRobots, crawlDelay } from './robots.mjs';

export const MAX_PER_SITE = 2;
// robots.txt 要求两次请求隔得比这还久（秒）的网站，这一轮不取。
export const MAX_CRAWL_DELAY_S = 60;
// 时间和读 robots.txt 的办法都能换（测试用可控的时间和假的 robots.txt）。signal 中止时提前放掉计时器。
export const clock = {
  now: () => Date.now(),
  sleep: (ms, { unref = false, signal } = {}) => new Promise((resolve) => {
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    if (unref) t.unref?.();
    if (signal?.aborted) done(); else signal?.addEventListener('abort', done, { once: true });
  }),
};

// reason：not_due（离这个网站上次请求还不够久，next_at 是什么时候够）、taken（这一轮已经给了别的线索 / 来源）、
// visits_unavailable（上次请求的时间读写不了，宁可这轮不取）。
export class CrawlDelayTooLong extends Error {
  constructor(host, seconds, { reason = 'not_due', next_at = null } = {}) {
    super(`crawl_delay_over_cap: ${host} asks ${seconds}s between requests (cap ${MAX_CRAWL_DELAY_S}s; ${reason}${next_at ? ` until ${next_at}` : ''})`);
    Object.assign(this, { code: 'crawl_delay_over_cap', host, crawl_delay: seconds, reason, ...(next_at ? { next_at } : {}) });
  }
}
// 这个错误是不是「Crawl-delay 超过上限」：是就给 { host, crawl_delay }（适配器只转了消息也认得出），不是给 null。
export function tooSlow(e) {
  if (e?.code === 'crawl_delay_over_cap') return { host: e.host, crawl_delay: e.crawl_delay };
  const m = String(e?.message || '').match(/crawl_delay_over_cap: (\S+) asks ([\d.]+)s/);
  return m ? { host: m[1], crawl_delay: Number(m[2]) } : null;
}
// 每个网站上一次请求的时间（Crawl-delay 超过上限的网站跨轮隔开用）。
export const VISITS = 'state/site-visits.json';
async function withVisits(change) {
  const [{ read, write }, { waitForLock }] = await Promise.all([import('../store.mjs'), import('../lock.mjs')]);
  const release = await waitForLock('visits', { timeout: 10000, interval: 50 });
  try {
    const all = read(VISITS, {}) || {};
    const out = change(all);
    write(VISITS, all);
    return out;
  } finally { release(); }
}
export const siteVisits = {
  // 离上次够久就记下这次（now）并回 { ok: true }；不够久回 { ok: false, next_at }。
  claim: (host, gapMs, now) => withVisits((all) => {
    const last = Date.parse(all[host]?.at || '');
    if (Number.isFinite(last) && now - last < gapMs) return { ok: false, next_at: new Date(last + gapMs).toISOString() };
    all[host] = { at: new Date(now).toISOString(), crawl_delay: gapMs / 1000 };
    return { ok: true };
  }),
  // 又发了一跳：把时间往后挪到 now。
  touch: (host, now) => withVisits((all) => {
    if (!all[host] || Date.parse(all[host].at) < now) all[host] = { ...all[host], at: new Date(now).toISOString() };
  }),
};
// 时间和读 robots.txt、记上次请求的办法都能换（测试用可控的时间、假的 robots.txt 和记在内存里的上次请求）。
export const politeness = { robots_timeout_ms: 10000, readRobots: (url) => fetchRobots(url), visits: siteVisits };

const scope = new AsyncLocalStorage();
let sites = new Map();  // 主机 → { active, waiting, nextAt }
let robots = new Map(); // origin → Promise<{ host, status, crawl_delay, delay_ms, note }>

// Crawl-delay 超过上限的网站这一轮的情况：主机 → { decided（Promise）, owner（放行给了哪个 politely()）, skipped, next_at }
let slow = new Map();

// owner：最外层的那个 politely()（一条线索的详情、一个扫描来源），套在里面的（Oleeo 的 10 秒）算同一个。
let owners = 0;
const NONE = { max: Infinity, robots: false, min_ms: 0, owner: null };
const merge = (outer, { max, robots: readsRobots = false, min_ms = 0 } = {}) => ({
  max: Math.min(outer.max, max ?? Infinity),
  robots: outer.robots || !!readsRobots,
  min_ms: Math.max(outer.min_ms, min_ms || 0),
  owner: outer.owner ?? ++owners,
});
export function politely(fn, options) {
  return scope.run(merge(scope.getStore() || NONE, options), fn);
}
// 专用 Chrome 的文档导航也照同一套网站间隔排队；调用方先检查 robots 是否允许该路径。
export const politeBrowserRead = (url, send) => politely(() => gate(url, send), { max: MAX_PER_SITE, robots: true });
// 现在所在的 politely() 范围（不在里面是 null）：fetchSource 用它决定要不要替子进程把门。
export const currentScope = () => scope.getStore() || null;

// 新的一轮（测试用）：忘掉排队状态、读过的 robots.txt 和这一轮放行 / 跳过的网站（上次请求的时间在 state 里，不忘）。
export function resetPoliteness() { sites = new Map(); robots = new Map(); slow = new Map(); }

// 这一轮读过的 robots.txt：{ 主机: { status, crawl_delay, note } }。Crawl-delay 超过上限的 note 是 crawl_delay_over_cap，
// taken 是这一轮取了 1 个（线索的详情或扫描来源），skipped 是没发出去的请求数，next_at 是还没到间隔时下次能取的时间。
export async function robotsReport() {
  const out = {};
  for (const r of await Promise.all(robots.values())) {
    const over = slow.get(r.host);
    out[r.host] = { status: r.status, ...(r.crawl_delay !== null ? { crawl_delay: r.crawl_delay } : {}),
      ...(over ? { note: 'crawl_delay_over_cap', ...(over.owner != null ? { taken: 1 } : {}), ...(over.skipped ? { skipped: over.skipped } : {}), ...(over.next_at ? { next_at: over.next_at } : {}) }
        : r.note ? { note: r.note } : {}) };
  }
  return out;
}

async function readDelay(u) {
  const base = { host: u.host, status: null, crawl_delay: null, delay_ms: 0, note: null };
  let timer = false;
  try {
    const got = await Promise.race([
      politeness.readRobots(`${u.origin}/robots.txt`),
      clock.sleep(politeness.robots_timeout_ms, { unref: true }).then(() => { timer = true; }),
    ]);
    if (timer) return { ...base, note: 'robots_timeout' };
    if (got.status >= 500) return { ...base, status: got.status, note: 'robots_server_error' };
    if (got.status >= 400) return { ...base, status: got.status, note: 'no_robots_txt' };
    const s = crawlDelay(got.text);
    return { ...base, status: got.status, crawl_delay: s, delay_ms: s ? Math.round(s * 1000) : 0 };
  } catch (e) {
    return { ...base, note: `robots_unreadable: ${String(e.message || e).slice(0, 120)}` };
  }
}

// 读 robots.txt 自己不排队（不在 politely 里），同一网站同时来的几路等同一次读取。
function robotsFor(u) {
  if (!robots.has(u.origin)) robots.set(u.origin, scope.exit(() => readDelay(u)));
  return robots.get(u.origin);
}

function site(host) {
  if (!sites.has(host)) sites.set(host, { active: 0, waiting: [], nextAt: 0 });
  return sites.get(host);
}
// 放一路出去时直接把名额交给排在最前的那个，中间插不进新来的。
function acquire(s, max, signal) {
  signal?.throwIfAborted();
  if (s.active < max) { s.active++; return null; }
  return new Promise((resolve, reject) => {
    const ready = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { const i = s.waiting.indexOf(ready); if (i < 0) return; s.waiting.splice(i, 1); reject(signal.reason); };
    s.waiting.push(ready);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function release(s) {
  const next = s.waiting.shift();
  if (next) next(); else s.active--;
}

// Crawl-delay 超过上限的网站：这一轮第一个来要的 politely() 去 state 里核上次请求的时间，够久就归它（记下这次）；
// 之后只放它的请求，别的一律这轮不取。
async function overCap(u, r, owner) {
  if (!slow.has(u.host)) slow.set(u.host, { decided: null, owner: null, reason: null, skipped: 0, next_at: null });
  const t = slow.get(u.host);
  t.decided ||= Promise.resolve().then(() => politeness.visits.claim(u.host, r.delay_ms, clock.now())).then(
    (c) => { if (c.ok) t.owner = owner; else Object.assign(t, { reason: 'not_due', next_at: c.next_at }); },
    () => { t.reason = 'visits_unavailable'; });
  await t.decided;
  if (t.owner === owner) return true;
  t.skipped++;
  throw new CrawlDelayTooLong(u.host, r.crawl_delay, { reason: t.reason || 'taken', next_at: t.next_at });
}

// 过门：等到这个网站有名额、离上一次开始够久，返回一个「出门」函数（请求的响应回来后调用，交出名额）。
async function enter(url, store, { signal } = {}) {
  signal?.throwIfAborted();
  const u = new URL(url);
  let gap = store.min_ms, visited = false;
  if (store.robots) {
    const r = await robotsFor(u);
    // 超过上限的，这一轮放行的那一个不在轮内按间隔排（间隔是跨轮隔开的）
    if (r.crawl_delay > MAX_CRAWL_DELAY_S) visited = await overCap(u, r, store.owner);
    else gap = Math.max(gap, r.delay_ms);
  }
  const s = site(u.host);
  await acquire(s, store.max, signal);
  try {
    // 不能预订未来的时隙：计时器迟醒后，后一路会追赶旧时隙而缩短真实间隔。
    // 醒来重新核对；检查与更新之间不 await，同一时刻只放行一路。下一段从实际放行算。
    for (;;) {
      signal?.throwIfAborted();
      const now = clock.now(), wait = s.nextAt - now;
      if (wait <= 0) { s.nextAt = now + gap; break; }
      await clock.sleep(wait, { signal });
    }
  } catch (e) { release(s); throw e; }
  let out = false;
  return async () => {
    if (out) return;
    out = true; release(s);
    // 发完记下时间（下一轮从这儿算间隔）；记不上也不耽误这次
    if (visited) await politeness.visits.touch(u.host, clock.now()).catch(() => {}); // 兜底：访问时间记不上，最多下次早一点再访问这个网站（robots 的间隔另有内存里的记录）
  };
}

async function gate(url, send) {
  const store = scope.getStore();
  if (!store) return send();
  const leave = await enter(url, store);
  try { return await send(); } finally { await leave(); }
}

// ---- 子进程（扫描的来源）经 IPC 回父进程排队 ----

// 子进程里调用：每一跳请求先问父进程要名额，响应回来就交还。子进程自己的 politely()（比如 Oleeo 的 10 秒）一起带过去。
export function gateThroughParent(proc = process) {
  let n = 0;
  const waits = new Map();
  proc.on('message', (m) => {
    const w = waits.get(m?.id);
    if (!w || !/^politeness:(go|deny)$/.test(m.type)) return;
    waits.delete(m.id);
    if (m.type === 'politeness:go') w.resolve();
    else w.reject(m.code === 'crawl_delay_over_cap' ? new CrawlDelayTooLong(m.host, m.crawl_delay) : Error(m.error));
  });
  useGate(async (url, send) => {
    const id = ++n, s = scope.getStore();
    await new Promise((resolve, reject) => {
      waits.set(id, { resolve, reject });
      proc.send({ type: 'politeness:enter', id, url, scope: s ? { ...s, max: Number.isFinite(s.max) ? s.max : null } : null });
    });
    try { return await send(); } finally { if (proc.connected) proc.send({ type: 'politeness:leave', id }); }
  });
}

// 父进程里调用：替这个子进程把门，store 是 fetchSource 被调用时所在的 politely() 范围。
// waiting(true/false)：子进程有没有请求正在门口等（fetchSource 等的时候不算它的超时）。
// close() 在子进程结束时调用，交还它没来得及交的名额；overCap() 是它碰到的 Crawl-delay 超过上限的网站。
export function parentGate(child, store, { waiting = () => {} } = {}) {
  const held = new Map();
  const stop = new AbortController();
  let closed = false, over = null, pending = 0;
  const reply = (m) => { if (!closed && child.connected) child.send(m); };
  child.on('message', (m) => {
    if (m?.type === 'politeness:leave') { held.get(m.id)?.(); held.delete(m.id); return; }
    if (m?.type !== 'politeness:enter' || closed) return;
    if (++pending === 1) waiting(true);
    const inner = m.scope ? { ...m.scope, max: m.scope.max ?? undefined } : {};
    enter(m.url, merge(store, inner), { signal: stop.signal }).then((leave) => {
      if (closed || !child.connected) return leave();
      held.set(m.id, leave);
      reply({ type: 'politeness:go', id: m.id });
    }, (e) => {
      if (e.code === 'crawl_delay_over_cap') over ||= { host: e.host, crawl_delay: e.crawl_delay };
      reply({ type: 'politeness:deny', id: m.id, error: String(e.message || e), code: e.code, host: e.host, crawl_delay: e.crawl_delay });
    }).finally(() => { if (--pending === 0) waiting(false); });
  });
  return {
    close() { closed = true; stop.abort(); for (const leave of held.values()) leave(); held.clear(); },
    overCap: () => over,
  };
}

// ---- 按网站分队列 ----

const hostOf = (x) => { if (!x) return null; try { return new URL(String(x)).host || String(x); } catch { return String(x); } };

// items 按原来的先后排着；siteOf(item) 给出它要打的网站（地址或主机名，不用取的给 null）。几路并发各自 await next()
// 领一件：先领现在就能开始的（它的网站在途不满 max 件、离上次开始也够久），都得等就挑最早能开始的，一样早按原来的先后；
// 所有剩下的网站都满了，就等有一件做完再挑。领到的那件做完调用 done()；只是前半段要打这个网站（取详情）、后半段
// 不用的，打完就调用 release()，网站的名额先让出来。总并发由调用方的路数定，这里不改。
export function siteQueue(items, siteOf, { max = MAX_PER_SITE } = {}) {
  const left = items.map((item, index) => ({ item, index, host: hostOf(siteOf(item)) }));
  const claimed = new Map();
  let wakers = [];
  const wake = () => { const w = wakers; wakers = []; for (const f of w) f(); };
  const readyIn = (host) => {
    if (!host) return 0;
    if ((claimed.get(host) || 0) >= max) return Infinity;
    return Math.max(0, (sites.get(host)?.nextAt || 0) - clock.now());
  };
  return {
    get size() { return left.length; },
    async next() {
      for (;;) {
        if (!left.length) return null;
        let best = -1, wait = Infinity;
        for (let k = 0; k < left.length && wait > 0; k++) {
          const w = readyIn(left[k].host);
          if (w < wait) { best = k; wait = w; }
        }
        // 最好的那件也要等一会儿，而手上还有在做的：等到它能开始，或者先有一件做完（也许别的网站就空出来了）。
        const busy = [...claimed.values()].some((c) => c > 0);
        if (best < 0 || (wait > 0 && busy)) {
          const stop = new AbortController();
          await Promise.race([new Promise((resolve) => wakers.push(resolve)), ...(best < 0 ? [] : [clock.sleep(wait, { signal: stop.signal })])]);
          stop.abort();
          continue;
        }
        const [job] = left.splice(best, 1);
        if (job.host) claimed.set(job.host, (claimed.get(job.host) || 0) + 1);
        let out = false;
        const release = () => { if (out) return; out = true; if (job.host) claimed.set(job.host, claimed.get(job.host) - 1); wake(); };
        return { item: job.item, index: job.index, host: job.host, release, done: release };
      }
    },
  };
}

// 和 lib/judge.mjs judgeMany 一样的结果（按原来的下标：{ ok, value } 或 { ok: false, error }），只是按网站分队列领活。
// fn(item, index, job)：job.release() 让出这件的网站名额（不打那个网站了，后面的活还在做）。
export async function runBySite(items, fn, { concurrency = 1, siteOf = () => null, max = MAX_PER_SITE } = {}) {
  const q = siteQueue(items, siteOf, { max });
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let job; (job = await q.next());) {
      try { out[job.index] = { ok: true, value: await fn(job.item, job.index, job) }; }
      catch (e) { out[job.index] = { ok: false, error: String(e.message || e).slice(0, 300) }; }
      finally { job.done(); }
    }
  }));
  return out;
}

useGate(gate);
