// 兼容层（和 ego 解耦，第 2 批）：原来写给 ego-browser 的脚本，原样在专用 Chrome（lib/browser-host.mjs）上跑。
//
// 脚本用的是 ego 的写法（见 ego-browser 技能的 API 参考）：
//   全局函数  taskSpace(名字或编号)、takeOverTaskSpace、claimTaskSpace、listTaskSpaces、profiles；
//   任务空间  spaceId、name、ownership、page(标签)、userPage()、pages()、tabs()、newPage()、adopt()、release()、
//             waitForControl()、handOff()、finish({ keep })、cdp()；
//   页面      goto、reload、url、title、info、evaluate、waitFor*、click / fill / press……（回执带弹出的新页和弹窗）、
//             setInputFiles、waitForFileChooser、screenshot、snapshot、fetch、cdp、mouse、keyboard；
//   选择器    loc=css:…、loc=role:…[name="…"]、loc=href:…、text=…、xpath=…、原样的 CSS（css=、:has-text、>> nth=N）。
// 这里用 Playwright 连上专用 Chrome（connectOverCDP，noDefaults：不改下载、焦点、配色这些浏览器设置）一一实现。
//
//   - 一个任务空间对应一个窗口：第一页开一个后台窗口（不抢焦点），之后的页尽量在同一个窗口里开新标签。
//   - 空间登记在 state/browser-spaces.json（编号、名字、归谁、页面标签 → 标签页 id），跨进程、跨轮次都认得。
//   - 交给你（handOff）以后空间归你：再动它的页面之前必须 takeOverTaskSpace，否则报 agentDelegatedToUser（和 ego 一样）。
//   - 点击、填写这类动作默认等 3 秒（ego 的默认）；页面上的弹窗不自动点掉，回执里带回来，脚本用 acceptDialog / dismissDialog。
//   - 同一个网站同一时间只有一个脚本（lib/browser-sites.mjs 的网站锁）；打开页面碰到验证页就停（site_check:<网站>），
//     这个网站一小时内不再自动打开，验证由你来做。
//   - 不躲检测：专用 Chrome 本身带着 --enable-automation，这里也不改指纹、不伪装任何东西。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file } from './store.mjs';
import { waitForLock } from './lock.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';
import { ensureHost, CHROME_NAME } from './browser-host.mjs';
import { siteOf, siteHold, holdSite, lockSite, releaseSites, VERIFY_PAGE } from './browser-sites.mjs';
import { noteSwallowed } from './swallow.mjs';

export const SPACES_PATH = 'state/browser-spaces.json';
// Playwright 连上去时要在临时目录里建一个文件夹；沙盒不让写系统临时目录时，换到数据目录的 private/tmp。
function writableTmp() {
  try { fs.accessSync(os.tmpdir(), fs.constants.W_OK); fs.rmdirSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'))); return; } catch {} // 兜底：系统临时目录写不了，下面换到数据目录的 private/tmp
  const dir = file('private/tmp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = dir;
}
const ACTION_TIMEOUT = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 选择器：ego 的写法 → Playwright 的写法 ─────────────────────────────────────────────────
export function toPwSelector(selector) {
  const s = String(selector ?? '').trim();
  if (!s) throw Error('selector_empty');
  let m;
  if ((m = /^@(\d+)$/.exec(s)) || (m = /^ref=(\d+)$/.exec(s))) return `css=[data-oc-ref="${m[1]}"]`;
  if (s.startsWith('loc=css:')) return `css=${s.slice(8)}`;
  if (s.startsWith('loc=role:')) return `role=${s.slice(9)}`;
  if (s.startsWith('loc=href:')) return `css=a[href*=${JSON.stringify(s.slice(9))}]`;
  if (/^(text|xpath|css|role)=/.test(s)) return s;
  if (/^\(?\/\//.test(s)) return `xpath=${s}`;
  return `css=${s}`;
}

// ── 空间登记 ───────────────────────────────────────────────────────────────────────────────
function loadSpaces() {
  try { const r = JSON.parse(fs.readFileSync(file(SPACES_PATH), 'utf8')); return { next_id: r.next_id || 1, spaces: r.spaces || {} }; }
  catch { return { next_id: 1, spaces: {} }; }
}
function saveSpaces(reg) {
  const dest = file(SPACES_PATH);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.${process.pid}.tmp`, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(`${dest}.${process.pid}.tmp`, dest);
}
// 改登记要锁住（几个脚本可能同时在跑）。fn 改 reg，返回值原样带回。
async function editSpaces(fn) {
  const release = await waitForLock('browserspaces', { timeout: 30000, interval: 50 });
  try { const reg = loadSpaces(); const out = await fn(reg); saveSpaces(reg); return out; } finally { release(); }
}

class DialogInfo {
  constructor(d) { this.type = d.type(); this.message = String(d.message()).slice(0, 500); this.defaultValue = d.defaultValue?.() || ''; }
}

// ── 运行时：一个脚本一个 ───────────────────────────────────────────────────────────────────
export class CompatRuntime {
  constructor({ browser, context, host }) {
    Object.assign(this, { browser, context, host, ids: new WeakMap(), wrapped: new WeakMap(), dialogs: new WeakMap(), _session: null });
  }
  // 页面弹窗按标签页记（同一页可能被包成几个页面对象）：不自动点掉，等脚本 acceptDialog / dismissDialog。
  watch(p) {
    if (!p || p.__ocWatched) return p;
    p.__ocWatched = true;
    p.on('dialog', d => this.dialogs.set(p, d));
    return p;
  }
  dialogOf(p) { return p ? this.dialogs.get(p) || null : null; }
  static async open({ playwright = null, hostOptions = {} } = {}) {
    if (sandboxed()) throw Error(sandboxSkip(`在${CHROME_NAME}里跑浏览器脚本`));
    const host = await ensureHost({ existingOnly: process.env.RADAR_BROWSER_EXISTING_ONLY === '1', ...hostOptions });
    writableTmp();
    const pw = playwright || await import('playwright-core');
    const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${host.port}`, { noDefaults: true, timeout: 30000 });
    const context = browser.contexts()[0];
    return new CompatRuntime({ browser, context, host });
  }
  async close() { await this.browser.close().catch(() => {}); } // 兜底：连接已经断了，关不掉不影响
  async session() { if (!this._session) this._session = await this.browser.newBrowserCDPSession(); return this._session; }
  async targetIdOf(p) {
    if (this.ids.has(p)) return this.ids.get(p);
    const s = await this.context.newCDPSession(p);
    try { const id = (await s.send('Target.getTargetInfo')).targetInfo.targetId; this.ids.set(p, id); return id; }
    finally { await s.detach().catch(() => {}); } // 兜底：会话已经随页面断了
  }
  async liveTargets() {
    const { targetInfos = [] } = await (await this.session()).send('Target.getTargets');
    return new Map(targetInfos.filter(t => t.type === 'page').map(t => [t.targetId, t]));
  }
  async pageByTarget(targetId, { timeout = 10000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const p of this.context.pages()) if (!p.isClosed() && await this.targetIdOf(p).catch(() => null) === targetId) return p; // 兜底：页面已经关了就拿不到 id，跳过它
      if (Date.now() > deadline) throw Error(`page_not_found:${targetId}`);
      await sleep(50);
    }
  }
  async windowOf(targetId) { try { return (await (await this.session()).send('Browser.getWindowForTarget', { targetId })).windowId; } catch { return null; } } // 兜底：窗口已经没了就是 null，调用方当找不到
  // 新开一个后台窗口（不抢焦点），返回里面那一页。
  async newWindowPage() {
    const { targetId } = await (await this.session()).send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    return this.pageByTarget(targetId);
  }
  // 自动只读任务不进标签栏、不建可见窗口。旧 Chrome 不支持时直接失败，绝不回退成弹窗。
  async newHiddenPage() {
    const { targetId } = await (await this.session()).send('Target.createTarget', { url: 'about:blank', hidden: true, background: true });
    return this.pageByTarget(targetId);
  }
  // 在 anchor 那一页所在的窗口里开一个新标签（从那一页 window.open，标签就落在同一个窗口）；不成就开新窗口。
  async newTabNear(anchor) {
    if (!anchor || anchor.isClosed()) return this.newWindowPage();
    const nonce = `oc-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const s = await this.context.newCDPSession(anchor).catch(() => null); // 兜底：拿不到那一页的会话就开新窗口
    if (s) {
      try { await s.send('Runtime.evaluate', { expression: `Window.prototype.open.call(window, ${JSON.stringify(`about:blank#${nonce}`)}, '_blank', 'noopener')`, userGesture: true }); } catch {} // 兜底：window.open 被页面拦了，下面等不到新标签就开新窗口
      await s.detach().catch(() => {}); // 兜底：会话已经随页面断了
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const p = this.context.pages().find(x => !x.isClosed() && x.url().endsWith(`#${nonce}`));
        if (p) return p;
        await sleep(50);
      }
    }
    return this.newWindowPage();
  }
  globals() {
    const rt = this;
    return {
      taskSpace: (nameOrId, options) => rt.taskSpace(nameOrId, options),
      takeOverTaskSpace: id => rt.takeOver(id, 'takeover'),
      claimTaskSpace: id => rt.takeOver(id, 'claim'),
      listTaskSpaces: () => rt.listSpaces(),
      profiles: async () => [{ id: 'default', name: CHROME_NAME, default: true }],
      help: () => `${CHROME_NAME}：ego-browser 的兼容写法（taskSpace、page.goto / evaluate / click / fill……）。`,
    };
  }
  // 空间还在不在：登记的页面里至少有一个标签页还开着。刚建、还没开页的空间留两分钟（别的进程正要用它）。
  async pruneSpaces() {
    const live = await this.liveTargets(), now = Date.now();
    return editSpaces(reg => {
      for (const [id, s] of Object.entries(reg.spaces)) {
        const pages = Object.values(s.pages || {});
        if (pages.some(t => live.has(t))) continue;
        if (!pages.length && now - (Date.parse(s.created_at || '') || 0) < 120000) continue;
        delete reg.spaces[id];
      }
      return reg;
    });
  }
  async listSpaces() {
    const reg = await this.pruneSpaces();
    return Object.values(reg.spaces).map(s => ({ id: s.id, spaceId: s.id, name: s.name, ownership: s.ownership, createdBy: s.createdBy || 'agent', pages: Object.keys(s.pages || {}), created_at: s.created_at || null }));
  }
  async taskSpace(nameOrId, { hidden = false } = {}) {
    const reg = await this.pruneSpaces();
    if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId ?? ''))) {
      const s = reg.spaces[String(Number(nameOrId))];
      if (!s) throw Error(`task_space_not_found:${nameOrId}`);
      if (hidden && !s.hidden) throw Error(`task_space_not_hidden:${nameOrId}`);
      return new CompatSpace(this, s.id, s.name, s.ownership);
    }
    const name = String(nameOrId || 'OfferCrew');
    const mine = Object.values(reg.spaces).filter(s => s.name === name && s.ownership === 'agent' && !!s.hidden === !!hidden).sort((a, b) => b.id - a.id)[0];
    if (mine) return new CompatSpace(this, mine.id, mine.name, mine.ownership);
    const s = await editSpaces(r => {
      const id = r.next_id++;
      r.spaces[id] = { id, name, ownership: 'agent', createdBy: 'agent', created_at: new Date().toISOString(), pages: {}, next: 1, ...(hidden ? { hidden: true } : {}) };
      return r.spaces[id];
    });
    return new CompatSpace(this, s.id, s.name, s.ownership);
  }
  async takeOver(id, how) {
    const reg = await this.pruneSpaces(), s = reg.spaces[String(Number(id))];
    if (!s) throw Error(`task_space_not_found:${id}`);
    await editSpaces(r => { if (r.spaces[s.id]) r.spaces[s.id].ownership = 'agent'; });
    const space = new CompatSpace(this, s.id, s.name, 'agent');
    // 接管那一刻你正在看的那一页（userPage）：这个空间窗口里看得见的那个标签。
    space._userPage = await space._activeTab().catch(() => null); // 兜底：拿不到当前看着的那一页就不记，接管照常
    space.claimedBy = how;
    return space;
  }
  // 给一个 Playwright 页面包上 ego 的页面接口（同一页只包一次：弹窗状态跟着它）。
  wrap(space, label, p) {
    this.watch(p);
    let w = this.wrapped.get(p);
    if (!w) { w = new CompatPage(space, label, p); this.wrapped.set(p, w); }
    else if (label && !w.label) w.label = label;
    return w;
  }
}

// ── 任务空间 ───────────────────────────────────────────────────────────────────────────────
class CompatSpace {
  constructor(rt, id, name, ownership) { Object.assign(this, { rt, spaceId: id, name, ownership, _userPage: null }); }
  _record() { return loadSpaces().spaces[String(this.spaceId)] || null; }
  // 说法里带 user control：调用方（bin/discover-human-browser.mjs 等）按 /user.*control/ 认「你接管了，停下」。
  _guard() { if (this.ownership && this.ownership !== 'agent') throw Error(`agentDelegatedToUser: task space ${this.spaceId} is under user control; takeOverTaskSpace(${this.spaceId}) first`); }
  page(label = 'p1') { return new CompatPage(this, String(label), null); }
  userPage() { return this._userPage; }
  async _livePages() {
    const rec = this._record(), live = await this.rt.liveTargets(), out = [];
    for (const [label, targetId] of Object.entries(rec?.pages || {})) if (live.has(targetId)) out.push({ label, targetId });
    return out;
  }
  async _pwPage(label, { create = false } = {}) {
    const rec = this._record();
    if (!rec) throw Error(`task_space_not_found:${this.spaceId}`);
    const targetId = rec.pages?.[label];
    if (targetId && (await this.rt.liveTargets()).has(targetId)) return this.rt.pageByTarget(targetId);
    if (!create) throw Error(`page_not_found:${label}`);
    // 新空间的 p1、或者被关掉的那一页：在空间的窗口里新开（空间里一页都没有了就开新窗口）。
    const anchor = (await this._livePages())[0];
    const p = rec.hidden ? await this.rt.newHiddenPage() : anchor ? await this.rt.newTabNear(await this.rt.pageByTarget(anchor.targetId)) : await this.rt.newWindowPage();
    await this._register(p, label);
    return p;
  }
  async _register(p, label = null) {
    const targetId = await this.rt.targetIdOf(p);
    const name = await editSpaces(reg => {
      const s = reg.spaces[String(this.spaceId)];
      if (!s) throw Error(`task_space_not_found:${this.spaceId}`);
      s.pages ||= {};
      const known = Object.entries(s.pages).find(([, t]) => t === targetId)?.[0];
      if (known) return known;
      let l = label;
      if (!l) { s.next = Math.max(s.next || 1, ...Object.keys(s.pages).map(k => Number(/^p(\d+)$/.exec(k)?.[1] || 0) + 1)); l = `p${s.next++}`; }
      s.pages[l] = targetId;
      return l;
    });
    return { label: name, targetId, page: this.rt.wrap(this, name, p) };
  }
  async pages() {
    const out = [];
    for (const { label, targetId } of await this._livePages()) out.push(this.rt.wrap(this, label, await this.rt.pageByTarget(targetId)));
    return out;
  }
  async _activeTab() {
    const tabs = await this.tabs();
    return (tabs.find(t => t.active) || tabs[0])?.page || null;
  }
  // 这个空间窗口里的所有标签：登记过的（有标签名）和没登记的（你自己在这个窗口里开的）。
  async tabs() {
    const live = await this.rt.liveTargets(), managed = await this._livePages();
    const windows = new Set((await Promise.all(managed.map(m => this.rt.windowOf(m.targetId)))).filter(w => w != null));
    const byTarget = new Map(managed.map(m => [m.targetId, m.label]));
    const out = [];
    for (const [targetId, info] of live) {
      const label = byTarget.get(targetId) || null;
      if (!label && !(windows.size && windows.has(await this.rt.windowOf(targetId)))) continue;
      const p = await this.rt.pageByTarget(targetId).catch(() => null); // 兜底：标签页刚关了，跳过它
      if (!p) continue;
      const active = await p.evaluate(() => document.visibilityState === 'visible').catch(() => false); // 兜底：页面正在跳转读不到，当它不在前台
      out.push({ label, page: this.rt.wrap(this, label, p), targetId, title: info.title, url: info.url, active, openedBy: label ? 'agent' : 'unknown' });
    }
    return out;
  }
  async newPage() { this._guard(); const anchor = (await this._livePages())[0]; const p = this._record()?.hidden ? await this.rt.newHiddenPage() : anchor ? await this.rt.newTabNear(await this.rt.pageByTarget(anchor.targetId)) : await this.rt.newWindowPage(); return (await this._register(p)).page; }
  async adopt(page, { as = null } = {}) {
    this._guard();
    const p = page?._p ? await page._resolve() : page;
    return (await this._register(p, as)).page;
  }
  async release(label) {
    await editSpaces(reg => { const s = reg.spaces[String(this.spaceId)]; if (s?.pages) delete s.pages[label]; });
    return true;
  }
  async waitForControl({ interval = 1000, timeout = 60000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this._record()?.ownership === 'agent') { this.ownership = 'agent'; return true; }
      if (Date.now() > deadline) throw Error(`wait_for_control_timeout:${this.spaceId}`);
      await sleep(interval);
    }
  }
  // 交给你：空间归你，之后系统要动它得先接管。窗口不抢到前面（要你看的地方会另外拉到前面）。
  async handOff() {
    await editSpaces(reg => { const s = reg.spaces[String(this.spaceId)]; if (s) s.ownership = 'user'; });
    this.ownership = 'user';
    return { handedOff: true, spaceId: this.spaceId };
  }
  // 收尾：keep 里的页留着，别的登记过的页关掉；一页都不剩、窗口里也没有你自己的标签，空间就没了。
  async finish({ keep = [] } = {}) {
    this._guard();
    const all = await this._livePages(), keepAll = keep === 'all', keepSet = new Set(Array.isArray(keep) ? keep : []);
    const retained = [], closed = [];
    for (const { label, targetId } of all) {
      if (keepAll || keepSet.has(label)) { retained.push(label); continue; }
      await (await this.rt.session()).send('Target.closeTarget', { targetId }).catch(() => {}); // 兜底：标签页已经被关了
      closed.push(label);
    }
    await editSpaces(reg => {
      const s = reg.spaces[String(this.spaceId)];
      if (!s) return;
      for (const l of closed) delete s.pages[l];
      if (!retained.length) delete reg.spaces[String(this.spaceId)];
    });
    return { retained, closed };
  }
  async cdp(method, params = {}) { return (await this.rt.session()).send(method, params); }
}

// ── 页面 ───────────────────────────────────────────────────────────────────────────────────
class CompatPage {
  constructor(space, label, pwPage) {
    Object.assign(this, { space, label, _pw: pwPage, openedBy: 'agent' });
    if (pwPage) space.rt.watch(pwPage);
    const page = this;
    this.mouse = {
      click: async (x, y, o = {}) => { await (await page._p()).mouse.click(x, y, pick(o, ['button', 'clickCount', 'delay'])); return page._receipt(); },
      move: async (x, y, o = {}) => (await page._p()).mouse.move(x, y, pick(o, ['steps'])),
      down: async (o = {}) => (await page._p()).mouse.down(pick(o, ['button', 'clickCount'])),
      up: async (o = {}) => (await page._p()).mouse.up(pick(o, ['button', 'clickCount'])),
      wheel: async (dx, dy) => (await page._p()).mouse.wheel(dx, dy),
    };
    this.keyboard = {
      down: async k => (await page._p()).keyboard.down(k),
      up: async k => (await page._p()).keyboard.up(k),
      press: async (k, o = {}) => (await page._p()).keyboard.press(k, pick(o, ['delay'])),
      type: async (t, o = {}) => (await page._p()).keyboard.type(String(t), pick(o, ['delay'])),
      insertText: async t => (await page._p()).keyboard.insertText(String(t)),
      paste: async c => (await page._p()).keyboard.insertText(String(typeof c === 'object' && c ? c.text ?? '' : c ?? '')),
    };
  }
  get spaceId() { return this.space.spaceId; }
  get targetId() { return this._targetId || null; }
  get _dialog() { return this.space.rt.dialogOf(this._pw); }
  _clearDialog() { if (this._pw) this.space.rt.dialogs.delete(this._pw); }
  async _resolve() {
    if (this._pw && !this._pw.isClosed()) return this._pw;
    this._pw = this.space.rt.watch(await this.space._pwPage(this.label, { create: this.label === 'p1' }));
    return this._pw;
  }
  async _p() {
    this.space._guard();
    const p = await this._resolve();
    this._targetId ||= await this.space.rt.targetIdOf(p);
    return p;
  }
  async _receipt(popups = []) {
    const r = {};
    if (popups.length) r.popups = [];
    for (const pp of popups) { const reg = await this.space._register(pp); r.popups.push({ label: reg.label, targetId: reg.targetId }); }
    if (this._dialog) r.dialog = new DialogInfo(this._dialog);
    return r;
  }
  // 动作期间弹出来的新页：收下、登记成这个空间的新页（p2、p3……），回执里带上。
  // 动作弹出了确认框这类弹窗：页面停在那里等人回答，点击已经送到了，不再等动作「完成」，回执里带上弹窗（ego 的做法）。
  async _act(fn) {
    const p = await this._p(), popups = [], onPopup = x => popups.push(x);
    let onDialog;
    const dialog = new Promise(resolve => { onDialog = () => resolve('dialog'); p.on('dialog', onDialog); });
    p.on('popup', onPopup);
    try {
      const action = fn(p);
      action.catch(() => {}); // 兜底：先挂上，免得没人等时成了未处理的拒绝；结果在下面的 race 里看
      if (await Promise.race([action.then(() => 'done'), dialog]) === 'done') await sleep(popups.length ? 0 : 150);
    } finally { p.off('popup', onPopup); p.off('dialog', onDialog); }
    return this._receipt(popups);
  }
  _loc(p, selector) { return p.locator(toPwSelector(selector)); }

  async url() { return (await this._p()).url(); }
  // 弹窗开着时页面里的脚本都停着：标题、地址从浏览器那边读（不进页面），免得一直等。
  async _targetInfo() {
    await this._p();
    try { return (await (await this.space.rt.session()).send('Target.getTargetInfo', { targetId: this._targetId })).targetInfo; } catch { return null; } // 兜底：标签页已经没了就是 null
  }
  async title() {
    const p = await this._p();
    if (this._dialog) return (await this._targetInfo())?.title || '';
    return p.title();
  }
  async info() {
    const p = await this._p();
    if (this._dialog) { const t = await this._targetInfo(); return { url: t?.url || p.url(), title: t?.title || '', viewport: null, scroll: null, dialog: new DialogInfo(this._dialog) }; }
    const view = await p.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY } })).catch(() => ({ viewport: null, scroll: null }));
    return { url: p.url(), title: await p.title().catch(() => ''), viewport: p.viewportSize() || view.viewport, scroll: view.scroll, dialog: null }; // 兜底：拿不到标题就空着，只是少一条参考
  }
  // 打开页面：先排队（同一网站一个脚本）、看这个网站是不是正「先别碰」；打开后是验证页就停下（ego 那边是脚本自己看）。
  async goto(url, o = {}) {
    const p = await this._p(), site = siteOf(url), hold = siteHold(url);
    if (hold) throw Error(`site_check:${site} ${hold.reason === 'holds_unreadable' ? '「先别碰」的记录读不了，所有网站' : '网站要先验证，'}${Math.ceil((Date.parse(hold.until) - Date.now()) / 60000)} 分钟内不再自动打开${hold.url ? `（${hold.url}）` : ''}`);
    await lockSite(site);
    const r = await p.goto(String(url), { timeout: o.timeout ?? 30000, waitUntil: o.waitUntil || 'load', ...(o.referer ? { referer: o.referer } : {}) });
    if (await p.evaluate(`(${VERIFY_PAGE})()`).catch(e => { noteSwallowed('browser-compat.verifyPage', e, { member: 'scout', doing: '看打开的是不是验证页', then: '当不是，接着往下走' }); return false; })) {
      holdSite(p.url());
      throw Error(`site_check:${siteOf(p.url()) || site} 网站要先验证（验证码、安全检查），一小时内不再自动打开；请你在专用 Chrome 里打开它完成验证（${p.url().slice(0, 200)}）`);
    }
    return { url: p.url(), status: r?.status?.() ?? null };
  }
  async reload(o = {}) { const p = await this._p(); await p.reload({ timeout: o.timeout ?? 30000, waitUntil: o.waitUntil || 'load' }); return { url: p.url() }; }
  async waitForURL(m, o = {}) { const p = await this._p(); await p.waitForURL(m, { timeout: o.timeout ?? 30000, waitUntil: 'commit' }); return p.url(); }
  async waitForTimeout(ms) { await sleep(Number(ms) || 0); }
  async waitForLoadState(state = 'load', o = {}) { await (await this._p()).waitForLoadState(state === 'networkidle' ? 'networkidle' : state || 'load', { timeout: o.timeout ?? 30000 }); }
  async waitForSelector(selector, o = {}) { await (await this._p()).waitForSelector(toPwSelector(selector), { timeout: o.timeout ?? 30000, state: o.state || 'visible' }); return true; }
  async waitForFunction(fn, arg, o = {}) { const h = await (await this._p()).waitForFunction(fn, arg, { timeout: o.timeout ?? 30000, polling: o.polling ?? 100 }); return h.jsonValue().catch(() => true); } // 兜底：返回值读不出来时只知道条件成立了，当 true
  async waitForEvent(event, o = {}) {
    const p = await this._p();
    if (event === 'popup') { const pp = await p.waitForEvent('popup', { timeout: o.timeout ?? 30000 }); return (await this.space._register(pp)).page; }
    if (event === 'download') return p.waitForEvent('download', { timeout: o.timeout ?? 30000 });
    throw Error(`unsupported_event:${event}`);
  }
  async evaluate(fn, arg) { return (await this._p()).evaluate(fn, arg); }
  async fetch(url, o = {}) {
    const p = await this._p();
    const { saveAs, timeout = 30000, ...init } = o;
    const r = await p.evaluate(async ({ url, init, binary, timeout }) => {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(url, { ...init, signal: ctl.signal });
        const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
        let body;
        if (binary) { const b = new Uint8Array(await res.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); body = btoa(s); }
        else body = await res.text();
        return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers, body };
      } finally { clearTimeout(t); }
    }, { url: String(url), init, binary: !!saveAs, timeout });
    if (saveAs) { fs.mkdirSync(path.dirname(saveAs), { recursive: true }); fs.writeFileSync(saveAs, Buffer.from(r.body, 'base64')); return { ...r, body: null, path: saveAs }; }
    return r;
  }
  async cdp(method, params = {}) {
    const p = await this._p(), s = await this.space.rt.context.newCDPSession(p);
    try { return await s.send(method, params); } finally { await s.detach().catch(() => {}); } // 兜底：会话已经随页面断了
  }
  async events() { return []; }
  async screenshot(o = {}) {
    const p = await this._p();
    if (o.path) fs.mkdirSync(path.dirname(o.path), { recursive: true });
    const buf = await p.screenshot({ ...(o.path ? { path: o.path } : {}), fullPage: !!o.fullPage, ...(o.clip ? { clip: o.clip } : {}), timeout: 30000 });
    return o.path || buf;
  }
  // 页面的语义快照（无障碍树，YAML 写法）：给回执、给人看。没有可点的编号（这边的脚本不用编号）。
  async snapshot(o = {}) {
    const p = await this._p();
    const text = await p.locator('body').ariaSnapshot({ timeout: 10000 });
    return `[${this.label} ${p.url()} | space ${this.spaceId}]\n${text}`;
  }
  async click(selector, o = {}) { return this._act(p => this._loc(p, selector).click({ ...pick(o, ['button', 'clickCount', 'delay', 'position', 'force']), timeout: o.timeout ?? ACTION_TIMEOUT })); }
  async dblclick(selector, o = {}) { return this._act(p => this._loc(p, selector).dblclick({ ...pick(o, ['button', 'delay', 'position', 'force']), timeout: o.timeout ?? ACTION_TIMEOUT })); }
  async hover(selector, o = {}) { return this._act(p => this._loc(p, selector).hover({ ...pick(o, ['position', 'force']), timeout: o.timeout ?? ACTION_TIMEOUT })); }
  async dragAndDrop(source, target, o = {}) { return this._act(p => this._loc(p, source).dragTo(this._loc(p, target), { ...pick(o, ['force', 'sourcePosition', 'targetPosition']), timeout: o.timeout ?? ACTION_TIMEOUT })); }
  async focus(selector, o = {}) { await this._loc(await this._p(), selector).focus({ timeout: o.timeout ?? ACTION_TIMEOUT }); return {}; }
  async press(selector, chord, o = {}) { return this._act(p => this._loc(p, selector).press(chord, { ...pick(o, ['delay']), timeout: o.timeout ?? ACTION_TIMEOUT })); }
  // 填写：选中的元素本身能填就填；是个外壳的话，填它里面唯一能填的那个框（ego 的规矩）。
  async fill(selector, value, o = {}) {
    const p = await this._p(), loc = this._loc(p, selector), timeout = o.timeout ?? ACTION_TIMEOUT;
    try { await loc.fill(String(value), { timeout }); }
    catch (e) {
      if (!/not an <input>|is not an input|Element is not an|not editable|contenteditable/i.test(e.message)) throw e;
      await loc.locator('input:not([type=hidden]), textarea, [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]').fill(String(value), { timeout });
    }
    return {};
  }
  async selectOption(selector, values, o = {}) { return (await this._loc(await this._p(), selector).selectOption(values == null ? [] : values, { timeout: o.timeout ?? ACTION_TIMEOUT })); }
  async setInputFiles(selector, paths) { await this._loc(await this._p(), selector).setInputFiles(paths, { timeout: 10000 }); return {}; }
  waitForFileChooser(o = {}) {
    return this._p().then(p => p.waitForEvent('filechooser', { timeout: o.timeout ?? 30000 })).then(fc => ({
      isMultiple: () => fc.isMultiple(),
      setFiles: async files => { await fc.setFiles(files); return this._dialog ? { dialog: new DialogInfo(this._dialog) } : {}; },
    }));
  }
  async acceptDialog(promptText) { await this._p(); const d = this._dialog; if (!d) return false; this._clearDialog(); await d.accept(promptText).catch(() => {}); return true; } // 兜底：弹窗已经被页面自己关了
  async dismissDialog() { await this._p(); const d = this._dialog; if (!d) return false; this._clearDialog(); await d.dismiss().catch(() => {}); return true; } // 兜底：弹窗已经被页面自己关了
  async close() {
    const p = await this._p();
    await p.close().catch(() => {}); // 兜底：页面已经关了
    await this.space.release(this.label);
    return true;
  }
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));

// 跑一段 ego 写法的脚本（bin/browser.mjs 调它）。脚本里的 radarResult 由调用方加在最前面。
export async function runCompatScript(source, opts = {}) {
  const rt = await CompatRuntime.open(opts);
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const g = rt.globals();
    const fn = new AsyncFunction(...Object.keys(g), String(source));
    return await fn(...Object.values(g));
  } finally { releaseSites(); await rt.close(); }
}
