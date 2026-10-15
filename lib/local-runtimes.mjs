// 这台电脑上装了哪些 AI 运行时（R23，10-11 负责人「就像 Paseo 一样，可以直接检测到」）：Claude Code、Codex 各一行，
// 写清版本、登录了没有、用的是哪种身份、能不能用。只跑本机只读的四条命令（--version、claude auth status、codex login status），
// 不调模型；只判断凭据有没有配置，不返回或记录值；OfferCrew 里不放登录流程，没登录的照实说在哪里登录。
//
// detectRuntimes() → [{ kind, name, installed, path, version, login: 'in'|'out'|'unknown', identity, identity_label, usable, state, remedy }]
//   identity：subscription · api_key · gateway_token · gateway_key · token · cloud · helper · null
// 结果缓存 10 分钟（命令路径、修改时间、登录目录变了就重查）；fresh: true 当场重查（页面上的「重新检测」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from './spawn.mjs';
import { LOCAL_AI_NAMES } from './local-ai-errors.mjs';

export const LOGIN_WHERE = {
  claude: '在终端里运行 claude，输入 /login 登录（或在 Claude Code 的设置里配好 API key），再回来点「重新检测」。',
  codex: '在终端里运行 codex login 登录（ChatGPT 账号或 API key），再回来点「重新检测」。',
};
const INSTALL_WHERE = {
  claude: '没找到 claude 命令。装好 Claude Code（claude.ai/download）后点「重新检测」。',
  codex: '没找到 codex 命令。装好 Codex CLI（brew install codex 或 npm i -g @openai/codex）后点「重新检测」。',
};
const IDENTITY = {
  claude: { subscription: 'claude.ai 账号', api_key: 'API key', bearer_token: 'API token', gateway_token: '自定义网关 · token', gateway_key: '自定义网关 · API key', token: '长期令牌', cloud: '云平台凭据', helper: '凭据脚本' },
  codex: { subscription: 'ChatGPT 账号', api_key: 'API key' },
};

// 与 run-now.sh 拉起 CLI 时的搜索路径一致（App 从 Finder 启动时 PATH 很短）。
export const localCliPath = (env = process.env) => env.RADAR_PATH || [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.nvm/versions/node/v22.21.0/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', env.PATH || ''].join(path.delimiter);
export function cliPath(kind, env = process.env) {
  const override = env[kind === 'claude' ? 'RADAR_CLAUDE_BIN' : 'RADAR_CODEX_BIN'];
  const paths = override ? [override] : localCliPath(env).split(path.delimiter).filter(Boolean).map(dir => path.join(dir, kind));
  return paths.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }) || null; // 兜底：不存在或不能执行的路径继续找下一个。
}

const cache = new Map(), TTL = 10 * 60e3;
// codex login status 把结果写在 stderr 上：两路都收。
const run = (exe, args, env) => {
  const r = spawnSync(exe, args, { env, cwd: env.RADAR_ROOT || undefined, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const timeout = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return { ok: !r.error && r.status === 0, stdout: String(r.stdout || ''), out: `${r.stdout || ''}\n${r.stderr || ''}`, timeout, blocked: !timeout && !!r.error };
};
const versionOf = s => String(s || '').match(/\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?/)?.[0] || null;

// auth status 把 bearer token 也叫 oauth_token，不能凭 ~/.claude.json 里残留的账号判身份。
// 与 CLI 的 env 合并顺序一致；只把存在性和端点种类留在结果里。优先级来自 Claude Code authentication 文档：
// 云平台 > AUTH_TOKEN > API_KEY > apiKeyHelper > OAUTH_TOKEN > 登录账号。
const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
// Claude Code 2.1.296 的 auth status 实测：1/true/yes/on（忽略大小写与空格）启用；0/false/no/off/其他值关闭。
const enabled = value => /^(1|true|yes|on)$/i.test(String(value || '').trim());
const AUTH_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const jsonAt = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }; // 兜底：读不了的配置不猜身份，仍以 CLI 登录检测为准。
const claudeDir = env => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
const configFiles = env => {
  const cwd = env.RADAR_ROOT || process.cwd();
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : process.platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode/managed-settings.json') : '/etc/claude-code/managed-settings.json';
  return [path.join(claudeDir(env), 'settings.json'), path.join(cwd, '.claude/settings.json'), path.join(cwd, '.claude/settings.local.json'), managed];
};
const customEndpoint = value => { try { return !!value && new URL(value).hostname !== 'api.anthropic.com'; } catch { return !!value; } }; // 兜底：无效的自定义地址仍不是官方端点。
function claudeIdentity(env, status) {
  const effective = Object.fromEntries(AUTH_VARS.map(k => [k, env[k]]));
  let helper = false;
  for (const f of configFiles(env)) {
    const c = jsonAt(f); if (!c) continue;
    if (Object.hasOwn(c, 'apiKeyHelper')) helper = !!c.apiKeyHelper;
    // Hosts that manage a provider themselves tell Claude to ignore provider/auth env in settings.
    if (!enabled(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) for (const k of AUTH_VARS) if (typeof c.env?.[k] === 'string') effective[k] = c.env[k];
  }
  const has = k => !!String(effective[k] || '').trim();
  const gateway = customEndpoint(effective.ANTHROPIC_BASE_URL);
  const method = String(status.authMethod || '');
  if (/gateway/i.test(method)) return 'gateway_token';
  if (CLOUD_FLAGS.some(k => enabled(effective[k])) || /bedrock|vertex|foundry/i.test(String(status.apiProvider || ''))) return 'cloud';
  if (has('ANTHROPIC_AUTH_TOKEN')) return gateway ? 'gateway_token' : 'bearer_token';
  if (has('ANTHROPIC_API_KEY') || method === 'api_key' || status.apiKeySource) return gateway ? 'gateway_key' : 'api_key';
  if (helper) return 'helper';
  if (has('CLAUDE_CODE_OAUTH_TOKEN')) return 'token';
  if (/claude.?ai/i.test(method)) return 'subscription';
  const dir = status.configDirectory || claudeDir(env);
  const accountFiles = [path.join(dir, '.claude.json'), ...(!env.CLAUDE_CONFIG_DIR ? [path.join(env.HOME || os.homedir(), '.claude.json')] : [])];
  if (/oauth|claude/.test(method)) return accountFiles.some(f => !!jsonAt(f)?.oauthAccount) ? 'subscription' : 'token';
  return null;
}
function claudeLogin(exe, env) {
  const r = run(exe, ['auth', 'status'], env);
  if (r.timeout || r.blocked) return { login: 'unknown', identity: null };
  let j = null; try { j = JSON.parse(r.stdout.trim()); } catch {} // 兜底：旧版没有 JSON 输出，按退出码算。
  if (!j) return { login: r.ok ? 'in' : 'out', identity: null };
  if (!r.ok || j.loggedIn !== true) return { login: j.loggedIn === false ? 'out' : 'unknown', identity: null };
  return { login: 'in', identity: claudeIdentity(env, j) };
}
// Codex：codex login status（退出码 0 = 登录了；文字里写着 ChatGPT 还是 API key）。只设环境变量 OPENAI_API_KEY 它也报没登录，照它说的。
function codexLogin(exe, env) {
  const r = run(exe, ['login', 'status'], env);
  if (r.timeout || r.blocked) return { login: 'unknown', identity: null };
  const t = r.out;
  if (!r.ok || /not logged in/i.test(t)) return { login: 'out', identity: null };
  return { login: 'in', identity: /chatgpt/i.test(t) ? 'subscription' : /api key/i.test(t) ? 'api_key' : null };
}

function detectOne(kind, env) {
  const name = LOCAL_AI_NAMES[kind], exe = cliPath(kind, env);
  if (!exe) return { kind, name, installed: false, path: null, version: null, login: 'unknown', identity: null, identity_label: null, usable: false, state: '没装', remedy: INSTALL_WHERE[kind] };
  const childEnv = { ...env, PATH: localCliPath(env) }; delete childEnv.CLAUDECODE;
  const v = run(exe, ['--version'], childEnv), version = v.ok ? versionOf(v.out) : null;
  const l = kind === 'claude' ? claudeLogin(exe, childEnv) : codexLogin(exe, childEnv);
  const identity_label = l.identity ? IDENTITY[kind][l.identity] : null;
  const state = l.login === 'out' ? '没登录' : l.login === 'unknown' ? '登录状态没查到' : identity_label ? `已登录 · ${identity_label}` : '已登录';
  return { kind, name, installed: true, path: exe, version, login: l.login, identity: l.identity, identity_label, usable: l.login === 'in', state,
    remedy: l.login === 'out' ? LOGIN_WHERE[kind] : l.login === 'unknown' ? `查登录状态超时了。在终端里运行 ${kind === 'claude' ? 'claude auth status' : 'codex login status'} 看看，再点「重新检测」。` : null };
}

const keyOf = (kind, env) => {
  const exe = cliPath(kind, env);
  let m = 0; try { m = exe ? fs.statSync(exe).mtimeMs : 0; } catch {} // 兜底：读不到修改时间就只按路径缓存
  const files = kind === 'claude' ? configFiles(env) : [path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json')];
  const sig = files.map(f => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } }); // 兜底：配置尚不存在也参与缓存键，创建后立即重查。
  const flags = kind === 'claude' ? [...AUTH_VARS.map(k => k === 'ANTHROPIC_BASE_URL' ? customEndpoint(env[k]) : CLOUD_FLAGS.includes(k) ? enabled(env[k]) : !!env[k]), enabled(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)] : [];
  return [kind, exe, m, env.HOME || '', env.CODEX_HOME || '', env.CLAUDE_CONFIG_DIR || '', env.RADAR_ROOT || process.cwd(), ...sig, ...flags].join('|');
};
export function detectRuntimes({ env = process.env, fresh = false, now = Date.now() } = {}) {
  if (fresh) cache.clear(); // 重新检测也清掉旧 App 账号目录的读数，下次设置页读同一个新状态。
  return Object.keys(LOCAL_AI_NAMES).map(kind => {
    const k = keyOf(kind, env), hit = cache.get(k);
    if (!fresh && hit && now - hit.at < TTL) return hit.value;
    const value = { ...detectOne(kind, env), checked_at: new Date(now).toISOString() };
    cache.set(k, { value, at: now });
    return value;
  });
}
export const clearRuntimeCache = () => cache.clear();
export const runtimeOf = (kind, opts) => detectRuntimes(opts).find(r => r.kind === kind) || null;
