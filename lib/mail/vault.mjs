// 内置邮箱的账号和授权码放在哪（数据目录的 private/mail/，不进 Git，不上传）：
//   account.json  地址、哪种邮箱、登录名（和地址不一样时）、上次测试的结果。没有授权码。
//   secret.json   授权码，用钥匙串里的主密钥（lib/mail/keychain.mjs）以 AES-256-GCM 加密；附加数据绑着邮箱地址，
//                 换到别的账号文件上解不开。目录 0700、文件 0600。
// 主密钥第一次保存时生成（32 字节随机数），以后只读。钥匙串里的密钥丢了，授权码就解不开：状态回「要重新填授权码」，
// 不猜、不重置别的。「断开」只删这两个文件，不碰钥匙串（任何时候都不删钥匙串条目）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { file } from '../store.mjs';
import { keychain } from './keychain.mjs';
import { normalizeAddress } from './providers.mjs';

export const MAIL_DIR = 'private/mail';
export const ACCOUNT_FILE = `${MAIL_DIR}/account.json`;
export const SECRET_FILE = `${MAIL_DIR}/secret.json`;
const ALG = 'aes-256-gcm';

const fail = (code, message) => Object.assign(Error(message), { code });
const aad = (address) => Buffer.from(`offercrew-mail:v1:${normalizeAddress(address)}`);

export function seal(key, address, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, key, iv, { authTagLength: 16 });
  c.setAAD(aad(address));
  const data = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return { v: 1, alg: ALG, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function unseal(key, address, box) {
  if (!box || box.v !== 1 || box.alg !== ALG) throw fail('mail_secret_unreadable', '保存的授权码读不出来，要重新填一次');
  try {
    const d = crypto.createDecipheriv(ALG, key, Buffer.from(String(box.iv), 'base64'), { authTagLength: 16 });
    d.setAAD(aad(address));
    d.setAuthTag(Buffer.from(String(box.tag), 'base64'));
    return Buffer.concat([d.update(Buffer.from(String(box.data), 'base64')), d.final()]).toString('utf8');
  } catch { throw fail('mail_secret_unreadable', '保存的授权码读不出来（钥匙串里的密钥换过了），要重新填一次'); }
}

async function masterKey({ create }) {
  const k = keychain();
  let hex = await k.read();
  if (!hex && create) hex = await k.add(crypto.randomBytes(32).toString('hex'));
  return hex ? Buffer.from(hex, 'hex') : null;
}

// 只给这个用户读写：先写临时文件（0600），再改名。
function writePrivate(rel, data) {
  const dest = file(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(dest), 0o700); } catch {} // 兜底：改不了权限的文件系统就照现在的权限
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}
const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(file(rel), 'utf8')); } catch { return null; } }; // 兜底：不在是没接邮箱；读坏了是 null，accountBroken 会照实说账号文件坏了

// 账号文件在、却读不出来（坏了）。断开了（文件不在）是 false。
export const accountBroken = () => fs.existsSync(file(ACCOUNT_FILE)) && !loadAccount();
// 账号（不含授权码）。没有、坏了都是 null。
export function loadAccount() {
  const a = readJson(ACCOUNT_FILE);
  return a && a.v === 1 && typeof a.address === 'string' && a.address.includes('@') ? a : null;
}

// 存账号和授权码。account：{ address, provider, login?, imap_user?, servers? }；servers 只有沙盒里连本机测试服务器时才有。
export async function saveAccount(account, code, { now = new Date() } = {}) {
  const address = normalizeAddress(account.address);
  const key = await masterKey({ create: true });
  writePrivate(SECRET_FILE, seal(key, address, code));
  const saved = {
    v: 1, address, provider: account.provider,
    ...(account.login ? { login: String(account.login) } : {}),
    // 测试时真正登录上的 IMAP 用户名（iCloud 可能是 @ 前面那段）：读信时直接用它，不用每次再试一遍。
    // 登录成功的那个登录名照存（是完整地址也存）：iCloud 下次不再先试 @ 前面那段，少登录一次（兜底清单 H02）。
    ...(account.imap_user ? { imap_user: String(account.imap_user) } : {}),
    ...(account.servers ? { servers: account.servers } : {}),
    // 只收信（第 6b 轮）：收信通、发信不通也存下来，照常读信；send 记着发信为什么不通，重新测试过了就去掉。
    ...(account.send ? { send: account.send } : {}),
    saved_at: now.toISOString(),
    checked_at: account.checked_at || now.toISOString(),
    status: 'ok',
  };
  writePrivate(ACCOUNT_FILE, saved);
  return saved;
}

// 读回授权码。没连过：mail_not_connected；解不开：mail_secret_unreadable。
export async function loadSecret(account = loadAccount()) {
  if (!account) throw fail('mail_not_connected', '还没连邮箱');
  const box = readJson(SECRET_FILE);
  if (!box) throw fail('mail_secret_unreadable', '保存的授权码不见了，要重新填一次');
  const key = await masterKey({ create: false });
  if (!key) throw fail('mail_secret_unreadable', '钥匙串里找不到邮箱的密钥，要重新填一次授权码');
  return unseal(key, account.address, box);
}

// 记下最近一次连接的结果（测试、以后的查信）：status ok 或失败的 kind，失败时带一句人话。
export function markChecked(result, { now = new Date() } = {}) {
  const a = loadAccount();
  if (!a) return null;
  const next = { ...a, checked_at: now.toISOString(), status: result.ok ? 'ok' : result.kind || 'server' };
  if (result.ok) delete next.problem; else next.problem = String(result.reason || '').slice(0, 200);
  // 收信通、发信不通：照常算连上（只收信），记下发信的原因；发信也通了就去掉。收信都没通的不动 send。
  if (result.ok && result.receive_only) next.send = { ok: false, kind: result.send?.kind || 'server', reason: String(result.send?.reason || '').slice(0, 300), at: now.toISOString() };
  else if (result.ok) delete next.send;
  writePrivate(ACCOUNT_FILE, next);
  return next;
}

// 断开：删账号和加密的授权码。钥匙串里的主密钥留着（不删任何钥匙串条目）。
export function forgetAccount() {
  let removed = false;
  for (const rel of [SECRET_FILE, ACCOUNT_FILE]) { try { fs.unlinkSync(file(rel)); removed = true; } catch {} } // 兜底：文件本来就不在就不用删
  return removed;
}
