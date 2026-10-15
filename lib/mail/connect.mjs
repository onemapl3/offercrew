// 连上用户自己的邮箱：IMAP 读（imapflow），SMTP 发（nodemailer）。第 1 批只用到「测试连接」：
//   IMAP  登录一次，以只读方式打开收件箱（EXAMINE），读出最新一封信的标题和时间，退出。
//         只读：不删、不移、不改已读状态。取信内容一律走 BODY.PEEK（imapflow 自己就这样），这里不发 STORE / EXPUNGE / MOVE。
//   SMTP  只握手、登录（smtpOpen + LOGIN），不发信。
// 失败原因写成人话（explain），而且把「授权码不对」和「连不上 / 超时」分开：在中国大陆连 Gmail 要代理，最常见的是后者。
//
//   代理   读环境变量：RADAR_MAIL_PROXY（off 就是不用），否则 ALL_PROXY，否则 HTTPS_PROXY（大小写都认）；NO_PROXY 里的域名直连。
//          都没配时，Gmail 先用 macOS 的系统代理（proxyFor），别家直连不通再经系统代理试（routesFor）。http(s):// 走 CONNECT，socks5:// 走 SOCKS（远端解析域名）。
//          界面上的代理设置以后再做。
//   线路   连接阶段（还没登录、一个字没发）不通就换下一条线路：代理 ↔ 直连，Gmail 发信 465 ↔ 587（routesFor）。
//          10-04、10-05 实测：同一台 Mac 上直连和经代理时好时坏，有时直连连上了不打招呼，有时代理节点不放 465 的加密连接。
//          都不通时原因说清是哪一种：直连被拦、代理没开、还是代理开着也不通（explainAttempts）。
//   沙盒   演示 / 沙盒模式和 node --test 底下只许连本机（127.0.0.1、localhost、::1）的假服务器，不用代理；
//          只有这时才许明文连接（plain）。正式运行只走 TLS：993 / 465 直接加密，587 要求 STARTTLS。
//   不泄露  授权码不进日志（imapflow、nodemailer 的日志都关了）、不进错误信息；服务器回的话也先把授权码抹掉。
import { noteFallback } from '../fallback.mjs';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from '../spawn.mjs';
import { ImapFlow } from 'imapflow';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { SocksClient } from 'socks';
import { BRAND } from '../brand.mjs';
import { sandboxed } from '../sandbox.mjs';
import { underTest } from './keychain.mjs';

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0'; } catch { return '0'; } })();
// IMAP ID（RFC 2971）：163 要求客户端报上名字，不报就拒绝读收件箱。只报产品名和版本，不带操作系统和别的。
export const CLIENT_INFO = { name: BRAND, version: VERSION, vendor: BRAND, 'support-url': false };
// SMTP 的 EHLO 名字：默认是这台 Mac 的主机名，会写进对方收到的信头里；换成地址字面量。
const EHLO_NAME = '[127.0.0.1]';
const LIMITS = { connectionTimeout: 15000, greetingTimeout: 12000, socketTimeout: 45000 };

const fail = (code, message, extra = {}) => Object.assign(Error(message), { code, ...extra });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const isLoopback = (host) => LOOPBACK.has(String(host || '').trim().toLowerCase());
export const localOnly = () => sandboxed() || underTest();

// ── 代理 ────────────────────────────────────────────────────────────────────────
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const OFF = /^(?:off|none|direct|0|false)$/i;
const firstSet = (...vals) => vals.map((v) => String(v ?? '').trim()).find(Boolean) || '';
// 不走代理的主机：NO_PROXY 的逗号列表，或者系统代理的例外列表（*.local、localhost……）；网段写法不认。
function excluded(host, list) {
  const h = String(host || '').toLowerCase();
  return list.map((n) => String(n).trim().toLowerCase()).filter(Boolean)
    .some((n) => n === '*' || h === n.replace(/^\*?\./, '') || h.endsWith('.' + n.replace(/^\*?\./, '')));
}
function normalizeProxy(raw) {
  let u;
  try { u = new URL(raw.includes('://') ? raw : `http://${raw}`); } catch { return null; } // 兜底：地址写得不对就当没配代理
  if (!PROXY_PROTOCOLS.has(u.protocol) || !u.hostname || !u.port) return null;
  if (localOnly() && !isLoopback(u.hostname)) return null;
  // socks5h（远端解析域名）是 curl 的写法；imapflow 的 socks5 本来就让代理解析域名。
  if (u.protocol === 'socks5h:') u.protocol = 'socks5:';
  return u.href.replace(/\/$/, '');
}

// macOS 的系统代理（scutil --proxy，只读）：代理软件打开「设置为系统代理」时有。从「启动台」打开的 App 拿不到终端里的
// 环境变量，在中国大陆连 Gmail 靠的就是它。只认 SOCKS、HTTPS、HTTP 三种（按这个顺序），自动代理配置（PAC）不认。
export function parseSystemProxy(text) {
  const t = String(text || '');
  const val = (k) => (t.match(new RegExp(`^\\s*${k} : (.+)$`, 'm')) || [])[1]?.trim();
  const ex = (t.match(/ExceptionsList : <array> \{([\s\S]*?)\}/) || [])[1] || '';
  const exceptions = [...ex.matchAll(/^\s*\d+ : (.+)$/gm)].map((m) => m[1].trim());
  for (const [kind, scheme] of [['SOCKS', 'socks5'], ['HTTPS', 'http'], ['HTTP', 'http']]) {
    const host = val(`${kind}Proxy`), port = val(`${kind}Port`);
    if (val(`${kind}Enable`) === '1' && host && /^\d+$/.test(port || '')) return { url: `${scheme}://${host}:${port}`, exceptions };
  }
  return null;
}
let systemCache = { at: 0, value: null };
export function systemProxy() {
  if (process.platform !== 'darwin' || localOnly()) return null;
  if (Date.now() - systemCache.at < 60000) return systemCache.value;
  let value = null;
  try { value = parseSystemProxy(execFileSync('/usr/sbin/scutil', ['--proxy'], { timeout: 3000, encoding: 'utf8' })); }
  catch (e) { noteFallback({ kind: 'mail-proxy', from: 'system-proxy', to: 'direct', why: e, member: 'owl', from_label: 'macOS 系统代理', to_label: '直连邮箱' }); }
  systemCache = { at: Date.now(), value };
  return value;
}

// 返回给 imapflow / nodemailer 用的代理地址，没有就 null。认不出的写法当没配（不猜）。
//   顺序：RADAR_MAIL_PROXY（off 就是不用）> ALL_PROXY > HTTPS_PROXY（大小写都认，NO_PROXY 里的直连）；
//         都没有、而且这个邮箱在中国大陆直连不上（system: true，就是 Gmail）时，用 macOS 的系统代理。
// 沙盒和测试里不读本机的环境变量和系统代理（开发机上常年开着代理）；测试要试代理，就把 env 显式传进来，而且代理只能在本机。
export function proxyFor(host, env = process.env, { system = false, systemProxy: sys = systemProxy } = {}) {
  if (localOnly() && env === process.env) return null;
  const raw = firstSet(env.RADAR_MAIL_PROXY, env.ALL_PROXY, env.all_proxy, env.HTTPS_PROXY, env.https_proxy);
  if (OFF.test(raw)) return null;
  if (raw) {
    if (excluded(host, String(env.NO_PROXY ?? env.no_proxy ?? '').split(','))) return null;
    const url = normalizeProxy(raw);
    // 写法认不出：直连，但记一笔（兜底清单 H02；邮件读不到代理可以直连，招聘站不行，那是 J 线的 H01）。
    if (!url) noteFallback({ kind: 'mail-proxy', from: 'env-proxy', to: 'direct', why: '代理写法认不出', member: 'owl', from_label: '环境变量里的代理', to_label: '直连邮箱' });
    return url;
  }
  if (!system) return null;
  const s = sys();
  return s && !excluded(host, s.exceptions || []) ? normalizeProxy(s.url) : null;
}
// 页面上说代理时只说地址和端口，不带用户名密码。
export const proxyLabel = (url) => { try { const u = new URL(url); return `${u.protocol.replace(/:$/, '')}://${u.hostname}:${u.port}`; } catch { return ''; } }; // 兜底：地址写得不对就不显示

// ── 服务器 ───────────────────────────────────────────────────────────────────────
// 连之前先看一眼要连哪里：沙盒和测试里只许本机；明文只许本机且只在那时。
export function checkServer(s, which) {
  const host = String(s?.host || '').trim(), port = Number(s?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw fail('mail_bad_server', `${which} 服务器设置不对`);
  if (localOnly() && !isLoopback(host)) throw fail('mail_sandbox', '演示 / 沙盒模式不连真的邮箱，只连本机的测试服务器');
  if (s.plain && !(localOnly() && isLoopback(host))) throw fail('mail_plain_refused', '不用加密的连接只在测试里用');
  return { ...s, host, port };
}

// IMAP 登录名：iCloud 先用 @ 前面那段，不行再用完整地址（Apple 的说明）；别家都用完整地址。用户另填了登录名就只用它。
export function imapUsers(account) {
  if (account.login) return [account.login];
  const address = String(account.address || '');
  if (account.imap?.user === 'local-then-full') return [address.split('@')[0], address];
  return [address];
}

export function imapOptions(account, user, pass, { proxy, limits = {} } = {}) {
  const s = checkServer(account.imap, 'IMAP');
  return {
    host: s.host, port: s.port, secure: !s.plain && s.secure !== false,
    ...(s.plain ? { doSTARTTLS: false } : s.secure === false ? { doSTARTTLS: true } : {}),
    auth: { user, pass },
    clientInfo: CLIENT_INFO,
    logger: false, emitLogs: false,
    disableAutoIdle: true,
    ...LIMITS, ...limits,
    // 一封信最大按 40 MB 算，防止坏掉的服务器把内存撑爆。
    maxLineLength: 8 * 1024 * 1024, maxLiteralSize: 40 * 1024 * 1024, maxResponseSize: 48 * 1024 * 1024,
    tls: { minVersion: 'TLSv1.2' },
    ...(proxy ? { proxy } : {}),
  };
}

export function smtpOptions(account, pass, { proxy, limits = {} } = {}) {
  const s = checkServer(account.smtp, 'SMTP');
  return {
    host: s.host, port: s.port, secure: !s.plain && s.secure !== false,
    ...(s.plain ? { ignoreTLS: true } : s.requireTLS || s.secure === false ? { requireTLS: true } : {}),
    auth: { user: account.login || account.address, pass },
    name: EHLO_NAME,
    logger: false, debug: false,
    ...LIMITS, dnsTimeout: 10000, ...limits,
    disableFileAccess: true, disableUrlAccess: true,
    tls: { minVersion: 'TLSv1.2' },
    ...(proxy ? { proxy } : {}),
  };
}

// ── 线路 ─────────────────────────────────────────────────────────────────────────
// 一条线路 = 经哪个代理（null 是直连）+ 连哪台服务器的哪个端口。连接阶段（没登录、没发任何东西）失败就换下一条：
// 换线不会把信发两遍，也不算一次登录（QQ、163 限制登录频率）。
//   Gmail（blocked_in_cn）：有代理先走代理，再直连。别家：先直连，系统代理开着再经它试一次。环境变量里设了代理：先代理再直连。
//   发信再加备用端口（providers 的 smtp_alt，Gmail 465 不通试 587 STARTTLS）：很多代理节点只放其中一个。
//   上次通的那条，下次排第一（只记在这个进程里）。
const lastGood = new Map();
const routeKey = (r) => `${r.proxy || 'direct'}|${r.server.port}`;
export function routesFor(which, target, { provider = null, env = process.env } = {}) {
  const server = checkServer(target[which], which.toUpperCase());
  const blocked = !!provider?.blocked_in_cn;
  const first = proxyFor(server.host, env, { system: blocked });
  const vias = first ? [first, null] : [null, ...(blocked ? [] : [proxyFor(server.host, env, { system: true })].filter(Boolean))];
  const alt = which === 'smtp' && provider?.smtp_alt && provider.smtp?.host === server.host && Number(provider.smtp?.port) === server.port ? { ...server, ...provider.smtp_alt } : null;
  const key = `${which}:${server.host}:${server.port}`;
  const list = vias.flatMap((proxy) => (alt ? [server, alt] : [server]).map((s) => ({ proxy, server: s, key })));
  const good = lastGood.get(key);
  return good ? [...list.filter((r) => routeKey(r) === good), ...list.filter((r) => routeKey(r) !== good)] : list;
}
function remember(which, list, r, member) {
  if (list.length < 2 || !r.key) return;
  lastGood.set(r.key, routeKey(r));
  if (r === list[0]) return;
  const via = (x) => (x.proxy ? 'proxy' : 'direct'), label = (x) => `${x.proxy ? `经代理 ${proxyLabel(x.proxy)}` : '直连'} ${x.server.host}:${x.server.port}`;
  noteFallback({ kind: `mail-route-${which}`, from: `${via(list[0])}-${list[0].server.port}`, to: `${via(r)}-${r.server.port}`, why: '连接阶段不通', member, from_label: label(list[0]), to_label: label(r) });
}
// 连接阶段的失败（换一条线路可能就通）：连不上、超时、加密没建立、代理不通。登录没过、服务器拒绝不算。
const ROUTE_KINDS = new Set(['network', 'timeout', 'tls', 'proxy']);
export const connectionFailure = (e) => !e?.authenticationFailed && ROUTE_KINDS.has(explain(e).kind);
const hide = (e, attempts) => { try { Object.defineProperty(e, 'attempts', { value: attempts, enumerable: false, configurable: true }); } catch {} return e; }; // 兜底：冻结的错误对象挂不上，原因就按最后一次说

// 经代理连邮箱：SOCKS 走 socks，HTTP 走 CONNECT（https:// 的代理先和代理握 TLS）。
export function tunnel(proxyUrl, host, port, { timeoutMs = 15000 } = {}) {
  const u = new URL(proxyUrl);
  if (/^socks/.test(u.protocol)) {
    return SocksClient.createConnection({
      proxy: { host: u.hostname, port: Number(u.port), type: /^socks4/.test(u.protocol) ? 4 : 5, ...(u.username ? { userId: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) },
      command: 'connect', destination: { host, port }, timeout: timeoutMs,
    }).then((r) => r.socket).catch((e) => { throw Object.assign(e, { code: 'EPROXY' }); });
  }
  return new Promise((resolve, reject) => {
    const s = u.protocol === 'https:' ? tls.connect({ host: u.hostname, port: Number(u.port), servername: u.hostname }) : net.connect(Number(u.port), u.hostname);
    const timer = setTimeout(() => { s.destroy(); reject(Object.assign(Error('proxy timeout'), { code: 'EPROXY' })); }, timeoutMs);
    s.once('error', (e) => { clearTimeout(timer); reject(Object.assign(e, { code: 'EPROXY' })); });
    s.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const auth = u.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n` : '';
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.off('data', onData); clearTimeout(timer);
      if (!/^HTTP\/1\.[01] 200/.test(buf.subarray(0, end).toString())) { s.destroy(); reject(Object.assign(Error('proxy refused the tunnel'), { code: 'EPROXY' })); return; }
      const rest = buf.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on('data', onData);
  });
}

// 代理本身开着没有：连一下它的端口（只连不说话）。
export function proxyAlive(url, { timeoutMs = 1500 } = {}) {
  let u;
  try { u = new URL(url); } catch { return Promise.resolve(false); } // 兜底：地址写得不对就当没开
  return new Promise((resolve) => {
    const s = net.connect(Number(u.port), u.hostname);
    const done = (v) => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true)); s.once('error', () => done(false));
  });
}

// 连上发信服务器、打过招呼（加密已建立，587 的 STARTTLS 也做完了），还没登录。按线路一条条试。
// 回 { conn, opts, route, closed }：closed 是连上以后第一次出错 / 断开的 Promise（发信那边拿它和登录、交信赛跑）。
// 全不通就抛最后一次的错，错上挂着 attempts（不可枚举）：[{ proxy, host, port, error, waited }]。
// deadline：到这个时刻还没通就不再试下一条（设置页「测试」有 20 秒的总时间）。
export async function smtpOpen(account, pass, { routes = null, proxy = null, limits = {}, deadline = null, member = 'quill' } = {}) {
  const list = routes || [{ proxy, server: checkServer(account.smtp, 'SMTP') }];
  const attempts = [];
  for (const [i, r] of list.entries()) {
    const left = deadline ? deadline - Date.now() : Infinity;
    if (i > 0 && left < 2500) break;
    const cap = Number.isFinite(left) ? { connectionTimeout: Math.min(limits.connectionTimeout ?? LIMITS.connectionTimeout, left), greetingTimeout: Math.min(limits.greetingTimeout ?? LIMITS.greetingTimeout, left) } : {};
    const opts = smtpOptions({ ...account, smtp: r.server }, pass, { limits: { ...limits, ...cap } });
    const t0 = Date.now();
    try {
      const open = await smtpOnce(opts, r.proxy);
      remember('smtp', list, r, member);
      return { ...open, opts, route: r };
    } catch (error) {
      attempts.push({ proxy: r.proxy, host: r.server.host, port: r.server.port, error, waited: Date.now() - t0 });
      if (!connectionFailure(error)) break;
    }
  }
  throw hide(attempts.at(-1).error, attempts);
}
async function smtpOnce(opts, proxy) {
  const socket = proxy ? await tunnel(proxy, opts.host, opts.port, { timeoutMs: opts.connectionTimeout }) : null;
  const conn = new SMTPConnection({ ...opts, ...(socket ? { connection: socket } : {}) });
  let onFail;
  const failed = new Promise((resolve) => { onFail = resolve; });
  let phase = null; // 连接阶段：出错就 reject；连上以后：交给 closed
  conn.on('error', (e) => (phase ? phase(e) : onFail(e)));
  conn.on('end', () => { const e = Object.assign(Error('connection closed'), { code: 'ECONNECTION' }); (phase ? phase(e) : onFail(e)); });
  return new Promise((resolve, reject) => {
    phase = (e) => { phase = null; try { conn.close(); } catch {} reject(e); }; // 兜底：连接已经断了
    conn.connect(() => { phase = null; resolve({ conn, closed: failed }); });
  });
}

// ── 失败原因 ─────────────────────────────────────────────────────────────────────
const NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS', 'ECONNECTION', 'EDNS', 'ESOCKET']);
const TIMEOUT = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT', 'ETIMEDOUT']);
const PROXY = new Set(['ProxyError', 'EPROXY', 'UnsupportedProxyAddress']);
// 服务器回的原话：IMAP 取 responseText（没有就去掉 tag 和 NO / BAD 的整行），SMTP 取 response，断线时的 BYE 取 reason。
const textOf = (e) => {
  const line = typeof e?.response === 'string' ? e.response.replace(/^\S+\s+(?:NO|BAD)\s+(?:\[[^\]]*\]\s*)?/i, '') : '';
  return [e?.responseText || line, e?.reason].filter(Boolean).join(' ').slice(0, 300);
};
const scrub = (s, secrets) => secrets.filter((x) => x && x.length >= 4).reduce((t, x) => t.split(x).join('••••'), String(s || ''));

// { kind, reason, server? }。kind：auth / unsafe / throttle / timeout / network / tls / proxy / sandbox / server。
export function explain(err, { step = 'imap', provider = null, host = '', port = null, proxy = null, secrets = [], waited = null } = {}) {
  const code = String(err?.code || ''), said = textOf(err), msg = String(err?.message || '');
  const label = provider?.label || '邮箱', codeName = provider?.code || '授权码';
  const server = scrub(said, secrets).replace(/\s+/g, ' ').trim().slice(0, 160) || null;
  const out = (kind, reason) => ({ kind, reason, ...(server ? { server } : {}) });
  if (['mail_sandbox', 'mail_plain_refused', 'mail_bad_server'].includes(code)) return { kind: code === 'mail_sandbox' ? 'sandbox' : 'config', reason: msg };
  const gfw = provider?.blocked_in_cn ? `在中国大陆连 ${label} 要开代理${proxy ? `（现在用的是 ${proxyLabel(proxy)}，看看它开着没有）` : '（代理软件打开「设置为系统代理」就行）'}。` : '';
  if (PROXY.has(code) || (proxy && /socks|proxy/i.test(msg))) return out('proxy', `代理连不上${proxy ? `（${proxyLabel(proxy)}）` : ''}，看看代理软件开着没有。`);
  if (/unsafe login/i.test(said)) return out('unsafe', `${label}拒绝了这次登录（Unsafe Login），过几分钟再试；还不行就到网页版设置里重新开一次 IMAP/SMTP 服务。`);
  if (code === 'ETHROTTLE' || /too many|rate.?limit|频繁|try again later|exceeded/i.test(said)) return out('throttle', `${label}说登录太频繁了，过几分钟再试。`);
  const authFailed = err?.authenticationFailed || err?.serverResponseCode === 'AUTHENTICATIONFAILED' || code === 'EAUTH' || code === 'ENOAUTH' || (step === 'smtp' && [534, 535].includes(Number(err?.responseCode)));
  if (authFailed) {
    const hint = provider?.provider === 'qq' || provider?.provider === 'netease'
      ? '也可能是还没在网页版「设置」里开启 IMAP/SMTP 服务。'
      : provider?.provider === 'gmail' ? '应用专用密码要先打开两步验证才能生成。'
        : provider?.provider === 'icloud' ? 'App 专用密码要先打开双重认证才能生成。' : '';
    return out('auth', `${label}${step === 'smtp' ? '发信' : ''}登录没通过：${codeName}不对，或者已经失效（改过邮箱密码以后要重新生成）。${hint}`);
  }
  // 发信连不上（收信那一步已经过了）：写清是哪个端口、什么现象。经代理时多半是代理节点封了发信端口（465、587，很多机场都封，防垃圾邮件）。
  // 证书本身的问题（自签名、过期）不是被拦，照下面的「加密连接没建立起来」说。
  if (step === 'smtp' && !/certificate|CERT_|self.signed|UNABLE_TO_|DEPTH_ZERO/i.test(`${code} ${msg}`) && (TIMEOUT.has(code) || NETWORK.has(code) || code === 'ECONNRESET' || /timed? ?out|socket hang up|ECONNRESET|closed|tls|handshake/i.test(msg))) {
    const where = `${host || '发信服务器'}${port ? `:${port}` : ''}`;
    const timedOut = TIMEOUT.has(code) || /timed? ?out/i.test(msg);
    const what = symptom(err, waited);
    // 类别照旧（timeout / network / tls：发信那边按它决定留在队列里再试），只是原因写清楚。
    const tail = proxy ? `多半是代理（${proxyLabel(proxy)}）的节点封了发信端口（465、587），很多机场都封；收信不受影响。换个不封发信端口的节点再点「重新测试」；` : (gfw || '看看网络，过一会儿再试；');
    return out(timedOut ? 'timeout' : /tls|handshake/i.test(msg) && !NETWORK.has(code) && code !== 'ECONNRESET' ? 'tls' : 'network', `发信连不上 ${where}（${proxy ? `经代理 ${proxyLabel(proxy)}` : '直连'}，${what}）。${tail}在那之前，要发的信可以在 ${provider?.label || '邮箱'} 里自己发。`);
  }
  if (TIMEOUT.has(code) || /timed? ?out/i.test(msg)) return out('timeout', `连接 ${host || '邮箱服务器'} 超时了。${gfw || '看看网络，过一会儿再试。'}`);
  // nodemailer 把证书、握手的错误包成 ESOCKET，原来的代号没了，只能看消息。
  if (err?.tlsFailed || code === 'ETLS' || code === 'EREQUIRETLS' || /^(?:ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code) || /certificate|\bssl\b|\btls\b|handshake/i.test(msg)) return out('tls', `和 ${host || '邮箱服务器'} 的加密连接没建立起来。${gfw}`);
  if (NETWORK.has(code)) return out('network', `连不上 ${host || '邮箱服务器'}。${gfw || '看看网络是不是通的。'}`);
  if (err?.mailboxMissing) return out('server', `${label}里找不到收件箱。`);
  return out('server', `${label}的服务器没接受这次连接${server ? `：${server}` : '。'}`);
}

// 连接阶段的现象，一小句：「等了 15 秒没有回应」「连接被拒绝」「连上以后被断开」「加密连接没建立起来」。
export function symptom(err, waited = null) {
  const code = String(err?.code || ''), msg = String(err?.message || '');
  const secs = waited ? `${Math.max(1, Math.round(waited / 1000))} 秒` : '';
  const timedOut = TIMEOUT.has(code) || /timed? ?out/i.test(msg);
  if (code === 'ECONNRESET' || /ECONNRESET|socket hang up/i.test(msg)) return `连上以后${secs ? ` ${secs}` : ''}被断开`;
  if (/ECONNREFUSED/.test(`${code} ${msg}`)) return '连接被拒绝';
  if (/refused the tunnel/i.test(msg)) return '代理不肯接通';
  if (/closed/i.test(msg)) return '连接被关掉，一个字都没回';
  if (timedOut) return `等了${secs ? ` ${secs}` : '很久'}没有回应`;
  if (NETWORK.has(code) && !/tls|ssl|handshake|secure/i.test(msg)) return '连不上';
  return '加密连接没建立起来';
}

// 试过几条线路都不通：说清是哪一种。async：要看一眼代理本身开着没有（proxyAlive）。
//   只试了一条（没有代理、或者头一条就是登录没过这类换线也没用的）：照 explain。
//   代理没开：「代理 … 没开，直连 … 也不通（…）」→ kind proxy。
//   代理开着也不通：「直连 … 不通（…），经代理 … 也不通（…）」→ 发信多半是节点封了发信端口，收信多半是节点连不上这个邮箱。
// 第一句话自己说得通（发信失败的那一行只取第一句，lib/mail/send-words.mjs sendWhy）。
//   host / port / proxy / waited：错上没挂 attempts 时（连上以后才出的错）照这几样说。
export async function explainAttempts(err, { step = 'imap', provider = null, secrets = [], alive = proxyAlive, host = '', port = null, proxy = null, waited = null } = {}) {
  const attempts = err?.attempts?.length ? err.attempts : [{ proxy, host, port, error: err, waited }];
  const last = attempts.at(-1);
  const single = explain(last.error, { step, provider, host: last.host, port: last.port, proxy: last.proxy, secrets, waited: last.waited });
  const viaProxy = attempts.filter((a) => a.proxy), direct = attempts.filter((a) => !a.proxy);
  if (!connectionFailure(last.error) || !viaProxy.length || !direct.length) return single;
  const label = provider?.label || '邮箱', server = last.host;
  const ports = new Set(attempts.map((a) => a.port)).size > 1;
  const sym = (list) => [...new Set(list.map((a) => `${ports ? `${a.port} ` : ''}${symptom(a.error, a.waited)}`))].join('；');
  const proxies = [...new Set(viaProxy.map((a) => a.proxy))];
  const down = (await Promise.all(proxies.map((p) => alive(p)))).some((ok) => !ok);
  const where = proxies.map(proxyLabel).join('、');
  const later = step === 'smtp' ? `在那之前，要发的信可以在 ${label} 里自己发。` : '';
  if (down) return { kind: 'proxy', reason: `代理 ${where} 没开，直连 ${server} 也不通（${sym(direct)}）。打开代理软件再试一次；${later}`, route: 'proxy_down', ...(single.server ? { server: single.server } : {}) };
  const timedOut = attempts.every((a) => explain(a.error).kind === 'timeout');
  const why = step === 'smtp' ? '代理开着，多半是代理节点封了发信端口（465、587），很多机场都封；换个不封发信端口的节点再试一次。' : `代理开着，多半是代理节点连不上 ${label}，换个节点再试一次。`;
  return { kind: timedOut ? 'timeout' : 'network', reason: `直连 ${server} 不通（${sym(direct)}），经代理 ${where} 也不通（${sym(viaProxy)}）。${why}${later}`, route: 'both_blocked', ...(single.server ? { server: single.server } : {}) };
}

// ── 登录并只读打开收件箱（测试连接和读信共用）────────────────────────────────────────────
// 按 imapUsers 的顺序试登录名，只有登录没通过才换下一个；连不上就不再连第二次。回 { client, user, box }，用完调用方 logout。
// options：额外的 imapflow 设置（常驻连接要打开 IDLE，lib/mail/live.mjs）。
// routes：按线路一条条试（routesFor('imap', …)），只有连接阶段不通才换下一条；不给就只走 proxy 这一条。
// 全不通时抛出的错上挂着 attempts（不可枚举），explainAttempts 拿它说清是哪一种。
export async function openInbox(account, pass, { proxy = null, routes = null, limits = {}, users = imapUsers(account), options = {}, deadline = null, member = 'owl' } = {}) {
  const list = routes || [{ proxy, server: account.imap }];
  const attempts = [];
  for (const [i, r] of list.entries()) {
    if (i > 0 && deadline && deadline - Date.now() < 2500) break;
    const t0 = Date.now();
    try {
      const opened = await openVia({ ...account, imap: r.server }, pass, { proxy: r.proxy, limits, users, options });
      remember('imap', list, r, member);
      return { ...opened, route: r, recovery: attempts.some(a => a.proxy) && !r.proxy ? { from: 'proxy', to: 'direct' } : null };
    } catch (error) {
      attempts.push({ proxy: r.proxy, host: r.server.host, port: r.server.port, error, waited: Date.now() - t0 });
      if (!connectionFailure(error)) break;
    }
  }
  throw hide(attempts.at(-1).error, attempts);
}
async function openVia(account, pass, { proxy, limits, users, options }) {
  let lastError = null;
  for (const user of users) {
    const client = new ImapFlow({ ...imapOptions(account, user, pass, { proxy, limits }), ...options });
    client.on('error', () => {}); // 断线由下面的 await 报出来；没人接的 error 事件会让进程退出
    try {
      await client.connect();
      const box = await client.mailboxOpen('INBOX', { readOnly: true });
      return { client, user, box };
    } catch (e) {
      lastError = e;
      try { client.close(); } catch {} // 兜底：连接已经断了
      if (!(e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED')) break;
    }
  }
  throw lastError || fail('mail_no_login', '没有可用的登录名');
}

// ── 测试连接 ─────────────────────────────────────────────────────────────────────
async function imapProbe(account, pass, { routes, limits, deadline }) {
  let opened;
  try { opened = await openInbox(account, pass, { routes, limits, deadline }); } catch (error) { return { ok: false, error }; }
  const { client, user, box, route } = opened;
  try {
    let latest = null;
    if (box.exists > 0) {
      const m = await client.fetchOne('*', { envelope: true, internalDate: true, uid: true });
      if (m) latest = { subject: String(m.envelope?.subject || '').slice(0, 200), at: toIso(m.internalDate || m.envelope?.date) };
    }
    // 收件箱现在读到哪一封（保存时给读信记起点，lib/mail/read.mjs）：UIDNEXT 减一，没给就取最后一封的 UID。
    let top = Number(box.uidNext) > 0 ? Number(box.uidNext) - 1 : 0;
    if (!top && box.exists > 0) top = Number((await client.fetchOne('*', { uid: true }))?.uid) || 0;
    await client.logout().catch(() => {}); // 兜底：退出登录失败不影响刚才的检查结果
    return { ok: true, user, count: box.exists, latest, uidvalidity: String(box.uidValidity), top, route };
  } catch (error) {
    try { client.close(); } catch {} // 兜底：连接已经断了
    return { ok: false, error };
  }
}
const toIso = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null; };

// 连上、登录，不发信，说再见。
async function smtpProbe(account, pass, { routes, limits, deadline }) {
  let open;
  try { open = await smtpOpen(account, pass, { routes, limits, deadline }); } catch (error) { return { ok: false, error }; }
  const { conn, opts, closed, route } = open;
  const r = await Promise.race([closed.then((error) => ({ ok: false, error })), new Promise((resolve) => conn.login(opts.auth, (e) => resolve(e ? { ok: false, error: e } : { ok: true })))]);
  try { conn.quit(); } catch {} // 兜底：连接已经断了
  setTimeout(() => { try { conn.close(); } catch {} }, 2000).unref?.(); // 兜底：连接已经关了
  return { ...r, route };
}

// account：{ address, login?, imap, smtp }（lib/mail/providers.mjs 的设置，加上地址）；pass：授权码。
// 回 { ok: true, imap_user, count, latest, uidvalidity, top } 或 { ok: false, step, kind, reason, server? }。授权码不会出现在返回值里。
// limits 只给测试用（把超时调短）。
// budgetMs：整次测试最多用多久（设置页点「测试」是 20 秒，lib/mail/api.mjs）。IMAP 头一次加密握手偶发失败、还来得及就再试一次；
// SMTP 用剩下的时间，到点算发信不通——收信通、发信不通回 { ok: false, step: 'smtp', imap_ok: true, …收信那几样 }，存的时候进「只收信」。
const TRANSIENT = new Set(['tls', 'network', 'timeout']);
export async function testConnection(account, pass, { provider = null, env = process.env, limits = {}, budgetMs = null } = {}) {
  const started = Date.now(), left = () => (budgetMs ? budgetMs - (Date.now() - started) : Infinity);
  const deadline = budgetMs ? started + budgetMs : null;
  let imapRoutes, smtpRoutes;
  try {
    checkServer(account.imap, 'IMAP'); checkServer(account.smtp, 'SMTP');
    imapRoutes = routesFor('imap', account, { provider, env }); smtpRoutes = routesFor('smtp', account, { provider, env });
  } catch (e) { return { ok: false, step: 'config', ...explain(e, { provider }) }; }
  const secrets = [pass];
  const imapLimits = budgetMs ? { connectionTimeout: 8000, greetingTimeout: 7000, socketTimeout: 12000, ...limits } : limits;
  let imap = await imapProbe(account, pass, { routes: imapRoutes, limits: imapLimits, deadline });
  // 第 6b 轮：经代理连 Gmail，头一次加密握手偶发失败（主会话实测第二次就好）：时间还够就再试一次，不让一次偶发就判失败。
  // 头一次的错记下（只记类别和代号，不记服务器原话）：运行日志里看得出是不是又试了一次（lib/mail/api.mjs）。
  let retried = null;
  if (!imap.ok) { const k = explain(imap.error, { step: 'imap', provider }).kind; if (TRANSIENT.has(k) && left() > 9000) { retried = `${k}${imap.error?.code ? ` ${String(imap.error.code).slice(0, 30)}` : ''}`; imap = await imapProbe(account, pass, { routes: imapRoutes, limits: imapLimits, deadline }); } }
  // 收信没通也测一下发信（G9：收发分别报结果）：只在收信是线路问题（网络、超时、加密握手、代理）时测，还要剩得下时间。
  // 授权码不对、被限流这类：同一个码再登一次发信只会多一次失败登录（163、QQ 限制登录频率），不测，说没测。
  if (!imap.ok) {
    const failed = { ok: false, step: 'imap', ...(retried ? { imap_retry: retried } : {}), ...(await explainAttempts(imap.error, { step: 'imap', provider, host: account.imap.host, port: account.imap.port, secrets })) };
    if (!['network', 'timeout', 'tls', 'proxy'].includes(failed.kind) || left() < 4000) return failed;
    const cap0 = Math.max(3000, Math.min(15000, left() - 1500)), t0 = Date.now();
    const s0 = await smtpProbe(account, pass, { routes: smtpRoutes, deadline, limits: budgetMs ? { connectionTimeout: cap0, greetingTimeout: cap0, socketTimeout: cap0, ...limits } : limits });
    return { ...failed, smtp: s0.ok ? { ok: true } : { ok: false, ...(await explainAttempts(s0.error, { step: 'smtp', provider, host: account.smtp.host, port: account.smtp.port, proxy: s0.route?.proxy || null, secrets, waited: Date.now() - t0 })) } };
  }
  const cap = Math.max(3000, Math.min(15000, left() - 1500)), t1 = Date.now();
  const smtp = await smtpProbe(account, pass, { routes: smtpRoutes, deadline, limits: budgetMs ? { connectionTimeout: cap, greetingTimeout: cap, socketTimeout: cap, ...limits } : limits });
  const via = imap.route?.proxy;
  const base = { imap_user: imap.user, count: imap.count, latest: imap.latest, uidvalidity: imap.uidvalidity, top: imap.top, ...(via ? { proxy: proxyLabel(via) } : {}) };
  if (retried) base.imap_retry = retried;
  if (!smtp.ok) return { ok: false, step: 'smtp', imap_ok: true, ...base, ...(await explainAttempts(smtp.error, { step: 'smtp', provider, host: account.smtp.host, port: account.smtp.port, proxy: smtp.route?.proxy || null, secrets, waited: Date.now() - t1 })) };
  return { ok: true, ...base };
}
