// BOSS 上招聘方主动找你、雷达又没扫到的岗位（10-01 负责人：「是不是也要把它放进我的雷达的池子里面呢？……还是说要去给
// judge 判断一下？如果合适才放，不合适的话也不监听」，选了「你看过再精判」）。挂在 Watcher 看 BOSS 聊天列表那一轮里
// （lib/boss-inbox.mjs runBossInbox），开关同一个：config/pipeline.json boss_chat_watch。
//
// 两段：
// 1. 还没读的（列表上有未读角标）：**从不点开**——点开对方就看到「已读」，系统不能替你已读不回。只看列表上的字：
//    自上次看过之后新冒出来的对话、有未读、最后一句是对方的、系统从没给这家公司 / 这个人发过东西，才算「对方主动找你」。
//    粗筛：你排除的公司、最后一句里点名的岗位是标题规则挡掉的（级别、方向）→ 不提、不再看（state/boss-inbox.json 记为 ignored）。
//    其余的一个对话一封轻信：「打开 BOSS 聊天」「不感兴趣」。这些不再进「N 个对话对不上岗位」那封合并的信。
// 2. 你自己读过之后（角标没了），下一轮只读地看一眼：点开这个对话，看岗位卡片和第一句是谁说的——第一句是对方的才往下走；
//    点岗位卡片（BOSS 在新标签页里打开岗位页），读岗位链接和 JD，关掉。岗位页上什么都不点（立即沟通 / 继续沟通都不碰）。
//    交给 Judge 精判（lib/judge-leads.mjs judgeLead，先判后存）：合适 → 进岗位池，来源「BOSS · 对方主动联系」、标签「对方主动找你」，
//    之后和雷达找到的岗位一样走；不合适 → 不进池、这个对话不再看，活动里记一句「Judge 判断不太合适：理由」，不发信。
//
// 运行时的红线：不回复、不输入、输入框里不留字、不点立即沟通、不点开未读的对话。脚本里的点击只有两处：
// 已读对话的 .friend-content、对话里的岗位卡片（tests/boss-inbound.test.mjs 看着）。
import fs from 'node:fs';
import { read, write, lines, writeLines, file, today, hash } from './store.mjs';
import { event } from './events.mjs';
import { BRAND } from './brand.mjs';
// BOSS 聊天列表的地址和它的状态文件（lib/boss-inbox.mjs 从这里转出去；两边以前互相引，成环）。
export const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
export const STATE_PATH = 'state/boss-inbox.json';
import { parseChatItem } from './list-watch.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { noteSwallowed } from './swallow.mjs';

export const SOURCE_TYPE = 'BOSS · 对方主动联系';
export const TAG = '对方主动找你';
export const MAX_PER_ROUND = 2; // 一轮最多看两个对话（每个二十来秒）
export const MAX_ATTEMPTS = 3;  // 读不成三次就不再试

// ── 列表上的字 ─────────────────────────────────────────────────────────────────────────────────
const clean = s => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[\s·|｜]+/g, '');
// 名字后面那一段（「Northwind 招聘者」「Contoso · HRBP」）里招聘者的头衔。
const TITLE_WORD = /^(?:招聘者|招聘|招聘专员|招聘经理|招聘主管|招聘负责人|人事|人事经理|人事专员|hr|hrbp|hrd|hrm|猎头|顾问|技术总监|技术负责人|研发总监|总监|经理|主管|负责人|创始人|联合创始人|合伙人|ceo|cto|coo|总裁|老板|面试官|部门负责人|团队负责人|tl|leader)$/i;
export function splitOrg(org) {
  const parts = clean(org).split(/\s*[·|｜]\s*|\s+/).filter(Boolean);
  const company = parts.filter(p => !TITLE_WORD.test(p));
  return { company: company.join(' ').slice(0, 60), title: parts.filter(p => TITLE_WORD.test(p)).join(' ').slice(0, 40) };
}

function companyTokens(company) {
  const c = String(company || '').normalize('NFKC');
  const parts = [c, c.replace(/[（(].*$/, ''), ...(c.match(/[（(]([^）)]*)[）)]/)?.[1] || '').split(/[,，、/]/)];
  return [...new Set(parts.map(norm).filter(t => t.length >= 2))];
}
// 系统给这家公司 / 这个人发过东西没有（state/outbound.ndjson，任何渠道）：发过就不算「对方主动找你」。
export function contactedBefore(conv, { leads = [], outbound = [] } = {}) {
  const head = norm(`${conv.shown} ${conv.org}`), who = norm(conv.name);
  const byId = new Map(leads.map(l => [l.record_id || l.id, l]));
  return outbound.some(o => {
    const company = o.company || byId.get(o.record_id)?.company || '';
    if (companyTokens(company).some(t => head.includes(t))) return true;
    return !!who && who.length >= 2 && [o.to, o.conversation, o.thread].some(v => typeof v === 'string' && norm(v).includes(who));
  });
}

// 最后一句里点名的岗位：「在招 / 招聘 / 岗位：…」后面那几个字，或者「」【】里的；要带个岗位名词才算。
const ROLE_NOUN = /工程师|开发|架构|专家|经理|总监|负责人|主管|研究员|实习|测试|产品|运营|销售|设计师|算法|engineer|developer|architect|manager|director|lead|intern|qa\b|sdet/i;
export function roleInMessage(text) {
  const s = clean(text);
  const found = [
    ...[...s.matchAll(/[「【《“"]([^」】》”"]{2,30})[」】》”"]/g)].map(m => m[1]),
    ...[...s.matchAll(/(?:在招|招聘|招|岗位|职位)[：:\s]*([^\s，,。！!？?；;、：:「」【】]{2,24})/g)].map(m => m[1]),
  ];
  return found.find(r => ROLE_NOUN.test(r)) || null;
}
// 标题规则挡掉的（lib/matcher.mjs prefilter 里看标题的那几条：级别、你不做的方向）。别的理由（地点、质量……）列表上看不出来，不在这里判。
const TITLE_REASONS = new Set(['seniority_out_of_range', 'excluded_role', 'outside_target_specialty', 'non_software_role']);
export async function titleReason(role) {
  if (!role) return null;
  try {
    const { prefilter } = await import('./matcher.mjs');
    const r = prefilter({ company: '', role, location: '', jd_text: '' });
    return TITLE_REASONS.has(r) ? r : null;
  } catch (e) { noteSwallowed('boss-inbound.titleReason', e, { member: 'scout', doing: '按标题规则看这个岗位', then: '当没被标题规则挡' }); return null; }
}

// 粗筛（只看列表上的字）：明显不合适的理由，或者 null。
export async function coarseReason(conv, { pipeline = read('config/pipeline.json', {}) || {} } = {}) {
  const { company, title } = splitOrg(conv.org);
  const names = [company, conv.org, ...clean(conv.org).split(/\s*[·|｜]\s*|\s+/)].filter(Boolean);
  if (names.some(n => excludedCompany({ company: n, author_title: title }, pipeline))) return 'company_excluded_by_user';
  return titleReason(roleInMessage(conv.preview));
}

// 第一段：一个还没读、对不上岗位的新对话算不算「对方主动找你」。null = 不算（照旧进合并的那封信）。
export async function classifyInbound(conv, { leads = [], outbound = [], pipeline } = {}) {
  if (conv.from_me || !(conv.unread > 0)) return null;
  if (contactedBefore(conv, { leads, outbound })) return null;
  const { company, title } = splitOrg(conv.org);
  const base = { company: company || conv.org || '', recruiter: conv.name, recruiter_title: title };
  const reason = await coarseReason(conv, { pipeline });
  return reason ? { ...base, status: 'ignored', by: 'screen', reason } : { ...base, status: 'unread' };
}

// ── 一个对话一封信（还没读的） ─────────────────────────────────────────────────────────────────
export function bossInboundAsks({ state = read(STATE_PATH, {}) || {} } = {}) {
  return Object.entries(state.conversations || {}).filter(([, e]) => e?.inbound?.status === 'unread').map(([key, e]) => ({
    from: 'watch', id: `boss-inbound:${key}`, type: 'info',
    title: `${e.inbound.company || '一家公司'} 的招聘方主动找你（还没读）`,
    question: `${e.inbound.recruiter || e.shown}：${e.preview || '（新消息）'}`.slice(0, 120),
    context: [], affected: [],
    options: [
      { key: '1', label: '打开 BOSS 聊天', steps: [{ type: 'open', url: CHAT_URL }], primary: true },
      { key: '2', label: '不感兴趣', steps: [{ type: 'boss_chat', action: 'ignore', key }] },
    ],
    other: null,
  }));
}
// 「不感兴趣」：这个对话记为不再看（信收起，以后不提、不点开、不判断）。
export function ignoreBossConversation(key, { now = Date.now() } = {}) {
  const state = read(STATE_PATH, {}) || {};
  const e = state.conversations?.[key];
  if (!e) throw Error('这个对话已经不在了');
  e.inbound = { ...(e.inbound || {}), status: 'ignored', by: 'user', at: new Date(now).toISOString() };
  write(STATE_PATH, { ...state, unlinked: (state.unlinked || []).filter(u => u.key !== key) });
  return '好，这个对话不再提醒';
}

// ── 第二段：读过之后，只读地看一眼 ──────────────────────────────────────────────────────────────
// 在列表里找到这个对话（名字行归一后相等），**有未读角标就不碰**；没有角标，给它的 .friend-content 做个记号，好让外面点它。
export const PICK = `(spec) => {
  const parse = ${parseChatItem.toString()};
  const norm = s => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\\s·|｜\\/,，]+/g, '');
  if (spec.outUrl && String(location.pathname || '').includes(spec.outUrl)) return { logged_out: true };
  for (const el of Array.from(document.querySelectorAll('[data-radar-open]'))) el.removeAttribute('data-radar-open');
  const lis = Array.from(document.querySelectorAll('.user-list li'));
  for (const li of lis) {
    const badge = li.querySelector('.notice-badge');
    const box = li.querySelector('.name-box');
    const names = box ? Array.from(box.children).map(e => e.innerText) : [];
    const it = parse({ text: String(li.innerText || '').slice(0, 600), badge: badge ? badge.innerText : '', names });
    if (!it || norm(it.shown) !== spec.target) continue;
    if (badge || it.unread) return { found: true, unread: true };
    const fc = li.querySelector('.friend-content');
    if (!fc) return { found: true, unread: false, clickable: false };
    fc.setAttribute('data-radar-open', spec.mark);
    return { found: true, unread: false, clickable: true };
  }
  return { found: false, count: lis.length };
}`;
// 对话里：岗位卡片（职位名、薪资），第一句是谁说的（item-friend 对方 / item-myself 你），对方第一句的字。输入框不碰。
export const PANE = `() => {
  const t = el => String(el && el.innerText || '').replace(/\\s+/g, ' ').trim();
  const card = document.querySelector('.chat-position-content .position-content');
  const msgs = Array.from(document.querySelectorAll('.message-item'));
  const first = msgs.find(m => m.classList.contains('item-friend') || m.classList.contains('item-myself'));
  const firstFriend = msgs.find(m => m.classList.contains('item-friend'));
  return { card: !!card, title: t(card && card.querySelector('.position-name')).slice(0, 120), salary: t(card && card.querySelector('.salary')).slice(0, 40),
    first: first ? (first.classList.contains('item-friend') ? 'friend' : 'me') : null, first_text: t(firstFriend).slice(0, 200), messages: msgs.length };
}`;
// 岗位页（新标签页）：只读字。选择器没在真页面上核过，取不到就退回整页文字。
export const JOB = `() => {
  const t = s => { const el = document.querySelector(s); return String(el && el.innerText || '').trim(); };
  const first = list => { for (const s of list) { const v = t(s); if (v) return v; } return ''; };
  const jd = first(['.job-detail-section .job-sec-text', '.job-sec-text', '.job-detail .text', '.job-sec']);
  return {
    title: first(['.job-banner .name h1', '.info-primary .name h1', '.job-title', 'h1']).split(/\\n/)[0].slice(0, 120),
    salary: first(['.job-banner .salary', '.info-primary .salary', '.salary']).slice(0, 40),
    company: first(['.sider-company .company-info a[ka*="company"]', '.sider-company .company-info', '.company-info .name', '.job-sec.company-info .name']).split(/\\n/).map(s => s.trim()).filter(Boolean)[0] || '',
    location: first(['.location-address', '.job-location .location-address', '.text-city']).slice(0, 80),
    jd: (jd || String(document.body && document.body.innerText || '')).slice(0, 20000),
  };
}`;

// 岗位卡片点哪儿（10-01 02:3x 真页面只读核对）：对方主动打招呼的对话里，外层 .position-content 不可点（cursor: auto，
// 点了没反应）；可点的是里面的 .left-content（职位名、薪资、城市，cursor: pointer），点它岗位页在新标签页打开。
// 在页面里按顺序挑第一个在的：.left-content → .position-name → 外层卡片。
export const CARD_CLICK = ['.chat-position-content .left-content', '.chat-position-content .position-name', '.chat-position-content .position-content'];
export const CARD_PICK = `(list) => { for (const s of list) { const el = document.querySelector(s); if (el && (!el.getClientRects || el.getClientRects().length)) return s; } return null; }`;
// 新标签页怎么拿到：先等 popup 事件（点之前挂上），没等到就看点击回执里的 popups（ego-browser 文档里的两种写法，
// 仓库里别的脚本没用过——真跑前请核一眼）。
const JOB_TAB = `async (task, page, selector) => {
  const popup = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null); // 兜底：没等到 popup 事件就看点击回执里的 popups（下面）
  const receipt = await page.click(selector, { label: "看这个岗位（只读）" });
  let job = await popup;
  if (!job && receipt && receipt.popups && receipt.popups[0]) { try { job = task.page(receipt.popups[0].label); } catch {} } // 兜底：回执里那一页已经关了，下面按没打开处理
  return job;
}`;

export function conversationScript({ brand = 'OfferCrew', shown, probe = {} } = {}) {
  const mark = hash(['open', shown]).slice(0, 10);
  const spec = { target: norm(shown).replace(/[/,，]+/g, ''), mark, outUrl: probe.logged_out_url || null };
  return `const task = await taskSpace(${JSON.stringify(`${brand} · 看 BOSS 对话`)});
const page = task.page("p1");
const jobTab = ${JOB_TAB};
let navError = null, out = { opened: false };
await page.goto(${JSON.stringify(CHAT_URL)}, { timeout: 40000 }).catch(e => { navError = String(e && e.message || e).slice(0, 120); });
await page.waitForTimeout(5000);
try {
  const pick = await page.evaluate("(" + ${JSON.stringify(PICK)} + ")(" + ${JSON.stringify(JSON.stringify(spec))} + ")");
  out = { ...out, ...(pick || {}) };
  if (pick && pick.clickable && !pick.unread) {
    await page.click(${JSON.stringify(`[data-radar-open="${mark}"]`)}, { label: "打开这个对话（只读）" });
    out.opened = true;
    await page.waitForTimeout(3000);
    const pane = await page.evaluate("(" + ${JSON.stringify(PANE)} + ")()");
    out.pane = pane;
    if (pane && pane.card && pane.first === "friend") {
      const target = await page.evaluate("(" + ${JSON.stringify(CARD_PICK)} + ")(" + ${JSON.stringify(JSON.stringify(CARD_CLICK))} + ")");
      const job = target ? await jobTab(task, page, target) : null;
      if (job) {
        await job.waitForLoadState().catch(() => {}); // 兜底：页面一直在加载也接着读，超时不算错
        await job.waitForTimeout(3000);
        out.job = { ...(await job.evaluate("(" + ${JSON.stringify(JOB)} + ")()")), url: await job.url() };
      } else out.job = { error: "no_job_tab" };
    }
  }
} catch (e) { out.error = String(e && e.message || e).slice(0, 120); }
await task.finish({ keep: [] }).catch(() => {}); // 兜底：收尾关不掉不影响已经读到的内容
radarResult({ ...out, navError });`;
}

export const JOB_URL = /^https:\/\/www\.zhipin\.com\/job_detail\/[^/?#]+\.html(?:[?#].*)?$/;
// 跑脚本，只留要用的字段。
export async function readConversation({ run, conv, brand = BRAND, probe = {} } = {}) {
  const r = await run(conversationScript({ brand, shown: conv.shown, probe }), { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }) || {};
  const s = (v, n) => clean(v).slice(0, n);
  const pane = r.pane && typeof r.pane === 'object' ? { card: r.pane.card === true, title: s(r.pane.title, 120), salary: s(r.pane.salary, 40), first: ['friend', 'me'].includes(r.pane.first) ? r.pane.first : null, first_text: s(r.pane.first_text, 200) } : null;
  const job = r.job && typeof r.job === 'object' ? (r.job.error ? { error: s(r.job.error, 60) } : { url: String(r.job.url || '').slice(0, 300), title: s(r.job.title, 120), salary: s(r.job.salary, 40), company: s(r.job.company, 80), location: s(r.job.location, 80), jd: String(r.job.jd || '').replace(/[ \t]+\n/g, '\n').trim().slice(0, 20000) }) : null;
  return { logged_out: r.logged_out === true, found: r.found === true, unread: r.unread === true, opened: r.opened === true, pane, job, error: r.error ? s(r.error, 120) : r.navError && !r.found ? s(r.navError, 120) : null };
}

// 读到的 → 一条线索（还没判断、没存）。
export function inboundLead(conv, entry, got, { at = new Date().toISOString(), evidence = null } = {}) {
  const ib = entry.inbound || {}, job = got.job || {}, pane = got.pane || {};
  const jobId = String(job.url || '').match(/job_detail\/([^/?#.]+)\.html/)?.[1] || null;
  const role = job.title || pane.title || '岗位待核';
  const location = job.location || '';
  return {
    company: job.company || ib.company || splitOrg(conv.org).company || conv.org,
    role, location: location || '未标注', ...(location ? {} : { needs_city_check: true }),
    url: job.url, source: 'boss', source_type: SOURCE_TYPE, tags: [TAG], source_job_id: jobId ? `boss:${jobId}` : `boss-chat:${conv.key}`,
    human: true, author: ib.recruiter || conv.name, author_title: ib.recruiter_title || splitOrg(conv.org).title || null,
    salary: job.salary || pane.salary || null, posted_at: null,
    jd_text: [role, job.salary || pane.salary, location, job.jd].filter(Boolean).join('\n').slice(0, 40000),
    entry_type: 'Boss直聘私信', evidence,
    inbound: { channel: 'boss_chat', conversation: conv.key, recruiter: ib.recruiter || conv.name, org: conv.org, first_message: pane.first_text || conv.preview || '', at },
  };
}

const reasonText = async (l, outcome) => {
  const { plainReason, reasonOf, PREFILTER_WORD } = await import('./workflow.mjs');
  return (outcome === 'prefiltered' ? PREFILTER_WORD[l.prefilter_reason] || plainReason(l.prefilter_reason, 60) : reasonOf(l)) || '和你的方向对不上';
};
// 合适：Judge 没有排除（推荐或待核，和雷达的岗位一样进池）。缺 JD 的也进池，照雷达的规矩等 JD。
export const fitOutcome = r => r.outcome === 'needs_jd' || (r.outcome === 'matched' && r.verdict !== 'exclude');

// 把一个读过的对话走完：看一眼 → 判断 → 进池 / 不再看。返回这一条的结果（给日志和测试）。调用方不持锁。
export async function confirmInbound({ run, conv, now = Date.now(), probe = {}, judgeFn = null, facts = undefined } = {}) {
  const at = new Date(now).toISOString();
  const cur = (read(STATE_PATH, {}) || {}).conversations?.[conv.key];
  if (!cur?.inbound || !['to_read', 'judging'].includes(cur.inbound.status)) return { status: 'skipped' };
  let ib = { ...cur.inbound };
  if (ib.status === 'to_read') {
    let got;
    try { got = await readConversation({ run, conv, probe }); } catch (e) { got = { error: String(e.message || e).slice(0, 120) }; }
    if (got.logged_out) return { status: 'logged_out' };
    if (got.unread) return await save(conv.key, { ...ib, checked_at: at }, { status: 'unread_again' });
    if (got.pane && got.pane.first === 'me') {
      return await save(conv.key, { ...ib, status: 'not_inbound', at, checked_at: at }, { status: 'not_inbound' });
    }
    const ok = got.pane?.first === 'friend' && got.job && !got.job.error && JOB_URL.test(got.job.url || '');
    if (!ok) {
      const attempts = (ib.attempts || 0) + 1, why = got.error || got.job?.error || (!got.found ? 'not_found' : !got.pane?.card ? 'no_job_card' : got.job ? 'job_url_unexpected' : 'not_read');
      if (attempts >= MAX_ATTEMPTS) event('owl', 'boss-inbound', 'skip', `BOSS 对话「${conv.shown}」读了 ${attempts} 次没读成，不再试（${why}）`);
      return await save(conv.key, { ...ib, attempts, last_error: why, checked_at: at, ...(attempts >= MAX_ATTEMPTS ? { status: 'unreadable' } : {}) }, { status: attempts >= MAX_ATTEMPTS ? 'unreadable' : 'retry', reason: why });
    }
    const evidence = `runs/${today()}/boss-inbound/${conv.key}-${at.replace(/[:.]/g, '-')}.json`;
    fs.mkdirSync(file(`runs/${today()}/boss-inbound`), { recursive: true });
    fs.writeFileSync(file(evidence), JSON.stringify({ at, chat: CHAT_URL, conversation: conv.shown, pane: got.pane, job: got.job }, null, 2));
    const { jd, ...job } = got.job;
    ib = { ...ib, status: 'judging', read_at: at, evidence, pane: got.pane, job };
    await save(conv.key, ib);
  }
  // 池里已经有这个岗位（雷达先扫到了）：不重判，留着它原来的来源和判断，只记上「对方主动找你」。
  const already = await tagExisting(conv, ib, { at });
  if (already) return already;
  // 判断（先判后存）。Judge 不可用 / 今天花费到上限：留着下一轮再判，不重开对话。
  const { judgeAvailable, judgeOffline } = await import('./judge.mjs');
  if (!judgeFn && !judgeAvailable({ offlineOk: true })) return { status: 'waiting_judge' };
  const { budgetGate } = await import('./spend.mjs');
  if (!judgeFn && !judgeOffline() && budgetGate('judge', { quiet: true, now })) return { status: 'waiting_judge' };
  const { identity } = await import('./dedupe.mjs');
  // JD 只存在证据文件里（state/boss-inbox.json 不背几万字）。
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file(ib.evidence), 'utf8')); } catch (e) { noteSwallowed('boss-inbound.evidence', e, { member: 'scout', doing: '读这条 BOSS 来信存下的岗位正文', then: '按没有 JD 正文接着判断' }); }
  const got = { pane: ib.pane, job: { ...ib.job, jd: saved?.job?.jd || '' } };
  const lead = inboundLead(conv, { ...cur, inbound: ib }, got, { at, evidence: ib.evidence });
  lead.id = identity(lead);
  let r;
  try {
    if (judgeFn) r = await judgeFn(lead, { facts, at });
    else { const { judgeLead } = await import('./judge-leads.mjs'); const { loadFacts } = await import('./judgements.mjs'); r = await judgeLead(lead, { facts: facts ?? loadFacts(), at }); }
  } catch (e) { return { status: 'waiting_judge', reason: String(e.message || e).slice(0, 120) }; }
  if (!fitOutcome(r)) {
    const why = await reasonText(lead, r.outcome);
    event('lens', 'boss-inbound', 'ok', `Judge 判断不太合适：${why}（${lead.company} · ${lead.role}，BOSS 上对方主动找你的）`);
    return await save(conv.key, { ...ib, status: 'ignored', by: 'judge', reason: why, at }, { status: 'unfit', reason: why });
  }
  const { mergeLeads } = await import('./dedupe.mjs');
  const { numberRecommended } = await import('./judge-leads.mjs');
  const leads = lines('state/leads.ndjson');
  const merged = mergeLeads(leads, [lead]);
  const row = merged.leads.find(l => l.id === (merged.added ? lead.id : findExisting(merged.leads, lead)));
  if (row && merged.added) numberRecommended(row, merged.leads, { at });
  if (row && !merged.added) markInbound(row, lead.inbound);
  writeLines('state/leads.ndjson', merged.leads);
  (await import('./recommend-sweep.mjs')).sweepRecommendations({ now, ...(facts ? { facts } : {}) });
  const rid = row ? row.record_id || row.id : null;
  event('lens', 'boss-inbound', 'ok', `${merged.added ? '放进岗位池' : '岗位池里已有'}：${lead.company} · ${lead.role}（BOSS 上对方主动找你的，Judge ${r.verdict === 'recommend' ? '推荐' : '待核'}）`);
  await save(conv.key, { ...ib, status: 'lead', record_id: rid, at });
  return { status: merged.added ? 'lead' : 'merged', record_id: rid, verdict: r.verdict || null };
}
const markInbound = (row, inbound) => { row.tags = [...new Set([...(Array.isArray(row.tags) ? row.tags : []), TAG])]; row.inbound = { ...inbound, existing: true }; };
async function tagExisting(conv, ib, { at }) {
  if (!JOB_URL.test(ib.job?.url || '')) return null;
  const leads = lines('state/leads.ndjson');
  const row = leads.find(l => l.id === findExisting(leads, { url: ib.job.url }));
  if (!row) return null;
  markInbound(row, { channel: 'boss_chat', conversation: conv.key, recruiter: ib.recruiter || conv.name, org: conv.org, first_message: ib.pane?.first_text || conv.preview || '', at });
  writeLines('state/leads.ndjson', leads);
  event('lens', 'boss-inbound', 'ok', `岗位池里已有：${row.company} · ${row.role}（BOSS 上对方主动找你的，记上了）`);
  await save(conv.key, { ...ib, status: 'lead', record_id: row.record_id || row.id, at });
  return { status: 'merged', record_id: row.record_id || row.id };
}
function findExisting(leads, lead) {
  const id = String(lead.url || '').match(/job_detail\/([^/?#.]+)\.html/)?.[1];
  const hit = (lead.id && leads.find(l => l.id === lead.id)) || (id && leads.find(l => !l.superseded && String(l.url || l.source_url || '').includes(`/job_detail/${id}.html`)));
  return hit?.id || null;
}
// 记回 state/boss-inbox.json（持 state 锁；同一进程里已持锁时直接写）。
async function save(key, inbound, ret) {
  const state = read(STATE_PATH, {}) || {};
  const e = state.conversations?.[key];
  if (e) { e.inbound = inbound; write(STATE_PATH, state); }
  return ret;
}
