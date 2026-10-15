// 文字调用（匹配、简历抽取、求职信 / AI 重写、对话）走本机 claude / codex 时，只把它们当纯文字模型用。
//
// 这些调用的输入里有 JD、邮件、网页、简历这类不可信材料；提示词说了「不要用工具」，但那只是请求。
// 这里让它真的没有手：claude 不给内置工具、不连 MCP、不读用户 / 项目设置（也就没有钩子和插件）、
// 不留会话记录，并在一个空的临时目录里跑（不读仓库里的 CLAUDE.md）；codex 关掉 shell、连接器、
// 浏览器、电脑操作、插件、钩子、子代理、生图这些 feature，再把本机 config.toml 里配的每个 MCP
// 服务器设成 enabled=false。未知的 feature 名 codex 会忽略，老版本也能跑。
// 执行器（bin/host/run-now.sh、radar-cycle.sh、mail-poll.sh）是另一回事：它们本来就要动手，不走这里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_TEXT_ARGS = Object.freeze(['--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence']);

export const CODEX_TEXT_FEATURES_OFF = Object.freeze([
  'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'in_app_local_automation', 'plugins', 'remote_plugin', 'hooks', 'multi_agent',
  'image_generation', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'view_image', 'goals',
  'code_mode_host', 'workspace_dependencies', 'web_search_request',
]);

// config.toml 里的 [mcp_servers.<名>]（含 [mcp_servers.<名>.env] 这类子表）→ 服务器名，去重、保持顺序。
export function codexMcpServers(configPath) {
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return []; } // 兜底：配置文件不在就没有
  const names = [];
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^\[\s*mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|'([^']+)'|([A-Za-z0-9_-]+))/);
    const name = m && (m[1] ?? m[2] ?? m[3]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
const tomlKey = (name) => /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
export const codexHomeOf = (backend = {}, env = process.env) => backend.codex_home || env.CODEX_HOME || path.join(os.homedir(), '.codex');

export function codexTextArgs(home) {
  return [
    ...CODEX_TEXT_FEATURES_OFF.flatMap((f) => ['-c', `features.${f}=false`]),
    ...codexMcpServers(path.join(home, 'config.toml')).flatMap((n) => ['-c', `mcp_servers.${tomlKey(n)}.enabled=false`]),
  ];
}

// 模板里写 default 的模型 = 不传 --model，让 claude / codex 用它自己的默认型号（别名 sonnet / opus 照常传）。
export const cliModel = (model) => (model && !/^default$/i.test(String(model).trim()) ? String(model) : null);

// claude -p --output-format json 的外壳：{type:'result', result: 回答正文, usage, modelUsage, total_cost_usd}。回答照旧交给调用方，
// 用量和实际型号（别名 sonnet 用的是哪一个）记进用量账（lib/usage.mjs）。不是这种外壳（老版本、测试里的假 claude 只吐正文）
// 就当正文用，用量记空。
export function claudeResult(out) {
  let env = null; try { env = JSON.parse(String(out || '').trim()); } catch {} // 兜底：输出不是 JSON 就是 null，下面照实说
  if (!env || env.type !== 'result' || typeof env.result !== 'string') return { text: String(out || ''), usage: null, model: null, cost_usd: null };
  if (env.is_error) throw Object.assign(Error(`claude_code_error: ${String(env.result || env.subtype || '').slice(0, 200)}`), { retryable: true });
  const per = Object.entries(env.modelUsage || {}).filter(([, u]) => u && (u.inputTokens || u.outputTokens)).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  return { text: env.result, usage: per.length === 1 ? per[0][1] : env.usage || null, model: per[0]?.[0] || null, cost_usd: Number.isFinite(Number(env.total_cost_usd)) ? Number(env.total_cost_usd) : null };
}
// claude 在一个空目录里跑，调用完删掉。
export const claudeTextDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'radar-claude-'));

// ── 演示 / 沙盒模式开着模型（RADAR_SANDBOX_MODELS=1，lib/sandbox.mjs sandboxModels）────────────────────
// 其中 Codex 的文字调用钉死在 Codex 内置的 OpenAI 供应商（ChatGPT 官方订阅登录）：命令行上的 -c 比 config.toml
// 优先，内置供应商 id 不能被 config.toml 改写，base_url 也钉回官方的 ChatGPT Codex 地址——切换供应商的工具把
// config.toml 切到哪个中转，沙盒里的 Codex 调用都不会经过它。环境里的 OPENAI_BASE_URL / API key 也不带进去。
export const CODEX_OFFICIAL_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_OFFICIAL_PIN = Object.freeze(['-c', 'model_provider="openai"', '-c', `openai_base_url="${CODEX_OFFICIAL_URL}"`, '-c', `chatgpt_base_url="https://chatgpt.com/backend-api/"`]);
const PIN_STRIP_ENV = ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
// 登录目录就是环境里的 CODEX_HOME（跑沙盒的人自己的，没设就是 codex 的默认 ~/.codex）；这里不读它里面的任何东西。
export function sandboxCodexEnv(env, base = process.env) {
  const out = { ...env };
  for (const k of PIN_STRIP_ENV) delete out[k];
  if (base.CODEX_HOME) out.CODEX_HOME = base.CODEX_HOME; else delete out.CODEX_HOME;
  return out;
}
// codex exec 的供应商参数：沙盒里是上面的钉子，平时是目录里的供应商。
export const codexProviderArgs = (b, pinned) => pinned ? [...CODEX_OFFICIAL_PIN] : b.codex_provider ? ['-c', `model_provider=${b.codex_provider}`] : [];
// 沙盒里只放行这一种 codex：exec、只读、上面的供应商钉子、文字调用的 feature 全关；供应商只能是 openai。
// 执行器那种要动手的 codex（danger-full-access、--full-auto、别的供应商）一律不是它。
export function pinnedTextCodex(args = []) {
  const a = args.map(String), pairs = new Set(), providers = [];
  if (a[0] !== 'exec') return false;
  for (let i = 0; i < a.length; i++) {
    if (/^--(dangerously|full-auto|yolo|add-dir|profile)/.test(a[i]) || a[i] === '-p') return false;
    if (a[i] === '-c' || a[i] === '--config' || a[i] === '--sandbox' || a[i] === '-s') { pairs.add(`${a[i] === '--config' ? '-c' : a[i] === '-s' ? '--sandbox' : a[i]} ${a[i + 1]}`); if (a[i] !== '--sandbox' && a[i] !== '-s' && /^model_provider\s*=/.test(String(a[i + 1]))) providers.push(a[i + 1]); if ((a[i] === '--sandbox' || a[i] === '-s') && a[i + 1] !== 'read-only') return false; i++; }
  }
  const need = [['--sandbox', 'read-only'], ...[0, 2, 4].map(i => [CODEX_OFFICIAL_PIN[i], CODEX_OFFICIAL_PIN[i + 1]]), ...CODEX_TEXT_FEATURES_OFF.map(f => ['-c', `features.${f}=false`])];
  return need.every(([k, v]) => pairs.has(`${k} ${v}`)) && providers.every(p => p === CODEX_OFFICIAL_PIN[1]);
}
// 沙盒里用哪些文字底座：清单照旧（网关、Claude 订阅、自己的 key、OfferCrew 补给都是文字模型，照常走）；其中 Codex 的
// 那几个供应商改成官方 openai、登录目录用环境里的 CODEX_HOME。清单是空的就用 Codex 的默认型号。
export const SANDBOX_CODEX = Object.freeze({ id: 'openai/default', provider: 'openai', model: 'default', effort: null, label: 'OpenAI 官方订阅 · Codex（沙盒）', kind: 'codex_exec', auth_file: null, wire_api: null, codex_provider: 'openai', codex_home: null, config_dir: null, provider_label: 'OpenAI 官方订阅 · Codex 登录' });
export function sandboxTextOrder(order = []) {
  const seen = new Set(), own = [];
  for (const b of order) {
    if (!b) continue;
    if (b.kind !== 'codex_exec') { own.push(b); continue; }
    if (seen.has(b.model || 'default')) continue;
    seen.add(b.model || 'default');
    own.push({ ...b, provider: 'openai', codex_provider: 'openai', codex_home: null });
  }
  return own.length ? own : [{ ...SANDBOX_CODEX }];
}
// 沙盒里放行的 claude：只有文字调用那一种（-p、一轮、没有工具、不连 MCP、不读设置、不留会话）。执行器那种不是它。
export function pinnedTextClaude(args = []) {
  const a = args.map(String), has = (k, v) => a.some((x, i) => x === k && (v === undefined || a[i + 1] === v));
  if (a.some(x => /^--(dangerously|permission-mode|allowedTools|allowed-tools|add-dir|mcp-config|continue|resume|agents)/.test(x))) return false;
  return has('-p') && has('--max-turns', '1') && has('--tools', '') && has('--strict-mcp-config') && has('--setting-sources', '') && has('--no-session-persistence');
}
