// Watch 的公司调研和「怎么准备」（2026-09-29，用户：点进线索看岗位的时候，要有这家公司的简介和调研，包括怎么准备）。
//
//   公司调研   一家公司一份，这家公司的所有岗位共用：state/company-briefs/<公司键>.json。线 W（10-04）起由引擎做：抓这家公司
//             已知的公开页面（官网、关于、招聘页、岗位页），守 robots、限速，遇到验证码和挡爬虫就跳过；用文字模型整理，
//             写明抓了哪几页、没用搜索引擎（lib/company-research.mjs）。每条说法都引用来源（sources 的序号，从 1 起），
//             来源要有标题、链接、日期；二手来源（论坛、点评、面经站）撑不起业务、规模、新闻这类事实。校验不过整份拒收。
//             命令行版（冻结）的执行器照旧可以写 JSON 交给 `node bin/company.mjs brief`，过同一份校验。
//   怎么准备   一条线索一份：state/role-prep/<线索 id>.json。从公司调研、JD 和判断里的主要缺口推出三小节：
//             补一补 / 准备讲 / 这家公司。补一补和准备讲每条引用它回应的 JD 原文，写入时核对确实在 JD 里。
//             面试阶段另有面试资料（lib/interview-dossier.mjs，Watcher 写，存在 App 里）。
//   队列       周期尾段（bin/prepare-interviews.mjs）：
//             调研       新线索 / 待批准里推荐或待核的公司（还有走到递出、等着写「怎么准备」的公司），没有调研或调研超过
//                        max_age_days 天：开一张 Judge 的调研卡，引擎在工作台里做。同时开着的周期调研卡最多 per_cycle 张，岗位多的公司先。
//             怎么准备   走到递出及以后的线索：有 JD、还没有「怎么准备」；公司调研好了（或公司不明、查不到）才写，Judge 自己写。
//                        每轮最多 prep_per_cycle 条。
//             页面上的「调研这家公司」「生成怎么准备」立刻开卡 / 开写，不占每轮名额。
// 设置在 config/pipeline.json 的 company_briefs：per_cycle（5）、max_age_days（30）、prep_per_cycle（5）；0 = 不自动排。
import fs from 'node:fs';
import { read, write, file, hash } from './store.mjs';
import { requestRunNow } from './run-now.mjs';
import { cachedLines, fileSig } from './state-cache.mjs';
import { jdLines } from './job-brief.mjs';
import { crewName } from './crew.mjs';
import { moveCardJobs } from './task-ledger.mjs';
import { shelved, happened } from './shelf.mjs';
import { directionSet } from './recommend-gate.mjs';
import { canonicalCompany } from './lead-fields.mjs';
import { postingKey, canonicalUrl } from './dedupe.mjs';
import { stageText } from './lead-state.mjs';
import { localTime } from './tz.mjs';
// 公司调研和「怎么准备」是 Lens 的（design/团队与工作流.md 第 3 节，原来在 Watch 名下）；名字从名册读。
export const LENS = crewName('lens');

export const BRIEF_DIR = 'state/company-briefs', PREP_DIR = 'state/role-prep';
// 「怎么准备」正在写 / 上次没写成（lib/role-prep.mjs 记，prepState 读）：{ <线索 id>: { status: writing|failed|unavailable, reason, at } }。
export const PREP_WRITING = 'state/role-prep-writing.json';
const WRITING_MS = 10 * 60000, RETRY_MS = 24 * 3600000;
export const BRIEF_KIND = 'company_brief', PREP_KIND = 'role_prep';
const DAY = 86400000, OPEN = ['pending', 'working'], STUCK = ['blocked', 'dropped', 'waiting_user'];
const iso = ms => new Date(ms).toISOString();
const T = x => { const t = Date.parse(x || ''); return Number.isFinite(t) ? t : 0; };
export const lastRev = rows => [...new Map(rows.map(r => [r.id, r])).values()];
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const ridOf = l => l?.record_id || l?.id || null;

// ── 设置 ─────────────────────────────────────────────────────────────────────
export const BRIEF_DEFAULTS = { per_cycle: 5, max_age_days: 30, prep_per_cycle: 5 };
export function briefSettings(pipeline = read('config/pipeline.json', {})) {
  const c = pipeline?.company_briefs || {};
  const int = (v, d, min = 0) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= min ? Math.floor(n) : d; };
  return { per_cycle: int(c.per_cycle, BRIEF_DEFAULTS.per_cycle), max_age_days: int(c.max_age_days, BRIEF_DEFAULTS.max_age_days, 1), prep_per_cycle: int(c.prep_per_cycle, BRIEF_DEFAULTS.prep_per_cycle) };
}

// ── 公司键 ───────────────────────────────────────────────────────────────────
// 同一家公司的不同写法落到同一份调研：「阿里巴巴集团」和「阿里巴巴」、「前金霸王（中国）有限公司」和「前金霸王」、
// 「米哈游·内推小助手」和「米哈游」。公司还不明（待核（猎头代招：…）、未披露的初创）没有键：不调研，先核实公司。
// 别名（「字节跳动」和「ByteDance」）靠调研里的 aliases 认。
const UNKNOWN = /^(?:待核|公司待核|待定|未知|未披露|不详|匿名|保密|某)|未披露|stealth|猎头|代招/i;
const SUFFIX_ZH = /(?:股份有限公司|有限责任公司|有限公司|集团|公司|控股|科技)$/u;
const SUFFIX_EN = /[\s,.]*\b(?:inc|ltd|llc|co|corp|corporation|limited|group|holdings?|plc|gmbh)\.?$/i;
export function companyKey(name) {
  let s = canonicalCompany(name).normalize('NFKC').trim();
  if (!s || UNKNOWN.test(s)) return null;
  s = s.replace(/[(（][^)）]*[)）]/g, ' ').split(/\s*[·•|/／]\s*/)[0].toLowerCase();
  for (let prev = null; prev !== s;) { prev = s; s = s.trim().replace(SUFFIX_ZH, '').replace(SUFFIX_EN, ''); }
  s = s.replace(/[^\p{L}\p{N}.-]+/gu, '').replace(/^[.-]+|[.-]+$/g, '');
  return s ? s.slice(0, 60) : null;
}
const sameCompany = (j, key) => !!key && (j.company_key === key || companyKey(j.company) === key);

// ── 来源 ─────────────────────────────────────────────────────────────────────
// 看域名分四种：二手（论坛、点评、面经站、个人博客）、媒体、公司页（LinkedIn、工商信息、百科）、其他（官网等）。
// 页面上二手的说法标「二手」；业务、规模、新闻和摘要至少要有一个不是二手的来源。
const SITES = {
  community: ['nowcoder.com', 'kanzhun.com', 'maimai.cn', 'zhihu.com', 'xiaohongshu.com', 'xhslink.com', 'v2ex.com', 'teamblind.com', 'reddit.com', '1point3acres.com', 'offershow.cn', 'levels.fyi', 'jobui.com', 'tieba.baidu.com', 'weibo.com', 'douban.com', 'bilibili.com', 'juejin.cn', 'csdn.net', 'cnblogs.com', 'jianshu.com', 'toutiao.com'],
  news: ['36kr.com', 'huxiu.com', 'latepost.com', 'caixin.com', 'jiemian.com', 'thepaper.cn', 'yicai.com', 'pedaily.cn', 'iyiou.com', 'geekpark.net', 'leiphone.com', 'qbitai.com', 'jiqizhixin.com', 'infoq.cn', 'caijing.com.cn', 'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com', 'techcrunch.com', 'theverge.com', 'scmp.com', 'nikkei.com', 'theinformation.com'],
  profile: ['linkedin.com', 'crunchbase.com', 'qcc.com', 'tianyancha.com', 'aiqicha.baidu.com', 'itjuzi.com', 'pitchbook.com', 'cbinsights.com', 'wikipedia.org', 'baike.baidu.com'],
};
export const siteOf = url => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }; // 兜底：地址解析不了就不算哪个网站
export function sourceKind(url) {
  const host = siteOf(url), hit = list => list.some(d => host === d || host.endsWith('.' + d));
  if (hit(SITES.community) || /(^|\.)glassdoor\./.test(host)) return 'community';
  if (hit(SITES.news)) return 'news';
  if (hit(SITES.profile)) return 'profile';
  return 'web';
}
export const SOURCE_WORD = { community: '二手', news: '媒体', profile: '公司页', web: '' };
const SEARCH_PAGE = /(^|\.)(google\.[a-z.]+|bing\.com|baidu\.com|sogou\.com|so\.com|duckduckgo\.com|yandex\.[a-z]+)$/;
function urlProblem(u) {
  if (typeof u !== 'string' || !u.trim()) return '缺 url';
  if (u.length > 600) return 'url 太长';
  let x; try { x = new URL(u); } catch { return 'url 不是完整的链接（要 https://…）'; }
  if (!['http:', 'https:'].includes(x.protocol)) return 'url 要是 http(s) 链接';
  const h = x.hostname.toLowerCase();
  if (!h.includes('.') || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(h) || /\.(local|internal)$/.test(h)) return 'url 不能是本机或内网地址';
  if (SEARCH_PAGE.test(h.replace(/^www\./, '')) && /^\/(search|s|web|url)\b/.test(x.pathname)) return '搜索结果页和跳转链接不算来源：打开结果，引用原文那一页';
  return null;
}
const DATE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
export function dateOk(s, now = Date.now()) {
  const m = DATE.exec(String(s ?? '').trim()); if (!m) return false;
  const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : 1;
  if (y < 1990 || mo < 1 || mo > 12 || d < 1) return false;
  const t = Date.UTC(y, mo - 1, d);
  return new Date(t).getUTCDate() === d && t <= now + DAY;
}

// ── 公司调研的写法与校验 ──────────────────────────────────────────────────────
// 每一节：标签、最多几条（逼着挑最有用的，不写成词典）、是不是硬事实（要有不是二手的来源）、要不要日期。
export const SECTIONS = {
  business: { label: '业务', max: 4, hard: true },
  scale: { label: '规模', max: 3, hard: true },
  hiring: { label: '在哪招', max: 3 },
  tech: { label: '技术', max: 4 },
  news: { label: '近期动态', max: 6, hard: true, date: true },
  culture: { label: '口碑', max: 4 },
  interview: { label: '面试', max: 6 },
  salary: { label: '薪资', max: 3 },
  red_flags: { label: '风险', max: 4 },
};
const BRIEF_KEYS = ['company', 'aliases', 'status', 'note', 'searched', 'summary', ...Object.keys(SECTIONS), 'sources'];
const CLAIM_MAX = 120;

function claimOf(x, where, ctx, { date = false, min = 4, max = CLAIM_MAX } = {}) {
  const errs = ctx.errors, n = ctx.sources.length;
  if (!x || typeof x !== 'object' || Array.isArray(x)) { errs.push(`${where} 要写成 {"text": "…", "src": [1]${date ? ', "date": "YYYY-MM-DD"' : ''}}`); return null; }
  const extra = Object.keys(x).filter(k => !['text', 'src', 'scope', ...(date ? ['date'] : [])].includes(k));
  if (extra.length) errs.push(`${where} 多了字段 ${extra.join('、')}（只写 text、src、scope${date ? '、date' : ''}）`);
  const text = clean(x.text);
  if (text.length < min || text.length > max) errs.push(`${where}.text 要 ${min}–${max} 个字（现在 ${text.length}）`);
  if (/https?:\/\/|www\./i.test(text)) errs.push(`${where}.text 里不放链接：链接写进 sources，这里用 src 引用序号`);
  const src = Array.isArray(x.src) ? x.src : x.src != null ? [x.src] : [];
  if (!src.length) errs.push(`${where} 没有来源：src 写 sources 里的序号（从 1 开始）；找不到来源的说法不写`);
  const bad = src.filter(i => !Number.isInteger(i) || i < 1 || i > n);
  if (bad.length) errs.push(`${where}.src 里的 ${bad.join('、')} 不是 sources 的序号（1–${n}）`);
  const out = { text, src: [...new Set(src.filter(i => Number.isInteger(i) && i >= 1 && i <= n))] };
  if (x.scope != null) { if (x.scope !== 'company') errs.push(`${where}.scope 只认 company：公司共用说法不能混入特定岗位结论`); else out.scope = 'company'; }
  if (date) {
    const d = clean(x.date);
    if (!dateOk(d, ctx.now)) errs.push(`${where}.date 写这件事发生的日期 YYYY-MM-DD（或 YYYY-MM），不能是将来`);
    out.date = d;
  }
  return out;
}
const onlySecondhand = (c, kinds) => !!c?.src.length && c.src.every(i => kinds[i - 1] === 'community');

// input：执行器写的 JSON；company：命令行给的公司名（优先）。返回 { brief, errors }：有错时 brief 为 null，errors 是
// 一条条可以照着改的话。
export function validateBrief(input, { company = null, now = Date.now() } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { brief: null, errors: ['要一个 JSON 对象（node bin/company.mjs template brief 看写法）'] };
  const name = clean(company || input.company).slice(0, 80), key = companyKey(name);
  if (!key) errors.push(`「${name || '（没写公司）'}」不是能调研的公司名：待核、未披露的先核实是哪家公司`);
  for (const k of Object.keys(input)) if (!BRIEF_KEYS.includes(k)) errors.push(`不认识的字段「${k}」（能写的：${BRIEF_KEYS.join('、')}）`);
  let aliases = [];
  if (input.aliases != null) {
    if (!Array.isArray(input.aliases) || input.aliases.length > 8 || input.aliases.some(a => typeof a !== 'string' || !clean(a) || clean(a).length > 60)) errors.push('aliases 写这家公司的其他叫法，字符串数组，最多 8 个');
    else aliases = [...new Set(input.aliases.map(clean))].filter(a => companyKey(a) && companyKey(a) !== key);
  }
  const rawSources = input.sources == null ? [] : input.sources;
  if (!Array.isArray(rawSources)) errors.push('sources 要是数组：[{"title": "…", "url": "https://…", "date": "YYYY-MM-DD"}]');
  const sources = [], seen = new Set();
  (Array.isArray(rawSources) ? rawSources : []).forEach((s, i) => {
    const at = `sources[${i + 1}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(`${at} 要写成 {"title", "url", "date"}`); sources.push({ title: '', url: '', date: '', kind: 'web', site: '' }); return; }
    const extra = Object.keys(s).filter(k => !['title', 'url', 'date'].includes(k));
    if (extra.length) errors.push(`${at} 多了字段 ${extra.join('、')}（只写 title、url、date）`);
    const title = clean(s.title), url = String(s.url || '').trim(), date = clean(s.date), bad = urlProblem(url);
    if (title.length < 2 || title.length > 120) errors.push(`${at}.title 写页面标题（2–120 字）`);
    if (bad) errors.push(`${at}.${bad}`);
    else if (seen.has(url)) errors.push(`${at} 和前面的来源是同一个链接：合并成一个，引用同一个序号`);
    if (!dateOk(date, now)) errors.push(`${at}.date 写发布日期或你查看的日期 YYYY-MM-DD（或 YYYY-MM），不能是将来`);
    seen.add(url);
    sources.push({ title, url, date, kind: bad ? 'web' : sourceKind(url), site: siteOf(url) });
  });
  if (sources.length > 30) errors.push('sources 最多 30 个：留最有用的');
  const ctx = { errors, sources, now, kinds: sources.map(s => s.kind) };

  // 查不到公开资料：记下查过哪些地方和为什么，不写任何说法。30 天内不再自动重查。
  if (input.status === 'not_found') {
    const searched = Array.isArray(input.searched) ? input.searched.map(clean).filter(Boolean).slice(0, 12) : [];
    if (searched.length < 2) errors.push('查不到时 searched 列出查过的地方（至少 2 处，比如 "官网"、"36氪"、"脉脉"）');
    const note = clean(input.note);
    if (note.length < 4 || note.length > 200) errors.push('查不到时 note 写一句为什么（4–200 字）');
    const said = ['summary', ...Object.keys(SECTIONS)].filter(k => input[k] != null && !(Array.isArray(input[k]) && !input[k].length));
    if (said.length) errors.push(`status 是 not_found 就不写 ${said.join('、')}；有能引用的内容就去掉 status，照常写`);
    return errors.length ? { brief: null, errors } : { brief: { company: name, key, aliases, status: 'not_found', searched, note, sources }, errors };
  }
  if (input.status != null && input.status !== 'ready') errors.push('status 不写就行；查不到公开资料时写 "not_found"');
  for (const k of ['searched', 'note']) if (input[k] != null) errors.push(`${k} 只在 status 是 not_found 时写`);
  if (!sources.length) errors.push('至少要一个来源（sources）');

  let summary = null;
  if (!input.summary) errors.push('缺 summary：两三句大白话的中文，说这家公司是做什么的、现在处在什么阶段');
  else {
    summary = claimOf(input.summary, 'summary', ctx, { min: 20, max: 220 });
    if (summary) {
      if ((summary.text.match(/[一-鿿]/g) || []).length < 8) errors.push('summary 用中文写');
      if ((summary.text.match(/[。！？!?]/g) || []).length > 4) errors.push('summary 两三句就够（现在超过 4 句）');
      if (onlySecondhand(summary, ctx.kinds)) errors.push('summary 只引用了二手来源（论坛、点评、面经站）：摘要要有官网或媒体来源');
    }
  }
  const out = {};
  for (const [k, spec] of Object.entries(SECTIONS)) {
    const v = input[k];
    if (v == null) { out[k] = []; continue; }
    if (!Array.isArray(v)) { errors.push(`${k} 要是数组（没有就写 []）`); out[k] = []; continue; }
    if (v.length > spec.max) errors.push(`${k}（${spec.label}）最多 ${spec.max} 条，现在 ${v.length} 条：挑最有用的`);
    out[k] = v.map((x, i) => claimOf(x, `${k}[${i + 1}]`, ctx, { date: !!spec.date })).filter(Boolean);
    const texts = out[k].map(c => c.text);
    if (new Set(texts).size < texts.length) errors.push(`${k} 里有重复的说法`);
    if (spec.hard) out[k].forEach((c, i) => { if (onlySecondhand(c, ctx.kinds)) errors.push(`${k}[${i + 1}] 只引用了二手来源：${spec.label}这类事实要有官网、媒体或公司页来源；二手说法放 culture、interview、salary 或 red_flags`); });
  }
  if (!Object.values(out).some(list => list.length)) errors.push('除了 summary 至少还要一条有来源的说法（业务、规模、在哪招、技术、动态、口碑、面试、薪资、风险任选）');
  // 列了没用的来源：删掉，或者在用到它的说法里引用它。
  const cited = new Set([...(summary?.src || []), ...Object.values(out).flatMap(list => list.flatMap(c => c.src))]);
  sources.forEach((s, i) => { if (!cited.has(i + 1)) errors.push(`sources[${i + 1}] 没有被任何说法引用：删掉它，或在用到它的说法的 src 里写 ${i + 1}`); });
  return errors.length ? { brief: null, errors } : { brief: { company: name, key, aliases, status: 'ready', summary, ...out, sources }, errors };
}

// ── 公司调研的存取 ────────────────────────────────────────────────────────────
export const briefPath = key => `${BRIEF_DIR}/${key}.json`;
let briefCache = null;
export function loadBriefs() {
  const sig = fileSig(BRIEF_DIR) + '|' + file(BRIEF_DIR);
  if (briefCache?.sig === sig) return briefCache.map;
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(file(BRIEF_DIR)); } catch {} // 兜底：调研目录还没有就是一份都没有
  for (const n of names.filter(n => n.endsWith('.json')).sort()) {
    try { const b = JSON.parse(fs.readFileSync(file(`${BRIEF_DIR}/${n}`), 'utf8')); if (b?.key && ['ready', 'not_found'].includes(b.status)) map.set(b.key, b); } catch {} // 兜底：读坏的那一份跳过，下次调研这家会重写
  }
  briefCache = { sig, map };
  return map;
}
// 别名表跟着这一份调研集合走（集合换了就重建）：指挥台一次要查几十家公司。
const aliasIndex = new WeakMap();
function aliasesOf(briefs) {
  let m = aliasIndex.get(briefs);
  if (!m) { m = new Map(); for (const b of briefs.values()) for (const a of b.aliases || []) { const k = companyKey(a); if (k && !m.has(k)) m.set(k, b); } aliasIndex.set(briefs, m); }
  return m;
}
export function briefFor(company, briefs = loadBriefs()) {
  const key = companyKey(company);
  return key ? briefs.get(key) || aliasesOf(briefs).get(key) || null : null;
}
// 公司资料可共用，别的岗位页里的团队结论不能挂到本岗位。来源序号保留，旧引用不会指到别的页面。
export function briefForLead(lead, briefs = loadBriefs()) {
  const b = briefFor(lead?.company, briefs);
  if (b?.status !== 'ready') return b;
  const own = new Set([lead.url, lead.application_url, lead.source_url].map(canonicalUrl).filter(Boolean));
  const blocked = (b.sources || []).flatMap((s, i) => postingKey({ url: s.url }) && !own.has(canonicalUrl(s.url)) ? [i + 1] : []);
  if (!blocked.length) return b;
  const allowed = c => !(c?.src || []).some(n => blocked.includes(n));
  // 存量调研把异岗结论混入财报引用时，来源序号不能证明它属于全公司。
  // 没有明确 company 范围的摘要及岗位敏感节先收起；业务/规模/新闻仍按公司来源显示。
  const sensitive = new Set(['hiring', 'tech', 'culture', 'interview', 'salary', 'red_flags']);
  return { ...b, summary: allowed(b.summary) && b.summary?.scope === 'company' ? b.summary : { text: '', src: [] },
    ...Object.fromEntries(Object.keys(SECTIONS).map(k => [k, (b[k] || []).filter(c => allowed(c) && (!sensitive.has(k) || c.scope === 'company'))])),
    other_role_sources: blocked, scope_note: '其他岗位的团队资料已收起；旧调研未注明公司范围的摘要、招聘、技术、面经和风险也已收起。本岗位的职责和要求以本页 JD 为准' };
}
export function saveBrief(brief, { now = Date.now(), by = null } = {}) {
  const old = loadBriefs().get(brief.key) || null;
  const stored = {
    ...brief, aliases: [...new Set([...(old?.aliases || []), ...(brief.aliases || [])])],
    updated_at: iso(now), ...(by ? { by } : {}), revision: (old?.revision || 0) + 1, ...(old?.updated_at ? { previous_updated_at: old.updated_at } : {}),
  };
  write(briefPath(brief.key), stored);
  briefCache = null;
  return stored;
}
export const briefAgeDays = (b, now = Date.now()) => b?.updated_at ? Math.max(0, Math.floor((now - T(b.updated_at)) / DAY)) : Infinity;
export const briefFresh = (b, now = Date.now(), settings = briefSettings()) => !!b && briefAgeDays(b, now) < settings.max_age_days;

// 一家公司现在的调研状态：unknown 公司不明 / none 还没调研 / researching 在排队或在做 / ready 有、没过期 /
// stale 有、过期了 / not_found 查过、公开资料很少 / failed 上次没调研成（卡住、放弃了）。
// open：有一条开着的调研任务（有旧调研时也可能在更新）；job：开着的那条，没有就是最近一条。
// 调研是一张 Judge 的调研卡（引擎抓公开页面、模型整理，lib/company-research.mjs）：卡按宿主任务的样子并进来——
// 排着、在做的算「在调研」，没做成的（卡住）算「上次没调研成」；做完、没做成的周期在 max_age_days 天里都不再自动开（你点了照样开）。
// source：周期开的是 cycle（算在每轮的名额里），别的是 page。
const CARD_JOB = { queued: 'pending', running: 'working', needs_you: 'waiting_user', stuck: 'blocked', done: 'completed' };
export function researchTasks() {
  return lastRev(cachedLines('state/tasks.ndjson')).filter(c => c.kind === 'research' && CARD_JOB[c.status])
    .map(c => ({ id: `card:${c.id}`, kind: BRIEF_KIND, status: CARD_JOB[c.status], company: c.leads?.[0]?.company || String(c.title || '').replace(/^调研\s*/, ''), created_at: c.created_at, updated_at: c.updated_at, card: c.id, source: c.from?.by === 'cycle' ? 'cycle' : 'page', ...(c.status === 'stuck' ? { result: clean(c.detail).replace(/^没做成：/, '') } : {}) }));
}
const researchCards = researchTasks;
export function companyState(company, { briefs = loadBriefs(), jobs = [], now = Date.now(), settings = briefSettings() } = {}) {
  const key = companyKey(company);
  if (!key) return { key: null, state: 'unknown', brief: null, job: null, open: false };
  const brief = briefFor(company, briefs);
  const keys = new Set([key, brief?.key, ...(brief?.aliases || []).map(companyKey)].filter(Boolean));
  const mine = lastRev([...jobs, ...researchCards()]).filter(j => j.kind === BRIEF_KIND && [...keys].some(k => sameCompany(j, k))).sort((a, b) => T(b.created_at) - T(a.created_at));
  const open = mine.find(j => OPEN.includes(j.status)) || null, last = mine[0] || null;
  const state = brief ? (brief.status === 'not_found' ? 'not_found' : briefFresh(brief, now, settings) ? 'ready' : 'stale')
    : open ? 'researching' : last && STUCK.includes(last.status) ? 'failed' : 'none';
  return { key: brief?.key || key, state, brief, job: open || last, open: !!open };
}

// ── 怎么准备 ─────────────────────────────────────────────────────────────────
const safeId = rid => String(rid ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
export const prepPath = rid => `${PREP_DIR}/${safeId(rid)}.json`;
export function prepFor(rid) {
  if (!rid) return null;
  try { const p = JSON.parse(fs.readFileSync(file(prepPath(rid)), 'utf8')); return p?.record_id === rid ? p : null; } catch { return null; } // 兜底：准备记录不在或读坏了就当没有，下次会重做
}
// JD 引文的比较：全角半角、大小写、空白和标点都不算差别。
export const squash = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s 　]+/g, '').replace(/[，,。.、；;：:！!？?“”"'‘’()（）【】[\]《》<>·•—–\-_…~～/|]/g, '');
export const jdHash = lead => hash(squash(lead?.jd_text || '')).slice(0, 16);
export const hasJd = lead => squash(lead?.jd_text).length >= 40;
export const PREP_SECTIONS = {
  review: { label: '补一补', max: 4, jd: true },
  pitch: { label: '准备讲', max: 4, jd: true, proof: true },
  company: { label: '这家公司', max: 3, src: true },
};
export const prepCount = prep => Object.keys(PREP_SECTIONS).reduce((n, k) => n + (prep?.[k] || []).length, 0);
// 写入、任务结果和页面共用同一个范围：别的明确岗位页的建议保留在原文里，但不作为本岗位准备。
export function prepPresentation(lead, prep, { brief = briefForLead(lead) } = {}) {
  if (!prep) return { prep: null, counts: { written: 0, visible: 0, hidden: 0 }, scope_note: null };
  const company = (prep.company || []).filter(c => !(c.src || []).some(n => brief?.other_role_sources?.includes(n)));
  const shown = { ...prep, company }, written = prepCount(prep), visible = prepCount(shown), hidden = written - visible;
  return { prep: shown, counts: { written, visible, hidden }, scope_note: hidden ? `当前 ${visible} 条；另 ${hidden} 条引用的是其他岗位的资料，已收起（原写入 ${written} 条）` : null };
}
export function prepSummary(lead, prep, opts) {
  const p = prepPresentation(lead, prep, opts);
  return `写好了：${p.counts.visible} 条${p.scope_note ? `；${p.scope_note}` : ''}`;
}
// 旧任务保存的是当时写入的数；读卡片时按当前正文计算，不改历史账。
export function prepTaskResult(card) {
  if (card?.kind !== 'prep' || card.status !== 'done') return card?.result;
  const rid = card.leads?.[0]?.rid, prep = prepFor(rid);
  const lead = prep && cachedLines('state/leads.ndjson').find(l => (l.record_id || l.id) === rid);
  return lead ? `当前有效准备：${prepSummary(lead, prep)}` : card.result;
}
export function prepHistoricalResult(card, text) {
  if (card?.kind !== 'prep') return text;
  if (/原写入|当前\s*\d+\s*条/.test(String(text || ''))) return String(text).replace(/^写好了[：:]/, '当时可见：');
  return String(text || '').replace(/^写好了[：:]\s*(\d+)\s*条/, '当时原写入：$1 条（历史记录，当前可见条数见当前有效准备）');
}
// 模型回答完不等于那一稿被采用。旧日志没记采用关系的，照实说，不能猜成失败重试。
export function prepRecordView(lead, e, prep = prepFor(ridOf(lead))) {
  const refs = (e.refs || []).map(r => r.file || '').join(' ');
  if (!prep || e.status !== 'ok' || !(e.step === 'role-prep' || e.step === 'model' && /怎么准备|role-prep|role_prep/.test(`${e.msg || ''} ${refs}`))) return e;
  const g = prep.generation, adopted = g?.request_id && refs.includes(g.request_id);
  const retried = !adopted && g?.request_ids?.some(id => refs.includes(id));
  const attempt = /role-prep-[A-Za-z0-9_-]+-\d+-(\d+)\.json\b/.exec(refs);
  // 请求末尾是 writePrep 核对循环的序号；大于 0 只可能是上一稿核对未过后的重写。
  const attemptNote = attempt ? `第 ${Number(attempt[1]) + 1} 次模型尝试${Number(attempt[1]) > 0 ? '，上一稿没通过核对后重写' : ''}；` : '';
  const why = e.step === 'role-prep' ? '当时正文已写入' : adopted ? '这一稿已采用' : retried ? '这一稿没通过核对，重写后采用下一稿' : `${attemptNote}模型完成不等于正文采用，历史记录未保存采用关系`;
  const p = prepPresentation(lead, prep);
  return { ...e, text: `${e.text || e.msg}；${why}。当前有效准备写于 ${localTime(prep.updated_at)}${p.scope_note ? `；${p.scope_note}` : ''}` };
}
export function validatePrep(input, { lead, brief = null } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { prep: null, errors: ['要一个 JSON 对象（node bin/company.mjs template prep 看写法）'] };
  if (!lead) return { prep: null, errors: ['没有这条线索'] };
  if (!hasJd(lead)) return { prep: null, errors: ['这条线索没有 JD 正文，没法对着 JD 准备：先回填原帖正文（node bin/backfill-jd.mjs），再写'] };
  for (const k of Object.keys(input)) if (!Object.hasOwn(PREP_SECTIONS, k)) errors.push(`不认识的字段「${k}」（能写的：review、pitch、company）`);
  const jd = squash(lead.jd_text), ready = brief?.status === 'ready', nsrc = ready ? brief.sources.length : 0, out = {};
  for (const [k, spec] of Object.entries(PREP_SECTIONS)) {
    const v = input[k] == null ? [] : input[k];
    if (!Array.isArray(v)) { errors.push(`${k} 要是数组`); out[k] = []; continue; }
    if (v.length > spec.max) errors.push(`${k}（${spec.label}）最多 ${spec.max} 条，现在 ${v.length} 条`);
    if (spec.src && v.length && !ready) errors.push('这家公司还没有调研好，company 这一节先不写');
    out[k] = v.map((x, i) => {
      const at = `${k}[${i + 1}]`;
      if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push(`${at} 要写成 {"text": "…", ${spec.src ? '"src": [1]' : '"jd": ["JD 原文"]'}}`); return null; }
      const allowed = ['text', ...(spec.jd ? ['jd'] : []), ...(spec.src ? ['src', 'jd'] : []), ...(spec.proof ? ['proof'] : [])];
      const extra = Object.keys(x).filter(f => !allowed.includes(f));
      if (extra.length) errors.push(`${at} 多了字段 ${extra.join('、')}（能写：${allowed.join('、')}）`);
      const text = clean(x.text);
      if (text.length < 6 || text.length > 80) errors.push(`${at}.text 一句话，6–80 个字（现在 ${text.length}）`);
      if (/https?:\/\//i.test(text)) errors.push(`${at}.text 里不放链接`);
      const item = { text };
      const quotes = x.jd == null ? [] : Array.isArray(x.jd) ? x.jd : [x.jd];
      if (spec.jd && !quotes.length) errors.push(`${at}.jd 照抄它回应的 1–2 句 JD 原文（prep-input 里 L 开头的那些）`);
      if (quotes.length > 2) errors.push(`${at}.jd 最多引 2 句`);
      quotes.slice(0, 2).forEach((q, n) => {
        const t = clean(q);
        if (typeof q !== 'string' || t.length < 4 || t.length > 80) errors.push(`${at}.jd[${n + 1}] 引一小段原文，4–80 个字`);
        else if (!jd.includes(squash(t))) errors.push(`${at}.jd[${n + 1}]「${t.slice(0, 30)}」不在这条线索的 JD 里：照抄原文，别改写`);
      });
      if (quotes.length) item.jd = quotes.slice(0, 2).map(clean);
      if (spec.src) {
        const src = Array.isArray(x.src) ? x.src : x.src != null ? [x.src] : [];
        if (!src.length) errors.push(`${at}.src 写公司调研 sources 的序号（prep-input 的 brief.sources）`);
        const bad = src.filter(i => !Number.isInteger(i) || i < 1 || i > nsrc || brief?.other_role_sources?.includes(i));
        if (bad.length) errors.push(`${at}.src 里的 ${bad.join('、')} 不是公司调研的来源序号（1–${nsrc}）`);
        item.src = [...new Set(src.filter(i => Number.isInteger(i) && i >= 1 && i <= nsrc && !brief?.other_role_sources?.includes(i)))];
      }
      if (spec.proof && x.proof != null) {
        const p = clean(x.proof);
        if (p.length < 2 || p.length > 60) errors.push(`${at}.proof 写用哪段真实经历来讲（2–60 字）`);
        else item.proof = p;
      }
      return item;
    }).filter(Boolean);
  }
  const total = out.review.length + out.pitch.length + out.company.length;
  if (out.review.length + out.pitch.length < 2) errors.push('review（补一补）和 pitch（准备讲）加起来至少 2 条');
  if (total > 8) errors.push(`一共最多 8 条（现在 ${total}）：挑最要紧的`);
  return errors.length ? { prep: null, errors } : { prep: out, errors };
}
// 模型写的「怎么准备」先修一遍再核对（R6，主会话 10-10：#516 两次都因为一段 JD 引文超过 80 个字被整份退回）：
// 一处不合规不再整份作废——引文太长截到句读处（截完还要在 JD 里），对不上 JD 的引文丢掉，没有引文了的那一条丢掉，
// 句子太长 / 太短、带链接的那一条丢掉，proof 不合规只丢 proof，调研序号对不上的丢掉；条数超了留前面的。其余照用，
// 修完照旧过 validatePrep（还是不够 2 条就不存）。执行器经 bin/company.mjs prep 写的照旧严格核对（它能照提示改）。
// 返回 { input: 修过的, dropped: 丢了几处 }。
const cutQuote = (t, jd) => {
  if (t.length <= 80) return t;
  const head = t.slice(0, 80), stop = Math.max(...[...'，。；;,.！!？?、'].map(c => head.lastIndexOf(c)));
  const cut = (stop >= 4 ? head.slice(0, stop) : head).trim();
  return cut.length >= 4 && jd.includes(squash(cut)) ? cut : null;
};
export function salvagePrep(input, { lead, brief = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !lead) return { input, dropped: 0 };
  const jd = squash(lead.jd_text), nsrc = brief?.status === 'ready' ? brief.sources.length : 0, out = {};
  let dropped = 0;
  for (const [k, spec] of Object.entries(PREP_SECTIONS)) {
    const v = Array.isArray(input[k]) ? input[k] : [];
    out[k] = v.map(x => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) { dropped++; return null; }
      const text = clean(x.text);
      if (text.length < 6 || text.length > 80 || /https?:\/\//i.test(text)) { dropped++; return null; }
      const item = { text };
      const raw = x.jd == null ? [] : Array.isArray(x.jd) ? x.jd : [x.jd];
      const quotes = raw.map(q => (typeof q === 'string' ? clean(q) : '')).map(t => (t.length >= 4 && jd.includes(squash(t)) ? cutQuote(t, jd) : null));
      dropped += quotes.filter(q => q == null).length;
      const keep = quotes.filter(Boolean).slice(0, 2);
      if (spec.jd && !keep.length) { dropped++; return null; }
      if (keep.length) item.jd = keep;
      if (spec.src) {
        const src = (Array.isArray(x.src) ? x.src : x.src != null ? [x.src] : []).filter(i => Number.isInteger(i) && i >= 1 && i <= nsrc && !brief?.other_role_sources?.includes(i));
        if (!src.length) { dropped++; return null; }
        item.src = [...new Set(src)];
      }
      if (spec.proof && x.proof != null) { const p = clean(x.proof); if (p.length >= 2 && p.length <= 60) item.proof = p; else dropped++; }
      return item;
    }).filter(Boolean);
    if (out[k].length > spec.max) { dropped += out[k].length - spec.max; out[k] = out[k].slice(0, spec.max); }
  }
  // 一共最多 8 条：先少写公司那一节，再从「准备讲」「补一补」的后面去掉。
  for (const k of ['company', 'pitch', 'review']) while (out.review.length + out.pitch.length + out.company.length > 8 && out[k].length > (k === 'company' ? 0 : 1)) { out[k].pop(); dropped++; }
  return { input: out, dropped };
}
// 以前存下的原因里带着字段名的（「pitch[1].jd[1] 引一小段原文，4–80 个字」）：换成同样的人话。
const oldReason = r => (/\b(review|pitch|company)\[\d+\]/.test(String(r || '')) ? `写出来的没通过核对：${prepTrouble([String(r)])}` : r || '');
// 没写成时对你说的那一句（不露 review[1].jd[1] 这类字段名）。errors：validatePrep 的。
export function prepTrouble(errors = []) {
  const e = errors.join('\n');
  if (/没有 JD 正文/.test(e)) return '这条岗位没有岗位描述原文，没法对着写';
  if (/至少 2 条/.test(e)) return '能对上岗位描述原文的不到 2 条';
  if (/不在这条线索的 JD 里|引一小段原文/.test(e)) return '引的岗位描述原文对不上';
  if (/还没有调研好|来源序号/.test(e)) return '公司那一节引的调研来源对不上';
  return errors.length ? '格式不对' : '原因没写下来';
}
export function savePrep(lead, prep, { brief = null, now = Date.now(), by = null, input_fp = null, generation = null } = {}) {
  const rid = ridOf(lead);
  const old = prepFor(rid);
  // 旧正文留档，不能为了说明重复写作删掉一次真实调用或覆盖唯一旧版本。
  if (old) write(`state/role-prep-history/${safeId(rid)}/${old.revision || hash(old).slice(0, 16)}.json`, old);
  const stored = {
    record_id: rid, number: lead.number ?? null, company: lead.company || '', role: lead.role || '', ...prep,
    brief_key: brief?.key || null, brief_updated_at: brief?.status === 'ready' ? brief.updated_at : null, jd_hash: jdHash(lead),
    updated_at: iso(now), revision: hash([rid, prep, iso(now)]).slice(0, 16), ...(by ? { by } : {}), ...(input_fp ? { input_fp } : {}), ...(generation ? { generation } : {}),
  };
  write(prepPath(rid), stored);
  // 写好了：这条岗位上等着「怎么准备」的卡的活记做完（Judge 自己写的、执行器 bin/company.mjs prep 写的都走这里）。
  moveCardJobs({ kind: 'prep', target: `lead:${rid}` }, 'done', { result: { summary: prepSummary(lead, stored) } });
  return stored;
}
// 这条线索的「怎么准备」：ready 有了 / queued 在排队或在做 / no_jd 没有 JD 正文 / failed 上次没写成 / none 还没有。
// outdated：有了但依据变了——公司调研后来更新过（brief）、JD 变了（jd）。
// 「在写」也看 lib/role-prep.mjs 的小表（Judge 自己写，不排宿主任务）：10 分钟内开始写的算在写；没写成的 24 小时内算没写成（周期不再自动重试，你点了照样写）。
export function prepState(lead, { jobs = [], briefs = loadBriefs(), now = Date.now(), writing = read(PREP_WRITING, {}) || {} } = {}) {
  const rid = ridOf(lead), prep = prepFor(rid), w = writing[rid] || null, age = w ? now - T(w.at) : Infinity;
  const mine = lastRev(jobs).filter(j => j.kind === PREP_KIND && j.record_id === rid).sort((a, b) => T(b.created_at) - T(a.created_at));
  const open = mine.find(j => OPEN.includes(j.status)) || (w?.status === 'writing' && age < WRITING_MS ? { kind: PREP_KIND, record_id: rid, status: 'working', created_at: w.at, result: '' } : null), last = mine[0] || null;
  const failedNow = w && ['failed', 'unavailable'].includes(w.status) && age < RETRY_MS && T(w.at) > T(last?.created_at);
  const state = prep ? 'ready' : open ? 'queued' : !hasJd(lead) ? 'no_jd' : failedNow || (last && STUCK.includes(last.status)) ? 'failed' : 'none';
  const job = open || (failedNow ? { kind: PREP_KIND, record_id: rid, status: 'blocked', created_at: w.at, result: oldReason(w.reason) } : last);
  const brief = prep ? briefFor(lead.company, briefs) : null;
  const outdated = prep ? [brief?.status === 'ready' && T(brief.updated_at) > T(prep.brief_updated_at) ? 'brief' : null, prep.jd_hash && prep.jd_hash !== jdHash(lead) ? 'jd' : null].filter(Boolean) : [];
  return { state, prep, job, open: !!open, outdated };
}

// ── 给执行器看的输入 ──────────────────────────────────────────────────────────
// 写「怎么准备」要的全部东西，一次打印完：执行器不用去读 20 MB 的线索文件。
const evidenceOf = h => { const v = clean(typeof h.evidence === 'object' && h.evidence ? JSON.stringify(h.evidence) : h.evidence || h.candidate_evidence || h.resume_ref || h.quote || ''); return v && !/^(unknown|none|n\/a|null)$/i.test(v) ? v.slice(0, 200) : null; };
export function prepInput(lead, { briefs = loadBriefs() } = {}) {
  const m = lead.match || {}, brief = briefForLead(lead, briefs), ready = brief?.status === 'ready';
  const texts = list => (list || []).map(c => ({ text: c.text, src: c.src }));
  return {
    lead: { number: lead.number ?? null, record_id: ridOf(lead), company: lead.company || '', role: lead.role || '', city: lead.location || '', stage: stageText(lead), verdict: m.verdict || null },
    jd: jdLines(lead.jd_text || '').slice(0, 60).map((x, i) => `L${i + 1} ${x.slice(0, 160)}`),
    judgment: {
      reasons: (m.reasons || lead.reasons || []).slice(0, 4).map(r => clean(r).slice(0, 200)),
      gap: clean(m.biggest_gap || lead.biggest_gap || '') || null,
      must_haves: (m.must_haves || []).slice(0, 10).map(h => ({ req: clean(h.req || h.requirement || h.name || '').slice(0, 160), status: h.status || 'unknown', evidence: evidenceOf(h) })),
    },
    brief: ready ? { updated_at: brief.updated_at, summary: brief.summary.text, tech: texts(brief.tech), interview: texts(brief.interview), culture: texts(brief.culture), red_flags: texts(brief.red_flags), sources: brief.sources.map((s, i) => ({ n: i + 1, title: s.title, site: s.site, kind: s.kind })).filter(s => !brief.other_role_sources?.includes(s.n)) }
      : brief ? { status: brief.status, note: brief.note || '' } : null,
    dossier: lead.interview_dossier?.status === 'published' && lead.interview_dossier.url ? lead.interview_dossier.url : null,
    // 你说准备时卡住的点（「N 卡住了 …」，bin/action.mjs）：写「补一补」时照顾到。
    ...((lead.interview_stuck || []).length ? { stuck: lead.interview_stuck.slice(-5).map(x => clean(x.text).slice(0, 120)) } : {}),
    write: 'review（补一补）和 pitch（准备讲）各 1–4 条，每条 text 一句话（6–80 字），jd 照抄它回应的 1–2 句 JD 原文（上面 L 开头的，去掉行号）；pitch 用候选人真实经历（判断里的 evidence），proof 写用哪段经历，不夸大；company（这家公司）0–3 条，只在有公司调研时写，src 写 brief.sources 的 n。一共不超过 8 条。',
  };
}

// ── 队列 ─────────────────────────────────────────────────────────────────────
// rows：指挥台的行（lib/hq.mjs hqView().rows：tab、verdict、cols、ending、rid、number、company、role、city）。
// 走到递出及以后：八列里从「递出」起有动静（Offer 也算），线索没结束。
export const reachedOut = r => !!r && (!r.ending || r.ending === 'offer') && (r.ending === 'offer' || (r.cols || []).slice(5).some(c => c && !['not_reached', 'skipped'].includes(c.status)));
const deciding = r => ['new', 'approve'].includes(r.tab) && ['recommend', 'verify'].includes(r.verdict) && !r.ending;
const roleLine = r => `#${r.number} ${clean(r.role).slice(0, 40)}${r.city ? `（${r.city}）` : ''}`;

// 命令里的公司名加引号（「Trane Technologies」「示例（中国）」这类带空格、括号的名字照抄也能跑）。
const quoted = name => `"${String(name).replace(/["\\$`]/g, '')}"`;
const BRIEF_TASK = (company, roles = [], previous = null) => [
  `为「${company}」写公司调研（这家公司的所有岗位共用${roles.length ? `；在看的岗位：${roles.join('、')}` : ''}）。`,
  previous?.updated_at ? `上次调研是 ${String(previous.updated_at).slice(0, 10)}：先 node bin/company.mjs show ${quoted(company)} 看旧版，更新近期动态、面经和风险，仍然成立的保留。` : '',
  '写法：node bin/company.mjs template brief。查官网、可靠媒体（36氪、虎嗅、晚点等）、LinkedIn 公司页；面经和口碑查牛客、看准、脉脉（二手）。',
  '每条说法引用 sources 的序号，查不到的不写、不猜；要登录的来源跳过，不为调研找用户登录。',
  `写入：node bin/company.mjs brief ${quoted(company)} --file <json>（先加 --check 自检，校验不过照提示改）；查不到公开资料就写 {"status":"not_found","searched":[…],"note":"…"}。控制在 10 次搜索以内。`,
].filter(Boolean).join('');
const PREP_TASK = (lead, brief) => [
  `为 #${lead.number ?? '—'} ${lead.company || ''} · ${clean(lead.role).slice(0, 40)} 写「怎么准备」：先 node bin/company.mjs prep-input ${lead.number ?? ridOf(lead)}（JD 原文、判断的主要缺口、公司调研）。`,
  '写 3–8 条：review 要补的、pitch 准备讲的（用候选人真实经历，不夸大）、company 这家公司的面经要点（引用调研来源序号）；review 和 pitch 每条在 jd 里照抄 1–2 句它回应的 JD 原文。',
  brief?.status === 'ready' ? '' : '这家公司没有可用的调研，company 这一节不写。',
  `写入：node bin/company.mjs prep ${lead.number ?? ridOf(lead)} --file <json>（先加 --check 自检）。`,
].filter(Boolean).join('');

export function briefJob({ company, key = companyKey(company), rows = [], reason = 'new', source = 'watch', now = Date.now(), previous = null } = {}) {
  const at = iso(now), name = clean(company).slice(0, 60), roles = rows.filter(r => r.number != null).slice(0, 5).map(roleLine);
  return {
    id: hash([BRIEF_KIND, key, at, source]), kind: BRIEF_KIND, company: name, company_key: key, status: 'pending', created_at: at, source, reason,
    ...(roles.length ? { roles } : {}), ...(previous?.updated_at ? { refresh_of: previous.updated_at } : {}),
    instructions: BRIEF_TASK(name, roles, previous),
  };
}
export function prepJob({ lead, source = 'watch', reason = 'auto', now = Date.now(), brief = null } = {}) {
  const at = iso(now), rid = ridOf(lead);
  return {
    id: hash([PREP_KIND, rid, at, source]), kind: PREP_KIND, record_id: rid, number: lead.number ?? null, company: lead.company || '', company_key: companyKey(lead.company),
    status: 'pending', created_at: at, source, reason, instructions: PREP_TASK(lead, brief),
  };
}

// 该排调研的公司，排好序（岗位多的在前）。wantsPrep(row)：这一行走到了递出、在等「怎么准备」，它的公司也要调研。
export function briefCandidates(rows = [], { briefs = loadBriefs(), jobs = [], now = Date.now(), settings = briefSettings(), wantsPrep = () => false } = {}) {
  const by = new Map(), byLead = new Map(cachedLines('state/leads.ndjson').map(l => [ridOf(l), l]));
  for (const r of rows) {
    if (!directionSet() && !happened(byLead.get(r.rid))) continue;
    if (shelved(byLead.get(r.rid) || { ...r, match: { verdict: r.verdict } })) continue;
    const key = companyKey(r.company);
    if (!key) continue;
    const c = by.get(key) || by.set(key, { key, company: r.company, open: 0, deciding: 0, recommend: 0, prep: 0, rows: [] }).get(key);
    if (!r.ending || r.ending === 'offer') c.open++;
    if (deciding(r)) { c.deciding++; if (r.verdict === 'recommend') c.recommend++; c.rows.push(r); }
    else if (reachedOut(r) && wantsPrep(r)) { c.prep++; c.rows.push(r); }
  }
  const out = [];
  for (const c of by.values()) {
    if (!c.deciding && !c.prep) continue;
    const st = companyState(c.company, { briefs, jobs, now, settings });
    if (st.brief && briefFresh(st.brief, now, settings)) continue;          // 有调研、没过期（查不到的也算，30 天内不重查）
    if (st.open || st.job?.status === 'waiting_user') continue;             // 已经在排、在做
    // 最近试过没成（卡住、放弃）：等过了期限，或者你在页面上点「再试一次」。
    if (st.job && now - T(st.job.created_at) < settings.max_age_days * DAY && !(st.brief && st.job.status === 'completed')) continue;
    out.push({ ...c, reason: st.brief ? 'stale' : 'new', brief: st.brief });
  }
  return out.sort((a, b) => b.open - a.open || b.recommend - a.recommend || b.deciding - a.deciding || b.prep - a.prep || a.company.localeCompare(b.company, 'zh'));
}
// 自动调研：同时开着的周期调研卡不超过 per_cycle 家（引擎一轮没做完，下一轮不再往上叠）。不改 jobs：要开卡的公司在 add 里，
// 由周期开调研卡（openResearchCards）。以前排给本机 AI 的旧任务（source watch）还开着的也算在名额里。
export function queueBriefs(jobs, rows, opts = {}) {
  const { now = Date.now(), settings = briefSettings() } = opts;
  const all = lastRev([...jobs, ...researchCards()]);
  const open = all.filter(j => j.kind === BRIEF_KIND && OPEN.includes(j.status) && ['watch', 'cycle'].includes(j.source)).length;
  const room = Math.max(0, settings.per_cycle - open), candidates = briefCandidates(rows, { ...opts, jobs: all, now, settings });
  const add = candidates.slice(0, room).map(c => ({ company: c.company, key: c.key, rows: c.rows, reason: c.reason, previous: c.brief || null }));
  return { add, open, room, candidates: candidates.length };
}
// 周期开调研卡（Judge 的，kind research，自己开跑）：一家一张，挂上为它排的第一条岗位。→ 开出来的卡
export async function openResearchCards(add = [], { now = Date.now(), leads = cachedLines('state/leads.ndjson') } = {}) {
  if (!add.length) return [];
  const { makeCard, saveCards, leadRef } = await import('./cards.mjs');
  const cards = add.map(a => {
    const r = (a.rows || []).find(x => x.rid), l = r ? leads.find(x => ridOf(x) === r.rid && !x.superseded) : null;
    return makeCard({ kind: 'research', title: `调研 ${clean(a.company).slice(0, 60)}`, leads: l ? [leadRef(l)] : [], owner: 'lens', from: { by: 'cycle' }, auto: true, now });
  });
  saveCards(cards);
  return cards;
}
// 自动写「怎么准备」：走到递出以后、有 JD、还没有的线索，排好序挑出这一轮要写的（L 线第 1b 批起由 Judge 自己写，lib/role-prep.mjs，
// 不再排 role_prep 宿主任务）。公司调研还在路上的等它好了再写；调研没人做得了（App 里本机 AI 没开，waitBrief: false）就不等，
// company 那一节先不写。线索结束了还开着的「怎么准备」任务（以前排给执行器的）一并关掉。→ { want: [线索…], closed, waiting }
export function queuePreps(jobs, rows, { leads = [], briefs = loadBriefs(), now = Date.now(), settings = briefSettings(), waitBrief = true, writing = read(PREP_WRITING, {}) || {} } = {}) {
  const leadBy = new Map(leads.filter(l => !l.superseded).map(l => [ridOf(l), l])), at = iso(now);
  const ended = new Set(rows.filter(r => r.ending && r.ending !== 'offer').map(r => r.rid));
  for (const l of leads) if (shelved(l)) ended.add(ridOf(l));
  const closed = [];
  for (const j of jobs) {
    if (j.kind !== PREP_KIND || !OPEN.includes(j.status) || !(ended.has(j.record_id) || (leads.length && !leadBy.has(j.record_id)))) continue;
    Object.assign(j, { status: 'completed', completed_at: at, updated_at: at, result: '线索已经结束，不用准备了' });
    closed.push(j.id);
  }
  const all = lastRev(jobs);
  let room = Math.max(0, settings.prep_per_cycle);
  const rank = r => r.tab === 'interview' ? 0 : r.tab === 'waiting' ? 1 : 2;
  const want = [], waiting = new Set();
  for (const r of rows.filter(r => reachedOut(r) && r.number != null).sort((a, b) => rank(a) - rank(b) || T(b.at) - T(a.at))) {
    if (!room) break;
    const l = leadBy.get(r.rid);
    if ((!directionSet() && !happened(l)) || (l && shelved(l))) continue;
    // 以前排给本机 AI、还没人接的旧任务（pending）不算在写：Judge 照样写，写好了把它一并关掉。
    const st = l ? prepState(l, { jobs: all, briefs, now, writing }) : null;
    if (!st || (st.state !== 'none' && !(st.state === 'queued' && st.job?.status === 'pending'))) continue;
    const co = companyState(l.company, { briefs, jobs: all, now, settings });
    if (waitBrief && ['none', 'researching'].includes(co.state)) { waiting.add(co.key); continue; }
    want.push(l);
    room--;
  }
  return { want, closed, waiting: [...waiting] };
}
// 周期里 Judge 这一步：先挑要调研的公司，再挑「怎么准备」要写的线索（要调研的公司，它的线索这轮先等着）。jobs 里结束了的旧「怎么准备」任务原地关掉。
// engine：调研有没有人做（能力表 company_research 归引擎，要有文字模型）。没有就不开调研卡，只数这一轮本来要开几家（no_model），
// 「怎么准备」也就不等调研。research（要开调研卡的公司）和 want（要写的线索）不打进周期的输出：bin/prepare-interviews.mjs 拿去做。
export function watchQueue({ jobs, rows, leads = [], now = Date.now(), settings = briefSettings(), briefs = loadBriefs(), engine = true }) {
  const leadBy = new Map(leads.filter(l => !l.superseded).map(l => [ridOf(l), l])), writing = read(PREP_WRITING, {}) || {};
  const wantsPrep = r => { const l = leadBy.get(r.rid); return !!l && prepState(l, { jobs, briefs, now, writing }).state === 'none'; };
  const b = queueBriefs(jobs, rows, { briefs, now, settings: engine ? settings : { ...settings, per_cycle: 0 }, wantsPrep });
  const p = queuePreps(jobs, rows, { leads, briefs, now, settings, waitBrief: engine, writing });
  return {
    company_briefs: { queued: b.add.map(a => a.company), open: b.open, candidates: b.candidates, per_cycle: settings.per_cycle, ...(engine ? {} : { no_model: Math.min(b.candidates, settings.per_cycle) }) },
    role_prep: { queued: p.want.map(l => l.number), closed: p.closed.length, waiting_brief: p.waiting.length, per_cycle: settings.prep_per_cycle },
    research: b.add,
    want: p.want,
  };
}

// ── 页面上的按钮：调研排队、拉起即时执行器；怎么准备 Judge 自己写 ────────────────────
export const findLead = rid => cachedLines('state/leads.ndjson').find(l => ridOf(l) === rid && !l.superseded) || null;
export async function requestBrief({ company = '', record_id = null, source = 'dashboard', now = Date.now(), kick = requestRunNow } = {}) {
  const lead = record_id ? findLead(record_id) : null, name = clean(company || lead?.company).slice(0, 80), key = companyKey(name);
  if (!key) return { status: 'unknown', receipt: `「${name || '这家公司'}」还不明（待核），先核实是哪家公司再调研。` };
  // 能力表 company_research 归引擎（Judge 抓公开页面、模型整理：lib/company-research.mjs，经 lib/task-do.mjs 的调研卡）；
  // 本机 AI 只接你交代的事和修系统（契约 2.4），所以按钮不排宿主任务、不叫醒本机 AI。source、kick 留着给老的调用方，不再用。
  const { makeCard, saveCards, readCards } = await import('./cards.mjs');
  const open = readCards().find(c => c.kind === 'research' && !['done', 'cancelled', 'stuck'].includes(c.status) && (c.title || '').includes(name));
  if (open) return { status: 'already', task: open.id, receipt: `${name} 已经在调研了，查完就出现在这里。` };
  const card = makeCard({ kind: 'research', title: `调研 ${name}`, leads: lead ? [{ rid: ridOf(lead), number: lead.number ?? null, company: lead.company || null }] : [], owner: 'lens', from: { by: 'you', via: 'page' }, auto: true, now });
  saveCards([card]);
  return { status: 'queued', task: card.id, receipt: `已交给 ${LENS} 调研 ${name}，查完就出现在这里。` };
}

// ── 写入之后：关掉对应的任务 ──────────────────────────────────────────────────
// bin/company.mjs 写入成功就把开着的同一家公司的调研任务（或同一条线索的「怎么准备」）记为完成：执行器忘了报 done，
// 下一轮也不会再查一遍。执行器随后照常 node bin/job.mjs done。
export function closeJobs(jobs, { kind, keys = [], record_id = null, result, evidence, now = Date.now() }) {
  const at = iso(now), closed = [];
  for (const j of jobs) {
    if (j.kind !== kind || !OPEN.includes(j.status)) continue;
    if (kind === BRIEF_KIND ? !keys.some(k => sameCompany(j, k)) : j.record_id !== record_id) continue;
    Object.assign(j, { status: 'completed', completed_at: at, updated_at: at, result, evidence, needs: [], waiting_user: null, blocked_reason: null });
    closed.push(j.id);
  }
  return closed;
}
// bin/job.mjs done 之前：调研 / 怎么准备任务要先用 bin/company.mjs 写进去（这条任务创建之后写的），不能空着报完成。
export function doneGuard(job) {
  if (job.kind === BRIEF_KIND) {
    const b = briefFor(job.company_key || job.company);
    if (!b || T(b.updated_at) < T(job.created_at)) throw Error(`这是公司调研任务：先 node bin/company.mjs brief ${job.company || job.company_key} --file <json> 写入（查不到就写 status:not_found），再报 done；做不下去用 blocked`);
  }
  if (job.kind === PREP_KIND) {
    const p = prepFor(job.record_id);
    if (!p || T(p.updated_at) < T(job.created_at)) throw Error(`这是「怎么准备」任务：先 node bin/company.mjs prep ${job.number ?? job.record_id} --file <json> 写入，再报 done；做不下去用 blocked`);
  }
}

// ── 给页面的 ─────────────────────────────────────────────────────────────────
// 一条说法给页面：来源序号换成 { n, url, title, site, kind, date }，只引用二手来源的标 second。
function claimView(c, sources) {
  const src = (c.src || []).map(i => sources[i - 1] ? { n: i, ...sources[i - 1] } : null).filter(Boolean);
  return { text: c.text, ...(c.date ? { date: c.date } : {}), src, second: !!src.length && src.every(s => s.kind === 'community') };
}
export function briefView(b) {
  if (!b) return null;
  const sources = (b.sources || []).map(s => ({ ...s, word: SOURCE_WORD[s.kind] || '' }));
  const out = { company: b.company, key: b.key, aliases: b.aliases || [], status: b.status, updated_at: b.updated_at || null, by: b.by || null, sources };
  // 引擎抓公开页面写的（lib/company-research.mjs）：抓了哪几页、跳过了哪几页、没用搜索引擎。
  if (b.engine) out.engine = { pages: (b.engine.pages || []).length, skipped: (b.engine.skipped || []).map(x => ({ url: x.url, site: siteOf(x.url), why: x.why })), search_engine: false };
  if (b.status === 'not_found') return { ...out, searched: b.searched || [], note: b.note || '' };
  out.summary = b.summary ? claimView(b.summary, sources) : null;
  for (const k of Object.keys(SECTIONS)) out[k] = (b[k] || []).map(c => claimView(c, sources));
  out.news.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  return out;
}
const jobView = j => j ? { id: j.id, status: j.status, created_at: j.created_at || null, completed_at: j.completed_at || null, result: j.result ? clean(j.result).slice(0, 200) : null, reason: j.reason || null } : null;
// 线索详情页的「公司」一节。
export function companyDetail(lead, { jobs = cachedLines('state/host-jobs.ndjson'), now = Date.now(), settings = briefSettings() } = {}) {
  const st = companyState(lead?.company, { jobs, now, settings });
  return { name: lead?.company || '', key: st.key, state: st.state, open: st.open, job: jobView(st.job), brief: briefView(briefForLead(lead)), scope_note: briefForLead(lead)?.scope_note || null, age_days: st.brief ? briefAgeDays(st.brief, now) : null, max_age_days: settings.max_age_days };
}
// 线索详情页的「怎么准备」一节。
export function prepDetail(lead, { jobs = cachedLines('state/host-jobs.ndjson') } = {}) {
  const st = prepState(lead, { jobs });
  const brief = st.prep ? briefForLead(lead) : null;
  const srcs = brief?.status === 'ready' ? brief.sources : [];
  const presentation = prepPresentation(lead, st.prep, { brief });
  const prep = presentation.prep ? { ...presentation.prep, company: presentation.prep.company.map(c => ({ ...c, src: (c.src || []).map(i => srcs[i - 1] ? { n: i, url: srcs[i - 1].url, title: srcs[i - 1].title, site: srcs[i - 1].site, kind: srcs[i - 1].kind } : null).filter(Boolean) })) } : null;
  const d = lead?.interview_dossier;
  return { state: st.state, open: st.open, outdated: st.outdated, job: jobView(st.job), prep, counts: presentation.counts, scope_note: presentation.scope_note, has_jd: hasJd(lead), dossier: d?.status === 'published' && d.url ? { url: d.url, verified_at: d.verified_at || null } : null };
}
// 指挥台抽屉里的小卡：摘要 + 两三条要紧的事实（规模、业务，有风险写风险，没有写在哪招 / 技术）。
export function companyCard(company, { briefs = loadBriefs(), jobs = [], now = Date.now(), settings = briefSettings() } = {}) {
  const st = companyState(company, { briefs, jobs, now, settings });
  const card = { key: st.key, state: st.state, open: st.open, job_status: st.job?.status || null, job_result: st.state === 'failed' && st.job?.result ? clean(st.job.result).slice(0, 120) : null };
  const b = briefForLead({ company }, briefs);
  if (!b) return card;
  card.updated_at = b.updated_at || null;
  if (b.status === 'not_found') return { ...card, note: clean(b.note).slice(0, 120) };
  const first = k => (b[k] || [])[0];
  const pick = [['规模', first('scale')], ['业务', first('business')], ['风险', first('red_flags')], ['在哪招', first('hiring')], ['技术', first('tech')]].filter(([, c]) => c).slice(0, 3);
  return { ...card, summary: b.summary?.text || '', facts: pick.map(([k, c]) => ({ k, v: c.text, second: claimView(c, b.sources).second })), sources: (b.sources || []).length, flags: (b.red_flags || []).length };
}
// 团队条上 Watch 的「调研中 N 家 / 已调研 M 家」。
export function researchCounts({ briefs = loadBriefs(), jobs = [] } = {}) {
  const researching = new Set(lastRev([...jobs, ...researchCards()]).filter(j => j.kind === BRIEF_KIND && OPEN.includes(j.status)).map(j => j.company_key || companyKey(j.company)).filter(Boolean));
  return { researching: researching.size, done: [...briefs.values()].filter(b => b.status === 'ready').length, preps_open: lastRev(jobs).filter(j => j.kind === PREP_KIND && OPEN.includes(j.status)).length };
}

// ── 骨架（node bin/company.mjs template brief|prep）─────────────────────────────
export const TEMPLATES = {
  brief: {
    aliases: ['公司的其他叫法（可选）'],
    summary: { text: '两三句中文写公司层面的业务和阶段，不写某个岗位的情况。', src: [1], scope: 'company' },
    business: [{ text: '主要业务和产品，一条一件事', src: [1] }],
    scale: [{ text: '规模 / 融资 / 阶段（写清年份和数字的出处）', src: [2] }],
    hiring: [{ text: '在哪些城市、哪些团队招人', src: [1] }],
    tech: [{ text: '技术栈、AI 方向', src: [1] }],
    news: [{ date: 'YYYY-MM-DD', text: '一件近期的事（一年内优先）', src: [2] }],
    culture: [{ text: '加班、口碑等（二手来源，页面标「二手」）', src: [3] }],
    interview: [{ text: '面试流程、面经里反复出现的考点', src: [3] }],
    salary: [{ text: '公开的薪资信号（没有就删掉这一节）', src: [3] }],
    red_flags: [{ text: '风险：裁员、欠薪、业务收缩……（没有就删掉这一节）', src: [2] }],
    sources: [
      { title: '官网 · 关于我们', url: 'https://www.example.com/about', date: 'YYYY-MM-DD' },
      { title: '媒体报道标题', url: 'https://36kr.com/p/…', date: 'YYYY-MM-DD' },
      { title: '牛客面经标题', url: 'https://www.nowcoder.com/discuss/…', date: 'YYYY-MM-DD' },
    ],
  },
  prep: {
    review: [{ text: '要补的一件事（一句话）', jd: ['照抄它回应的 JD 原文'] }],
    pitch: [{ text: '准备讲的一段经历，讲到什么程度', jd: ['照抄它回应的 JD 原文'], proof: '用哪段真实经历' }],
    company: [{ text: '这家公司面试的一个要点', src: [1] }],
  },
};
