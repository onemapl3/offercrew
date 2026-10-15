// 专用 Chrome 的主机（和 ego 解耦，2026-10-02，方案 design/desktop-app/方案-内置浏览器（和ego解耦）.md）：
// 一个长开的 Google Chrome，所有要在网页上动手的地方共用它，用的是同一份登录状态。
//
//   - 用电脑上装的 Google Chrome，不打包、不下载；没装就报 chrome_missing，请你自己去装（负责人 10-02 定）。
//   - 专用登录档案 private/browser-profile（0700），不碰你平时用的 Chrome 档案：新版 Chrome 不让远程调试那份，
//     分开也让 OfferCrew 只碰求职网站。界面上叫「专用 Chrome」。
//   - 调试端口只开在 127.0.0.1，端口由系统随机分配（--remote-debugging-port=0）。端口和进程号写进
//     private/browser-host.json（0600，只有你能读），谁要用就照它连上来。启动加锁：两个进程同时要用也只起一个。
//   - 就是一个正常启动的 Chrome，带着标准的自动化开关 --enable-automation（顶上显示「正受到自动测试软件的控制」，
//     navigator.webdriver 是 true）。不改指纹、不打隐身补丁、不伪装 webdriver、不去掉自动化标记（方案红线第 6 条）：
//     网站拦下来、要验证或者要登录，就停下交给你。
//   - 用到时才起，起来以后一直开着。Mac 上交给 LaunchServices 另起一个实例（open -n），后台的活不抢焦点（-g）；
//     开出来时没有窗口（--no-startup-window），要给你看的页面才开窗口，后台的活开在不进标签栏的隐藏标签页里。
//   - Chrome 崩了或者你把它退出了：看门狗（bin/serve.mjs 每分钟 checkHost）清掉状态，下次要用时再起，不会马上又弹出来。
//   - 沙盒（lib/sandbox.mjs）里不起 Chrome；测试（node --test）里只许起无头的。
//   - Mac 版里本机 AI 在 Codex 的受限沙盒里跑（CODEX_SANDBOX=seatbelt）：沙盒里起不了 Chrome（10-03 实测），连本机端口要开着网络
//     （App 给它开了）。这时不自己起，在 state/browser-host-request.json 留个请求，由沙盒外的工作台（bin/serve.mjs 每 2 秒看一次，
//     serveHostRequest）起好，脚本等它开好再连上去。
//
// 页面上的事只用很小的 CDP 客户端（lib/cdp.mjs）做，而且只挂我们自己开的那个标签页：你正在用的标签页不会被注入任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from './spawn.mjs';
import { file } from './store.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';
import { connectCdp, getJson } from './cdp.mjs';
import { noteSwallowed } from './swallow.mjs';
import { findChrome, CHROME_DOWNLOAD } from './chrome-path.mjs';

export { findChrome, CHROME_DOWNLOAD };

export const PROFILE_DIR = 'private/browser-profile';
export const STATE_PATH = 'private/browser-host.json';
export const LOCK_PATH = 'private/browser-host.lock';
// 给你看的那个标签页（「打开登录页」一直用它）：记的只是标签页的 id 和为哪个账号打开的。
export const USER_TAB_PATH = 'state/browser-user-tab.json';
export const REQUEST_PATH = 'state/browser-host-request.json';
export const CHROME_NAME = '专用 Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const fail = (code, message, extra = {}) => Object.assign(Error(`${code}：${message}`), { code, ...extra });

// ── 找 Chrome（lib/chrome-path.mjs：能力表也要问装没装，放在下面一层）──
export const chromeMissing = () => fail('chrome_missing', `这台电脑上没找到 Google Chrome。先装上 Chrome（${CHROME_DOWNLOAD}），再试一次。`);

// 启动参数。只有这些：专用档案、随机端口、标准的自动化开关、跳过首次运行的欢迎页，外加三个性能参数：
// 后台窗口、被挡住的窗口不降频（预填、扫描都在后台窗口里做，不把窗口抢到前面；主会话 10-02 定）。
// Playwright 自己起 Chrome 时也加这三个，和躲检测无关。
// 不加 --disable-blink-features=AutomationControlled，不改 user agent，不加任何让网站认不出自动化的东西。
export const NO_THROTTLE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
export function chromeArgs(profile, { headless = false, platform = process.platform } = {}) {
  return [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--enable-automation',
    '--no-first-run',
    '--no-default-browser-check',
    ...NO_THROTTLE,
    // Mac 上关掉最后一个窗口 Chrome 还在；别的系统没有窗口会退出，就先开一个空白页。
    ...(platform === 'darwin' || headless ? ['--no-startup-window'] : []),
    // 无头只在测试里用：不碰钥匙串。
    ...(headless ? ['--headless=new', '--use-mock-keychain'] : []),
    ...(platform === 'darwin' || headless ? [] : ['about:blank']),
  ];
}
const appBundleOf = exe => /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1] || null;

// ── 状态文件和锁 ───────────────────────────────────────────────────────────────────────────
export const profileDir = () => file(PROFILE_DIR);
export function readState() {
  try { return JSON.parse(fs.readFileSync(file(STATE_PATH), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') noteSwallowed('browser-host.readState', e, { member: 'patch', doing: '读专用 Chrome 的状态', then: '当它没开，要用时重新起' }); return null; }
}
function writeState(state) {
  const dest = file(STATE_PATH), tmp = `${dest}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}
export function clearState() { try { fs.rmSync(file(STATE_PATH), { force: true }); } catch {} } // 兜底：force 已经不管文件在不在；删不掉的话下次按进程活不活着再判断

// 起 Chrome 的那几秒加锁：锁文件里是持锁进程号；持锁的进程没了、或者锁放了一分钟还在，就当它是死锁。
async function hostLock(timeout) {
  const p = file(LOCK_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ pid: process.pid, at: Date.now(), n: Math.random() });
  const deadline = Date.now() + timeout;
  for (;;) {
    try { fs.writeFileSync(p, mine, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let held = null, raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); held = JSON.parse(raw); } catch {} // 兜底：另一个进程正在写或刚删，读不出就当锁没人持有，下面只删刚才读到的那一份
    if (!held || !alive(held.pid) || Date.now() - held.at > 60000) {
      // 只删刚才读到的那一份（读和删之间别人换了锁，就不动）。
      try { if (fs.readFileSync(p, 'utf8') === raw) fs.rmSync(p, { force: true }); } catch {} // 兜底：读和删之间锁被别人换了或已经删了，不动它
      continue;
    }
    if (Date.now() > deadline) throw fail('chrome_host_busy', '另一个进程正在打开专用 Chrome，等了太久');
    await sleep(200);
  }
  return () => { try { if (fs.readFileSync(p, 'utf8') === mine) fs.rmSync(p, { force: true }); } catch {} }; // 兜底：锁已经被别人清掉了，不用再放
}

// ── 连上去 ────────────────────────────────────────────────────────────────────────────────
// Chrome 把端口和浏览器的 WebSocket 路径写在档案里的 DevToolsActivePort。
function readPortFile(profile) {
  try {
    const [p, ws] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map(s => s.trim());
    const port = Number(p);
    return port > 0 && /^\/devtools\/browser\/[\w-]+$/.test(ws || '') ? { port, ws } : null;
  } catch { return null; } // 兜底：端口文件不在就是专用 Chrome 没开
}
// 这个端口上真的是这个档案的那个浏览器：/json/version 里的 WebSocket 地址对得上（端口被别的程序占了不算）。
async function endpointLive({ port, ws }) {
  try {
    const v = await getJson(port, '/json/version', { timeout: 1500 });
    return String(v.webSocketDebuggerUrl || '').endsWith(ws) ? v : null;
  } catch { return null; } // 兜底：那个端口没在听，就是没开
}
const wsUrl = st => `ws://127.0.0.1:${st.port}${st.ws}`;
async function browserPid(st) {
  let cdp = null;
  try {
    cdp = await connectCdp(wsUrl(st), { timeout: 5000 });
    const r = await cdp.send('SystemInfo.getProcessInfo', {}, { timeout: 5000 });
    return r.processInfo?.find(p => p.type === 'browser')?.id ?? null;
  } catch { return null; } finally { cdp?.close(); } // 兜底：连不上就拿不到进程号，调用方按不知道处理
}
// 已经开着、连得上的专用 Chrome；没有就是 null。状态文件丢了但 Chrome 还开着（档案里的端口文件还在），照样认回来。
export async function liveHost() {
  const profile = profileDir(), st = readState();
  if (st?.port && st.ws && st.profile === profile && (!st.pid || alive(st.pid)) && await endpointLive(st)) return st;
  const ep = readPortFile(profile);
  if (ep && (ep.port !== st?.port || ep.ws !== st?.ws)) {
    const v = await endpointLive(ep);
    if (v) {
      const again = { ...ep, pid: await browserPid(ep), profile, executable: st?.executable || null, headless: /Headless/i.test(v['User-Agent'] || ''), version: v.Browser || null, started_at: st?.started_at || null, adopted_at: new Date().toISOString(), last_used_at: st?.last_used_at || new Date().toISOString() };
      writeState(again);
      return again;
    }
  }
  return null;
}
// 档案被一个连不上的 Chrome 占着（比如它卡住了，或者有人不带调试端口直接用这个档案开了 Chrome）。
function profileHeldBy(profile) {
  try { const pid = Number(/-(\d+)$/.exec(fs.readlinkSync(path.join(profile, 'SingletonLock')))?.[1]); return alive(pid) ? pid : null; } catch { return null; } // 兜底：档案没有锁文件就是没在用
}

const envHeadless = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.RADAR_BROWSER_HEADLESS || '').trim());

function launch(exe, args, { headless, foreground }) {
  // Mac 上有界面的 Chrome 交给 LaunchServices 起：-n 另起一个实例（你自己的 Chrome 开着也不影响），
  // -g 不抢到最前面（后台的活）。进程号等调试端口通了再问 Chrome 自己。
  const app = process.platform === 'darwin' && !headless ? appBundleOf(exe) : null;
  const child = app
    ? spawn('/usr/bin/open', ['-n', ...(foreground ? [] : ['-g']), '-a', app, '--args', ...args], { detached: true, stdio: 'ignore' })
    : spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  if (headless && child.pid) watchOwner(child.pid);
  return app ? null : child;
}
// 无头的专用 Chrome 只在测试里用（有界面的那个 App 退出、崩了都要留着：你可能正在里面看预填好的申请页）。测试进程被杀掉时
// test.after 来不及关它，它就一直挂在后台吃内存（10-03 发现一个挂了一夜的）。所以无头的另起一个小看门进程：每秒看一眼主人
// 还在不在，主人没了就关掉这个 Chrome。只在设了 RADAR_BROWSER_OWNER 时才看门：测试文件把自己的进程号写进去，它开的子进程
// 起的 Chrome 也归它（几个脚本接力连同一个 Chrome，起它的那个脚本先退出也不会被收掉）；写 self 就是起 Chrome 的这个进程。
// 没设就不看门，和以前一样（产品里不起无头的；就算有人用 RADAR_BROWSER_HEADLESS 起了，也不会被误关）。
const OWNER_WATCH = `const [owner, pid] = process.argv.slice(1).map(Number);
const alive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const t = setInterval(() => {
  if (!alive(pid)) { clearInterval(t); return; }
  if (alive(owner)) return;
  clearInterval(t);
  try { process.kill(pid, 'SIGTERM'); } catch {} // 兜底：进程已经退了就不用再杀
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 3000); // 兜底：进程已经退了就不用再杀
}, 1000);`;
function watchOwner(pid) {
  const v = String(process.env.RADAR_BROWSER_OWNER || '').trim();
  const owner = v === 'self' ? process.pid : Number(v);
  if (!(owner > 0)) return;
  try { spawn(process.execPath, ['-e', OWNER_WATCH, String(owner), String(pid)], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { noteSwallowed('browser-host.ownerWatch', e, { member: 'patch', doing: '起看门狗（App 退出时顺手关掉专用 Chrome）', then: 'App 退出后专用 Chrome 可能还开着' }); }
}

// 要用浏览器时调它：开着就直接用，没开就起一个。返回 { pid, port, ws, profile, headless, ... }。
//   foreground  没开着、要现在起的时候，起来就到最前面（「打开登录页」）；后台的活不抢焦点。
//   headless    只有测试用（RADAR_BROWSER_HEADLESS=1 或传 true）。
// 专用 Chrome 新起来以后要做的事。由用到的模块自己登记（lib/application-page.mjs），这里不去引它：
// application-page 要引本文件，反过来再引就成了环（lib/layer-check.mjs）。
const hostStartHooks = new Set();
export function onHostStarted(fn) { hostStartHooks.add(fn); return () => hostStartHooks.delete(fn); }
export async function ensureHost({ headless = envHeadless(), foreground = false, executable = null, timeout = 45000, existingOnly = false } = {}) {
  if (sandboxed()) throw Object.assign(Error(sandboxSkip(`打开${CHROME_NAME}`)), { code: 'sandbox' });
  const live = await liveHost();
  if (live) return touch(live);
  if (existingOnly) throw fail('chrome_host_not_running', '专用 Chrome 已关闭，自动检查等待下次由你打开');
  const exe = executable || findChrome();
  if (!exe) throw chromeMissing();
  if (confined()) return requestHost({ timeout: Math.min(timeout, 30000) });
  // 测试里绝不起有界面的 Chrome（别的会话可能正在用屏幕）。
  if (process.env.NODE_TEST_CONTEXT && !headless) throw fail('chrome_host_headed_in_tests', '测试里只许起无头的专用 Chrome');
  const release = await hostLock(timeout);
  try {
    const again = await liveHost();
    if (again) return touch(again);
    const profile = profileDir();
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.chmodSync(profile, 0o700);
    const held = profileHeldBy(profile);
    if (held) throw fail('chrome_host_profile_busy', `${CHROME_NAME}已经开着，但连不上（进程 ${held}）。把它完全退出（⌘Q）后再试一次。`, { pid: held });
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    const child = launch(exe, chromeArgs(profile, { headless }), { headless, foreground });
    const deadline = Date.now() + timeout;
    let ep = null;
    while (!ep && Date.now() < deadline) {
      await sleep(150);
      const p = readPortFile(profile);
      if (p && await endpointLive(p)) ep = p;
      else if (child && child.exitCode != null) break;
    }
    if (!ep) {
      if (child?.pid && alive(child.pid)) { try { process.kill(child.pid); } catch {} } // 兜底：进程已经退了就不用再杀
      throw fail('chrome_host_start_failed', `${CHROME_NAME}没有打开调试端口${child?.exitCode != null ? `（退出码 ${child.exitCode}）` : ''}`);
    }
    const v = await endpointLive(ep);
    const at = new Date().toISOString();
    const state = { pid: await browserPid(ep) ?? child?.pid ?? null, port: ep.port, ws: ep.ws, profile, executable: exe, headless: !!headless, version: v?.Browser || null, started_at: at, last_used_at: at };
    writeState(state);
    // 专用 Chrome 是新起的：以前预填好、留在里面的申请页都没了。登记过的核对（lib/application-page.mjs 的 checkKeptPages，O3）
    // 在后台跑，不挡这次要用浏览器的活；出错只打一行。
    if (!headless) for (const fn of hostStartHooks) Promise.resolve().then(fn).catch(e => console.error(`[browser-host] 核对预填页没成：${String(e?.message || e).slice(0, 120)}`));
    return state;
  } finally { release(); }
}

// 在 Codex 的沙盒里：Chrome 由沙盒外的工作台起（见文件开头）。
export const confined = (env = process.env) => env.CODEX_SANDBOX === 'seatbelt';
async function requestHost({ timeout = 30000 } = {}) {
  const dest = file(REQUEST_PATH);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(300);
    const live = await liveHost();
    if (live) return touch(live);
  }
  throw fail('chrome_host_wait', `${CHROME_NAME}要由 OfferCrew 打开，等了 ${Math.round(timeout / 1000)} 秒还没开好（OfferCrew 开着吗？）`);
}
// 工作台这边：有新的请求（2 分钟以内的）就起专用 Chrome，不抢焦点。返回 null（没有请求）或 { started | stale | error }。
// 请求只是一声「要用」：里面只看时间，别的一概不读——不照它打开网址、不换 Chrome、不加参数，只做「开专用 Chrome」这一件
// 固定的事（主会话 10-03）。沙盒里的本机 AI 写得了这个文件，所以它不能是一条能带内容的命令通道。
export async function serveHostRequest({ maxAge = 120000, now = Date.now(), start = () => ensureHost() } = {}) {
  const p = file(REQUEST_PATH);
  let req = null;
  try { req = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; }
  fs.rmSync(p, { force: true });
  if (!(now - Date.parse(req?.at || '') < maxAge)) return { stale: true };
  try { const st = await start(); return { started: true, pid: st?.pid ?? null }; }
  catch (e) { return { error: String(e?.message || e).slice(0, 200), code: e?.code || null }; }
}

// 每用一次记一下（闲着就关看它）。
function touch(st) {
  const next = { ...st, last_used_at: new Date().toISOString() };
  try { writeState(next); } catch {} // 兜底：只是记一下最近用过的时间，写不进去最多早一点被当成闲着关掉
  return next;
}

// 连上专用 Chrome 干一件事，干完断开（Chrome 照旧开着）。
export async function withHost(fn, opts = {}) {
  const st = await ensureHost(opts);
  const cdp = await connectCdp(wsUrl(st));
  try { return await fn(cdp, st); } finally { cdp.close(); }
}

// ── 标签页 ────────────────────────────────────────────────────────────────────────────────
export async function attach(cdp, targetId) { return (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
export async function detach(cdp, session) { await cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {}); } // 兜底：标签页已经关了，连接也就断了
// 后台用的标签页：不进标签栏、不开窗口、不抢焦点（hidden），这条连接一断它就自己关掉。
// 认不得 hidden 的旧版 Chrome 退回到后台新开一个窗口。
export async function hiddenTab(cdp) {
  try { return { targetId: (await cdp.send('Target.createTarget', { url: 'about:blank', hidden: true, background: true })).targetId, hidden: true }; }
  catch { return { targetId: (await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })).targetId, hidden: false }; }
}
// 导航并等页面加载完（load 事件，最多 timeout）。网址打不开（断网、域名不对、网站回错误状态又没有内容）时
// 不抛错，navError 带回原因。
export async function navigate(cdp, session, url, { timeout = 40000 } = {}) {
  await cdp.send('Page.enable', {}, { session }).catch(() => {}); // 兜底：不开页面事件也能导航，只是等不到加载事件，下面按超时处理
  const loaded = cdp.waitFor('Page.loadEventFired', { session, timeout });
  loaded.catch(() => {}); // 兜底：先挂上，免得没人等时成了未处理的拒绝；结果在下面 await 里看
  let r;
  try { r = await cdp.send('Page.navigate', { url }, { session, timeout }); }
  catch (e) { loaded.cancel(); return { navError: String(e.message || e).slice(0, 300) }; }
  if (r.errorText) { loaded.cancel(); return { navError: r.errorText }; }
  try { await loaded; } catch { return { navError: null, slow: true }; }
  return { navError: null };
}
// 在页面里跑一段表达式，只取回能转成 JSON 的值。
export async function evaluate(cdp, session, expression, { timeout = 15000 } = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { session, timeout });
  if (r.exceptionDetails) throw Error(`page_eval_failed:${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200)}`);
  return r.result?.value;
}

// 把专用 Chrome 拉到最前面。不用 open -a "Google Chrome"：那样会拉起你自己平时用的 Chrome。
// 先让 Chrome 自己把那个标签页提到前面（Page.bringToFront），再按进程号激活这个 Chrome 实例。
export async function activateApp(pid, { run = execFile } = {}) {
  if (process.platform !== 'darwin' || !alive(pid)) return false;
  const js = `ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); (a && !a.isNil()) ? a.activateWithOptions(3) : false;`;
  return new Promise(resolve => {
    const child = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { timeout: 5000 }, error => resolve(!error));
    child?.stdin?.end?.();
  });
}

// 把专用 Chrome 拉到最前面（「打开申请页」切过去以后）：开着才拉，无头的（测试）不拉。
export async function activateHost() {
  const st = await liveHost();
  return st && !st.headless ? activateApp(st.pid) : false;
}

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(file(rel), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') noteSwallowed('browser-host.readJson', e, { member: 'patch', doing: `读 ${rel}`, then: '当没有，重新开一个给你看的标签页' }); return null; }
}
function writeJson(rel, data) {
  const dest = file(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.tmp`, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(`${dest}.tmp`, dest);
}

// 「打开登录页」：在给你看的那个标签页里打开 url，拉到最前面，页面交给你。那个标签页被关了就新开一个窗口。
// 网站回错误状态时照样把页面交给你（你可以在里面刷新或换地址），原因放在 navError 里。
// browse：看原帖这类（从 App 里点开的招聘网站链接，lib/open-where.mjs）：每次在那个窗口里新开一个标签，不占用登录用的那一页
// （你可能正停在登录页上，登录检查要看它）；那个窗口还没有，就新开一个窗口，这一页从此就是「给你看的那个标签页」。
// inspect：开好以后等页面安静下来（地址、标题、正文都 1.5 秒没变，最多 8 秒），读回落在哪 { url, title, text }，
// 给「打开申请页」核对是不是这个岗位（lib/landing.mjs）。只读，不往页面里写东西。
export async function settlePage(cdp, session, { maxMs = 8000, quietMs = 1500, minMs = 2500, step = 400 } = {}) {
  const t0 = Date.now(); let last = null, since = t0, snap = null;
  while (Date.now() - t0 < maxMs) {
    await sleep(step);
    let s = null;
    try { s = await evaluate(cdp, session, `({ url: location.href, title: document.title, ready: document.readyState, text: (document.body && document.body.innerText || '').slice(0, 6000) })`, { timeout: 3000 }); }
    catch { since = Date.now(); continue; } // 兜底：正在跳转（执行环境换了），等下一次
    if (!s) continue;
    snap = s;
    const key = `${s.url}|${s.title}|${Math.floor(String(s.text).length / 200)}`;
    if (key !== last) { last = key; since = Date.now(); continue; }
    if (s.ready === 'complete' && Date.now() - since >= quietMs && Date.now() - t0 >= minMs) break;
  }
  return snap ? { url: snap.url, title: snap.title, text: snap.text } : null;
}
export async function openUserTab(url, { account = null, activate = true, browse = false, inspect = false } = {}) {
  return withHost(async (cdp, st) => {
    const saved = readJson(USER_TAB_PATH);
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    let targetId = saved?.targetId && targetInfos.some(t => t.type === 'page' && t.targetId === saved.targetId) ? saved.targetId : null;
    const keep = browse && targetId;
    if (keep) {
      // 先把那个窗口提到前面，新标签就开在它里面（Chrome 把新标签开在最近用过的窗口里）。
      const s0 = await attach(cdp, targetId);
      await cdp.send('Page.bringToFront', {}, { session: s0 }).catch(() => {}); // 兜底：拉不到前面也照样在那个窗口里开新标签
      await detach(cdp, s0);
      targetId = (await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: false })).targetId;
    }
    if (!targetId) targetId = (await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })).targetId;
    const session = await attach(cdp, targetId);
    let navError = null;
    // 等到页面开始显示（最多 3 秒）再回话：回执出来时你切过去看到的已经是那一页，不是空白。
    await cdp.send('Page.enable', {}, { session }).catch(() => {}); // 兜底：不开页面事件也能导航，只是等不到加载事件，下面按超时处理
    const shown = cdp.waitFor('Page.domContentEventFired', { session, timeout: 3000 });
    shown.catch(() => {}); // 兜底：先挂上，免得没人等时成了未处理的拒绝；结果在下面 await 里看
    try { const r = await cdp.send('Page.navigate', { url }, { session, timeout: 45000 }); navError = r.errorText || null; }
    catch (e) { navError = String(e.message || e).slice(0, 300); }
    if (navError) shown.cancel(); else await shown.catch(() => {}); // 兜底：3 秒还没显示出来也先回话，页面会接着加载
    if (activate) {
      await cdp.send('Page.bringToFront', {}, { session }).catch(() => {}); // 兜底：拉不到前面页面也已经开好了，你切过去就能看到
      if (!st.headless) await activateApp(st.pid);
    }
    let landed = null;
    if (inspect && !navError) { try { landed = await settlePage(cdp, session); } catch { landed = null; } } // 兜底：读不回就是认不出，调用方照实说
    await detach(cdp, session);
    if (!keep) writeJson(USER_TAB_PATH, { targetId, account, url, at: new Date().toISOString() });
    // 你自己去打开了这个网站（多半就是去做验证 / 登录）：「先别碰」的等待清掉，下一轮照常去看。
    try { const { clearSiteHold, siteOf } = await import('./browser-sites.mjs'); clearSiteHold(siteOf(url)); } catch (e) { noteSwallowed('browser-host.clearSiteHold', e, { member: 'scout', doing: '你打开网站后清掉「先别碰」的等待', then: '下一轮可能还会跳过这个网站' }); }
    return { ok: true, engine: 'chrome', targetId, url, navError, ...(inspect ? { landed } : {}) };
  }, { foreground: activate });
}

// 给你看的那个标签页现在在哪（登录检查要知道你是不是还停在登录页）。没有、或者专用 Chrome 没开着，就是 null。
// 只读标签页列表，不挂到那个标签页上。
export async function userTabNow() {
  const saved = readJson(USER_TAB_PATH);
  if (!saved?.targetId) return null;
  const st = await liveHost();
  if (!st) return null;
  let cdp = null;
  try {
    cdp = await connectCdp(wsUrl(st), { timeout: 5000 });
    const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, { timeout: 5000 });
    const t = targetInfos.find(x => x.targetId === saved.targetId);
    return t ? { ...saved, url: t.url, opened_url: saved.url } : null;
  } catch { return null; } finally { cdp?.close(); } // 兜底：专用 Chrome 没在听就是没有给你看的标签页（null）
}

// ── 看门狗、状态、关掉 ─────────────────────────────────────────────────────────────────────
// 有没有给你看的标签页：除了系统自己的任务空间（state/browser-spaces.json 里归系统的）以外，还有别的标签页开着——
// 你的登录页、交给你检查的申请表、你自己在里面开的标签——就算有。
const SPACES_PATH = 'state/browser-spaces.json';
async function userFacing(st) {
  let agent = new Set();
  try { const reg = JSON.parse(fs.readFileSync(file(SPACES_PATH), 'utf8')); agent = new Set(Object.values(reg.spaces || {}).filter(x => x.ownership === 'agent').flatMap(x => Object.values(x.pages || {}))); } catch {} // 兜底：读不出系统的任务空间登记，就把所有标签都当成给你看的，宁可不关
  let cdp = null;
  try {
    cdp = await connectCdp(wsUrl(st), { timeout: 5000 });
    const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, { timeout: 5000 });
    return targetInfos.some(t => t.type === 'page' && !agent.has(t.targetId));
  } catch { return true; } finally { cdp?.close(); } // 兜底：连不上就当有给你看的标签页，宁可不关
}
// bin/serve.mjs 每分钟调一次：
//   - Chrome 没了（崩了、你退出了）：清掉状态，下次要用时再起，不在这里重新拉起来；
//   - 闲着就关（主会话 10-02）：idleMs 没用过、又没有给你看的标签页开着，就关掉，要用时再起。登录状态存在档案目录里，关了不丢
//     （只在会话期间有效的 cookie 除外，见 docs/chrome-host.md）。程序坞里就不会一直多一个 Chrome。
export async function checkHost({ idleMs = 0, now = Date.now() } = {}) {
  const st = readState();
  if (!st) return { running: false };
  const live = await liveHost();
  if (!live) { clearState(); return { running: false, cleared: true }; }
  const last = Date.parse(live.last_used_at || live.started_at || '') || 0;
  if (idleMs && now - last >= idleMs && !(await userFacing(live))) {
    await stopHost();
    return { running: false, idle_closed: true, pid: live.pid };
  }
  return { running: true, pid: live.pid, port: live.port };
}
// 设置页、诊断用：装没装 Chrome、专用 Chrome 开没开着。不起 Chrome。
export async function hostStatus() {
  const executable = findChrome(), live = sandboxed() ? null : await liveHost();
  return { installed: !!executable, executable, running: !!live, pid: live?.pid ?? null, version: live?.version ?? null, profile: PROFILE_DIR, download: CHROME_DOWNLOAD };
}
// 关掉专用 Chrome（测试、App 退出时用）：先请它自己关（Browser.close），5 秒还在就结束进程。
export async function stopHost({ wait = 5000 } = {}) {
  const st = readState() || await liveHost();
  if (!st) return { stopped: false };
  try { const cdp = await connectCdp(wsUrl(st), { timeout: 3000 }); await cdp.send('Browser.close', {}, { timeout: 3000 }).catch(() => {}); cdp.close(); } catch {} // 兜底：先请它自己关；请不动下面会等它退出，再不退就结束进程
  const deadline = Date.now() + wait;
  while (st.pid && alive(st.pid) && Date.now() < deadline) await sleep(100);
  if (st.pid && alive(st.pid)) { try { process.kill(st.pid); } catch {} } // 兜底：进程已经退了就不用再杀
  clearState();
  return { stopped: true, pid: st.pid ?? null };
}
