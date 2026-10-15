import { sourceActive, discoveryAllows } from '../lib/discovery-policy.mjs';
import { previousContact } from '../lib/recipient-contact.mjs';
// Find someone who can refer the candidate into each company worth applying to.
//
// Three places, in the order they convert: people who published a 内推 offer
// for the company (脉脉 / 小红书 / LinkedIn posts, and the human posts already in
// state/leads.ndjson); alumni and former colleagues who work there; the
// recruiter or manager who posted the opening. Jev reads each candidate post
// and answers the narrow questions (offers a referral? works there? still
// open? which line is the contact?); code keeps the people, the search
// receipts and the outreach drafts. The ATS form for a company waits until
// this search has run (lib/referrers.mjs).
//
//   node bin/find-referrers.mjs                # companies with kept leads, browser when a session exists
//   node bin/find-referrers.mjs --no-browser   # local sources only
//   node bin/find-referrers.mjs --company 字节跳动
import { BRAND } from '../lib/brand.mjs';
import { lines, patchLines, read, write, arg, log, today, hash, root, deadlineNear } from '../lib/store.mjs';
import { event } from '../lib/events.mjs';
import { judgeAvailable, judgeMany } from '../lib/judge.mjs';
import { readPerson, loadFacts } from '../lib/judgements.mjs';
import { runBrowserScript } from '../lib/browser-run.mjs';
import { EXTRACTORS, normalizeMaimaiPost, MAIMAI_PAGE_STATE } from '../lib/human-browser-extractors.mjs';
import { parsePostedAt, sessionReady } from '../lib/human-browser.mjs';
import { byPriority } from '../lib/matcher.mjs';
import { budgetGate } from '../lib/spend.mjs';
import { loadReferrers, loadSearches, searchFor, searchFresh, recordSearch, upsertReferrer, referrersFor, referralDraft, normalizeCompany, sameCompany, MAX_PER_COMPANY, CONTACT_COOLDOWN_DAYS } from '../lib/referrers.mjs';
import { endedLead } from '../lib/lead-state.mjs';

if (!judgeAvailable({ textOk: true })) { console.log(JSON.stringify(log('find-referrers', { status: 'no_change', reason: 'judge_unavailable' }))); process.exit(0); }
// 今天的花费上限到了（lib/spend.mjs）：不开新的查找，留到明天。
if (budgetGate('referrers')) { console.log(JSON.stringify(log('find-referrers', { status: 'no_change', reason: 'spend_cap' }))); process.exit(0); }
const now = Date.now(), date = today();
const noBrowser = process.argv.includes('--no-browser') || process.env.RADAR_EXTERNAL_POLICY === 'base-and-cards';
const only = arg('--company', '');
const limit = Math.max(1, Number(arg('--limit', 6)));
const dir = `runs/${date}/referrers`;
const facts = loadFacts();
const leads = lines('state/leads.ndjson');
const sessions = read('config/portal-sessions.json', { domains: {} });
const searches = loadSearches();

// The sites searched for 「<公司> 内推」, in the order they convert.
const SEARCHES = (company) => [
  { name: 'maimai', domain: 'maimai.cn', url: `https://maimai.cn/web/search_center?type=feed&query=${encodeURIComponent(company + ' 内推')}&highlight=true` },
  { name: 'xiaohongshu', domain: 'www.xiaohongshu.com', url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(company + ' 内推')}` },
  { name: 'linkedin', domain: 'www.linkedin.com', url: `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(company + ' 内推')}&sortBy=%22date_posted%22` },
];

// Companies with a lead the judgement kept and the user has not ruled out.
// The best lead per company carries the draft.
const byCompany = new Map();
for (const l of leads) {
  if (!discoveryAllows(l)) continue;
  if (l.superseded || l.legacy || endedLead(l)) continue;
  if (!['recommend', 'verify'].includes(l.match?.verdict) || !l.number) continue;
  if (only && l.company !== only) continue;
  const key = normalizeCompany(l.company);
  if (!key || /^待核/.test(String(l.company))) continue;
  const cur = byCompany.get(key);
  if (!cur) byCompany.set(key, { key, company: l.company, lead: l, leads: [l] });
  else { cur.leads.push(l); if ((l.match?.score || 0) > (cur.lead.match?.score || 0)) cur.lead = l; }
}
// When a company is searched again. A fresh search used to hold it for the whole
// TTL, so once every kept company had been searched (mostly from local posts
// only, while no browser session existed) each run searched nothing. Now a
// company is also due when a posting arrived after its last search (a new
// opening can have a new poster), or when that search never reached a site and
// a browser session exists now. Hangzhou and people's posts first.
const DAY = 86400000;
const browserReady = !noBrowser && SEARCHES('x').some((site) => sourceActive(site.name) && sessionReady({ requires_session: true, domain: site.domain }, sessions));
function due(t) {
  if (only) return 'requested';
  const s = searchFor(t.company, searches);
  if (!searchFresh(s, now)) return s ? 'stale' : 'never';
  const at = Date.parse(s.searched_at), age = now - at;
  if (age >= 2 * DAY && t.leads.some((l) => Date.parse(l.discovered_at || l.imported_at || '') > at)) return 'new_lead';
  if (browserReady && age >= DAY && !(s.sources || []).some((x) => x !== 'local')) return 'local_only';
  return null;
}
const DUE_RANK = { requested: 0, never: 1, stale: 2, local_only: 3, new_lead: 4 };
const targets = [...byCompany.values()].map((t) => ({ ...t, due: due(t) })).filter((t) => t.due)
  .sort((a, b) => DUE_RANK[a.due] - DUE_RANK[b.due] || byPriority(a.lead, b.lead)).slice(0, limit);
const dueCounts = targets.reduce((m, t) => ({ ...m, [t.due]: (m[t.due] || 0) + 1 }), {});
if (process.argv.includes('--dry-targets')) {
  console.log(JSON.stringify({ status: 'dry_run', kept_companies: byCompany.size, browser_ready: browserReady, targets: targets.map((t) => ({ company: t.company, due: t.due, lead: t.lead.number })) }));
  process.exit(0);
}

// --- Source 1: human posts already discovered, by any pipeline.
function localPosts(company) {
  return leads.filter((l) => /真人|内推|Boss|HR直发/.test(l.source_type || '') && l.author && (sameCompany(l.company, company) || new RegExp(normalizeCompany(company).slice(0, 6).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(String(l.jd_text || l.text || ''))))
    .map((l) => ({ id: l.id, source: l.source || l.source_type, author: l.author, author_title: l.author_title || '', body: l.original_body || l.text || l.jd_text || '', url: l.url, contact_url: l.contact_profile_url || l.profile_url || l.author_url || null, email: l.email || null, posted_at: l.posted_at, lead_number: l.number }));
}

// --- Source 2: a search on each site the user is signed into, for
// 「<公司> 内推」. Same extractors and session discipline as discovery.
const call = (script, timeout = 120000) => runBrowserScript(script, { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 });
let browserSpace = null, browserBlocked = false;
// A login wall ends that site for the rest of the run, not the other sites:
// the next company would only land on the same wall again.
const walled = new Map();
async function searchSite(site, company) {
  if (!sourceActive(site.name)) return {posts:[],skipped:'disabled_by_configuration'};
  if (walled.has(site.name)) return { posts: [], skipped: walled.get(site.name) };
  if (browserBlocked || !sessionReady({ requires_session: true, domain: site.domain }, sessions)) return { posts: [], skipped: 'no_session' };
  const maimai = site.name === 'maimai';
  const script = `
const task = await taskSpace(${JSON.stringify(browserSpace ?? `${BRAND} referrer search`)});
const page = task.page("p1");
await page.goto(${JSON.stringify(site.url)}, {waitUntil:"domcontentloaded", timeout:30000});
await page.waitForLoadState("networkidle", {timeout:15000}).catch(() => {}); // 兜底：页面一直有网络请求也接着读，超时不算错
await page.waitForTimeout(2500);
${maimai ? `const state = await page.evaluate(${MAIMAI_PAGE_STATE});
// The Maimai extractor clicks each row and waits; five rows per evaluation
// stays under the browser's 15 s evaluation cap.
const rows = [];
if (!state.status) for (let offset = 0; offset < 10; offset += 5) { const chunk = await page.evaluate(${EXTRACTORS.maimai}, { offset, limit: 5 }); rows.push(...chunk); if (chunk.length < 5) break; }
radarResult({ space: task.spaceId, url: await page.url(), rows, status: state.status });` : `const rows = await page.evaluate(${EXTRACTORS[site.name]});
radarResult({ space: task.spaceId, url: await page.url(), rows });`}`;
  let page;
  try { page = await call(script); } catch (e) { return { posts: [], skipped: 'browser_error:' + String(e.message).slice(0, 80) }; }
  browserSpace = page.space;
  write(`${dir}/${hash([company, site.name]).slice(0, 16)}.json`, page);
  const status = page.status || (/\/(?:login|signin|sign-?in|authwall|web\/user\/safe)\b/i.test(String(page.url || '')) ? 'session_expired' : null);
  if (status) { if (status === 'captcha') browserBlocked = true; else walled.set(site.name, status); return { posts: [], skipped: status }; }
  const rows = (page.rows || []).map((row) => maimai ? normalizeMaimaiPost(row, now) : { ...row, posted_at: row.posted_at || parsePostedAt(row.posted_label, now) });
  return { posts: rows.filter((p) => p.author && p.body).slice(0, 10).map((p) => ({ id: p.id, source: site.name, author: p.author, author_title: p.author_title || '', body: p.body, url: p.url, contact_url: p.profile_url || p.author_url || p.url || null, email: null, posted_at: p.posted_at })) };
}

let companiesSearched = 0, peopleFound = 0, draftsMade = 0, deferred = 0;
const errors = [], skippedSites = {};
for (const t of targets) {
  // 到了周期给的收尾点：剩下的公司不搜，也不记搜索，下一轮仍然到期。一家最多三个站点，留足三分钟。
  if (deadlineNear(180000)) { deferred = targets.length - companiesSearched; break; }
  const posts = localPosts(t.company);
  const sources = ['local'];
  if (!noBrowser) for (const site of SEARCHES(t.company)) {
    const r = await searchSite(site, t.company);
    if (r.skipped) { skippedSites[site.name] = r.skipped; continue; }
    sources.push(site.name);
    posts.push(...r.posts);
  }
  // Fresh posts only, one per author, at most twelve per company for the model.
  const seen = new Set();
  const fresh = posts.filter((p) => !p.posted_at || now - Date.parse(p.posted_at) < 60 * 86400000).filter((p) => { const k = `${p.source}|${p.author}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  const judged = await judgeMany(fresh, (p) => readPerson(p, { company: t.company, facts, request_id: `person-${hash([t.key, p.source, p.id]).slice(0, 20)}` }), { concurrency: 4 });
  let found = 0;
  // The user's outreach order (2026-09-19): headhunter first, then in-house
  // HR, then the recruiter or hiring manager, then employees (alumni and
  // former colleagues ahead of strangers). Rank first, then take the top few.
  const RANK = { headhunter: 0, hr: 1, recruiter: 2, referral_post: 3, alumni: 4, former_colleague: 5, team_member: 6 };
  const ranked = judged.map((r, i) => ({ r, p: fresh[i] })).filter(({ r }) => r.ok || (errors.push({ company: t.company, error: r.error }), false)).map(({ r, p }) => {
    const j = r.value;
    const relationship = j.is_headhunter ? 'headhunter' : j.is_hr ? 'hr' : j.is_recruiter_or_hiring_manager ? 'recruiter' : j.offers_referral ? 'referral_post' : j.shared_background === 'same_school' ? 'alumni' : j.shared_background === 'same_former_employer' ? 'former_colleague' : j.works_at_company ? 'team_member' : null;
    return { p, j, relationship };
  }).filter(({ j, relationship }) => relationship && j.is_individual && !j.is_seeking && j.still_open !== false && (j.offers_referral || j.works_at_company || j.is_recruiter_or_hiring_manager || j.is_headhunter || j.is_hr))
    .sort((a, b) => RANK[a.relationship] - RANK[b.relationship]);
  for (const { p, j, relationship } of ranked) {
    const existing = referrersFor(t.company).filter((x) => ['found', 'drafted', 'contacted'].includes(x.status) && (!x.contacted_at || now - Date.parse(x.contacted_at) < CONTACT_COOLDOWN_DAYS * 86400000));
    if (existing.length + found >= MAX_PER_COMPANY) break;
    const person = upsertReferrer({ company: t.company, author: p.author, author_title: p.author_title, relationship, source: p.source, post_url: p.url, contact_url: p.contact_url, email: j.email || p.email || null, contact_line: j.contact_line, evidence: `${dir}/${hash([t.company, p.source, p.id]).slice(0, 16)}.json`, judgement: { offers_referral: j.offers_referral, works_at_company: j.works_at_company, recruiter: j.is_recruiter_or_hiring_manager, headhunter: j.is_headhunter, hr: j.is_hr, shared: j.shared_background }, lead_number: t.lead.number }, { now });
    write(person.evidence, { post: p, judgement: j });
    found++; peopleFound++;
    // One reviewable draft per person; the user releases it with 「发 编号」.
    // 搜一家要几分钟：草稿按当场重读的那份查重、当场写下（lib/store.mjs patchLines），不攒到最后拿开头读的那份整份写回。
    if (person.status !== 'found') continue;
    let made = null;
    patchLines('state/drafts.ndjson', (drafts) => {
      if (drafts.some((d) => d.referrer_id === person.id && d.status !== 'cancelled')) return false;
      const d = referralDraft(person, t.lead, facts, { now });
      if (!d || previousContact(d, drafts) || !(d.to || d.channel === 'email')) return false;
      drafts.push(d); made = d;
    });
    if (made) { draftsMade++; upsertReferrer({ ...person, id: person.id, status: 'drafted', draft_id: made.draft_id }); }
  }
  // 识别失败不等于查完了；保留已找到的人，其余候选下一轮还要重试。
  if (judged.every(r => r.ok)) recordSearch(t.company, { found, sources, now });
  companiesSearched++;
}
event('reacher', 'referrers', peopleFound ? 'ok' : 'skip', `内推人发现：查 ${companiesSearched} 家，找到 ${peopleFound} 人，草稿 ${draftsMade} 封`);
console.log(JSON.stringify(log('find-referrers', { status: peopleFound || draftsMade ? 'changed' : 'no_change', companies: companiesSearched, due: dueCounts, pending: byCompany.size - targets.length + new Set(errors.map(e => e.company)).size + deferred, ...(deferred ? { deferred } : {}), people: peopleFound, drafts: draftsMade, skipped_sites: skippedSites, errors: errors.slice(0, 5) })));
