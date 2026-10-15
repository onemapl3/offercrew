// Patch 的「记账」技能（2026-09-29，design/团队与工作流.md 第 1.4、3 节；design/竞品代码对齐.md WS1）：
// 模型花了多少 token、大约多少钱、花在哪位成员身上、为哪件事、谁发起的。说明在 docs/cost.md。
//
//   账     state/usage.ndjson，每次模型调用、每个执行器会话一行，只追加：at（发生的时间）、logged_at（记账的时间）、
//          member（6 位成员之一：scout / lens / tailor / quill / owl / patch，由 crewMember 这一个函数定）、
//          role（调用方给的老编号，原样留着：radar / reacher / watch / system / executor）、launcher（谁发起的：启动的脚本，
//          judge-leads / match / serve（工作台）/ cycle（定时周期）/ run-now（即时执行）/ mail-poll（收件箱巡检）…）、
//          step（哪件事：judge 判断 · match 逐条匹配 · evaluate 一页评估 · mail 读来信 · rewrite 改写 · chat 对话 ·
//          research 公司调研 · contacts / referrers 找人 · intent 听懂指令 · cycle / run-now / mail-poll 执行器会话 …）、
//          member_note（归属是猜的时写明为什么）、backend（驱动）、provider（模型目录里的供应商）、model、
//          input_tokens（整份输入）、cached_tokens（其中命中缓存的）、cache_write_tokens、output_tokens、
//          billing（subscription 订阅额度 / api 按 token 付钱 / credits OfferCrew 补给，lib/free-model.mjs）、credits（这次花了多少补给，
//          中转在响应头里说的）、lead_id / job_id、status。
//          role、launcher、step 都原样留着：成员表定稿、归属规则改了，可以从账上重算。
//          各家对「输入含不含缓存」的写法不一样，在 tokensOf 里对齐。写账出错只丢这一行，从不让模型调用本身失败。
//   来源   lib/model.mjs（文字 / 图片）、lib/judge.mjs（Jev）、lib/chat.mjs（对话）、lib/operator/models.mjs（内置操作员）、
//          lib/codex-computer.mjs（Codex 电脑操作）、执行器会话（syncCodexSessions：Codex 自己的会话记录；Claude 执行器
//          读我们自己的 stream-json 日志，claudeLogRows）。启动脚本跑完会记一次（bin/host/record-usage.mjs），
//          工作台每 10 分钟再对一遍（还在跑的会话、漏记的）。
//   隐私   Codex 的会话记录里有完整对话。这里只读三样：开头 session_meta 的 cwd（只算从本产品目录启动的会话）、
//          token_count 事件里的 total_token_usage、rate_limits.primary（本周额度已用百分比）；再加 turn_context 里的型号名。
//          对话内容一个字都不解析、不存、不显示。会话记录的位置：CODEX_HOME（没设就是 ~/.codex）、模型目录里各账号的
//          登录目录、config/host.json 的 codex_homes。
//   价格   config/prices.json（本机，可改；没有就读模板 config/prices.example.json）：每百万 token 的价。钱一律是估算，
//          页面上写价格表的日期；只给按 token 付钱的算钱，订阅（Claude Code 登录、Codex 用 ChatGPT 登录）只记 token。
//   读账   只读尾巴（ledgerSince）：按记账时间 logged_at 从后往前读到窗口之前就停；同一个 id 记了几次以最后一次为准
//          （还在跑的会话越记越大）。
//   补账   第一次写账时（state/usage.ndjson 还不存在）把最近 14 天的旧记录补进来：runs/<日>/usage.json 和执行器会话。
//          只补第一行实时记录之前的，不和实时的重叠。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file, hash, root, configSource } from './store.mjs';
import { TZ, zonedTime } from './tz.mjs';
import { loadProviders } from './backends.mjs';
import { FREE_PROVIDER, freeQuotaView } from './free-model.mjs';
import { CREW_IDS, isMember, crewOf, crewName, crewMember as crewRow } from './crew.mjs';
import { event } from './events.mjs';
import { noteSwallowed } from './swallow.mjs';

export const LEDGER = 'state/usage.ndjson';
export const PRICES = 'config/prices.json';
export const STEP_LABEL = {
  judge: '判断岗位', match: '逐条匹配', evaluate: '一页评估', mail: '读来信', rewrite: '改写草稿', chat: '对话', research: '公司调研', contacts: '找招聘邮箱',
  referrers: '找内推人', intent: '听懂指令', 'add-lead': '收录链接', 'resume-import': '导入简历', 'resume-review': '简历体检与改写', 'resume-tailor': '按岗位定制简历',
  letter: '求职信与自我介绍', operator: '内置操作员', 'computer-use': 'Codex 电脑操作',
  'run-now': '即时执行', cycle: '定时周期', 'mail-poll': '收件箱巡检', executor: '本机 AI 会话（不确定是谁发起的）', test: '测试连接', other: '其他',
};
export const LAUNCHER_LABEL = {
  cycle: '定时周期', 'run-now': '即时执行', 'mail-poll': '收件箱巡检', 'codex-session': '其他 Codex 会话',
  'judge-leads': '判断新岗位', match: '逐条匹配', evaluate: '一页评估', inbox: '读来信', 'find-contacts': '找联系人', 'find-referrers': '找内推人',
  'add-lead': '收录转发的链接', 'auto-apply': '填申请表', 'tailor-resumes': '按岗位定制简历', operator: '内置操作员', 'computer-use': 'Codex 电脑操作', serve: '工作台（对话、改写…）', other: '其他',
};
// 执行器会话的发起方（页面上标「会话」）。
export const SESSION_LAUNCHERS = ['cycle', 'run-now', 'mail-poll', 'codex-session'];
export const BACKEND_LABEL = { anthropic_http: 'Anthropic 兼容 API', openai_http: 'OpenAI 兼容 API', claude_code: 'Claude Code 登录', codex_exec: 'Codex', jev: '判断模型', http_api: '旧 HTTP 接口' };
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
export const dayOf = t => DAY_FMT.format(new Date(t));
export const dayStart = day => zonedTime(day, '00:00:00', TZ);
const int = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };
const MEMBER_ID = /^[a-z][a-z0-9_-]{0,31}$/;

// ── 记到谁名下 ─────────────────────────────────────────────────────────────────
// 老编号 → 6 位成员：只问名册（lib/crew.mjs crewOf，事件、暂停、页面、对话都用它）。账上留着 role / launcher / step，可以重算。
//   radar    按步骤分：发现类的（扫官网、扫真人帖、收录）归 Scout，判断类的（判断、匹配、一页评估）归 Lens；
//            没写步骤的按 ROLE_STEP 当成匹配（Lens）；配上不在它名下的步骤（比如对话 chat）归 Scout——对话页把原来
//            Radar 的会话显示成 Scout（feat/talk），钱跟着你当时说话的那张脸走
//   reacher  → Quill；watch → Owl，公司调研归 Lens；system → Patch，简历导入归 Tailor
//   executor 大家共用的手：记到请它做事的成员——交给它的任务（job_kind）是谁的活就记谁；会话本身能认出是谁的
//            （mail-poll 收件箱巡检 → Owl）就记谁；分不开的（一整轮 cycle、混着几件事的 run-now）记到 Patch，
//            member_note 写明为什么
export const CREW = CREW_IDS;
export const MEMBER_LABEL = Object.fromEntries(CREW_IDS.map(id => [id, crewRow(id).label]));
export const UNKNOWN_EXECUTOR_NOTE = `认不出是哪位成员请本机 AI 做的，先记在 ${crewName('patch')} 名下`;
export function crewMember({ member = null, role = null, step = null, job_kind = null } = {}) {
  if (isMember(member)) return { member };
  const old = MEMBER_ID.test(String(member || '')) ? member : role;
  const id = MEMBER_ID.test(String(old || '')) ? old : null;
  const who = crewOf(id, { step, job_kind });
  if (who && !(who === 'patch' && (!id || id === 'executor'))) return { member: who };
  if (who === 'patch' || !id || id === 'executor') return { member: 'patch', note: UNKNOWN_EXECUTOR_NOTE };
  return { member: 'patch', note: `不认识的成员编号 ${id}，先记在 ${crewName('patch')} 名下` };
}
// 调用方不说的时候按请求 id 认：Jev 的问题集（lib/judgements.mjs）和各处的 request_id 有固定前缀。
const BY_REQUEST = [
  [/^(?:posting|match)-/, 'radar', 'judge'], [/^eval-/, 'radar', 'evaluate'], [/^add-lead-/, 'radar', 'add-lead'],
  [/^(?:mail|inbox)-/, 'watch', 'mail'], [/^person-/, 'reacher', 'referrers'], [/^contact-/, 'reacher', 'contacts'],
  [/^rewrite-/, 'reacher', 'rewrite'], [/^intent-/, 'system', 'intent'], [/^resume-import-/, 'system', 'resume-import'], [/^chat-/, null, 'chat'],
  // Tailor 的「材料」页（lib/resume-assistant.mjs 体检和改写、resume-tailor.mjs 按岗位定制、resume-letters.mjs 求职信和
  // 自我介绍）：调用 infer 时不带成员，按请求 id 记到 Tailor 名下。
  [/^resume-review-/, 'tailor', 'resume-review'], [/^resume-tailor-/, 'tailor', 'resume-tailor'], [/^tailor-(?:cover_letter|self_intro|email)-/, 'tailor', 'letter'],
];
const ROLE_STEP = { radar: 'match', watch: 'mail', reacher: 'rewrite', system: 'other', executor: 'executor' };
// 谁发起的：启动这次调用的脚本（bin/judge-leads.mjs → judge-leads；工作台 → serve）。执行器会话由启动脚本明说。
const LAUNCHER = (() => { const n = path.basename(String(process.argv[1] || ''), '.mjs'); return /^[a-z][a-z0-9-]{0,40}$/.test(n) ? n : 'other'; })();
export function attribute({ request_id = '', role = null, member = null, step = null, launcher = null } = {}) {
  const hit = BY_REQUEST.find(([re]) => re.test(String(request_id || '')));
  const ok = x => typeof x === 'string' && MEMBER_ID.test(x);
  const raw = [member, role, hit?.[1]].find(ok) || null, old = [role, member, hit?.[1]].find(x => ok(x) && !CREW.includes(x)) || null;
  const s = step || hit?.[2] || ROLE_STEP[raw] || 'other';
  const who = crewMember({ member: raw, step: s });
  return { member: who.member, ...(who.note ? { note: who.note } : {}), ...(old ? { role: old } : {}), step: s, launcher: launcher || LAUNCHER };
}

// ── token：各家写法对齐 ────────────────────────────────────────────────────────
//   Claude（Messages 接口、claude -p 的 usage）：input_tokens 不含缓存，缓存读 / 写另列；cache_creation 里分 5 分钟 / 1 小时。
//   claude -p 的 modelUsage：同上，驼峰。OpenAI chat：prompt_tokens 含 prompt_tokens_details.cached_tokens；
//   responses：input_tokens 含 input_tokens_details.cached_tokens。DeepSeek：prompt_tokens 含 prompt_cache_hit_tokens。
//   Codex（--json 的 turn.completed、会话记录的 total_token_usage）：input_tokens 含 cached_input_tokens。Jev：input / output。
export function tokensOf(u) {
  if (!u || typeof u !== 'object') return null;
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    const hit = int(u.cache_read_input_tokens), put = int(u.cache_creation_input_tokens), hour = int(u.cache_creation?.ephemeral_1h_input_tokens);
    return { input_tokens: int(u.input_tokens) + hit + put, cached_tokens: hit, cache_write_tokens: put, ...(hour ? { cache_write_1h_tokens: Math.min(hour, put) } : {}), output_tokens: int(u.output_tokens) };
  }
  if ('inputTokens' in u || 'outputTokens' in u) {
    const hit = int(u.cacheReadInputTokens), put = int(u.cacheCreationInputTokens);
    return { input_tokens: int(u.inputTokens) + hit + put, cached_tokens: hit, cache_write_tokens: put, output_tokens: int(u.outputTokens) };
  }
  const input = int(u.input_tokens ?? u.prompt_tokens), output = int(u.output_tokens ?? u.completion_tokens);
  const hit = int(u.cached_input_tokens ?? u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens);
  if (!input && !output) return null;
  return { input_tokens: input, cached_tokens: Math.min(hit, input), cache_write_tokens: 0, output_tokens: output };
}
export const tokensTotal = r => int(r?.input_tokens) + int(r?.output_tokens);
export const uncachedInput = r => Math.max(0, int(r?.input_tokens) - int(r?.cached_tokens));

// ── 价格表 ─────────────────────────────────────────────────────────────────────
let priceCache = null;
export function loadPrices() {
  const src = configSource(PRICES);
  let sig = '-'; try { const s = fs.statSync(file(src)); sig = `${src}:${s.mtimeMs}:${s.size}`; } catch {} // 兜底：价格表文件不在就没有签名，按「-」缓存
  if (priceCache?.sig === sig) return priceCache.value;
  let value = null, broken = null; try { value = src ? JSON.parse(fs.readFileSync(file(src), 'utf8')) : null; } catch { value = null; broken = src; }
  // 本机的价格表读坏了：照实说（broken），改读仓库里的模板，不当成空表（空表 = 什么都不计钱，花费上限就失灵了）。
  if (broken && src !== 'config/prices.example.json') { try { value = JSON.parse(fs.readFileSync(file('config/prices.example.json'), 'utf8')); } catch { value = null; } } // 兜底：模板也读不出来时，上面的 broken 已经照实带出去了
  // 本机的价格表是以前复制的：模板里后来加的型号（例如 claude-haiku-5-5）它没有，照模板补上（本机写了的照本机），
  // 免得新型号按最贵的价保守地算，花费上限被它提前用完。
  if (value && !broken && src && src !== 'config/prices.example.json') { try { const t = JSON.parse(fs.readFileSync(file('config/prices.example.json'), 'utf8')); value = { ...value, models: { ...(t.models || {}), ...(value.models || {}) }, aliases: { ...(t.aliases || {}), ...(value.aliases || {}) } }; } catch {} } // 兜底：模板读不出来就只用本机的
  value = { models: {}, aliases: {}, providers: {}, usd_cny: 7, ...(value || {}), file: src || null, ...(broken ? { broken } : {}) };
  priceCache = { sig, value };
  return value;
}
// 型号 → 价格：先认别名（sonnet、gpt-6、deepseek-chat），再精确，再最长前缀（带日期的型号：claude-haiku-4-5-20251001）。
export function priceFor(model, prices = loadPrices()) {
  const models = prices?.models || {}, aliases = prices?.aliases || {};
  let m = String(model || '').trim().toLowerCase();
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  if (!m || m === 'default') return null;
  if (aliases[m]) m = String(aliases[m]).toLowerCase();
  if (models[m]) return { key: m, ...models[m] };
  const key = Object.keys(models).filter(k => m.startsWith(k) && /^[-.@_:]/.test(m.slice(k.length))).sort((a, b) => b.length - a.length)[0];
  return key ? { key, ...models[key] } : null;
}
// 订阅不算钱：Claude Code 用账号登录（claude_code）、Codex 用 ChatGPT 登录（内置的 openai 供应商和它的多账号）。
// 价格表 providers.<供应商>.billing 可以改判（公司付费的网关算 subscription；Codex 用 API key 登录的算 api）。
// OfferCrew 补给（供应商 offercrew）是 credits：记 token 和补给，你付的钱是 ¥0。
export function billingOf({ backend = null, provider = null, codex_provider = null } = {}, prices = loadPrices()) {
  if (provider === FREE_PROVIDER) return 'credits';
  const own = prices?.providers?.[provider]?.billing;
  if (own === 'subscription' || own === 'api') return own;
  if (backend === 'claude_code') return 'subscription';
  if (backend === 'codex_exec' && (codex_provider || String(provider || '').split('@')[0]) === 'openai') return 'subscription';
  return 'api';
}
// 一行账大约多少美元。订阅是 0（subscription: true）；价格表里没有这个型号是 null（priced: false）。
export function costOf(row = {}, prices = loadPrices()) {
  const billing = row.billing || billingOf(row, prices);
  if (billing === 'subscription') return { usd: 0, billing, priced: true, subscription: true };
  if (billing === 'credits') return { usd: 0, billing, priced: true, credits: true };
  if (!tokensTotal(row)) return { usd: 0, billing, priced: true };
  // 价格表里没有这个型号：按表里最贵的价保守地算（计入每天的美元上限），并标 priced: false，页面照实列出「未定价」。
  const p0 = priceFor(row.model, prices) || { ...conservativePrice(prices), conservative: true };
  // 一次输入超过某个量就换一档价（Haiku 5.5：10 万 token 以上，价格表里的 long）。
  const p = p0.long && int(row.input_tokens) > (Number(p0.long.above) || Infinity) ? { ...p0, ...p0.long } : p0;
  const input = int(row.input_tokens), hit = Math.min(int(row.cached_tokens), input), put = Math.min(int(row.cache_write_tokens), input - hit), hour = Math.min(int(row.cache_write_1h_tokens), put);
  const pin = Number(p.input) || 0, fx = p.currency === 'CNY' ? 1 / (Number(prices.usd_cny) || 7) : 1, mult = Number(prices.providers?.[row.provider]?.multiplier) || 1;
  const usd = ((input - hit - put) * pin + hit * (p.cached ?? pin) + (put - hour) * (p.cache_write ?? pin * 1.25) + hour * (p.cache_write_1h ?? pin * 2) + int(row.output_tokens) * (Number(p.output) || 0)) / 1e6 * fx * mult;
  return { usd, billing, priced: !p.conservative, price: p, ...(p.conservative ? { conservative: true } : {}) };
}
// 保守价：价格表里每百万 token 最贵的输入价和输出价（人民币标价按汇率折成美元）；表是空的就用 15 / 75 美元。
export function conservativePrice(prices = loadPrices()) {
  const fx = Number(prices?.usd_cny) || 7, list = Object.values(prices?.models || {}).map(m => ({ input: (Number(m.input) || 0) / (m.currency === 'CNY' ? fx : 1), output: (Number(m.output) || 0) / (m.currency === 'CNY' ? fx : 1) }));
  const input = Math.max(15, ...list.map(m => m.input)), output = Math.max(75, ...list.map(m => m.output));
  return { key: 'conservative', input, output, currency: 'USD' };
}
// 文字模型按价排序：高级档（spend_tier=premium）把最贵的（当作最好的）放前面。订阅的底座按它对应型号的价排
// （sonnet → Claude Sonnet）；Codex 写 default 的按 config.toml 里的默认型号（default_model）。认不出的型号排最后。
export function rankBackends(order = [], prefer = null, prices = loadPrices()) {
  if (!['best', 'cheapest'].includes(prefer) || order.length < 2) return order;
  const price = b => Number(priceFor(String(b?.model || '').toLowerCase() === 'default' ? b.default_model : b?.model, prices)?.output) || 0;
  return order.map((b, i) => ({ b, i, p: price(b) })).sort((x, y) => (!x.p - !y.p) || (prefer === 'best' ? y.p - x.p : x.p - y.p) || x.i - y.i).map(x => x.b);
}

// ── 写账 ─────────────────────────────────────────────────────────────────────
// row：{ at, member?, step?, role?, request_id?, backend, provider, codex_provider?, model, usage（原样）| 各项 tokens,
//        lead_id?, job_id?, status: 'ok' | 'failed', duration_ms?, id? }。返回规整好的一行。
export function usageRow(row = {}) {
  const at = row.at ? new Date(row.at).toISOString() : new Date().toISOString();
  const who = attribute(row);
  const t = row.usage ? tokensOf(row.usage) : tokensOf(row);
  const hour = Math.min(t?.cache_write_1h_tokens || int(row.cache_write_1h_tokens), t?.cache_write_tokens || 0);
  const out = {
    id: row.id || `u_${hash([row.request_id || '', at, row.backend || '', row.model || ''])}`.slice(0, 18), at, member: who.member, ...(who.role ? { role: who.role } : {}), launcher: who.launcher, step: who.step,
    ...(row.member_note || who.note ? { member_note: row.member_note || who.note } : {}),
    backend: row.backend || null, provider: row.provider || null, model: row.model ? String(row.model) : null,
    input_tokens: t?.input_tokens || 0, cached_tokens: t?.cached_tokens || 0, cache_write_tokens: t?.cache_write_tokens || 0, output_tokens: t?.output_tokens || 0,
    ...(hour ? { cache_write_1h_tokens: hour } : {}), ...(t ? {} : { no_usage: true }), status: row.status === 'failed' ? 'failed' : 'ok',
  };
  out.billing = row.billing || billingOf({ backend: out.backend, provider: out.provider, codex_provider: row.codex_provider });
  // 做了什么（给人看的一句，10-03 负责人：用量页一行一件事）：调用方写的，没写的按步骤显示。
  if (row.what) out.what = String(row.what).replace(/\s+/g, ' ').trim().slice(0, 80);
  for (const k of ['lead_id', 'job_id', 'request_id', 'duration_ms', 'source', 'quota', 'reported_usd', 'log', 'session', 'started_at', 'origin', 'why_kind', 'fallback_from', 'requested_model', 'reported_model']) if (row[k] != null && row[k] !== '') out[k] = row[k];
  if (Number.isFinite(Number(row.credits)) && row.credits !== null && row.credits !== '') out.credits = Math.round(Number(row.credits) * 100) / 100;
  if (Array.isArray(row.job_ids) && row.job_ids.length) out.job_ids = row.job_ids.slice(0, 20);
  return out;
}
const appendRows = rows => {
  if (!rows.length) return 0;
  const at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file(LEDGER)), { recursive: true });
  fs.appendFileSync(file(LEDGER), rows.map(r => JSON.stringify({ ...r, logged_at: r.logged_at || at })).join('\n') + '\n');
  return rows.length;
};
// 第一次写账（账还不存在）先补旧账：只补这一行之前的，所以同一次调用不会既补又记。空账先建出来，补账里再记账不会又来补一遍。
function firstWrite(at, { codex = true } = {}) {
  if (fs.existsSync(file(LEDGER))) return false;
  fs.mkdirSync(path.dirname(file(LEDGER)), { recursive: true });
  fs.writeFileSync(file(LEDGER), '', { flag: 'a' });
  try { backfillUsage({ now: at, before: at - 1000, codex }); } catch (e) { noteSwallowed('usage.backfill', e, { doing: '补旧的用量账', then: '旧账先不补，新的照常记' }); }
  return true;
}
// 老数据目录第一次打开「运行与用量」：账还不存在就先补旧账，不用等下一次调用模型才看到历史（bin/serve.mjs 在 /api/usage 读之前调）。
// usageView 本身只读；codex:false 不去读执行器会话目录（沙盒）。补过一次就返回 false。
export function ensureLedger({ now = Date.now(), codex = true } = {}) {
  try { return firstWrite(now + 1000, { codex }); } catch (e) { noteSwallowed('usage.ensureLedger', e, { doing: '建用量账', then: '这次先不看旧账' }); return false; }
}
let lastWriteFail = 0;
export function recordUsage(row = {}) {
  try {
    const out = usageRow(row);
    firstWrite(Date.parse(out.at) || Date.now());
    out.logged_at = new Date().toISOString();
    appendRows([out]);
    return out;
  } catch (e) {
    // 写不进去（磁盘满、权限）：花费上限靠这本账，漏记就少算。照实记一条事件（十分钟内只记一次），模型调用本身不受影响。
    if (Date.now() - lastWriteFail > 600000) { lastWriteFail = Date.now(); try { event('patch', 'usage', 'fail', `用量账写不进去，这次的用量没记上（${String(e?.message || e).slice(0, 120)}）`); } catch {} } // 兜底：记事件本身失败不能挡模型调用
    return null;
  }
}
// 追加还没记过、或者记过但数变了的行（按 id；还在跑的会话越记越大）。返回新记的行数。
export function recordRows(rows = []) {
  if (!rows.length) return 0;
  firstWrite(Math.min(...rows.map(r => Date.parse(r.at) || Date.now())));
  const last = new Map(ledgerSince(Math.min(...rows.map(r => Date.parse(r.started_at || r.at) || Date.now())) - 2 * 86400000).map(r => [r.id, r]));
  const same = (a, b) => ['input_tokens', 'cached_tokens', 'output_tokens', 'member', 'launcher', 'step', 'model'].every(k => a[k] === b[k]) && a.quota?.used_percent === b.quota?.used_percent;
  return appendRows(rows.filter(r => r.id && !(last.has(r.id) && same(last.get(r.id), r)) && (last.set(r.id, r), true)));
}

// ── 读账 ─────────────────────────────────────────────────────────────────────
// at 在 since 之后的行（同一个 id 取最后记的那次、按 at 排）。从文件尾往前读，读到一行记账时间早于 since 一小时就停。
const tailCache = new Map();
export function ledgerSince(since = 0) {
  const p = file(LEDGER);
  let st; try { st = fs.statSync(p); } catch { return []; } // 兜底：账还不存在就是没有用量
  const sig = `${st.mtimeMs}:${st.size}:${st.ino}`, hit = tailCache.get(since);
  if (hit?.sig === sig) return hit.rows;
  const stopBefore = since - 3600000;
  let bytes = 256 * 1024, rows = [];
  for (;;) {
    const start = Math.max(0, st.size - bytes), buf = Buffer.alloc(st.size - start), fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const raw = buf.toString('utf8').split('\n');
    if (start) raw.shift();
    rows = raw.flatMap(s => { if (!s) return []; try { const r = JSON.parse(s); return r && typeof r === 'object' ? [r] : []; } catch { return []; } }); // 兜底：一行坏了跳过这一行
    if (!start || rows.some(r => Date.parse(r.logged_at || r.at) < stopBefore)) break;
    bytes *= 4;
  }
  const byId = new Map();
  rows.forEach((r, i) => byId.set(r.id || `#${i}`, r));
  const out = [...byId.values()].filter(r => Date.parse(r.at) >= since).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (tailCache.size > 8) tailCache.clear();
  tailCache.set(since, { sig, rows: out });
  return out;
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const blank = () => ({ calls: 0, failed: 0, tokens: 0, input_tokens: 0, cached_tokens: 0, uncached_tokens: 0, output_tokens: 0, usd: 0, subscription_tokens: 0, api_tokens: 0, credit_tokens: 0, credits: 0, unpriced_calls: 0, unpriced_tokens: 0, no_usage_calls: 0 });
function add(t, r, c) {
  const n = tokensTotal(r);
  t.calls++; if (r.status === 'failed') t.failed++; if (r.no_usage && r.status !== 'failed') t.no_usage_calls++;
  t.tokens += n; t.input_tokens += int(r.input_tokens); t.cached_tokens += int(r.cached_tokens); t.uncached_tokens += uncachedInput(r); t.output_tokens += int(r.output_tokens);
  if (c.subscription) t.subscription_tokens += n; else if (c.credits) { t.credit_tokens += n; t.credits += Number(r.credits) || 0; } else t.api_tokens += n;
  if (c.priced === false) { t.unpriced_calls++; t.unpriced_tokens += n; }
  t.usd += Number(c.usd) || 0;
  return t;
}
const withCny = (t, prices) => ({ ...t, usd: Math.round(t.usd * 1e6) / 1e6, cny: Math.round(t.usd * (Number(prices.usd_cny) || 7) * 1e4) / 1e4, credits: Math.round(t.credits * 100) / 100 });
export function totals(rows = [], prices = loadPrices()) {
  const t = blank();
  for (const r of rows) add(t, r, costOf(r, prices));
  return withCny(t, prices);
}
const groupBy = (rows, key, prices) => {
  const m = new Map();
  for (const r of rows) { const k = key(r); const t = m.get(k) || m.set(k, blank()).get(k); add(t, r, costOf(r, prices)); }
  return [...m].map(([k, t]) => ({ key: k, ...withCny(t, prices) })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
};
// 今天用了多少（顶栏、每日上限都看它）。
export function dayTotals(now = Date.now(), prices = loadPrices()) {
  const day = dayOf(now);
  return { day, ...totals(ledgerSince(dayStart(day)), prices) };
}
// 订阅额度：Codex 的本周已用百分比来自会话记录（最近读到的那一次）；Claude 本机读不到，照实说。
export function quotaView(rows = []) {
  const q = rows.filter(r => r.quota?.used_percent != null).sort((a, b) => String(a.quota.read_at || a.at).localeCompare(String(b.quota.read_at || b.at))).at(-1)?.quota || null;
  return {
    codex: q ? { used_percent: q.used_percent, window_minutes: q.window_minutes ?? null, resets_at: q.resets_at ? new Date(Number(q.resets_at) * 1000).toISOString() : null, read_at: q.read_at || null, plan: q.plan || null } : null,
    claude: { readable: false, note: 'Claude 订阅的剩余额度本机读不到' },
    // OfferCrew 补给：最近一次知道的余额（中转每次回答都会带回来；不联网）。
    free: (() => { try { return freeQuotaView(); } catch (e) { noteSwallowed('usage.freeQuota', e, { doing: '读补给的余额', then: '余额先空着' }); return null; } })(),
  };
}
const OPS_MAX = 300;
// 用量页一行算多少 token：没命中缓存的输入 + 输出 + 命中缓存的输入 × 0.1（relay/model/worker.mjs countedTokens 同一个算法）。
export const countedTokens = r => Math.ceil(uncachedInput(r) + int(r.output_tokens) + int(r.cached_tokens) * 0.1);
function opRow(r) {
  return { id: r.id, at: r.at, member: r.member || 'patch', member_label: MEMBER_LABEL[r.member] || r.member || '', what: r.what || STEP_LABEL[r.step] || STEP_LABEL.other, step: r.step || 'other', model: r.model || null, provider: r.provider || null, backend: r.backend || null, tokens: r.billing === 'credits' && Number.isFinite(Number(r.credits)) && r.credits !== null ? Math.round(Number(r.credits)) : countedTokens(r), uncached_tokens: uncachedInput(r), input_tokens: int(r.input_tokens), cached_tokens: int(r.cached_tokens), output_tokens: int(r.output_tokens), billing: r.billing || null, status: r.status || 'ok' };
}
// 「运行与用量」要的：近 days 天按天、按成员、按谁发起、按模型，外加今天、这一周的合计，订阅额度。
export function usageView({ now = Date.now(), days = 7, prices = loadPrices() } = {}) {
  const today = dayOf(now), keys = Array.from({ length: days }, (_, i) => dayOf(dayStart(today) - (days - 1 - i) * 86400000 + 43200000));
  const rows = ledgerSince(dayStart(keys[0])), todayRows = rows.filter(r => dayOf(r.at) === today);
  const byDay = new Map(keys.map(k => [k, []])); for (const r of rows) byDay.get(dayOf(r.at))?.push(r);
  const keyOf = r => `${r.provider || r.backend || '?'}/${r.model || '?'}`;
  const models = groupBy(rows, keyOf, prices).map(g => {
    const r = rows.find(x => keyOf(x) === g.key) || {}, c = costOf(r, prices), p = priceFor(r.model, prices);
    return { ...g, provider: r.provider || null, backend: r.backend || null, backend_label: BACKEND_LABEL[r.backend] || r.backend || '', model: r.model || null, billing: c.billing, price: p ? { key: p.key, input: p.input, cached: p.cached ?? null, output: p.output, currency: p.currency || 'USD', note: p.note || null } : null };
  });
  // 按成员、按发起方：token 多的在前（钱在旁边一列），发起方标上是不是执行器会话。
  const both = (list, label) => list.map(g => ({ ...g, label: label[g.key] || g.key, ...(SESSION_LAUNCHERS.includes(g.key) && label === LAUNCHER_LABEL ? { session: true } : {}) })).sort((a, b) => b.tokens - a.tokens || b.usd - a.usd);
  return {
    today: { day: today, ...totals(todayRows, prices) }, week: { from: keys[0], to: today, ...totals(rows, prices) },
    days: keys.map(k => ({ day: k, ...totals(byDay.get(k), prices) })),
    by_member: both(groupBy(rows, r => r.member || 'system', prices), MEMBER_LABEL), by_member_today: both(groupBy(todayRows, r => r.member || 'system', prices), MEMBER_LABEL),
    by_step: both(groupBy(rows, r => r.step || 'other', prices), STEP_LABEL), by_step_today: both(groupBy(todayRows, r => r.step || 'other', prices), STEP_LABEL),
    by_launcher: both(groupBy(rows, r => r.launcher || 'other', prices), LAUNCHER_LABEL), by_launcher_today: both(groupBy(todayRows, r => r.launcher || 'other', prices), LAUNCHER_LABEL),
    // 一次操作一行（10-03 负责人）：最新的在前，最多 OPS_MAX 行。tokens = 这次算多少：没命中缓存的输入 + 输出 + 命中缓存的 × 0.1
    //（和中转扣补给同一个算法；补给的行用中转说的数）；原始的三个数在详情里。
    ops: rows.slice(-OPS_MAX).reverse().map(opRow),
    notes: [...new Set(rows.map(r => r.member_note).filter(Boolean))].slice(0, 6),
    by_model: models,
    unpriced: [...new Set(rows.filter(r => costOf(r, prices).priced === false).map(r => r.model || '?'))].slice(0, 12),
    ...(prices.broken ? { prices_broken: prices.broken } : {}),
    quota: quotaView(rows),
    prices: { updated: prices.updated || null, file: prices.file, usd_cny: Number(prices.usd_cny) || 7, sources: (prices.sources || []).map(s => ({ name: s.name, url: s.url, checked: s.checked })) },
    ledger: fs.existsSync(file(LEDGER)),
  };
}

// ── 执行器会话：Codex ──────────────────────────────────────────────────────────
// 会话记录：<home>/sessions/YYYY/MM/DD/rollout-<本地时间>-<会话 id>.jsonl。只读：第一行 session_meta 里 base_instructions
// 之前的那几个字段（会话 id、开始时间、cwd、供应商、发起方），turn_context 行里的型号名，token_count 行（只有数字）。
// 其余每一行都只按开头认类型，不解析。
const head = (p, n = 65536) => { const fd = fs.openSync(p, 'r'); try { const b = Buffer.alloc(n), k = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, k).toString('utf8'); } finally { fs.closeSync(fd); } };
const tailText = (p, size, n) => { const fd = fs.openSync(p, 'r'), len = Math.min(size, n), b = Buffer.alloc(len); try { fs.readSync(fd, b, 0, len, size - len); } finally { fs.closeSync(fd); } return b.toString('utf8'); };
const field = (s, k) => { const m = new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`).exec(s); if (!m) return null; try { return JSON.parse(`"${m[1]}"`); } catch { return null; } }; // 兜底：这个字段转义坏了就当没有
const LINE = type => new RegExp(`^\\{"timestamp":"[^"]*",(?:"ordinal":\\d+,)?"type":"${type}","payload":\\{`);
const TOKEN_LINE = new RegExp(`^\\{"timestamp":"[^"]*",(?:"ordinal":\\d+,)?"type":"event_msg","payload":\\{"type":"token_count"`);
// cwd：只要从这个目录启动的会话；别的目录的会话读完第一行那几个字段就放下，后面一行都不碰。结果按文件大小和修改时间记住。
const rolloutCache = new Map();
export function readRollout(p, { cwd: want = null } = {}) {
  let st; try { st = fs.statSync(p); } catch { return null; } // 兜底：会话文件不在就是没有
  const key = `${p}|${want || ''}`, hit = rolloutCache.get(key);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.value;
  const value = readRolloutFresh(p, st, want);
  if (rolloutCache.size > 2000) rolloutCache.clear();
  rolloutCache.set(key, { size: st.size, mtime: st.mtimeMs, value });
  return value;
}
function readRolloutFresh(p, st, want) {
  const first = head(p).split('\n')[0];
  if (!LINE('session_meta').test(first)) return null;
  const meta = first.slice(0, first.indexOf('"base_instructions"') > 0 ? first.indexOf('"base_instructions"') : first.length);
  const session = field(meta, 'session_id') || field(meta, 'id'), cwd = field(meta, 'cwd');
  if (!session || !cwd) return null;
  if (want && !sameDir(cwd, want)) return { session, cwd, other: true };
  const out = { session, cwd, started_at: field(meta, 'timestamp') || null, provider: field(meta, 'model_provider'), origin: field(meta, 'originator'), model: null, usage: null, quota: null, last_at: null, size: st.size, mtime: st.mtimeMs };
  for (const n of [256 * 1024, 4 * 1024 * 1024]) {
    const text = tailText(p, st.size, n);
    for (const s of text.split('\n')) {
      if (TOKEN_LINE.test(s)) { try { const e = JSON.parse(s), u = e.payload?.info?.total_token_usage, q = e.payload?.rate_limits?.primary; if (u) { out.usage = u; out.last_at = e.timestamp || out.last_at; } if (q && Number.isFinite(Number(q.used_percent))) out.quota = { used_percent: Number(q.used_percent), window_minutes: q.window_minutes ?? null, resets_at: q.resets_at ?? null, plan: e.payload.rate_limits.plan_type || null, read_at: e.timestamp || null }; } catch {} } // 兜底：一行坏了跳过这一行
      else if (LINE('turn_context').test(s)) out.model = field(s.slice(0, 4000), 'model') || out.model;
    }
    if (out.usage || n >= st.size) break;
  }
  return out;
}
const sameDir = (a, b) => { const r = x => { try { return fs.realpathSync(x); } catch { return path.resolve(String(x || '')); } }; return !!a && r(a).replace(/\/+$/, '') === r(b).replace(/\/+$/, ''); };
// 会话记录在哪：明确设了的 CODEX_HOME、模型目录里各账号的登录目录、host.json 的 codex_homes。不默认去翻 ~/.codex：
// 那是用户自己的 Codex（10-02 开箱第 2 轮 X2：新装的 App 一启动就把那里最近 14 天的会话补进了账）。执行器这一次用的
// 正是 ~/.codex 时，由启动脚本的记账（bin/host/record-usage.mjs）带着这次的会话号去读那几个文件。
export const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
export function codexHomes(providers = null) {
  let catalog = []; try { catalog = Object.values(providers || loadProviders()).filter(p => p.kind === 'codex_exec' && p.codex_home).map(p => path.isAbsolute(p.codex_home) ? p.codex_home : file(p.codex_home)); } catch {} // 兜底：模型目录读坏了会在设置和体检里报；这里只少几个会话目录
  let extra = []; try { extra = (JSON.parse(fs.readFileSync(file('config/host.json'), 'utf8')).codex_homes || []).map(h => String(h).replace(/^~(?=\/)/, os.homedir())); } catch {} // 兜底：没有 host.json 是常态，就没有额外的会话目录
  return [...new Set([process.env.CODEX_HOME, ...catalog, ...extra].filter(Boolean))];
}
const localParts = t => { const d = new Date(t); return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')]; };
export function rolloutFiles({ homes = codexHomes(), days = 2, now = Date.now(), sessions = null } = {}) {
  const out = [];
  for (const home of homes) for (let d = 0; d < days + 1; d++) {
    const dir = path.join(home, 'sessions', ...localParts(now - d * 86400000));
    let names = []; try { names = fs.readdirSync(dir).filter(n => /^rollout-.*\.jsonl$/.test(n)); } catch { continue; }
    for (const n of names) if (!sessions || sessions.some(s => n.endsWith(`${s}.jsonl`))) out.push(path.join(dir, n));
  }
  return [...new Set(out)];
}
// 我们自己的启动日志里写着这次开的是哪个会话（codex exec 的头几行：model / provider / session id），末尾「tokens used」
// 只是没命中缓存的输入加输出，不当总数用。
// 周期日志有几 MB：只找每段开头的「OpenAI Codex v」，看它后面 2 KB 的抬头。
export function parseCodexLog(text = '') {
  const s = String(text), out = [];
  for (let i = s.indexOf('OpenAI Codex v'); i >= 0; i = s.indexOf('OpenAI Codex v', i + 14)) {
    if (i > 0 && s[i - 1] !== '\n') continue;
    const block = s.slice(i, i + 2048), pick = re => re.exec(block)?.[1] || null;
    const session = pick(/\nsession id:\s*([0-9a-f-]{8,})/i);
    if (session) out.push({ session, model: pick(/\nmodel:\s*(\S+)/), provider: pick(/\nprovider:\s*(\S+)/) });
  }
  return out;
}
// 哪个会话是谁发起的：runs/<日>/cycle-host（定时周期）、run-now（即时执行）、mail-poll（收件箱巡检）下的 Codex 日志。
// 定时周期是一个大会话把几位成员的活一起做，先记到 Patch（定时运行是它的活）；即时执行是谁的活要等启动脚本跑完才说得清
// （bin/host/record-usage.mjs 读那一批任务），之前先记到 Patch；收件箱巡检是 Owl 的。
export const CYCLE_NOTE = `定时周期的本机 AI 会话：几位成员的活在一个会话里做，先记在 ${crewName('patch')}（定时运行）名下`;
const LAUNCHERS = [
  ['cycle-host', { launcher: 'cycle', step: 'cycle', member: 'patch', member_note: CYCLE_NOTE }],
  ['run-now', { launcher: 'run-now', step: 'run-now', member: 'patch', member_note: UNKNOWN_EXECUTOR_NOTE }],
  ['mail-poll', { launcher: 'mail-poll', step: 'mail-poll', member: 'owl' }],
];
const UNKNOWN_SESSION = { launcher: 'codex-session', step: 'executor', member: 'patch', member_note: UNKNOWN_EXECUTOR_NOTE };
const logCache = new Map();
export function launcherMap({ days = 2, now = Date.now() } = {}) {
  const map = new Map();
  for (let d = 0; d < days + 1; d++) {
    const dir = `runs/${dayOf(now - d * 86400000).replaceAll('-', '')}`;
    for (const [sub, who] of LAUNCHERS) {
      let names = []; try { names = fs.readdirSync(file(`${dir}/${sub}`)).filter(n => /^log-.*\.txt$/.test(n)); } catch { continue; }
      for (const n of names) {
        const p = file(`${dir}/${sub}/${n}`);
        let st; try { st = fs.statSync(p); } catch { continue; }
        const sig = `${st.mtimeMs}:${st.size}`, hit = logCache.get(p);
        const found = hit?.sig === sig ? hit.found : parseCodexLog(fs.readFileSync(p, 'utf8'));
        logCache.set(p, { sig, found });
        for (const s of found) if (!map.has(s.session)) map.set(s.session, { ...who, model: s.model, log: `${dir}/${sub}/${n}` });
      }
    }
  }
  return map;
}
// 把最近 days 天 OfferCrew 自己拉起的 Codex 会话记进账（新的、或者还在跑、数变了的）。只认自己的：sessions 明确给的
// （启动脚本从这次的日志里读出来的），或者 runs/ 下启动日志里写着的；别的会话哪怕也在这个目录里跑（用户自己在这里开过
// Codex、同一路径上以前装过一份），文件都不打开。attribution：{ 会话 id: {member, launcher, step, member_note, provider,
// job_ids} }，启动脚本刚跑完时给；否则沿用账上已有的归属，再按启动日志认，还认不出就记到 Patch 并写明「认不出」。返回新记的行数。
export function syncCodexSessions({ now = Date.now(), days = 2, homes = codexHomes(), sessions = null, attribution = {}, source = null, before = Infinity } = {}) {
  const launched = launcherMap({ days, now }), ours = sessions || [...new Set([...launched.keys(), ...Object.keys(attribution || {})])];
  if (!ours.length) return 0;
  const found = rolloutFiles({ homes, days, now, sessions: ours }).map(p => readRollout(p, { cwd: root })).filter(r => r && !r.other && r.usage && ours.includes(r.session) && Date.parse(r.started_at || r.last_at || 0) < before);
  if (!found.length) return 0;
  const prior = new Map(ledgerSince(now - (days + 2) * 86400000).map(r => [r.id, r]));
  const rows = found.map(s => {
    const id = `cx_${hash(['codex-session', s.session]).slice(0, 16)}`, old = prior.get(id), mine = attribution[s.session] || null, log = launched.get(s.session) || null;
    const known = old && old.member_note !== UNKNOWN_EXECUTOR_NOTE ? { member: old.member, launcher: old.launcher, step: old.step, member_note: old.member_note, provider: old.provider, job_ids: old.job_ids } : null;
    const who = mine || known || log || UNKNOWN_SESSION;
    return usageRow({ id, at: s.last_at || s.started_at, started_at: s.started_at, member: who.member, role: 'executor', launcher: who.launcher || UNKNOWN_SESSION.launcher, step: who.step || 'executor', member_note: who.member_note || null, backend: 'codex_exec', provider: who.provider || s.provider, codex_provider: s.provider, model: s.model || who.model || null, usage: s.usage, quota: s.quota, session: s.session, origin: s.origin, job_ids: who.job_ids || null, ...(source ? { source } : {}) });
  });
  return recordRows(rows);
}

// ── 执行器会话：Claude（我们自己的 stream-json 日志）──────────────────────────
// 最后一条 result 里的 modelUsage（每个型号一份）和 usage（5 分钟 / 1 小时的缓存写入）；Claude 订阅的剩余额度读不到。
export function parseClaudeLog(text = '') {
  let result = null, init = null;
  for (const s of String(text).split('\n')) {
    if (!s.startsWith('{"type":"result"') && !s.startsWith('{"type":"system"')) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (e.type === 'result') result = e; else if (e.subtype === 'init' && e.model) init = e.model;
  }
  if (!result) return [];
  const per = Object.entries(result.modelUsage || {}).filter(([, u]) => u && (u.inputTokens || u.outputTokens || u.cacheReadInputTokens || u.cacheCreationInputTokens));
  const hour = int(result.usage?.cache_creation?.ephemeral_1h_input_tokens);
  if (per.length) return per.map(([model, u]) => ({ model, usage: u, ...(per.length === 1 && hour ? { cache_write_1h_tokens: hour } : {}), reported_usd: Number.isFinite(Number(u.costUSD)) ? Number(u.costUSD) : null }));
  return result.usage && (result.usage.input_tokens || result.usage.output_tokens || result.usage.cache_read_input_tokens) ? [{ model: init, usage: result.usage, reported_usd: Number.isFinite(Number(result.total_cost_usd)) ? Number(result.total_cost_usd) : null }] : [];
}
export function claudeLogRows({ log, member = 'patch', launcher = 'run-now', step = 'run-now', member_note = null, provider = null, backend = 'claude_code', now = Date.now(), job_ids = null, source = null } = {}) {
  let text; try { text = fs.readFileSync(log, 'utf8'); } catch { return []; } // 兜底：日志不在就是没有
  const rel = path.relative(file(''), path.resolve(log)).split(path.sep).join('/');
  return parseClaudeLog(text).map(x => usageRow({ id: `u_${hash(['exec', rel, x.model || ''])}`.slice(0, 18), at: new Date(now).toISOString(), member, role: 'executor', launcher, step, member_note, backend, provider, model: x.model, usage: x.usage, cache_write_1h_tokens: x.cache_write_1h_tokens, reported_usd: x.reported_usd, log: rel, job_ids, source })).filter(r => tokensTotal(r));
}

// ── 补账 ─────────────────────────────────────────────────────────────────────
// 最近 days 天、before 之前：runs/<日>/usage.json（文字模型、Jev、对话）、Claude 执行器的 stream-json 日志（按修改时间）、
// Codex 会话记录（按开始时间）。before 缺省是账里第一行实时记录的时间：补账只补开始记账之前的，不和实时的重叠。
const LEGACY_BACKEND = { jev: 'jev', codex_exec: 'codex_exec', claude_code: 'claude_code', anthropic_http: 'anthropic_http', openai_http: 'openai_http', http_api: 'http_api' };
export function legacyRows(dayDir, { providers = loadProviders() } = {}) {
  let rows = []; try { rows = JSON.parse(fs.readFileSync(path.join(dayDir, 'usage.json'), 'utf8')); } catch { return []; } // 兜底：这一天没有用量记录
  if (!Array.isArray(rows)) return [];
  // driver: 'offline' 是规则判断（lib/judge.mjs 的离线判断）：没调模型、不花 token，不补进账。
  return rows.filter(r => r && r.at && r.driver !== 'offline').map(r => {
    const id = String(r.model || ''), slash = id.indexOf('/');
    const provider = slash > 0 ? id.slice(0, slash) : r.driver === 'jev' ? 'typesafe' : null, model = slash > 0 ? id.slice(slash + 1) : id || null;
    const backend = LEGACY_BACKEND[r.driver] || providers?.[provider]?.kind || null;
    let member = r.role || null;
    const chat = /^chat-([a-z0-9]{8,32})-/.exec(r.request_id || '');
    if (chat) { try { member = JSON.parse(fs.readFileSync(file(`state/chat/${chat[1]}.json`), 'utf8')).persona || null; } catch {} } // 兜底：对话记录不在就不知道是哪位，空着
    return usageRow({ at: r.at, request_id: r.request_id, role: member, backend, provider, codex_provider: backend === 'codex_exec' ? providers?.[provider]?.codex_provider : null, model, usage: r.usage, status: r.status === 'completed' ? 'ok' : 'failed', duration_ms: r.duration_ms, source: 'backfill' });
  });
}
function firstLiveAt() {
  let text = ''; try { text = fs.readFileSync(file(LEDGER), 'utf8'); } catch { return Infinity; }
  for (const s of text.split('\n')) { if (!s) continue; try { const r = JSON.parse(s); if (r.source !== 'backfill' && Date.parse(r.at)) return Date.parse(r.at); } catch {} } // 兜底：一行坏了跳过这一行
  return Infinity;
}
export function backfillUsage({ days = 14, now = Date.now(), before = null, codex = true } = {}) {
  const until = Math.min(before ?? Infinity, firstLiveAt(), now), from = dayOf(now - days * 86400000).replaceAll('-', '');
  let providers = {}; try { providers = loadProviders(); } catch {} // 兜底：模型目录读坏了会在设置和体检里报；这里只少认几个底座
  let dirs = []; try { dirs = fs.readdirSync(file('runs')).filter(n => /^\d{8}$/.test(n) && n >= from).sort(); } catch {} // 兜底：runs 目录还没有，就没有旧账可补
  const out = [];
  for (const d of dirs) {
    out.push(...legacyRows(file(`runs/${d}`), { providers }).filter(r => Date.parse(r.at) < until));
    for (const [sub, who] of LAUNCHERS) {
      let names = []; try { names = fs.readdirSync(file(`runs/${d}/${sub}`)).filter(n => /^log-.*\.jsonl$/.test(n)); } catch { continue; }
      for (const n of names) { let at = 0; try { at = fs.statSync(file(`runs/${d}/${sub}/${n}`)).mtimeMs; } catch { continue; } if (at < until) out.push(...claudeLogRows({ log: file(`runs/${d}/${sub}/${n}`), ...who, now: at, source: 'backfill' })); }
    }
  }
  let have = new Set();
  // 兜底：账还不存在就当一条都没有；一行坏了跳过这一行
  try { have = new Set(fs.readFileSync(file(LEDGER), 'utf8').split('\n').flatMap(s => { try { return [JSON.parse(s).id]; } catch { return []; } })); } catch {}
  const fresh = out.filter(r => !have.has(r.id) && (have.add(r.id), true)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let rows = appendRows(fresh.map(r => ({ ...r, source: 'backfill' })));
  if (codex) try { rows += syncCodexSessions({ now, days, homes: codexHomes(providers), source: 'backfill', before: until }); } catch (e) { noteSwallowed('usage.syncCodex', e, { doing: '补本机 Codex 的用量', then: '这部分先不补' }); }
  return { rows };
}
