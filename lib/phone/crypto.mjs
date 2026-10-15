// 手机和电脑之间的端到端加密（桌面版方案第六节、附录 F）。只用 WebCrypto：X25519 交换密钥、HKDF 派生、AES-GCM 加密。
// 这一份同时跑在三个地方：电脑上的引擎（Node）、手机网页（Safari / Chrome，由中转原样发到 /p/crypto.js）、测试。
// 所以这里不许 import 任何东西，也不许用 Buffer：只用 globalThis.crypto、TextEncoder、btoa / atob。
//
// 配对（中转只转发，看不到密钥；手动输码时靠 6 位核对数字防中间人）：
//   手机 → 电脑  hello：手机的公钥 + 承诺 C = SHA-256(标签 ‖ 手机公钥 ‖ 手机随机数)（先承诺、后亮随机数）
//   电脑 → 手机  offer：电脑的公钥 + 电脑随机数
//   手机 → 电脑  reveal：手机随机数；电脑核对承诺
//   两边各自算：共享秘密 = X25519(自己的私钥, 对方公钥)；扫码时再把 # 后面的一次性密钥当 HKDF 的盐混进去；
//   派生出核对数字（6 位）、配对密钥（只用来送回 device token）和这部手机的根密钥。扫码时手机还核对电脑公钥的指纹。
//   中间人想让两边的核对数字一样，只能靠猜（百万分之一），因为双方的随机数在对方亮出之前就定下了。
// 配对之后每一帧：AES-256-GCM，两个方向各用一把钥匙；IV = 会话号（8 字节随机）‖ 计数（4 字节）；
//   附加数据里有方向、设备号、会话号、计数，改一个字、换个方向、挪给别的设备都打不开；
//   收的一方按（会话号, 计数）只收比见过的更大的，外加时间戳窗口，重放的帧一律丢掉（ReplayGuard）。
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();

export const PROTOCOL = 'offercrew-phone-v1';
export const utf8 = s => enc.encode(String(s));
export const fromUtf8 = b => dec.decode(b);
export function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }
export function concat(...parts) {
  const bufs = parts.map(p => (typeof p === 'string' ? utf8(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) { out.set(b, at); at += b.length; }
  return out;
}
export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = String(str || '');
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw Error('bad_base64');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export const sha256 = async data => new Uint8Array(await subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data));

// ── X25519 ──────────────────────────────────────────────────────────────────
// 这台浏览器 / Node 能不能做 X25519（iOS 17 以前的 Safari、Chrome 133 以前不行）。手机网页先问这个。
export async function x25519Supported() {
  try { await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']); return true; } catch { return false; }
}
// extractable：电脑要把私钥存进 private/phone/，所以要能导出；手机上的私钥不导出，整个 CryptoKey 放进 IndexedDB。
export const generateKeyPair = (extractable = false) => subtle.generateKey({ name: 'X25519' }, extractable, ['deriveBits']);
export const exportPublic = async key => new Uint8Array(await subtle.exportKey('raw', key));
export const exportPrivate = async key => new Uint8Array(await subtle.exportKey('pkcs8', key));
export const importPrivate = (pkcs8, extractable = false) => subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, extractable, ['deriveBits']);
export async function importPublic(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw Error('bad_public_key');
  return subtle.importKey('raw', raw, { name: 'X25519' }, true, []);
}
export async function dh(privateKey, publicRaw) {
  let bits;
  try { bits = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await importPublic(publicRaw) }, privateKey, 256)); }
  catch { throw Error('bad_public_key'); } // Node / 浏览器遇到低阶点会直接报错
  if (bits.every(x => x === 0)) throw Error('bad_public_key'); // 低阶点：共享秘密全是 0
  return bits;
}
// 公钥指纹：SHA-256 的前 16 字节，base64url 22 个字符。二维码里带着它，手机据此认出真的那台电脑。
export const fingerprint = async publicRaw => b64u((await sha256(concat(PROTOCOL, ':fp:', publicRaw))).slice(0, 16));

// ── HKDF ────────────────────────────────────────────────────────────────────
export async function hkdf(ikm, salt, info, length = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt || new Uint8Array(32), info: typeof info === 'string' ? utf8(info) : info }, key, length * 8));
}

// ── 配对 ────────────────────────────────────────────────────────────────────
export const commitment = async (phonePub, phoneNonce) => b64u(await sha256(concat(PROTOCOL, ':commit:', phonePub, phoneNonce)));
// 两边拿同样的输入算出同样的东西。secret：扫码时 # 后面那段一次性密钥（字节），手动输码时为 null。
export async function pairingKeys({ shared, secret = null, macPub, phonePub, macNonce, phoneNonce }) {
  const transcript = await sha256(concat(PROTOCOL, ':pair:', macPub, phonePub, macNonce, phoneNonce, secret ? 'qr' : 'code'));
  const okm = await hkdf(shared, secret || new Uint8Array(32), concat(PROTOCOL, ':keys:', transcript), 68);
  const n = ((okm[64] << 24) | (okm[65] << 16) | (okm[66] << 8) | okm[67]) >>> 0;
  return { sas: String(n % 1000000).padStart(6, '0'), pairKey: okm.slice(0, 32), root: okm.slice(32, 64), transcript: b64u(transcript) };
}

// ── 每一帧 ──────────────────────────────────────────────────────────────────
// 根密钥 → 两个方向各一把 AES-GCM 钥匙（不可导出）。m2p：电脑发给手机；p2m：手机发给电脑。
export async function directionKeys(root) {
  const make = async dir => subtle.importKey('raw', await hkdf(root, null, `${PROTOCOL}:${dir}`), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { m2p: await make('m2p'), p2m: await make('p2m') };
}
// 配对密钥（32 字节）→ AES-GCM 钥匙：只用来把 device token 送回手机（方向 m2p，设备号写 'pair'）。
export const aesKey = raw => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
export const newSession = () => ({ sid: b64u(randomBytes(8)), ctr: 0 });
const ivOf = (sidBytes, ctr) => { const iv = new Uint8Array(12); iv.set(sidBytes, 0); new DataView(iv.buffer).setUint32(8, ctr >>> 0); return iv; };
const aadOf = (dir, device, s, c) => utf8(`${PROTOCOL}|${dir}|${device}|${s}|${c}`);
// 加密一帧。session 是 newSession() 的结果，每发一帧计数加一。data 是任意 JSON；加上发出时刻 ts。
export async function seal(key, { dir, device, session, data, now = Date.now() }) {
  if (session.ctr >= 0xffffffff) throw Error('session_exhausted');
  const c = ++session.ctr, sidBytes = unb64u(session.sid);
  const x = await subtle.encrypt({ name: 'AES-GCM', iv: ivOf(sidBytes, c), additionalData: aadOf(dir, device, session.sid, c) }, key, utf8(JSON.stringify({ ...data, ts: now })));
  return { s: session.sid, c, x: b64u(new Uint8Array(x)) };
}
// 解开一帧：被改过、方向不对、设备不对都会抛错（'tampered'）。不查重放，重放由 ReplayGuard 管。
export async function open(key, { dir, device, frame }) {
  const f = frame || {};
  if (typeof f.s !== 'string' || !Number.isInteger(f.c) || f.c < 1 || typeof f.x !== 'string') throw Error('bad_frame');
  let sidBytes;
  try { sidBytes = unb64u(f.s); } catch { throw Error('bad_frame'); }
  if (sidBytes.length !== 8) throw Error('bad_frame');
  let plain;
  try { plain = await subtle.decrypt({ name: 'AES-GCM', iv: ivOf(sidBytes, f.c), additionalData: aadOf(dir, device, f.s, f.c) }, key, unb64u(f.x)); }
  catch { throw Error('tampered'); }
  const data = JSON.parse(fromUtf8(new Uint8Array(plain)));
  return { data, sid: f.s, ctr: f.c, ts: Number(data.ts) || 0 };
}

// 防重放：每个会话号记住见过的最大计数，只收更大的；会话号在第一次见到后保留 maxAgeMs；
// 发出时刻早于 now - maxAgeMs + skewMs 的帧（包括早就忘了会话号的旧帧）一律不收，晚于 now + skewMs 的也不收。
// state 是可以直接 JSON 存盘的对象 { sid: [maxCtr, firstSeenAt] }。
export class ReplayGuard {
  constructor(state = {}, { maxAgeMs = 48 * 3600000, skewMs = 3600000, maxSessions = 256 } = {}) {
    this.state = state && typeof state === 'object' ? state : {};
    Object.assign(this, { maxAgeMs, skewMs, maxSessions });
  }
  check({ sid, ctr, ts }, now = Date.now()) {
    if (!(ts > now - this.maxAgeMs + this.skewMs) || ts > now + this.skewMs) return 'stale';
    const seen = this.state[sid];
    if (seen && ctr <= seen[0]) return 'replay';
    return null;
  }
  accept({ sid, ctr }, now = Date.now()) {
    const seen = this.state[sid];
    this.state[sid] = [ctr, seen ? seen[1] : now];
    this.prune(now);
  }
  prune(now = Date.now()) {
    const rows = Object.entries(this.state).filter(([, v]) => now - v[1] < this.maxAgeMs);
    rows.sort((a, b) => b[1][1] - a[1][1]);
    this.state = Object.fromEntries(rows.slice(0, this.maxSessions));
  }
  toJSON() { return this.state; }
}

// 6 位配对码：去掉容易看错的 0/O、1/I/L，写成 K7Q-2MX 的样子；输入时忽略大小写、空格和横线。
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode() {
  const b = randomBytes(6);
  const s = [...b].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join(''); // 256 % 31 的偏差很小，码本来就只用来找房间
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}
export const normalizeCode = s => { const c = String(s || '').toUpperCase().replace(/[\s-]/g, ''); return c.length === 6 && [...c].every(x => CODE_ALPHABET.includes(x)) ? c : null; };
// 二维码 # 后面那段：房间号.一次性密钥.电脑公钥指纹（都是 base64url）。
export function parsePairFragment(hash) {
  const m = /^#?([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,64})\.([A-Za-z0-9_-]{22})$/.exec(String(hash || '').trim());
  return m ? { room: m[1], secret: m[2], fp: m[3] } : null;
}
// 中转用的检查值：扫码来的手机拿一次性密钥算出它，中转只比对这个值，拿不到密钥本身。
export const qrTag = async secretBytes => b64u((await hkdf(secretBytes, null, `${PROTOCOL}:relay-tag`, 16)));
