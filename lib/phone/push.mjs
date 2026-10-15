// 新消息提醒（手机第二里程碑 C3，design/phone-m2/实施方案.md 第十节「新消息提醒」）：这台 Mac 自己就是 Web Push 的发送方，
// 不经过中转，也不用负责人去哪里配置什么。
//
//   密钥   VAPID（P-256）第一次用到时在 Mac 上生成，存 private/phone/push.json（600，和 mac.json 一样）；公钥只经加密通道给配好的手机（push.key）。
//   订阅   每部手机一份 { endpoint, p256dh, auth }，记在 devices.json 这部手机的记录上（push_sub；/api/phone 里 push 为 true）；
//          解除配对时和记录一起删掉。endpoint 只认 https 上真正的推送服务（APPLE / 谷歌 / Mozilla / 微软，见 PUSH_HOSTS），别的一律拒（防 SSRF）。
//   发送   RFC 8291 aes128gcm 端到端加密 + RFC 8292 VAPID（ES256 JWT），带 TTL、Urgency、Topic（同一件事的提醒互相顶掉）；只用 node:crypto。
//          404 / 410：这份订阅没了，删掉；429 / 5xx / 连不上：退避一会儿再发（留着没发的）；别的错：这一条不发了。从不记内容和密钥。
//   内容   { title, body, url, tag }：url 是手机 App 里的位置（#talk/<会话> 或 #wait/<信>）。加密的，推送服务看不到，所以可以带一句话。
//   什么时候推
//          (a) 这部手机说过话的对话里，有了新回复（执行器写回的话）或者交代的事做完 / 卡住 / 等你（lib/talk.mjs talkState 的 landed）；
//          (b) 收件箱里多了一件等你拍板的事（以前没见过的信；「新线索筛选」这种成批的不推）；
//          (c) 就是 (a) 里「做完了」那一种。
//          普通岗位推荐、系统拟投的待批准攒 15 分钟摘要；回复、面试、登录、发送结果核实等仍及时推，每部手机最多 20 秒一次。
//          页面正开着、订阅着实时更新的手机不推（它自己看得到）；
//          夜里（lib/personas.mjs inQuietHours）先攒着，天亮合成一条再推；只有这部手机 15 分钟内刚说过话的那段对话照推。
//   沙盒   从不真的发。唯一的例外给测试：沙盒里 OFFERCREW_PUSH_TEST_ENDPOINT 指向本机回环地址（http://127.0.0.1:端口）时，
//          那个地址上的订阅照常加密、签名、发出——发给测试里的假推送服务，东西出不了这台电脑。
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { sandboxed, ownWorkbench } from '../sandbox.mjs';
import { event } from '../events.mjs';
import { memberName } from '../members.mjs';
import { phoneHref } from '../routes.mjs';
import { recommendationAsks, recommendationFocus, summaryPicks } from '../recommend-summary.mjs';

export const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
export const PUSH_SUFFIXES = ['.notify.windows.com'];
export const COALESCE_MS = 20000;
export const ROUTINE_SUMMARY_MS = 15 * 60000;
export const QUIET_EXEMPT_MS = 15 * 60000;
export const TICK_MS = 60000;
export const BACKOFF = { first: 30000, max: 15 * 60000, retryAfterMax: 3600000 };
export const PUSH_ASK_TYPES = new Set(['interview', 'login', 'review', 'decide', 'info', 'followup']); // triage（新线索筛选）一来一批，不推
export const RS = 4096;
const SEEN_KEEP_MS = 48 * 3600000, MAX_PENDING = 50, MAX_SESSIONS = 8;
const DEFAULT_CONTACT = 'https://offercrew.onemaple.cc';
const b64u = b => Buffer.from(b).toString('base64url');
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;
const unb64u = s => { const t = String(s ?? ''); if (!B64U.test(t)) throw Error('bad base64url'); return Buffer.from(t, 'base64url'); };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fail = (code, message) => Object.assign(Error(message), { code });
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

// ── 推送地址 ────────────────────────────────────────────────────────────────
// 测试用的假推送服务：只在沙盒里、只认本机回环地址上的 http。
export function testOrigin(env = process.env) {
  const v = env.OFFERCREW_PUSH_TEST_ENDPOINT;
  if (!v || !sandboxed()) return null;
  try { const u = new URL(v); return u.protocol === 'http:' && LOOPBACK.includes(u.hostname) ? u.origin : null; } catch { return null; } // 兜底：地址写得不对就当没有本机推送地址
}
// null = 能用；否则是一句拒绝的理由。
export function checkEndpoint(raw, { test = null } = {}) {
  const s = String(raw ?? '');
  if (!s || s.length > 1024) return '推送地址不对';
  let u;
  try { u = new URL(s); } catch { return '推送地址不对'; }
  if (u.username || u.password) return '推送地址不对';
  if (test && u.origin === test) return null;
  if (u.protocol !== 'https:' || u.port) return '推送地址要是 https';
  const h = u.hostname.toLowerCase();
  if (PUSH_HOSTS.includes(h) || PUSH_SUFFIXES.some(x => h.endsWith(x) && h.length > x.length)) return null;
  return '不认识的推送服务';
}
// 手机交来的订阅：endpoint + 手机的公钥（P-256，65 字节未压缩）+ 16 字节的 auth。
export function cleanSubscription(a = {}, { test = null } = {}) {
  const endpoint = String(a?.endpoint ?? ''), why = checkEndpoint(endpoint, { test });
  if (why) throw fail('bad_endpoint', why);
  let pub, auth;
  try { pub = unb64u(a?.keys?.p256dh); auth = unb64u(a?.keys?.auth); } catch { throw fail('bad_keys', '订阅的钥匙不对'); }
  if (pub.length !== 65 || pub[0] !== 4 || auth.length !== 16) throw fail('bad_keys', '订阅的钥匙不对');
  try { crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' }); }
  catch { throw fail('bad_keys', '订阅的钥匙不对'); }
  return { endpoint, p256dh: b64u(pub), auth: b64u(auth) };
}

// ── VAPID（RFC 8292）────────────────────────────────────────────────────────
export function newVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  return { jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d }, pub: rawPublic(j) };
}
export const rawPublic = jwk => b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
export function vapidJwt({ jwk, aud, sub, exp }) {
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), p = b64u(JSON.stringify({ aud, exp, sub }));
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(sig)}`;
}

// ── 加密（RFC 8291 + RFC 8188 aes128gcm，一条记录）────────────────────────────
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
// salt、asPrivate 只给测试（RFC 8291 附录 A 的固定值）；平时每次随机。
export function encryptPayload({ p256dh, auth, payload, salt = crypto.randomBytes(16), asPrivate = null, rs = RS }) {
  const ua = unb64u(p256dh), secret = unb64u(auth), ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(Buffer.from(asPrivate)); else ecdh.generateKeys();
  const as = ecdh.getPublicKey(), shared = ecdh.computeSecret(ua);
  const ikm = hmac(hmac(secret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plain.length + 16 > rs) throw fail('too_big', '提醒内容太长');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); Buffer.from(salt).copy(head, 0); head.writeUInt32BE(rs, 16); head[20] = as.length;
  return Buffer.concat([head, as, body]);
}

// ── 发出去 ──────────────────────────────────────────────────────────────────
// 回 { status, retryAfter }；连不上是 status 0。回环地址上的 http（只有沙盒里的测试会走到）包在 ownWorkbench 里，别的一律 https。
export function postPush(url, { body, headers, timeoutMs = 10000 }) {
  const u = new URL(url), plain = u.protocol === 'http:';
  if (plain && !LOOPBACK.includes(u.hostname)) return Promise.resolve({ status: 0, error: 'refused' });
  const run = () => new Promise(resolve => {
    let done = false; const end = v => { if (!done) { done = true; resolve(v); } };
    const req = (plain ? http : https).request(u, { method: 'POST', timeout: timeoutMs, headers: { ...headers, 'content-length': String(body.length) } }, res => {
      res.resume();
      res.on('end', () => end({ status: res.statusCode, retryAfter: res.headers['retry-after'] || null }));
      res.on('error', () => end({ status: res.statusCode || 0 }));
    });
    req.on('timeout', () => req.destroy(Error('timeout')));
    req.on('error', e => end({ status: 0, error: e.code || 'error' }));
    req.end(body);
  });
  return plain ? ownWorkbench(run) : run();
}

// ── 要推什么 ────────────────────────────────────────────────────────────────
// landed：lib/talk.mjs talkState().landed；asks：inboxView().asks。都变成 { key, kind, session_id? | ask_id?, from, title?, text? }。
export function pushItems({ landed = [], asks = [], recommendations = [] } = {}) {
  const out = [];
  // apply: 是尚未批准的系统拟投；review/draft 也可能是回复或发送结果核实，不按大类延迟。
  for (const a of asks || []) if (a?.id && PUSH_ASK_TYPES.has(a.type)) out.push({ key: `ask:${a.id}`, kind: 'ask', ask_id: String(a.id), from: a.from || null, title: cut(a.title, 60), ...(a.type === 'decide' && String(a.id).startsWith('apply:') ? { routine: true } : {}) });
  for (const l of landed || []) if (l?.key && l.session_id && ['reply', 'done', 'needs_you', 'stuck'].includes(l.kind)) out.push({ key: String(l.key), kind: l.kind, session_id: String(l.session_id), from: l.persona || null, title: cut(l.title, 60), text: cut(l.text, 80) });
  for (const a of recommendationAsks(recommendations)) out.push({ key: `recommendation:${a.lead.record_id}`, kind: 'recommendation', recommended_at: a.recommendation_at, ask_id: String(a.id), from: 'lens', title: cut([a.lead.company, a.lead.role].filter(Boolean).join(' · '), 80), lead: { record_id: a.lead.record_id, company: a.lead.company } });
  return out;
}
const who = from => (from ? cut(memberName(from), 20) || 'OfferCrew' : 'OfferCrew');
// 点提醒打开手机上的哪一页（lib/routes.mjs phoneHref，web/phone/logic.js route 认的写法）。
const hashUrl = (kind, id) => kind === 'wait' ? phoneHref.wait(String(id)) : phoneHref.talk(encodeURIComponent(String(id)));
const routine = i => i.kind === 'recommendation' || i.routine === true;
function one(i) {
  if (i.kind === 'recommendation') return { title: 'OfferCrew 推荐岗位', body: i.title || '有一个合适岗位可以看看', url: hashUrl('wait', i.ask_id), tag: `recommendation-${i.ask_id}` };
  if (i.kind === 'ask') return { title: who(i.from), body: i.title || '有一件事等你拍板', url: hashUrl('wait', i.ask_id), tag: `wait-${i.ask_id}` };
  const body = i.kind === 'reply' ? i.text || '有新回复' : i.kind === 'done' ? `做完了：${i.title || '你交代的事'}` : i.kind === 'stuck' ? `卡住了：${i.title || '你交代的事'}` : `等你确认：${i.title || '你交代的事'}`;
  return { title: who(i.from), body, url: hashUrl('talk', i.session_id), tag: `talk-${i.session_id}` };
}
// 攒下的几条 → 一条提醒。
export function compose(items) {
  if (items.length === 1) return one(items[0]);
  const sessions = new Set(items.filter(i => i.session_id).map(i => i.session_id)), asks = items.filter(i => i.kind === 'ask'), recommendations = items.filter(i => i.kind === 'recommendation');
  const url = asks.length ? phoneHref.wait() : recommendations.length ? phoneHref.wait(recommendationFocus(recommendations.map(i => i.ask_id))) : sessions.size === 1 ? hashUrl('talk', [...sessions][0]) : phoneHref.talk();
  const body = items.every(routine) ? [recommendations.length && `${recommendations.length} 个推荐岗位`, asks.length && `${asks.length} 个投递待批`].filter(Boolean).join(' · ') : `${items.length} 条新消息`;
  return { title: 'OfferCrew', body, url, tag: 'offercrew' };
}
export const urgencyOf = items => (items.some(i => (i.kind === 'ask' && !routine(i)) || i.kind === 'needs_you') ? 'high' : 'normal');
export const ttlOf = items => (items.some(i => i.kind === 'ask') ? 86400 : 6 * 3600);
export const topicOf = tag => crypto.createHash('sha256').update(String(tag)).digest('base64url').slice(0, 32);
const summaryBatch = items => {
  const chosen = new Set(summaryPicks(items.filter(i => i.kind === 'recommendation'), { lead: i => i.lead }));
  const selected = items.filter(i => i.kind !== 'recommendation' || chosen.has(i));
  const timely = selected.filter(i => !routine(i)).slice(-MAX_PENDING);
  // 普通岗位多也不能挤掉已排队的回复、登录或发送结果核实。
  const room = MAX_PENDING - timely.length;
  return [...timely, ...(room > 0 ? selected.filter(routine).slice(-room) : [])];
};

// ── 服务 ────────────────────────────────────────────────────────────────────
// svc：PhoneService（devices()、saveDevice()、readPrivate()、writePrivate()、relay()）。
// configure({ items, quiet, visible })：items() 现在该推的全部（pushItems 的结果）、quiet(now) 是不是夜里、visible() 开着页面的手机 id。
export class PushService {
  constructor({ svc, env = process.env, now = () => Date.now(), post = postPush, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer = t => clearTimeout(t) } = {}) {
    Object.assign(this, { svc, env, now, post, setTimer, clearTimer });
    this.items = null; this.quiet = () => false; this.visible = () => [];
    this.seen = null; this.recommendationSince = null; this.pending = new Map(); this.last = new Map(); this.timers = new Map(); this.backoff = new Map(); this.sending = new Set(); this.flights = new Set(); this.logged = new Map();
    this.stats = { sent: 0, dropped: 0, sandbox: 0, failed: 0 };
    this.stopped = false;
  }
  // 正在发的全部（测试等它们发完）。
  get inflight() { return Promise.allSettled([...this.flights]); }
  configure({ items = null, quiet = null, visible = null } = {}) { if (items) this.items = items; if (quiet) this.quiet = quiet; if (visible) this.visible = visible; return this; }
  // register：工作台的调度器（lib/scheduler.mjs register）。给了就由它每分钟叫一次 check（出错按退避、记运行日志），不给（测试、单独用）自己起计时器。
  start({ register = null } = {}) {
    this.stopped = false;
    if (this.tick || this.unregister) return this;
    if (register) this.unregister = register('phone-push', { every: TICK_MS, label: '手机新消息提醒', run: () => ({ new_items: this.check(), subscribers: this.subscribers().length, queued: [...this.pending.values()].reduce((n, q) => n + q.length, 0), delivered_total: this.stats.sent, failed_total: this.stats.failed }) });
    else { this.tick = setInterval(() => this.check(), TICK_MS); this.tick.unref?.(); }
    return this;
  }
  stop() { this.stopped = true; clearInterval(this.tick); this.tick = null; this.unregister?.(); this.unregister = null; for (const t of this.timers.values()) this.clearTimer(t.timer); this.timers.clear(); }

  vapid() {
    const v = this.svc.readPrivate('push.json', null);
    if (v?.jwk?.d && v?.pub) return v;
    const k = { ...newVapid(), created_at: new Date(this.now()).toISOString() };
    this.svc.writePrivate('push.json', k);
    return k;
  }
  contact() { const r = this.svc.relay?.(); return r && r.startsWith('https:') ? r : DEFAULT_CONTACT; }
  subscribers() { return this.svc.devices().filter(d => d.push_sub?.endpoint); }

  // 经加密通道来的三个方法（lib/phone/gateway.mjs 转过来）。
  async handle(dev, m, a = {}) {
    if (m === 'push.key') return { key: this.vapid().pub };
    if (m === 'push.subscribe') return this.subscribe(dev.id, a);
    if (m === 'push.unsubscribe') return this.unsubscribe(dev.id);
    throw fail('unknown_method', '回电脑处理');
  }
  subscribe(id, a) {
    const sub = cleanSubscription(a, { test: testOrigin(this.env) });
    this.vapid();
    const list = this.svc.devices(), dev = list.find(d => d.id === id);
    if (!dev) throw fail('gone', '这部手机已经和电脑断开');
    const same = dev.push === true && dev.push_sub && ['endpoint', 'p256dh', 'auth'].every(k => dev.push_sub[k] === sub[k]);
    const at = new Date(this.now()).toISOString();
    // 重开手机会续报同一订阅；at 是真实启用时间，不是续报时间。
    const enabledAt = same && Number.isFinite(Date.parse(dev.push_sub.at)) ? dev.push_sub.at : at;
    dev.push = true; dev.push_sub = { ...sub, at: enabledAt, updated_at: at };
    this.svc.saveDevice(dev);
    if (!this.seen) this.baseline(); // 订阅之前就有的事不推
    this.backoff.delete(id);
    if (!same) event('user', 'phone', 'ok', `「${dev.name}」打开了新消息提醒`); // 手机每次打开 App 都会再交一次同一份订阅：只记第一次
    return { ok: true, push: true };
  }
  unsubscribe(id) {
    const list = this.svc.devices(), dev = list.find(d => d.id === id);
    if (dev && (dev.push || dev.push_sub)) { dev.push = false; delete dev.push_sub; this.svc.saveDevice(dev); event('user', 'phone', 'ok', `「${dev.name}」关了新消息提醒`); }
    this.forget(id);
    return { ok: true, push: false };
  }
  forget(id) { this.pending.delete(id); this.last.delete(id); this.backoff.delete(id); const t = this.timers.get(id); if (t) this.clearTimer(t.timer); this.timers.delete(id); }
  drop(id, why) {
    const list = this.svc.devices(), dev = list.find(d => d.id === id);
    if (dev?.push_sub) { dev.push = false; delete dev.push_sub; this.svc.saveDevice(dev); event('system', 'phone', 'skip', `「${dev.name}」的新消息提醒失效了（${why}），在手机上重新打开就好`); }
    this.forget(id); this.stats.dropped++;
  }
  // 这部手机在哪段对话里说过话（网关转 /api/talk、第一版的 talk 都记一笔）。
  noteSession(id, session) {
    if (!/^[a-z0-9]{8,32}$/.test(String(session || ''))) return;
    const list = this.svc.devices(), dev = list.find(d => d.id === id);
    if (!dev) return;
    const at = new Date(this.now()).toISOString(), rest = (dev.talk_sessions || []).filter(s => s && s.id !== session);
    dev.talk_sessions = [{ id: session, at }, ...rest].slice(0, MAX_SESSIONS);
    this.svc.saveDevice(dev);
  }

  read() { try { return this.items?.() || []; } catch (e) { this.log('source', `新消息提醒读不到最新的状态：${cut(e?.message || e, 120)}`); return null; } }
  baseline() { const t = this.now(), items = this.read(); if (items) { this.seen = new Map(items.map(i => [i.key, t])); this.recommendationSince = t; } }
  // 看一眼有没有新的事（工作台有更新时、以及每分钟一次）。
  check() {
    if (this.stopped) return 0;
    const subs = this.subscribers();
    if (!subs.length || !this.items) { for (const id of this.pending.keys()) if (!subs.some(d => d.id === id)) this.forget(id); return 0; }
    const t = this.now(), items = this.read();
    if (!items) return 0;
    if (!this.seen) { this.seen = new Map(items.map(i => [i.key, t])); this.recommendationSince = t; return 0; }
    // 来源读取完整已放行推荐；暂缓后重现的旧项不算新批次，只认上次成功检查后放行的推荐。
    const fresh = items.filter(i => !this.seen.has(i.key) && (i.kind !== 'recommendation' || Date.parse(i.recommended_at) >= this.recommendationSince));
    this.recommendationSince = t;
    for (const i of items) this.seen.set(i.key, t);
    for (const [k, at] of this.seen) if (t - at > SEEN_KEEP_MS) this.seen.delete(k);
    for (const dev of subs) {
      const used = new Set((dev.talk_sessions || []).map(s => s.id));
      const mine = fresh.filter(i => i.kind === 'ask' || (i.kind === 'recommendation' && Date.parse(i.recommended_at) >= (Date.parse(dev.push_sub.at) || 0)) || used.has(i.session_id));
      if (mine.length) {
        const q = this.pending.get(dev.id) || [], readyAt = Math.min(...q.filter(routine).map(i => i.ready_at), t + ROUTINE_SUMMARY_MS);
        q.push(...mine.map(i => routine(i) ? { ...i, ready_at: readyAt } : i));
        this.pending.set(dev.id, summaryBatch(q));
      }
    }
    for (const id of [...this.pending.keys()]) this.flush(id);
    return fresh.length;
  }
  // 把攒着的发出去（到点了、不在夜里、页面没开着的话）。
  flush(id) {
    if (this.stopped) return 'stopped';
    let q = this.pending.get(id);
    if (!q?.length) { this.pending.delete(id); return 'none'; }
    const dev = this.svc.devices().find(d => d.id === id);
    if (!dev?.push_sub) { this.forget(id); return 'none'; }
    let visible = [];
    try { visible = this.visible() || []; } catch {} // 兜底：不知道哪些页面开着就当都没开，最多多推一次提醒
    if (visible.includes(id)) { this.pending.delete(id); return 'visible'; } // 页面开着：它自己看得到
    const t = this.now();
    // 摘要等待期间岗位可能被处理、暂缓或移走；到点只提醒仍待办的项。
    // 读不到当前状态时只暂缓普通摘要，不挡已经排队的及时消息。
    let current = null;
    if (q.some(routine)) {
      const items = this.read();
      if (items) {
        current = new Map(items.map(i => [i.key, i]));
        q = q.filter(i => !routine(i) || current.has(i.key)).map(i => routine(i) ? { ...current.get(i.key), ready_at: i.ready_at } : i);
        this.pending.set(id, q);
        if (!q.length) { this.pending.delete(id); return 'none'; }
      }
    }
    let send = q;
    if (this.quiet(t)) {
      const recent = new Set((dev.talk_sessions || []).filter(s => t - Date.parse(s.at || 0) < QUIET_EXEMPT_MS).map(s => s.id));
      send = q.filter(i => i.session_id && recent.has(i.session_id));
      if (!send.length) return 'quiet';
    }
    send = send.filter(i => !routine(i) || (current && i.ready_at <= t));
    if (!send.length) { this.later(id, current ? Math.max(1, Math.min(...q.filter(routine).map(i => i.ready_at)) - t) : TICK_MS); return 'summary'; }
    // 先给全部候选记去重，再限制这一批摘要；限额外的岗位不会下一拍反复补推。
    // 夜里攒了几轮也共用一个名额，不碰消息、申请提醒或岗位收录。
    const recommendations = send.filter(i => i.kind === 'recommendation');
    const chosen = new Set(summaryPicks(recommendations, { lead: i => i.lead }));
    send = send.filter(i => i.kind !== 'recommendation' || chosen.has(i));
    const wait = Math.max((this.last.get(id) || -Infinity) + COALESCE_MS, this.backoff.get(id)?.until || 0) - t;
    if (wait > 0 || this.sending.has(id)) { this.later(id, Math.max(wait, 1000)); return 'later'; }
    this.pending.set(id, q.filter(i => !send.includes(i) && !recommendations.includes(i)));
    if (!this.pending.get(id).length) this.pending.delete(id);
    this.last.set(id, t);
    this.sending.add(id);
    const p = this.deliver(dev, send).catch(() => 'failed').finally(() => { this.sending.delete(id); this.flights.delete(p); this.flush(id); });
    this.flights.add(p);
    return 'sent';
  }
  later(id, ms) {
    if (this.stopped) return;
    const at = this.now() + ms, old = this.timers.get(id);
    if (old && old.at <= at) return;
    if (old) this.clearTimer(old.timer); // 15 分钟摘要不能挡住后来仅需等 20 秒的及时提醒。
    this.timers.set(id, { at, timer: this.setTimer(() => { this.timers.delete(id); this.flush(id); }, ms) });
  }
  async deliver(dev, items) {
    const sub = dev.push_sub, test = testOrigin(this.env);
    const bad = checkEndpoint(sub.endpoint, { test });
    if (bad) { this.drop(dev.id, bad); return 'dropped'; }
    if (sandboxed() && !(test && new URL(sub.endpoint).origin === test)) { this.stats.sandbox++; return 'sandbox'; } // 沙盒里从不真的发
    const msg = compose(items), v = this.vapid();
    let body;
    try { body = encryptPayload({ p256dh: sub.p256dh, auth: sub.auth, payload: JSON.stringify(msg) }); }
    catch { this.drop(dev.id, '订阅的钥匙不对'); return 'dropped'; }
    const jwt = vapidJwt({ jwk: v.jwk, aud: new URL(sub.endpoint).origin, sub: this.contact(), exp: Math.floor(this.now() / 1000) + 12 * 3600 });
    const r = await this.post(sub.endpoint, { body, headers: {
      'content-type': 'application/octet-stream', 'content-encoding': 'aes128gcm', ttl: String(ttlOf(items)), urgency: urgencyOf(items), topic: topicOf(msg.tag),
      authorization: `vapid t=${jwt}, k=${v.pub}`,
    } });
    const s = r?.status || 0;
    if (s >= 200 && s < 300) { this.backoff.delete(dev.id); this.stats.sent++; return 'sent'; }
    if (s === 404 || s === 410) { this.drop(dev.id, '推送服务说这份订阅已经没了'); return 'dropped'; }
    if (s === 0 || s === 429 || s >= 500) {
      const prev = this.backoff.get(dev.id)?.ms || 0, ms = Math.min(prev ? prev * 2 : BACKOFF.first, BACKOFF.max);
      const ra = Number(r?.retryAfter), wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, BACKOFF.retryAfterMax) : ms;
      this.backoff.set(dev.id, { ms, until: this.now() + wait });
      const q = this.pending.get(dev.id) || [];
      this.pending.set(dev.id, summaryBatch([...items, ...q]));
      this.later(dev.id, wait);
      this.stats.failed++;
      this.log(`busy:${dev.id}`, `新消息提醒暂时没发出去（推送服务 ${s || '连不上'}），${Math.round(wait / 1000)} 秒后再试`);
      return 'retry';
    }
    this.stats.failed++;
    this.log(`fail:${dev.id}:${s}`, `新消息提醒没发出去（推送服务回 ${s}）`);
    return 'failed';
  }
  // 同一件事的失败 10 分钟只记一次；只记状态码，不记内容、不记地址。
  log(key, text) {
    const t = this.now(), last = this.logged.get(key) || 0;
    if (t - last < 600000) return;
    this.logged.set(key, t);
    event('system', 'phone', 'fail', text);
  }
}
