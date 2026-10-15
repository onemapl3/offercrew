// Patch 的「记账」技能的另一半：花费档位和每天的上限（2026-09-29，design/团队与工作流.md 第 1.4、3、5 节；
// 账和价格在 lib/usage.mjs，说明在 docs/cost.md）。
//
//   档位   config/pipeline.json spend_tier：
//            economy   省钱：新线索先由你按标题挑一轮（收件箱里一封「按标题挑新线索」，一次 10 条），只有你留下的才花
//                      token 让 Lens 判断（Jev 判断、逐条匹配都只挑 title_pick.keep 的）。你转发 / 收录来的线索算你已经挑过。
//            standard  标准：和以前一样，每条新线索都判断（缺省）。
//            premium   高级：Lens 给推荐的岗位都写一页完整评估（lib/evaluate.mjs，用你配置里最好的文字模型）；逐条匹配也用最好的。
//   上限   config/pipeline.json budget.daily_usd（估算的美元）/ budget.daily_tokens；都不设 = 不限，行为和以前一样。
//          到了：当天不再开新的判断、逐条匹配、一页评估、按岗位定制简历、找人、自动排的公司调研和真人帖扫描（周期跳过这几步，host-work
//          把自动排的调研、真人帖扫描留在队列里），线索和任务留到明天；你已经批准、做到一半的事（发信、投递、你点的调研、
//          对话、读来信、执行器手上的活）照常做完。收件箱来一封「今天的花费上限到了」：今天再放宽 X / 明天继续。
//          今天的放宽和「明天继续」记在 state/budget.json（只有工作台写它），第二天自动作废。
import { coName } from './vocab.mjs';
import { read, write, lines, writeLines, hash } from './store.mjs';
import { event } from './events.mjs';
import { dayOf, dayTotals, loadPrices, STEP_LABEL } from './usage.mjs';
import { pendingLead, byPriority } from './matcher.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { leadCity } from './city.mjs';
import { judgeOffline } from './judge.mjs';
import { freeHold, BLOCK_TITLE, buyUrl } from './free-model.mjs';
import { PROVIDER_PRESETS } from './provider-presets.mjs';
import { onPath, desktopApp } from './backends.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crewName } from './crew.mjs';

export const TIERS = ['economy', 'standard', 'premium'];
export const TIER_LABEL = { economy: '省钱', standard: '标准', premium: '高级' };
export const TIER_NOTE = {
  economy: '新线索先由你按标题挑一轮，只有你留下的才花 token 去判断。花得最少，多一件事要你点。',
  standard: '每条新线索都自动判断。和以前一样。',
  premium: '每条新线索都判断，推荐的岗位再写一页完整评估（级别、JD 写的薪资、差距和对策），用你配置里最好的模型。最贵。',
};
export const BUDGET_STATE = 'state/budget.json';
// 到了上限就不开新的这几步：周期阶段 → 账上的 step。
export const HELD_STAGES = { 'judge-leads': 'judge', match: 'match', evaluate: 'evaluate', 'find-contacts': 'contacts', 'find-referrers': 'referrers', 'tailor-resumes': 'resume-tailor' };
const STEP_ACTOR = { judge: 'radar', match: 'radar', evaluate: 'radar', discovery: 'radar', contacts: 'postman', referrers: 'postman', research: 'nightwatch', 'resume-tailor': 'tailor' };

export function spendTier(pipeline = read('config/pipeline.json', {})) {
  const t = String(pipeline?.spend_tier || '').trim();
  return TIERS.includes(t) ? t : 'standard';
}
export function budgetConfig(pipeline = read('config/pipeline.json', {})) {
  const b = pipeline?.budget || {}, empty = v => v == null || v === '', ok = v => Number(v) > 0 && Number.isFinite(Number(v)), pos = v => (empty(v) || !ok(v) ? null : Number(v));
  // 写了但读不懂（"5O"、"$5"、负数）：不当成「不设上限」，记在 invalid 里，budgetState 当作已经到了上限。
  const invalid = ['daily_usd', 'daily_tokens'].filter(k => !empty(b[k]) && !ok(b[k]));
  return { daily_usd: pos(b.daily_usd), daily_tokens: pos(b.daily_tokens), ...(invalid.length ? { invalid } : {}) };
}

// ── 数字怎么说 ─────────────────────────────────────────────────────────────────
export function tokenText(n) {
  const x = Math.max(0, Number(n) || 0);
  if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e8 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (x >= 1e3) return `${Math.round(x / 1e3)}k`;
  return String(Math.round(x));
}
export function cnyText(cny) {
  const x = Math.max(0, Number(cny) || 0);
  if (!x) return '¥0';
  if (x < 0.1) return '不到 ¥0.1';
  return `¥${x < 10 ? x.toFixed(1).replace(/\.0$/, '') : Math.round(x)}`;
}

// ── 今天到没到上限 ─────────────────────────────────────────────────────────────
export function budgetState({ now = Date.now(), pipeline = read('config/pipeline.json', {}), prices = loadPrices(), used = null } = {}) {
  const cap = budgetConfig(pipeline), day = dayOf(now), rate = Number(prices.usd_cny) || 7;
  const saved = read(BUDGET_STATE, {}) || {}, mine = saved.day === day ? saved : {};
  const extra = { usd: Number(mine.extra_usd) || 0, tokens: Number(mine.extra_tokens) || 0 };
  const t = used || dayTotals(now, prices);
  const limit_usd = cap.daily_usd != null ? cap.daily_usd + extra.usd : null, limit_tokens = cap.daily_tokens != null ? cap.daily_tokens + extra.tokens : null;
  const by = cap.invalid ? 'invalid' : limit_usd != null && t.usd >= limit_usd ? 'usd' : limit_tokens != null && t.tokens >= limit_tokens ? 'tokens' : null;
  const share = Math.max(limit_usd ? t.usd / limit_usd : 0, limit_tokens ? t.tokens / limit_tokens : 0);
  return {
    day, enabled: cap.daily_usd != null || cap.daily_tokens != null || !!cap.invalid, cap, ...(cap.invalid ? { invalid_note: `花费上限写坏了（config/pipeline.json 的 ${cap.invalid.map(k => `budget.${k}`).join('、')}），先按到了上限处理，在「设置 → 花费」里重新填` } : {}), extra, limit_usd, limit_tokens, usd_cny: rate,
    used: { usd: t.usd, cny: t.usd * rate, tokens: t.tokens, subscription_tokens: t.subscription_tokens || 0 },
    share: Math.round(share * 1000) / 1000, reached: !!by, by, deferred: !!mine.deferred_at, raises: (mine.raises || []).length,
  };
}
export const limitText = b => b.cap?.invalid ? '写坏了' : [b.limit_usd != null ? `约 ${cnyText(b.limit_usd * b.usd_cny)}` : null, b.limit_tokens != null ? `${tokenText(b.limit_tokens)} token` : null].filter(Boolean).join(' / ') || '不限';
export const usedText = b => `${tokenText(b.used.tokens)} token${b.cap.daily_usd != null || b.used.usd ? ` · 约 ${cnyText(b.used.cny)}` : ''}`;

// 周期阶段、脚本开头、循环里开下一件之前问一句：到了上限就返回今天的状态（并在运行日志里记一行），否则 null。
// OfferCrew 补给（lib/free-model.mjs）被中转拒了、文字模型又只剩它：和到了上限一样，这几步先停（by: 'free'）。
export function budgetGate(step, { now = Date.now(), quiet = false } = {}) {
  const f = freeHold({ now });
  if (f) {
    if (!quiet) event(STEP_ACTOR[step] || 'system', 'free-model', 'skip', `${BLOCK_TITLE[f.kind] || 'OfferCrew 补给用不了'}：${STEP_LABEL[step] || step}先停，等你换一个模型`);
    return { reached: true, by: 'free', free: f, day: dayOf(now) };
  }
  const b = budgetState({ now });
  if (!b.reached) return null;
  if (!quiet) event(STEP_ACTOR[step] || 'system', 'spend-cap', 'skip', `今天的花费上限到了（${usedText(b)}，上限 ${limitText(b)}）：${STEP_LABEL[step] || step}留到明天`);
  return b;
}
// 离线判断（lib/judge-offline.mjs）是规则，不是模型调用：打开时判断岗位这一步不算花钱，照常跑；用模型判断的照旧拦。
export const stageHeld = (stage, opts) => (!HELD_STAGES[stage] || (stage === 'judge-leads' && judgeOffline()) ? null : budgetGate(HELD_STAGES[stage], opts));
// 自动排的、可以等到明天的执行器任务：Watch 自己排的公司调研和「怎么准备」、每天的真人帖扫描。你点的、你交代的不算。
export const discretionaryJob = j => (['company_brief', 'role_prep'].includes(j?.kind) && j.source === 'watch') || j?.kind === 'discover_human_opportunities';

// ── 收件箱：「今天的花费上限到了」 ─────────────────────────────────────────────
// 放宽多少：上限的一半，取个整（¥ 到元、token 到两位有效数字）。
function niceCny(x) { return x < 1 ? Math.max(0.1, Math.round(x * 10) / 10) : x < 20 ? Math.round(x) : Math.round(x / 5) * 5; }
function niceTokens(x) { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, x))) - 1); return Math.max(1000, Math.round(x / p) * p); }
export function raiseBy(b) {
  if (b.by === 'tokens') { const tokens = niceTokens(b.cap.daily_tokens / 2); return { tokens, label: `${tokenText(tokens)} token` }; }
  const cny = niceCny(b.cap.daily_usd * b.usd_cny / 2);
  return { usd: cny / b.usd_cny, label: `¥${cny}` };
}
export function budgetAsks({ now = Date.now(), state = null } = {}) {
  const b = state || budgetState({ now });
  if (!b.reached || b.deferred) return [];
  // 上限写坏了（兜底清单 A16）：不是「到了上限」，放宽也解不开。照实说，给两条真能解开的路：清空写坏的那一项，或者到设置里重填。
  if (b.by === 'invalid') return [{
    from: 'system', id: `budget-invalid:${b.day}:${b.cap.invalid.join(',')}`, type: 'decide', title: '花费上限写坏了',
    question: `${b.invalid_note}。新的判断、匹配、找人和自动调研先停下；你已经批准、做到一半的事照常做完。`,
    context: [`${crewName('patch')} · 记账`],
    facts: [{ k: '写坏的', v: b.cap.invalid.map(k => `budget.${k}`).join('、') }],
    options: [
      { key: '1', label: '清空写坏的上限', steps: [{ type: 'budget', action: 'clear_invalid' }], primary: true, hint: '清空以后这一项不设上限，照常跑' },
      { key: '2', label: '打开「设置 → 花费」', steps: [{ type: 'navigate', to: '#settings/spend' }] },
    ],
    other: null,
  }];
  const x = raiseBy(b), used = usedText(b), limit = limitText(b);
  const after = { ...b, limit_usd: b.limit_usd != null && x.usd ? b.limit_usd + x.usd : b.limit_usd, limit_tokens: b.limit_tokens != null && x.tokens ? b.limit_tokens + x.tokens : b.limit_tokens };
  const base = limitText({ ...b, limit_usd: b.cap.daily_usd, limit_tokens: b.cap.daily_tokens });
  return [{
    from: 'system', id: `budget:${b.day}:${b.raises}`, type: 'decide', title: '今天的花费上限到了',
    question: `今天已经用了 ${used}，到了上限（${limit}）。新的判断、匹配、找人和自动调研先停下，留到明天；你已经批准、做到一半的事照常做完。`,
    context: [`${crewName('patch')} · 记账`, '钱是估算'],
    facts: [
      { k: '今天', v: used }, { k: '上限', v: `${limit}${b.raises ? `（今天已放宽 ${b.raises} 次）` : ''}` },
      { k: '停下的', v: '判断岗位、逐条匹配、一页评估、按岗位定制简历、找联系人和内推人、自动排的公司调研、真人帖扫描' },
      { k: '照常做', v: '发信、投递、你点的调研、对话、读来信、本机 AI 手上的活' },
    ],
    options: [
      { key: '1', label: `今天再放宽 ${x.label}`, steps: [{ type: 'budget', action: 'raise', ...(x.usd ? { usd: x.usd } : {}), ...(x.tokens ? { tokens: x.tokens } : {}) }], primary: true, hint: `只放宽今天：今天的上限到 ${limitText(after)}，明天回到 ${base}` },
      { key: '2', label: '明天继续', steps: [{ type: 'budget', action: 'defer' }], hint: '今天不再开新的，线索和任务都留着，明天 0 点起自动接着做' },
    ],
    other: null,
  }];
}
export function answerBudget(step = {}, { now = Date.now() } = {}) {
  const day = dayOf(now), at = new Date(now).toISOString(), saved = read(BUDGET_STATE, {}) || {}, mine = saved.day === day ? saved : { day };
  if (step.action === 'raise') {
    const usd = Math.max(0, Number(step.usd) || 0), tokens = Math.max(0, Math.round(Number(step.tokens) || 0));
    if (!usd && !tokens) throw Error('放宽多少没说清楚');
    write(BUDGET_STATE, { ...mine, day, extra_usd: (Number(mine.extra_usd) || 0) + usd, extra_tokens: (Number(mine.extra_tokens) || 0) + tokens, raises: [...(mine.raises || []), { at, usd, tokens }], deferred_at: null });
    const b = budgetState({ now });
    event('user', 'spend-cap', 'ok', `今天的花费上限放宽到 ${limitText(b)}（只管今天）`);
    return `好，今天的上限放宽到 ${limitText(b)}；下一轮接着判断，明天回到原来的上限`;
  }
  if (step.action === 'clear_invalid') {
    const pipeline = read('config/pipeline.json', {}) || {}, bad = budgetConfig(pipeline).invalid || [];
    if (!bad.length) return '花费上限现在读得懂，没有要清空的';
    const budget = { ...(pipeline.budget || {}) };
    for (const k of bad) delete budget[k];
    write('config/pipeline.json', { ...pipeline, budget });
    event('user', 'spend-cap', 'ok', `清空了写坏的花费上限（${bad.map(k => `budget.${k}`).join('、')}）`);
    return '好，写坏的上限清空了，下一轮接着跑；要上限的话在「设置 → 花费」里重填';
  }
  if (step.action === 'defer') {
    write(BUDGET_STATE, { ...mine, day, deferred_at: at });
    event('user', 'spend-cap', 'ok', '今天的花费上限到了：你选了明天继续');
    return '好，今天不再开新的判断和调研，线索和任务都留着，明天 0 点起自动接着做';
  }
  throw Error('未知的花费操作');
}

// ── 收件箱：「补给用完了」 ─────────────────────────────────────────────────────
// 文字模型只剩 OfferCrew 补给、又被中转拒了（用完、过期、碰上防滥用的限流、全站暂停、关了、令牌失效）才来；同时指挥台顶上有一句
// （lib/hq.mjs stop）。几条路：自己的 key（预设在 lib/provider-presets.mjs）、Mac 版用 ChatGPT 账号登录、本机检测到的 Claude Code /
// Codex；还有兑换码（以后卖补给时用，买的地址没配就不显示）。碰上的是明天就恢复的限流，再加一条「等明天」。
// 选哪条都是去「设置 → 模型」，真正改配置在那里做（能先测试）；什么都不选，模型链里就没有能用的（不会悄悄换成本机的）。
export function freeModelAsks({ now = Date.now(), hold = freeHold({ now }) } = {}) {
  if (!hold) return [];
  const presets = PROVIDER_PRESETS.map(p => p.label.replace(/（.*$/, '')).join('、');
  // Mac 版不先看这台电脑上装了什么（主会话 10-03）：只给「用本机 AI」，到设置的模型页点了才查。命令行装的照旧看。
  const desk = desktopApp();
  const local = desk ? [] : [onPath('claude', process.env.RADAR_CLAUDE_BIN) ? 'Claude Code' : null, onPath('codex', process.env.RADAR_CODEX_BIN) && fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json')) ? 'Codex' : null].filter(Boolean);
  const daily = ['daily_limit', 'request_limit', 'paused'].includes(hold.kind);
  const go = { type: 'navigate', to: '#settings/model' };
  const buy = buyUrl();
  // 要登录（没登录，或者登录过期）：第一条就是登录（10-03 补给跟着账户走）。
  const login = hold.kind === 'login';
  return [{
    from: 'system', id: `free-model:${hold.kind}:${dayOf(now)}`, type: 'decide', title: BLOCK_TITLE[hold.kind] || BLOCK_TITLE.credits_exhausted,
    question: `${hold.reason}在这之前，新的判断、匹配、找人和自动调研先停下；你已经批准、做到一半的事照常做完。`,
    context: [`${crewName('patch')} · 记账`, 'OfferCrew 补给'],
    facts: [
      { k: '停下的', v: '判断岗位、逐条匹配、一页评估、找联系人和内推人、自动排的公司调研、真人帖扫描' },
      { k: '照常做', v: '发信、投递、你已经批准的事、本机 AI 手上的活' },
      ...(hold.until ? [{ k: '下次再试', v: new Date(hold.until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) }] : []),
    ],
    // 兑换码：填了就兑（lib/model-choice.mjs redeemFreeCode），加上的补给马上能用。买补给：直接在浏览器里打开（没配地址就不显示）。
    form: [{ key: 'code', label: '兑换码', type: 'text' }],
    options: [
      ...(login ? [{ label: '登录 OfferCrew 账户', steps: [{ type: 'navigate', to: '#login' }], primary: true, hint: '邮箱验证码或 Google' }] : []),
      { label: '用自己的 API key', steps: [go], primary: !local.length && !login, hint: `${presets} 都可以；key 只存在这台电脑上` },
      { label: '用 ChatGPT 账号登录', steps: [go], hint: '在 OfferCrew 的 Mac 版里登录，用你 ChatGPT 订阅的额度' },
      ...(desk ? [{ label: '用本机 AI（Codex / Claude Code）', steps: [go] }] : local.length ? [{ label: `用这台电脑上的 ${local.join(' / ')}`, steps: [go], primary: !login, hint: `这台电脑上装了 ${local.join('、')}` }] : []),
      { label: '输入兑换码', input: 'fields', steps: [{ type: 'redeem' }], hint: '兑换的补给不过期' },
      ...(buy ? [{ label: '买补给', href: buy, steps: [], hint: '付款后发兑换码' }] : []),
      ...(daily ? [{ label: '等明天恢复', steps: [{ type: 'snooze', until: hold.until }], hint: '北京时间 0 点恢复，之后自动接着做' }] : []),
    ].map((o, i) => ({ key: String(i + 1), ...o })),
    other: null,
  }];
}

// ── 省钱档：你先按标题挑 ───────────────────────────────────────────────────────
// 线索上记 title_pick = { keep, at, by: 'owner' }。只在省钱档起作用：换回标准档，没挑过、挑了「不要」的也照常判断。
// 一批 10 条：收件箱的表单一次最多收 10 项（bin/serve.mjs /api/inbox/answer）；表单的键是 p1…p10，按 ids 的顺序对回线索。
export const SKIM_BATCH = 10;
const ownerBrought = l => l.source === 'forwarded' || /用户转发|你收录/.test(String(l.source_type || ''));
// 省钱档里这条能不能花 token 判断：你留下的，或者本来就是你转发 / 收录来的。
export const economyAllows = l => l?.title_pick?.keep === true || ownerBrought(l || {});
// 等你挑的：还没判断过、没被规则挡掉、公司没被排除、你还没挑过。
export const awaitingPick = l => pendingLead(l) && !l.judgement && !l.prefilter_reason && !l.match_error_final && !l.title_pick && !ownerBrought(l) && !excludedCompany(l);
export function skimAsks({ leads = [], now = Date.now(), tier = spendTier() } = {}) {
  if (tier !== 'economy') return [];
  const waiting = leads.filter(awaitingPick).sort(byPriority);
  if (!waiting.length) return [];
  const batch = waiting.slice(0, SKIM_BATCH), ids = batch.map(l => l.record_id || l.id);
  const label = l => [coName(l.company) || '公司待核', String(l.role || '岗位待核').slice(0, 48), (leadCity(l) && leadCity(l) !== '其他' ? leadCity(l) : String(l.location || '').slice(0, 16)) || null].filter(Boolean).join(' · ');
  return [{
    from: 'radar', id: `skim:${hash(ids).slice(0, 12)}`, type: 'decide', title: `按标题挑新线索（${waiting.length} 条等你）`,
    question: `省钱档：先按标题挑一挑，只有你留下的才花 token 去判断。这一批 ${batch.length} 条，默认都留下，把不想要的改成「不要」。`,
    context: [`${crewName('lens')} · 省钱档`], note: `还有 ${waiting.length} 条没挑`,
    form: batch.map((l, i) => ({ key: `p${i + 1}`, label: label(l), type: 'choice', options: ['留下', '不要'], value: '留下' })),
    options: [
      { key: '1', label: '按我选的', input: 'fields', steps: [{ type: 'title_pick', ids }], primary: true, hint: '留下的马上去判断；不要的这一档里不再判断，换回标准档会照常判断' },
      { key: '2', label: `这 ${batch.length} 条都留下`, steps: [{ type: 'title_pick', ids, all: 'keep' }], hint: '全部去判断' },
      { key: '3', label: '晚点再挑', steps: [{ type: 'snooze', hours: 3 }], hint: '三小时后再问；这期间新线索不判断' },
    ],
    other: null,
  }];
}
// 记下你挑的。answered：收件箱表单的 [{key, label, value}]；all: 'keep' 就全部留下。返回回执和留下了几条。
export async function pickTitles(step = {}, answered = null, { now = Date.now() } = {}) {
  const ids = Array.isArray(step.ids) ? step.ids.map(String) : [];
  const keep = new Map(ids.map((id, i) => [id, step.all === 'keep' ? true : (answered || []).find(f => f.key === `p${i + 1}`)?.value !== '不要']));
  if (!keep.size) throw Error('这一批里没有线索');
  const at = new Date(now).toISOString();
  let kept = 0, dropped = 0;
  {
    const rows = lines('state/leads.ndjson');
    for (const l of rows) { const id = l.record_id || l.id; if (!keep.has(id) || l.title_pick) continue; l.title_pick = { keep: keep.get(id), at, by: 'owner' }; keep.get(id) ? kept++ : dropped++; }
    if (kept || dropped) writeLines('state/leads.ndjson', rows);
  }
  event('user', 'title-pick', 'ok', `按标题挑：留下 ${kept} 条，不要 ${dropped} 条（省钱档）`);
  return { kept, dropped, receipt: `留下 ${kept} 条${dropped ? `，不要 ${dropped} 条` : ''}` };
}
