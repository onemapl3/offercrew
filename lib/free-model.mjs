// OfferCrew 补给：新用户不用 key，登录 OfferCrew 账户就能用我们提供的额度（2026-10-02 负责人：原来叫「免费额度」「点」，改叫「OfferCrew 补给」；
// 它是我们提供、以后要收费的智能服务，不能让人以为永远免费）。10-03 负责人：产品里不写送多少、不写多少天——「你可以用我们官方提供给你的
// 订阅额度，也可以自己用自己的 key」；赠送的数只写在宣传里。赠送不限时，用完为止（中转回的 expires_at 是 null）。单位写 token：「剩 380 万 token」，
// 英文「OfferCrew Tokens: 3.8M left」。每次扣 = 没命中缓存的输入 + 输出 + 命中缓存的输入 × 0.1（中转算，见 relay/model/worker.mjs costOf）。
//
// 真的模型 key 不在 App 里，只在负责人部署的中转里（relay/model/，地址是 lib/brand.mjs 的 FREE_MODEL_RELAY）。
// 送多少在中转那边（relay/model/wrangler.toml 的 SIGNUP_TOKENS），App 里不写；
// 没有「每天最多用多少」。用完或到期以后，改用自己的 API key 或这台电脑上的 Claude Code、Codex——但只换成你自己配过的
// （lib/backends.mjs dropUnpickedLocal：模板里原来就有的本机 Claude Code / Codex 不算，不会悄悄换过去）；什么都没配就是「没有模型」。
// 你选「OfferCrew 补给」时（只在那时），引擎向中转领一个匿名令牌，像粘贴的 key 一样存在 private/providers/offercrew.auth.json，
// 再加一个 openai_http 供应商 offercrew 指向中转；没有别的模型能用时，它就是文字模型（config/model.json text.backends）
// 和对话的默认底座。之后的调用照常走 lib/model.mjs、lib/chat.mjs 的 openai_http 驱动，不需要改驱动。
//
//   状态   state/free-model.json：最近一次知道的余额（中转在每次回答的响应头里带回剩多少、这次花了多少、赠送的哪天到期）、安装编号、
//          中转允许的模型和价钱（GET /models）、被拒的原因和到什么时候（blocked：用完了 / 过期了 / 碰上防滥用的限流 / 全站暂停 /
//          关了 / 令牌失效）。令牌不写在这里。
//   用完   被拒之后，文字模型只剩补给可用时：指挥台顶上一句「补给用完了」加「看原因」（lib/hq.mjs stop），收件箱来一封信
//          （几条路：粘贴自己的 key、Mac 版用 ChatGPT 登录、本机检测到的 Claude Code / Codex），自动排的判断、匹配、找人、调研
//          像花费上限那样先停（lib/spend.mjs budgetGate）。发信、投递、你已经批准的事不受影响（它们本来就不靠这几步）。
//   沙盒   演示 / 沙盒模式不碰网络：GET 回答 { available: false, demo: true }，start 回 409。开了 RADAR_SANDBOX_MODELS=1
//          （lib/sandbox.mjs sandboxModels）就照常：领令牌、查余额、列模型、经中转调用，都在 modelCall 里放行。
//   地址   RADAR_FREE_RELAY_URL（或旧名 OFFERCREW_FREE_RELAY）覆盖中转地址，可以是 http://127.0.0.1:8787 这种本机的
//          wrangler dev：部署之前先在本机把整条路走一遍。覆盖了就连已经领过的令牌也跟着走这个地址。
//   账     lib/usage.mjs 把供应商 offercrew 记成 billing: credits：记 token 和每次花的补给，你付的钱是 ¥0，旁边显示剩多少。
//   兑换码 （2026-09-30）中转分两格记：赠送的和兑换码加的（不过期，以后卖；这次不做购买）。redeemFreeCode 先在本机
//          核一遍格式和校验位（输错一位当场说），再交给中转（POST /redeem）；兑换记录只留码的最后 4 位，在 state/free-model.json 的
//          redemptions 里。内测名额（中转的 MAX_FREE_INSTALLS）满了，领补给回「内测名额已满」，兑换码照样能用。买的地址：中转 /models
//          的 buy_url，没有就用 OFFERCREW_BUY_URL 或 lib/brand.mjs 的 BUY_POINTS_URL（默认空 = 不显示）。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { relayDiagnostic, scrubRelayBody, temporaryRelayFailure } from './relay-diagnostic.mjs';
import { read, write, file } from './store.mjs';
import { FREE_MODEL_RELAY, FREE_MODEL_ON, BUY_POINTS_URL } from './brand.mjs';
import { normalizeCode, maskCode, CODE_REASON } from './redeem-code.mjs';
import { sandboxed, sandboxModels, modelCall } from './sandbox.mjs';
import { loadProviders, saveProviders, resolveBackend, textBackendUsable, dropUnpickedLocal } from './backends.mjs';
import { event } from './events.mjs';
import { textConf } from './text-conf.mjs';
import { noteSwallowed } from './swallow.mjs';
// 本机的几样事实（供应商名、令牌和状态的位置、接没接上）在 lib/free-state.mjs，text-conf 也从那里取；这里原样转出去。
import { FREE_PROVIDER, FREE_AUTH, FREE_STATE, bearerOf, tokenOf, freeState, freeEnabled } from './free-state.mjs';
export { FREE_PROVIDER, FREE_AUTH, FREE_STATE, bearerOf, freeState, freeEnabled };

export const FREE_LABEL = 'OfferCrew 补给';
export const UNIT = 'token';
export const FREE_LABEL_EN = 'OfferCrew Tokens';
export const FREE_PRIVACY = '选 OfferCrew 补给时，你的简历和岗位描述会经过 OfferCrew 的中转服务器，再交给模型服务商处理；中转只记用了多少补给，不保存内容。接了邮箱以后，判断邮件用到的发件人、标题和对方新写的那一段，也会这样经过中转。登录用的邮箱存在 OfferCrew 的中转上，只用来登录和记补给用量。想自己掌控，就用自己的 API key 或 ChatGPT 账号。';
export const SANDBOX_REASON = '演示 / 沙盒模式不调用模型';
const OFF_REASON = '这个版本没有配置 OfferCrew 补给';
const UNREACHABLE = '连不上 OfferCrew 补给的中转，稍后再试，或者先用自己的 API key。';
const REFRESH_MS = 60000;
// 被拒之后多久再试一次（用完、过期也隔几个小时再问一次：负责人可能补了）。防滥用的限流（request_limit、daily_limit、paused）到北京时间明天 0 点。
// upstream：中转那边的设置出了问题（key 没配、配置写坏了、账户没开）：十分钟后再试。
// 模型服务商这一次没答上来（超时 524、5xx、流断了、连不上）不在这里：只算这一次失败，不停用补给；连着 UPSTREAM_STREAK 次才停 UPSTREAM_PAUSE_MS（见 noteRelayResponse）。
// login：要登录（没登录、登录过期）：不定时重试，登录了就清掉。
const RECHECK_MS = { login: 0, upstream: 10 * 60000, credits_exhausted: 6 * 3600000, credits_expired: 6 * 3600000, off: 3600000, bad_token: 6 * 3600000, request_limit: null, daily_limit: null, paused: null };
const KINDS = Object.keys(RECHECK_MS);
// 模型服务商连着几次没答上来（中间没有一次成功，相邻两次不超过 UPSTREAM_WINDOW_MS）才短暂停一下补给，免得一直撞。
export const UPSTREAM_STREAK = 3, UPSTREAM_WINDOW_MS = 10 * 60000, UPSTREAM_PAUSE_MS = 2 * 60000;
// 中转回的 why 里算「等太久」的：上游前面的 Cloudflare 等首字节超时（524）、网关超时（504）、请求超时（408）、源站连不上（522）。
const TIMEOUT_WHY = /^http_(?:408|504|522|524)$/;
// 中转自己的设置问题（不是这一次的运气）：照旧停十分钟。
const RELAY_SETUP = ['model_key_missing', 'model_misconfigured', 'config_invalid', 'accounts_off'];
export const BETA_FULL = '内测名额已满';
// 补给的模型旁边那一句（中转 MODELS 没写 note 时用）：10-03 负责人，Astra 默认，Sol 给想省的成员（比如 Watcher 读信）。
export const FREE_MODEL_NOTE = { 'gpt-6-sol': '更快、更省' };
// 挡路时顶上那一句（指挥台、团队页、收件箱的信标题都用它）。
export const BLOCK_TITLE = { login: '要登录才能用补给', upstream: '补给暂时连不上', credits_exhausted: '补给用完了', credits_expired: '补给用完了', daily_limit: '今天的补给到上限了', request_limit: '今天的调用次数到上限了', paused: 'OfferCrew 补给今天暂停了', off: 'OfferCrew 补给暂时关闭了', bad_token: 'OfferCrew 补给的令牌失效了' };
export const BAD_TOKEN = 'OfferCrew 补给的令牌失效了，在「设置 → 模型」里重新领取。';
export const LOGIN_REASON = '登录 OfferCrew 账户以后才能用补给。';
export const LOGIN_EXPIRED = '登录过期了，请重新登录。';

// 中转地址：环境变量可以覆盖（测试、fork、本机的 wrangler dev）；空串或不是 http(s) 就当没配。
const cleanUrl = v => { const s = String(v || '').trim().replace(/\/+$/, ''); return /^https?:\/\/\S+$/.test(s) ? s : null; };
const relayEnv = () => process.env.RADAR_FREE_RELAY_URL != null ? process.env.RADAR_FREE_RELAY_URL : process.env.OFFERCREW_FREE_RELAY;
export function relayBase() {
  const v = relayEnv();
  if (v == null && !FREE_MODEL_ON) return null;
  return cleanUrl(v != null ? v : FREE_MODEL_RELAY);
}
// 调用供应商 offercrew 时用哪个地址：环境变量覆盖了就用覆盖的，否则用领令牌时存下的。
export const freeRelayBase = stored => (relayEnv() != null && cleanUrl(relayEnv())) || stored || relayBase() || '';
// 演示 / 沙盒模式、又没开模型：补给不联网。
const offline = () => sandboxed() && !sandboxModels();
// 调补给时带的用途词（请求头 x-offercrew-what，中转记进账户流水）：只放固定的几个词（lib/model.mjs modelDoing 的那张表），
// 数字和符号去掉、最多 12 个字；公司名、岗位名、邮件标题不放进来。
export const relayWhat = word => String(word || '').replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12) || '其他';
export const whatHeader = word => ({ 'x-offercrew-what': encodeURIComponent(relayWhat(word)) });
export const accountToken = () => { const a = read(FREE_AUTH, null); return typeof a?.account_token === 'string' && /^oca_[0-9a-f]{64}$/.test(a.account_token) ? a.account_token : null; };
// 写 private/providers/offercrew.auth.json（600）。
export function saveAuth(next) {
  fs.mkdirSync(file('private/providers'), { recursive: true, mode: 0o700 });
  write(FREE_AUTH, next);
  fs.chmodSync(file(FREE_AUTH), 0o600);
}
// 本机忘掉账户令牌（退出登录、中转说令牌作废了）。安装令牌留着。
export function forgetAccount() {
  const a = read(FREE_AUTH, null);
  if (!a || !('account_token' in a || 'account' in a)) return false;
  const { account_token, account, ...rest } = a;
  if (rest.auth_token) saveAuth(rest); else fs.rmSync(file(FREE_AUTH), { force: true });
  saveState({ account_seen: null, account_rows: null });
  return true;
}
const saveState = patch => { const s = { ...freeState(), ...patch }; write(FREE_STATE, s); return s; };

// ── 数字怎么说 ─────────────────────────────────────────────────────────────────
// token 数：中文按万、亿（「284 万」「4.5 万」「8500」），英文按 K、M（「2.84M」「950K」）。往下取，不把还没有的说成有。
const cut = (x, digits) => { const k = 10 ** digits; return String(Math.floor(x * k + 1e-9) / k); };
export function tokenText(n, lang = 'zh') {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  if (lang === 'en') return x >= 1e9 ? `${cut(x / 1e9, 2)}B` : x >= 1e6 ? `${cut(x / 1e6, 2)}M` : x >= 1e3 ? `${cut(x / 1e3, x >= 1e5 ? 0 : 1)}K` : String(x);
  if (x >= 1e8) return `${cut(x / 1e8, 2)} 亿`;
  if (x >= 1e4) return `${cut(x / 1e4, x >= 1e6 ? 0 : 1)} 万`;
  return String(x);
}
// 旧名字：别的模块还在用。
export const pointText = n => tokenText(n);
const DAY_MS = 86400000;
// 赠送的还有几天到期（向上取整：还剩 3 小时也说「1 天后到期」）；不知道就 null。
export function daysLeft(expires_at, now = Date.now()) {
  const t = Date.parse(expires_at || '');
  // 减一分钟再取整：本机的钟比中转早几毫秒时不多算一天。
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now - 60000) / DAY_MS)) : null;
}
const freeOf = q => (q.free != null ? Math.max(0, Number(q.free) || 0) : Math.max(0, (Number(q.balance) || 0) - Math.max(0, Number(q.paid) || 0)));
// 还剩多少：「剩 284 万 token」。10-03 起赠送不限时，不写到期（老中转回的 expires_at 也不写）。
export function balanceLabel(q) {
  if (!q || q.balance == null) return null;
  return `剩 ${tokenText(Math.max(0, Number(q.balance) || 0))} ${UNIT}`;
}
// 导航栏和手机「我的」那一格：「⚡ 380 万 · 5 天」。只在文字模型用的是补给时才有（自己的 API、本机运行时不显示，show: false）。
//   days  赠送的还有几天（10-03 起不限时，中转回 null，就不显示）；low  剩的不到送的 10%：琥珀色；empty  用完：「0」。
export function navView(q, { gift = null, now = Date.now(), inUse = true } = {}) {
  if (!inUse || !q || q.balance == null || q.unit !== UNIT) return { show: false };
  const total = Math.max(0, Number(q.balance) || 0), free = freeOf(q), d = free > 0 ? daysLeft(q.expires_at, now) : null;
  const expired = q.expired || q.blocked === 'credits_expired' || (free > 0 && d === 0 && !(Number(q.paid) > 0));
  const left = expired ? 0 : total, empty = left <= 0, base = Number(gift) > 0 ? Number(gift) : null;
  return { show: true, balance: left, text: tokenText(left), text_en: tokenText(left, 'en'), days_left: d, days: null, days_en: null, low: !empty && base != null && left < base * 0.1, empty, label: empty ? (expired ? BLOCK_TITLE.credits_expired : BLOCK_TITLE.credits_exhausted) : `补给：${balanceLabel(q, now)}`, label_en: `${FREE_LABEL_EN}: ${tokenText(left, 'en')} left` };
}
// 一句话的状态：平时就是余额和到期；被挡着时照实说是什么挡着（防滥用的限流只在碰上时才说）。
export function remainingLabel(q, now = Date.now()) {
  if (!q || q.balance == null) return null;
  if (q.paused) return 'OfferCrew 补给今天暂停，北京时间明天 0 点恢复';
  if (q.blocked === 'request_limit') return '今天的调用次数到上限了，北京时间明天 0 点恢复';
  if (q.blocked === 'daily_limit') return `今天的补给到上限了，北京时间明天 0 点恢复（${balanceLabel(q, now)}）`;
  const expired = q.expired || q.blocked === 'credits_expired' || (freeOf(q) > 0 && daysLeft(q.expires_at, now) === 0);
  if ((Number(q.balance) || 0) <= 0 || (expired && !(Number(q.paid) > 0))) return expired ? BLOCK_TITLE.credits_expired : BLOCK_TITLE.credits_exhausted;
  return balanceLabel(q, now);
}
const optNum = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const quotaOf = (b, at) => ({ unit: b.unit === UNIT ? UNIT : null, free: optNum(b.free), paid: optNum(b.paid), balance: Number(b.balance) || 0, expires_at: b.expires_at || null, expired: !!b.expired, blocked: KINDS.includes(b.blocked) ? b.blocked : null, spent: Number(b.spent) || 0, paused: !!b.paused, reason: b.reason || null, resets_at: b.resets_at || null, at, checked_at: at });

// ── 被拒 ───────────────────────────────────────────────────────────────────────
// 现在是不是被中转拒着（到期的不算）。
export function freeBlocked({ now = Date.now(), state = freeState() } = {}) {
  const b = state.blocked;
  if (!b?.kind) return null;
  if (b.until && now >= Date.parse(b.until)) return null;
  return b;
}
// Failed responses only. Successful bodies and request contents never enter these diagnostic files.
function recordRelayFailure(status, headers, text, { request = null, secrets = [], attempt = 1, retry_ms = null } = {}) {
  const diagnostic = relayDiagnostic(status, headers, text);
  const ref = `runs/${new Date().toISOString().slice(0, 10).replaceAll('-', '')}/relay-error-${randomUUID()}.json`;
  try {
    write(ref, { at: new Date().toISOString(), ...diagnostic, attempt, retry_ms, response: scrubRelayBody(text, request, secrets) });
    event('patch', 'free-model', 'warn', retry_ms == null ? '补给这次没答上来，已留下脱敏的错误回执' : `补给上游暂时出错，${retry_ms / 1000} 秒后自动重试`, { refs: [{ file: ref }] });
  } catch (e) { noteSwallowed('free-model.diagnostic', e, { doing: '保存补给错误回执', then: '继续报告这次调用结果' }); }
}
// No usable successor: at most two retries (1s, 3s), sharing the original request deadline.
// Otherwise return the first failure for immediate failover. Never replay a successful/partial answer.
export async function fetchRelay(send, { signal, request = null, secrets = [], allowRetry = true, sleep = delay } = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await send();
    if (r.ok) return r;
    const text = await r.text().catch(() => ''); // 兜底：错误体读不到仍按状态码判断。
    const retryAfter = r.headers?.get?.('retry-after');
    const seconds = retryAfter == null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000);
    const ms = Math.max(attempt === 1 ? 1000 : 3000, (Number.isFinite(seconds) ? seconds : 60) * 1000);
    const retry = allowRetry && attempt < 3 && !signal?.aborted && ms <= 10000 && temporaryRelayFailure(r.status, text);
    recordRelayFailure(r.status, r.headers, text, { request, secrets, attempt, retry_ms: retry ? ms : null });
    if (!retry) return { ok: false, status: r.status, headers: r.headers, text: async () => text };
    await sleep(ms, undefined, { signal });
  }
}

// lib/model.mjs、lib/chat.mjs 调用供应商 offercrew 之后告诉这里：成功就记下剩多少（响应头），被拒就记下原因。
// 写状态出错只丢这一次，不让模型调用本身失败。
export function noteRelayResponse(status, headers = null, bodyText = '', { now = Date.now(), requested = null } = {}) {
  try {
    const at = new Date(now).toISOString();
    if (status >= 200 && status < 300) {
      const h = k => { const v = headers?.get ? headers.get(k) : headers?.[k]; const x = v == null || v === '' ? NaN : Number(v); return Number.isFinite(x) ? x : null; };
      const balance = h('x-offercrew-balance'), cost = h('x-offercrew-cost'), free = h('x-offercrew-free'), paid = h('x-offercrew-paid');
      const ex = headers?.get ? headers.get('x-offercrew-expires') : headers?.['x-offercrew-expires'], expires = ex && Number.isFinite(Date.parse(ex)) ? new Date(Date.parse(ex)).toISOString() : null;
      const s = freeState();
      if (balance != null) {
        const q = s.quota || {};
        const unit = (headers?.get ? headers.get('x-offercrew-unit') : headers?.['x-offercrew-unit']) === UNIT ? UNIT : null;
        saveState({ quota: { ...q, unit, balance, ...(free != null ? { free } : {}), ...(paid != null ? { paid } : {}), ...(expires ? { expires_at: expires } : {}), expired: false, blocked: null, spent: (Number(q.spent) || 0) + (cost || 0), paused: false, at }, blocked: null });
      } else if (s.blocked) saveState({ blocked: null });
      if (freeState().upstream_fails) saveState({ upstream_fails: null });
      // 实际是谁答的（x-offercrew-model）：用量账照它记。
      const hv = k => (headers?.get ? headers.get(k) : headers?.[k]) || null, sv = hv('x-offercrew-model');
      const served = sv && /^[\w./:-]{1,80}$/.test(sv) ? sv : null;
      // 答的不是请求的那个（兜底清单 A03）：用量账照实记答的那个；同一天同一对只给 System 记一条。
      if (served && requested && served !== requested) { const k = `${new Date(now + 8 * 3600000).toISOString().slice(0, 10)}|${requested}|${served}`; if (freeState().served_note !== k) { saveState({ served_note: k }); event('patch', 'free-model', 'warn', `请求的是 ${requested}，实际由 ${served} 回答`); } }
      return cost == null && !served ? null : { cost, ...(served ? { served } : {}) };
    }
    let body = {}; try { body = JSON.parse(bodyText || '{}') || {}; } catch {} // 兜底：正文不是 JSON 就按空的判断，状态码照样看
    // 上游出错（中转连不上模型服务商、服务商回错）：算「补给暂时连不上」，照实带上原因（why 只是类别和状态码）。
    // key 没配、配置写坏了（中转 503，兜底清单 B02、B03）也算这一类：原因照实带上。
    const upstream = status !== 400 && ['upstream_error', 'upstream_unreachable', 'model_key_missing', 'model_misconfigured', 'config_invalid', 'accounts_off'].includes(body.error);
    // 401 login_required（没登录、安装令牌并过号）、account_token_invalid（退出了或者令牌作废）：要登录；作废的令牌本机也删掉。
    const login = status === 401 && ['login_required', 'account_token_invalid'].includes(body.error);
    if (login && body.error === 'account_token_invalid') forgetAccount();
    // 503 也可能是 Cloudflare 的临时 HTML 错误（例如 Worker 资源限制 1102）。
    // 只有中转明确回 off / not_configured 才停一小时，不能把一次网关故障写成全局关停。
    const off = status === 503 && ['off', 'not_configured'].includes(body.error);
    const kind = login ? 'login' : upstream ? 'upstream' : status === 401 ? 'bad_token' : off ? 'off' : status === 429 && KINDS.includes(body.error) ? body.error : null;
    if (!kind) return null;
    const why = upstream ? String(body.why || (headers?.get ? headers.get('x-offercrew-upstream-why') : headers?.['x-offercrew-upstream-why']) || 'error').slice(0, 40) : null;
    // 模型服务商这一次没答上来（不是中转的设置问题）：只算这一次，记一笔连着几次；不到 UPSTREAM_STREAK 次不停用补给。
    const once = upstream && !RELAY_SETUP.includes(body.error) && why !== 'no_key' && why !== 'wire';
    let streak = 0;
    if (once) {
      const f = freeState().upstream_fails, near = f?.n > 0 && now - Date.parse(f.at || '') <= UPSTREAM_WINDOW_MS;
      streak = (near ? f.n : 0) + 1;
      saveState({ upstream_fails: { n: streak >= UPSTREAM_STREAK ? 0 : streak, at } });
      if (streak < UPSTREAM_STREAK) return { upstream: { why, timeout: TIMEOUT_WHY.test(why), n: streak } };
    }
    const recheck = once ? UPSTREAM_PAUSE_MS : RECHECK_MS[kind];
    const until = kind === 'login' ? null : recheck ? new Date(now + recheck).toISOString() : body.resets_at || nextBeijingDay(now);
    const reason = String(body.reason || (kind === 'bad_token' ? BAD_TOKEN : kind === 'login' ? (body.error === 'account_token_invalid' ? LOGIN_EXPIRED : LOGIN_REASON) : BLOCK_TITLE[kind])).slice(0, 200) + (why ? `（${why}）` : '');
    const prev = freeState().blocked;
    // 同一天、同一个原因只给 System 记一条。
    const key = `${new Date(now + 8 * 3600000).toISOString().slice(0, 10)}|${kind}|${why || ''}`;
    const blocked = { kind, reason, at, until, key, ...(why ? { why } : {}) };
    const q0 = freeState().quota || {};
    saveState({ blocked, ...(kind === 'credits_exhausted' || kind === 'credits_expired' ? { quota: { ...q0, balance: optNum(body.balance) ?? 0, ...(kind === 'credits_expired' ? { free: 0, expired: true } : {}), blocked: kind, at } } : {}) });
    if (upstream ? prev?.key !== key : (!prev || prev.kind !== kind || (prev.until && now >= Date.parse(prev.until)))) event(upstream ? 'patch' : 'system', 'free-model', 'blocked', `${BLOCK_TITLE[kind]}：${reason}`);
    return { blocked, ...(once ? { upstream: { why, timeout: TIMEOUT_WHY.test(why), n: streak } } : {}) };
  } catch (e) { noteSwallowed('free-model.noteRelay', e, { doing: '记下补给这次的回话（余额、停用原因）', then: '这次的状态没记上，下次回话再记' }); return null; }
}
// 调补给没成：始终使用补给分类，不把中转的 HTTP 状态当作用户自有模型的认证失败。
//   free_upstream_timeout: http_524   模型服务商太久没回（「模型太久没回」）
//   free_upstream_error: http_502     模型服务商这一次出错、流断了、连不上，或者中转的设置问题（「模型服务商那边暂时出错」）
//   free_quota_blocked: <原因>         用完、过期、限流、要登录、令牌失效、关了：照旧
// free_blocked 只在补给真的停着时带（熔断不把它算到底座头上）。
export function blockedError(b) {
  const e = Error(b.kind === 'upstream' ? `free_upstream_error: ${b.why || 'error'}` : `free_quota_blocked: ${b.reason}`);
  return Object.assign(e, { retryable: true, free_blocked: b.kind });
}
export function relayFailure(status, headers = null, bodyText = '', opts = {}) {
  const diagnostic = relayDiagnostic(status, headers, bodyText);
  let body = {}; try { body = JSON.parse(bodyText || '{}') || {}; } catch {} // 兜底：网关拒绝可能是纯文本，按状态码与拒绝标识判断。
  if (['1010', '1020'].includes(String(body?.diagnostic?.cloudflare_code || '')) || body.upstream_status === 401) return Object.assign(Error('free_upstream_access: service_refused'), { retryable: false });
  if (status === 403 || ['1010', '1020'].includes(diagnostic.cloudflare_code)) return Object.assign(Error(`free_relay_access: http_${status}`), { retryable: false });
  const n = noteRelayResponse(status, headers, bodyText, opts);
  if (n?.upstream) return Object.assign(Error(`${n.upstream.timeout ? 'free_upstream_timeout' : 'free_upstream_error'}: ${n.upstream.why}`), { retryable: true, ...(n.blocked ? { free_blocked: n.blocked.kind } : {}) });
  return n?.blocked ? blockedError(n.blocked) : Object.assign(Error(`${status === 400 ? 'free_request_error' : 'free_upstream_error'}: http_${status}`), { retryable: status === 0 || status >= 500 });
}
// 流式回答（stream: true，10-03）：余额要到流结束才知道，中转在最后写一行注释 `: offercrew {cost, balance, free, paid, expires_at, unit, model}`。
// line：那一行冒号后面的部分（「offercrew {...}」），或者已经解析好的对象。照响应头那一套记（noteRelayResponse），认不出就什么都不动。
export function noteRelayTrailer(line, { now = Date.now(), requested = null } = {}) {
  let o = line;
  if (typeof line === 'string') { const m = /^\s*offercrew\s+(\{.*\})\s*$/.exec(line); if (!m) return null; try { o = JSON.parse(m[1]); } catch (e) { noteSwallowed('free-model.trailer', e, { doing: '读补给回答末尾的说明（余额、实际是哪个模型答的）', then: '这次余额不更新' }); return null; } }
  if (!o || typeof o !== 'object') return null;
  const h = { 'x-offercrew-balance': o.balance, 'x-offercrew-cost': o.cost, 'x-offercrew-free': o.free, 'x-offercrew-paid': o.paid, 'x-offercrew-expires': o.expires_at, 'x-offercrew-unit': o.unit, 'x-offercrew-model': o.model };
  return noteRelayResponse(200, Object.fromEntries(Object.entries(h).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])), '', { now, requested });
}
const nextBeijingDay = now => { const d = new Date(now + 8 * 3600000).toISOString().slice(0, 10); return new Date(Date.parse(`${d}T00:00:00+08:00`) + 86400000).toISOString(); };

// ── 文字模型是不是只剩补给 ─────────────────────────────────────────────────────
// 和 lib/model.mjs backendsFor 同一条：排在补给后面、你没选过的本机 Claude Code / Codex 不算（不会悄悄换过去）。
// 文字链从 lib/text-conf.mjs 取（A07 / A08）：config/model.json 没写 text 时是默认链（领过令牌就是补给），和 infer、挡路横条看的同一条。
function textChain(providers = loadProviders()) {
  const conf = textConf({ providers });
  return dropUnpickedLocal((Array.isArray(conf.backends) ? conf.backends : []).map(r => { try { return resolveBackend(r, providers); } catch { return null; } }).filter(Boolean)); // 兜底：解析不了的那一项跳过（和对话的清单同一条规矩）
}
// 清单里除了补给之外，还有没有能用的文字模型。
export function otherTextModel(providers = loadProviders()) {
  return textChain(providers).find(b => b.provider !== FREE_PROVIDER && textBackendUsable(b)) || null;
}
// 被拒着、而且文字模型只剩补给：自动排的模型活先停（lib/spend.mjs budgetGate），收件箱来一封信。
export function freeHold({ now = Date.now() } = {}) {
  try {
    const b = freeBlocked({ now });
    if (!b) return null;
    const providers = loadProviders();
    if (!textChain(providers).some(x => x.provider === FREE_PROVIDER)) return null;
    if (otherTextModel(providers)) return null;
    return b;
  } catch (e) { noteSwallowed('free-model.hold', e, { doing: '看补给被拒时要不要先停自动的模型活', then: '照常排' }); return null; }
}

// ── 和中转说话 ─────────────────────────────────────────────────────────────────
export async function relay(path, { method = 'GET', token = null, timeout = 15000, body: payload = {} } = {}) {
  const base = relayBase();
  const r = await modelCall(() => globalThis.fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(timeout) }));
  const text = await r.text();
  let body = {}; try { body = JSON.parse(text) || {}; } catch {} // 兜底：正文不是 JSON 就按空的判断，状态码照样带回去
  return { status: r.status, ok: r.ok, body, headers: r.headers, text };
}
// 问一次中转还剩多少（一分钟内问过就用上次的）。返回 { quota } 或 { error }。
async function refreshQuota({ now = Date.now(), force = false } = {}) {
  const s = freeState(), token = tokenOf();
  if (!token) return { error: 'no_token' };
  // 存的还是旧单位（10-03 以前按「补给 / 点」记的）就马上重问。
  if (!force && s.quota?.unit === UNIT && s.quota?.checked_at && now - Date.parse(s.quota.checked_at) < REFRESH_MS) return { quota: s.quota, cached: true };
  let r;
  const acc = accountToken();
  try { r = await relay(acc ? '/account/me' : '/quota', { token, timeout: 8000 }); } catch { return { error: 'unreachable', quota: s.quota || null }; }
  if (!r.ok) { const n = noteRelayResponse(r.status, r.headers, r.text, { now }); return { error: n?.blocked?.kind === 'login' ? 'login' : r.status === 401 ? 'bad_token' : 'refused', quota: s.quota || null }; }
  return { quota: applyQuota(acc ? r.body.account || {} : r.body, now) };
}
// 中转说还能用：清掉被拒；说用完 / 过期 / 碰上限流：按原因记下（和调用被拒一样）。
export function applyQuota(body, now = Date.now()) {
  const at = new Date(now).toISOString(), quota = quotaOf(body, at);
  const kind = quota.blocked || (quota.paused ? 'paused' : quota.balance <= 0 ? (quota.expired ? 'credits_expired' : 'credits_exhausted') : null);
  const blocked = kind ? { kind, reason: quota.reason || BLOCK_TITLE[kind], at, until: RECHECK_MS[kind] ? new Date(now + RECHECK_MS[kind]).toISOString() : quota.resets_at || nextBeijingDay(now) } : null;
  saveState({ quota, blocked, ...(body.install_id ? { install_id: body.install_id } : {}) });
  return quota;
}

// ── GET /api/model/free ─────────────────────────────────────────────────────────
// { available, enabled, remaining_label, paused, reason, demo }（外加 privacy：给界面放在选项旁边的一句话）；
// 补给：balance_label（剩 N 补给，M 天后到期）、free_points / paid_points、expires_at / days_left、beta_full（内测名额满了）、buy_url、redemptions。
// signed_in、email：登着哪个 OfferCrew 账户（10-03）。没登录时界面上补给那一块只放「登录」。
export async function freeModelView(opts = {}) {
  const v = await freeView0(opts), t = accountToken(), email = t ? read(FREE_AUTH, null)?.account?.email || null : null;
  return { ...v, signed_in: !!t, email: typeof email === 'string' ? email : null };
}
async function freeView0({ now = Date.now(), refresh = true } = {}) {
  const enabled = freeEnabled(), st0 = freeState();
  const extra = () => { const st = freeState(), q = st.quota || null; return { buy_url: buyUrl(), beta_full: !enabled && !!st.beta_full_at, balance_label: enabled ? balanceLabel(q, now) : null, free_points: q ? freeOf(q) : null, paid_points: q?.paid ?? (q ? 0 : null), expires_at: q?.expires_at || null, days_left: q?.expires_at ? daysLeft(q.expires_at, now) : null, gift: { tokens: giftTokens(st), days: st.models?.signup_days || 30 }, redemptions: redemptionsOf(st), nav: navView(q, { gift: giftTokens(st), now, inUse: enabled && freeInUse() }) }; };
  if (offline()) return { available: false, enabled, remaining_label: null, paused: false, reason: SANDBOX_REASON, demo: true, privacy: FREE_PRIVACY, ...extra() };
  if (!relayBase()) return { available: false, enabled: false, remaining_label: null, paused: false, reason: OFF_REASON, demo: false, privacy: FREE_PRIVACY };
  if (!enabled) return { available: !st0.beta_full_at, enabled: false, remaining_label: null, paused: false, reason: st0.beta_full_at ? BETA_FULL : null, demo: false, privacy: FREE_PRIVACY, ...extra() };
  const r = refresh ? await refreshQuota({ now }) : { quota: freeState().quota || null };
  const q = r.quota || null, blocked = freeBlocked({ now });
  const reason = blocked ? blocked.reason : r.error === 'unreachable' ? UNREACHABLE : null;
  const st = freeState();
  return { available: !blocked && r.error !== 'unreachable' && r.error !== 'bad_token', enabled: true, remaining_label: remainingLabel(q, now), paused: !!(q?.paused || blocked?.kind === 'paused' || blocked?.kind === 'off'), reason, demo: false, privacy: FREE_PRIVACY, ...(blocked ? { blocked: blocked.kind } : {}), install_id: st.install_id || null, model: currentFreeModel(), models: st.models?.models || [], ...extra() };
}
// 买补给的地址：中转说的地址优先（负责人改 wrangler.toml 就能换，不用发新版），再是环境变量、lib/brand.mjs。只认 https。
export function buyUrl() {
  const ok = v => (/^https:\/\/[^\s"'<>]+$/.test(String(v || '').trim()) ? String(v).trim() : null);
  return ok(freeState().models?.buy_url) || ok(process.env.OFFERCREW_BUY_URL) || ok(BUY_POINTS_URL) || null;
}
// 中转允许的模型和价钱（GET /models，不要令牌）：存进状态，界面显示「判断一个岗位大约多少补给」。
async function refreshModels() {
  try {
    const r = await relay('/models', { timeout: 8000 });
    if (!r.ok || !Array.isArray(r.body.models)) return freeState().models || null;
    const clean = r.body.models.filter(m => m && /^[\w./:-]{1,80}$/.test(String(m.id || ''))).slice(0, 20).map(m => ({ id: String(m.id), label: String(m.label || m.id).slice(0, 60), default: !!m.default, wire: m.wire === 'responses' ? 'responses' : 'chat', note: m.note ? String(m.note).slice(0, 20) : FREE_MODEL_NOTE[String(m.id)] || null, examples: Array.isArray(m.examples) ? m.examples.slice(0, 5).map(e => ({ key: String(e.key || ''), label: String(e.label || '').slice(0, 30), tokens: Math.max(0, Math.round(Number(e.tokens) || 0)) })) : [] }));
    if (!clean.length) return freeState().models || null;
    const models = { default: clean.find(m => m.id === r.body.default)?.id || clean[0].id, models: clean, free_open: r.body.free_open !== false, unit: r.body.unit === UNIT ? UNIT : null, signup: Number(r.body.signup_tokens) > 0 ? Number(r.body.signup_tokens) : null, signup_days: Number(r.body.signup_days) > 0 ? Number(r.body.signup_days) : null, buy_url: typeof r.body.buy_url === 'string' ? r.body.buy_url.slice(0, 300) : null, at: new Date().toISOString() };
    saveState({ models });
    return models;
  } catch { return freeState().models || null; }
}
// 送多少：中转 /models 说的（新单位才算；只用来算「不到 10%」，界面上不写）；不知道按 400 万算。
const giftTokens = st => (st.models?.unit === UNIT && st.models?.signup > 0 ? st.models.signup : 4000000);
// 兑换记录：10-03 以前记的是「补给 / 点」，按 1 点 = 1000 token 换过来显示（和中转换旧余额同一个比例）。
const redemptionsOf = st => (st.redemptions || []).slice(-20).reverse().map(r => ({ ...r, tokens: r.tokens != null ? r.tokens : Math.round((Number(r.points) || 0) * 1000) }));
// 文字模型现在用的是不是补给（清单第一个）：导航栏的 ⚡ 只在这时显示；用自己的 API、本机运行时就不显示。
export function freeInUse() {
  try { return textChain()[0]?.provider === FREE_PROVIDER; } catch { return false; } // 兜底：算不出清单就当没在用补给，只是导航栏不显示 ⚡
}
// 补给的每个模型走哪种接口（中转 /models 说的）：成员各选各的模型时，按模型走，不按供应商那一个 wire_api。
export function freeWire(model) {
  try { const m = (freeState().models?.models || []).find(x => x.id === model); return m?.wire || null; } catch { return null; } // 兜底：没有模型清单就按供应商的接口走
}
// 文字模型清单里用的是补给的哪个模型（没用就是中转的默认）。
export function currentFreeModel() {
  try { const b = textChain().find(x => x.provider === FREE_PROVIDER); if (b) return b.model; } catch {} // 兜底：算不出清单就用中转的默认模型（下一行）
  return freeState().models?.default || null;
}

// 领令牌（第一次选 OfferCrew 补给，或者第一次兑换码）。purpose: 'redeem' = 内测名额满了也要一个令牌去兑换（不带赠送的补给）。
// 回 { token, quota } 或 { error, reason, status }。
async function register({ purpose = 'free', now = Date.now() } = {}) {
  let r;
  try { r = await relay('/register', { method: 'POST', body: purpose === 'redeem' ? { purpose } : {} }); } catch { return { error: 'unreachable', reason: UNREACHABLE }; }
  if (!r.ok || typeof r.body.token !== 'string' || !/^oc_[0-9a-f]{64}$/.test(r.body.token)) {
    if (r.body?.error === 'beta_full') { saveState({ beta_full_at: new Date(now).toISOString() }); await refreshModels(); return { error: 'beta_full', reason: BETA_FULL }; }
    const reason = String(r.body?.reason || (r.status === 429 ? '今天领取补给的次数到上限了，明天再试，或者先用自己的 API key。' : UNREACHABLE)).slice(0, 200);
    return { error: r.status === 429 ? 'register_limited' : r.status === 503 ? (r.body?.error === 'not_configured' ? 'not_configured' : 'off') : 'relay_error', reason };
  }
  const token = r.body.token;
  fs.mkdirSync(file('private/providers'), { recursive: true, mode: 0o700 });
  write(FREE_AUTH, { provider: FREE_PROVIDER, base_url: relayBase(), auth_token: token, wire_api: 'chat' });
  fs.chmodSync(file(FREE_AUTH), 0o600);
  const at = new Date(now).toISOString(), quota = quotaOf(r.body.quota || {}, at);
  saveState({ quota, blocked: null, registered_at: at, install_id: /^i_[0-9a-f]{12}$/.test(r.body.install_id || '') ? r.body.install_id : null, ...(r.body.free === false ? {} : { beta_full_at: null }) });
  return { token, quota };
}

// ── 领补给（POST /api/model/free { action: 'start' } 的补给这一半）──────────────────
// 领令牌（或者核一遍已有的）、接上供应商 offercrew。换不换文字模型、对话默认不在这里：那是「设置 → 模型」的事，
// 在 lib/model-choice.mjs startFreeModel（10-05 拆开：以前这里自己改设置，补给模块引了设置和对话，model 那一块成了环）。
// 回 { model, providers, quota }，用不了回 { status: 409, body: { error, reason } }。
// model：换一个中转允许的、更强的模型（界面上显示它的价钱）；不写就用中转说的默认。
export async function claimFree({ model = null, now = Date.now() } = {}) {
  const no = (error, reason) => ({ status: 409, body: { error, reason } });
  if (offline()) return no('sandbox', SANDBOX_REASON);
  if (!relayBase()) return no('not_configured', OFF_REASON);
  // 10-03：要登录才能用补给（试用跟着账户，不跟着电脑）。界面上没登录只给「登录」（web/model-settings.js、web/onboarding.js）；
  // 这里不拦：老安装照旧，等中转的 ACCOUNT_REQUIRED 打开，安装令牌一律回 401 login_required（noteRelayResponse 记成「要登录」）。
  let token = tokenOf(), quota = null;
  if (token) {
    const r = await refreshQuota({ now, force: true });
    if (r.error === 'login') return no('login_required', freeBlocked({ now })?.reason || LOGIN_EXPIRED);
    if (r.error === 'bad_token') token = null;
    else if (r.error === 'unreachable') return no('unreachable', UNREACHABLE);
    else quota = r.quota || null;
  }
  if (!token) {
    const r = await register({ now });
    if (r.error) return no(r.error, r.reason);
    ({ token, quota } = r);
  } else {
    // 已经领过：地址可能换过（fork、测试），跟着当前的走。
    const a = read(FREE_AUTH, {});
    if (a.base_url !== relayBase()) { write(FREE_AUTH, { ...a, base_url: relayBase() }); fs.chmodSync(file(FREE_AUTH), 0o600); }
  }
  const c = await connectFree({ model });
  if (c.error) return no(c.error, c.reason);
  saveState({ enabled_at: freeState().enabled_at || new Date(now).toISOString() });
  return { ...c, quota };
}
// 供应商 offercrew 接上中转允许的模型（目录里加上它、跟着模型定接口）。回 { model, providers } 或 { error, reason }。
export async function connectFree({ model = null } = {}) {
  const list = await refreshModels();
  if (!list?.models?.length) return { error: 'unreachable', reason: UNREACHABLE };
  const ids = list.models.map(m => m.id);
  if (model != null && !ids.includes(String(model))) return { error: 'model_not_allowed', reason: `OfferCrew 补给只能用这些模型：${ids.join('、')}` };
  const pick = model != null ? String(model) : list.default;
  // 走哪种接口（chat / responses）跟着这个模型：中转的 GET /models 说了算。
  const wire = list.models.find(m => m.id === pick)?.wire || 'chat';
  const auth = read(FREE_AUTH, {});
  if (auth.wire_api !== wire) { write(FREE_AUTH, { ...auth, wire_api: wire }); fs.chmodSync(file(FREE_AUTH), 0o600); }
  return { model: pick, providers: ensureProvider(loadProviders(), ids, wire, list.models) };
}

// ── 兑换码（POST /api/model/free { action: 'redeem', code } 的补给这一半）─────────────
// 先在本机核格式和校验位（输错一位当场说，不去中转）；还没有令牌就先领一个（内测名额满了也行，只是不带赠送的补给）；
// 兑换成功把新余额记下、清掉「用完了」。回 { status, body, wire }：wire = 第一次用到补给，要接上供应商 offercrew
// （接上、换不换默认在 lib/model-choice.mjs redeemFreeCode）。
export async function redeemCode({ code, now = Date.now() } = {}) {
  const no = (status, error, reason) => ({ status, body: { error, reason } });
  const n = normalizeCode(code);
  if (!n.ok) return no(400, n.error === 'empty' ? 'empty' : 'bad_format', CODE_REASON[n.error]);
  if (offline()) return no(409, 'sandbox', SANDBOX_REASON);
  if (!relayBase()) return no(409, 'not_configured', OFF_REASON);
  let token = tokenOf(), fresh = false;
  if (!token) {
    const r = await register({ purpose: 'redeem', now });
    if (r.error) return no(409, r.error, r.reason);
    token = r.token; fresh = true;
  }
  let r;
  try { r = await relay('/redeem', { method: 'POST', token, body: { code: n.code } }); } catch { return no(409, 'unreachable', UNREACHABLE); }
  if (r.status === 401) { noteRelayResponse(401, r.headers, r.text, { now }); return no(409, 'bad_token', BAD_TOKEN); }
  if (!r.ok) return no(r.status === 429 ? 429 : r.status >= 500 ? 409 : 400, String(r.body.error || 'refused'), String(r.body.reason || CODE_REASON[r.body.error] || '兑换没成功').slice(0, 200));
  const quota = applyQuota(r.body.quota || {}, now), pts = Math.round(Number(r.body.tokens) || 0), kind = r.body.kind === 'paid' ? 'paid' : 'free';
  if (!r.body.already) {
    const list = [...(freeState().redemptions || []), { at: new Date(now).toISOString(), code: maskCode(n.code), tokens: pts, kind }].slice(-50);
    saveState({ redemptions: list });
    event('user', 'free-model', 'ok', `兑换码加了 ${tokenText(pts)} ${UNIT}（${balanceLabel(quota, now)}）`);
  }
  const label = balanceLabel(quota, now);
  return { status: 200, wire: fresh || !freeEnabled(), body: { ok: true, already: !!r.body.already, tokens: pts, kind, balance_label: label, remaining_label: remainingLabel(quota, now), text_model: false, receipt: r.body.already ? `这张码已经在这台电脑上兑过了，${label}` : `加了 ${tokenText(pts)} ${UNIT}，${label}` } };
}

// 目录里加上供应商 offercrew（已经有就更新地址和标签）。
// list：中转 /models 的模型（带 label、note）：设置里每位成员选模型时，选项写「OfferCrew 补给 · GPT-6 Sol · 更快、更省」。
export function ensureProvider(providers = loadProviders(), models = [], wire = 'chat', list = []) {
  const cur = providers[FREE_PROVIDER] || {};
  const notes = Object.fromEntries((list || []).filter(m => m.note).map(m => [m.id, m.note]));
  providers[FREE_PROVIDER] = { ...cur, label: FREE_LABEL, kind: 'openai_http', auth_file: FREE_AUTH, models: [...new Set(models)], ...(Object.keys(notes).length ? { notes } : {}), efforts: [], wire_api: wire === 'responses' ? 'responses' : 'chat', user: true, free: true, created_at: cur.created_at || new Date().toISOString() };
  saveProviders(providers);
  return loadProviders();
}
// ── 账：「运行与用量」旁边显示剩多少（只读本机状态，不联网）─────────────────────
export function freeQuotaView({ now = Date.now() } = {}) {
  if (!freeEnabled()) return null;
  const s = freeState(), q = s.quota || null, blocked = freeBlocked({ now, state: s });
  return { label: remainingLabel(q, now) || '余额待查', balance_label: balanceLabel(q, now), free: q ? freeOf(q) : null, paid: q ? q.paid ?? 0 : null, redemptions: redemptionsOf(s), nav: navView(q, { gift: giftTokens(s), now, inUse: freeInUse() }), balance: q?.balance ?? null, expires_at: q?.expires_at || null, days_left: q?.expires_at ? daysLeft(q.expires_at, now) : null, at: q?.at || null, install_id: s.install_id || null, blocked: blocked ? { kind: blocked.kind, reason: blocked.reason, until: blocked.until } : null };
}
