// 「模型现在能不能用」只有一个答案（2026-09-30 发版前打磨）：右侧面板、设置 → 模型、引导的模型一步、检查清单、
// 团队卡片和成员页都从这里读。
//   sandboxNote()   演示 / 沙盒模式（没开 RADAR_SANDBOX_MODELS）：一律不调模型，所有地方都写这一句
//   cliLogin(bin)   这台电脑上的 claude / codex 有没有登录：PATH 上有这个命令不等于能用。沙盒外才跑
//                   `claude auth status` / `codex login status`（4 秒超时），结果缓存 10 分钟；
//                   'in' 登录了 · 'out' 找到了但没登录 · 'unknown' 没查（沙盒里、超时）——unknown 不拦
//   modelLabel()    供应商 / 模型 id 的人话（claude_subscription/sonnet → Claude Code · Sonnet）
import { execFileSync } from './spawn.mjs';
import { sandboxed, sandboxModels } from './sandbox.mjs';
import { modelWords } from '../web/labels.js';

export const SANDBOX_NOTE = '演示 / 沙盒模式不调用模型';
export const NOT_LOGGED_IN = '找到了，但还没登录';
export const sandboxNote = () => (sandboxed() && !sandboxModels() ? SANDBOX_NOTE : null);

const cache = new Map(), TTL = 10 * 60e3;
export function cliLogin(bin, { exe = null, env = process.env, now = Date.now() } = {}) {
  // 沙盒里（包括开了 RADAR_SANDBOX_MODELS）一律不跑这两条命令：沙盒只放行调模型的命令，别的会被拦下，拦下不等于没登录。
  if (sandboxed()) return 'unknown';
  const cmd = exe || bin, key = [bin, cmd, env.PATH || '', env.CODEX_HOME || '', env.CLAUDE_CONFIG_DIR || ''].join('|'), hit = cache.get(key);
  if (hit && now - hit.at < TTL) return hit.state;
  let state;
  try {
    const out = execFileSync(cmd, bin === 'claude' ? ['auth', 'status'] : ['login', 'status'], { env, timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    let j = null; try { j = JSON.parse(String(out).trim()); } catch {} // 兜底：输出不是 JSON 就是 null，下面照实说读不到
    state = j && j.loggedIn === false ? 'out' : 'in';
  } catch (e) { state = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM' ? 'unknown' : 'out'; }
  cache.set(key, { state, at: now });
  return state;
}
export const clearLoginCache = () => cache.clear();

// 供应商 / 模型 id → 界面上的名字。认不得的供应商用它自己的 label（lib/backends.mjs 目录里的），再不行原样。
// openai：这台电脑上原来就登录好的 Codex（默认登录目录 ~/.codex），和 claude_subscription（Claude Code）一样是「这台电脑上的」；
// 「ChatGPT 账号」只给在 OfferCrew 里登录的 openai@<名>（Mac 版的 openai@app）。和引导模型一步的卡片同一套叫法（web/onboarding.js
// cardOfModel）：以前这里把 ~/.codex 也叫「ChatGPT 账号」，新装时亮着补给，顶上却写「文字模型：ChatGPT 账号」（10-02 开箱第 3 轮）。
const PROVIDER = { claude_subscription: 'Claude Code', openai: 'Codex', typesafe: '判断模型', offercrew: 'OfferCrew 补给', claude_gateway: 'Claude', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };
const CHATGPT = 'ChatGPT 账号';
const MODEL = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', default: '默认模型', 'jev-latest': '判断模型' };
export function modelLabel(ref, { providerLabel = null } = {}) {
  const s = String(ref || ''), i = s.indexOf('/'), prov = i > 0 ? s.slice(0, i) : '', model = i > 0 ? s.slice(i + 1) : s;
  if (model === 'jev-latest' || prov === 'typesafe') return '判断模型';
  // openai@<名>：有自己登录目录的 ChatGPT 账号（Mac 版在 OfferCrew 里登录的是 openai@app），以前落到「自定义接口」。
  const p = PROVIDER[prov] || (/^openai@/.test(prov) ? CHATGPT : '') || providerLabel || (prov ? '自定义接口' : ''), m = MODEL[model] || modelWords(model);
  return p && m && m !== '默认模型' ? `${p} · ${m}` : p || m || '';
}
