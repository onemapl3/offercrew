// 专用 Chrome 上的网站排队和「先别碰」（和 ego 解耦第 2 批；调研 10-02：降频和停手都写进代码，不靠模型自觉）。
//
//   排队   同一个网站（zhipin.com、maimai.cn、linkedin.com……）同一时间只有一个浏览器脚本在上面。脚本第一次打开这个
//          网站时拿到它的锁，脚本结束（进程退出）就放开；锁里记着进程号，进程没了锁就作废。别的脚本最多等一分钟，
//          还轮不到就报 site_busy:<网站>，这一轮先不做。
//   停手   打开一个页面碰到验证页（验证码、人机检查、访问太频繁），或者登录检查碰到验证页：这个网站一小时内不再自动打开，
//          报 site_check:<网站>。验证只由你本人在专用 Chrome 里做；一小时后再试，或者你处理完以后清掉（clearSiteHold）。
// 不换出口、不换浏览器、不绕过去。
import fs from 'node:fs';
import path from 'node:path';
import { file } from './store.mjs';
// 这个进程还在不在（和 lib/browser-host.mjs alive 一样；不引它，免得两个模块互相引成环）。
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
import { event } from './events.mjs';

export const HOLDS_PATH = 'state/browser-site-holds.json';
export const LOCK_DIR = 'private/browser-sites';
export const HOLD_MS = 60 * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 网站 = 可注册的那一级域名：www.zhipin.com → zhipin.com；hr.163.com → 163.com；x.com.cn → x.com.cn。
export function siteOf(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; } // 兜底：网址解析不了就不算哪个网站
  if (!host || /^\[|^\d+(\.\d+){3}$/.test(host) || !host.includes('.')) return host || null;
  const parts = host.split('.');
  const take = parts.length >= 3 && /^(com|net|org|gov|edu|co|ac)$/.test(parts.at(-2)) && parts.at(-1).length === 2 ? 3 : 2;
  return parts.slice(-take).join('.');
}

// 「先别碰」的记录读坏了（兜底清单 F07）：不能当作没有记录——那样下一轮又去敲刚要验证的网站（红线：碰到验证页就停）。
// 改成所有网站一起停一小时（键 *），坏文件挪到旁边（.bad-<时间>）留着查，记一条事件；一小时后照常。
export const ALL_SITES = '*';
function readHolds(now = Date.now()) {
  const p = file(HOLDS_PATH);
  let raw = null;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; }
  if (raw != null) { try { const h = JSON.parse(raw); if (h && typeof h === 'object' && !Array.isArray(h)) return h; } catch {} } // 兜底：读坏了往下走：所有网站一起停一小时，坏文件挪开，记一条事件
  const at = new Date(now).toISOString();
  const holds = { [ALL_SITES]: { at, until: new Date(now + HOLD_MS).toISOString(), url: '', reason: 'holds_unreadable', letter_at: at } };
  try {
    if (raw != null) fs.renameSync(p, `${p}.bad-${now}`);
    writeHolds(holds);
    event('system', 'browser', 'error', `「网站要验证、先别碰」的记录读不了，所有网站先停一小时再自动打开（坏文件留在 ${HOLDS_PATH}.bad-${now}）`, { kind: 'site_holds_unreadable' });
  } catch {} // 兜底：挪坏文件或记事件没做成，所有网站照样停一小时（holds 照样返回）
  return holds;
}
function writeHolds(h) {
  const dest = file(HOLDS_PATH);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.${process.pid}.tmp`, JSON.stringify(h, null, 2) + '\n');
  fs.renameSync(`${dest}.${process.pid}.tmp`, dest);
}
// 这个网站现在是不是「先别碰」：{ site, at, until, url, reason } 或 null。
export function siteHold(url, now = Date.now()) {
  const site = siteOf(url);
  if (!site) return null;
  const holds = readHolds(now), live = h => (h && Date.parse(h.until || '') > now ? h : null);
  const h = live(holds[site]) || live(holds[ALL_SITES]);
  return h ? { site, ...h } : null;
}
export function holdSite(url, { reason = 'verification', now = Date.now(), ms = HOLD_MS } = {}) {
  const site = siteOf(url);
  if (!site) return null;
  const holds = readHolds(now), prev = holds[site];
  // 收件箱的「请你接手」信按 letter_at 编号：24 小时内再被拦，还是同一封（lib/site-check-asks.mjs）。
  const letter = prev?.letter_at && now - Date.parse(prev.letter_at) < 24 * 3600000 ? prev.letter_at : new Date(now).toISOString();
  holds[site] = { at: new Date(now).toISOString(), until: new Date(now + ms).toISOString(), url: String(url).slice(0, 300), reason, letter_at: letter };
  writeHolds(holds);
  return { site, ...holds[site] };
}
// 你过了验证（自己去打开了这个网站）：等待清掉；信的编号留 24 小时，免得刚处理完又来一封新的。
export function clearSiteHold(site, { now = Date.now() } = {}) {
  const holds = readHolds(now);
  if (!holds[site] || !(Date.parse(holds[site].until || '') > now)) return false;
  holds[site] = { ...holds[site], until: new Date(now).toISOString(), cleared_at: new Date(now).toISOString() };
  writeHolds(holds);
  return true;
}

// 拿网站的锁：返回放锁的函数（进程退出时也会放）。等不到报 site_busy:<网站>。
const held = new Map();
export async function lockSite(site, { wait = 60000, interval = 250 } = {}) {
  if (!site) return () => {};
  if (held.has(site)) return held.get(site);
  const dir = file(LOCK_DIR), p = path.join(dir, `${site.replace(/[^a-z0-9.-]/gi, '_')}.lock`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ pid: process.pid, at: Date.now() });
  const deadline = Date.now() + wait;
  for (;;) {
    try { fs.writeFileSync(p, mine, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let raw = '', h = null;
    try { raw = fs.readFileSync(p, 'utf8'); h = JSON.parse(raw); } catch {} // 兜底：另一个进程正在写或刚删，读不出就当锁没人持有，下面只删刚才读到的那一份
    if (!h || !alive(h.pid) || h.pid === process.pid) { try { if (fs.readFileSync(p, 'utf8') === raw) fs.rmSync(p, { force: true }); } catch {} continue; } // 兜底：读和删之间锁被别人换了或已经删了，不动它
    if (Date.now() > deadline) throw Error(`site_busy:${site}`);
    await sleep(interval);
  }
  const release = () => { held.delete(site); process.removeListener('exit', release); try { if (fs.readFileSync(p, 'utf8') === mine) fs.rmSync(p, { force: true }); } catch {} }; // 兜底：锁已经被别人清掉了，不用再放
  process.once('exit', release);
  held.set(site, release);
  return release;
}
export function releaseSites() { for (const r of [...held.values()]) r(); }

// 页面里跑的验证页判断（和登录检查 lib/login-probe.mjs 的同一套说法）：地址像验证页、有看得见的验证码框，或者页面字很少、
// 其中有一行短短的「请完成安全验证」「访问过于频繁」。普通页面里提到「安全验证」不算（字多的页面只看地址和验证码框）。
export const VERIFY_PAGE = String(function () {
  var url = location.href, lines = (document.body ? document.body.innerText : '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var TEXT = /人机验证|安全验证|拖动滑块|滑动验证|请完成验证|请完成安全验证|访问过于频繁|访问异常|异常访问|verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|unusual traffic/i;
  var FRAME = /recaptcha|hcaptcha|geetest|captcha|turnstile|arkoselabs|funcaptcha|nc_iconfont|aliyuncaptcha/i;
  var URL_RE = /captcha|\/challenge|verify\.html|security[-_]?check|\/waf\//i;
  // 验证码框只认看得见、像个样子的：很多网站每页都挂着一个隐形的 reCAPTCHA（size=invisible、0×0），那不是要你验证。
  var frames = Array.prototype.slice.call(document.querySelectorAll('iframe')).some(function (f) {
    var src = f.getAttribute('src') || '';
    if (!FRAME.test(src) || /size=invisible/i.test(src)) return false;
    var r = f.getBoundingClientRect ? f.getBoundingClientRect() : null;
    return !r || (r.width >= 60 && r.height >= 40);
  });
  return URL_RE.test(url) || frames || (lines.length < 60 && lines.some(function (l) { return l.length <= 60 && TEXT.test(l); }));
});
