// OfferCrew 的 macOS 外壳（Electron 主进程）。引擎就是上一级目录里的代码，原样运行：
//   1. 数据目录（~/Library/Application Support/OfferCrew，开发时 OFFERCREW_DATA_DIR）里挂上引擎（bin/data-root.mjs）；
//   2. 写一个 node 小脚本，宿主脚本按名字调 node 时用 App 自己的程序当 Node；
//   3. 在空闲端口上起 bin/serve.mjs（ELECTRON_RUN_AS_NODE=1，RADAR_SCHEDULER=app：定时在引擎里跑），看门狗管着；
//   4. 窗口加载工作台；关窗口不退出，常驻菜单栏；全局快捷键唤起「跟团队说」；可设开机自启；
//   5. 正式签名的安装包：不在「应用程序」里就问一次要不要移过去；后台检查更新（offercrew.onemaple.cc/updates/mac/，desktop/lib/update-feed.mjs；启动、每小时、回到前台时查，desktop/lib/update-pace.mjs），
//      发现新版后侧栏提示，点下载；下好后侧栏、「设置 → 关于」和菜单栏里都有「重启以更新」，不点就在下次退出时装上。
// --smoke：起引擎、加载页面、打印一行 JSON 就退出，给测试和打包后的自检用。
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, globalShortcut, dialog, powerMonitor, ipcMain, session, autoUpdater as squirrel } from 'electron';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeNodeShim } from './lib/node-shim.mjs';
import { superviseService } from './lib/service.mjs';
import { pickHotkey } from './lib/hotkey.mjs';
import { localFeedOverride } from './lib/update-feed.mjs';
import { pacedCheck, EVERY_MS } from './lib/update-pace.mjs';
import { checkText } from './lib/update-status.mjs';
import { wireUpdateDownload } from './lib/update-download.mjs';
import { appMenu } from './lib/app-menu.mjs';
import { watchPage } from './lib/page-recovery.mjs';
import { bundleVersion, moveDecision } from './lib/versions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const engine = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(here, '..');
const { BRAND } = await import(pathToFileURL(path.join(engine, 'lib/brand.mjs')).href);
const { APP_SCHEDULE } = await import(pathToFileURL(path.join(engine, 'lib/app-schedule.mjs')).href);
// 数据目录的名字固定为 OfferCrew，不跟产品名走（改名以后老用户的数据还在原处）。
const dataDir = process.env.OFFERCREW_DATA_DIR || path.join(app.getPath('appData'), 'OfferCrew');
const shellDir = path.join(dataDir, '.offercrew');
const sandbox = /^(1|true|yes|on)$/i.test(String(process.env.RADAR_SANDBOX || '')) || fs.existsSync(path.join(dataDir, 'state/sandbox.json'));
app.setName(BRAND);
app.setPath('userData', path.join(shellDir, 'electron'));

let win = null, pageRecovery = null, tray = null, base = null, quitting = false, engineChild = null, supervisor = null, hotkey = null, fakeLoginItem = false, updater = null, updateReady = null, updateCheck = { state: 'idle' }, checkUpdates = null, downloadUpdate = null;
const logFile = () => { fs.mkdirSync(path.join(dataDir, 'runs/desktop'), { recursive: true }); return path.join(dataDir, 'runs/desktop/shell.log'); };
const log = (msg) => { try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
const prefsFile = path.join(shellDir, 'desktop.json');
const prefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; } };
const savePrefs = (p) => { fs.mkdirSync(shellDir, { recursive: true }); fs.writeFileSync(prefsFile, JSON.stringify({ ...prefs(), ...p }, null, 2) + '\n'); };

// 当 Node 用的程序：Helper 程序（不在程序坞里冒图标），找不到就用主程序。
function nodeBinary() {
  const exe = path.basename(process.execPath);
  const helper = path.join(path.dirname(process.execPath), '..', 'Frameworks', `${exe} Helper.app`, 'Contents', 'MacOS', `${exe} Helper`);
  return fs.existsSync(helper) ? helper : process.execPath;
}
const asNode = (extra = {}) => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extra });

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function waitReady(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url + '/api/perf', { headers: keyCookie, signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
function fail(title, detail) {
  log(`${title}: ${detail}`);
  if (SMOKE) { console.log(JSON.stringify({ ok: false, error: title, detail })); app.exit(1); return; }
  dialog.showErrorBox(title, `${detail}\n\n日志：${logFile()}`);
  app.exit(1);
}

// 引擎只认带钥匙的请求（lib/local-auth.mjs）：每次启动现生成一把，经环境变量交给引擎，窗口的 cookie 由这里设好；不写进任何文件。
const localKey = crypto.randomBytes(32).toString('hex');
const keyCookie = { cookie: `offercrew_key=${localKey}` };

async function startEngine() {
  const node = nodeBinary();
  const linked = spawnSync(node, [path.join(engine, 'bin/data-root.mjs'), dataDir], { env: asNode(), encoding: 'utf8', timeout: 30000 });
  let r = null; try { r = JSON.parse(String(linked.stdout).trim().split('\n').pop()); } catch {}
  if (r?.code === 'data_newer') return newerData(r);
  if (!r?.ok) return fail(`${BRAND} 没法准备数据目录`, r?.error || String(linked.stderr || linked.error || '未知错误').slice(0, 400));
  const shim = writeNodeShim({ dataDir, nodeBinary: node });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = asNode({ RADAR_ROOT: dataDir, RADAR_SCHEDULER: 'app', RADAR_LOCAL_KEY: localKey, PATH: `${shim}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}` });
  fs.mkdirSync(path.join(dataDir, 'runs/desktop'), { recursive: true });
  const out = fs.openSync(path.join(dataDir, 'runs/desktop/engine.log'), 'a');
  supervisor = superviseService({
    start: () => (engineChild = spawn(node, [path.join(engine, 'bin/serve.mjs'), '--port', String(port)], { cwd: dataDir, env, stdio: ['ignore', out, out] })),
    onState: (s) => { log(`engine ${s.state}${s.reason ? ' · ' + s.reason : ''}${s.delay_ms ? ` · retry in ${s.delay_ms} ms` : ''}`); if (s.state === 'gave_up' && !quitting) fail(`${BRAND} 的引擎反复退出，已停止重启`, `最后一次：${s.reason}。引擎日志：${path.join(dataDir, 'runs/desktop/engine.log')}`); },
  });
  if (!(await waitReady(base))) return fail(`${BRAND} 的引擎没有启动`, `30 秒内没有响应。引擎日志：${path.join(dataDir, 'runs/desktop/engine.log')}`);
  log(`engine ready on ${base} (data ${dataDir}${sandbox ? ', sandbox' : ''})`);
  return true;
}

// 从 App 里点开的外部链接（第 4 轮开箱 F10）：交给引擎，招聘网站在专用 Chrome 里开（lib/open-where.mjs）；引擎说交给系统
// （你自己账号的登录、我们的网站、下载页，或者专用 Chrome 打不开——那时引擎记一笔「换了」），或者引擎没回话，才交给你平时用的浏览器。
let engineToken = null;
async function engineCall(p, body) {
  for (let i = 0; i < 2; i++) {
    if (!engineToken) engineToken = (await (await fetch(base + '/api/session', { headers: keyCookie })).json()).token;
    const r = await fetch(base + p, { method: 'POST', headers: { ...keyCookie, origin: base, 'content-type': 'application/json', 'x-radar-token': engineToken }, body: JSON.stringify(body) });
    if (r.status === 403) { engineToken = null; continue; } // 引擎重启过，口令换了
    return r.json();
  }
  throw Error('engine refused');
}
async function openOutside(url) {
  if (!/^https?:/i.test(url)) return shell.openExternal(url);
  try { const r = await engineCall('/api/open-url', { url, browse: true }); if (r?.open_in && r.open_in !== 'system') return; }
  catch (e) { log(`open in 专用 Chrome failed: ${e?.message || e}`); }
  shell.openExternal(url);
}

async function createWindow() {
  await session.defaultSession.cookies.set({ url: base, name: 'offercrew_key', value: localKey, httpOnly: true, sameSite: 'strict' });
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 960, minHeight: 640, show: false, title: BRAND,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const page = win;
  pageRecovery = watchPage({ window: page, base, log, isQuitting: () => quitting,
    showMessageBox: options => dialog.showMessageBox(page, options) });
  page.once('closed', () => { if (win === page) { win = null; pageRecovery = null; } });
  const origin = new URL(base).origin;
  win.webContents.setWindowOpenHandler(({ url }) => { if (new URL(url).origin !== origin) { openOutside(url); return { action: 'deny' }; } return { action: 'allow' }; });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) { e.preventDefault(); openOutside(url); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  if (!SMOKE) win.once('ready-to-show', () => win.show());
  return win.loadURL(base + '/');
}

async function reopenPage() {
  if (!base || quitting) return;
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      if (win && !win.isDestroyed()) win.destroy();
      await createWindow();
    }
    else await pageRecovery.reopen();
    showWindow();
  } catch (error) {
    log(`page reopen-window-failed ${error?.code || 'unknown'}`);
    if (!quitting) dialog.showErrorBox('页面暂时打不开', '可以稍后在“显示”菜单里重新打开页面。');
  }
}

// 下一轮周期的时间（按本机时间，照 lib/app-schedule.mjs 的表）。
function nextCycle(now = new Date()) {
  const times = APP_SCHEDULE.find((j) => j.name === 'cycle')?.times || [];
  for (let d = 0; d < 2; d++) for (const t of times) {
    const [h, m] = t.split(':').map(Number), at = new Date(now); at.setDate(at.getDate() + d); at.setHours(h, m, 0, 0);
    if (at > now) return `${d ? '明天 ' : ''}${t}`;
  }
  return null;
}
const loginItemOn = () => (sandbox ? fakeLoginItem : app.getLoginItemSettings().openAtLogin);
function setLoginItem(on) {
  if (sandbox) { fakeLoginItem = !!on; log(`sandbox: login item not registered (would be ${on ? 'on' : 'off'})`); return fakeLoginItem; }
  app.setLoginItemSettings({ openAtLogin: !!on });
  return loginItemOn();
}
function refreshTray() {
  if (!tray) return;
  const next = nextCycle();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开 ${BRAND}`, click: showWindow },
    { label: '跟团队说', accelerator: hotkey || undefined, click: summonTalk },
    { type: 'separator' },
    ...(updateReady ? [{ label: '重启以更新', sublabel: updateReady, click: installUpdate }] : []),
    ...(updatesOn() ? [{ label: '检查更新…', sublabel: checkText(updateCheck, app.getVersion()) || undefined, enabled: updateCheck.state !== 'checking', click: () => checkFromTray() }] : []),
    ...(updateReady || updatesOn() ? [{ type: 'separator' }] : []),
    ...(next ? [{ label: `下一轮：${next}`, enabled: false }] : []),
    ...(sandbox ? [{ label: '演示 / 沙盒模式：不会发出任何东西', enabled: false }] : []),
    { label: '开机自动启动', type: 'checkbox', checked: loginItemOn(), click: (i) => { setLoginItem(i.checked); refreshTray(); } },
    { label: '打开数据文件夹', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: `退出 ${BRAND}`, click: () => app.quit() },
  ]));
}
function showWindow() { if (!win) return; win.show(); win.focus(); app.focus({ steal: true }); }
async function summonTalk() {
  showWindow();
  const opened = await win.webContents.executeJavaScript('window.OfferCrew?.openTalk ? (window.OfferCrew.openTalk(), true) : false').catch(() => false);
  if (!opened) win.loadURL(base + '/#command?talk=1');
}
function registerHotkey(wanted) {
  globalShortcut.unregisterAll();
  const r = pickHotkey({ wanted, register: (k) => { try { return globalShortcut.register(k, summonTalk); } catch { return false; } } });
  hotkey = r.key;
  log(`hotkey ${hotkey || 'none'} (tried ${r.tried.join(', ')})`);
  return r;
}

// 正式签名的安装包才查更新（build.mjs --sign 在 package.json 里写 offercrew.updates）；临时签名的装不上，沙盒和自检也不查。
// 本机试验：OFFERCREW_UPDATE_URL 指向这台电脑（wrangler dev 发的 /updates/mac/）时改从那里查，沙盒里也查；别的地址不认（lib/update-feed.mjs）。
const shellMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).offercrew || {}; } catch { return {}; } })();
const localFeed = localFeedOverride();
const updatesOn = () => app.isPackaged && !!shellMeta.updates && !SMOKE && (!sandbox || !!localFeed);
// 「下好了」以 Squirrel 拿到新版为准：electron-updater 下完 zip 先报一次 update-downloaded，再把 zip 交给系统的 Squirrel；
// Squirrel 也报 update-downloaded 时，新版才算放好了——这时退出 App（哪种退法都行，包括 will-quit 里的 app.exit），
// Squirrel 的 ShipIt 等进程结束就把新版换进去，下次打开就是新版（autoInstallOnAppQuit，默认开着）。
// 只在这之后才亮「重启以更新」：早一步亮、你马上退出的话，新版还没交给 Squirrel，这次就装不上。
function setUpdateReady(version) {
  updateReady = version;
  log(`update ${version} ready: installs on quit, or now from 重启以更新`);
  setCheck({ state: 'ready', version });
}
// 查更新到哪一步了（desktop/lib/update-status.mjs 说成一句话）：菜单栏「检查更新」下面那行小字、「设置 → 关于」里那一行都用它。
function setCheck(next) {
  updateCheck = { manual: updateCheck.manual, ...next };
  refreshTray();
  win?.webContents.send('desktop:update', updateView());
}
const updateView = () => ({ current: app.getVersion(), ready: updateReady, can_check: updatesOn(), check: { state: updateCheck.state, version: updateCheck.version || null, percent: updateCheck.percent ?? null, text: checkText(updateCheck, app.getVersion()) } });
async function downloadUpdateNow() {
  if (updatesOn() && downloadUpdate) await downloadUpdate();
  return updateView();
}
// 你点的「检查更新」：马上查，不管离上次多久；正在查就等那一次；已经下好或正在下就不再查，照实说。
async function checkUpdateNow() {
  if (!updatesOn()) return { ...updateView(), check: { state: 'off', version: null, text: checkText({ state: 'off' }) } };
  if (!checkUpdates) return updateView();
  updateCheck = { ...updateCheck, manual: true };
  await checkUpdates('manual');
  return updateView();
}
async function checkFromTray() {
  const v = await checkUpdateNow();
  if (v.ready) {
    const { response } = await dialog.showMessageBox({ type: 'info', buttons: ['重启以更新', '稍后'], defaultId: 0, cancelId: 1, message: `${v.ready} 已下好`, detail: '不重启的话，下次退出时也会装上。' });
    if (response === 0) installUpdate();
    return;
  }
  if (v.check.state === 'available') {
    const { response } = await dialog.showMessageBox({ type: 'info', buttons: ['下载更新', '稍后'], defaultId: 0, cancelId: 1, message: v.check.text, detail: '下载进度会显示在侧栏。下好以后可以重启以更新。' });
    if (response === 0) { showWindow(); downloadUpdateNow(); }
    return;
  }
  const text = v.check.text;
  if (text) await dialog.showMessageBox({ type: v.check.state === 'error' ? 'warning' : 'info', buttons: ['好'], message: text, ...(v.check.state === 'downloading' ? { detail: '下好以后，菜单栏和侧栏会出现「重启以更新」。' } : {}) });
}
async function startUpdates() {
  if (!updatesOn()) return;
  const mod = await import('electron-updater');
  updater = mod.autoUpdater || mod.default.autoUpdater;
  updater.logger = { info: (m) => log(`update: ${m}`), warn: (m) => log(`update warn: ${m}`), error: (m) => log(`update error: ${m}`), debug: () => {} };
  downloadUpdate = wireUpdateDownload(updater, squirrel, { getCheck: () => updateCheck, setCheck, onReady: setUpdateReady, log });
  if (localFeed) { updater.setFeedURL({ provider: 'generic', url: localFeed, useMultipleRangeRequest: false }); log(`update feed (local test): ${localFeed}`); }
  // 启动时、每小时、窗口回到前台（离上次 30 分钟以上）各查一次（desktop/lib/update-pace.mjs）。
  const check = checkUpdates = pacedCheck(() => updateReady || ['downloading', 'preparing'].includes(updateCheck.state) ? null : updater.checkForUpdates().catch((e) => log(`update check failed: ${e?.message || e}`)));
  check('start');
  setInterval(() => check('timer'), EVERY_MS).unref();
  app.on('browser-window-focus', () => check('focus'));
}
// 现在就装：先停引擎（它在写数据），再让 Squirrel 换新版并重新打开。
async function installUpdate() {
  if (!updater || !updateReady) return false;
  quitting = true;
  const child = engineChild;
  supervisor?.stop();
  if (child && child.exitCode === null) await new Promise((r) => { child.once('exit', r); setTimeout(r, 4000).unref(); });
  updater.quitAndInstall();
  return true;
}
// 这个 App 的版本：和包里引擎的 package.json 是同一个（build.mjs 两边写的是同一个版本号）；开发时 app.getVersion() 是 Electron 的版本，所以读引擎的。
const myVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8')).version; } catch { return app.getVersion(); } })();
const bundlePath = path.resolve(process.execPath, '..', '..', '..');
const installedPath = path.join('/Applications', path.basename(bundlePath));
// 等这个进程退出以后再打开另一份（两份用的是同一个数据目录，同一时间只能开一个），然后自己退出。
function openOtherAndQuit(appPath) {
  spawn('/bin/sh', ['-c', `while /bin/kill -0 ${process.pid} 2>/dev/null; do /bin/sleep 0.1; done; /usr/bin/open "$0"`, appPath], { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}
// 这些数据是更新的版本写的（bin/data-root.mjs 报 data_newer，什么都没动）：说清楚，不启动引擎。
// 「应用程序」里那一份够新、又不是这一份，就给一个直接打开它的按钮。
async function newerData(r) {
  log(`data written by ${r.data_version}, this app is ${r.app_version}: engine not started`);
  if (SMOKE) return fail('smoke: data is newer', r.error);
  const there = bundlePath !== installedPath ? bundleVersion(installedPath) : null;
  const canOpen = there && moveDecision(r.data_version, there) === 'keep';
  const { response } = await dialog.showMessageBox({
    type: 'warning', buttons: canOpen ? [`打开「应用程序」里的 ${there}`, '退出'] : ['退出'], defaultId: 0, cancelId: canOpen ? 1 : 0,
    message: `这些数据是 ${BRAND} ${r.data_version} 写的，比这个 App 新`,
    detail: `这个 App 是 ${r.app_version}，打开新版才能接着用。数据没有被动过。`,
  });
  if (canOpen && response === 0) openOtherAndQuit(installedPath); else app.exit(0);
  return false;
}
// 从 DMG 或「下载」里直接打开时，问一次要不要移到「应用程序」（移过去后会自动重开）。
// 不拿旧版顶掉新版（主会话 10-03，第 4 轮出过一次）：「应用程序」里那一份一样新或更新，就不换，打开那一份；
// 那一份更旧才换，对话框里写清两个版本号。返回 true = 已经交给另一份或正在搬，调用方不要再启动引擎
// （以前搬完还接着跑，引擎的路径已经被搬走，弹一个出错框挂在那里，第 4 轮那次挂了 13 分钟）。
async function offerMoveToApplications() {
  if (!app.isPackaged || SMOKE || sandbox || app.isInApplicationsFolder()) return false;
  const there = bundleVersion(installedPath), decision = moveDecision(myVersion, there);
  if (decision === 'keep') {
    log(`Applications has ${there}, this copy is ${myVersion}: not replaced, opening that one`);
    await dialog.showMessageBox({
      type: 'info', buttons: ['打开'], defaultId: 0,
      message: `「应用程序」里已经有 ${BRAND} ${there}${there === myVersion ? '' : '，比这个新'}`,
      detail: `不会用这一份（${myVersion}）替换它，现在打开「应用程序」里的那一份。`,
    });
    openOtherAndQuit(installedPath);
    return true;
  }
  if (prefs().skipMoveToApplications) return false;
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question', buttons: [decision === 'replace' ? `换成 ${myVersion}` : '移到「应用程序」', '以后再说'], defaultId: 0, cancelId: 1,
    message: `把 ${BRAND} 移到「应用程序」文件夹？`,
    detail: decision === 'replace' ? `「应用程序」里现在是 ${there}，会换成这一份 ${myVersion}，旧的放进废纸篓。放在别处，自动更新会失败。` : '放在别处，自动更新会失败。',
    checkboxLabel: '不再询问',
  });
  if (response !== 0) { if (checkboxChecked) savePrefs({ skipMoveToApplications: true }); return false; }
  // 问完到真的搬之间，那里可能刚装上一份更新的：搬之前再看一次。
  const conflictHandler = () => moveDecision(myVersion, bundleVersion(installedPath)) !== 'keep';
  try {
    if (app.moveToApplicationsFolder({ conflictHandler })) return true;
    if (moveDecision(myVersion, bundleVersion(installedPath)) === 'keep') { openOtherAndQuit(installedPath); return true; }
  } catch (e) { log(`move to Applications failed: ${e?.message || e}`); }
  return false;
}

// 页面桥接（preload.cjs）：只回应来自本地工作台的页面。
const fromUs = (e) => { try { return !!base && new URL(e.senderFrame.url).origin === new URL(base).origin; } catch { return false; } };
ipcMain.on('desktop:version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('desktop:update:get', (e) => (fromUs(e) ? updateView() : null));
ipcMain.handle('desktop:update:download', (e) => (fromUs(e) ? downloadUpdateNow() : null));
ipcMain.handle('desktop:update:install', (e) => fromUs(e) && installUpdate());
ipcMain.handle('desktop:update:check', (e) => (fromUs(e) ? checkUpdateNow() : null));
ipcMain.handle('desktop:loginItem:get', (e) => fromUs(e) && loginItemOn());
ipcMain.handle('desktop:loginItem:set', (e, on) => { if (!fromUs(e)) return false; const v = setLoginItem(on); refreshTray(); return v; });
ipcMain.handle('desktop:hotkey:get', (e) => (fromUs(e) ? hotkey || '' : ''));
ipcMain.handle('desktop:hotkey:set', (e, accel) => {
  if (!fromUs(e)) return { ok: false, error: 'not allowed' };
  const before = hotkey, r = registerHotkey(accel);
  if (r.key === accel) { savePrefs({ hotkey: accel }); refreshTray(); return { ok: true }; }
  registerHotkey(before);
  return { ok: false, error: `${accel} 用不了（可能被别的 App 占用，或者是切换输入法的键），还在用 ${before || '无'}` };
});

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
// 退出时把专用 Chrome 也关掉（J 线 10-02，lib/browser-host.mjs stopHost）：登录状态存在档案里，下次要用再起。
const stopBrowser = () => { if (dataDir) spawnSync(nodeBinary(), [path.join(engine, 'bin/browser.mjs'), '--stop'], { env: asNode({ RADAR_ROOT: dataDir }), timeout: 6000 }); };
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (!engineChild || engineChild.exitCode !== null) return stopBrowser();
  e.preventDefault();
  const done = () => { stopBrowser(); app.exit(0); };
  engineChild.once('exit', done);
  setTimeout(done, 4000).unref();
  supervisor?.stop();
});
powerMonitor.on('resume', () => log('mac woke up (missed scheduled runs are caught up by the engine)'));

app.whenReady().then(async () => { try {
  // 开发外壳没有打包时的 CFBundleIconFile；使用正式 .icns 内同一张 PNG，不改 Electron 或已签名 App。
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(here, 'assets', 'OfferCrew.png'));
  const smokeTimer = SMOKE ? setTimeout(() => fail('smoke timeout', '45 秒内没有完成'), 45000) : null;
  if (await offerMoveToApplications()) return;
  if (!(await startEngine())) return;
  // 菜单栏图标：单色模板图（文件名以 Template 结尾，系统按菜单栏深浅自动反色；@2x 自动取用）。
  if (!SMOKE) { tray = new Tray(nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png'))); tray.setToolTip(BRAND); }
  registerHotkey(prefs().hotkey || null);
  await createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu({ brand: BRAND, packaged: app.isPackaged, updates: updatesOn(), reopen: reopenPage, settings: () => { win?.show(); win?.focus(); win?.webContents.executeJavaScript("location.hash = '#settings'").catch(e => log(`open settings: ${e.message}`)); }, update: () => checkFromTray() })));
  refreshTray();
  startUpdates().catch((e) => log(`updates off: ${e?.message || e}`));
  if (SMOKE) {
    const title = await win.webContents.executeJavaScript('document.title').catch(() => '');
    // 引擎的依赖都在：「开始使用」页要读 YAML（第三方库 yaml），这里请求一次它的接口。
    const setup = await fetch(base + '/api/setup', { headers: keyCookie }).then((r) => r.status).catch(() => 0);
    clearTimeout(smokeTimer);
    if (setup !== 200) return fail('smoke: /api/setup failed', `status ${setup}`);
    // 快捷键唤起的就是 summonTalk()：调用一次，确认右侧栏打开了（web/panel.js 打开时给 body 加 pn-open）。
    await summonTalk();
    let talk = false;
    for (let i = 0; i < 25 && !talk; i++) { await new Promise((r) => setTimeout(r, 200)); talk = await win.webContents.executeJavaScript("document.body.classList.contains('pn-open')").catch(() => false); }
    if (!talk) return fail('smoke: the talk panel did not open', 'summonTalk() ran but body.pn-open never appeared');
    console.log(JSON.stringify({ ok: true, port: Number(new URL(base).port), data_dir: dataDir, engine, hotkey, sandbox, title, setup, talk_panel: talk, updates: !!shellMeta.updates, bridge: await win.webContents.executeJavaScript('typeof window.OfferCrewDesktop').catch(() => '') }));
    app.quit();
  }
} catch (e) { fail(`${BRAND} 启动出错`, String(e?.stack || e).slice(0, 600)); } });
