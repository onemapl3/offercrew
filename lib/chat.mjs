import { RELAY_USER_AGENT } from './relay-diagnostic.mjs';
// 和系统角色对话。
//
// 一个会话 = state/chat/<id>.json。每一轮把当前系统状态（按角色裁剪）、提到的岗位简报
// 和最近对话一起交给模型，模型以该角色口吻回答；它可以在结尾附一行 ACTIONS（指挥室
// 指令，网页上变成按钮，走 dispatchCommand 的同一套确认）或 HANDOFF（需要浏览器 /
// 长时间工作的事，交给团队任务，进度和结果沿同一任务回到对话）。
// 模型在这里永远只是"说"，任何发送、提交仍然只经字面的「发 N」「投 N」。
//
// 底座在 config/chat.json 的 backends 里：Claude 走网关（anthropic_http），GPT 走本机
// `codex exec`（codex_exec，供应商 = ~/.codex/config.toml 里的 id 或内置 openai）。
import { tallyLines } from './tally.mjs';
import { OPS, opFor } from './ops-table.mjs';
import { BRAND } from './brand.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from './spawn.mjs';
import { file, read, write, lines, hash, today } from './store.mjs';
import { PERSONAS } from './personas.mjs';
import { jobBrief } from './job-brief.mjs';
import { localAiContext, LOCAL_AI_INDEPENDENT } from './local-ai-status.mjs';
import { CLAUDE_TEXT_ARGS, codexTextArgs, codexHomeOf, claudeTextDir, cliModel, claudeResult, codexProviderArgs, sandboxCodexEnv, sandboxTextOrder } from './text-cli.mjs';
import { recordUsage } from './usage.mjs';
import { claudeMessage } from './claude-api.mjs';
import { FREE_PROVIDER, fetchRelay, freeBlocked, blockedError, relayFailure, noteRelayResponse, noteRelayTrailer, freeRelayBase, freeWire, BLOCK_TITLE, bearerOf, whatHeader } from './free-model.mjs';
import { modelDoing } from './model.mjs';
import { event } from './events.mjs';
import { sandboxed, sandboxModels, sandboxSkip, modelCall } from './sandbox.mjs';
import { normalizeChatConfig, backendLabel, resolveBackend, providerEnv, loadProviders, catalog as providerCatalog, textBackendUsable, dropUnpickedLocal } from './backends.mjs';
import { recall, renderNotes, addNote, parseRememberCommand, parseRememberLines } from './memory.mjs';
import { roleChatBackend, ROLES, roleStepBackends } from './roles.mjs';
import { ownerLabel } from './facts.mjs';
import { primaryCity } from './city.mjs';
import { memberName, memberDuty, memberId, voiceOf, MEMBER_IDS } from './members.mjs';
import { LEGACY, isMember, crewName, crewOf } from './crew.mjs';
import { errorReason } from './say-error.mjs';
import { noteFallback, whyKind, dayOf } from './fallback.mjs';
import { ruleTitle, shownTitle, readCardsLite } from './chat-title.mjs';
import { defaultFreeRef } from './text-conf.mjs';
import { readSse, isSse } from './sse.mjs';
import { leadApplyWords } from './apply-words.mjs';
import { noteSwallowed } from './swallow.mjs';
import { stageText, feedbackText } from './lead-state.mjs';
import { deniesOutbound, outboundAsk, resolveCommand, isQuestion, computerNeed } from './intent.mjs';
import { localTime, localTimes, relativeDay, relativeDates, dayOf as localDay, TZ } from './tz.mjs';

export const CHAT_DIR = 'state/chat';
export const CHAT_CONFIG = 'config/chat.json';
export const REPLIES_PATH = 'state/web-replies.ndjson';
const iso = x => new Date(x).toISOString();
const leadKey = l => l.record_id || l.id;

export function chatConfig() {
  const m = read('config/model.json', {});
  // 没写对话设置（或写了却既没有清单、也没有 models、也没写 driver）：走默认链（lib/text-conf.mjs，领过补给就是补给，否则没有），
  // 不再当作 Claude 网关 claude-fable-5-1（兜底清单复核 A08）。写了旧的 driver 的照旧。
  const saved = read(CHAT_CONFIG, null), own = saved && ((Array.isArray(saved.backends) && saved.backends.length) || Array.isArray(saved.models) || saved.driver);
  const free = own ? null : defaultFreeRef(), ref = free ? `${free.provider}/${free.model}` : null;
  const raw = own ? saved : { ...(saved || {}), backends: free ? [free] : [], models: [], default: ref };
  const c = normalizeChatConfig(raw, m.text?.models || ['claude-fable-5-1']);
  return { auth_file: m.text?.auth_file || 'private/claude-api.auth.json', max_tokens: 1600, timeout_ms: 90000, codex_timeout_ms: 180000, history: 16, context_chars: 26000, ...c };
}
// 给网页的底座清单：可选、当前默认、每个能不能用（凭据 / 供应商是否存在）。
export function chatBackends(config = chatConfig()) {
  const providers = loadProviders();
  const note = r => r.kind === 'anthropic_http' ? `Anthropic 兼容 API · 按 token 计费` : r.kind === 'openai_http' ? `OpenAI 兼容 API（${r.wire_api || 'chat'}）· 按 token 计费` : r.kind === 'claude_code' ? `claude -p · 占 Claude 订阅额度 · 约 5–10 秒` : `codex exec · 每轮固定开销约 3 万 token · ${r.codex_provider === 'openai' ? '占 ChatGPT 订阅额度' : '按 token 计费'} · 约 30–60 秒`;
  return {
    default: config.default,
    // 对话页的角色还是老的四个（radar / watch / reacher / system），成员编号也给一份：各自按 lib/roles.mjs 的沿用规则取。
    persona_defaults: Object.fromEntries([...Object.keys(PERSONAS), ...ROLES].map(r => [r, roleChatBackend(r, providers)])),
    backends: config.backends.map(b => { try { const r = resolveBackend(b, providers); return { ...b, label: backendLabel(b, providers), kind: r.kind, available: true, note: note(r) }; } catch (e) { return { ...b, label: b.label || b.id, kind: null, available: false, note: e.message }; } }),
    providers: providerCatalog(providers),
  };
}
let driver = null;
export function setChatDriver(fn) { driver = fn; }
// 现在有没有能用的对话模型（右侧面板那一行「现在没有能用的模型」、talkTurn 要不要调模型都看它）：
//   sandbox     演示 / 沙盒模式不调模型（算作没有）
//   no_backend  清单里一个能解析的底座都没有（没配凭据 / 供应商）
//   failing     最近 10 分钟里上一轮调模型失败了（还会再试：成功一次就恢复）
// 只看本机的配置和上一轮的结果，不为了探测去调模型。
let lastFail = null, backendsAt = 0, backendsOk = true;
// 和设置 → 模型同一个判断（lib/backends.mjs textBackendUsable：凭据、登录状态），解析不了的算不能用；补给被中转拒着也不算。
// 问的是解析过的那一条（chatOrder 的结果，F05）：清单里的一项只有 provider / model，凭据文件（auth_file）、登录目录在供应商目录里；
// 拿没解析的去问，就当成没有凭据：接上了补给（或自己的 API key），对话栏、任务页还说「没有能用的模型」。
const usableChat = r => { try { return textBackendUsable(r) && !(r.provider === FREE_PROVIDER && freeBlocked()); } catch { return false; } }; // 兜底：凭据解析不了的算不能用（上面的注释），设置 → 模型那里会照实显示
// 按清单走时的顺序：默认的在前，其余照清单；解析不了的跳过。清单里有补给时，排在它后面、你没选过的本机 Claude Code / Codex 拿掉
// （lib/backends.mjs dropUnpickedLocal，10-02 负责人：补给用完以后不悄悄换成本机的 Codex）。
function chatOrder(config, providers = loadProviders(), { strict = true } = {}) {
  return dropUnpickedLocal([...config.backends.filter(b => b.id === config.default), ...config.backends.filter(b => b.id !== config.default)].flatMap(b => { try { return [resolveBackend(b, providers)]; } catch (e) { if (strict && !e.unknown_provider) throw e; return []; } }));
}
let blockedNote = null;
export function modelState({ now = Date.now(), config = null } = {}) {
  if (driver) return { ok: true };
  if (sandboxed() && !sandboxModels()) return { ok: false, why: 'sandbox', note: '演示 / 沙盒模式不调用模型' };
  if (config || now - backendsAt > 5000) { try { const providers = loadProviders(); backendsOk = chatOrder(config || chatConfig(), providers, { strict: false }).some(usableChat); } catch (e) { noteSwallowed('chat.modelState', e, { doing: '读对话模型的配置', then: '先当没有能用的对话模型' }); backendsOk = false; } let blk = null; try { blk = !backendsOk && chatOrder(config || chatConfig(), loadProviders(), { strict: false }).some(b => b.provider === FREE_PROVIDER) ? freeBlocked() : null; } catch {} blockedNote = blk ? `${BLOCK_TITLE[blk.kind] || ''}${blk.reason && blk.reason !== BLOCK_TITLE[blk.kind] ? `：${blk.reason}` : ''}` : null; backendsAt = now; } // 兜底：第二个 try 只是想说清补给为什么被拒；读不出来就只说「还没有配好对话模型」，配置读坏已在上一句记过
  if (!backendsOk) return { ok: false, why: 'no_backend', note: blockedNote || '还没有配好对话模型' };
  if (lastFail && now - lastFail.at < 10 * 60e3) return { ok: false, why: 'failing', note: `上一轮没调通：${errorReason(lastFail.msg)}` };
  return { ok: true };
}

// ── 边生成边显示（10-03 L 线）─────────────────────────────────────────────────
// 传了 onDelta 的（对话面板那一轮）：HTTP 底座带 stream: true，一边读 SSE 一边把新到的字交给 onDelta。
//   读完了（chat 的 [DONE] / finish_reason，responses 的 response.completed，Anthropic 的 message_stop）：和整段返回的一样。
//   一个字还没出就断了、出错了：照旧抛错（retryable），complete 换下一个底座。
//   出过字以后断了：不抛错，带着已经收到的那部分回去（broken: true），不重试、不换模型；花了多少照中转那边按已到的部分算。
// 补给（中转）的余额在流的最后一行注释里（`: offercrew {...}`，lib/free-model.mjs noteRelayTrailer）。
// codex exec、claude -p 不流：照旧整段返回。
function deadline(ms) {
  const ctl = new AbortController(), limit = Number(ms) || 90000;
  let timer = null, fired = false;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { fired = true; ctl.abort(); }, limit); };
  arm();
  return { signal: ctl.signal, arm, stop: () => clearTimeout(timer), get fired() { return fired; } };
}
// 读 SSE：lib/sse.mjs readSse（长活 lib/model.mjs 也用它）。每到一块重新计时（两块之间最多等 timeout_ms）。
// 读完一段流以后：读完了 → 回答；没出字 → 抛错（换下一个）；出过字 → broken。
// ended：上游没说完就结束了（补给结尾行的 broken: upstream_ended），说「模型那边没说完就停了」；别的断法是 network（连接断了）或 timeout。
function streamResult(out, { finished, failed, err, clock, ended = false }) {
  if (finished && !failed && !err) return out;
  const timeout = clock.fired;
  const e = Object.assign(Error(failed ? `stream_failed: ${String(failed).slice(0, 160)}` : timeout ? 'stream_timeout' : ended ? 'stream_ended: upstream_ended' : `stream_cut: ${String(err?.message || 'ended early').slice(0, 120)}`), { retryable: true });
  if (!out.text) throw e;
  return { ...out, broken: true, cut: { kind: timeout ? 'timeout' : ended ? 'ended' : 'network', error: e } };
}

// Claude（你自己的 Anthropic key、兼容网关）：官方 SDK（lib/claude-api.mjs），有代理走代理。稳定的系统提示打缓存点，多轮对话下一轮读缓存。
// 起标题这类一两句话的（step title、输出上限很小）按 tiny：5.5 系列关掉思考，免得思考吃掉那几十个 token 的上限。
async function anthropicComplete({ system, messages, backend, config, max_tokens, onDelta = null, step = 'chat' }) {
  const c = read(backend.auth_file || config.auth_file || 'private/claude-api.auth.json');
  if (!c?.auth_token) throw Error('claude_api_credentials_missing');
  const started = Date.now(), live = typeof onDelta === 'function', clock = live ? deadline(config.timeout_ms) : null;
  const asked = max_tokens || config.max_tokens || 1600, job = step === 'title' || asked <= 200 ? 'tiny' : 'chat';
  let r;
  try {
    r = await claudeMessage({ auth: c, model: backend.model, system, messages, job, max_tokens: asked, stream: live, onText: live ? onDelta : null, timeout_ms: Number(config.timeout_ms) || 90000, cache: job === 'chat', keepPartial: live, ...(live ? { signal: clock.signal, onEvent: () => clock.arm() } : {}) });
  } finally { clock?.stop(); }
  const usage = r.usage ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens } : null;
  const out = { text: String(r.text || '').trim(), model: backend.model, backend: backend.id, reported_model: r.reported_model || null, usage, raw_usage: r.usage || null, duration_ms: Date.now() - started };
  if (r.partial) return { ...out, broken: true, cut: { kind: clock?.fired || /timeout/.test(r.error?.message || '') ? 'timeout' : 'network', error: r.error } };
  return out;
}
// OpenAI 兼容 HTTP：chat/completions 或 responses，凭据来自该供应商的 auth 文件。
const usageOf = u => (u ? { input_tokens: u.input_tokens ?? u.prompt_tokens ?? null, output_tokens: u.output_tokens ?? u.completion_tokens ?? null } : null);
// 你自己配的兼容服务不认 stream_options（一个字没出就 400，错里说到 stream）：同一个底座去掉它再试一次（模型不变，不算换模型），
// 记一笔 noteFallback（from 和 to 都是它）；这一天里这个底座就不再带（skipOpts）。拿不到 usage 的，用量记成未知（no_usage），不估。
// 补给（中转）认 stream_options，不走这一步。
const skipOpts = new Map();
async function openaiComplete({ system, messages, backend, config, max_tokens, onDelta = null, member = null, step = 'chat', retryRelay = true }) {
  // OfferCrew 补给（lib/free-model.mjs）：被中转拒着就直接换下一个底座；回答的响应头带回花了多少补给、还剩多少。
  const free = backend.provider === FREE_PROVIDER, blk = free ? freeBlocked() : null;
  if (blk) throw blockedError(blk);
  const c = read(backend.auth_file), key = bearerOf(c);
  if (!key) throw Error('openai_api_credentials_missing');
  const base = String(free ? freeRelayBase(c.base_url) : c.base_url || '').replace(/\/$/, ''), wire = backend.model_wire || (free && freeWire(backend.model)) || backend.wire_api || c.wire_api || 'chat', started = Date.now();
  const live = typeof onDelta === 'function', clock = live ? deadline(config.timeout_ms) : null;
  const body = wire === 'responses'
    ? { model: backend.model, instructions: system, input: messages.map(m => ({ role: m.role, content: m.content })), max_output_tokens: max_tokens || config.max_tokens || 1600, store: false, ...(backend.effort ? { reasoning: { effort: backend.effort } } : {}) }
    : { model: backend.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: max_tokens || config.max_tokens || 1600 };
  // 流式：chat 接口要最后一块带上 usage（stream_options），responses 接口的 usage 在 response.completed 里。
  const day = dayOf(Date.now());
  if (live) { body.stream = true; if (wire !== 'responses' && (free || skipOpts.get(backend.id) !== day)) body.stream_options = { include_usage: true }; }
  const signal = live ? clock.signal : AbortSignal.timeout(Number(config.timeout_ms) || 90000);
  const send = () => fetch(base + (wire === 'responses' ? '/responses' : '/chat/completions'), { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(free ? { ...whatHeader(modelDoing({ step })), 'user-agent': RELAY_USER_AGENT } : {}) }, body: JSON.stringify(body), signal }).catch(e => ({ ok: false, status: 0, text: async () => String(e.message) }));
  let r;
  try { r = free ? await fetchRelay(send, { signal, allowRetry: retryRelay, request: body, secrets: [key] }) : await send(); }
  catch (e) { clock?.stop(); throw e; }
  if (!r.ok && r.status === 400 && body.stream_options && !free) {
    const said = await r.text().catch(() => ''); // 兜底：错误的正文读不出来就按空的判断
    if (/stream/i.test(said)) {
      delete body.stream_options; skipOpts.set(backend.id, day);
      let label = backend.id; try { label = backendLabel(backend, loadProviders()); } catch {} // 兜底：拿不到名字就用底座 id
      try { noteFallback({ kind: 'chat', from: backend.id, to: backend.id, why: Error(`stream_options_unsupported: ${said.slice(0, 120)}`), member, from_label: label, to_label: `${label}（不带 stream_options）` }); } catch {} // 兜底：noteFallback 自己会吞写账的错；这里只防参数出错挡住重试
      clock.arm(); r = await send();
    } else { const h = r.headers; r = { ok: false, status: 400, headers: h, text: async () => said }; }
  }
  if (!r.ok) { clock?.stop(); const body = await r.text().catch(() => ''); const said = free ? relayFailure(r.status, r.headers, body) : null; if (said) throw said; const e = Error(`openai_api_${r.status}: ${backend.id} ${body.slice(0, 160)}`); e.retryable = r.status === 0 || r.status >= 500 || r.status === 404 || r.status === 429; throw e; } // 兜底：错误的正文读不出来就只报状态码
  if (live && isSse(r)) {
    let text = '', usage = null, finished = false, failed = null, err = null, trailer = null, reportedModel = null;
    const piece = d => { if (typeof d !== 'string' || !d) return; text += d; try { onDelta(d); } catch {} }; // 兜底：听的那头（页面）断了不影响回答本身
    try {
      await readSse(r, {
        clock,
        onComment: x => { if (!free) return; const m = /^offercrew\s+(\{.*\})\s*$/.exec(x); if (m) try { trailer = JSON.parse(m[1]); } catch (e) { noteSwallowed('chat.relayTrailer', e, { doing: '读补给回答末尾的说明（实际是哪个模型答的）', then: '这次按请求的模型记' }); } },
        onEvent: ({ event: t0, data }) => {
          if (data.trim() === '[DONE]') { finished = true; return; }
          let o; try { o = JSON.parse(data); } catch { return; } // 兜底：一行不是 JSON（心跳、注释）就跳过
          if (typeof (o.response?.model || o.model) === 'string') reportedModel = o.response?.model || o.model;
          if (wire === 'responses') {
            const t = o.type || t0;
            if (t === 'response.output_text.delta') piece(o.delta);
            else if (t === 'response.completed' || t === 'response.incomplete') { finished = true; if (o.response?.usage) usage = o.response.usage; }
            else if (t === 'response.failed' || t === 'error') failed = o.response?.error?.message || o.error?.message || o.message || t;
            return;
          }
          if (o.error) failed = o.error.message || o.error.type || 'error';
          const ch = o.choices?.[0];
          piece(ch?.delta?.content);
          if (ch?.finish_reason) finished = true;
          if (o.usage) usage = o.usage;
        },
      });
    } catch (e) { err = e; }
    // 补给：用最后那行注释记余额（没收到那一行，就只照响应头记是谁答的）。
    const relay = free ? (trailer ? noteRelayTrailer(trailer, { requested: backend.model }) : noteRelayResponse(r.status, r.headers, '', { requested: backend.model })) : null, credits = relay?.cost ?? null;
    // 补给（兜底复核 N03）：中转在上游断了的时候也写结尾行、正常关闭，所以只认结尾行的 complete === true 算说完了；
    // complete 是 false、没有这个字段、没收到这一行，都算断了。broken: upstream_ended 是「模型那边没说完就停了」，别的是「连接断了」。
    if (free) { const done = trailer?.complete === true; finished = done; if (done) { failed = null; err = null; } }
    const ended = free && trailer?.complete === false && trailer.broken === 'upstream_ended';
    return streamResult({ text: text.trim(), model: backend.id, backend: backend.id, usage: usageOf(usage), raw_usage: usage || null, duration_ms: Date.now() - started, ...(credits != null ? { credits } : {}), ...((relay?.served || reportedModel) ? { reported_model: relay?.served || reportedModel } : {}) }, { finished, failed, err, clock, ended });
  }
  const relay = free ? noteRelayResponse(r.status, r.headers, '', { requested: backend.model }) : null, credits = relay?.cost ?? null;
  const d = await r.json();
  clock?.stop();
  const text = wire === 'responses' ? (d.output_text || (d.output || []).flatMap(o => o.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('')) : (d.choices?.[0]?.message?.content ?? '');
  const out = { text: String(text || '').trim(), model: backend.id, backend: backend.id, usage: usageOf(d.usage), raw_usage: d.usage || null, duration_ms: Date.now() - started, ...(credits != null ? { credits } : {}), ...((relay?.served || d.model) ? { reported_model: relay?.served || d.model } : {}) };
  // 上游没有流回来（比如中转那边接口不同、整段返回了）：整段当一块给出去。
  if (live && out.text) try { onDelta(out.text); } catch {} // 兜底：听的那头（页面）断了不影响回答本身
  return out;
}
// GPT 经 codex exec：一次性、只读沙箱、临时目录，把 system + 对话拼成一段提示词。
export function codexPrompt(system, messages) {
  const transcript = messages.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n\n');
  return `${system}\n\n---\n下面是到目前为止的对话。你是「助手」。请只输出你这一轮的回复正文（可以在最后附 ACTIONS / HANDOFF 行），不要复述对话、不要加前缀、不要使用任何工具、不要读写文件。\n\n${transcript}\n\n助手：`;
}
export function codexComplete({ system, messages, backend, config }) {
  return new Promise((resolve, reject) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-chat-')), output = path.join(work, 'reply.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work, '--json', '--output-last-message', output];
    // 沙盒里供应商钉在官方 openai（lib/text-cli.mjs）。
    const pinned = sandboxed();
    args.push(...codexProviderArgs(backend, pinned));
    if (backend.effort) args.push('-c', `model_reasoning_effort=${backend.effort}`);
    if (cliModel(backend.model)) args.push('--model', cliModel(backend.model));
    args.push(...codexTextArgs(codexHomeOf(backend)), '-');
    const started = Date.now(), limit = Number(config.codex_timeout_ms) || 180000;
    const child = spawn(process.env.RADAR_CODEX_BIN || 'codex', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: pinned ? sandboxCodexEnv(providerEnv(backend)) : providerEnv(backend) });
    let usage = null, buffer = '', errText = '', jsonError = '', timedOut = false, failed = false;
    const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, limit); // 兜底：进程已经退了就不用再杀
    child.stdout.on('data', chunk => { buffer += chunk.toString(); const rows = buffer.split('\n'); buffer = rows.pop(); for (const row of rows) { try { const e = JSON.parse(row); if (e.usage) usage = e.usage; if (e.type === 'error' && typeof e.message === 'string') jsonError = e.message; } catch {} } if (buffer.length > 1024 * 1024) buffer = ''; }); // 兜底：一行不是 JSON（进度输出）就跳过
    child.stderr.on('data', chunk => { errText = (errText + chunk.toString()).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { failed = true; clearTimeout(timer); cleanup(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) return;
      try {
        if (timedOut) throw Error(`codex_timeout_${Math.round(limit / 1000)}s`);
        if (code !== 0) { const e = Error(`codex_exit_${code}: ${[errText, jsonError].filter(Boolean).join('\n').slice(-300)}`); e.retryable = !/provider .* not found/i.test(errText); throw e; }
        const text = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim() : '';
        if (!text) throw Error('codex_empty_reply');
        resolve({ text, model: backend.id, backend: backend.id, usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : null, raw_usage: usage, duration_ms: Date.now() - started });
      } catch (e) { reject(e); } finally { cleanup(); }
    });
    child.stdin.end(codexPrompt(system, messages));
  });
}
// Claude 官方订阅：本机 claude -p，一轮、无工具；登录目录来自目录（默认 ~/.claude）。
export function claudeCodeComplete({ system, messages, backend, config }) {
  return new Promise((resolve, reject) => {
    // 对话也只是说话：没有工具、没有 MCP、不读设置和钩子、不留会话，在空目录里跑（lib/text-cli.mjs）。
    // JSON 输出带回用量（lib/text-cli.mjs claudeResult），回答正文照旧。
    const args = ['-p', '--output-format', 'json', '--max-turns', '1', ...CLAUDE_TEXT_ARGS];
    if (cliModel(backend.model)) args.push('--model', cliModel(backend.model));
    if (backend.effort) args.push('--effort', backend.effort);
    const started = Date.now(), limit = Number(config.claude_timeout_ms) || 120000;
    const dir = claudeTextDir(), cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const child = spawn(process.env.RADAR_CLAUDE_BIN || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: providerEnv(backend), cwd: dir });
    child.on('close', cleanup); child.on('error', cleanup);
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, limit); // 兜底：进程已经退了就不用再杀
    child.stdout.on('data', c => { out += c.toString(); });
    child.stderr.on('data', c => { err = (err + c.toString()).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (timedOut) { const e = Error(`claude_code_timeout_${Math.round(limit / 1000)}s`); e.retryable = true; throw e; }
        if (code !== 0) { const e = Error(`claude_code_exit_${code}: ${err.slice(-300)}`); e.retryable = true; throw e; }
        const r = claudeResult(out), text = r.text.trim();
        if (!text) throw Error('claude_code_empty_reply');
        resolve({ text, model: backend.id, backend: backend.id, usage: r.usage ? { input_tokens: (r.usage.inputTokens ?? r.usage.input_tokens ?? 0) + (r.usage.cacheReadInputTokens ?? r.usage.cache_read_input_tokens ?? 0) + (r.usage.cacheCreationInputTokens ?? r.usage.cache_creation_input_tokens ?? 0), output_tokens: r.usage.outputTokens ?? r.usage.output_tokens ?? 0 } : null, raw_usage: r.usage, reported_model: r.model, duration_ms: Date.now() - started });
      } catch (e) { reject(e); }
    });
    child.stdin.end(codexPrompt(system, messages));
  });
}
// 一次补全。指定了 backend 就只用它；没指定从默认开始，网关类错误换下一个。
// meta：{ member, step } 记进用量账（lib/usage.mjs）；对话页传当前角色，设置页的「测」是 system · test。
// onDelta：边生成边显示（对话面板那一轮）：新到的字一块一块交给它。一旦出过字就不再换底座；中途断了回 broken（见上面「边生成边显示」）。
export async function complete({ system, messages, backend = null, model = null, config = chatConfig(), max_tokens = null, meta = {}, onDelta = null } = {}) {
  if (driver) return driver({ system, messages, backend, model, config, ...(onDelta ? { onDelta } : {}) });
  // 演示 / 沙盒模式：不调模型（对话内容不出本机），回一句说明，会话照常记下（lib/sandbox.mjs）。
  // 开了 RADAR_SANDBOX_MODELS=1：照常调，Codex 的供应商钉在官方 openai（lib/text-cli.mjs sandboxTextOrder）。
  const sbx = sandboxed();
  if (sbx && !sandboxModels()) { sandboxSkip('对话模型调用', { actor: 'user' }); return { text: '（演示 / 沙盒模式：这里不调用模型，所以没有真实回复。你的消息已记下。）', model: 'sandbox', backend: 'sandbox', usage: null, duration_ms: 0 }; }
  const providers = loadProviders();
  const wanted = backend || model;
  let chosen = wanted ? config.backends.find(b => b.id === wanted || b.model === wanted) : null;
  // 清单里没有但目录里认得的引用（如 openai/gpt-5.5）也允许临时点名。
  if (wanted && !chosen) { try { chosen = resolveBackend(wanted, providers); } catch { throw Error(`没有这个底座：${wanted}`); } }
  // 点名的底座解析不了就报错；按清单走时跳过供应商不在目录里的项（设置页和指挥台会告警）。
  // 某位成员给这一步单独配了模型（lib/roles.mjs steps，例如 System 起标题用 Haiku）：没点名底座时先用它。
  let step = null; try { step = !chosen && meta.member && meta.step ? roleStepBackends(meta.member, meta.step, providers) : null; } catch {} // 兜底：读不出成员设置就照对话的清单
  let order = chosen ? [resolveBackend(chosen, providers)] : step ? dropUnpickedLocal(step) : chatOrder(config, providers);
  if (sbx) order = sandboxTextOrder(order);
  if (!order.length) throw Error('config/chat.json 没有可用的 backends');
  // 失败过的（兜底清单 A02）：每一次的原因类别进用量账；换下一个时记一笔「换了」（lib/fallback.mjs）；回复上带 fallback_from。
  let last; const failures = [];
  const label = b => { try { return backendLabel(b, providers); } catch { return b.id; } };
  // 出过字了（spoke）：后面再出什么错也不换底座。
  let spoke = false;
  const live = typeof onDelta === 'function' ? d => { if (String(d).trim()) spoke = true; onDelta(d); } : null;
  for (const b of order) {
    const started = Date.now();
    try {
      const r = await modelCall(() => b.kind === 'codex_exec' ? codexComplete({ system, messages, backend: b, config }) : b.kind === 'claude_code' ? claudeCodeComplete({ system, messages, backend: b, config }) : b.kind === 'openai_http' ? openaiComplete({ system, messages, backend: b, config, max_tokens, onDelta: live, member: meta.member ? crewOf(meta.member) : null, step: meta.step || 'chat', retryRelay: b.provider === FREE_PROVIDER && !order.slice(order.indexOf(b) + 1).some(usableChat) }) : anthropicComplete({ system, messages, backend: b, config, max_tokens, onDelta: live, step: meta.step || 'chat' }));
      // 中途断了：已经收到的那部分照样记账（中转按它扣了），记成没成、原因类别是断在哪（network / timeout）。
      recordUsage({ member: meta.member || 'system', step: meta.step || 'chat', ...(meta.what ? { what: meta.what } : {}), backend: b.kind, provider: b.provider, codex_provider: b.codex_provider, model: r.reported_model || cliModel(b.model) || b.model, requested_model: b.model, reported_model: r.reported_model || null, usage: r.raw_usage || r.usage, ...(r.credits != null ? { credits: r.credits } : {}), duration_ms: r.duration_ms ?? Date.now() - started, status: r.broken ? 'failed' : 'ok', ...(r.broken ? { why_kind: r.cut.kind } : {}), ...(failures.length ? { fallback_from: failures.at(-1).backend } : {}) });
      return failures.length ? { ...r, fallback_from: failures, fallback_to: label(b) } : r; // fallback_to：接着答的那个（页面写「由 Y 回答（X 没调通）」）
    }
    catch (e) {
      const w = whyKind(e);
      recordUsage({ member: meta.member || 'system', step: meta.step || 'chat', ...(meta.what ? { what: meta.what } : {}), backend: b.kind, provider: b.provider, codex_provider: b.codex_provider, model: cliModel(b.model) || b.model, duration_ms: Date.now() - started, status: 'failed', why_kind: w.kind });
      last = e;
      if (chosen || spoke || !e.retryable || b === order.at(-1)) throw e;
      failures.push({ backend: b.id, label: label(b), why_kind: w.kind });
      const next = order[order.indexOf(b) + 1];
      try { noteFallback({ kind: 'chat', from: b.id, to: next.id, why: e, member: meta.member ? crewOf(meta.member) : null, from_label: label(b), to_label: label(next) }); } catch {} // 兜底：noteFallback 自己会吞写账的错；这里只防参数出错挡住换下一个
    }
  }
  throw last || Error('no_backend');
}

// ── 会话存储 ──────────────────────────────────────────────────────────────────
const sessionPath = id => `${CHAT_DIR}/${id}.json`;
export const validId = id => /^[a-z0-9]{8,32}$/.test(String(id || ''));
export const newSessionId = () => crypto.randomBytes(8).toString('hex');
export const sessionExists = id => validId(id) && fs.existsSync(file(sessionPath(id)));
// 同一个会话可能有几路同时在写（浮层刚记下一条指令的回执，这一轮对话的模型还没回来；执行器的回复在并进来）：
// 写之前把磁盘上多出来的消息并进来，交接的标记只增不减——谁也不覆盖谁。
const msgKey = m => m.id || m.reply_key || hash([m.role, m.at, m.content]).slice(0, 16);
// drop：这一路有意拿掉的几条（挪进了另一件活自己的对话，lib/talk.mjs），磁盘上的不再并回来。
// 这段对话属于哪件活（task、asked_in、origin）、你看过到哪（seen_at）也只增不减：手上那份没有、磁盘上有的照磁盘的。
export function saveSession(s, { drop = null } = {}) {
  const disk = read(sessionPath(s.id), null);
  if (disk) {
    for (const k of ['task', 'asked_in', 'origin', 'routine']) if (disk[k] && !s[k]) s[k] = disk[k];
    if (disk.seen_at && !(String(s.seen_at || '') >= disk.seen_at)) s.seen_at = disk.seen_at;
  }
  if (disk?.messages?.length) {
    const mine = new Map((s.messages || []).map(m => [msgKey(m), m]));
    let added = false;
    for (const m of disk.messages) {
      if (drop?.has(msgKey(m))) continue;
      const cur = mine.get(msgKey(m));
      if (!cur) { s.messages.push(m); added = true; continue; }
      if (m.handoff && cur.handoff) for (const k of ['dispatched', 'message_id', 'dispatched_at', 'answered_at', 'withdrawn_at']) if (m.handoff[k] && !cur.handoff[k]) cur.handoff[k] = m.handoff[k];
    }
    if (added) s.messages.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    if (disk.title && disk.title !== '新对话' && s.title === '新对话') s.title = disk.title;
    // 模型起的、你改的标题不被这一路手上的旧标题（规则取的）盖掉（lib/chat-title.mjs）。
    const rank = { model: 1, task: 2, you: 3 }; // 一件活的对话用活的标题（task），只有你改的盖得过它
    if ((rank[disk.title_by] || 0) > (rank[s.title_by] || 0)) { s.title = disk.title; s.title_by = disk.title_by; }
  }
  write(sessionPath(s.id), s);
  for (const fn of savedHooks) try { fn(s); } catch (e) { console.error(`[chat] 存对话之后的记账出错：${e.message}`); }
  return s;
}
// 存完一段对话之后要做的事（lib/task-writer.mjs：Writer 的消息变了，把卡的那件活记到它现在的样子）。chat 不认得任务，只管调。
const savedHooks = new Set();
export const onSessionSaved = fn => { savedHooks.add(fn); };
// 会话里说过的话（你说的、成员回的、执行器回报的），给面板的会话切换搜（标题搜不到时也能按内容找到）。只留最近的 4000 字。
const sessionText = s => (s.messages || []).filter(m => ['user', 'assistant', 'executor'].includes(m.role)).map(m => String(m.content || '').replace(/\s+/g, ' ')).join(' \n ').slice(-4000);
// 会话里回过话的成员（按第一次出场排；老的单人会话那位排最前）：对话历史每一行的小头像。
export function sessionCrew(s) {
  const out = [];
  const add = k => { const id = memberId(k); if (id && !out.includes(id)) out.push(id); };
  if (s?.member) add(s.member);
  for (const m of s?.messages || []) { if (['assistant', 'executor'].includes(m.role)) add(m.persona); if (m.kind === 'relay') { add(m.from); add(m.to); } }
  return out;
}
// 你说的第一句（标题还是「新对话」时，对话历史用它当标题）。
const firstSaid = s => { const t = String((s?.messages || []).find(m => m.role === 'user')?.content || '').replace(/\s+/g, ' ').trim(); return t.length > 40 ? t.slice(0, 39) + '…' : t; };
// 任务专用的对话（T2 / T5 建的：id 由卡号定、不是从对话里起的活、定时周期的例行、旧卡迁移拼出来的）。任务卡片（L 线 10-03）以后
// 一件活是任务页里的一张卡，对话栏只放对话：这几种文件留着不删，但不进对话历史（列表、分页、搜都一样），也不当「手上那段」接着说。
// 被 T2 变成任务对话的普通聊天（里面有你自己打的字、id 不是卡号定的）不算，照普通聊天列。
export const taskSessionId = cardId => crypto.createHash('sha1').update(`task|${cardId}`).digest('hex').slice(0, 16);
export const taskOnly = s => !!s?.task && (s.id === taskSessionId(s.task) || !!s.origin || !!s.routine || !!s.migrated);
// 对话历史的一行（title 是显示用的标题，lib/chat-title.mjs shownTitle：老会话的网址标题读的时候改写，收录对上了换成公司和职位）。
// 行上不带任务（task）：对话就是对话，任务的状态在任务页上看。
const sessionRow = (s, ctx, { text = true } = {}) => ({ id: s.id, persona: s.persona, title: shownTitle(s, ctx), backend: s.backend || null, updated_at: s.updated_at, messages: (s.messages || []).length, ...(text ? { text: sessionText(s) } : {}), pending_handoffs: (s.messages || []).filter(m => m.handoff && m.handoff.dispatched && !m.handoff.answered_at).length, member: s.member || null, crew: sessionCrew(s), first: firstSaid(s), seen_at: s.seen_at || null, created_at: s.created_at || null });
const byNewest = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || String(b.id).localeCompare(String(a.id));
export function listSessions() {
  const dir = file(CHAT_DIR);
  if (!fs.existsSync(dir)) return [];
  const ctx = { cards: readCardsLite() };
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => read(`${CHAT_DIR}/${n}`, null)).filter(s => s && !taskOnly(s)).map(s => sessionRow(s, ctx)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
// 对话历史一页（GET /api/chat?limit=&before=&q=，电脑的切换器和手机的历史）：所有对话按最后说话的时间排成一列；任务专用的那几段（taskOnly）不列、也不搜。
//   limit   一页几段（默认 50，最多 200）
//   before  游标：上一页最后一行的「updated_at|id」（只给 updated_at 也行）；只要比它早的
//   q       搜标题、说过的每一句（不只最近那些）、回过话的成员的名字；搜到的是内容时 hit 是那句话前后一小段
// 空会话不列。→ { sessions, next }，next 是下一页的游标（没有了是 null）。
// 不为排序把所有文件全读一遍：先按文件修改时间排（每次写会话文件都会更新它，所以 updated_at 不会比它晚），
// 读到手上的已经够一页、下一个文件改得比这一页最晚的那段还早时就停。搜的时候要看内容，只能每个都读。
export function pageSessions({ limit = 50, before = null, q = '' } = {}) {
  const dir = file(CHAT_DIR), n = Math.max(1, Math.min(200, Number(limit) || 50));
  if (!fs.existsSync(dir)) return { sessions: [], next: null };
  const needle = String(q || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
  const cur = String(before || ''), bar = cur.lastIndexOf('|'), bu = bar >= 0 ? cur.slice(0, bar) : cur, bid = bar >= 0 ? cur.slice(bar + 1) : '';
  const older = s => !cur || String(s.updated_at || '') < bu || (String(s.updated_at || '') === bu && !!bid && String(s.id) < bid);
  const files = fs.readdirSync(dir).filter(x => x.endsWith('.json')).map(x => { let m = 0; try { m = fs.statSync(path.join(dir, x)).mtimeMs; } catch {} return { x, m }; }).sort((a, b) => b.m - a.m); // 兜底：文件刚被删了就排在最后
  const ctx = { cards: readCardsLite() }, got = [];
  for (const f of files) {
    // 已经有一页多一段了，而剩下的文件都改得比手上最早那段还早：它们排不进来
    if (!needle && got.length > n && f.m + 2000 < Date.parse(got[n].updated_at || 0)) break;
    const s = read(`${CHAT_DIR}/${f.x}`, null);
    if (!s?.id || taskOnly(s) || !(s.messages || []).length || (s.routine && !needle) || !older(s)) continue;
    let hit = '';
    if (needle) {
      const title = shownTitle(s, ctx), said = (s.messages || []).filter(m => ['user', 'assistant', 'executor'].includes(m.role)).map(m => String(m.content || '').replace(/\s+/g, ' ')).join(' \n ');
      const names = sessionCrew(s).map(memberName).join(' ');
      if (!`${title && title !== '新对话' ? title : firstSaid(s)} ${names}`.toLowerCase().includes(needle)) { const i = said.toLowerCase().indexOf(needle); if (i < 0) continue; hit = snippet(said, i, needle.length); }
    }
    const row = { ...sessionRow(s, ctx, { text: false }), ...(needle ? { hit } : {}) };
    // 按时间插进去，手上只留一页多一段
    let i = got.findIndex(r => byNewest(row, r) < 0); if (i < 0) i = got.length;
    got.splice(i, 0, row); if (got.length > n + 1) got.length = n + 1;
  }
  const page = got.slice(0, n), last = page.at(-1);
  return { sessions: page, next: got.length > n && last ? `${last.updated_at || ''}|${last.id}` : null };
}
const snippet = (t, i, len) => { const a = Math.max(0, i - 12), b = Math.min(t.length, i + len + 24); return `${a ? '…' : ''}${t.slice(a, b).replace(/\s*\n\s*/g, ' ').trim().replace(/^[。，,.!?！？、；;：:]+\s*/, '')}${b < t.length ? '…' : ''}`; };
// id：浮层先定好会话 id 再下指令（执行器的回复要认得回到哪个会话），指令执行完才建会话。
// member：和一位成员单独说的会话（面板上点了那位）；不给就是「团队」，由前台 Desk 分给对的成员。
export function newSession({ persona = 'radar', backend = null, now = Date.now(), id = null, member = null } = {}) {
  if (id !== null && !validId(id)) throw Error('无效的会话 id');
  id ||= newSessionId();
  // 成员 id 用六人团队的（lib/members.mjs）；旧的四个角色 id 当别名认。
  const s = { id, persona: persona === 'team' ? 'team' : memberId(persona) || 'scout', backend, title: '新对话', created_at: iso(now), updated_at: iso(now), messages: [], ...(memberId(member) ? { member: memberId(member) } : {}) };
  saveSession(s);
  return s;
}
export function loadSession(id) {
  if (!validId(id)) throw Error('无效的会话 id');
  const s = read(sessionPath(id), null);
  if (!s) throw Error('会话不存在');
  return mergeReplies(s);
}
// 你看过这段对话了（POST /api/chat/seen；手机和电脑是同一份）：对话历史上「有新消息」的小点按它和 updated_at 比。
export function markSeen(id, { now = Date.now() } = {}) {
  const s = loadSession(id);
  s.seen_at = iso(Math.max(now, Date.parse(s.updated_at || 0) || 0));
  saveSession(s);
  return { session_id: s.id, seen_at: s.seen_at };
}
export function deleteSession(id) {
  if (!validId(id)) throw Error('无效的会话 id');
  fs.rmSync(file(sessionPath(id)), { force: true });
  return { deleted: id };
}
// 执行器写回 state/web-replies.ndjson 的回复并入会话，作为 executor 角色的消息。
// all：已经读好的回复（浮层一次看几个会话时只读一遍文件）。
export function mergeReplies(s, all = null) {
  const replies = (all || lines(REPLIES_PATH)).filter(r => r.session_id === s.id);
  let changed = false;
  for (const r of replies) {
    const key = r.message_id || hash([r.session_id, r.at, r.text]).slice(0, 16);
    if ((s.messages || []).some(m => m.reply_key === key)) continue;
    // 回报记在交出这件事的那位名下（任务卡上写的也是它），不看执行器自己写的是谁：一件事从头到尾只有一位。
    const asker = s.messages.find(m => m.handoff?.message_id && m.handoff.message_id === r.message_id)?.persona;
    s.messages.push({ id: crypto.randomBytes(6).toString('hex'), role: 'executor', persona: memberId(asker) || r.persona || 'system', content: String(r.text || ''), at: r.at || iso(Date.now()), reply_key: key, evidence: r.evidence || null });
    const h = s.messages.find(m => m.handoff && m.handoff.message_id === r.message_id && !m.handoff.answered_at);
    if (h) h.handoff.answered_at = r.at || iso(Date.now());
    changed = true;
  }
  if (changed) { s.updated_at = iso(Date.now()); saveSession(s); }
  return s;
}

// ── 上下文 ───────────────────────────────────────────────────────────────────
// 「筛选 杭州」举的是第一个目标城市（lib/city.mjs）。
const grammar = () => `指挥室指令语法（只能用这些原样句子）：「投 N」「投 全部」「发 N」「发 全部」「N 不发」「改 N 怎么改」「pass N 原因」「N 联系」「N 跟进」「N 备注 …」「N 面试 YYYY-MM-DD HH:mm」「N 面试完成」「N 复盘 …」「N 晚点提醒」「N 暂停提醒」「详情 N」「筛选」${primaryCity() ? `「筛选 ${primaryCity()}」` : ''}「筛选 真人」「停」「我的待办」「重点」「拟发清单」「拟投清单」。`;
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
function stringify(obj, limit) { let s = JSON.stringify(obj, null, 0); if (s.length > limit) s = s.slice(0, limit) + '…(截断)'; return s; }
// 线索的几个数给模型看时只给那一份账（lib/tally.mjs，和指挥台的标签、收件箱、侧栏角标同一份；rebuild7/one-source）：
// 以前这里给的是指挥中心另算的 pool（实测 295 条，指挥台标签是 19 + 68），模型照着报，和页面对不上（H4）。
// 有账就只给账；没有账（老调用、测试）才退回原来那几个数。
function leadCounts(n, verdicts, tally = null) {
  if (tally) return { 说法: tallyLines(tally), 等你处理: tally.waiting.total, 新线索: tally.leads.new, 其中推荐: tally.leads.recommend, 待核: tally.leads.verify, 指挥台各标签: tally.leads.tabs, 全部岗位按结论: tally.leads.verdicts };
  if (!n) return n;
  return {
    '全部（不含已排除 / 归档）': n.total, '等你拍板（指挥台「新线索」「待核」，还没点联系 / 投 / pass）': n.pool, '等你拍板的按判断分': verdicts,
    '你拍过板、在推进': n.decided, '判成不合适': n.excluded, '其他城市，先放着': n.backlog, '规则先筛掉': n.prefiltered, '真人帖（等你拍板的里面）': n.human,
    '今天新找到': n.discovered_today, '今天判了': n.judged_today, '今天推荐': n.recommended_today, '判断没成': n.match_failed,
  };
}
// 现状视图有数组、按 id 索引的表和带列表的包装对象；坏行只跳过，不能打断只读问答。
export function workRows(value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 32 || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap(x => workRows(x, seen, depth + 1));
  if (Object.hasOwn(value, 'id') || Object.hasOwn(value, 'rid')) return [value];
  for (const key of ['asks', 'tasks', 'items', 'cards', 'groups', 'rows', 'workers']) if (Object.hasOwn(value, key)) return workRows(value[key], seen, depth + 1);
  if (['kind', 'title', 'question', 'label', 'status'].some(k => Object.hasOwn(value, k))) return [value];
  return Object.values(value).flatMap(x => workRows(x, seen, depth + 1));
}
export function currentWork(work = {}) {
  const asks = workRows(work?.asks).map(a => ({ id: a.id, kind: a.kind, title: a.title, question: a.question, detail: a.detail, note: a.note, context: a.context, form: a.form, lead: a.lead, options: workRows(a.options).map(o => ({ label: o.label })) }));
  const tasks = workRows(work?.tasks).filter(t => !['done', 'cancelled', 'withdrawn', 'completed'].includes(t.status)).map(t => ({ id: t.id, title: t.title, status: t.status, next: t.wait_note || t.need_title || t.next || t.detail || t.result, lead: t.lead || t.leads }));
  return { asks, tasks };
}
export function personaContext(persona, center = {}, { now = Date.now() } = {}) {
  const c = center, local_ai = localAiContext();
  const base = { time: iso(now), snapshot_at: c.ts, quiet_hours: c.quiet_hours, todo_total: c.tally ? c.tally.waiting.total : c.todo?.total_user, ...(c.tally ? { counts: tallyLines(c.tally) } : {}), blocked: (c.current_work ? [] : workRows(c.blocked)).slice(0, 12).map(b => ({ label: b.label, reason: cut(b.reason, 120), action: b.action })), alerts: (c.alerts || []).slice(0, 12).map(a => ({ level: a.level, source: a.source, msg: cut(a.msg, 140) })) };
  const roles = Object.fromEntries(Object.entries(c.roles || {}).map(([k, r]) => [k, { status: r.status, last: r.last ? cut(r.last.msg, 100) : null, last_at: r.last?.ts || null, stages: (r.stages || []).map(s => ({ step: s.stage, status: s.status, result: s.msg || s.summary || null, reason: s.reason || s.error || null })), facts: r.facts }]));
  // 旧运行账里的 host/models 不再是本机 AI 的配置来源。
  for (const k of ['patch', 'system']) if (roles[k]?.facts) { const { executor, models, ...rest } = roles[k].facts; roles[k].facts = rest; }
  const per = {
    radar: { leads: { counts: leadCounts(c.leads?.counts, c.leads?.verdicts, c.tally), stages: c.leads?.stages, cities: c.leads?.cities, sources: c.leads?.sources, top_picks: (c.leads?.top_picks?.rows || []).map(r => ({ n: r.number, company: r.company, role: r.role, city: r.city, fit: r.fit, blocker: r.blocker, owner: r.owner })), recent: c.leads?.recent }, todo: { screen: workRows(workRows(c.todo?.groups).find(g => g.kind === 'screen')?.items).slice(0, 15), decide: workRows(workRows(c.todo?.groups).find(g => g.kind === 'decide')?.items).slice(0, 10) }, preferences: { positive: c.preferences?.positive, negative: c.preferences?.negative, manual: c.preferences?.manual }, schedule: c.schedule?.items?.map(i => ({ kind: i.kind, next_at: i.next_at, last_finished_at: i.last_finished_at, last_exit: i.last_exit })) },
    watch: { inbox: c.followup?.inbox, interviews: c.followup?.interviews, mail: c.followup?.mail, connector: c.roles?.owl?.facts, todo: { reply: workRows(c.todo?.groups).find(g => g.kind === 'reply')?.items, schedule: workRows(c.todo?.groups).find(g => g.kind === 'schedule')?.items, review: workRows(c.todo?.groups).find(g => g.kind === 'review')?.items, clarify: workRows(c.todo?.groups).find(g => g.kind === 'clarify')?.items }, outbound_waiting: (c.followup?.outbound || []).filter(o => !o.replied_at).slice(0, 15).map(o => ({ n: o.number, company: o.company, channel: o.channel, at: o.at, days: o.days_since })) },
    reacher: { send_proposal: c.todo?.send_proposal, apply_proposal: c.todo?.apply_proposal, todo: { send: workRows(c.todo?.groups).find(g => g.kind === 'send')?.items, submit: workRows(c.todo?.groups).find(g => g.kind === 'submit')?.items, followup: workRows(c.todo?.groups).find(g => g.kind === 'followup')?.items, auto_apply: workRows(workRows(c.todo?.groups).find(g => g.kind === 'auto_apply')?.items).slice(0, 10) }, outbound: (c.followup?.outbound || []).slice(0, 20).map(o => ({ n: o.number, company: o.company, channel: o.channel, purpose: o.purpose, at: o.at, replied: !!o.replied_at })), referrers: (c.followup?.referrers || []).slice(0, 15), executor_tasks: c.executor?.heartbeat?.tasks, host_jobs: { waiting_user: c.executor?.host_jobs?.waiting_user?.slice(0, 8), blocked: c.executor?.host_jobs?.blocked?.slice(0, 8) } },
    system: { executor: { run_now: { ...(c.executor?.run_now || {}), log: undefined, last_result: cut(c.executor?.run_now?.last_result, 1200) }, heartbeat: c.executor?.heartbeat, host_jobs: { pending: c.executor?.host_jobs?.pending?.length, working: c.executor?.host_jobs?.working?.length, waiting_user: c.executor?.host_jobs?.waiting_user?.length, blocked: c.executor?.host_jobs?.blocked?.length, completed_today: c.executor?.host_jobs?.completed_today }, local_ai }, schedule: c.schedule, progress: c.progress, ops: { current: c.ops?.current, history: (c.ops?.history || []).slice(0, 5) }, settings: c.settings ? { stack: c.settings.stack ? { ...c.settings.stack, rows: c.settings.stack.rows?.filter(r => !/本机 AI|Codex|Claude Code|周期.*巡检/.test(r.fn || '')), issues: c.settings.stack.issues?.filter(r => !/本机 AI|周期巡检|兜底/.test(r.area || '')), errors: undefined, warnings: undefined } : undefined, model: c.settings.files?.model?.values, judge: c.settings.files?.judge?.values, chat: c.settings.files?.chat?.values } : undefined },
  };
  if (c.current_work) for (const part of Object.values(per)) { delete part.todo; delete part.outbound_waiting; }
  // 能力边界对每个成员都相同，不能只藏在 System 的角色上下文里（Writer 不读那一段）。
  return localTimes({ base, roles, executor: { local_ai }, focus: per[persona] || per.system });
}
export function mentionedLeads(text, leads = lines('state/leads.ndjson'), drafts = lines('state/drafts.ndjson'), max = 4) {
  const nums = [...new Set((String(text).match(/\d{1,6}/g) || []).map(Number))].slice(0, max);
  const out = [];
  for (const n of nums) {
    const l = leads.find(x => x.number === n);
    if (!l) continue;
    let brief = '';
    try { brief = jobBrief(l).text; } catch { brief = `${l.company} · ${l.role}`; }
    const ds = drafts.filter(d => d.record_id === leadKey(l) && !['cancelled', 'superseded'].includes(d.status)).map(d => ({ draft_id: d.draft_id, channel: d.channel || 'email', purpose: d.purpose, status: d.status, to: d.to, subject: d.subject, body: cut(d.body, 800), displayed: !!d.displayed_hash }));
    out.push({ number: n, company: l.company || null, stage: stageText(l), feedback: feedbackText(l), verdict: l.match?.verdict || null, brief, drafts: ds, auto_apply: l.auto_apply ? { status: l.auto_apply.status, progress: leadApplyWords(l.auto_apply).line, approved_at: l.auto_apply.approved_at } : null, waiting_user: l.waiting_user || null });
  }
  return out;
}
// 脚本目录按角色列给模型：本角色的在前，其它角色的只列名字。
// judgeOk：判断层现在能不能用（调用方问好传进来；对话这一层不去引判断层，免得成环）。不知道就两样都列。
export function opsForPrompt(persona, { judgeOk = null } = {}) {
  try {
    // 脚本表按成员记（lib/crew.mjs）；对话的角色是老的四个：radar 管 Scout 和 Lens 的，reacher 管 Quill 和 Tailor 的。
    const own = o => (isMember(persona) ? [persona] : LEGACY[persona]?.pause || ['patch']).includes(o.role || 'patch');
    // 没有 Jev 时 judge-leads 跑的就是 match（lib/ops-table.mjs opFor）：不列它，免得模型说出「Jev」、给两个一样的按钮。
    const listed = Object.entries(OPS).filter(([k]) => opFor(k, judgeOk) === k);
    const mine = listed.filter(([, o]) => own(o)), others = listed.filter(([, o]) => !own(o));
    return [...mine.map(([k, o]) => `- 运行 ${k} — ${o.label}：${o.desc}${o.heavy ? '（会调模型 / 浏览器，较慢）' : ''}`), others.length ? `- 其它角色的：${others.map(([k, o]) => `${k}（${o.label}，${crewName(o.role || 'patch')}）`).join('、')}` : ''].filter(Boolean).join('\n');
  } catch { return '（脚本目录不可用）'; }
}
// `owner` 是「张三 / Alex」这样的称呼，来自 candidate/facts.yaml（lib/facts.mjs ownerLabel）。
export function systemPrompt(persona, { now = Date.now(), center = {}, leads = [], memory = [], config = chatConfig(), owner = ownerLabel(), focus = null, resume = null, judgeOk = null } = {}) {
  // 口吻和按角色裁剪的状态还按旧的四个角色（lib/members.mjs voiceOf）；名字、职责是这位成员自己的。
  const voice = voiceOf(persona), p = PERSONAS[voice] || PERSONAS.system;
  const ctx = personaContext(voice, center, { now });
  const dates = [...new Set([iso(now), ...(JSON.stringify({ center, leads }).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g) || [])].map(at => localDay(at)))].map(day => ({ date: day, relative: relativeDay(day, now) }));
  // Writer（tailor）不再借 Reacher 的那一份（投递、联系的数据）：它负责的是简历，提示词里放这一版简历（resume，lib/resume-talk.mjs resumeBrief）。
  const writer = memberId(persona) === 'tailor';
  const limit = Number(config.context_chars) || 26000;
  const sections = [
    `${persona === 'team' ? `你代表「${BRAND}」整个求职团队，本轮以团队身份回答，不沿用上一次成员的身份` : `你是「${BRAND}」求职团队里的 ${memberName(persona)}（${memberDuty(persona) || p.duty}）`}，在本地工作台和用户（求职者本人${owner ? '，' + owner : ''}）对话，用第一人称说话。用中文，直接、具体、短句；引用数据时给编号和数字；不确定就说不确定，不编造。`,
    '报数只照抄下面 JSON 里 counts（和页面上同一份账）的数，不要自己数、不要估；那里没有的数就说页面上看。\n' +
    '你能看到的是系统此刻的真实状态（下面的 JSON）。你只是在"说"：你不能自己发送邮件、提交申请或改状态。用户要做事时，把它写成指挥室指令放在回答最后一行：\nACTIONS: ["发 32", "pass 44 城市太远"]\n（JSON 数组，每项必须是语法里的原样句子；发送 / 投递类会由系统再向用户确认一次。）\n用户明确交代了打开网页、抓原帖、核实信息等任务，且不属于现有指令时，可写成一句任务放在最后一行：\nHANDOFF: 任务描述\n这是一项待交办的团队任务；用户交办后，由 OfferCrew 引擎处理普通业务，进度和结果沿任务回到这个对话。发送、预填和提交仍走对应业务动作的批准流程，不能用 HANDOFF 绕过。明确交代的本机文件或终端命令才检查可选本机 AI 的开关与可用性。改简历、写求职信或自我介绍是 Writer 自己的活，系统会直接交给 Writer，不写 HANDOFF。用户只问可用性或现状时，直接回答，不附 ACTIONS 或 HANDOFF。\n用户明确表达的长期偏好或决定、你在这轮确认的教训，值得留在用户可查看的共享记忆库时，加一行：\nREMEMBER: 偏好｜一句话\n（前缀可选：决定 / 教训 / 公司 / 偏好 / 待办 / 事实；每轮最多一条；普通问答不写。用中文写一句人话，不带代码名、字段名、文件路径、状态码，用户会在记忆库里看到这句。）以上三种都可以不写。',
    `${LOCAL_AI_INDEPENDENT}本机 AI 的状态只看 executor.local_ai；文字模型的设置、旧运行记录和历史对话不能覆盖当前选中的运行时、身份、开关和运行状态。具体业务仍按当前的文字模型、邮箱、浏览器连接与批准状态说明，缺哪项就说明哪项。`,
    `## 当前本机 AI 状态（所有成员共用）\n${stringify({ executor: ctx.executor }, 6000)}`,
    '抓到、判断、核实是不同结果：只按有成功证据的步骤说完成，不从抓取条数推断核实条数。失败、部分完成和等终审必须照当前进度说。JSON 没有草稿就不能说已经写好；过去的对话不能覆盖本次状态。用户问现状或分析材料时不提议外发或启动投递。',
    `## 本轮时钟
当前本地时间：${localTime(now)}（${TZ}）；今天是 ${localDay(now)}。相对日期只按这一轮的时钟与下表说，不沿用会话建立时或历史回答里的今天、明天。拿不准就只写绝对日期。
${JSON.stringify(dates)}`,
    center.current_work ? `## 当前收件箱与任务（本轮读取，下一步的唯一依据）
${stringify(localTimes(currentWork(center.current_work)), 20000)}
只按这里的问题、表单字段和选项说要处理什么；不从旧提醒、联系后天数、历史回答再造待办。同一岗位已在草稿待批准，就只列批准草稿，不再要求决定是否跟进。没有列出的旧补信息问题不能再要求用户填写。` : '',
    grammar(),
    `## 你可以让系统跑的脚本（当工具用；写进 ACTIONS 为「运行 <名字>」，用户点了才真正跑；一次只跑一个）\n${opsForPrompt(persona, { judgeOk })}`,
    `团队分工：${MEMBER_IDS.map(id => `${memberName(id)} ${memberDuty(id)}`).join('；')}。业务由上述成员负责，工具执行记录归交办的成员。本机 AI 是可选的本机工具。不属于你的事可以简短回答并说该找谁。`,
    `所有时间按本地时区 ${TZ} 表达；下列时间已经转换，不再换算。当前新指令的对象优先于历史上下文；用户说不要外发、不要投时，不建议发送、投递、预填或外发任务。`,
    `## 系统状态（${localTime(now) || ''}）\n${stringify(ctx.base, 4000)}\n## 各角色\n${stringify(ctx.roles, 4000)}\n${writer ? '' : `## 你负责的部分\n${stringify(ctx.focus, limit)}`}`,
    writer ? '你是简历师。用户说「体检」「改一版」、或者选中几行说怎么改，系统会直接交给你去做，不用写 HANDOFF；聊天时只根据下面这份简历、用户的资料和用户说过的话回答，不编造简历上没有的经历、数字和技能。' : '',
    resume ? `## 用户正在看的简历\n${resume}` : '',
    memory.length ? `## 记忆库（团队和用户共享的经验，最相关在前；与状态冲突时以状态为准）\n${renderNotes(memory)}` : '',
    focus ? `## 用户正在看的岗位\n编号 ${focus}（工作台右侧面板上开着它）。用户说「这个」「它」「这条」「这家」时，指的就是它。` : '',
    leads.length ? `## 用户提到的岗位\n${leads.map(l => `### 编号 ${l.number}（阶段 ${l.stage}${l.feedback ? '，反馈 ' + l.feedback : ''}${l.verdict ? '，判断 ' + l.verdict : ''}）\n${l.brief}\n${l.drafts.length ? '草稿：' + JSON.stringify(localTimes(l.drafts)) : '没有草稿'}${l.auto_apply ? '\n申请表进度（auto_submit 关着时系统只预填、不提交）：' + JSON.stringify(localTimes(l.auto_apply)) : ''}${l.waiting_user ? '\n等用户回答：' + l.waiting_user : ''}`).join('\n\n')}` : '',
  ].filter(Boolean);
  return sections.join('\n\n');
}
// 流到一半时能给人看的那部分：ACTIONS / HANDOFF / REMEMBER 这几行不给；最后一行还在写、可能是这几行的开头的，先不给（不会先露出来再收回去）。
const TAIL_MARK = /^\s*(ACTIONS?|HANDOFF|REMEMBER)\s*[:：]/;
export function shownSoFar(text) {
  const rows = String(text || '').split('\n'), tail = rows.pop();
  const head = tail.trimStart().replace(/\s+$/, '');
  const hold = TAIL_MARK.test(tail) || !tail.trim() || (/^[A-Z]+$/.test(head) && ['ACTIONS', 'HANDOFF', 'REMEMBER'].some(w => w.startsWith(head)));
  return [...rows.filter(r => !TAIL_MARK.test(r)), ...(hold ? [] : [tail])].join('\n');
}
// 断了的那一句（lib/say-error.mjs errorReason 那一套）：超时说「模型太久没回」，上游没说完就停了说「模型那边没说完就停了」，别的都是「连接断了」。
export const cutLine = cut => `这句没说完：${errorReason(cut?.kind === 'timeout' ? cut.error || 'timeout' : cut?.kind === 'ended' ? '模型那边没说完就停了' : '连接断了')}`;
export function parseReply(text) {
  const rows = String(text || '').split('\n');
  let actions = [], handoff = null;
  const keep = [];
  for (const row of rows) {
    const a = row.match(/^\s*ACTIONS?\s*[:：]\s*(\[.*\])\s*$/);
    const h = row.match(/^\s*HANDOFF\s*[:：]\s*(.+)$/);
    if (a) { try { actions = JSON.parse(a[1]).filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 8); } catch { keep.push(row); } continue; }
    if (h) { handoff = h[1].trim().slice(0, 500); continue; }
    keep.push(row);
  }
  return { content: keep.join('\n').trim(), actions, handoff };
}

// ── 一轮对话 ─────────────────────────────────────────────────────────────────
// focus：用户正看着的那一条的编号（面板「正在看 #12」），它的简报一并交给模型。
// onDelta：边生成边显示（POST /api/talk 带 stream: true）。给它的是能给人看的那部分（shownSoFar：ACTIONS / HANDOFF / REMEMBER 那几行不给）。
export async function chatTurn({ session_id, persona = null, text, backend = null, model = null, center = {}, now = Date.now(), completeFn = complete, config = chatConfig(), focus = null, resume = null, onDelta = null, judgeOk = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 4000) throw Error('请输入内容（4000 字以内）');
  const s = session_id ? loadSession(session_id) : newSession({ persona: persona || 'radar', backend: backend || model || null, now });
  if (persona === 'team' || memberId(persona)) s.persona = persona === 'team' ? 'team' : memberId(persona);
  const chosen = backend || model || null;
  if (chosen !== null) s.backend = chosen || null;
  const userMsg = { id: crypto.randomBytes(6).toString('hex'), role: 'user', content: raw, at: iso(now) };
  s.messages.push(userMsg);
  if (s.title === '新对话') { s.title = ruleTitle(raw); s.title_by = 'rule'; }
  const leads = mentionedLeads(`${Number.isInteger(focus) ? `#${focus} ` : ''}${raw}`);
  // 「记住：…」直接入库，不经模型；其余先查记忆库再组提示词。
  const remembered = [];
  const direct = parseRememberCommand(raw);
  if (direct) { try { const r = await addNote({ by: 'user', kind: direct.kind, text: direct.text, numbers: leads.map(l => l.number), companies: [] }, { now }); remembered.push({ id: r.note.id, kind: r.note.kind, text: r.note.text, status: r.status }); userMsg.remembered = remembered.slice(); } catch (e) { userMsg.remember_error = e.message; } }
  const memory = recall({ text: raw, numbers: leads.map(l => l.number), companies: leads.map(l => l.company).filter(Boolean), limit: 12, now });
  const system = systemPrompt(s.persona, { now, center, leads, memory, config, judgeOk, focus: Number.isInteger(focus) ? focus : null, resume: typeof resume === 'string' && resume ? resume : null });
  // 浮层里下的指令也在这个会话里（你的原话 + 那位成员的回执）：回执标明是哪条指令的，模型知道你刚做了什么。
  const history = s.messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'executor').slice(-(Number(config.history) || 16)).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.role === 'executor' ? `【执行器回复】${m.content}` : m.kind === 'receipt' ? `【指令「${m.command?.text || ''}」的回执】${m.content}${m.detail ? '\n' + m.detail : ''}` : m.content }));
  // Messages 接口要求 user/assistant 交替且以 user 开头；合并相邻同角色。
  const merged = [];
  for (const m of history) { const last = merged.at(-1); if (last && last.role === m.role) last.content += '\n\n' + m.content; else merged.push({ ...m }); }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  // 底座：这轮点名的 > 会话记住的 > 角色默认（config/roles.json）> 全局默认。
  const roleDefault = roleChatBackend(voiceOf(s.persona));
  let r, heard = '', sent = '';
  const live = typeof onDelta === 'function' ? d => { heard += d; const v = relativeDates(shownSoFar(heard), now).replace(/(\d{4}-\d{2}-\d{2})\s*[（(](?:今(?:天)?|明(?:天)?|昨(?:天)?)?$/, '$1'); if (v.length > sent.length && v.startsWith(sent)) { const piece = v.slice(sent.length); sent = v; try { onDelta(piece); } catch {} } } : null; // 兜底：听的那头（页面）断了不影响回答本身
  try { r = await completeFn({ system, messages: merged, backend: s.backend || roleDefault || null, config, meta: { member: s.persona, step: 'chat' }, ...(live ? { onDelta: live } : {}) }); }
  catch (e) {
    lastFail = { at: Date.now(), msg: String(e.message).slice(0, 80) };
    s.messages.push({ id: crypto.randomBytes(6).toString('hex'), role: 'assistant', persona: s.persona, content: `（模型没有回复：${errorReason(e)}）`, at: iso(Date.now()), error: true });
    s.updated_at = iso(Date.now()); saveSession(s);
    event('user', 'chat', 'fail', `对话模型调用失败：${String(e.message).slice(0, 120)}`);
    return { session: s, reply: s.messages.at(-1), error: errorReason(e) }; // 原文在上面那条事件和模型调用的记录里
  }
  if (r.backend !== 'sandbox') lastFail = null;
  // 中途断了（r.broken）：已经说出来的那部分留着，后面跟一句「这句没说完：…」；没说完的 ACTIONS / HANDOFF / REMEMBER 不算数。
  const rl = r.broken ? { content: shownSoFar(r.text), remembers: [] } : parseRememberLines(r.text);
  const parsed = r.broken ? { content: rl.content.trim(), actions: [], handoff: null } : parseReply(rl.content);
  parsed.content = relativeDates(parsed.content, now);
  if (deniesOutbound(raw)) {
    parsed.actions = parsed.actions.filter(a => !outboundAsk(a) && resolveCommand(a).kind !== 'op');
    parsed.handoff = null;
  }
  // 模型建议不能给自己授予执行权限；信息问答也不挂交办按钮。
  if (!outboundAsk(raw)) parsed.actions = parsed.actions.filter(a => !outboundAsk(a));
  if (isQuestion(raw)) { parsed.actions = parsed.actions.filter(a => ['brief', 'query', 'top_picks', 'send_list', 'apply_list'].includes(resolveCommand(a).kind)); parsed.handoff = null; }
  if (parsed.handoff && (outboundAsk(parsed.handoff) || computerNeed(parsed.handoff)) && !computerNeed(raw) && !outboundAsk(raw)) parsed.handoff = null;
  const reply = { id: crypto.randomBytes(6).toString('hex'), role: 'assistant', persona: s.persona, content: parsed.content, actions: parsed.actions, handoff: parsed.handoff ? { text: parsed.handoff, dispatched: false } : null, at: iso(Date.now()), model: r.model, backend: r.backend || null, ...(r.fallback_from ? { fallback_from: r.fallback_from, ...(r.fallback_to ? { fallback_to: r.fallback_to } : {}) } : {}), ...(r.broken ? { cut: cutLine(r.cut) } : {}), usage: r.usage || null, duration_ms: r.duration_ms || null, remembered: [] };
  for (const m of rl.remembers) { try { const a = await addNote({ by: 'chat', kind: m.kind, text: m.text, numbers: leads.map(l => l.number), companies: [] }, { now: Date.now() }); reply.remembered.push({ id: a.note.id, kind: a.note.kind, text: a.note.text, status: a.status }); } catch (e) { reply.remember_error = e.message; } }
  s.messages.push(reply);
  s.updated_at = iso(Date.now()); s.model = r.model;
  saveSession(s);
  const day = today();
  write(`runs/${day}/usage.json`, [...read(`runs/${day}/usage.json`, []), { request_id: `chat-${s.id}-${reply.id}`, at: reply.at, driver: 'chat', model: r.model, status: 'completed', duration_ms: r.duration_ms || null, usage: r.usage || null }]);
  if (r.broken) event('user', 'chat', 'warn', `与 ${memberName(s.persona)} 对话一轮，回复中途断了（${r.model}，${String(r.cut?.error?.message || '').slice(0, 80)}）`);
  else event('user', 'chat', 'ok', `与 ${memberName(s.persona)} 对话一轮（${r.model}）`);
  return { session: s, reply };
}

// 交给即时执行器：一条宿主任务 + 一次去抖拉起；回复通过 state/web-replies.ndjson 回到会话。
export async function handoff({ session_id, text, persona = null, now = Date.now() } = {}) {
  const s = loadSession(session_id);
  const task = String(text || '').trim();
  if (!task || task.length > 2000) throw Error('任务描述不能为空');
  const message_id = `chat-${s.id}-${crypto.randomBytes(4).toString('hex')}`;
  const who = persona || s.persona;
  const { queueEngineTask } = await import('./task-entry.mjs');
  const card = queueEngineTask({ text: task, owner: who, from: { by: 'you', via: 'chat', session_id: s.id, message_id }, now });
  const msg = { id: crypto.randomBytes(6).toString('hex'), role: 'system', persona: who, content: `已交给团队：${task}`, card: card.id, at: iso(now), handoff: { text: task, message_id, dispatched: true, dispatched_at: iso(now) } };
  s.messages.push(msg);
  for (const m of s.messages) if (m.handoff && !m.handoff.dispatched && m.handoff.text === task) { m.handoff.dispatched = true; m.handoff.message_id = message_id; }
  s.updated_at = iso(now); saveSession(s);
  event('user', 'room', 'ok', `对话交给团队：${task.slice(0, 80)}`);
  return { session: s, message_id, card_id: card.id };
}
