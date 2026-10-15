// 内置操作员的模型客户端：默认沿用 Quill 的文字模型；显式 HTTP 配置保留图片能力。
//
// 两种协议就够覆盖几乎所有模型：
//   openai_http   OpenAI 兼容的 Chat Completions（或 Responses）：OpenAI、DeepSeek、通义千问兼容模式、
//                 vLLM、Ollama 的 /v1、OpenRouter……（写 openai_compat 也认，是同一个东西）
//   anthropic_http  Anthropic Messages：Claude 官方 API 或兼容网关
// 供应商按 lib/backends.mjs 的方式读：config/providers.json 里的「供应商/模型」+ private/*.auth.json
// 里的 base_url / auth_token。开源用户也可以不建目录，直接写 { kind, base_url, api_key(_env), model }，
// 本机 Ollama 连 key 都不用。每一步只要模型回一个 JSON 动作，所以解析要经得起各种模型的毛病：
// 代码块、前后废话、<think> 推理段、尾逗号、单引号。
import fs from 'node:fs';
import { read } from '../store.mjs';
import { resolveBackend, loadProviders, textBackendUsable } from '../backends.mjs';
import { backendsFor } from '../model.mjs';
import { modelConf } from '../text-conf.mjs';
import { recordUsage } from '../usage.mjs';
import { claudeMessage, takesSampling } from '../claude-api.mjs';

export const HTTP_OPERATOR_KINDS = ['openai_http', 'anthropic_http'];
const KIND_ALIAS = { openai_compat: 'openai_http', openai: 'openai_http', anthropic: 'anthropic_http' };

// 规范化成客户端要的描述：{ kind, base_url, api_key, model, wire_api, vision, label, ... }。
export function resolveOperatorModel(spec, { providers = null } = {}) {
  if (!spec) spec = { inherit: 'text', role: 'quill', vision: false };
  const s = typeof spec === 'string' ? { ref: spec } : { ...spec };
  if (s.inherit === 'text') {
    const registry = providers || loadProviders(), role = s.role || 'quill';
    const backends = backendsFor(modelConf('text', { providers: registry }), registry, { role, step: 'operator' });
    if (!backends.some(textBackendUsable)) throw Error('operator_model_missing：还没有配好文字模型，请在模型设置中选择并测试');
    return { kind: 'text_model', backends, role, model: backends[0].model, label: backends[0].id, inherited: true, vision: false, max_tokens: 1000, timeout_ms: 90000 };
  }
  const kind0 = KIND_ALIAS[s.kind] || s.kind;
  // 直接写地址：不经供应商目录。
  if (s.base_url) {
    if (!HTTP_OPERATOR_KINDS.includes(kind0 || 'openai_http')) throw Error(`operator_model_kind：不认识的协议 ${s.kind}（openai_compat / anthropic_http）`);
    if (!s.model) throw Error('operator_model_missing：直接配置时要写 model');
    const key = s.api_key || (s.api_key_env ? process.env[s.api_key_env] : '') || '';
    return { kind: kind0 || 'openai_http', base_url: String(s.base_url).replace(/\/+$/, ''), api_key: key, model: s.model, wire_api: s.wire_api || 'chat', vision: !!s.vision, json_mode: !!s.json_mode, label: s.label || `${s.model} · ${hostOf(s.base_url)}`, max_tokens: s.max_tokens || 800, timeout_ms: s.timeout_ms || 90000 };
  }
  const ref = s.ref || (s.provider && s.model ? `${s.provider}/${s.model}` : s.model);
  if (!ref) throw Error('operator_model_missing：没有配置内置操作员用的模型');
  const b = resolveBackend(ref, providers || loadProviders());
  if (['claude_code', 'codex_exec'].includes(b.kind)) {
    if (s.vision) throw Error('operator_model_vision：这个 CLI 文字接口读取网页文字；看图须明确配置支持图片的 HTTP 模型');
    return { kind: 'text_model', backends: [b], role: 'quill', model: b.model, label: b.id, inherited: false, vision: false, max_tokens: s.max_tokens || 1000, timeout_ms: s.timeout_ms || 90000 };
  }
  if (!HTTP_OPERATOR_KINDS.includes(b.kind)) throw Error(`operator_model_kind：不支持的模型驱动 ${b.kind}`);
  const auth = b.auth_file ? read(b.auth_file, null) : null;
  if (!auth?.base_url) throw Error(`operator_model_credentials：${b.provider} 缺凭据文件 ${b.auth_file || ''}`);
  return { kind: b.kind, base_url: String(auth.base_url).replace(/\/+$/, ''), api_key: auth.account_token || auth.auth_token || auth.api_key || '', model: b.model, wire_api: b.wire_api || auth.wire_api || 'chat', vision: !!s.vision, json_mode: !!s.json_mode, label: b.id, max_tokens: s.max_tokens || 800, timeout_ms: s.timeout_ms || 90000 };
}
const hostOf = u => { try { return new URL(u).host; } catch { return String(u || ''); } };
const imageData = img => (Buffer.isBuffer(img) ? img : fs.readFileSync(img)).toString('base64');
const mediaType = img => (typeof img === 'string' && /\.jpe?g$/i.test(img) ? 'image/jpeg' : 'image/png');

// messages: [{ role: 'user'|'assistant', text, image? }]；image 是截图路径或 Buffer，只有 vision 才带上。
export function buildRequest(m, { system, messages }) {
  const withImages = m.vision;
  if (m.kind === 'anthropic_http') {
    const base = m.base_url.replace(/\/v1$/, '');
    return { url: `${base}/v1/messages`, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(m.api_key ? { 'x-api-key': m.api_key, authorization: `Bearer ${m.api_key}` } : {}) }, body: { model: m.model, max_tokens: m.max_tokens, ...(takesSampling(m.model) ? { temperature: 0 } : {}), system, messages: messages.map(x => ({ role: x.role, content: [{ type: 'text', text: x.text }, ...(withImages && x.image ? [{ type: 'image', source: { type: 'base64', media_type: mediaType(x.image), data: imageData(x.image) } }] : [])] })) } };
  }
  const auth = m.api_key ? { authorization: `Bearer ${m.api_key}` } : {};
  if (m.wire_api === 'responses') {
    return { url: `${m.base_url}/responses`, headers: { 'content-type': 'application/json', ...auth }, body: { model: m.model, instructions: system, max_output_tokens: m.max_tokens, store: false, input: messages.map(x => ({ role: x.role, content: [{ type: x.role === 'assistant' ? 'output_text' : 'input_text', text: x.text }, ...(withImages && x.image && x.role === 'user' ? [{ type: 'input_image', image_url: `data:${mediaType(x.image)};base64,${imageData(x.image)}` }] : [])] })) } };
  }
  return { url: `${m.base_url}/chat/completions`, headers: { 'content-type': 'application/json', ...auth }, body: { model: m.model, temperature: 0, max_tokens: m.max_tokens, ...(m.json_mode ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: system }, ...messages.map(x => ({ role: x.role, content: withImages && x.image && x.role === 'user' ? [{ type: 'text', text: x.text }, { type: 'image_url', image_url: { url: `data:${mediaType(x.image)};base64,${imageData(x.image)}` } }] : x.text }))] } };
}
export function responseText(m, d) {
  if (m.kind === 'anthropic_http') return (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
  if (m.wire_api === 'responses') return d.output_text || (d.output || []).flatMap(o => o.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
  const c = d.choices?.[0]?.message?.content;
  return Array.isArray(c) ? c.map(x => x.text || '').join('') : String(c ?? '');
}
const usageOf = u => (u ? { input_tokens: u.input_tokens ?? u.prompt_tokens ?? null, output_tokens: u.output_tokens ?? u.completion_tokens ?? null } : null);

// { label, vision, complete({ system, messages }) → { text, usage, ms } }。429 / 5xx / 网络错误重试一次。
export function createModelClient(spec, { fetch: doFetch = globalThis.fetch, providers = null, retryDelayMs = 1500, completeFn = null } = {}) {
  const m = resolveOperatorModel(spec, { providers });
  if (m.kind === 'text_model') {
    const client = { label: m.label, vision: false, kind: m.kind, model: m.model, inherited: m.inherited,
      async complete({ system, messages, signal = null }) {
        const aborted = () => Object.assign(Error('operator_model_aborted'), { retryable: false });
        if (signal?.aborted) throw aborted();
        const complete = completeFn || (await import('../chat.mjs')).complete;
        const started = Date.now();
        let abort;
        const stopped = signal ? new Promise((_, reject) => { abort = () => reject(aborted()); signal.addEventListener('abort', abort, { once: true }); }) : null;
        const work = Promise.resolve().then(() => complete({ system, messages: messages.map(x => ({ role: x.role, content: String(x.text || '') })),
          config: { backends: m.backends, default: m.backends[0].id, max_tokens: m.max_tokens, timeout_ms: m.timeout_ms, codex_timeout_ms: m.timeout_ms, claude_timeout_ms: m.timeout_ms },
          meta: { member: m.role, step: 'operator' }, max_tokens: m.max_tokens }));
        try {
          const r = await (stopped ? Promise.race([work, stopped]) : work);
          if (signal?.aborted) throw aborted();
          if (r.broken || r.backend === 'sandbox' || !String(r.text || '').trim()) throw Error('operator_model_incomplete：模型没有返回完整回答');
          client.label = r.backend || m.label; client.model = r.reported_model || r.model || m.model;
          return { text: r.text, usage: r.usage || null, ms: Date.now() - started, model: client.model, backend: r.backend || null };
        } finally { if (abort) signal.removeEventListener('abort', abort); }
      } };
    return client;
  }
  return {
    label: m.label, vision: m.vision, kind: m.kind, model: m.model,
    // signal：调用方的中止信号（整个任务到时限）；和每次请求自己的超时合在一起。
    async complete({ system, messages, signal = null }) {
      // Claude：官方 SDK（lib/claude-api.mjs），有代理走代理；一步只回一个小 JSON 动作，按 tiny（5.5 系列关思考、低 effort），
      // 型号收 temperature 才带 0。SDK 自己再试一次（429 / 5xx / 连不上），不在这里另外循环。
      if (m.kind === 'anthropic_http') return claudeStep(m, { system, messages, signal, doFetch: doFetch === globalThis.fetch ? null : doFetch });
      const req = buildRequest(m, { system, messages });
      let last;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw Object.assign(Error('operator_model_aborted'), { retryable: false });
        const started = Date.now();
        const stop = signal ? AbortSignal.any([AbortSignal.timeout(m.timeout_ms), signal]) : AbortSignal.timeout(m.timeout_ms);
        const r = await doFetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: stop }).catch(e => ({ ok: false, status: 0, text: async () => String(e.message) }));
        // 每一步的用量记进用量账（lib/usage.mjs）：内置操作员替 Reacher 填表，算它的。
        if (r.ok) { const d = await r.json(); recordUsage({ member: 'reacher', step: 'operator', backend: m.kind, provider: String(m.label || '').includes('/') ? String(m.label).split('/')[0] : null, model: d.model || m.model, requested_model: m.model, reported_model: d.model || null, usage: d.usage || null, duration_ms: Date.now() - started, status: 'ok' }); return { text: responseText(m, d), usage: usageOf(d.usage), ms: Date.now() - started }; }
        const body = await r.text().catch(() => ''); // 兜底：错误的正文读不出就只报状态码
        last = Object.assign(Error(`operator_model_http_${r.status}: ${m.label} ${String(body).slice(0, 160)}`), { status: r.status, retryable: !signal?.aborted && (r.status === 0 || r.status === 429 || r.status >= 500) });
        if (!last.retryable || attempt) throw last;
        await new Promise(res => setTimeout(res, retryDelayMs));
      }
      throw last;
    },
  };
}

async function claudeStep(m, { system, messages, signal, doFetch }) {
  if (signal?.aborted) throw Object.assign(Error('operator_model_aborted'), { retryable: false });
  const body = buildRequest(m, { system, messages }).body.messages;
  const started = Date.now(), stop = signal ? AbortSignal.any([AbortSignal.timeout(m.timeout_ms), signal]) : AbortSignal.timeout(m.timeout_ms);
  try {
    const r = await claudeMessage({ auth: { base_url: m.base_url, auth_token: m.api_key }, model: m.model, system, messages: body, job: 'tiny', max_tokens: m.max_tokens, timeout_ms: m.timeout_ms, signal: stop, maxRetries: 1, temperature: 0, ...(doFetch ? { fetch: doFetch } : {}) });
    recordUsage({ member: 'reacher', step: 'operator', backend: m.kind, provider: String(m.label || '').includes('/') ? String(m.label).split('/')[0] : null, model: r.model || m.model, requested_model: m.model, reported_model: r.reported_model || null, usage: r.usage || null, duration_ms: Date.now() - started, status: 'ok' });
    return { text: r.text, usage: usageOf(r.usage), ms: Date.now() - started };
  } catch (e) {
    if (signal?.aborted) throw Object.assign(Error('operator_model_aborted'), { retryable: false });
    throw Object.assign(Error(`operator_model_http_${e.status || 0}: ${m.label} ${String(e.message || '').slice(0, 160)}`), { status: e.status || 0, retryable: !!e.retryable });
  }
}

// ── 从模型回复里取一个 JSON 对象 ──────────────────────────────────────────────────────────
// 顺序：去掉 <think> 段 → 优先 ```json 代码块 → 从左到右找第一个配平的 {…}（字符串里的括号不算）→
// 解析不了就修一下（尾逗号、注释、单引号、Python 的 True/False/None）再试。
function balancedEnd(s, i) {
  let depth = 0, quote = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
function repairJson(raw) {
  let out = '', quote = null;
  for (let j = 0; j < raw.length; j++) {
    const c = raw[j];
    if (quote) {
      if (c === '\\') { const n = raw[j + 1]; out += quote === "'" && n === "'" ? "'" : c + (n ?? ''); j++; continue; }
      if (c === quote) { quote = null; out += '"'; continue; }
      out += quote === "'" && c === '"' ? '\\"' : c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += '"'; continue; }
    if (c === '/' && raw[j + 1] === '/') { while (j < raw.length && raw[j] !== '\n') j++; continue; }
    if (c === '/' && raw[j + 1] === '*') { const e = raw.indexOf('*/', j + 2); j = e === -1 ? raw.length : e + 1; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
}
// 兜底：不是 JSON 就修一下再试；还不行就是 undefined，调用方照实说模型回的格式不对
const tryParse = raw => { try { return JSON.parse(raw); } catch {} try { return JSON.parse(repairJson(raw)); } catch {} return undefined; };
function firstObject(s) {
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    const end = balancedEnd(s, i);
    const v = tryParse(end === -1 ? s.slice(i) + '}' : s.slice(i, end + 1));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return undefined;
}
export function extractJson(text) {
  const s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
  const fences = [...s.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const c of [...fences, s]) { const v = firstObject(c); if (v !== undefined) return v; }
  // 整段是数组：取第一个对象。
  const arr = tryParse(s.trim());
  if (Array.isArray(arr) && arr[0] && typeof arr[0] === 'object') return arr[0];
  throw Error('model_no_json');
}
const ALIAS = { type: 'fill', input: 'fill', enter: 'fill', enter_text: 'fill', type_text: 'fill', write: 'fill', choose: 'select', select_option: 'select', pick: 'select', tick: 'check', toggle: 'check', uncheck: 'check', navigate: 'goto', open: 'goto', go: 'goto', visit: 'goto', key: 'press', keypress: 'press', press_key: 'press', finish: 'done', complete: 'done', stop: 'done', ask_user: 'need_user', handoff: 'need_user', need_human: 'need_user', user: 'need_user', error: 'fail', abort: 'fail', give_up: 'fail', upload_file: 'upload', attach: 'upload', sleep: 'wait', tap: 'click', press_button: 'click' };
// 一个模型回复 → 规范动作 { action, id, value, reason }。认各种写法：id 写成 "[12]"、"e12"、element_id，
// 值写成 text / option / url / key / path / checked，动作包在 { action: { type, … } } 里。
export function parseAction(text) {
  let o = extractJson(text);
  if (Array.isArray(o.actions) && o.actions[0]) o = { ...o.actions[0] };
  if (o.action && typeof o.action === 'object') { const inner = o.action; o = { ...o, ...inner }; if (typeof o.action === 'object') o.action = inner.type ?? inner.name ?? null; }
  const name0 = String(o.action ?? o.type ?? o.name ?? o.tool ?? o.command ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const action = ALIAS[name0] || name0;
  if (!action) throw Error('model_no_action');
  const rawId = o.id ?? o.element ?? o.element_id ?? o.elementId ?? o.ref ?? o.index ?? o.target;
  const m = rawId == null ? null : String(rawId).match(/\d+/);
  const id = m ? Number(m[0]) : null;
  let value = o.value ?? o.text ?? o.option ?? o.url ?? o.key ?? o.path ?? o.file ?? o.direction ?? o.checked ?? null;
  if (name0 === 'uncheck' && value == null) value = false;
  return { action, id, value, reason: String(o.reason ?? o.thought ?? o.why ?? '').slice(0, 300) };
}
