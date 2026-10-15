import { PLATFORM_ACTIONS, MAIMAI_SYNC_UNAVAILABLE } from './platform-actions.mjs';
import { DISCOVERY_SOURCES } from './discovery-policy.mjs';
// 可在网页上改的配置：模型底座（供应商 × 模型目录）、执行器链、运行参数、个人事实、手动偏好。
//
// 每个文件只开放一份白名单字段，写之前先把旧文件备份到 state/backups/config/，
// 改完的值下一次脚本运行就生效（脚本每次都重新读配置）。密钥文件只报告存在与否。
// 所有模型引用都是「供应商/模型」，供应商来自 lib/backends.mjs 的目录（config/providers.json）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { file, read, write, text as readText, today } from './store.mjs';
import { PREFERENCES_PATH, loadPreferences, resetPreferencesCache, WEIGHT_CAP } from './preferences.mjs';
import { complete as chatComplete, chatConfig, chatBackends } from './chat.mjs';
import { localAi, localAiSentence } from './capabilities.mjs';
import { loadProviders, resolveBackend, normalizeChatConfig, backendLabel, providersOfKind, catalog, codexProviders, desktopApp, EFFORTS, KNOWN_MODELS as KNOWN, KINDS as PROVIDER_KINDS } from './backends.mjs';
import { event } from './events.mjs';
import { ROLES, ROLE_LABEL, ROLE_USES, roleSummary, loadRoles, setRoleSteps, roleChatBackend } from './roles.mjs';
import { crewOf, crewName } from './crew.mjs';
import { cityConfig } from './city.mjs';
import { forgetFacts } from './facts.mjs';
import { recheckCityDrafts } from './city-draft-review.mjs';
import { gateSettings } from './recommend-gate.mjs';
import { summarySettings } from './recommend-summary.mjs';
import { dayOf, dayStart, ledgerSince } from './usage.mjs';
import { recordModelVerification, providerFingerprint, modelErrorFilter } from './model-verification.mjs';
import { backendsFor } from './model.mjs';
import { modelConf } from './text-conf.mjs';
import { noteSwallowed } from './swallow.mjs';

const iso = x => new Date(x).toISOString();
export const KNOWN_MODELS = { claude: KNOWN.claude, codex: KNOWN.gpt, gpt: KNOWN.gpt, jev: KNOWN.jev };
const ENUM = { executor: ['claude', 'codex'], effort: EFFORTS };
const list = (v, { min = 1 } = {}) => { const a = (Array.isArray(v) ? v : String(v ?? '').split(/[\n,，、]+/)).map(x => String(x).trim()).filter(Boolean); if (a.length < min) throw Error('至少填一个'); return [...new Set(a)]; };
const int = (v, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw Error(`要是 ${lo}–${hi} 的整数`); return n; };
const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw Error(`要是 ${lo}–${hi} 的数`); return n; };
const bool = v => v === true || v === 'true' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 0 || v === '0' ? false : (() => { throw Error('要是 true / false'); })();
const oneOf = (opts) => v => { const s = String(v ?? '').trim(); if (!opts.includes(s)) throw Error(`只能是 ${opts.join(' / ')}`); return s; };
// 可以不填的数：空 = 不限（写成 null）。
const maybe = check => v => (v == null || String(v).trim() === '' ? null : check(v));
// 一份「供应商/模型」清单：每项 {provider, model, effort?, label?}，供应商必须在目录里且驱动符合用途。
const specs = ({ kinds = null, min = 1, max = 8, withLabel = false, withId = false } = {}) => v => {
  const providers = loadProviders();
  const raw = Array.isArray(v) ? v : String(v ?? '').split('\n').map(s => s.trim()).filter(Boolean).map(line => { const [provider, model, effort, ...rest] = line.split(/\s*\|\s*|\s+/); return { provider, model, effort: effort || null, label: rest.join(' ') || null }; });
  if (raw.length < min) throw Error(min === 1 ? '至少一项' : `至少 ${min} 项`);
  if (raw.length > max) throw Error(`最多 ${max} 项`);
  const out = raw.map(item => {
    const r = resolveBackend(item, providers);
    if (kinds && !kinds.includes(r.kind)) throw Error(`${r.provider}（${PROVIDER_KINDS[r.kind]}）不能用在这里，需要 ${kinds.map(k => PROVIDER_KINDS[k]).join(' / ')}`);
    const spec = { provider: r.provider, model: r.model };
    if (r.effort) spec.effort = r.effort;
    if (withLabel && (item.label || r.label)) spec.label = String(item.label || r.label).trim().slice(0, 80);
    if (withId) spec.id = r.id;
    return spec;
  });
  const ids = new Set();
  for (const s of out) { const id = `${s.provider}/${s.model}`; if (ids.has(id)) throw Error(`重复：${id}`); ids.add(id); }
  return out;
};
// 角色底座：对话一个（可空 = 跟随全局），文字一份清单（可空 = 跟随全局）。
const optionalSingleSpec = v => { if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null; const r = specs({ max: 1 })(Array.isArray(v) ? v : [typeof v === 'string' ? v : v])[0]; return `${r.provider}/${r.model}`; };
const optionalSpecs = v => { if (v == null || v === '' || (Array.isArray(v) && !v.length)) return []; return specs({ min: 0, max: 4 })(v); };
const providerOf = kinds => v => { const id = String(v ?? '').trim(); const ok = providersOfKind(kinds).map(p => p.key); if (!ok.includes(id)) throw Error(`只能是 ${ok.join(' / ')}`); return id; };
// 默认底座可以是目录里任何一个「供应商/模型」；不在清单里的会在保存时补进清单。
const backendDefaultCheck = v => { const id = String(v ?? '').trim(); const ids = chatConfig().backends.map(b => b.id); if (ids.includes(id)) return id; try { return resolveBackend(id).id; } catch (e) { throw Error(`${e.message}；清单里现有：${ids.join(' / ')}`); } };

// 城市名额比例（config/pipeline.json city_quota）：设置页给一个城市的比例。哪个城市：本机 pipeline.json
// 里已经写了的那个，否则 facts.yaml 的第一个目标城市；两样都没有就不显示这一项。
function quotaField() {
  const city = Object.keys(read('config/pipeline.json', {}).city_quota || {})[0] || cityConfig().ranked[0];
  return city ? { [`city_quota.${city}`]: { label: `${city}判断名额比例`, check: v => num(v, 0, 1) } } : {};
}
export const SETTINGS = {
  platform_actions: { file: 'config/human-source-policy.json', label: '平台外发', fields: Object.fromEntries(Object.entries(PLATFORM_ACTIONS).map(([key, p]) => [`${key}.actions_enabled`, { label: key === 'maimai' ? '在脉脉上发送好友申请' : `在${p.label}上发私信 / 预填 / 提交`, bool: true, check: bool }])) },
  sources: { file: 'config/human-source-policy.json', label: '扫描源', fields: Object.fromEntries(Object.entries(DISCOVERY_SOURCES).map(([key, label]) => [`${key}.enabled`, { label, bool: true, check: bool }])) },
  host: { file: 'config/host.json', label: '本机 AI', fields: {
    executor: { label: '用哪一个', enum: ENUM.executor, check: oneOf(ENUM.executor), help: 'claude：Claude Code 无头模式（供应商见下一项）；codex：codex exec（用兜底那一项）' },
    claude_provider: { label: 'Claude Code 走哪个供应商', provider_enum: ['anthropic_http', 'claude_code'], check: providerOf(['anthropic_http', 'claude_code']), help: '网关 = 按 token 计费；官方订阅 = 用该账号的 claude 登录态' },
    models: { label: 'Claude 模型顺序', list: true, check: v => list(v), options: KNOWN_MODELS.claude, help: '依次尝试，不可用换下一个' },
    max_turns: { label: '最多工具轮数', check: v => int(v, 5, 200) },
    timeout_minutes: { label: '超时（分钟）', check: v => int(v, 5, 120) },
    'codex_models.chain': { label: 'Codex 链（周期 / 巡检）', specs: true, kinds: ['codex_exec'], check: specs({ kinds: ['codex_exec'], max: 4 }), help: '依次尝试；供应商 = 目录里的 Codex 账号 / 中转' },
    'codex_models.cycle_effort': { label: '周期任务思考强度', enum: ENUM.effort, check: oneOf(ENUM.effort) },
    'system_auto_repair.enabled': { label: `${crewName('patch')} 自动修复`, bool: true, check: bool, help: '允许额外排查；只有同时启用「让本机 AI 也帮着查」才调用本机工具，常规恢复由引擎照常处理' },
    'system_auto_repair.per_hour': { label: '自动修复每小时上限', check: v => int(v, 0, 10) },
    'system_auto_repair.cooldown_hours': { label: '同一问题重试间隔（小时）', check: v => int(v, 1, 168) },
    'system_auto_repair.local_ai': { label: '让本机 AI 也帮着查', bool: true, check: bool },
    'codex_models.fallback': { label: '兜底（run-now 用 codex 时）', specs: true, kinds: ['codex_exec'], single: true, check: v => specs({ kinds: ['codex_exec'], max: 1 })(Array.isArray(v) ? v : [v])[0] },
  } },
  model: { file: 'config/model.json', label: '文字 / 图片模型', fields: {
    'text.backends': { label: '文字生成（求职信、AI 重写）', specs: true, kinds: ['anthropic_http', 'openai_http', 'claude_code', 'codex_exec'], check: specs({ max: 4 }), help: '按顺序尝试' },
    'text.max_tokens': { label: '最大输出 tokens', check: v => int(v, 256, 16000) },
    'text.timeout_ms': { label: '超时（毫秒）', check: v => int(v, 10000, 600000) },
    'vision.backends': { label: '图片识别（海报、截图）', specs: true, kinds: ['codex_exec', 'anthropic_http', 'openai_http'], check: specs({ kinds: ['codex_exec', 'anthropic_http', 'openai_http'], max: 3 }), help: 'Claude 官方订阅的 claude -p 不收图片' },
    'vision.timeout_ms': { label: '图片识别超时（毫秒）', check: v => int(v, 10000, 600000) },
  } },
  judge: { file: 'config/judge.json', label: '判断模型', fields: {
    enabled: { label: '启用 Jev', bool: true, check: bool, help: '关掉后退回正则 + 生成模型的旧路径' },
    model: { label: 'Jev 模型', options: KNOWN_MODELS.jev, check: v => String(v || '').trim() || (() => { throw Error('不能为空'); })() },
    concurrency: { label: '并发', check: v => int(v, 1, 16) },
    timeout_ms: { label: '超时（毫秒）', check: v => int(v, 5000, 180000) },
    max_retries: { label: '重试次数', check: v => int(v, 0, 6) },
    'thresholds.recommend_fit': { label: '推荐阈值 fit', check: v => num(v, 0, 3) },
    'thresholds.intent_verb': { label: '意图置信阈值', check: v => num(v, 0.3, 1) },
  } },
  chat: { file: 'config/chat.json', label: '对话底座', fields: {
    backends: { label: '对话可选底座', specs: true, kinds: ['anthropic_http', 'openai_http', 'claude_code', 'codex_exec'], with_label: true, check: specs({ max: 12, withLabel: true, withId: true }), help: '对话页右上角的下拉就是这份清单' },
    default: { label: '默认底座', backend_enum: true, check: backendDefaultCheck, help: '对话页不选时用它；网关类错误自动换下一个' },
    max_tokens: { label: '每轮最多输出 tokens（Claude 网关）', check: v => int(v, 256, 8000) },
    codex_timeout_ms: { label: 'Codex 超时（毫秒）', check: v => int(v, 30000, 900000) },
    claude_timeout_ms: { label: 'Claude 订阅超时（毫秒）', check: v => int(v, 20000, 600000) },
    history: { label: '带入的历史轮数', check: v => int(v, 2, 60) },
    context_chars: { label: '状态上下文上限（字符）', check: v => int(v, 4000, 120000) },
  } },
  concierge: { file: 'config/concierge.json', label: '提醒与投递规则', fields: {
    quiet_start: { label: '静默开始（时）', check: v => int(v, 0, 23) },
    quiet_end: { label: '静默结束（时）', check: v => int(v, 0, 23) },
    'auto_apply_policy.require_batch_review': { label: '投递先审后投', bool: true, check: bool, help: '关掉等于批准即投，风险自负' },
    'auto_apply_policy.require_referrer_search': { label: '表单前先找内推人', bool: true, check: bool },
    'auto_apply_policy.deal_one_by_one': { label: '拟投一张一张来', bool: true, check: bool },
  } },
  roles: { file: 'config/roles.json', label: '成员底座', fields: Object.fromEntries(ROLES.flatMap(r => [
    [`roles.${r}.chat`, { label: `${ROLE_LABEL[r]} · 对话默认`, specs: true, single: true, optional: true, kinds: ['anthropic_http', 'openai_http', 'claude_code', 'codex_exec'], check: optionalSingleSpec, help: '空 = 跟随 config/chat.json 的默认' }],
    [`roles.${r}.text`, { label: `${ROLE_LABEL[r]} · 文字生成（${ROLE_USES[r]}）`, specs: true, optional: true, kinds: ['anthropic_http', 'openai_http', 'claude_code', 'codex_exec'], check: optionalSpecs, help: '空 = 跟随 config/model.json 的文字清单' }],
  ])) },
  pipeline: { file: 'config/pipeline.json', label: '发现与匹配', fields: {
    'discovery.focus_only': { label: '只收录优先城市与远程岗位', bool: true, check: bool },
    'discovery.excluded_companies': { label: '排除公司（含名称或别名）', list: true, check: v => list(v, { min: 0 }) },
    'discovery.browser_interval_hours': { label: '浏览器来源扫描间隔（小时）', check: v => int(v, 1, 24) },
    // 推荐规则（lib/recommend-gate.mjs）：默认线 60，已判断结果不限展示数量；明确填写正数才按天限量。
    'recommend.min_score': { label: '推荐线（匹配度）', check: v => int(v, 0, 100), help: '匹配度没到这条线的，Judge 说推荐也先放进待核' },
    'recommend.daily_limit': { label: '每天最多新推荐（空 = 不限）', check: maybe(v => int(v, 1, 100)), help: '默认展示全部已判断合格的推荐。填上限只控制每天展示多少，不节省模型花费；模型预算在「花费」里设置' },
    'recommend.per_company': { label: '同公司在推荐摘要 / 推送中最多几个（空 = 不限）', check: maybe(v => int(v, 1, 30)), help: '默认 3 个，只控制重点摘要与每批手机推送。搜索、收录和全部岗位照常保留所有合适岗位' },
    match_limit: { label: '每轮最多匹配', check: v => int(v, 5, 200) },
    match_per_company: { label: '单公司最多', check: v => int(v, 1, 30) },
    application_preparation_batch: { label: '每轮准备材料数', check: v => int(v, 1, 50) },
    human_discovery_daily: { label: '每天抓真人帖', bool: true, check: bool },
    linkedin_chat_watch: { label: 'LinkedIn 网页消息：白天每 10 分钟检查', bool: true, check: bool, help: '直接读取专用 Chrome 的已登录线程，不依赖通知邮件；打开线程可能被网站标为已读，不发送。手动检查不受时段限制' },
    boss_chat_watch: { label: 'BOSS 聊天列表：每小时看一眼新消息', bool: true, check: bool, help: '读聊天列表（谁发来、最后一句、未读数）；没读的对话不点开；招聘方主动找你的，你读过后才点开看岗位、交给 Judge；不回复、不打字；BOSS 用户协议不允许自动访问' },
    maimai_chat_watch: { label: '脉脉消息同步', bool: true, disabled: MAIMAI_SYNC_UNAVAILABLE, check: v => { if (bool(v)) throw Error(MAIMAI_SYNC_UNAVAILABLE); return false; }, help: '请打开脉脉聊天查看和回复；已有消息记录仍保留' },
    ...quotaField(),
    // Patch 的记账（lib/spend.mjs，docs/cost.md）：花费档位和每天的上限。
    spend_tier: { label: '花费档位', enum: ['economy', 'standard', 'premium'], check: oneOf(['economy', 'standard', 'premium']), help: 'economy 省钱：你先按标题挑，只判断你留下的；standard 标准：和以前一样；premium 高级：推荐的岗位再写一页评估，用最好的模型' },
    'budget.daily_usd': { label: '每天花费上限（美元，估算；空 = 不限）', check: maybe(v => num(v, 0.01, 10000)), help: '到了就停下新的判断、匹配、找人和自动调研，留到明天；已经批准的照常做完' },
    'budget.daily_tokens': { label: '每天 token 上限（空 = 不限）', check: maybe(v => int(v, 1000, 10000000000)), help: '订阅登录的也算 token；到了和钱的上限一样处理' },
    // 桌面版：拉不拉起本机 AI（执行器，lib/capabilities.mjs localAi，10-02 开箱第 2 轮 X1）。开关在 设置 → 高级。
    desktop_executor: { label: '允许使用本机工具（可选）', bool: true, check: bool },
    // 网页上的活用哪个浏览器：只有专用 Chrome（ego 那条路 10-04 删掉了；旧配置里写的 ego 不再认）。
    browser: { label: '浏览器', enum: ['chrome'], check: oneOf(['chrome']) },
  } },
};
const getIn = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const setIn = (o, p, v) => { const ks = p.split('.'); let x = o; for (const k of ks.slice(0, -1)) { if (x[k] == null || typeof x[k] !== 'object') x[k] = {}; x = x[k]; } x[ks.at(-1)] = v; };
// 旧写法折算：model.json 的 driver + models / provider + model → backends 清单。
function legacyBackends(conf = {}) {
  if (Array.isArray(conf.backends) && conf.backends.length) return conf.backends;
  if (conf.driver === 'anthropic_http') return (conf.models || [conf.model || 'claude-fable-5-1']).map(m => ({ provider: 'claude_gateway', model: m }));
  if (conf.driver === 'claude_code') return (conf.models || [conf.model || 'claude-sonnet-5']).map(m => ({ provider: 'claude_subscription', model: m }));
  if (conf.driver === 'codex_exec') return [{ provider: conf.provider || codexProviders().default_provider, model: conf.model || codexProviders().default_model || 'gpt-5.6-luna', ...(conf.effort ? { effort: conf.effort } : {}) }];
  return [];
}
function currentValue(name, data, key) {
  if (name === 'sources') return getIn(data, key) !== false;
  if (name === 'model' && key.endsWith('.backends')) return legacyBackends(getIn(data, key.split('.')[0]) || {});
  if (name === 'host' && key === 'claude_provider') return data.claude_provider || 'claude_gateway';
  // 成员没单独设的，显示它沿用的老角色设置（lib/roles.mjs）：页面上看到的就是实际在用的。
  if (name === 'roles') { const [, m, f] = key.split('.'), v = loadRoles(data)[m]?.[f]; return f === 'chat' ? v || null : v || []; }
  if (name === 'chat') { const c = chatConfig(); if (key === 'backends') return c.backends; if (key === 'default') return c.default; }
  if (name === 'pipeline' && key === 'linkedin_chat_watch') return data[key] !== false;
  if (name === 'pipeline' && key === 'recommend.per_company') return summarySettings(data).per_company;
  if (name === 'pipeline' && key.startsWith('recommend.')) return gateSettings(data)[key.slice('recommend.'.length)];
  return getIn(data, key) ?? null;
}

export function backupFile(rel, now = Date.now()) {
  const src = file(rel);
  if (!fs.existsSync(src)) return null;
  const stamp = iso(now).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dest = `state/backups/config/${path.basename(rel).replace(/\.(json|yaml|yml)$/, '')}-${stamp}${path.extname(rel)}`;
  fs.mkdirSync(path.dirname(file(dest)), { recursive: true });
  fs.copyFileSync(src, file(dest));
  return dest;
}
export function settingsView() {
  const providers = loadProviders();
  const files = {};
  for (const [name, def] of Object.entries(SETTINGS)) {
    const data = read(def.file, null) || (name === 'chat' ? chatConfig() : {});
    const values = Object.fromEntries(Object.keys(def.fields).map(k => [k, currentValue(name, data, k)]));
    files[name] = { file: def.file, label: def.label, exists: fs.existsSync(file(def.file)), values, fields: Object.fromEntries(Object.entries(def.fields).map(([k, f]) => [k, { label: f.label, enum: f.provider_enum ? providersOfKind(f.provider_enum, providers).map(p => p.key) : f.backend_enum ? chatConfig().backends.map(b => b.id) : f.enum || null, enum_labels: f.provider_enum ? Object.fromEntries(providersOfKind(f.provider_enum, providers).map(p => [p.key, p.label])) : f.backend_enum ? Object.fromEntries(chatConfig().backends.map(b => [b.id, backendLabel(b, providers)])) : null, list: !!f.list, bool: !!f.bool, specs: !!f.specs, single: !!f.single, kinds: f.kinds || null, with_label: !!f.with_label, options: f.options || null, help: f.help || null, disabled: f.disabled || null }])) };
  }
  const auth = Object.fromEntries([['claude_api', 'private/claude-api.auth.json'], ['typesafe', 'private/typesafe.auth.json'], ['feishu', 'private/feishu-listener.auth.json'], ['gmail_oauth', 'private/gmail-token.auth.json']].map(([k, p]) => [k, { file: p, exists: fs.existsSync(file(p)), provider: k === 'claude_api' ? (read(p, {})?.provider || null) : null, base_url: k === 'claude_api' ? (read(p, {})?.base_url || null) : null }]));
  const usage = {};
  // 今日模型用量读 Patch 的账（lib/usage.mjs）：和「运行与用量」同一份数据，执行器会话、Claude Code 的用量都在里面。
  for (const row of ledgerSince(dayStart(dayOf(Date.now())))) { const k = `${row.backend || '?'}${row.model ? ' · ' + (row.provider ? row.provider + '/' : '') + row.model : ''}`; const u = usage[k] || { calls: 0, failed: 0, input_tokens: 0, output_tokens: 0, ms: 0 }; u.calls++; if (row.status === 'failed') u.failed++; u.input_tokens += row.input_tokens || 0; u.output_tokens += row.output_tokens || 0; u.ms += row.duration_ms || 0; usage[k] = u; }
  const backups = fs.existsSync(file('state/backups/config')) ? fs.readdirSync(file('state/backups/config')).sort().slice(-8) : [];
  const stack = stackSummary(providers);
  return { agents: agentSettings(files, stack), runtimes: catalog(providers).filter(p => ['claude_code', 'codex_exec'].includes(p.kind)), files, auth, usage_today: usage, known_models: KNOWN_MODELS, backups, facts: FACT_FIELDS, catalog: catalog(providers), kinds: PROVIDER_KINDS, efforts: EFFORTS, stack, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { label: p.label, desc: p.desc }])), chat_backends: chatBackends(), roles: roleSummary(providers) };
}
// Only expose model fields, never the CLI's full configuration or authentication.
// These are observed defaults, not a claim about CLI precedence or a run's resolved model.
function localCliModelDefaults(kind) {
  const entries = [], env = process.env, home = env.HOME || os.homedir();
  const add = (model, source) => {
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,159}$/.test(model)) return;
    entries.push({ model, source });
  };
  const toml = (p, source) => {
    try {
      // A profile/model-provider table must not be mistaken for the top-level default.
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) break;
        const match = line.match(/^\s*model\s*=\s*(?:"([^"\\]+)"|'([^']+)')\s*(?:#.*)?$/);
        if (match) add(match[1] || match[2], `${source} · 顶层 model`);
      }
    } catch {} // 兜底：默认配置不存在或读不出，页面明确显示尚未读到型号，不阻止打开设置。
  };
  const json = (p, source) => {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      add(data.model, `${source} · model`);
      add(data.env?.ANTHROPIC_MODEL, `${source} · env.ANTHROPIC_MODEL`);
    } catch {} // 兜底：CLI 配置缺失或损坏时不推断型号，页面保留跟随 CLI 默认。
  };
  if (kind === 'codex') {
    toml(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), `${env.CODEX_HOME ? 'CODEX_HOME' : '~/.codex'}/config.toml`);
    toml(file('.codex/config.toml'), '任务目录/.codex/config.toml');
  } else {
    add(env.ANTHROPIC_MODEL, '当前进程环境 · ANTHROPIC_MODEL');
    json(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'), `${env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : '~/.claude'}/settings.json`);
    json(file('.claude/settings.json'), '任务目录/.claude/settings.json');
    json(file('.claude/settings.local.json'), '任务目录/.claude/settings.local.json');
  }
  return { entries, note: '型号跟随 CLI 自己的配置；profile、项目配置或环境设置可能覆盖这些默认值，实际型号以运行回执为准。' };
}
// Compact agent controls project the existing configuration, without another source of truth.
function agentSettings(files, stack = {}) {
  const id = b => !b ? null : typeof b === 'string' ? b : `${b.provider}/${b.model}`;
  const chat = files.chat.values.default, text = files.model.values['text.backends'] || [];
  const host = files.host.values, eff = loadRoles(), executor = localAi();
  const providers = loadProviders(), effectiveText = role => {
    try { return { effective_text: backendsFor(modelConf('text', { providers }), providers, { role }).map(b => ({ provider: b.provider, model: b.model })) }; }
    catch (e) {
      noteSwallowed('settings.agentModels', e, { member: role, doing: `读取 ${ROLE_LABEL[role]} 的文字模型配置`, then: '保留原设置，暂停显示生效清单' });
      return { effective_text: [], effective_text_error: e.message };
    }
  };
  return [
    { role: 'chat', label: '对话（全局默认）', chat, text: id(text[0]), text_chain: text, inherit: false },
    ...ROLES.map(role => ({ fallback_chat: (stack.issues || []).some(i => i.role === role && i.area === 'role_chat'), text_issue: (stack.issues || []).some(i => i.role === role && i.area === 'role_text'), role, label: ROLE_LABEL[role], help: `用在：${ROLE_USES[role]}${eff[role].from ? `；没单独设，沿用原来 ${[...new Set(Object.values(eff[role].from))].join('、')} 的设置` : ''}`, chat: files.roles.values[`roles.${role}.chat`], text: id(files.roles.values[`roles.${role}.text`]?.[0]), text_chain: files.roles.values[`roles.${role}.text`], effective_chat: roleChatBackend(role, providers) || chat, ...effectiveText(role), steps: eff[role].steps || {}, inherit: true })),
    { role: 'jev', label: '判断模型', chat: `typesafe/${files.judge.values.model || 'jev-latest'}`, single: true, fixed: true, help: '独立 Typesafe 判断接口', inherit: false },
    executor.source === 'local'
      ? { role: 'executor', label: '本机 AI', source: 'local', local_cli: executor.kind, local_defaults: localCliModelDefaults(executor.kind), chat: null, chat_label: `${executor.kind === 'claude' ? 'Claude Code' : 'Codex'} · 跟随 CLI 默认`, single: true, fixed: true, inherit: false, help: '模型由所选 CLI 的当前配置决定' }
      : { role: 'executor', label: '本机 AI', source: executor.source, chat: id(host['codex_models.fallback'] || host['codex_models.chain']?.[0]), single: true, kinds: ['codex_exec'], inherit: false },
  ];
}
export function setAgentBackend(role, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(k => !['chat', 'text'].includes(k))) throw Error('只接受对话与文字底座');
  // 老的角色编号（radar / watch / reacher / system）照样认：换成接手它的那位（lib/crew.mjs）。
  if (!['chat', 'executor'].includes(role) && !ROLES.includes(role)) role = crewOf(role) || role;
  if (![...ROLES, 'chat', 'executor'].includes(role)) throw Error('该智能体不支持切换底座');
  if (role === 'executor' && localAi().source === 'local') throw Error('本机工具的模型跟随所选 CLI 默认；要换 Claude Code 或 Codex，请在本机工具中选择');
  // Validate the complete request before writing any file.
  const refs = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value == null || value === '' ? null : specs({ max: 1 })([value])[0]]));
  // 改这位的文字模型：这位按步骤单独配的（加 Anthropic key 时自动写的 steps，lib/claude-defaults.mjs）一起清掉，照你改的用。
  if (ROLES.includes(role)) { const r = updateSettings('roles', Object.fromEntries(Object.entries(refs).map(([key, ref]) => [`roles.${role}.${key}`, key === 'chat' ? ref : ref ? [ref] : []]))); if ('text' in refs && loadRoles()[role]?.steps) setRoleSteps(role, null); return r; }
  if (Object.values(refs).some(v => !v)) throw Error('全局默认与本机 AI 不能跟随自身');
  if (role === 'executor') {
    if ('text' in refs) throw Error('本机 AI 只有一个底座');
    const ref = refs.chat, backend = resolveBackend(ref);
    if (backend.kind === 'codex_exec') return updateSettings('host', { executor: 'codex', 'codex_models.fallback': ref });
    throw Error('当前登录来源使用 Codex；要用这台电脑上的 Claude Code，请在本机工具中选择');
  }
  const results = [];
  if (refs.chat) results.push(updateSettings('chat', { default: `${refs.chat.provider}/${refs.chat.model}` }));
  if (refs.text) results.push(updateSettings('model', { 'text.backends': [refs.text] }));
  return { status: results.some(r => r.status === 'saved') ? 'saved' : 'unchanged', results };
}

// 提交前终审（2026-09-30 拍板）：一直开着，不是开关。任何想把它关掉的请求都拒绝，
// 不管是点名 final_review，还是整块改 auto_apply_policy。lib/auto-apply.mjs 也不再读这个值。
export const FINAL_REVIEW_LOCKED = '提交前终审一直开着，不能关';
function refuseFinalReviewOff(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (/(^|\.)final_review$/.test(k) && v !== true) throw Error(FINAL_REVIEW_LOCKED);
    if (/(^|\.)auto_apply_policy$/.test(k) && v && typeof v === 'object' && 'final_review' in v && v.final_review !== true) throw Error(FINAL_REVIEW_LOCKED);
  }
}
export function updateSettings(name, patch = {}, { now = Date.now() } = {}) {
  refuseFinalReviewOff(patch);
  const def = SETTINGS[name];
  if (!def) throw Error('未知配置');
  const keys = Object.keys(patch || {});
  if (!keys.length) throw Error('没有要改的字段');
  const data = read(def.file, null) || (name === 'chat' ? chatConfig() : {});
  const changes = [];
  for (const k of keys) {
    const f = def.fields[k];
    if (!f) throw Error(`不允许改 ${k}`);
    let v;
    try { v = f.check(patch[k]); } catch (e) { throw Error(`${f.label}：${e.message}`); }
    // 比较用文件里的原值（不带默认），这样预设能把缺省字段显式写进去。成员底座比的是实际在用的（沿用老角色的也算）：
    // 沿用着老设置的成员写成空，要真的写进去（= 明确跟随全局），不能当成「没变」。
    const cur = (name === 'model' && k.endsWith('.backends')) || name === 'chat' || name === 'roles' ? currentValue(name, data, k) : getIn(data, k) ?? null;
    const strip = x => (Array.isArray(x) ? x.map(({ id, ...r }) => r) : x);
    if (JSON.stringify(strip(cur)) === JSON.stringify(strip(v))) continue;
    changes.push({ key: k, label: f.label, from: cur ?? null, to: v });
    setIn(data, k, v);
    // backends 写入后，旧的 driver / models / provider 字段不再有意义，收起来避免歧义。
    if (name === 'model' && k.endsWith('.backends')) { const sec = data[k.split('.')[0]]; sec.driver = 'backends'; for (const old of ['models', 'model', 'provider', 'effort', 'fallback']) delete sec[old]; }
  }
  if (!changes.length) return { status: 'unchanged', file: def.file, changes: [] };
  if (name === 'chat') {
    // 默认底座不在清单里：先补进清单，再规范化。
    // 只有这次改的是 default 才补进清单；用户重写整份清单时，默认回到清单第一项（normalizeChatConfig）。
    if (keys.includes('default') && data.default && !(data.backends || []).some(b => (b.id || `${b.provider}/${b.model}`) === data.default)) { try { const r = resolveBackend(data.default); data.backends = [...(data.backends || []), { provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}) }]; changes.push({ key: 'backends', label: '对话可选底座', from: null, to: `+${r.id}` }); } catch {} } // 兜底：默认底座解析不了就不加进可选底座
    const c = normalizeChatConfig(data); data.backends = c.backends; data.default = c.default; delete data.models; delete data.driver;
  }
  const backup = backupFile(def.file, now);
  write(def.file, data);
  event('user', 'settings', 'ok', `操作台修改 ${def.file}：${changes.map(c => c.key).join('、')}${backup ? `（备份 ${backup}）` : ''}`, { refs: [] }); // 备份在 state/ 下，证据链接打不开（/api/evidence 只给 runs/）
  return { status: 'saved', file: def.file, changes, backup };
}

// 现在谁在用什么：每条链路的底座一眼看清，解析不了的（供应商不在目录里等）标红。
// 解析不了的分三档（issues：{ level, area, text, role? }；errors / warnings / notes 是各档的原话）：
//   error  挡路：这一路一个能用的都没有（整张清单都解析不了、本机 AI 要用的 Claude Code 供应商不在）。指挥台上是严重告警。
//   warn   降级：清单里坏了几项，还有能用的，按顺序跳过；兜底项坏了（只在链都失败时才用）。
//   info   已经自动处理：成员自己的对话 / 文字底座解析不了，按跟随全局或跳过处理（lib/roles.mjs），什么都没挡（10-04：Mac 版没填
//          key 时不提供 openai，5 位成员的对话底座都指着它，顶上挂了「5 条严重告警」）。设置不动：填上 key 那一家回来了，原来的选择照常生效。
export function stackSummary(providers = loadProviders()) {
  const host = read('config/host.json', {}), model = read('config/model.json', {}), judge = read('config/judge.json', {}), chat = chatConfig();
  const issues = [];
  const refText = ref => typeof ref === 'string' ? ref : `${ref?.provider || '?'}/${ref?.model || '?'}`;
  const check = ref => { try { const r = resolveBackend(ref, providers); return { label: `${r.provider}/${r.model}${r.effort ? ' · ' + r.effort : ''}` }; } catch (e) { return { label: `${refText(ref)} ✗`, err: e.message }; } };
  // 一张清单：坏的每项都记；整张都坏了才挡路，还有能用的只是降级（按顺序跳过）。
  const listed = (refs, area, where) => { const rs = refs.map(check), bad = rs.filter(r => r.err).length; rs.forEach((r, i) => r.err && issues.push({ level: bad === rs.length ? 'error' : 'warn', area, text: `${where(i)}：${r.err}` })); return rs.map(r => r.label); };
  // 本机登录沿用 CLI 自己的默认模型和凭据；旧 provider/周期链在这条路径上不再执行，不把它们报告成故障。
  const local = localAi(), ownLogin = local.source === 'local';
  const codexRef = c => c && typeof c === 'object' && !String(c.model || '').trim() ? { ...c, model: 'default' } : c;
  const quietLabel = ref => { try { const r = resolveBackend(ref, providers); return `${r.provider}/${r.model}`; } catch { return refText(ref); } };
  const chainRefs = (host.codex_models?.chain || []).map(codexRef);
  const chain = ownLogin || !local.ready ? [] : listed(chainRefs, '本机 AI', i => `Codex 链第 ${i + 1} 项`);
  const list = (conf, area) => { const l = legacyBackends(conf); return l.length ? listed(l, area, i => `${area}第 ${i + 1} 项`).join('  →  ') : '未设'; };
  // Judge 继承同一份文字配置：显示完整标签，配置问题由「文字生成」报一次，不在展示时重复累计。
  const inheritedText = legacyBackends(modelConf('text', { providers })).map(ref => check(ref).label).join('  →  ') || '未设';
  const rows = [
    { fn: '本机 AI（你交代的事、自动修复）', value: `${localAiSentence(local)}${ownLogin ? ' · 沿用 CLI 的默认模型和凭据' : ''}` },
    ...(!ownLogin ? [{ fn: 'Codex 模型链', value: (chain.length ? chain : chainRefs.map(quietLabel)).join(' → ') || '未设' }] : []),
    { fn: '文字生成（求职信、AI 重写）', value: list(model.text, '文字生成') },
    { fn: '图片识别（招聘海报、截图）', value: list(model.vision, '图片识别') },
    { fn: '对话页默认', value: (() => { const b = chat.backends.find(x => x.id === chat.default); return b ? backendLabel(b, providers) : '未设'; })() },
    { fn: '判断岗位（Lens）', value: judge.enabled !== false && read('private/typesafe.auth.json', {})?.api_key ? `Jev · ${judge.model || 'jev-latest'}` : judge.driver === 'offline' || process.env.RADAR_JUDGE === 'offline' ? '离线规则' : `文字模型 · ${roleSummary(providers).lens?.text_labels?.join(' → ') || inheritedText}` },
    ...ROLES.map(r => { const v = roleSummary(providers)[r]; return { fn: `角色 ${ROLE_LABEL[r]}`, value: `对话 ${v.chat_label || '跟随全局'} ｜ 文字（${ROLE_USES[r]}）${v.text_labels.length ? v.text_labels.join(' → ') : '跟随全局'}` }; }),
  ];
  listed(chat.backends, '对话', i => `对话底座「${chat.backends[i].id}」`);
  const roles = roleSummary(providers);
  for (const r of ROLES) { const v = roles[r]; if (v.chat && /✗$/.test(v.chat_label || '')) issues.push({ level: 'info', area: 'role_chat', role: r, text: `角色 ${ROLE_LABEL[r]} 的对话底座「${v.chat}」解析不了，已按跟随全局处理` }); for (const t of v.text_labels) if (/✗$/.test(t)) issues.push({ level: 'info', area: 'role_text', role: r, text: `角色 ${ROLE_LABEL[r]} 的文字清单里有解析不了的项：${t}` }); }
  // Mac 版不读这台电脑上的 ~/.codex/config.toml（lib/backends.mjs desktopProviders 同一条）。
  const cx = desktopApp() ? {} : codexProviders();
  const said = level => issues.filter(i => i.level === level).map(i => i.text);
  return { rows, issues, errors: said('error'), warnings: said('warn'), notes: said('info'), codex_default: { provider: cx.default_provider, model: cx.default_model, effort: cx.default_effort }, codex_config: cx.file };
}

// 一类解析不了的底座的一句话（指挥台告警、顶上那一行用）：写清是哪一类、几个；每一项的原话另给（detail）。
// issues 是 stackSummary 同一档的几项。
export function stackHeadline(issues = []) {
  if (!issues.length) return '';
  const roles = n => new Set(issues.filter(i => i.area === n).map(i => i.role)).size;
  const names = area => [...new Set(issues.filter(i => i.area === area).map(i => String(ROLE_LABEL[i.role] || '成员').split(' · ')[0]))].join('、');
  if (issues[0].level === 'info') return [roles('role_chat') && `${names('role_chat')} 单独选的对话模型不在模型目录里，已跟随全局；可在模型设置重新选择`, roles('role_text') && `${names('role_text')} 的文字模型清单里有未配置的项，已跳过；可在模型设置重新选择`].filter(Boolean).join('；');
  const areas = [...new Set(issues.map(i => i.area))], n = a => issues.filter(i => i.area === a).length, of = a => `${a}${/[A-Za-z]$/.test(a) ? ' ' : ''}的`;
  if (issues[0].level === 'warn') return `${areas.map(a => `${a} ${n(a)} 个`).join('、')}模型用不了，已跳过`;
  return areas.length === 1 ? `${of(areas[0])}${n(areas[0]) > 1 ? ` ${n(areas[0])} 个模型都` : '模型'}用不了` : `${areas.length} 处模型用不了：${areas.join('、')}`;
}

// 底座预设：一键把所有链路切到某一家。只改列出的字段；先 preview 看差异，再 apply。
// 中转在目录里的 key：Codex 配置里叫 custom 的那个，没有就是第一个不是官方订阅的 Codex 供应商。
const relayKey = () => { const cx = Object.values(loadProviders()).filter(x => x.kind === 'codex_exec' && x.key !== 'openai'); return (cx.find(x => x.key === 'custom') || cx[0])?.key || 'custom'; };
export const PRESETS = {
  gateway: {
    label: '网关 / 中转（按 token 计费，不占订阅额度）',
    desc: 'Claude Code 走 Claude 网关（Anthropic 兼容）；周期 / 巡检 Codex 链先中转的 gpt-6-astra，再官方订阅 gpt-5.6-luna 兜底；文字生成走 Claude 网关；图片识别走中转的 GPT；对话默认 Claude Fable。',
    changes: () => ({
      host: { executor: 'claude', claude_provider: 'claude_gateway', 'codex_models.chain': [{ provider: relayKey(), model: 'gpt-6-astra', effort: 'low' }, { provider: 'openai', model: 'gpt-5.6-luna', effort: 'low' }], 'codex_models.fallback': { provider: relayKey(), model: 'gpt-6-astra', effort: 'medium' } },
      model: { 'text.backends': [{ provider: 'claude_gateway', model: 'claude-fable-5-1' }, { provider: 'claude_gateway', model: 'claude-opus-5' }], 'vision.backends': [{ provider: relayKey(), model: 'gpt-6-astra', effort: 'low' }] },
      chat: { default: 'claude_gateway/claude-fable-5-1' },
    }),
  },
  openai_subscription: {
    label: 'OpenAI 官方订阅（Codex 登录，占 ChatGPT 额度）',
    desc: '本机 AI 改走 codex exec；周期 / 巡检 Codex 链先官方订阅 gpt-5.6-luna，再中转兜底；文字生成与图片识别都走官方订阅的 GPT；对话默认 GPT-5.6 Luna。',
    changes: () => ({
      host: { executor: 'codex', 'codex_models.chain': [{ provider: 'openai', model: 'gpt-5.6-luna', effort: 'low' }, { provider: relayKey(), model: 'gpt-6-astra', effort: 'low' }], 'codex_models.fallback': { provider: 'openai', model: 'gpt-5.6-luna', effort: 'medium' } },
      model: { 'text.backends': [{ provider: 'openai', model: 'gpt-5.6-luna', effort: 'low' }], 'vision.backends': [{ provider: 'openai', model: 'gpt-5.6-luna', effort: 'low' }] },
      chat: { default: 'openai/gpt-5.6-luna' },
    }),
  },
  claude_subscription: {
    label: 'Claude 官方订阅（Claude Code 登录，占 Claude 额度）',
    desc: '本机 AI 和周期宿主步骤先用官方订阅的 Claude Opus 5.5（要 Gmail 的活仍交给 Codex）；文字生成与对话默认 Opus 5.5；Codex 链官方订阅在前、中转兜底；图片识别走官方订阅的 GPT。Claude 的登录在终端用 claude auth login 完成。',
    changes: () => ({
      host: { executor: 'claude', claude_provider: 'claude_subscription', models: ['claude-opus-5-5'], 'codex_models.chain': [{ provider: 'openai', model: 'gpt-6-astra', effort: 'medium' }, { provider: relayKey(), model: 'gpt-6-astra', effort: 'medium' }], 'codex_models.fallback': { provider: 'openai', model: 'gpt-6-astra', effort: 'medium' } },
      model: { 'text.backends': [{ provider: 'claude_subscription', model: 'claude-opus-5-5' }, { provider: 'openai', model: 'gpt-6-astra', effort: 'medium' }, { provider: relayKey(), model: 'gpt-6-astra', effort: 'medium' }], 'vision.backends': [{ provider: 'openai', model: 'gpt-6-astra', effort: 'medium' }, { provider: relayKey(), model: 'gpt-6-astra', effort: 'medium' }] },
      chat: { default: 'claude_subscription/claude-opus-5-5' },
    }),
  },
};
export function previewPreset(name) {
  const p = PRESETS[name];
  if (!p) throw Error('未知预设');
  const changes = [];
  for (const [fileName, patch] of Object.entries(p.changes())) {
    const def = SETTINGS[fileName], data = read(def.file, null) || (fileName === 'chat' ? chatConfig() : {});
    for (const [k, v] of Object.entries(patch)) {
      const f = def.fields[k]; if (!f) continue;
      let value, note = null;
      // 对话默认底座不在清单里时，应用预设会先把它加进清单，所以这里只校验目录认不认得。
      if (fileName === 'chat' && k === 'default' && !chatConfig().backends.some(b => b.id === v)) { try { value = resolveBackend(v).id; note = '会先加入对话底座清单'; } catch (e) { changes.push({ file: def.file, key: k, label: f.label, from: currentValue(fileName, data, k) ?? null, to: v, error: `${f.label}：${e.message}` }); continue; } }
      else { try { value = f.check(v); } catch (e) { changes.push({ file: def.file, key: k, label: f.label, from: currentValue(fileName, data, k) ?? null, to: v, error: `${f.label}：${e.message}` }); continue; } }
      // 与 updateSettings 同一把尺子：文件里的原值（不带默认），缺省字段也会被显式写入。
      const current = (fileName === 'model' && k.endsWith('.backends')) || fileName === 'chat' ? currentValue(fileName, data, k) : getIn(data, k) ?? null;
      const strip = x => (Array.isArray(x) ? x.map(({ id, ...r }) => r) : x);
      if (JSON.stringify(strip(current)) !== JSON.stringify(strip(value))) changes.push({ file: def.file, key: k, label: f.label, from: current ?? null, to: value, ...(note ? { note } : {}) });
    }
  }
  return { name, label: p.label, desc: p.desc, changes, blocked: changes.filter(c => c.error) };
}
export function applyPreset(name, { now = Date.now() } = {}) {
  const preview = previewPreset(name);
  if (preview.blocked.length) throw Error(`预设里有字段不能应用：${preview.blocked.map(c => c.error).join('；')}`);
  const results = [];
  // chat.default 依赖清单里有这一项：没有就先把它补进清单。
  const chatPatch = PRESETS[name].changes().chat || {};
  if (chatPatch.default) { const c = chatConfig(); if (!c.backends.some(b => b.id === chatPatch.default)) { const r = resolveBackend(chatPatch.default); results.push(updateSettings('chat', { backends: [...c.backends, { provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}) }] }, { now })); } }
  for (const [fileName, patch] of Object.entries(PRESETS[name].changes())) {
    const keys = preview.changes.filter(c => c.file === SETTINGS[fileName].file).map(c => c.key);
    if (!keys.length) continue;
    results.push(updateSettings(fileName, Object.fromEntries(keys.map(k => [k, patch[k]])), { now }));
  }
  event('user', 'settings', 'ok', `操作台应用底座预设「${PRESETS[name].label}」`);
  return { name, label: PRESETS[name].label, results, applied: results.flatMap(r => r.changes || []) };
}

// 连通性测试：发一个最小请求。可以点名底座（供应商/模型，含 GPT 经 codex 约 30–60 秒、Claude 订阅约 5–10 秒），
// 或只给 Claude 模型名（走网关）。
export async function testModel({ backend = null, model = null, provider = null, driver = null, completeFn = chatComplete } = {}) {
  const cfg = chatConfig();
  const ref = backend || (model ? (provider ? `${provider}/${String(model).trim()}` : String(model).trim()) : '');
  if (!ref) throw Error('缺模型名');
  const providers = loadProviders();
  let b; try { b = resolveBackend(ref, providers); } catch (e) { throw Error(`没有这个底座：${ref}（${e.message}）`); }
  const fingerprint = providerFingerprint(providers[b.provider]), safeError = modelErrorFilter(providers[b.provider]);
  const started = Date.now();
  let result;
  try {
    const r = await completeFn({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], backend: b.id, max_tokens: 32, meta: { member: 'system', step: 'test' }, config: { ...cfg, default: b.id, backends: [{ id: b.id, provider: b.provider, model: b.model, ...(b.effort ? { effort: b.effort } : {}) }], timeout_ms: 30000, codex_timeout_ms: 120000, claude_timeout_ms: 90000 } });
    if (r.backend === 'sandbox' || r.model === 'sandbox') throw Error('演示 / 沙盒模式不调用模型，尚未测试');
    if (r.backend && r.backend !== b.id) throw Error('测试请求由其他模型回答，所选模型尚未通过');
    if (r.broken || !String(r.text || '').trim()) throw Error('模型没有返回完整的文字回答');
    result = { ok: true, backend: b.id, model: r.model || b.model, requested_model: b.model, actual_model: r.reported_model || null, ms: Date.now() - started, text: String(r.text || '').slice(0, 40), usage: r.usage || null };
  } catch (e) { result = { ok: false, backend: b.id, model: b.model, actual_model: null, ms: Date.now() - started, error: safeError(e) }; }
  recordModelVerification(b.id, result, { providers, fingerprint });
  return result;
}

// ── 个人事实：白名单字段，保留 facts.yaml 里的注释 ─────────────────────────────
export const FACT_FIELDS = {
  'identity.email': { label: '邮箱', kind: 'text' }, 'identity.phone_cn': { label: '手机', kind: 'text' }, 'identity.linkedin': { label: 'LinkedIn', kind: 'text' }, 'identity.github': { label: 'GitHub / 主页', kind: 'text' },
  'location.current_city': { label: '现居城市', kind: 'text' }, 'location.target_cities': { label: '目标城市', kind: 'list' }, 'location.relocation_ok': { label: '可搬迁', kind: 'text' }, 'location.work_mode_preference': { label: '工作方式优先级', kind: 'list', options: ['remote_china', 'hybrid', 'onsite'] }, 'location.onsite_5days_acceptable': { label: '接受五天坐班', kind: 'bool' }, 'location.travel_ok': { label: '出差', kind: 'text' },
  'availability.current_status': { label: '在职状态', kind: 'text' }, 'availability.notice_period_days': { label: '通知期（天）', kind: 'int' }, 'availability.earliest_start': { label: '最早到岗', kind: 'text' }, 'availability.notice_can_shorten': { label: '通知期可缩短', kind: 'text' },
  'compensation.expected_annual_cny': { label: '期望年薪', kind: 'text' }, 'compensation.floor_annual_cny': { label: '底线年薪', kind: 'text' }, 'compensation.current_annual_cny': { label: '当前年薪', kind: 'text' }, 'compensation.expected_annual_usd_remote': { label: '海外远程期望', kind: 'text' }, 'compensation.equity_preference': { label: '期权偏好', kind: 'text' },
  'preferences.company_priority': { label: '公司偏好顺序', kind: 'list' }, 'preferences.role_families': { label: '目标方向', kind: 'list' }, 'preferences.hard_exclusions': { label: '硬排除', kind: 'list' }, 'preferences.soft_exclusions': { label: '软排除', kind: 'text' },
  'communication.daily_feedback_budget_minutes': { label: '每天处理求职事项的时间（分钟）', kind: 'int' },
  'standard_answers.why_leaving': { label: '离职原因（内部）', kind: 'text' }, 'standard_answers.management_experience': { label: '管理经验', kind: 'text' }, 'standard_answers.biggest_strength': { label: '最大优势', kind: 'text' },
};
export function updateFact(pathKey, value, { now = Date.now() } = {}) {
  const f = FACT_FIELDS[pathKey];
  if (!f) throw Error(`不允许改 ${pathKey}`);
  let v;
  if (f.kind === 'list') v = list(value, { min: 0 });
  else if (f.kind === 'int') v = int(value, 0, 100000);
  else if (f.kind === 'bool') v = bool(value);
  else { v = String(value ?? '').replace(/\r?\n/g, ' ').trim(); if (!v) throw Error('不能为空'); if (v.length > 400) throw Error('太长'); }
  const doc = YAML.parseDocument(readText('candidate/facts.yaml'));
  const keys = pathKey.split('.');
  const before = doc.getIn(keys, true);
  const beforeValue = before && typeof before === 'object' && 'toJSON' in before ? before.toJSON() : before;
  if (JSON.stringify(beforeValue) === JSON.stringify(v)) return { status: 'unchanged', path: pathKey, value: v };
  doc.setIn(keys, v);
  const backup = backupFile('candidate/facts.yaml', now);
  write('candidate/facts.yaml', doc.toString());
  forgetFacts();
  event('user', 'settings', 'ok', `操作台修改个人事实 ${pathKey}${backup ? `（备份 ${backup}）` : ''}`, { refs: [] });
  const cityReview = ['location.target_cities', 'location.work_mode_preference'].includes(pathKey) ? recheckCityDrafts({ dryRun: false, source: 'settings', now }) : null;
  return { status: 'saved', path: pathKey, value: v, previous: beforeValue ?? null, backup, ...(cityReview ? { city_pauses: cityReview } : {}) };
}

// ── 手动偏好：直接写 preferences.json 的 manual ──────────────────────────────
export function setManualPreference({ key, weight, now = Date.now() } = {}) {
  const k = String(key || '').trim();
  if (!/^[a-z_]+:[^\s]{1,40}$/.test(k)) throw Error('偏好键要像 direction:算法研究 这样');
  const prefs = loadPreferences(PREFERENCES_PATH);
  const manual = { ...(prefs.manual || {}) };
  if (weight === null || weight === '' || weight === undefined) { if (!(k in manual)) throw Error('没有这条手动偏好'); delete manual[k]; }
  else manual[k] = num(weight, -WEIGHT_CAP, WEIGHT_CAP);
  const backup = backupFile(PREFERENCES_PATH, now); // 设置页写着「每次都留备份」：手动偏好也一样
  write(PREFERENCES_PATH, { ...prefs, manual, manual_updated_at: iso(now) });
  resetPreferencesCache();
  event('user', 'settings', 'ok', `操作台${weight == null || weight === '' ? '撤销' : '设置'}手动偏好 ${k}${weight == null || weight === '' ? '' : ' = ' + manual[k]}`);
  return { status: 'saved', manual, backup };
}
