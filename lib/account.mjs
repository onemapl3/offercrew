// OfferCrew 账户（10-03）：补给跟着账户走，不跟着电脑。中转那头的接口见 design/handoff/账户-接口.md。
//
//   登录   邮箱验证码（emailStart → emailVerify），或者 Google：googleStart 生成 PKCE 和 state，界面用系统浏览器打开中转的
//          /account/google/start；中转把人送回工作台自己的回环地址（bin/serve.mjs /api/account/google/cb），googleFinish 拿一次性的码
//          换账户令牌。Google 的钥匙只在中转，App 里一样都不放。
//   令牌   账户令牌（oca_…）和账户邮箱存在 private/providers/offercrew.auth.json（600，lib/free-model.mjs saveAuth），和这台电脑原来的
//          安装令牌放在一起；第一次登录时把安装令牌交上去并号（中转只并一次）。令牌不进日志、不进页面、不进事件；事件里也不写邮箱。
//   退出   logout：告诉中转作废这个令牌，本机删掉它（中转连不上也照样删）。
//   面板   accountView：左下角账户面板要的——邮箱、补给还剩多少、最近用掉的（10-03 不限时，不写到期）（中转 /account/usage，只有用途词、token 数和时间）。
//          详细的「判断 #12 · 某公司」只在本机的用量账里（lib/usage.mjs），不上中转。
import os from 'node:os';
import crypto from 'node:crypto';
import { read } from './store.mjs';
import { event } from './events.mjs';
import { sandboxed, sandboxModels } from './sandbox.mjs';
import { FREE_AUTH, relay, relayBase, saveAuth, accountToken, forgetAccount, applyQuota, freeState, freeEnabled, balanceLabel, remainingLabel, tokenText, freeBlocked, UNIT } from './free-model.mjs';
import { noteSwallowed } from './swallow.mjs';

const UNREACHABLE = '连不上 OfferCrew 的中转，稍后再试。';
const OFFLINE = '演示 / 沙盒模式不登录';
const OFF = '这个版本没有配置 OfferCrew 补给';
const offline = () => sandboxed() && !sandboxModels();
const cleanEmail = v => String(v || '').trim().toLowerCase().slice(0, 254);
const looksEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const emailOf = a => (a && typeof a.email === 'string' ? a.email : null);
// 这台电脑叫什么（流水里「哪台电脑」那一栏）：主机名去掉 .local，最多 40 个字。
export const deviceName = () => String(os.hostname() || 'Mac').replace(/\.local$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Mac';
// 现在登着的账户：{ id, email }；没登录 null。
export function currentAccount() {
  if (!accountToken()) return null;
  const a = read(FREE_AUTH, null)?.account || {};
  return { id: typeof a.id === 'string' ? a.id : null, email: emailOf(a) };
}
const ready = () => (offline() ? { error: 'sandbox', reason: OFFLINE } : !relayBase() ? { error: 'not_configured', reason: OFF } : null);
const fail = (status, body, fallback) => ({ status: status >= 400 && status < 600 ? status : 409, body: { error: String(body?.error || 'refused'), reason: String(body?.reason || fallback).slice(0, 200), ...(body?.retry_after != null ? { retry_after: Number(body.retry_after) || null } : {}), ...(body?.attempts_left != null ? { attempts_left: Number(body.attempts_left) } : {}) } });

// ── 邮箱验证码 ─────────────────────────────────────────────────────────────────
export async function emailStart({ email } = {}) {
  const e = cleanEmail(email);
  if (!looksEmail(e)) return { status: 400, body: { error: 'bad_email', reason: '这不像一个邮箱地址' } };
  const no = ready(); if (no) return { status: 409, body: no };
  let r; try { r = await relay('/account/email/start', { method: 'POST', body: { email: e } }); } catch { return { status: 409, body: { error: 'unreachable', reason: UNREACHABLE } }; }
  if (!r.ok) return fail(r.status, r.body, '验证码没发出去，稍后再试。');
  return { status: 200, body: { ok: true, resend_after: Number(r.body.resend_after) || 60, expires_in: Number(r.body.expires_in) || 600 } };
}
export async function emailVerify({ email, code } = {}) {
  const e = cleanEmail(email), c = String(code || '').replace(/\D/g, '');
  if (!looksEmail(e)) return { status: 400, body: { error: 'bad_email', reason: '这不像一个邮箱地址' } };
  if (c.length !== 6) return { status: 400, body: { error: 'bad_code', reason: '验证码是 6 位数字' } };
  const no = ready(); if (no) return { status: 409, body: no };
  return signIn('/account/email/verify', { email: e, code: c }, 'email');
}

// ── Google（中转当中间人，回环地址 + PKCE）─────────────────────────────────────────
// state → { verifier, expires }；只在内存里，十分钟有效，用一次就删。
const pending = new Map();
export function googleStart({ redirect_uri, now = Date.now() } = {}) {
  const no = ready(); if (no) return { status: 409, body: no };
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\S*$/.test(String(redirect_uri || ''))) return { status: 400, body: { error: 'bad_redirect', reason: '登录回不到 OfferCrew' } };
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const verifier = crypto.randomBytes(48).toString('base64url'), state = crypto.randomBytes(24).toString('base64url');
  pending.set(state, { verifier, expires: now + 600000 });
  const q = new URLSearchParams({ redirect_uri, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state });
  return { status: 200, body: { url: `${relayBase()}/account/google/start?${q}` } };
}
// 回环地址收到的 ?code=&state=（或 ?error=&reason=&state=）。回 { status, body }，body.reason 给回环那一页显示。
export async function googleFinish(params, { now = Date.now() } = {}) {
  const get = k => (params?.get ? params.get(k) : params?.[k]) || '';
  const p = pending.get(get('state'));
  if (!p || p.expires < now) { pending.delete(get('state')); return { status: 400, body: { error: 'code_expired', reason: '登录超时了，请重新点 Google 登录。' } }; }
  pending.delete(get('state'));
  if (get('error')) return { status: 400, body: { error: String(get('error')).slice(0, 40), reason: String(get('reason') || 'Google 登录没成功，稍后再试，或者用邮箱验证码。').slice(0, 200) } };
  if (!get('code')) return { status: 400, body: { error: 'code_expired', reason: '登录超时了，请重新点 Google 登录。' } };
  return signIn('/account/google/token', { code: String(get('code')).slice(0, 512), code_verifier: p.verifier }, 'google');
}

// 两种登录最后都走这里：带上这台电脑的名字和原来的安装令牌（并号），存下账户令牌，接上补给。
async function signIn(path, payload, how) {
  const auth = read(FREE_AUTH, null) || {};
  const install = typeof auth.auth_token === 'string' && /^oc_[0-9a-f]{64}$/.test(auth.auth_token) ? auth.auth_token : null;
  let r; try { r = await relay(path, { method: 'POST', body: { ...payload, device: deviceName(), ...(install ? { install_token: install } : {}) } }); } catch { return { status: 409, body: { error: 'unreachable', reason: UNREACHABLE } }; }
  if (!r.ok) return fail(r.status, r.body, '登录没成功，稍后再试。');
  const token = r.body.account_token, acc = r.body.account || {};
  if (typeof token !== 'string' || !/^oca_[0-9a-f]{64}$/.test(token)) return { status: 409, body: { error: 'relay_error', reason: '登录没成功，稍后再试。' } };
  saveAuth({ provider: 'offercrew', wire_api: 'chat', ...auth, base_url: relayBase(), account_token: token, account: { id: /^a_[0-9a-z]{6,40}$/.test(acc.id || '') ? acc.id : null, email: cleanEmail(acc.email || payload.email || '') || null, at: new Date().toISOString() } });
  // 账户上的余额、到期：/account/me 回的和 /quota 同一套字段。
  applyQuota(acc.balance != null ? acc : {});
  // 第一次登录：接上供应商 offercrew；没有别的文字模型能用时，补给就是文字模型和对话默认（和原来开通补给一样）。
  let wired = { text: false, chat: false };
  try { const { useFreeModel } = await import('./model-choice.mjs'); const w = await useFreeModel({}); if (!w.error) wired = w; } catch (e) { noteSwallowed('account.wireUp', e, { doing: '登录后接上补给', then: '登录照常，补给要在设置 → 模型里接' }); }
  event('user', 'account', 'ok', `登录了 OfferCrew 账户（${how === 'google' ? 'Google' : '邮箱验证码'}）${r.body.merged ? '，这台电脑原来的补给并进了账户' : ''}${wired.text ? '；文字模型用补给' : ''}`);
  return { status: 200, body: { ok: true, email: cleanEmail(acc.email || payload.email || ''), merged: r.body.merged ? true : false, text_model: !!wired.text } };
}

// ── 退出 ───────────────────────────────────────────────────────────────────────
export async function logout() {
  const token = accountToken();
  if (!token) return { status: 200, body: { ok: true, already: true } };
  if (!offline() && relayBase()) { try { await relay('/account/logout', { method: 'POST', token, timeout: 8000 }); } catch (e) { noteSwallowed('account.logout', e, { doing: '通知中转这台电脑退出了账户', then: '本机照样退出、删掉令牌' }); } }
  forgetAccount();
  event('user', 'account', 'ok', '退出了 OfferCrew 账户');
  return { status: 200, body: { ok: true } };
}

// ── 左下角账户面板 ──────────────────────────────────────────────────────────────
// { signed_in, email, initial, balance_text, remaining_label, blocked, rows: [{ what, tokens, tokens_text, at }], more }；
// 没登录：{ signed_in: false, can_login, reason }。中转连不上时用本机记着的余额，rows 为 null。
export async function accountView({ now = Date.now(), rows = true } = {}) {
  const acc = currentAccount();
  if (!acc) { const no = ready(); return { signed_in: false, can_login: !no, reason: no?.reason || null, supply_on: freeEnabled() }; }
  const token = accountToken();
  let me = null, list = null, more = false, err = null;
  if (!ready()) {
    try {
      const r = await relay('/account/me', { token, timeout: 8000 });
      if (r.status === 401) { forgetAccount(); return { signed_in: false, can_login: true, reason: String(r.body?.reason || '登录过期了，请重新登录。').slice(0, 200), supply_on: freeEnabled() }; }
      if (r.ok && r.body.account) { me = r.body.account; applyQuota(me, now); } else if (!r.ok) err = String(r.body?.reason || UNREACHABLE).slice(0, 200); // 503 accounts_off 这类：照「暂时连不上」说，不当成没登录
      if (rows) {
        const u = await relay('/account/usage?limit=30', { token, timeout: 8000 });
        if (!u.ok && !err) err = String(u.body?.reason || UNREACHABLE).slice(0, 200);
        if (u.ok && Array.isArray(u.body.rows)) { list = u.body.rows.slice(0, 30).map(x => ({ what: String(x.what || '其他').slice(0, 20), tokens: Math.max(0, Number(x.tokens) || 0), tokens_text: tokenText(x.tokens), at: x.at || null, device: x.device ? String(x.device).slice(0, 40) : null })); more = u.body.next != null; }
      }
    } catch { err = UNREACHABLE; }
  }
  const q = freeState().quota || null, blocked = freeBlocked({ now });
  const email = acc.email || (me && cleanEmail(me.email)) || '';
  return {
    signed_in: true, email, initial: (email.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase(),
    balance: q?.balance ?? null, balance_text: q?.balance != null ? tokenText(q.balance) : null, unit: UNIT,
    balance_label: balanceLabel(q, now), remaining_label: remainingLabel(q, now),
    blocked: blocked && blocked.kind !== 'login' ? { kind: blocked.kind, reason: blocked.reason } : null,
    rows: list, more, reason: err, supply_on: freeEnabled(),
  };
}
