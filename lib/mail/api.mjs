// /api/mail（bin/serve.mjs）：内置邮箱的状态、测试、保存、断开。界面（引导的「邮箱」一步、设置 → 账号与连接 → 邮箱）以后接。
//   GET   mailView()：只回地址、哪种邮箱、连没连上（连不上时一句原因）。从不回授权码。
//   POST  mailPost({ action, … })：
//           detect      { address }                 认邮箱：哪一家、要什么码、说明在哪一节；认不出的再查一次 MX
//           test        { address, code, login? }   用粘贴的授权码登录一次，读出最新一封信的标题；不保存
//           save        { address, code, login? }   先测试，通过了才加密保存
//           retest      {}                          用保存的授权码再测一次，记下结果
//           disconnect  {}                          删掉保存的账号和授权码（钥匙串不动）
//         演示 / 沙盒模式下还收 servers：{ imap: { host, port, plain? }, smtp: { … } }，只许本机的测试服务器。
// 授权码只在内存里过一下：不写日志、不进返回值、不进运行日志。同一时间只跑一次测试（163、QQ 限制登录频率）。
import { event } from '../events.mjs';
import { currentMailbox } from '../facts.mjs';
import { ADDRESS, normalizeAddress, providerFor, classifyDomain, providerSummary, PROVIDERS } from './providers.mjs';
import { testConnection, isLoopback, localOnly } from './connect.mjs';
import { loadAccount, saveAccount, loadSecret, markChecked, forgetAccount } from './vault.mjs';
import fs from 'node:fs';
import { file, lines } from '../store.mjs';
import { sendWhy } from './send-words.mjs';
import { TZ } from '../tz.mjs';
import { loadCursor, saveCursor, CURSOR_FILE } from './read.mjs';
import { mailView } from './status.mjs';
import { release, listActions } from '../actions.mjs';

export { mailView };

export function releaseMailReads(address, options = {}) {
  const key = String(address || '').toLowerCase();
  if (!key) return { released: 0, kinds: [] };
  // 邮箱地址可以含 _ 和 %；按整串比较，不能把它作为 SQL LIKE 模式释放别人的任务。
  const ids = listActions({ kind: 'read_mail', state: 'approved' }).filter(a => a.hold === `mail_read:${key}`).map(a => a.id);
  return release({ ...options, code: 'mail_read', ids, kinds: ['read_mail'] });
}

const fail = (status, message) => Object.assign(Error(message), { status });

// 粘进来的授权码去掉所有空白再测、再存：Google 给的是「xxxx xxxx xxxx xxxx」，网页复制时还可能带上看不见的零宽字符（\s 管不到）。
// 横线是码的一部分（iCloud 的 App 专用密码就带），不动。
export const cleanCode = (v) => String(v ?? '').replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '');
function parseCode(v) {
  const code = cleanCode(v);
  if (!code) throw fail(400, '先把授权码粘贴进来');
  if (code.length < 4 || code.length > 64 || !/^[\x21-\x7e]+$/.test(code)) throw fail(400, '授权码的格式不对，重新复制一次');
  return code;
}
function parseAddress(v) {
  const address = normalizeAddress(v || currentMailbox());
  if (!address) throw fail(400, '先填邮箱地址');
  if (!ADDRESS.test(address) || address.length > 254) throw fail(400, '邮箱地址不对，再看一下');
  return address;
}
function parseLogin(v) {
  const login = String(v ?? '').trim();
  if (!login) return null;
  if (login.length > 254 || /\s/.test(login)) throw fail(400, '登录名不对');
  return login;
}
// 沙盒里连本机测试服务器用；正式运行不收。
function parseServers(v) {
  if (v == null) return null;
  if (!localOnly()) throw fail(400, '只有演示 / 沙盒模式能指定服务器');
  const one = (s, which) => {
    const host = String(s?.host || '').trim(), port = Number(s?.port);
    if (!isLoopback(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, `${which} 服务器只能是本机`);
    return { host, port, plain: s?.plain === true, ...(s?.secure === true ? { secure: true } : {}) };
  };
  return { imap: one(v.imap, 'IMAP'), smtp: one(v.smtp, 'SMTP') };
}

// 要连的那个账号：邮箱的预设，或者沙盒里给的本机服务器。
async function target(body) {
  const address = parseAddress(body.address);
  // 沙盒里演示设置页时，可以用 RADAR_MAIL_SERVERS（JSON：{ imap: { host, port, plain }, smtp: … }，只能是本机）把邮箱指到本机的测试服务器。
  const servers = parseServers(body.servers ?? (localOnly() && process.env.RADAR_MAIL_SERVERS ? JSON.parse(process.env.RADAR_MAIL_SERVERS) : null));
  const login = parseLogin(body.login);
  if (servers) {
    const p = providerFor(address);
    const provider = p.supported ? p : { provider: 'test', label: '测试邮箱', code: '授权码' };
    return { provider, account: { address, login, provider: provider.provider, imap: servers.imap, smtp: servers.smtp }, servers };
  }
  const p = localOnly() ? providerFor(address) : await classifyDomain(address);
  if (!p.supported) throw Object.assign(fail(422, p.reason), { kind: p.kind });
  return { provider: p, account: { address, login, provider: p.provider, imap: p.imap, smtp: p.smtp }, servers: null };
}

// 保存过的账号，连的时候用哪组服务器：沙盒存的本机服务器，否则按邮箱类型现取预设（预设改了跟着走）。
function savedTarget(a) {
  if (a.servers) {
    if (!localOnly()) throw fail(409, '这份邮箱设置只在演示 / 沙盒模式里能用');
    return { provider: PROVIDERS[a.provider] ? { provider: a.provider, ...PROVIDERS[a.provider] } : { provider: 'test', label: '测试邮箱', code: '授权码' }, account: { ...a, imap: a.servers.imap, smtp: a.servers.smtp } };
  }
  const p = providerFor(a.address);
  const preset = p.supported ? p : PROVIDERS[a.provider] ? { supported: true, provider: a.provider, ...PROVIDERS[a.provider] } : null;
  if (!preset) throw fail(409, '这个邮箱现在接不上了，重新连一次');
  return { provider: preset, account: { ...a, imap: preset.imap, smtp: preset.smtp } };
}

// 测试结果对外的样子：不带授权码，也不带服务器回的原话以外的东西。
// 收信通、发信不通（第 6b 轮）：算连上，只收信——照常读信、分类；send 写清发信为什么不通。
const receiveOnly = r => !r.ok && r.step === 'smtp' && !!r.imap_ok;
const settled = r => receiveOnly(r) ? { ...r, ok: true, receive_only: true, send: { kind: r.kind, reason: r.reason, ...(r.server ? { server: r.server } : {}) } } : r;
// 收信、发信分别一句（G9：以前只写「连通了：收件箱最新一封……」，看不出发信测没测）。发信只登录发信服务器，不真的发一封。
export function checksOf(r) {
  const receive = r.ok || r.imap_ok ? { ok: true, text: '收信通了' } : r.step === 'imap' || r.step === 'config' || r.step === 'secret' ? { ok: false, text: r.reason || '收信没通' } : { ok: null, text: '收信没测' };
  const send = r.ok && !r.receive_only ? { ok: true, text: '发信通了（登录了发信服务器，没有真的发信）' }
    : r.receive_only ? { ok: false, text: r.send?.reason || '发信不通' }
    : r.smtp ? (r.smtp.ok ? { ok: true, text: '发信通了（登录了发信服务器，没有真的发信）' } : { ok: false, text: r.smtp.reason || '发信不通' })
    : { ok: null, text: ['auth', 'unsafe', 'throttle', 'secret'].includes(r.kind) ? '发信没测（同一个授权码，收信已经登不上）' : '发信没测（收信那一步就停了）' };
  return { receive, send };
}
const publicResult = (r0) => { const r = settled(r0); return {
  ok: !!r.ok, checks: checksOf(r),
  ...(r.receive_only ? { receive_only: true, send: r.send } : {}),
  ...(r.ok ? {} : { step: r.step, kind: r.kind, reason: r.reason, ...(r.server ? { server: r.server } : {}) }),
  ...(r.latest !== undefined ? { latest: r.latest } : {}),
  ...(r.count !== undefined ? { count: r.count } : {}),
  ...(r.proxy ? { proxy: r.proxy } : {}),
}; };

// 最近一次真发信没发出去（state/send-requests.ndjson：还排着或失败、记着上次的错，之后没有发出过的）：一句话，没有是 null。
export function lastSendFailure({ requests = lines('state/send-requests.ndjson'), now = Date.now() } = {}) {
  const mail = requests.filter(r => (r.channel || 'email') === 'email');
  const bad = mail.filter(r => ['queued', 'failed'].includes(r.status) && r.last_error && r.last_try_at && now - Date.parse(r.last_try_at) < 7 * 86400000).sort((a, b) => Date.parse(b.last_try_at) - Date.parse(a.last_try_at))[0];
  if (!bad) return null;
  if (mail.some(r => r.status === 'sent' && Date.parse(r.sent_at || r.checked_at || r.at || 0) > Date.parse(bad.last_try_at))) return null;
  const at = new Date(bad.last_try_at).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `最近一次真发信（${at}）没发出去：${sendWhy(bad)}`;
}
let running = false;
// 设置页、引导点「测试」「保存」最多等这么久（第 6 轮：Gmail 经系统代理连，连接、问候、读写的超时一项项叠起来能到一两分钟，
// 页面上一直没动静，负责人以为「没有反应」）。到点就回「超时」，后台那次连接自己会因为超时断掉。
export const TEST_DEADLINE_MS = 20000;
function withDeadline(work, ms, provider) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, step: 'imap', kind: 'timeout', reason: `连邮箱 ${Math.round(ms / 1000)} 秒没有回应。${provider?.blocked_in_cn ? 'Gmail 在国内要经代理才连得上，看看代理开着没有，再试一次。' : '看看网络，过一会儿再试。'}` }), ms); });
  return Promise.race([work.finally(() => clearTimeout(timer)), late]);
}
async function once(fn) {
  if (running) throw fail(409, '正在测试邮箱，等这一次结束');
  running = true;
  try { return await fn(); } finally { running = false; }
}

export async function mailPost(body = {}, { deadlineMs = TEST_DEADLINE_MS } = {}) {
  const action = String(body.action || '');
  if (action === 'detect') {
    const address = parseAddress(body.address);
    const p = localOnly() ? providerFor(address) : await classifyDomain(address);
    return { address, ...providerSummary(p) };
  }
  if (action === 'test' || action === 'save') {
    const code = parseCode(body.code);
    const { provider, account, servers } = await target(body);
    const t0 = Date.now();
    const r0 = await once(() => withDeadline(testConnection(account, code, { provider, budgetMs: deadlineMs }), deadlineMs, provider)), r = settled(r0);
    // 运行日志里记一行：点了以后请求到没到、回没回来、怎么回的（第 6 轮：负责人点了「测试」「保存」，日志里一条都没有，查不出卡在哪）。
    // 只记哪种邮箱、哪一步、什么类别、几秒；不记授权码、不记服务器的原话。
    if (action === 'test' || !r.ok) event('owl', 'mail-connect', r.ok ? 'ok' : 'fail', `邮箱${action === 'save' ? '保存前的测试' : '测试'}${r.receive_only ? `收信通了、发信不通（smtp · ${r.send?.kind || '?'}）` : r.ok ? '连通了' : `没通过（${r.step || '?'} · ${r.kind || '?'}）`}${r0.imap_retry ? `（收信头一次 ${r0.imap_retry}，又试了一次）` : ''}：${provider.label || '测试邮箱'} · ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    if (action === 'test' || !r.ok) return publicResult(r);
    await saveAccount({ address: account.address, provider: account.provider, login: account.login, imap_user: r.imap_user, servers, ...(r.receive_only ? { send: { ok: false, kind: r.send.kind, reason: String(r.send.reason || '').slice(0, 300), at: new Date().toISOString() } } : {}) }, code);
    // 读信从现在的最新一封往后读（以前的信不读）。同一个邮箱重新填授权码时游标不动，中间到的信照样读到。
    const cur = loadCursor();
    if (!cur || cur.address !== account.address || String(cur.uidvalidity) !== String(r.uidvalidity)) saveCursor({ address: account.address, uidvalidity: String(r.uidvalidity), last_uid: Number(r.top) || 0, checked_at: new Date().toISOString() });
    event('owl', 'mail-connect', 'ok', `邮箱接好了：${provider.label || '测试邮箱'}${r.receive_only ? '（只收信：发信不通）' : ''}`);
    releaseMailReads(account.address);
    return { ...publicResult(r), saved: true, mail: mailView() };
  }
  if (action === 'retest') {
    const a = loadAccount();
    if (!a) throw fail(409, '还没连邮箱');
    const { provider, account } = savedTarget(a);
    let code;
    try { code = await loadSecret(a); } catch (e) {
      markChecked({ ok: false, kind: 'secret', reason: e.message });
      return { ok: false, step: 'secret', kind: 'secret', reason: e.message, mail: mailView() };
    }
    const r = settled(await once(() => withDeadline(testConnection(account, code, { provider, budgetMs: deadlineMs }), deadlineMs, provider)));
    markChecked(r);
    if (r.ok) releaseMailReads(account.address);
    const out = publicResult(r), last = lastSendFailure();
    // 发信服务器登录通了，可最近一次真发信没发出去：一起说，登录通不等于一定发得出。
    if (out.checks.send.ok && last) out.checks.send = { ...out.checks.send, note: last };
    return { ...out, mail: mailView() };
  }
  if (action === 'disconnect') {
    const removed = forgetAccount();
    // 读信的游标也删：以后重新连上，从那时最新的一封往后读，不把断开期间的旧信当新信。
    try { fs.unlinkSync(file(CURSOR_FILE)); } catch {} // 兜底：读信的游标本来就不在就不用删
    if (removed) event('owl', 'mail-connect', 'skip', '邮箱断开了：保存的授权码已删除');
    return { ok: true, removed, mail: mailView() };
  }
  throw fail(400, '未知的邮箱操作');
}
