// Claude（Anthropic Messages 接口）的唯一出口：官方 SDK @anthropic-ai/sdk，不再手写 fetch。
//
// 谁用：lib/model.mjs（结构化的活：判断、读信、改简历、写信……）、lib/chat.mjs（对话、起标题）、lib/operator/models.mjs（内置操作员）、
// lib/backends.mjs（探测模型清单）。供应商是 anthropic_http 的都走这里：你自己的 Anthropic key（api.anthropic.com），或兼容的网关。
//
// 网络：这台电脑直连 api.anthropic.com 会被挡（403，地区限制），和发信一样有代理就走代理（lib/ats/http.mjs proxyFor：
// HTTPS_PROXY / ALL_PROXY，再看 macOS 系统代理里开着的 HTTPS 代理；本机地址和 NO_PROXY 直连）。从启动台打开的 App 拿不到
// 终端里的代理变量，靠的就是系统代理。http(s) 代理走 undici 的 ProxyAgent，socks5 走 Socks5ProxyAgent。没有代理就用全局 fetch。
//
// 每个型号的规矩（claude-api 技能，2026-10）——不按规矩发会 400：
//   claude-haiku-5-5   思考默认开；effort 不高于 high 时可以 { type: 'disabled' }
//   claude-sonnet-5-5  { type: 'disabled' } 报 400；关思考用 { type: 'between_tools' }（effort 不高于 high、不能带别的字段）
//   claude-opus-5-5    思考关不掉，只能调 effort（默认 medium）
//   三个都不收 temperature / top_p，不支持 assistant 预填、强制 tool_choice。思考占 max_tokens，要留够，不然 JSON 被截断。
//   stop_reason 是 refusal：当失败（model_refused），不换别的模型（负责人定过不设后备模型，不开 fallbacks）。
// 认不出的型号（网关上的旧型号、别家起的名字）照旧：不带思考和 effort，只发 model / max_tokens / system / messages。
import Anthropic from '@anthropic-ai/sdk';
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent } from 'undici';
import { proxyFor } from './ats/http.mjs';

export const CLAUDE_MODELS = { light: 'claude-haiku-5-5', write: 'claude-sonnet-5-5', best: 'claude-opus-5-5' };
const bare = m => String(m || '').trim().replace(/^.*\//, '').toLowerCase();
// 型号的家族：'haiku-5-5' | 'sonnet-5-5' | 'opus-5-5' | 'modern'（4.6 以后、5 系列，收结构化输出、不收采样参数）| 'legacy'
export function claudeFamily(model) {
  const m = bare(model);
  const own = /^claude-(haiku|sonnet|opus)-5-5(?:$|[-@])/.exec(m);
  if (own) return `${own[1]}-5-5`;
  if (/^claude-(?:fable|mythos)-5|^claude-opus-5(?:$|[-@])|^claude-sonnet-5(?:$|[-@])|^claude-opus-4-[678]|^claude-sonnet-4-6|^claude-haiku-4-5/.test(m)) return 'modern';
  return 'legacy';
}
// 收不收 temperature / top_p（不收的发了就 400）。
export const takesSampling = model => !/^claude-(?:haiku-5|sonnet-5|opus-5|opus-4-[78]|fable|mythos)/.test(bare(model));
// 收不收结构化输出（output_config.format）。
const STRUCTURED = /^claude-(?:haiku-5-5|sonnet-5-5|opus-5-5|fable-5|mythos-5|opus-5|opus-4-8|sonnet-5|haiku-4-5)/;
export const takesStructured = model => STRUCTURED.test(bare(model));

// ── 一次调用发什么 ───────────────────────────────────────────────────────────
// job：'tiny'（起标题、读信分类这类一两句话的）| 'structured'（判断、评估、讲原因：要 JSON、要想一想）
//      | 'write'（改简历、写信、调研、怎么准备：长、要写好）| 'chat'（对话那一轮）
// 返回 { thinking?, output_config?, max_tokens }；stream：这次是不是流式（非流式的输出上限不超过 16000，SDK 的 10 分钟估算）。
const EFFORT = { tiny: 'low', chat: 'low', structured: 'medium', write: 'medium' };
const ROOM = { stream: 32000, plain: 16000, chat: 8000 };
export function requestShape(model, { job = 'structured', max_tokens = 4000, stream = false } = {}) {
  const fam = claudeFamily(model), asked = Math.max(1, Number(max_tokens) || 4000), effort = EFFORT[job] || 'medium';
  const room = n => Math.max(asked, job === 'chat' ? Math.min(n, ROOM.chat) : n);
  if (fam === 'haiku-5-5') {
    if (job === 'tiny') return { thinking: { type: 'disabled' }, output_config: { effort: 'low' }, max_tokens: asked };
    return { thinking: { type: 'adaptive' }, output_config: { effort }, max_tokens: room(stream ? ROOM.stream : ROOM.plain) };
  }
  if (fam === 'sonnet-5-5') {
    // between_tools 不能带别的字段；effort 放在 output_config 里（不高于 high）。
    if (job === 'tiny') return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' }, max_tokens: asked };
    return { thinking: { type: 'adaptive' }, output_config: { effort }, max_tokens: room(stream ? ROOM.stream : ROOM.plain) };
  }
  if (fam === 'opus-5-5') return { output_config: { effort }, max_tokens: job === 'tiny' ? Math.max(asked, 2000) : room(stream ? ROOM.stream : ROOM.plain) };
  return { max_tokens: asked };
}

// ── 结构化输出：把调用方的 JSON Schema 收拾成接口收的那一种 ─────────────────────────
// 不收：数值 / 字符串长度的限制、复杂的数组限制、additionalProperties 不是 false、递归。收拾掉的那些限制照旧写在提示词里
// （调用方把整份 schema 附在提示词后面），回来以后调用方自己校验。收拾不了（additionalProperties 是个 schema、没有 type 的对象……）
// 就返回 null：这次不用结构化输出，照旧靠提示词要 JSON。
const DROP = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', '$schema', 'title', 'default', 'examples'];
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);
export function strictSchema(schema) {
  let ok = true;
  const walk = (s, depth) => {
    if (!ok || depth > 24 || !s || typeof s !== 'object' || Array.isArray(s)) { if (depth > 24) ok = false; return s; }
    const o = {};
    for (const [k, v] of Object.entries(s)) {
      if (DROP.includes(k)) continue;
      if (k === 'minItems') { if (Number(v) <= 1) o.minItems = v; continue; }
      if (k === 'format') { if (FORMATS.has(v)) o.format = v; continue; }
      if (k === 'properties' && v && typeof v === 'object') o.properties = Object.fromEntries(Object.entries(v).map(([p, x]) => [p, walk(x, depth + 1)]));
      else if (['items', 'not'].includes(k)) o[k] = walk(v, depth + 1);
      else if (['anyOf', 'allOf', 'oneOf'].includes(k) && Array.isArray(v)) o[k === 'oneOf' ? 'anyOf' : k] = v.map(x => walk(x, depth + 1));
      else if (['$defs', 'definitions'].includes(k) && v && typeof v === 'object') o[k] = Object.fromEntries(Object.entries(v).map(([p, x]) => [p, walk(x, depth + 1)]));
      else o[k] = v;
    }
    const isObj = o.type === 'object' || (Array.isArray(o.type) && o.type.includes('object')) || o.properties;
    if (isObj) {
      if (o.additionalProperties !== undefined && o.additionalProperties !== false) ok = false;
      if (!o.properties) ok = false; // 键随意的对象（字典）收拾不了
      o.additionalProperties = false;
    }
    return o;
  };
  const out = walk(schema, 0);
  return ok && out && typeof out === 'object' ? out : null;
}

// ── 客户端：每份凭据 + 出口一个，复用连接 ─────────────────────────────────────────
const isOfficial = base => { try { return /(^|\.)anthropic\.com$/i.test(new URL(base).hostname); } catch { return false; } }; // 兜底：地址写得不对就当不是
const agents = new Map();
function dispatcherFor(proxy) {
  if (!agents.has(proxy)) agents.set(proxy, /^socks/i.test(proxy) ? new Socks5ProxyAgent(proxy.replace(/^socks5h:/i, 'socks5:')) : new ProxyAgent(proxy));
  return agents.get(proxy);
}
// 这一跳走哪个代理（没有就 null）：和招聘站接口同一个判断。
// 测试里不走这台机器的代理（开发机上常年开着，测试的假地址经代理就连到外面去了）。
export const claudeProxy = url => { if (process.env.NODE_TEST_CONTEXT) return null; try { return proxyFor(url); } catch { return null; } }; // 兜底：读不出代理设置就当没有，直连
// 给 SDK 的 fetch：有代理就用 undici 带代理发，没有就用全局 fetch（测试里替换的也是它）。
function proxiedFetch(url, init) {
  const proxy = claudeProxy(String(url));
  if (!proxy) return globalThis.fetch(url, init);
  return undiciFetch(url, { ...init, dispatcher: dispatcherFor(proxy) });
}
const clients = new Map();
// auth：凭据文件的内容（base_url、auth_token / api_key）。官方地址只带 x-api-key；兼容网关两种头都带（和以前手写 fetch 时一样）。
// apiKey、authToken 都明写：SDK 不再去读这台电脑上的 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant 登录。
export function claudeClient(auth, { maxRetries = 2, fetch: own = null } = {}) {
  const token = String(auth?.auth_token || auth?.api_key || '').trim();
  if (!token) throw Error('claude_api_credentials_missing');
  const base = String(auth.base_url || 'https://api.anthropic.com').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  // 调用方自己给的 fetch（测试里的假 fetch）：不缓存，也不走代理。
  if (own) return new Anthropic({ apiKey: token, authToken: isOfficial(base) ? null : token, baseURL: base, maxRetries, fetch: own });
  const key = `${base}\n${token}\n${maxRetries}`;
  if (!clients.has(key)) {
    if (clients.size > 16) clients.clear();
    clients.set(key, new Anthropic({ apiKey: token, authToken: isOfficial(base) ? null : token, baseURL: base, maxRetries, fetch: proxiedFetch }));
  }
  return clients.get(key);
}

// ── 出错：变成这个产品认得的那几种说法（lib/say-error.mjs、lib/system/breaker.mjs）──────────
// claude_api_<状态码>: <型号> <对方说的>  —— 401 钥匙、429 额度 / 限流、404 型号不存在、5xx 对方出错；retryable 照以前：0、404、429、5xx。
// claude_api_region —— 直连被挡（403 forbidden「Request not allowed」）：这台电脑所在的地区要开代理（不写 403 和 forbidden，不当成钥匙坏了）。
// claude_api_proxy —— 代理连不上。claude_api_timeout —— 到点了。model_refused —— 模型拒绝回答这一件。
export function claudeError(e, { model = '', base = '' } = {}) {
  if (e?.claude) return e;
  const tag = x => Object.assign(x, { claude: true });
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError || e?.name === 'AbortError' || e?.name === 'TimeoutError') return tag(Object.assign(Error(`claude_api_timeout: ${model} 没按时回答`), { retryable: true }));
  if (e instanceof Anthropic.APIConnectionError) {
    const proxy = claudeProxy(base || 'https://api.anthropic.com/'), cause = e.cause?.code || e.cause?.cause?.code || e.cause?.message || '';
    if (proxy) return tag(Object.assign(Error(`claude_api_proxy: 代理 ${proxyHost(proxy)} 连不上（${String(cause).slice(0, 60)}）`), { retryable: true }));
    return tag(Object.assign(Error(`claude_api_0: ${model} fetch failed${cause ? ` (${String(cause).slice(0, 60)})` : ''}`), { retryable: true }));
  }
  if (e instanceof Anthropic.APIError && e.status) {
    const body = e.error || {}, inner = body.error || body, type = String(inner.type || ''), said = String(inner.message || e.message || '').replace(/\s+/g, ' ').slice(0, 160);
    if (e.status === 403 && type === 'forbidden' && /not allowed/i.test(said)) return tag(Object.assign(Error(`claude_api_region: 这台电脑所在的地区连不上 Anthropic（${claudeProxy(base || 'https://api.anthropic.com/') ? '代理节点所在的地区也不行，换一个节点' : '要开代理'}）`), { retryable: false, region: true }));
    const out = Error(`claude_api_${e.status}: ${model} ${type ? `${type} ` : ''}${said}`.trim());
    out.retryable = e.status >= 500 || e.status === 404 || e.status === 429 || e.status === 408 || e.status === 409;
    out.status = e.status; out.api_type = type;
    return tag(out);
  }
  return e instanceof Error ? e : Error(String(e));
}
const proxyHost = p => { try { const u = new URL(p); return `${u.hostname}:${u.port}`; } catch { return '本机代理'; } }; // 兜底：地址写得不对就当不是
// 400 是不是因为结构化输出（schema 不收、这个网关不认 output_config）：是的话同一个型号不带它再问一次。
const formatRejected = e => e?.status === 400 && /output_config|output_format|json_schema|schema|format/i.test(String(e.message || ''));
// 400 是不是因为思考 / effort 参数（网关上的型号不认）：是的话不带它们再问一次。
const shapeRejected = e => e?.status === 400 && /thinking|effort|between_tools|adaptive/i.test(String(e.message || ''));

export function refusalError(msg) {
  const cat = msg?.stop_details?.category ? String(msg.stop_details.category).replace(/[^a-z_]/gi, '').slice(0, 30) : '';
  return Object.assign(Error(`model_refused: 模型这次拒绝回答这件事${cat ? `（${cat}）` : ''}`), { retryable: false, refused: true, claude: true });
}

// ── 一次调用 ─────────────────────────────────────────────────────────────────
// auth：凭据（base_url、auth_token）；model：型号；system：字符串或 content block 数组；messages：Messages 接口的 messages。
// schema：要 JSON 时的 JSON Schema（收得下就用结构化输出）；job / max_tokens：见 requestShape。
// stream：流式（长活、对话）；onText(delta)：边到边交出去（对话面板）。timeout_ms：这次最多等多久（含 SDK 自己的重试）。
// signal：调用方自己的中止信号（对话那一轮按「两块之间最多等多久」计时，onEvent 每到一块重新计时）；不给就按 timeout_ms。
// cache：true 时在 system 的最后一块打缓存点（稳定的系统提示），并让接口自动缓存到最后一块（多轮对话下一轮读得到）。
// temperature：只在这个型号收、又没开思考时才带（5.5 系列不收，带了就 400）。fetch：测试里的假 fetch。
// → { text, stop_reason, cut, usage（接口原样）, model, partial? }。refusal 抛 model_refused。
// 流式中途断了：一个字没出就抛错（retryable）；出过字的，keepPartial 时带着已收到的回去（partial: true, error）。
export async function claudeMessage({ auth, model, system = null, messages, schema = null, job = 'structured', max_tokens = 4000, stream = false, onText = null, timeout_ms = 120000, cache = false, keepPartial = false, maxRetries = 2, signal: outer = null, onEvent = null, temperature = null, fetch = null }) {
  const client = claudeClient(auth, { maxRetries, fetch }), base = String(auth?.base_url || '');
  const modern = claudeFamily(model) !== 'legacy';
  let shape = requestShape(model, { job, max_tokens, stream });
  let format = schema && takesStructured(model) ? strictSchema(schema) : null;
  const sys = system == null ? undefined : typeof system === 'string'
    ? (cache && modern ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system)
    : system;
  const signal = outer || AbortSignal.timeout(Math.max(1000, Number(timeout_ms) || 120000));
  const body = () => ({
    model, max_tokens: shape.max_tokens, messages,
    ...(sys !== undefined ? { system: sys } : {}),
    ...(shape.thinking ? { thinking: shape.thinking } : {}),
    ...(shape.output_config || format ? { output_config: { ...(shape.output_config || {}), ...(format ? { format: { type: 'json_schema', schema: format } } : {}) } } : {}),
    ...(cache && modern ? { cache_control: { type: 'ephemeral' } } : {}),
    ...(temperature != null && takesSampling(model) && !shape.thinking ? { temperature } : {}),
  });
  for (let round = 0; ; round++) {
    let text = '';
    try {
      let msg;
      if (stream) {
        const s = client.messages.stream(body(), { signal, timeout: Math.max(1000, Number(timeout_ms) || 120000) });
        if (onEvent) s.on('streamEvent', () => { try { onEvent(); } catch {} }); // 兜底：只是重新计时，出错不影响回答
        s.on('text', d => { text += d; if (onText && d) try { onText(d); } catch {} }); // 兜底：听的那头（页面）断了不影响回答本身
        msg = await s.finalMessage();
      } else msg = await client.messages.create(body(), { signal, timeout: Math.max(1000, Number(timeout_ms) || 120000) });
      if (msg.stop_reason === 'refusal') throw refusalError(msg);
      const out = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return { text: out, stop_reason: msg.stop_reason, cut: msg.stop_reason === 'max_tokens', usage: msg.usage || null, model: msg.model || model, reported_model: msg.model || null };
    } catch (raw) {
      let e = signal.aborted && !raw?.claude ? Object.assign(Error(`claude_api_timeout: ${model} 没按时回答`), { retryable: true, claude: true }) : claudeError(raw, { model, base });
      // 流读到一半出的、SDK 没归类的错（连接断了、流里报错）：这一次失败、可以再试（lib/say-error.mjs 认 stream_cut）。
      if (stream && !e.claude && !e.refused) e = Object.assign(Error(`stream_cut: ${String(raw?.message || 'ended early').slice(0, 120)}`), { retryable: true, claude: true });
      // 同一个型号少带一样再问一次（各一次）：结构化输出不收 → 不带 format；思考参数不认 → 不带思考和 effort。
      if (round < 2 && !text && format && formatRejected(e)) { format = null; continue; }
      if (round < 2 && !text && (shape.thinking || shape.output_config) && shapeRejected(e)) { shape = { max_tokens: Math.min(shape.max_tokens, 16000) }; continue; }
      if (text && keepPartial && !e.refused) return { text, stop_reason: null, cut: false, usage: null, model, reported_model: null, partial: true, error: Object.assign(e, { retryable: true }) };
      throw e;
    }
  }
}

// 目录里「探测模型」：GET /v1/models（SDK 自动翻页）。
export async function claudeModelList(auth) {
  const client = claudeClient(auth, { maxRetries: 1 }), out = [];
  try { for await (const m of client.models.list({ limit: 100 }, { timeout: 20000 })) { out.push(m.id); if (out.length > 10000) throw Error('模型目录分页尚未读完；请稍后刷新'); } }
  catch (e) { throw claudeError(e, { base: auth?.base_url }); }
  return out;
}
