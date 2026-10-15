// 本机工作台的门（10-02 开箱第 2 轮查出：这台电脑上任何程序都能读 /api/snapshot，也就是你的求职数据；负责人 10-03 定发布前修）。
// 只有我们自己的页面（电脑版、经网关来的手机）能读写；别的程序、别的网页都读不到。
//
//   凭证    一把钥匙，放在只给本机工作台用的 cookie 里（offercrew_key：HttpOnly、SameSite=Strict，网页脚本读不到，
//           别的网站带不过来）。经网关来的手机带的是工作台进程内存里的口令（x-radar-token，bin/serve.mjs），不落盘。
//   钥匙    Mac 版：App 每次启动现生成一把，经环境变量 RADAR_LOCAL_KEY 交给引擎，自己给窗口设好 cookie——不写进任何文件。
//           命令行装的：存在 private/workbench-key（0600，只有你能读）；`node bin/open-workbench.mjs` 打开一个带钥匙的
//           地址，工作台收下钥匙、写进 cookie、跳回不带钥匙的地址，以后这个浏览器就一直能打开。
//   其余    Host 必须是 127.0.0.1 / localhost 加本端口（防 DNS rebinding）；带了 Origin 的必须是本端口自己的页面
//           （别的网页跨站来读、来写一律拒）。Gmail 授权回调不要钥匙：它由 OAuth 的 state 校验，而且是系统浏览器跳回来的。
// 读得到你家目录文件的程序，本来就能直接读数据目录；这道门挡的是读不到文件、却连得上本机端口的东西（网页、别的用户、沙盒里的程序）。
//
// 测试（node --test 起的工作台）默认不设门，免得几十个 HTTP 测试都要带钥匙；RADAR_LOCAL_AUTH=on 才设（tests/local-api-auth.test.mjs）。
// 产品里没有关掉它的开关。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file } from './store.mjs';

export const COOKIE = 'offercrew_key';
export const KEY_PATH = 'private/workbench-key';
const KEY_RE = /^[0-9a-f]{64}$/;

export const authEnforced = (env = process.env) => !env.NODE_TEST_CONTEXT || env.RADAR_LOCAL_AUTH === 'on';

// 工作台用的钥匙：App 给的（环境变量），否则文件里的，没有就生成一把写进去（0600）。
export function workbenchKey(env = process.env) {
  const given = String(env.RADAR_LOCAL_KEY || '').trim().toLowerCase();
  if (KEY_RE.test(given)) return given;
  const p = file(KEY_PATH);
  try { const k = fs.readFileSync(p, 'utf8').trim(); if (KEY_RE.test(k)) return k; } catch {} // 兜底：钥匙文件不在或读不出就生成一把新的（下面）
  const k = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${p}.${process.pid}.tmp`, k + '\n', { mode: 0o600 });
  fs.renameSync(`${p}.${process.pid}.tmp`, p);
  return k;
}
// 命令行用：只读，不生成（工作台还没起过就是 null）。
export function storedKey() { try { const k = fs.readFileSync(file(KEY_PATH), 'utf8').trim(); return KEY_RE.test(k) ? k : null; } catch { return null; } } // 兜底：工作台还没起过就是 null（上面的注释）

const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
export function cookieOf(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return '';
}
export const setCookie = key => `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;

// 这一个请求能不能进：{ ok } 或 { ok: false, status, error }。key：钥匙；token：工作台进程内存里的口令（网关用）。
export function checkRequest(req, { port, key, token, env = process.env } = {}) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!hosts.includes(req.headers.host)) return { ok: false, status: 403, error: 'host_not_allowed' };
  const origin = req.headers.origin;
  if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return { ok: false, status: 403, error: 'origin_not_allowed' };
  if (!authEnforced(env)) return { ok: true };
  if (same(cookieOf(req), key) || same(req.headers['x-radar-token'], token)) return { ok: true };
  return { ok: false, status: 401, error: 'unauthorized' };
}
// 地址里带着钥匙（node bin/open-workbench.mjs 打开的那一个）：对上了就收下。
export const keyInUrl = (url, key) => same(url.searchParams.get('key'), key);
export const workbenchLink = (port, key, where = '/') => `http://127.0.0.1:${port}${where}${where.includes('?') ? '&' : '?'}key=${key}`;

// 没带钥匙打开页面时看到的（不含任何数据）。
export const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>OfferCrew</title><style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;color:#333}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style><p>这个页面只能从 OfferCrew 打开。</p><p>命令行装的：在 OfferCrew 的目录里运行 <code>node bin/open-workbench.mjs</code>。</p>`;
