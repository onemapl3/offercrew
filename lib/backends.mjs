// 供应商与模型目录：谁在提供推理、各自支持哪些模型、用哪个账号。
//
// 一个供应商 = 一种驱动 + 一份凭据 / 登录态 + 一张模型清单（config/providers.json）：
//   anthropic_http  Claude 经网关（private/claude-api.auth.json，按 token 计费）
//   claude_code     Claude 官方订阅：本机 `claude -p`，登录态在 CLAUDE_CONFIG_DIR（默认 ~/.claude）。登录只在
//                   Anthropic 自己的流程里完成（用户自己在终端跑 `claude auth login`）；这里只指向那个目录、
//                   用 `claude auth status` 看登没登录，从不读、不存、不转交 Claude 账号的令牌
//   codex_exec      GPT 经本机 `codex exec`：登录态在 CODEX_HOME（默认 ~/.codex），
//                   codex_provider 是那份 config.toml 里的 id（openai 内置 = ChatGPT 官方订阅）
// 多账号 = 同一种驱动、不同的登录目录：private/accounts/<key>/。模型清单可自动探测
// （网关的 /v1/models、Codex 的 models_cache.json），也可以手工增删。
// 任何地方引用模型都写成 `供应商/模型`，例如 openai/gpt-5.6-luna、claude_gateway/claude-fable-5-1。
import { appShell } from './capabilities.mjs';
import fs from 'node:fs';
import { cliLogin } from './model-truth.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from './spawn.mjs';
import { promisify } from 'node:util';
import { file, read, write, hash } from './store.mjs';
import { BRAND } from './brand.mjs';
import { noteSwallowed } from './swallow.mjs';
import { modelCall } from './sandbox.mjs';

const execFileP = promisify(execFile);
export const PROVIDERS_PATH = 'config/providers.json';
export const KINDS = { anthropic_http: 'Anthropic Messages 兼容（Claude 网关 / 官方 API）', openai_http: 'OpenAI 兼容 HTTP（chat 或 responses）', claude_code: 'Claude 官方订阅（Claude Code 登录）', codex_exec: 'Codex（codex exec）' };
export const HTTP_KINDS = ['anthropic_http', 'openai_http'];
export const PROVIDER_KEY = /^[a-z][a-z0-9_-]{1,31}$/;
const hasProto = u => /^https?:\/\/[^\s]+$/.test(String(u || '').trim());
export const DRIVERS = Object.keys(KINDS);
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const KNOWN_MODELS = {
  claude: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  gpt: ['gpt-6-astra', 'gpt-6', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6', 'gpt-5.5'],
  jev: ['jev-latest'],
};
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const codexConfigPath = (home = codexHome()) => path.join(home, 'config.toml');
const hostOf = u => { try { return new URL(u).host; } catch { return String(u || ''); } };
const str = v => { const m = String(v ?? '').trim().match(/^"([^"]*)"|^'([^']*)'|^([^\s#]+)/); return m ? (m[1] ?? m[2] ?? m[3]) : ''; };
const abs = p => (p ? (path.isAbsolute(p) ? p : file(p)) : null);

// ── ~/.codex/config.toml：供应商段落与默认值（浅解析）──────────────────────────
export function codexProviders(cfg = codexConfigPath()) {
  const out = { file: cfg, exists: fs.existsSync(cfg), default_provider: 'openai', default_model: null, default_effort: null, providers: [{ id: 'openai', label: 'openai · OpenAI 官方订阅（ChatGPT 登录）', builtin: true, base_url: null, bearer: null }] };
  if (!out.exists) return out;
  let section = null;
  for (const raw of fs.readFileSync(cfg, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[([^\]]+)\]$/);
    if (head) { const m = head[1].match(/^model_providers\.(?:"([^"]+)"|([^.\s]+))$/); section = m ? (m[1] || m[2]) : null; if (section && !out.providers.some(p => p.id === section)) out.providers.push({ id: section, label: section, builtin: false, base_url: null, bearer: null }); continue; }
    const kv = line.match(/^([A-Za-z_][\w.]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (section) { const p = out.providers.find(x => x.id === section); if (k === 'base_url') { p.base_url = str(v); p.label = `${section} · ${hostOf(p.base_url)}`; } if (k === 'name' && !p.base_url) p.label = `${section} · ${str(v)}`; if (k === 'experimental_bearer_token') p.bearer = str(v); }
    else if (k === 'model_provider') out.default_provider = str(v);
    else if (k === 'model') out.default_model = str(v);
    else if (k === 'model_reasoning_effort') out.default_effort = str(v);
  }
  // 自己配了 base_url 的供应商是中转或别家接口，按 token 计费（不占 ChatGPT 订阅额度）。
  for (const p of out.providers) if (!p.builtin && p.base_url) p.label += '（按 token 计费）';
  return out;
}
export const providerIds = (info = codexProviders()) => info.providers.map(p => p.id);
export const providerKnown = (id, info = codexProviders()) => info.providers.some(p => p.id === id);

// ── 注册表 ───────────────────────────────────────────────────────────────────
// 文件里没有的供应商按本机情况自动补：网关（有凭据文件）、Claude 官方订阅（默认登录）、
// Codex 配置里的每个供应商。用户加的账号只在文件里。
// Mac 版（RADAR_SCHEDULER=app）不这样补（负责人 10-03：「用户应该要自己设置这些 API key 才会有选」）：见下面 desktopProviders。
export const desktopApp = (env = process.env) => appShell(env); // 只有能力表读运行方式（lib/capabilities.mjs）
export function defaultProviders() {
  const m = read('config/model.json', {});
  const authFile = m.text?.auth_file || 'private/claude-api.auth.json';
  const auth = read(authFile, null);
  const out = {};
  out.claude_gateway = { label: `Claude 网关 · ${auth?.provider || hostOf(auth?.base_url) || '未配置'}（按 token）`, kind: 'anthropic_http', auth_file: authFile, models: [...KNOWN_MODELS.claude], efforts: [] };
  // Mac 版：只有填过凭据的 Claude 网关；这台电脑上的 Claude Code、~/.codex 里的供应商都不补。
  if (desktopApp()) return auth ? out : {};
  // ~/.claude/settings.json 的 env 可能把 ANTHROPIC_* 指向中转：那时在 config/providers.json 给它配独立的
  // config_dir，用户自己跑一次 `CLAUDE_CONFIG_DIR=<目录> claude auth login`（loginHints 给出这条命令）。
  out.claude_subscription = { label: 'Claude 官方订阅 · Claude Code 登录（默认账号）', kind: 'claude_code', config_dir: null, models: [...KNOWN_MODELS.claude], efforts: EFFORTS.slice(0, 3) };
  const info = codexProviders();
  for (const p of info.providers) out[p.id] = { label: p.builtin ? 'OpenAI 官方订阅 · Codex 登录（默认账号）' : `${p.label} · Codex`, kind: 'codex_exec', codex_provider: p.id, codex_home: null, models: p.builtin ? ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5'] : [...KNOWN_MODELS.gpt], efforts: [...EFFORTS] };
  return out;
}
// Mac 版能选的：OfferCrew 补给、你在 OfferCrew 里填过 key / 登录过的（目录里带 user、account、free 的，和填过凭据的 Claude 网关）。
// 这台电脑上的 Codex、Claude Code 各多一项「本机 Codex」「本机 Claude Code」，要装了也登录了，而且下面两条有一条：
//   - 本机 AI 开关打开着（config/pipeline.json desktop_executor）；
//   - 你在引导或设置的「用本机 AI」里亲手选了它（markLocalPicked 记的，选了 Codex 只多 Codex）。选它不打开那个开关：开关管的是动手。
// 两条都没有就不碰 ~/.codex、~/.claude，它们配置里的中转一个都不列。目录文件里以前存下的本机项（saveProviders 会把整个目录写回去）也一样拿掉。
export const LOCAL_LABELS = { openai: '本机 Codex', claude_subscription: '本机 Claude Code' };
function localRuntimesOn(env = process.env) {
  const on = read('config/pipeline.json', {})?.desktop_executor === true, picked = pickedProviders(), want = key => on || !!picked?.has(key);
  const out = {};
  if (want('openai') && onPath('codex', env.RADAR_CODEX_BIN) && fs.existsSync(path.join(codexHome(), 'auth.json')) && cliLogin('codex', { exe: env.RADAR_CODEX_BIN, env }) !== 'out')
    out.openai = { label: LOCAL_LABELS.openai, kind: 'codex_exec', codex_provider: 'openai', codex_home: null, models: ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5'], efforts: [...EFFORTS], local: true };
  if (want('claude_subscription') && onPath('claude', env.RADAR_CLAUDE_BIN) && cliLogin('claude', { exe: env.RADAR_CLAUDE_BIN, env }) !== 'out')
    out.claude_subscription = { label: LOCAL_LABELS.claude_subscription, kind: 'claude_code', config_dir: null, models: [...KNOWN_MODELS.claude], efforts: EFFORTS.slice(0, 3), local: true };
  return out;
}
// 这一项是不是「这台电脑上的」（默认登录目录的 Codex / Claude Code，或 ~/.codex 里的中转），而不是在 OfferCrew 里配的。
const fromThisComputer = (key, p) => !p.user && !p.account && !p.free && (
  (p.kind === 'codex_exec' && !p.codex_home) || (p.kind === 'claude_code' && !p.config_dir) || (key === 'claude_gateway' && !read(p.auth_file || '', null)));
function desktopProviders(merged, env = process.env) {
  const savedLocal = Object.fromEntries(Object.entries(merged).filter(([key]) => key in LOCAL_LABELS));
  for (const [key, p] of Object.entries(merged)) if (fromThisComputer(key, p)) delete merged[key];
  // 本机登录态重新探测；用户添加的型号和上次读到的目录仍须保留。
  for (const [key, p] of Object.entries(localRuntimesOn(env))) {
    const old = savedLocal[key]?.kind === p.kind ? savedLocal[key] : {};
    merged[key] = { ...p, models: [...new Set([...(old.models || []), ...p.models])],
      ...(old.manual_models ? { manual_models: old.manual_models } : {}),
      ...(old.discovered ? { discovered: old.discovered, discovered_at: old.discovered_at, discovered_from: old.discovered_from } : {}),
      ...(old.efforts?.length ? { efforts: old.efforts } : {}) };
  }
  return merged;
}
export function loadProviders() {
  const saved = read(PROVIDERS_PATH, { providers: {} });
  let merged = { ...defaultProviders() };
  for (const [key, p] of Object.entries(saved.providers || {})) merged[key] = { ...(merged[key] || {}), ...p };
  if (desktopApp()) merged = desktopProviders(merged);
  for (const [key, p] of Object.entries(merged)) {
    // 以前的 setup-token 令牌文件（oauth_token_file）不再用：Claude 订阅只认登录目录里 Claude Code 自己的登录。
    if (p.kind === 'claude_code' && 'oauth_token_file' in p) { delete p.oauth_token_file; if (/setup-token/.test(p.label || '')) p.label = 'Claude 官方订阅 · Claude Code 登录（独立登录目录）'; }
    p.key = key; p.models = [...new Set((p.models || []).map(x => String(x).trim()).filter(Boolean))]; p.efforts = p.efforts || (p.kind === 'codex_exec' ? [...EFFORTS] : p.kind === 'claude_code' ? EFFORTS.slice(0, 3) : []); }
  return merged;
}
export function saveProviders(providers) {
  const clean = Object.fromEntries(Object.entries(providers).map(([k, p]) => { const { key, status, ...rest } = p; return [k, rest]; }));
  write(PROVIDERS_PATH, { ...read(PROVIDERS_PATH, {}), providers: clean, updated_at: new Date().toISOString() });
  return clean;
}
export const getProvider = (key, providers = loadProviders()) => providers[key] || null;
export function providerLabel(key, providers = loadProviders()) { return providers[key]?.label || `${key}（未知供应商）`; }
export const providersOfKind = (kinds, providers = loadProviders()) => Object.values(providers).filter(p => (Array.isArray(kinds) ? kinds : [kinds]).includes(p.kind));

// 一条底座引用 → 驱动能用的完整描述。
export function resolveBackend(ref, providers = loadProviders()) {
  let provider = null, model = null, effort = null, label = null, id = null;
  if (typeof ref === 'string') {
    const s = ref.trim();
    const i = s.indexOf('/');
    if (i > 0 && providers[s.slice(0, i)]) { provider = s.slice(0, i); model = s.slice(i + 1); }
    else if (i > 0 && !/^(https?):/.test(s)) { provider = s.slice(0, i); model = s.slice(i + 1); }
    else if (/^claude/i.test(s)) { provider = 'claude_gateway'; model = s; }
    else if (/^gpt|^o\d/i.test(s)) { provider = codexProviders().default_provider; model = s; }
    else throw Error(`看不懂的底座：${s}（要写成 供应商/模型）`);
  } else if (ref && typeof ref === 'object') {
    model = String(ref.model || '').trim();
    provider = ref.provider || (ref.driver === 'anthropic_http' ? 'claude_gateway' : ref.driver === 'claude_code' ? 'claude_subscription' : ref.driver === 'codex_exec' ? codexProviders().default_provider : null);
    if (!provider && ref.id && String(ref.id).includes('/')) provider = String(ref.id).split('/')[0];
    if (!provider) provider = /^claude/i.test(model) ? 'claude_gateway' : codexProviders().default_provider;
    // 旧 id（裸模型名）不再保留，统一成 供应商/模型。
    effort = ref.effort || null; label = ref.label || null; id = ref.id && String(ref.id).includes('/') ? ref.id : null;
  }
  if (!model) throw Error('底座缺 model');
  const p = providers[provider];
  if (!p) { const e = Error(`供应商「${provider}」不在目录里（可选：${Object.keys(providers).join(' / ')}）`); e.unknown_provider = provider; throw e; }
  if (effort && !(p.efforts || []).includes(effort)) effort = (p.efforts || [])[0] || null;
  return { id: id || `${provider}/${model}`, provider, model, effort, label, kind: p.kind, auth_file: p.auth_file || null, wire_api: p.model_wires?.[model] || p.wire_api || null, ...(p.model_wires?.[model] ? { model_wire: p.model_wires[model] } : {}), codex_provider: p.codex_provider || null, codex_home: abs(p.codex_home), config_dir: abs(p.config_dir), provider_label: p.label };
}
export const backendId = b => { try { return resolveBackend(b).id; } catch { return b?.id || (b?.provider ? `${b.provider}/${b.model}` : String(b?.model || '')); } };
export function backendLabel(b, providers = loadProviders()) {
  try { const r = resolveBackend(b, providers); return r.label || `${r.model} · ${r.provider_label}${r.effort ? ' · ' + r.effort : ''}`; }
  catch { return b?.label || backendId(b); }
}
// 规范化一份 backends 清单（chat.json / model.json 用）；旧写法自动升级。
export function normalizeBackend(raw = {}, providers = loadProviders()) {
  const r = resolveBackend(typeof raw === 'string' ? raw : raw, providers);
  return { id: r.id, provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}), ...(r.label ? { label: r.label } : {}) };
}
// 供应商不在目录里的一项（例如 ~/.codex/config.toml 里删掉了那个中转）原样留在清单里、标上
// unknown_provider：设置页和指挥台据此告警（lib/settings.mjs stackSummary），对话按顺序跳过它；
// 不能因为一项配错就让读配置的每个页面都报错。
export function unresolvedBackend(raw, e) {
  const s = typeof raw === 'string' ? raw.trim() : null;
  const model = String(s ? s.slice(s.indexOf('/') + 1) : raw?.model || '').trim();
  const provider = e.unknown_provider;
  return { id: (s && s.includes('/') ? s : raw?.id && String(raw.id).includes('/') ? raw.id : `${provider}/${model}`), provider, model, ...(raw?.effort ? { effort: raw.effort } : {}), ...(raw?.label ? { label: raw.label } : {}), unknown_provider: true };
}
export function normalizeChatConfig(raw = {}, fallbackModels = ['claude-fable-5-1'], providers = loadProviders()) {
  const list = Array.isArray(raw.backends) && raw.backends.length ? raw.backends : (raw.models || fallbackModels).map(m => ({ provider: 'claude_gateway', model: m }));
  const backends = list.map(b => { try { return normalizeBackend(b, providers); } catch (e) { if (!e.unknown_provider) throw e; return unresolvedBackend(b, e); } });
  const ids = new Set();
  for (const b of backends) { if (ids.has(b.id)) throw Error(`backend id 重复：${b.id}`); ids.add(b.id); }
  // default 可能还是旧 id（裸模型名）：按模型名对上就换成新 id。
  const legacy = raw.default && !backends.some(b => b.id === raw.default) ? backends.find(b => b.model === raw.default || b.id.endsWith('/' + raw.default)) : null;
  const def = backends.some(b => b.id === raw.default) ? raw.default : legacy ? legacy.id : backends[0]?.id || null;
  return { ...raw, backends, default: def };
}
export const backendsToLines = (backends = []) => backends.map(b => [b.id, b.provider, b.model, b.effort || '', b.label || ''].join(' | ')).join('\n');
export function backendsFromLines(text = '', providers = loadProviders()) {
  return String(text).split('\n').map(s => s.trim()).filter(Boolean).map(line => { const [id, provider, model, effort, ...rest] = line.split('|').map(s => s.trim()); return normalizeBackend({ id: id || null, provider: provider || null, model, effort: effort || null, label: rest.join('|') || null }, providers); });
}

// ── 状态：登录态 / 凭据 ─────────────────────────────────────────────────────────
const ENV_CLEAN = env => { const e = { ...env }; for (const k of ['CLAUDECODE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN']) delete e[k]; return e; };
// 子进程只带登录目录（CLAUDE_CONFIG_DIR / CODEX_HOME），从不带 Claude 账号令牌：继承来的 CLAUDE_CODE_OAUTH_TOKEN 也去掉，
// 登录只认那个目录里 Claude Code 自己的登录。
export function providerEnv(p, base = process.env) {
  const env = ENV_CLEAN(base);
  if (p.kind === 'codex_exec' && p.codex_home) env.CODEX_HOME = abs(p.codex_home);
  if (p.kind === 'claude_code' && p.config_dir) env.CLAUDE_CONFIG_DIR = abs(p.config_dir);
  return env;
}
export async function providerStatus(key, providers = loadProviders()) {
  const p = providers[key];
  if (!p) return { key, ok: false, detail: '不在目录里' };
  try {
    if (p.kind === 'anthropic_http' || p.kind === 'openai_http') { const a = read(p.auth_file || 'private/claude-api.auth.json', null); return { key, ok: !!(a?.auth_token || a?.account_token) && hasProto(a.base_url), detail: a?.auth_token ? `凭据 ${p.auth_file} · ${hostOf(a.base_url)}${p.kind === 'openai_http' ? ' · ' + (p.wire_api || 'chat') : ''}` : `缺 ${p.auth_file}` }; }
    if (p.kind === 'codex_exec') {
      const home = abs(p.codex_home) || codexHome();
      if (p.codex_home && !fs.existsSync(home)) return { key, ok: false, detail: `登录目录 ${p.codex_home} 不存在` };
      // 中转用 bearer 的 codex 目录不需要 codex login。
      const own = codexProviders(codexConfigPath(home)).providers.find(x => x.id === p.codex_provider);
      if (own?.bearer && own.base_url) return { key, ok: true, detail: `bearer 已配置 · ${hostOf(own.base_url)}（不需要 codex login）· ${home}` };
      const r = await execFileP(process.env.RADAR_CODEX_BIN || 'codex', ['login', 'status'], { env: providerEnv(p), timeout: 15000 }).catch(e => ({ stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message) }));
      const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
      const ok = /logged in/i.test(text) && !/not logged in/i.test(text);
      const cfg = codexProviders(codexConfigPath(home));
      const providerOk = p.codex_provider === 'openai' || cfg.providers.some(x => x.id === p.codex_provider);
      return { key, ok: ok && providerOk, detail: `${text.split('\n')[0] || '未知'}${providerOk ? '' : `；该登录目录的 config.toml 里没有供应商 ${p.codex_provider}`} · ${home}` };
    }
    if (p.kind === 'claude_code') {
      const dir = abs(p.config_dir);
      if (p.config_dir && !fs.existsSync(dir)) return { key, ok: false, detail: `登录目录 ${p.config_dir} 不存在` };
      const r = await execFileP(process.env.RADAR_CLAUDE_BIN || 'claude', ['auth', 'status'], { env: providerEnv(p), timeout: 20000 }).catch(e => ({ stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message) }));
      let j = null; try { j = JSON.parse(String(r.stdout || '').trim()); } catch {} // 兜底：输出不是 JSON 就是 null，下面照实说「无法读取登录状态」
      const ok = !!j?.loggedIn;
      const login = `${dir ? `CLAUDE_CONFIG_DIR=${dir} ` : ''}claude auth login`;
      return { key, ok, detail: j ? (ok ? `已登录 · ${j.authMethod || ''} ${j.subscriptionType || ''} · ${dir || '~/.claude'}`.trim() : `未登录：在终端运行 ${login}`) : `无法读取登录状态：${String(r.stderr || r.stdout).slice(0, 120)}` };
    }
    return { key, ok: false, detail: `未知驱动 ${p.kind}` };
  } catch (e) { return { key, ok: false, detail: String(e.message).slice(0, 160) }; }
}
// 文字模型能不能用（不跑命令，只看本机文件和 PATH）：claude / codex 要在 PATH 上（或 RADAR_*_BIN 指的文件在）；
// Codex 另外要有登录（登录目录里的 auth.json）或自带 bearer 的中转；HTTP 供应商要有凭据文件里的 token；
// Claude 订阅问一次它登录目录里的 `claude auth status`。lib/setup.mjs 的清单和 lib/free-model.mjs 都用它。
export const onPath = (bin, override) => override ? fs.existsSync(override) : String(process.env.PATH || '').split(':').filter(Boolean).some(d => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } }); // 兜底：这个目录里没有或不能执行就看下一个目录
export function textBackendUsable(b) {
  if (b.kind === 'anthropic_http' || b.kind === 'openai_http') { const a = read(b.auth_file || 'private/claude-api.auth.json', null); return !!(a?.auth_token || a?.account_token); }
  // 在 PATH 上还不够：沙盒外再问一次登录状态（lib/model-truth.mjs cliLogin，缓存 10 分钟），问的是它自己的登录目录。
  if (b.kind === 'claude_code') return onPath('claude', process.env.RADAR_CLAUDE_BIN) && cliLogin('claude', { exe: process.env.RADAR_CLAUDE_BIN, env: providerEnv(b) }) !== 'out';
  if (b.kind === 'codex_exec') {
    if (!onPath('codex', process.env.RADAR_CODEX_BIN)) return false;
    const home = b.codex_home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (codexProviders(codexConfigPath(home)).providers.find(p => p.id === b.codex_provider)?.bearer) return true;
    return fs.existsSync(path.join(home, 'auth.json')) && cliLogin('codex', { exe: process.env.RADAR_CODEX_BIN, env: { ...process.env, CODEX_HOME: home } }) !== 'out';
  }
  return false;
}
// ── 本机运行时：这台电脑默认登录的 Claude Code / Codex（模板 config/model.example.json、chat.example.json 里原来就写着的两条）──
// 10-02 负责人：OfferCrew 补给用完或过期以后，模型链只换成你自己配过的（自己的 API key、登录的账号、你选过的本机运行时）；
// 不能悄悄改用本机的 Codex。你在引导或「设置 → 模型」里选过本机的，记在 state/model-local.json（lib/onboarding.mjs useLocalModel、
// lib/model-choice.mjs useTextModel 写），之后它才算你配过的。
export const LOCAL_PICK = 'state/model-local.json';
export const isLocalRuntime = b => !!b && (b.provider === 'claude_subscription' || (b.provider === 'openai' && !b.codex_home));
// 不给 b：选没选过任何一个本机运行时。给 b：选过的是不是它这一个（按 refs 里的供应商对：claude_subscription 是 Claude Code，
// openai 是 Codex；型号不论）——选过 Codex 不等于选过 Claude Code（兜底清单复核结论第 4 条，10-03 主会话）。
const pickedProviders = () => { try { const s = read(LOCAL_PICK, null); return s?.at ? new Set((Array.isArray(s.refs) ? s.refs : []).map(r => String(r).split('/')[0])) : null; } catch (e) { noteSwallowed('backends.localPick', e, { doing: '读你选过的本机模型记录', then: '当没选过' }); return null; } };
export function localPicked(b = null) { const set = pickedProviders(); return !!set && (!b || set.has(b.provider)); }
export function markLocalPicked(refs = [], now = Date.now()) {
  try { const old = read(LOCAL_PICK, null)?.refs, keep = Array.isArray(old) ? old.map(String) : []; write(LOCAL_PICK, { at: new Date(now).toISOString(), refs: [...new Set([...[...refs].map(String), ...keep])].slice(0, 4) }); } catch (e) { noteSwallowed('backends.localPick', e, { doing: '记下你选了哪个本机模型', then: '这次的设置照常保存' }); }
}
// 清单里有补给（供应商 offercrew）时：排在它后面、你没选过的本机运行时拿掉（选过 Codex 的只留 Codex）。排在它前面的本来就先用，不动。
export function dropUnpickedLocal(order = []) {
  const i = order.findIndex(b => b?.provider === 'offercrew');
  if (i < 0) return order;
  return order.filter((b, j) => j <= i || !isLocalRuntime(b) || localPicked(b));
}
export async function allStatuses(providers = loadProviders()) {
  const out = {};
  await Promise.all(Object.keys(providers).map(async k => { out[k] = await providerStatus(k, providers); }));
  return out;
}

// ── 探测可用模型 ─────────────────────────────────────────────────────────────
async function openaiModelList(base, token) {
  const url = String(base).replace(/\/+$/, ''), paths = [...new Set([url + '/models', url.replace(/\/v1$/, '') + '/v1/models'])];
  let endpoint, response;
  for (const candidate of paths) {
    try { response = await modelCall(() => fetch(candidate, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) })); }
    catch (e) {
      throw Error(`${hostOf(base)} 的 /models 请求失败（${e.message}${e.cause?.code ? ` · ${e.cause.code}` : ''}）；仍可手填型号并测试`, { cause: e });
    }
    if (response.ok) { endpoint = candidate; break; }
    // 只有端点未实现时试 /v1/models；认证、限流和服务故障不换路径掩盖原始状态。
    if (![404, 405].includes(response.status)) break;
  }
  if (!endpoint) throw Error(`${hostOf(base)} 的 /models 不可用（HTTP ${response.status}）；仍可手填型号并测试`);
  const found = [], wires = {}, readiness = {}, cursors = new Set();
  for (let page = 0; ; page++) {
    const d = await response.json(), list = d.data || d.models;
    if (!Array.isArray(list)) throw Error('模型目录的返回格式无法识别；仍可手填型号并测试');
    found.push(...list.map(m => typeof m === 'string' ? m : m.id || m.slug || m.name).filter(m => typeof m === 'string' && m.trim()));
    for (const m of list) if (m && typeof m === 'object') {
      const id = m.id || m.slug || m.name;
      if (id && ['chat', 'responses'].includes(m.wire)) wires[id] = m.wire;
      if (id && typeof m.ready === 'boolean') readiness[id] = m.ready;
    }
    if (!d.has_more) return { found, wires, readiness };
    const cursor = d.last_id || d.next_cursor || list.at(-1)?.id;
    if (!cursor || cursors.has(cursor) || page >= 99) throw Error('模型目录分页尚未读完；请稍后刷新，已有型号已保留');
    cursors.add(cursor);
    const next = new URL(endpoint); next.searchParams.set('after', cursor);
    response = await modelCall(() => fetch(next, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) }));
    if (!response.ok) throw Error(`模型目录下一页返回 ${response.status}；已有型号已保留`);
  }
}
export async function discoverModels(key, providers = loadProviders()) {
  const p = providers[key];
  if (!p) throw Error('不在目录里');
  const identity = provider => hash([provider?.kind, provider?.auth_file, provider?.auth_file ? read(provider.auth_file, {}) : null, provider?.codex_home, provider?.codex_provider, provider?.config_dir]);
  const startedWith = identity(p);
  let found = [], source = '';
  if (p.kind === 'anthropic_http') {
    const a = read(p.auth_file || 'private/claude-api.auth.json', null);
    if (!a?.auth_token) throw Error(`缺 ${p.auth_file}`);
    // 官方 SDK（lib/claude-api.mjs），有代理走代理。
    const { claudeModelList } = await import('./claude-api.mjs');
    found = (await modelCall(() => claudeModelList(a)).catch(e => { throw Error(`${hostOf(a.base_url)} 的 /v1/models 不可用（${String(e.message).slice(0, 80)}）`); })).filter(Boolean); source = `${hostOf(a.base_url)}/v1/models`;
  } else if (p.kind === 'codex_exec') {
    const home = abs(p.codex_home) || codexHome();
    if (p.codex_provider === 'openai') {
      const cache = path.join(home, 'models_cache.json');
      if (!fs.existsSync(cache)) throw Error(`没有 ${cache}（先用该账号跑一次 codex，它会拉取模型目录）`);
      const j = JSON.parse(fs.readFileSync(cache, 'utf8'));
      const list = (j.models || []).filter(m => !m.visibility || m.visibility === 'list');
      found = list.map(m => m.slug || m.id).filter(Boolean);
      const efforts = [...new Set(list.flatMap(m => (m.supported_reasoning_levels || []).map(x => x.effort)))].filter(e => EFFORTS.includes(e));
      if (efforts.length) p.efforts = efforts;
      source = `${cache}（${j.fetched_at || ''}）`;
    } else {
      const cfg = codexProviders(codexConfigPath(home)).providers.find(x => x.id === p.codex_provider);
      if (!cfg?.base_url) throw Error(`config.toml 里没有供应商 ${p.codex_provider} 的 base_url`);
      if (!cfg.bearer) throw Error(`供应商 ${p.codex_provider} 没有 experimental_bearer_token，无法调用 /v1/models`);
      found = (await openaiModelList(cfg.base_url, cfg.bearer)).found; source = `${hostOf(cfg.base_url)}/models`;
    }
  } else if (p.kind === 'openai_http') {
    const a = read(p.auth_file, null);
    if (!(a?.account_token || a?.auth_token)) throw Error(`缺 ${p.auth_file}`);
    const result = await openaiModelList(a.base_url, a.account_token || a.auth_token);
    found = result.found; p.model_wires = result.wires; p.model_readiness = result.readiness; source = `${hostOf(a.base_url)}/models`;
  } else if (p.kind === 'claude_code') {
    throw Error('Claude 官方订阅没有模型列表接口；手工添加模型名后用「测」验证');
  }
  found = [...new Set(found.map(m => String(m).trim()).filter(Boolean))];
  // 网络请求期间可能新增了供应商、手填了型号或换了 Key：只并入这一份目录，保留新的设置。
  const latest = loadProviders(), current = latest[key];
  if (!current || identity(current) !== startedWith) throw Error('供应商设置已改变，请用新配置刷新目录；已保存的型号未修改');
  const added = found.filter(m => !current.models.includes(m));
  current.models = [...new Set([...current.models, ...found])];
  current.discovered = found; current.discovered_at = new Date().toISOString(); current.discovered_from = source;
  for (const field of ['efforts', 'model_wires', 'model_readiness']) if (p[field]) current[field] = p[field];
  saveProviders(latest);
  return { key, found, added, source, models: current.models, efforts: current.efforts };
}
export function setProviderModels(key, models, providers = loadProviders()) {
  const p = providers[key];
  if (!p) throw Error('不在目录里');
  const list = [...new Set((Array.isArray(models) ? models : String(models || '').split(/[\n,，、\s]+/)).map(x => String(x).trim()).filter(Boolean))];
  if (!list.length) throw Error('至少留一个模型');
  p.models = list;
  saveProviders(providers);
  return { key, models: list };
}
export function setProviderLabel(key, label, providers = loadProviders()) {
  const p = providers[key]; if (!p) throw Error('不在目录里');
  p.label = String(label || '').trim().slice(0, 80) || p.label; saveProviders(providers); return { key, label: p.label };
}

// ── 多账号：同一驱动、独立登录目录 ───────────────────────────────────────────────
export const ACCOUNT_BASES = { openai: { kind: 'codex_exec', codex_provider: 'openai', label: 'OpenAI 官方订阅 · Codex 登录', login: home => `CODEX_HOME=${home} codex login`, status: home => `CODEX_HOME=${home} codex login status` }, claude_subscription: { kind: 'claude_code', label: 'Claude 官方订阅 · Claude Code 登录', login: dir => `CLAUDE_CONFIG_DIR=${dir} claude auth login`, status: dir => `CLAUDE_CONFIG_DIR=${dir} claude auth status` } };
export function addAccount({ base, name, label = null }, providers = loadProviders()) {
  const b = ACCOUNT_BASES[base];
  if (!b) throw Error(`只能给 ${Object.keys(ACCOUNT_BASES).join(' / ')} 加账号`);
  const n = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(n)) throw Error('账号名用小写字母、数字、-、_，1–24 位');
  const key = `${base}@${n}`;
  if (providers[key]) throw Error(`已有账号 ${key}`);
  const dir = `private/accounts/${key}`;
  fs.mkdirSync(file(dir), { recursive: true, mode: 0o700 });
  if (b.kind === 'codex_exec') fs.writeFileSync(path.join(file(dir), 'config.toml'), `# ${BRAND} 账号 ${key}：只用内置 openai 供应商（ChatGPT 官方订阅）。\nmodel_provider = "openai"\n`, { flag: 'wx' });
  providers[key] = { label: label || `${b.label}（账号 ${n}）`, kind: b.kind, ...(b.kind === 'codex_exec' ? { codex_provider: 'openai', codex_home: dir } : { config_dir: dir }), models: [...providers[base]?.models || (b.kind === 'codex_exec' ? ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5'] : KNOWN_MODELS.claude)], efforts: providers[base]?.efforts || (b.kind === 'codex_exec' ? [...EFFORTS] : EFFORTS.slice(0, 3)), account: true, created_at: new Date().toISOString() };
  saveProviders(providers);
  const absDir = file(dir);
  return { key, dir, login_command: b.login(absDir), status_command: b.status(absDir), note: b.kind === 'claude_code' ? '在终端跑登录命令并完成浏览器授权；登录态只存在这个目录里，不影响默认账号。' : '在终端跑登录命令（会打开浏览器）；登录态存在这个目录的 auth.json 里。' };
}
export function removeAccount(key, providers = loadProviders()) { return removeProvider(key, providers); }
// 登录命令（给界面显示）。
export function loginHints(key, providers = loadProviders()) {
  const p = providers[key]; if (!p) return null;
  if (p.kind === 'codex_exec') { const home = abs(p.codex_home); return { login: `${home ? `CODEX_HOME=${home} ` : ''}codex login`, status: `${home ? `CODEX_HOME=${home} ` : ''}codex login status` }; }
  if (p.kind === 'claude_code') { const dir = abs(p.config_dir); return { login: `${dir ? `CLAUDE_CONFIG_DIR=${dir} ` : ''}claude auth login`, status: `${dir ? `CLAUDE_CONFIG_DIR=${dir} ` : ''}claude auth status` }; }
  return { login: p.user ? `在「模型目录」这张卡上改地址 / 密钥（写入 ${p.auth_file}）` : `把网关凭据写到 ${p.auth_file}（provider、base_url、令牌）`, status: null };
}
// ── 自己加供应商：任意 Anthropic 兼容 / OpenAI 兼容的 HTTP API，或 Codex 的 Responses 中转 ────
const tomlStr = v => JSON.stringify(String(v));
export function addProvider({ key, label = null, kind, base_url, api_key, models = [], wire_api = 'chat', efforts = null } = {}, providers = loadProviders()) {
  const k = String(key || '').trim().toLowerCase();
  if (!PROVIDER_KEY.test(k)) throw Error('供应商 key 用小写字母开头，字母、数字、-、_，2–32 位');
  if (providers[k]) throw Error(`已有供应商 ${k}`);
  if (!['anthropic_http', 'openai_http', 'codex_exec'].includes(kind)) throw Error('协议只能是 anthropic_http / openai_http / codex_exec（Claude 官方订阅账号请用「添加账号」）');
  const base = String(base_url || '').trim().replace(/\/$/, '');
  if (!hasProto(base)) throw Error('base_url 要以 http(s):// 开头');
  const token = String(api_key || '').trim();
  if (!token) throw Error('缺 API key');
  const list = [...new Set((Array.isArray(models) ? models : String(models || '').split(/[\n,，、\s]+/)).map(x => String(x).trim()).filter(Boolean))];
  const at = new Date().toISOString();
  let entry;
  if (kind === 'codex_exec') {
    // 一个雷达自己的 codex 目录：config.toml 里只有这一家中转（Responses 接口 + bearer），不碰 ~/.codex。
    const dir = `private/accounts/codex@${k}`;
    fs.mkdirSync(file(dir), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(file(dir), 'config.toml'), `# ${BRAND} 供应商 ${k}（工作台添加）。\nmodel_provider = ${tomlStr(k)}\n[model_providers.${k}]\nname = ${tomlStr(k)}\nbase_url = ${tomlStr(base)}\nwire_api = "responses"\nrequires_openai_auth = true\nexperimental_bearer_token = ${tomlStr(token)}\n`, { mode: 0o600 });
    entry = { label: label || `${k} · ${hostOf(base)} · Codex`, kind, codex_provider: k, codex_home: dir, models: list.length ? list : [...KNOWN_MODELS.gpt], efforts: efforts || [...EFFORTS], user: true, created_at: at };
  } else {
    const authFile = `private/providers/${k}.auth.json`;
    fs.mkdirSync(file('private/providers'), { recursive: true, mode: 0o700 });
    write(authFile, { provider: k, base_url: base, auth_token: token, ...(kind === 'openai_http' ? { wire_api: wire_api === 'responses' ? 'responses' : 'chat' } : {}) });
    fs.chmodSync(file(authFile), 0o600);
    entry = { label: label || `${k} · ${hostOf(base)}`, kind, auth_file: authFile, models: list.length ? list : (kind === 'anthropic_http' ? [...KNOWN_MODELS.claude] : []), efforts: efforts || [], ...(kind === 'openai_http' ? { wire_api: wire_api === 'responses' ? 'responses' : 'chat' } : {}), user: true, created_at: at };
  }
  providers[k] = entry;
  saveProviders(providers);
  return { key: k, kind, label: entry.label, auth_file: entry.auth_file || null, dir: entry.codex_home || null, models: entry.models, note: kind === 'codex_exec' ? '中转必须支持 Responses 接口；用「测」验证。' : kind === 'openai_http' ? `按 ${entry.wire_api} 接口调用；不确定就用「测」验证，不通再改成另一种。` : '按 /v1/messages 调用。' };
}
export function updateProvider(key, { label, base_url, api_key, models, wire_api } = {}, providers = loadProviders()) {
  const p = providers[key];
  if (!p) throw Error('不在目录里');
  const changed = [];
  if (label != null && String(label).trim()) { p.label = String(label).trim().slice(0, 80); changed.push('label'); }
  if (models != null) { const list = [...new Set((Array.isArray(models) ? models : String(models).split(/[\n,，、\s]+/)).map(x => String(x).trim()).filter(Boolean))]; if (!list.length) throw Error('至少留一个模型'); p.models = list; changed.push('models'); }
  if ((base_url != null && String(base_url).trim()) || (api_key != null && String(api_key).trim()) || (wire_api != null && p.kind === 'openai_http')) {
    if (p.kind === 'anthropic_http' || p.kind === 'openai_http') {
      const a = read(p.auth_file, {}) || {};
      if (base_url != null && String(base_url).trim()) { const b = String(base_url).trim().replace(/\/$/, ''); if (!hasProto(b)) throw Error('base_url 要以 http(s):// 开头'); a.base_url = b; changed.push('base_url'); }
      if (api_key != null && String(api_key).trim()) { a.auth_token = String(api_key).trim(); changed.push('api_key'); }
      if (wire_api != null && p.kind === 'openai_http') { p.wire_api = wire_api === 'responses' ? 'responses' : 'chat'; a.wire_api = p.wire_api; changed.push('wire_api'); }
      a.provider = a.provider || key;
      fs.mkdirSync(path.dirname(file(p.auth_file)), { recursive: true });
      write(p.auth_file, a); fs.chmodSync(file(p.auth_file), 0o600);
    } else if (p.kind === 'codex_exec' && p.user) {
      const cfgPath = path.join(file(p.codex_home), 'config.toml');
      const cur = codexProviders(cfgPath).providers.find(x => x.id === p.codex_provider) || {};
      const b = base_url != null && String(base_url).trim() ? String(base_url).trim().replace(/\/$/, '') : cur.base_url;
      const t = api_key != null && String(api_key).trim() ? String(api_key).trim() : cur.bearer;
      if (!hasProto(b)) throw Error('base_url 要以 http(s):// 开头');
      fs.writeFileSync(cfgPath, `# ${BRAND} 供应商 ${key}（工作台添加）。\nmodel_provider = ${tomlStr(key)}\n[model_providers.${key}]\nname = ${tomlStr(key)}\nbase_url = ${tomlStr(b)}\nwire_api = "responses"\nrequires_openai_auth = true\nexperimental_bearer_token = ${tomlStr(t || '')}\n`, { mode: 0o600 });
      if (base_url != null) changed.push('base_url'); if (api_key != null) changed.push('api_key');
    } else throw Error(`这个供应商的地址和密钥不在 ${BRAND} 管理范围内（Codex 默认账号请改 ~/.codex/config.toml）`);
  }
  if (!changed.length) throw Error('没有要改的字段');
  saveProviders(providers);
  return { key, changed };
}
export function removeProvider(key, providers = loadProviders()) {
  const p = providers[key];
  if (!p) throw Error('不在目录里');
  if (!p.account && !p.user) throw Error('只能删除自己加的供应商或账号');
  delete providers[key];
  saveProviders(providers);
  return { key, kept: p.codex_home || p.config_dir || p.auth_file || null, note: '凭据 / 登录目录保留在 private/ 下，确认不用再手动删除。' };
}
// 目录视图（给界面）。
export function catalog(providers = loadProviders()) {
  return Object.values(providers).map(p => { const a = (p.kind === 'anthropic_http' || p.kind === 'openai_http') ? read(p.auth_file || '', null) : null; return { key: p.key, label: p.label, kind: p.kind, kind_label: KINDS[p.kind] || p.kind, wire_api: p.wire_api || null, base_host: a ? hostOf(a.base_url) : null, models: p.models, ...(p.notes ? { notes: p.notes } : {}), efforts: p.efforts || [], account: !!p.account, user: !!p.user, removable: !!(p.account || p.user), editable_auth: p.kind === 'anthropic_http' || p.kind === 'openai_http' || (p.kind === 'codex_exec' && !!p.user), codex_provider: p.codex_provider || null, home: p.codex_home || p.config_dir || (p.kind === 'codex_exec' ? '~/.codex' : p.kind === 'claude_code' ? '~/.claude' : p.auth_file), discovered_at: p.discovered_at || null, discovered_from: p.discovered_from || null, discoverable: p.kind !== 'claude_code', hints: loginHints(p.key, providers) }; });
}
