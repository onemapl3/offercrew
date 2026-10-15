// 电脑这一边的手机服务：配对、已配对的手机、到中转的连接、把手机发来的密文请求交给 lib/phone/api.mjs（第一版的四件事）
// 或 lib/phone/gateway.mjs（第二阶段：页面请求、代码包、更新推送、分块上传；答复分块、标「只要实时」）。
// 接口契约见桌面版方案附录 F（/api/phone），入口是 lib/phone.mjs。
//
// 本机文件（都在 private/phone/，目录 700、文件 600；任何接口都不返回里面的密钥）：
//   mac.json      这台电脑的身份：房间号、连中转用的令牌、X25519 私钥 / 公钥
//   devices.json  已配对的手机：设备号、名字、根密钥、中转令牌的摘要（令牌本身只在手机上）、防重放记录、hand_off、
//                 新消息提醒的订阅 push_sub 和说过话的会话 talk_sessions（lib/phone/push.mjs）
//   push.json     新消息提醒用的 VAPID 密钥（lib/phone/push.mjs；公钥只经加密通道给配好的手机）
//   access.ndjson 每个手机请求一行（哪部手机、什么时候、哪个方法 / 接口、结果、用了多久；不记查询参数和内容），按天滚动留 30 天
// 解除配对 = 立刻删掉这部手机的根密钥（之后它发来的帧解不开也不认），同时让中转删掉它的令牌、断开它、清掉给它排队的帧。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as C from './crypto.mjs';
import { RelayLink } from './link.mjs';
import { qrPng } from './qr.mjs';
import { handleRequest, ConfirmTokens } from './api.mjs';
import { PhoneGateway, AccessLog, METHODS as GATEWAY_METHODS, packReply } from './gateway.mjs';
import { PushService } from './push.mjs';
import { file, read } from '../store.mjs';
import { sandboxed } from '../sandbox.mjs';
import { event } from '../events.mjs';
import { noteSwallowed } from '../swallow.mjs';

// 默认的中转（负责人部署的那一个）。手机默认开（负责人 10-01：装好就能配对手机，引导里有配对这一步）。
export const DEFAULT_RELAY = 'https://offercrew.onemaple.cc';
export const REASONS = {
  sandbox: '演示 / 沙盒模式：不连手机',
  unset: '手机中转还没开通',
  unreachable: '连不上中转服务',
  denied: '中转服务不认这台电脑的钥匙，手机暂时连不上',
};
const PAIR_MS = 10 * 60000;
// 页面请求只要实时：在路上放了 5 分钟以上的（比如还没重新部署的旧中转把它排了队）不做。
export const LIVE_MAX_AGE_MS = 5 * 60000;
const fail = (status, message) => Object.assign(Error(message), { status });
const iso = t => new Date(t).toISOString();
const hex = n => crypto.randomBytes(n).toString('hex');

// 中转地址：环境变量 OFFERCREW_PHONE_RELAY（测试、本机开发）> 本机的 config/phone.json 的 relay（自己部署的中转）> 默认的中转。
// 不想用手机：config/phone.json 写 "relay": "off"（或 ""）——关着的时候不探测、不联网，界面只说「手机中转还没开通」。
// 只看本机文件，不看模板 config/phone.example.json（读不到时 store 会退到模板）。演示 / 沙盒模式照旧不连（blocked() 先说沙盒）。
export function relayBase(env = process.env) {
  let v = env.OFFERCREW_PHONE_RELAY;
  if (v == null && fs.existsSync(file('config/phone.json'))) { const c = read('config/phone.json', {}) || {}; if (Object.hasOwn(c, 'relay')) v = c.relay; }
  if (v == null) v = DEFAULT_RELAY;
  v = String(v ?? '').trim();
  if (!v || v === 'off') return null;
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) return null; return u.origin; } catch { return null; } // 兜底：地址写得不对就当没配中转
}
export const isLoopback = base => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname); } catch { return false; } }; // 兜底：地址写得不对就不算本机

// ── 本机文件 ────────────────────────────────────────────────────────────────
const DIR = 'private/phone';
function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(file(path.join(DIR, name)), 'utf8')); } catch { return fallback; } }
function writeJson(name, value) {
  const dir = file(DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {} // 兜底：改不了权限的文件系统（外接盘）就照现在的权限
  const dest = path.join(dir, name), tmp = `${dest}.${process.pid}.${hex(3)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
}

export const publicDevice = d => ({ id: d.id, name: d.name, kind: d.kind || 'pwa', paired_at: d.paired_at || null, last_seen_at: d.last_seen_at || null, push: !!d.push, hand_off: d.hand_off === true });

export class PhoneService {
  constructor({ env = process.env, WebSocketImpl = globalThis.WebSocket, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), probeMs = 60000 } = {}) {
    Object.assign(this, { env, WS: WebSocketImpl, fetch: fetchImpl, now, probeMs });
    this.pairing = null; this.link = null; this.probeAt = 0; this.probeOk = null; this.deps = null;
    this.keyCache = new Map(); this.sessions = new Map(); this.rate = new Map(); this.tokens = new ConfirmTokens(); this.seenWrites = new Map();
    // 同一部手机的帧：收的时候一帧一帧解（防重放要按计数从小到大），发的时候一帧一帧封、按封的顺序发出去。
    this.inq = new Map(); this.outq = new Map(); this.access = new AccessLog({ now }); this.gateway = null;
    // 最近 2 分钟答过的页面请求（改东西的那些）：手机断线重连后原样重发同一帧，电脑不再做一遍，只把上次的答复再发一次。
    this.recent = new Map();
    this.push = new PushService({ svc: this, env, now });
  }
  relay() { return relayBase(this.env); }
  // 沙盒里只允许连本机的中转（测试、开发用），什么都出不了这台电脑。
  // 沙盒先说沙盒（本机回环地址上的测试中转除外），再说没开通。
  blocked() { const r = this.relay(); if (sandboxed() && !(r && isLoopback(r))) return REASONS.sandbox; if (!r) return REASONS.unset; return null; }
  devices() { return (readJson('devices.json', { devices: [] }).devices || []).filter(d => d && d.id); }
  saveDevices(list) { writeJson('devices.json', { devices: list }); }
  saveDevice(dev) { const list = this.devices(); const i = list.findIndex(d => d.id === dev.id); if (i < 0) return; list[i] = dev; this.saveDevices(list); }
  identity() { return readJson('mac.json', null); }
  readPrivate(name, fallback) { return readJson(name, fallback); }
  writePrivate(name, value) { writeJson(name, value); }
  async ensureIdentity() {
    let id = this.identity();
    if (id?.room && id?.token && id?.priv && id?.pub) return id;
    const kp = await C.generateKeyPair(true);
    id = { room: C.b64u(C.randomBytes(16)), token: C.b64u(C.randomBytes(32)), priv: C.b64u(await C.exportPrivate(kp.privateKey)), pub: C.b64u(await C.exportPublic(kp.publicKey)), created_at: iso(this.now()) };
    writeJson('mac.json', id);
    return id;
  }
  wsUrl(room) { return `${this.relay().replace(/^http/, 'ws')}/ws/${room}?as=mac`; }

  // ── 能不能配手机 ──
  async probe() {
    if (this.link?.state === 'online') return true;
    if (sandboxed()) return true; // 沙盒里只会是本机中转；不发 HTTP（沙盒会拦），连接本身会说明连没连上
    if (this.probeOk !== null && this.now() - this.probeAt < this.probeMs) return this.probeOk;
    try {
      const r = await this.fetch(`${this.relay()}/p/health`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json().catch(() => ({})); // 兜底：正文不是 JSON 就当不是我们的中转，下一行算没连上
      this.probeOk = r.ok && j.service === 'offercrew-phone';
    } catch { this.probeOk = false; } // 兜底：连不上中转就是没连上，手机页照实显示
    this.probeAt = this.now();
    return this.probeOk;
  }
  async availability() {
    const b = this.blocked();
    if (b) return { available: false, reason: b };
    if (this.link?.denied) return { available: false, reason: REASONS.denied };
    return (await this.probe()) ? { available: true, reason: null } : { available: false, reason: REASONS.unreachable };
  }
  liveState(p = this.pairing) {
    if (!p) return null;
    if (['waiting', 'confirm'].includes(p.state) && p.expires < this.now()) this.endPairing('expired');
    return p.state;
  }
  publicPairing() {
    const p = this.pairing;
    if (!p) return null;
    const state = this.liveState(p), waiting = state === 'waiting';
    return { id: p.id, state, qr: waiting ? `/api/phone/qr?id=${p.id}` : null, url: waiting ? p.url : null, code: waiting ? p.code : null, expires_at: iso(p.expires), sas: state === 'confirm' ? p.sas : null };
  }
  async view() {
    const av = await this.availability();
    const relay = this.relay();
    return { available: av.available, reason: av.reason, phone_url: av.available ? `${relay}/app/` : null, link: this.link?.state || 'off', pairing: this.publicPairing(), paired: this.devices().map(publicDevice) };
  }
  qr(id) {
    const p = this.pairing;
    if (!p || p.id !== id || this.liveState(p) !== 'waiting') throw fail(404, '没有这个配对码');
    return qrPng(p.url);
  }

  // ── /api/phone 的动作 ──
  async action(body = {}) {
    const action = String(body?.action || ''), id = body?.id == null ? '' : String(body.id);
    const ACTIONS = ['pair_start', 'pair_confirm', 'pair_cancel', 'unpair', 'rename', 'hand_off'];
    if (!ACTIONS.includes(action)) throw fail(400, `没有这个动作：${action.slice(0, 40)}`);
    if (action === 'pair_start') return { pairing: await this.pairStart() };
    if (!id) throw fail(400, '缺少 id');
    if (action === 'pair_confirm') return { pairing: await this.pairConfirm(id) };
    if (action === 'pair_cancel') {
      const p = this.pairing;
      if (!p || p.id !== id) throw fail(404, '没有这个配对');
      if (['waiting', 'confirm'].includes(this.liveState(p))) { this.sendPair({ t: 'cancel' }); this.endPairing('cancelled'); event('user', 'phone', 'ok', '手机配对已取消'); }
      return { pairing: this.publicPairing() };
    }
    const list = this.devices(), dev = list.find(d => d.id === id);
    if (!dev) throw fail(404, '没有这部手机');
    if (action === 'unpair') {
      this.saveDevices(list.filter(d => d.id !== id));
      this.keyCache.delete(id); this.sessions.delete(id); this.rate.delete(id); this.recent.delete(id); this.gateway?.forget(id); this.push.forget(id);
      this.link?.send({ t: 'revoke', d: id }); // 中转不在线也没关系：下次连上时会对账，把它删掉
      event('user', 'phone', 'ok', `解除了和「${dev.name}」的配对，这部手机的密钥已作废`);
      this.idle();
      return { ok: true, paired: this.devices().map(publicDevice) };
    }
    if (action === 'rename') {
      const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
      if (!name || name.length > 30) throw fail(400, '名字要 1–30 个字');
      dev.name = name; this.saveDevices(list);
      return { ok: true, device: publicDevice(dev) };
    }
    if (typeof body.allowed !== 'boolean') throw fail(400, 'allowed 要是 true 或 false');
    dev.hand_off = body.allowed; this.saveDevices(list);
    event('user', 'phone', 'ok', `「${dev.name}」${body.allowed ? '可以' : '不能再'}把活交给本机 AI`);
    return { ok: true, device: publicDevice(dev) };
  }

  async pairStart() {
    const av = await this.availability();
    if (!av.available) throw fail(409, av.reason);
    const idn = await this.ensureIdentity();
    if (this.pairing && ['waiting', 'confirm'].includes(this.liveState())) { this.sendPair({ t: 'cancel' }); this.endPairing('cancelled'); }
    const secret = C.randomBytes(32), code = C.newCode(), fp = await C.fingerprint(C.unb64u(idn.pub));
    const p = { id: `pr_${hex(4)}`, state: 'waiting', code, secret, tag: await C.qrTag(secret), expires: this.now() + PAIR_MS, sas: null, phone: null, stage: 'open' };
    p.url = `${this.relay()}/p#${idn.room}.${C.b64u(secret)}.${fp}`;
    this.pairing = p;
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => { if (this.pairing === p) this.liveState(p); }, PAIR_MS + 500); this.pairTimer.unref?.();
    this.ensureLink();
    this.openPairing();
    // 等中转登记好这次配对再把二维码给出去（最多几秒；连不上也照样返回，连上后会补登记）。
    await new Promise(resolve => { p.onOpened = resolve; const t = setTimeout(resolve, 6000); t.unref?.(); });
    p.onOpened = null;
    event('user', 'phone', 'ok', '开始配对手机（10 分钟内有效）');
    return this.publicPairing();
  }
  openPairing() {
    const p = this.pairing;
    if (p && p.state === 'waiting' && p.stage === 'open') this.link?.send({ t: 'pair_open', pid: p.id, code: C.normalizeCode(p.code), tag: p.tag, expires: p.expires });
  }
  sendPair(m) { const p = this.pairing; if (p) this.link?.send({ t: 'pair_out', pid: p.id, m }); }
  endPairing(state) {
    const p = this.pairing;
    if (!p) return;
    p.state = state; p.secret = null; p.keys = null; p.stage = 'done';
    this.link?.send({ t: 'pair_close', pid: p.id });
    this.idle();
  }
  async pairConfirm(id) {
    const p = this.pairing;
    if (!p || p.id !== id) throw fail(404, '没有这个配对');
    const state = this.liveState(p);
    if (state === 'expired') throw fail(409, '这个码过期了，重新配对一次');
    if (state !== 'confirm') throw fail(409, state === 'waiting' ? '手机还没连上：等手机上出现核对数字再确认' : '这次配对已经结束了');
    if (this.link?.state !== 'online') throw fail(409, '连不上中转服务，手机收不到结果；等连上再确认');
    if (p.stage === 'confirming') throw fail(409, '正在确认，稍等');
    p.stage = 'confirming'; // 连点两下只配一部
    const idn = await this.ensureIdentity(), token = C.b64u(C.randomBytes(32));
    const dev = { id: `dev_${hex(5)}`, name: p.phone.name || '我的手机', kind: 'pwa', pub: p.phone.pub, root: C.b64u(p.keys.root), token_hash: await sha256hex(token), paired_at: iso(this.now()), last_seen_at: iso(this.now()), push: false, hand_off: false, chat_session: null, replay: {} };
    const list = this.devices();
    list.push(dev); this.saveDevices(list);
    this.link.send({ t: 'allow', d: dev.id, token_hash: dev.token_hash });
    const f = await C.seal(await C.aesKey(p.keys.pairKey), { dir: 'm2p', device: 'pair', session: C.newSession(), data: { t: 'done', device: dev.id, token, room: idn.room, name: dev.name }, now: this.now() });
    this.sendPair({ t: 'sealed', f });
    this.endPairing('paired');
    event('user', 'phone', 'ok', `手机「${dev.name}」配对好了`);
    return this.publicPairing();
  }

  // ── 连接 ──
  needLink() { return !this.blocked() && (this.devices().length > 0 || ['waiting', 'confirm'].includes(this.pairing?.state)); }
  ensureLink() {
    if (this.link || !this.needLink()) return;
    const idn = this.identity();
    if (!idn) return;
    this.link = new RelayLink({ url: this.wsUrl(idn.room), token: idn.token, WebSocketImpl: this.WS, onMessage: m => this.onRelay(m).catch(e => console.error('phone', String(e?.message || e).slice(0, 200))), onState: s => { if (s === 'online') this.probeOk = true; } });
    this.link.start();
  }
  idle() { if (this.link && !this.needLink()) { this.link.stop(); this.link = null; } }
  // deps.gateway：{ port, token, webRoutes, askById, taskAsk, classifyTalk, info }（bin/serve.mjs），有它才接第二阶段的页面请求。
  start(deps) {
    this.deps = deps;
    if (deps?.gateway) { const { port, token, webRoutes, ...rest } = deps.gateway; this.gateway = new PhoneGateway({ port, token, webRoutes, deps: rest, now: this.now, log: this.access, push: this.push, onTalk: (id, s) => this.push.noteSession(id, s) }); }
    // 新消息提醒（lib/phone/push.mjs）：deps.push = { items(), quiet(now) }；开着页面、订阅了实时更新的手机不推。
    if (deps?.push) { this.push.configure({ items: deps.push.items, quiet: deps.push.quiet, visible: () => this.gateway?.subscribed() || [] }).start({ register: deps.push.register }); }
    this.ensureLink(); return this;
  }
  stop() { clearTimeout(this.pairTimer); this.push.stop(); this.link?.stop(); this.link = null; }

  async onRelay(m) {
    if (m.t === 'ok') {
      const local = this.devices();
      for (const d of local) this.link.send({ t: 'allow', d: d.id, token_hash: d.token_hash });
      for (const d of m.devices || []) if (!local.some(x => x.id === d)) this.link.send({ t: 'revoke', d });
      if (this.pairing?.state === 'waiting' && this.pairing.stage === 'open') this.openPairing();
      return;
    }
    if (m.t === 'pair_opened') { const p = this.pairing; if (p && p.id === m.pid) { p.opened = true; p.onOpened?.(); } return; }
    if (m.t === 'gone') { const d = this.devices().find(x => x.id === m.d); if (d) this.link.send({ t: 'allow', d: d.id, token_hash: d.token_hash }); return; }
    if (m.t === 'seen') return this.seen(m.d, m.at);
    if (m.t === 'pair_in') return this.onPair(m.pid, m.m || {});
    if (m.t === 'from') return this.onFrame(m.d, m.f);
  }
  seen(id, at) {
    const last = this.seenWrites.get(id) || 0;
    if (this.now() - last < 60000) return;
    this.seenWrites.set(id, this.now());
    const list = this.devices(), d = list.find(x => x.id === id);
    if (d) { d.last_seen_at = at && !Number.isNaN(Date.parse(at)) ? iso(Date.parse(at)) : iso(this.now()); this.saveDevices(list); }
  }

  async onPair(pid, m) {
    const p = this.pairing;
    if (!p || p.id !== pid || !['waiting', 'confirm'].includes(this.liveState(p))) return;
    if (m.t === 'hello' && p.stage === 'open') {
      let pub;
      try { pub = C.unb64u(m.pub); } catch { pub = null; } // 兜底：解不开就是 null，下一行按 bad_hello 停掉配对
      if (!pub || pub.length !== 32 || typeof m.commit !== 'string' || !['qr', 'code'].includes(m.via)) { this.sendPair({ t: 'error', code: 'bad_hello' }); return this.endPairing('cancelled'); }
      p.phone = { pub: m.pub, commit: m.commit, via: m.via, name: String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 30) || null };
      p.macNonce = C.randomBytes(16); p.stage = 'offered';
      return this.sendPair({ t: 'offer', pub: this.identity().pub, nonce: C.b64u(p.macNonce) });
    }
    if (m.t === 'reveal' && p.stage === 'offered') {
      let nonce;
      try { nonce = C.unb64u(m.nonce); } catch { nonce = null; } // 兜底：解不开就是 null，下一行按核对不上停掉配对
      const phonePub = C.unb64u(p.phone.pub);
      if (!nonce || nonce.length !== 16 || (await C.commitment(phonePub, nonce)) !== p.phone.commit) { this.sendPair({ t: 'error', code: 'commit' }); event('system', 'phone', 'fail', '手机配对的核对信息对不上，已停止'); return this.endPairing('cancelled'); }
      const idn = this.identity(), priv = await C.importPrivate(C.unb64u(idn.priv));
      p.keys = await C.pairingKeys({ shared: await C.dh(priv, phonePub), secret: p.phone.via === 'qr' ? p.secret : null, macPub: C.unb64u(idn.pub), phonePub, macNonce: p.macNonce, phoneNonce: nonce });
      p.sas = p.keys.sas; p.state = 'confirm'; p.stage = 'sas';
      return;
    }
    if (m.t === 'gone' || m.t === 'abort') return this.endPairing('cancelled');
  }

  async keysFor(dev) {
    let k = this.keyCache.get(dev.id);
    if (!k || k.root !== dev.root) { k = { root: dev.root, ...(await C.directionKeys(C.unb64u(dev.root))) }; this.keyCache.set(dev.id, k); }
    return k;
  }
  limited(id) {
    const now = this.now(), recent = (this.rate.get(id) || []).filter(t => now - t < 60000);
    recent.push(now); this.rate.set(id, recent);
    return recent.length > 30;
  }
  // 解开一帧、查重放、记下：同一部手机的帧排成一队做（页面会一下子发好几个请求，计数小的必须先查）。之后的处理各做各的。
  async onFrame(id, f) {
    const prev = this.inq.get(id) || Promise.resolve();
    const step = prev.then(() => this.openFrame(id, f)).catch(e => { noteSwallowed('phone.openFrame', e, { doing: '解开手机发来的一帧', then: '这一帧丢掉，不处理' }); return null; });
    this.inq.set(id, step);
    step.then(() => { if (this.inq.get(id) === step) this.inq.delete(id); });
    const got = await step;
    if (!got) return;
    const { dev, req, ts } = got;
    if (got.replay) { // 同一帧又来了一次：做过的不再做；答过的页面请求把上次的答复再发一次（上次手机正好断线没收到）
      const c = typeof req.id === 'string' && this.recent.get(id)?.get(req.id);
      if (c?.env) await this.sendParts(id, req.id.slice(0, 40), c.env);
      return;
    }
    if (GATEWAY_METHODS.includes(req.m)) {
      if (this.now() - ts > LIVE_MAX_AGE_MS) return this.rejected(id, '页面请求在路上放太久了，没有做');
      return this.onGateway(dev, req);
    }
    const t0 = this.now(), reply = { re: typeof req.id === 'string' ? req.id.slice(0, 40) : null };
    if (this.limited(id)) Object.assign(reply, { ok: false, code: 'rate', error: '太频繁了，稍等一下再试' });
    else if (!this.deps) Object.assign(reply, { ok: false, code: 'not_ready', error: '电脑上的 OfferCrew 还在启动，稍等再试' });
    else {
      try { reply.data = await handleRequest(dev, req, { ...this.deps, tokens: this.tokens, save: d => this.saveDevice(d) }); reply.ok = true; }
      catch (e) { Object.assign(reply, { ok: false, code: e.code || 'error', error: String(e.message || e).slice(0, 300) }); }
      if (req.m === 'talk' && reply.ok && reply.data?.session_id) this.push.noteSession(id, reply.data.session_id);
      if (req.m === 'inbox.answer' || req.m === 'talk') event('user', 'phone', reply.ok ? 'ok' : 'fail', `手机「${dev.name}」：${req.m === 'talk' ? '跟团队说了一句' : `回信 ${String(req.a?.id || '').slice(0, 60)} · ${reply.data?.state || reply.error}`}`);
    }
    this.access.write({ at: new Date(t0).toISOString(), device: id, m: String(req.m || '').slice(0, 40), status: reply.ok ? 200 : reply.code === 'rate' ? 429 : 400, ms: this.now() - t0 });
    await this.reply(id, reply);
  }
  async openFrame(id, f) {
    let dev = this.devices().find(d => d.id === id);
    if (!dev) { this.link?.send({ t: 'revoke', d: id }); return null; }
    const keys = await this.keysFor(dev);
    let o;
    try { o = await C.open(keys.p2m, { dir: 'p2m', device: id, frame: f }); }
    catch { this.rejected(id, '解不开（被改过，或不是这部手机发的）'); return null; }
    // 解密要等一下：这期间可能刚被解除配对，重新读一次；防重放的检查和记下在同一拍里做完。
    const list = this.devices(); dev = list.find(d => d.id === id);
    if (!dev) return null;
    const guard = new C.ReplayGuard(dev.replay || {}), why = guard.check(o, this.now());
    if (why) { this.rejected(id, why === 'replay' ? '重复的帧（重放）' : '时间不对（太旧或太新）'); return why === 'replay' && o.data && typeof o.data === 'object' ? { dev, req: o.data, replay: true } : null; }
    guard.accept(o, this.now()); dev.replay = guard.toJSON(); this.saveDevices(list);
    return { dev, req: o.data && typeof o.data === 'object' ? o.data : {}, ts: o.ts };
  }
  // 第二阶段的页面请求（lib/phone/gateway.mjs）：答复 gzip 后分块，每块一帧，都标「只要实时」（手机不在就丢）。
  async onGateway(dev, req) {
    const re = typeof req.id === 'string' ? req.id.slice(0, 40) : null;
    const keep = re && !(['hello', 'bundle', 'events'].includes(req.m) || (req.m === 'http' && String(req.a?.method || 'GET').toUpperCase() === 'GET'));
    const mine = keep ? this.remember(dev.id) : null;
    if (mine) mine.set(re, { at: this.now(), env: null });
    const env = this.gateway
      ? await this.gateway.handle(dev, req, { alive: () => this.devices().some(d => d.id === dev.id) })
      : { ok: false, code: 'not_ready', error: '电脑上的 OfferCrew 还在启动，稍等再试' };
    if (!env) { mine?.delete(re); return; } // 处理期间被解除配对：什么都不回
    if (mine) mine.set(re, { at: this.now(), env: JSON.stringify(env).length <= 256 * 1024 ? env : { ok: false, code: 'duplicate', error: '这件事电脑已经做过了，刷新看看结果' } });
    await this.sendParts(dev.id, re, env);
  }
  remember(id) {
    const t = this.now(), m = this.recent.get(id) || new Map();
    for (const [k, v] of m) if (t - v.at > 120000) m.delete(k);
    while (m.size >= 100) m.delete(m.keys().next().value);
    this.recent.set(id, m);
    return m;
  }
  async sendParts(id, re, env) {
    const parts = await packReply(env);
    await Promise.all(parts.map((z, part) => this.sendSealed(id, { re, part, parts: parts.length, z }, { live: true })));
  }
  // 工作台有更新（bin/serve.mjs 的 SSE 定时器）：推给最近 2 分钟订阅过的手机。手机不在线这帧就丢了。
  // 同一刻也看一眼要不要发新消息提醒（提醒由这台 Mac 直接发给推送服务，不经过中转，所以不看中转连没连着）。
  pushUpdate() {
    try { this.push.check(); } catch (e) { console.error('phone push', String(e?.message || e).slice(0, 200)); }
    if (!this.gateway || this.link?.state !== 'online') return 0;
    const ids = this.gateway.subscribed().filter(id => this.devices().some(d => d.id === id));
    for (const id of ids) this.sendSealed(id, { push: 'update', at: iso(this.now()) }, { live: true });
    return ids.length;
  }
  // 封一帧发给这部手机：同一部手机排成一队（计数按发出的顺序递增）；每一帧封之前都再看一眼它还在不在。
  sendSealed(id, data, { live = false } = {}) {
    const prev = this.outq.get(id) || Promise.resolve();
    const next = prev.then(async () => {
      const dev = this.devices().find(d => d.id === id);
      if (!dev) return false; // 被解除配对：什么都不回
      const keys = await this.keysFor(dev);
      let s = this.sessions.get(id);
      if (!s) { s = C.newSession(); this.sessions.set(id, s); }
      const f = await C.seal(keys.m2p, { dir: 'm2p', device: id, session: s, data, now: this.now() });
      return !!this.link?.send({ t: 'to', d: id, f, ...(live ? { live: true } : {}) });
    }).catch(e => { noteSwallowed('phone.sendFrame', e, { doing: '给手机加密发一帧', then: '这一帧没发出去' }); return false; });
    this.outq.set(id, next);
    next.then(() => { if (this.outq.get(id) === next) this.outq.delete(id); });
    return next;
  }
  reply(id, data) { return this.sendSealed(id, data); }
  rejected(id, why) {
    const k = `${id}:${why}`, last = this.seenWrites.get(k) || 0;
    if (this.now() - last > 600000) { this.seenWrites.set(k, this.now()); event('system', 'phone', 'skip', `丢掉了手机 ${id} 发来的一帧：${why}`); }
  }
}
const sha256hex = async s => crypto.createHash('sha256').update(String(s)).digest('hex');
