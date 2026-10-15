// 手机这一边的协议：配对、连上自己的房间、发加密请求、收加密回答。手机网页（app.js）和测试里的脚本手机都用这一份。
// 不 import 任何东西：加密函数（/p/crypto.js，即 lib/phone/crypto.mjs）、WebSocket、fetch、存储都从外面传进来。
// store：{ get(key), set(key, value), del(key) }，都可以是异步的；浏览器里是 IndexedDB（能存不可导出的 CryptoKey）。
//
// 存下来的只有：房间号、设备号、中转令牌、两把不可导出的 AES 钥匙、电脑公钥的指纹、防重放的记录。
//
// 第二阶段（手机上跑工作台自己的页面，电脑那边是 lib/phone/gateway.mjs）：
//   请求帧（封在密文里）  { id, m, a }；m 是 hello / bundle / http / events / upload.chunk / upload.done 时，
//                        发给中转的外层是 { t: 'e', f, live: true }：电脑不在线就不排队，中转回 { t: 'offline', s, c }，请求立刻以 code 'mac_offline' 失败。
//   答复（每块一帧）      { re, part, parts, z }：z 是一段 base64url；拼齐、gzip 解压（DecompressionStream）、JSON 解析后是
//                        { ok, data } 或 { ok: false, code, error }，和第一版单帧的答复一样处理。
//   推送                  { push: 'update', at }：onEvent('push', { kind: 'update', at })。
//   第一版的四个方法（status、inbox.list、inbox.answer、talk）照旧：单帧答复，电脑不在线时在中转里排队。

export const ERRORS = {
  pairing_invalid: '这个码不对、已经用过或者过期了。在电脑上重新点一次「扫码配对手机」。',
  mac_offline: '电脑现在没连上中转。确认电脑上的 OfferCrew 开着，再试一次。',
  bad_hello: '手机发出的配对信息不完整，请重试。',
  fingerprint: '这个二维码和连上的电脑对不上，配对已停止。请在电脑上重新配对。',
  cancelled: '电脑上取消了这次配对。',
  closed: '连接断了，配对没有完成。请在电脑上重新配对。',
  commit: '配对信息核对不上，已停止。',
  crypto: '这台手机的浏览器太旧，不支持需要的加密方式。请把系统升级到 iOS 17 或更新；安卓请用新版 Chrome。',
};

const wsBase = base => String(base).replace(/^http/, 'ws').replace(/\/+$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const LIVE_METHODS = ['hello', 'bundle', 'http', 'events', 'upload.chunk', 'upload.done', 'push.key', 'push.subscribe', 'push.unsubscribe'];
export const UPLOAD_CHUNK = 24 * 1024, UPLOAD_MAX = 10 * 1024 * 1024, MAX_PARTS = 1024;
// 重连后可以重新封一帧再发的（只读）；别的请求重发同一帧，电脑只认一次，不会做两遍。
const idempotent = (m, a) => ['hello', 'bundle', 'events'].includes(m) || (m === 'http' && String(a?.method || 'GET').toUpperCase() === 'GET');
const fail = (message, code) => Object.assign(Error(message), { code });
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class PhoneClient {
  // replayDelayMs：分块答复和推送的防重放记录最多隔多久写一次存储（页面在 pagehide 时调 flushReplay() 立刻写）。
  constructor({ C, base, WebSocketImpl = globalThis.WebSocket, fetchImpl = (...a) => globalThis.fetch(...a), store, onEvent = () => {}, now = () => Date.now(), replayDelayMs = 1000 }) {
    Object.assign(this, { C, base: String(base).replace(/\/+$/, ''), WS: WebSocketImpl, fetch: fetchImpl, store, emit: onEvent, now, replayDelayMs });
    this.replayTimer = null; this.replayDirty = false;
    this.pending = new Map(); this.ws = null; this.stopped = false; this.backoff = 1000; this.session = null; this.macOnline = null; this.state = 'off';
    this.rx = Promise.resolve(); this.sealing = Promise.resolve(); this.subscribed = false; this.keepalive = null;
  }

  async account() { return (await this.store.get('account')) || null; }

  // ── 配对 ──────────────────────────────────────────────────────────────────
  // 扫码：fragment 是 # 后面那段（房间号.一次性密钥.电脑指纹）。输码：code 是 6 位配对码。
  // 返回 { sas } 之后，等 done 这个 Promise：电脑上确认了就 resolve，出错就 reject（message 是给人看的中文）。
  async pair({ fragment = null, code = null, name = '我的手机' } = {}) {
    const C = this.C;
    if (!(await C.x25519Supported())) throw Error(ERRORS.crypto);
    let room, via, secret = null, fp = null;
    if (fragment) {
      const f = C.parsePairFragment(fragment);
      if (!f) throw Error('这个二维码不是 OfferCrew 的配对码。');
      ({ room, fp } = f); via = 'qr'; secret = C.unb64u(f.secret);
    } else {
      const norm = C.normalizeCode(code);
      if (!norm) throw Error('配对码是 6 位字母和数字，再核对一下。');
      const r = await this.fetch(`${this.base}/p/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: norm }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(j.error || '找不到这个配对码。');
      room = j.room; via = 'code'; code = norm;
    }
    const kp = await C.generateKeyPair(false), pub = await C.exportPublic(kp.publicKey), nonce = C.randomBytes(16);
    const hello = { t: 'hello', via, pub: C.b64u(pub), commit: await C.commitment(pub, nonce), name: String(name).slice(0, 40) };
    if (via === 'qr') hello.tag = await C.qrTag(secret); else hello.code = code;
    const ws = new this.WS(`${wsBase(this.base)}/ws/${room}?as=pair`);
    let keys = null, finished = false, sasResolve, sasReject, failNow = () => {};
    const sas = new Promise((res, rej) => { sasResolve = res; sasReject = rej; });
    const done = new Promise((resolve, reject) => {
      const fail = msg => { if (finished) return; finished = true; try { ws.close(); } catch {} sasReject(Error(msg)); reject(Error(msg)); };
      failNow = fail;
      ws.addEventListener('open', () => ws.send(JSON.stringify(hello)));
      // 电脑送回结果后马上关掉配对连接：关闭可能比解密先到，等手上这一条处理完再算断开。
      let busy = Promise.resolve();
      ws.addEventListener('error', () => busy.then(() => fail(ERRORS.closed)));
      ws.addEventListener('close', () => busy.then(() => fail(ERRORS.closed)));
      ws.addEventListener('message', ev => { busy = busy.then(() => onMessage(ev)); });
      const onMessage = async ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        try {
          if (m.t === 'error') return fail(ERRORS[m.code] || ERRORS.closed);
          if (m.t === 'cancel') return fail(ERRORS.cancelled);
          if (m.t === 'offer' && !keys) {
            const macPub = C.unb64u(m.pub);
            if (via === 'qr' && (await C.fingerprint(macPub)) !== fp) { ws.send(JSON.stringify({ t: 'abort' })); return fail(ERRORS.fingerprint); }
            const macNonce = C.unb64u(m.nonce);
            ws.send(JSON.stringify({ t: 'reveal', nonce: C.b64u(nonce) }));
            keys = await C.pairingKeys({ shared: await C.dh(kp.privateKey, macPub), secret: via === 'qr' ? secret : null, macPub, phonePub: pub, macNonce, phoneNonce: nonce });
            keys.macFp = await C.fingerprint(macPub);
            sasResolve({ sas: keys.sas });
            return;
          }
          if (m.t === 'sealed' && keys) {
            const { data } = await C.open(await C.aesKey(keys.pairKey), { dir: 'm2p', device: 'pair', frame: m.f });
            if (data.t !== 'done' || data.room !== room) return fail(ERRORS.closed);
            const dk = await C.directionKeys(keys.root);
            await this.store.set('account', { room, device: data.device, token: data.token, name: data.name || name, mac_fp: keys.macFp, m2p: dk.m2p, p2m: dk.p2m, paired_at: new Date(this.now()).toISOString() });
            await this.store.set('replay', {});
            finished = true; try { ws.close(); } catch {}
            resolve({ device: data.device });
          }
        } catch { fail(ERRORS.closed); }
      };
    });
    done.catch(() => {}); sas.catch(() => {});
    // 手机上点「不一样，取消」：告诉电脑这次作废。
    const abort = () => { try { ws.send(JSON.stringify({ t: 'abort' })); } catch {} failNow('已取消这次配对。'); };
    return { sas, done, abort };
  }

  // ── 连到自己的房间 ──────────────────────────────────────────────────────────
  async connect() {
    const acc = await this.account();
    if (!acc) return false;
    this.stopped = false;
    if (!this.session) this.session = this.C.newSession();
    await this.flushReplay();
    this.guard = new this.C.ReplayGuard((await this.store.get('replay')) || {});
    this.open(acc);
    return true;
  }
  open(acc) {
    if (this.stopped) return;
    const ws = new this.WS(`${wsBase(this.base)}/ws/${acc.room}?as=dev&d=${acc.device}`);
    this.ws = ws; this.setState('connecting');
    let ping = null, alive = true;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'auth', token: acc.token }));
      ping = setInterval(() => { if (!alive) { try { ws.close(); } catch {} return; } alive = false; try { ws.send('ping'); } catch {} }, 25000);
    });
    // 一帧一帧按到达的顺序处理：防重放按计数从小到大收，并发解密会把先到的判成重放。
    ws.addEventListener('message', ev => { alive = true; this.rx = this.rx.then(() => this.onMessage(acc, ev.data)).catch(() => {}); });
    ws.addEventListener('close', () => {
      clearInterval(ping);
      if (this.ws === ws) this.ws = null;
      // 还没等到回答的请求重连后再发一次：同一帧电脑只收一次（防重放），不会做两遍。
      // 只读的页面请求（GET、hello、bundle、events）重新封一帧：电脑可能已经答过、答复却因为手机不在丢了。
      for (const p of this.pending.values()) { if (p.sent && p.live && idempotent(p.m, p.a)) { p.reseal = true; p.parts = null; p.got = 0; } p.sent = false; }
      if (this.stopped) { this.setState('off'); return; }
      this.setState('offline');
      const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => this.account().then(a => a && this.open(a)), wait);
    });
  }
  async onMessage(acc, data) {
    if (data === 'pong') return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'ok') { this.backoff = 1000; this.macOnline = !!m.mac; this.setState('online'); this.emit('mac', { online: this.macOnline }); this.reseal(); this.flushOutbox(); if (this.subscribed) this.request('events', { op: 'subscribe' }).catch(() => {}); }
    else if (m.t === 'mac') { this.macOnline = !!m.online; this.emit('mac', { online: this.macOnline }); if (!this.macOnline) this.failLive(); }
    else if (m.t === 'offline') { // 「只要实时」的请求到了中转，电脑不在：不排队
      this.macOnline = false; this.emit('mac', { online: false });
      for (const [id, p] of this.pending) if (p.f && p.f.s === m.s && p.f.c === m.c) this.settle(id, p, { ok: false, code: 'mac_offline', error: ERRORS.mac_offline });
    }
    else if (m.t === 'queued') { // 旧版中转不认 live、把页面请求排了队：页面这边当作电脑不在线（电脑回来后也不会做放了 5 分钟以上的）
      for (const [id, p] of this.pending) if (p.live && p.f && p.f.s === m.s && p.f.c === m.c) this.settle(id, p, { ok: false, code: 'mac_offline', error: ERRORS.mac_offline });
      this.emit('queued', m);
    }
    else if (m.t === 'dropped') this.emit('dropped', m);
    else if (m.t === 'denied') { this.stopped = true; await this.forget(); this.emit('revoked', {}); }
    else if (m.t === 'e') await this.receive(acc, m.f);
  }
  // 电脑掉线：「只要实时」的请求马上失败（不排队；已经发出去的，电脑的答复也到不了了）。
  failLive() { for (const [id, p] of this.pending) if (p.live) this.settle(id, p, { ok: false, code: 'mac_offline', error: ERRORS.mac_offline }); }
  settle(id, p, env) {
    this.pending.delete(id); clearTimeout(p.timer);
    if (env.ok) { let v; try { v = p.shape ? p.shape(env.data) : env.data; } catch (e) { return p.reject(e); } p.resolve(v); }
    else p.reject(fail(env.error || '电脑没能处理', env.code));
  }
  setState(s) { if (this.state !== s) { this.state = s; this.emit('link', { state: s }); } }
  close() { this.stopped = true; clearInterval(this.keepalive); this.keepalive = null; try { this.ws?.close(); } catch {} }
  async forget() { this.close(); clearTimeout(this.replayTimer); this.replayTimer = null; this.replayDirty = false; this.guard = null; await this.store.del('account'); await this.store.del('replay'); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('这部手机已经和电脑断开')); } this.pending.clear(); }

  async receive(acc, f) {
    if (!this.guard) return; // 已经忘掉这台电脑
    let o;
    try { o = await this.C.open(acc.m2p, { dir: 'm2p', device: acc.device, frame: f }); } catch { this.emit('rejected', { why: 'tampered' }); return; }
    const why = this.guard.check(o, this.now());
    if (why) { this.emit('rejected', { why }); return; }
    this.guard.accept(o, this.now());
    const d = o.data;
    // 防重放记录：第一版的单帧答复照旧收到就写；页面请求的分块答复和推送（一个回答可能几十帧）攒着，最多每 replayDelayMs 写一次。
    // 页面关掉前没写进去的那几帧，重放也没有用：它们答的请求在新页面里已经没人等（请求号是随机的），推送只会让页面多刷新一次。
    this.replayDirty = true;
    if (typeof d.push === 'string' || Number.isInteger(d.parts)) this.saveReplaySoon(); else await this.flushReplay();
    if (typeof d.push === 'string') { this.emit('push', { kind: d.push, at: d.at || null }); return; }
    const p = d.re && this.pending.get(d.re);
    if (Number.isInteger(d.parts)) { // 分块的答复
      if (!p) return; // 没人在等了（超时、重发过）
      if (d.parts < 1 || d.parts > MAX_PARTS || !Number.isInteger(d.part) || d.part < 0 || d.part >= d.parts || typeof d.z !== 'string' || (p.parts && p.parts.length !== d.parts)) return this.settle(d.re, p, { ok: false, code: 'bad_reply', error: '电脑的回答格式不对' });
      if (!p.parts) { p.parts = new Array(d.parts); p.got = 0; }
      if (!p.parts[d.part]) { p.parts[d.part] = this.C.unb64u(d.z); p.got++; }
      this.arm(d.re, p); // 还在收：重新计时
      if (p.got < d.parts) return;
      let env;
      try {
        const all = new Uint8Array(p.parts.reduce((n, b) => n + b.length, 0)); let at = 0;
        for (const b of p.parts) { all.set(b, at); at += b.length; }
        env = JSON.parse(new TextDecoder().decode(await gunzip(all)));
      } catch { env = { ok: false, code: 'bad_reply', error: '电脑的回答不完整' }; }
      return this.settle(d.re, p, env);
    }
    if (p) this.settle(d.re, p, d);
    else this.emit('late', d); // 手机关着时电脑回的答复（之前排队的请求）
  }
  saveReplaySoon() {
    if (!this.replayTimer) this.replayTimer = setTimeout(() => { this.replayTimer = null; this.flushReplay().catch(() => {}); }, this.replayDelayMs);
  }
  async flushReplay() {
    clearTimeout(this.replayTimer); this.replayTimer = null;
    if (!this.guard || !this.replayDirty) return;
    this.replayDirty = false;
    await this.store.set('replay', this.guard.toJSON());
  }
  arm(id, p) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (this.pending.get(id) !== p) return;
      this.pending.delete(id);
      p.reject(fail(this.macOnline === false ? (p.live ? ERRORS.mac_offline : '电脑现在不在线，你的请求已经存着，电脑醒来后处理。') : '电脑没有及时回答，稍后再看。', this.macOnline === false && p.live ? 'mac_offline' : 'timeout'));
    }, p.timeoutMs);
  }

  // 发一个请求给电脑。第一版的四个方法（status、inbox.list、inbox.answer、talk）：电脑不在线时请求先存在中转里，onQueued 在中转说「存着了」时调用。
  // 第二阶段的方法（LIVE_METHODS）默认「只要实时」：电脑不在线就立刻以 code 'mac_offline' 失败。timeoutMs 到了还没回答就 reject（code 'timeout'）。
  async request(m, a = {}, { timeoutMs = null, onQueued = null, live = LIVE_METHODS.includes(m), shape = null } = {}) {
    const acc = await this.account();
    if (!acc) throw Error('这部手机还没和电脑配对');
    if (live && this.state === 'online' && this.macOnline === false) throw fail(ERRORS.mac_offline, 'mac_offline');
    if (!this.session) this.session = this.C.newSession();
    const id = this.C.b64u(this.C.randomBytes(9));
    return new Promise((resolve, reject) => {
      const p = { m, a, live, resolve, reject, f: null, sent: false, onQueued, shape, timeoutMs: timeoutMs ?? (live ? (m === 'bundle' || m === 'upload.done' ? 120000 : 30000) : 60000) };
      this.pending.set(id, p); this.arm(id, p);
      this.sealWith(id, p, acc);
    });
  }
  // 封帧排成一队：计数按封的顺序递增，发的时候也按计数从小到大（电脑只收比见过的更大的）。
  sealWith(id, p, acc) {
    this.sealing = this.sealing.then(async () => {
      if (this.pending.get(id) !== p) return;
      p.f = await this.C.seal(acc.p2m, { dir: 'p2m', device: acc.device, session: this.session, data: { id, m: p.m, a: p.a }, now: this.now() });
      this.flushOutbox();
    }).catch(e => { if (this.pending.get(id) === p) { this.pending.delete(id); clearTimeout(p.timer); p.reject(e); } });
  }
  reseal() { this.account().then(acc => { if (acc) for (const [id, p] of this.pending) if (p.reseal) { p.reseal = false; p.f = null; this.sealWith(id, p, acc); } }).catch(() => {}); }
  flushOutbox() {
    const ws = this.ws;
    if (!ws || this.state !== 'online') return;
    const due = [...this.pending].filter(([, p]) => p.f && !p.sent && !p.reseal).sort((x, y) => x[1].f.c - y[1].f.c);
    for (const [id, p] of due) {
      if (p.live && this.macOnline === false) { this.settle(id, p, { ok: false, code: 'mac_offline', error: ERRORS.mac_offline }); continue; }
      try { ws.send(JSON.stringify({ t: 'e', f: p.f, ...(p.live ? { live: true } : {}) })); p.sent = true; } catch { return; }
      if (p.onQueued && this.macOnline === false) p.onQueued({ id });
    }
  }

  // ── 第二阶段：页面请求 ────────────────────────────────────────────────────────
  // 页面的一个 fetch。headers 只带 content-type 和 x-phone-confirm（手机上的确认卡给的令牌），别的电脑那边也不认。
  // 返回 { status, headers: { 'content-type', 'content-disposition'? }, body }：文字是字符串，别的（图片、PDF、Word）是 Uint8Array。
  http({ method = 'GET', path, headers = {}, body = null } = {}, opts = {}) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) { const key = k.toLowerCase(); if (key === 'content-type' || key === 'x-phone-confirm') h[key] = String(v); }
    return this.request('http', { method: String(method).toUpperCase(), path: String(path), headers: h, ...(body != null ? { body: String(body) } : {}) }, { ...opts, shape: this.httpShape });
  }
  httpShape = d => ({ status: d.status, headers: d.headers || {}, body: d.b64 != null ? this.C.unb64u(d.b64) : d.body ?? '' });
  // 电脑上的页面代码包：{ version, same: true }（和手上这版一样），或 { version, files: { 路径: { type, body（文字）| bytes（Uint8Array） } } }。
  bundle(version = null, opts = {}) {
    return this.request('bundle', version ? { version } : {}, { ...opts, shape: d => (d.files ? { version: d.version, files: Object.fromEntries(Object.entries(d.files).map(([k, f]) => [k, f.b64 != null ? { type: f.type, bytes: this.C.unb64u(f.b64) } : { type: f.type, body: f.body }])) } : d) });
  }
  hello(opts = {}) { return this.request('hello', {}, opts); }
  // 订阅工作台的更新：之后电脑那边一有变化就推 { push: 'update' }（onEvent('push', …)）。每分钟续一次，重连后自动再订。
  async subscribe() {
    this.subscribed = true;
    clearInterval(this.keepalive);
    this.keepalive = setInterval(() => { if (this.state === 'online') this.request('events', { op: 'keepalive' }).catch(() => {}); }, 60000);
    return this.request('events', { op: 'subscribe' });
  }
  unsubscribe() { this.subscribed = false; clearInterval(this.keepalive); this.keepalive = null; return this.request('events', { op: 'unsubscribe' }).catch(() => null); }
  // 上传（简历，10 MB 以内）：切成小块一块一帧，同时在路上的最多 window 块，收齐后电脑交给 POST /api/setup/resume。
  // headers：content-type、x-file-name（和工作台页面发的一样）。返回和 http() 一样。
  async upload(bytes, { headers = {}, onProgress = null, window = 6 } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length > UPLOAD_MAX) throw fail('文件超过 10 MB', 'too_big');
    const u = this.C.b64u(this.C.randomBytes(12)), n = Math.max(1, Math.ceil(data.length / UPLOAD_CHUNK));
    let next = 0, done = 0;
    const worker = async () => {
      while (next < n) {
        const i = next++;
        await this.request('upload.chunk', { u, i, n, b: this.C.b64u(data.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK)) });
        done++; onProgress?.({ done, total: n });
      }
    };
    await Promise.all(Array.from({ length: Math.min(window, n) }, worker));
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) { const key = k.toLowerCase(); if (key === 'content-type' || key === 'x-file-name') h[key] = String(v); }
    return this.request('upload.done', { u, n, size: data.length, path: '/api/setup/resume', headers: h }, { shape: this.httpShape });
  }
  async waitOnline(ms = 10000) { const end = this.now() + ms; while (this.state !== 'online' && this.now() < end) await sleep(50); return this.state === 'online'; }
}
