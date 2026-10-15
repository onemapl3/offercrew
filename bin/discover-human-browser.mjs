import { sourceState, discoveryAllows, discoveryInstructions, excludedCompany } from '../lib/discovery-policy.mjs';
// Browser-driven discovery of posts a real recruiter wrote.
//
// Applying en masse to ATS listings converts badly, so the daily round leads
// with people: LinkedIn posts, Boss 直聘 HR who post their own openings, and
// 脉脉 / 小红书 when a session exists. Public boards stay in
// bin/discover-human.mjs; this one needs the user's logged-in browser.
//
// Each source respects the configured scan interval. A source whose session is missing is
// skipped and reported, never scraped half-way behind a login wall.
import { runBrowserScript } from '../lib/browser-run.mjs';
import { BRAND } from '../lib/brand.mjs';
import { lines, read, write, writeLines, patch, log, hash, today, root, arg } from '../lib/store.mjs';
import { mergeLeads, maimaiPostKey, maimaiPostKeys } from '../lib/dedupe.mjs';
import { prefilter } from '../lib/matcher.mjs';
import { BROWSER_SOURCES, sessionReady, classifyPost, summarizeRejections, parsePostedAt, pickPostedAt, linkedinPostDate, detailNavigable, detailBreaker, platformDraft, maimaiDetailEligible, clusterMaimaiLeads } from '../lib/human-browser.mjs';
import { EXTRACTORS, LINKEDIN_PAGE_STATE, XIAOHONGSHU_DETAIL, normalizeMaimaiPost, parseMaimaiDetail, MAIMAI_PAGE_STATE, MAIMAI_SORT_BY_TIME } from '../lib/human-browser-extractors.mjs';
import { loadFacts } from '../lib/application-form.mjs';
import { readLinkedinPosts, linkedinPostUrl } from '../lib/linkedin-browser.mjs';
import { errorEvidence } from '../lib/error-evidence.mjs';
import { AWAITING_JUDGEMENT, siteOnlyStop, browserScanComplete } from '../lib/human-browser.mjs';
import { sourceFailureReceipt } from '../lib/browser-source-receipt.mjs';
import { collectSearch, advanceSearchResults, searchResultsFingerprint } from '../lib/browser-discovery-depth.mjs';

if (process.env.RADAR_EXTERNAL_POLICY === 'base-and-cards') {
  console.log(JSON.stringify(log('discover-human-browser', {status:'needs_host_connector', next_actions:[{type:'browser_discovery', operation:'inspect_logged_in_sources', instructions:discoveryInstructions()+' Use one authorised browser task space, preserve source dates, stop on login/captcha/user-control boundaries, and save actual read evidence. No messages or applications are authorised by this read task.'}]})));
  process.exit(0);
}
const now = Date.now(), date = today();
const only = arg('--source');
const force = process.argv.includes('--force');
const dir = `runs/${date}/human-discovery`;
const index = read('state/human-browser-index.json', {});
const sessions = read('config/portal-sessions.json', { domains: {} });

const call = (script, timeout = 180000) => runBrowserScript(script, { cwd: root, timeout: Math.floor(timeout), maxBuffer: 32 * 1024 * 1024 });
let browserSpace=arg('--space') ? Number(arg('--space')) : null;
let browserControlStopped=false;
let browserBlocked=false;

// Give the remaining enabled sources a share of the stage wall-clock budget.
// Search and detail no longer compete for a fixed page count. Leave time to
// verify promising snippets, then report unfinished coverage instead of done.
const scanDeadline = Math.min(Date.parse(process.env.RADAR_MATCH_DEADLINE || '') || Infinity, now + 28 * 60000);
let sourceDeadline = scanDeadline;
const stored = lines('state/leads.ndjson');
const knownPosts = new Set(stored.flatMap(l => [l.source_job_id, ...maimaiPostKeys(l).map(k => 'maimai:' + k.split(':').at(-1))]).filter(Boolean));
const postKey = (post, source) => `${source.name}:${post.id || hash([post.url, post.author, post.body])}`;
const yielded = new Set();
function usefulCard(post, source) {
  const id = postKey(post, source);
  if (yielded.has(id)) return false;
  yielded.add(id);
  if (source.name === 'maimai') return maimaiDetailEligible(post, { now });
  if (source.name === 'xiaohongshu') {
    const at = Date.parse(post.posted_at || parsePostedAt(post.posted_label, now));
    return detailNavigable(post.url, source) && (!Number.isFinite(at) || at <= now && now - at <= 30 * 86400000)
      && !excludedCompany({ company: post.company || post.title }) && /招聘|内推|招人|岗位|hiring/i.test(post.title + '\n' + post.body);
  }
  const dated = source.name === 'linkedin' ? { ...post, ...linkedinPostDate(post, now) } : post;
  const lead = classifyPost(dated, source, { now }).lead;
  return !!lead && discoveryAllows(lead) && (!prefilter(lead) || prefilter(lead) === 'china_remote_unverified');
}
async function scrape(source) {
  const posts = [], coverage = [];
  let page_loads = 0;
  const searches = source.searches;
  const searchDeadline = Date.now() + (sourceDeadline - Date.now()) * (['maimai', 'xiaohongshu'].includes(source.name) ? 0.55 : 1);
  for (let query = 0; query < searches.length; query++) {
    const url = searches[query], maimai = source.name === 'maimai';
    const deadline = Date.now() + Math.max(0, searchDeadline - Date.now()) / (searches.length - query);
    let initial = true, offset = 0, count = 0;
    const guard = maimai ? MAIMAI_PAGE_STATE : source.name === 'linkedin' ? LINKEDIN_PAGE_STATE : '() => ({status:null})';
    const result = await collectSearch({ deadline, known: knownPosts, key: post => postKey(post, source), candidate: post => usefulCard(post, source),
      read: async cursor => {
        const script = `
const task = await taskSpace(${JSON.stringify(browserSpace ?? `${BRAND} source discovery`)});
const page = task.page("p1");
const passDeadline = Date.now() + 120000;
${initial ? `${maimai && page_loads ? 'await page.waitForTimeout(2500);' : ''}
await page.goto(${JSON.stringify(url)}, {waitUntil:"domcontentloaded", timeout:30000});
${source.name === 'linkedin' ? `await page.waitForFunction(() => (${LINKEDIN_PAGE_STATE})().status !== 'linkedin_page_unrecognized', undefined, {timeout:25000}).catch(e => { if (!/Timeout/i.test(e.message)) throw e; });` : 'await page.waitForLoadState("networkidle").catch(() => {});'} // 兜底：持续有网络请求时仍读取当前页面
await page.waitForTimeout(2500);` : ''}
let state = await page.evaluate(${guard});
${initial && maimai ? `if (!state.status) {
  const sorted = await page.evaluate(${MAIMAI_SORT_BY_TIME});
  if (!sorted) state = { status: 'time_sort_missing' };
  else { await page.waitForTimeout(3000); state = await page.evaluate(${guard}); }
}` : ''}
${maimai ? `const rows = [];
let offset = ${cursor?.offset ?? offset}, total = state.status ? 0 : await page.evaluate(() => document.querySelectorAll('li.list-group-item.clearfix, li.list-group-item.cursor-pointer').length);
if (offset >= total) offset = 0; // A virtualized list can replace cards without growing.
const readUntil = Math.min(${deadline}, passDeadline);
if (!state.status) while (offset < total && Date.now() + 12000 < readUntil) {
  const chunk = await page.evaluate(${EXTRACTORS.maimai}, { offset, limit: 5 });
  rows.push(...chunk); offset += chunk.length;
  if (chunk.length < 5) { offset = total; break; }
  state = await page.evaluate(${guard});
  if (state.status) break;
}
radarResult({ space:task.spaceId, url:await page.url(), title:await page.title(), rows, status:state.status, time_sorted:!state.status, card_count:total, cursor: !state.status && offset < total ? {offset} : null });`
: source.name === 'linkedin' ? `const rows = state.status ? [] : await (${readLinkedinPosts.toString()})(page, ${JSON.stringify(EXTRACTORS.linkedin)}, ${linkedinPostUrl.toString()}, {deadline:${deadline}});
radarResult({space:task.spaceId,url:await page.url(),title:await page.title(),rows,status:state.status,page_shape:state.shape||null});`
: `const rows = state.status ? [] : await page.evaluate(${EXTRACTORS[source.name]});
radarResult({space:task.spaceId,url:await page.url(),title:await page.title(),rows,status:state.status});`}`;
        let page;
        try { page = await call(script, Math.max(1000, Math.min(150000, deadline - Date.now() + 5000))); }
        catch (e) {
          if (Date.now() >= deadline && /time.?out|timed out|ETIMEDOUT/i.test(e.message)) return { rows: [], time_budget: true };
          if (/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(e.message)) browserControlStopped = true;
          const error_evidence = `${dir}/${source.name}/failure-${Date.now()}.json`;
          write(error_evidence, errorEvidence(e));
          return { rows: [], blocked: e.message, error_evidence };
        }
        browserSpace = page.space;
        if (initial) page_loads++;
        initial = false; count = page.card_count || 0;
        write(`${dir}/${source.name}/${hash(url).slice(0, 16)}-${coverage.length}-${Date.now()}.json`, page);
        const status = page.status || (/\/(?:login|signin|sign-?in|authwall|web\/user\/safe)\b/i.test(String(page.url || '')) ? 'session_expired' : null);
        return { ...page, blocked: status, rows: (page.rows || []).map(row => maimai ? normalizeMaimaiPost(row, now) : source.name === 'linkedin' ? { ...row, search_url: url } : row) };
      },
      advance: async () => {
        try {
          const next = await call(`const task=await taskSpace(${JSON.stringify(browserSpace)});const page=task.page("p1");
let state=await page.evaluate(${guard});
let next={advanced:false};
if(!state.status){
  const before=await page.evaluate(${searchResultsFingerprint.toString()});
  next=await page.evaluate(${advanceSearchResults.toString()});
  if(next.advanced){await page.waitForTimeout(3000);state=await page.evaluate(${guard});if(!state.status)next.unchanged=before===await page.evaluate(${searchResultsFingerprint.toString()});}
}
radarResult({...next,blocked:state.status||null});`, Math.max(1000, Math.min(20000, deadline - Date.now() + 1000)));
          offset = next.method === 'next' ? 0 : count;
          if (next.method === 'next') page_loads++;
          return next;
        } catch (e) {
          if (Date.now() >= deadline && /time.?out|timed out|ETIMEDOUT/i.test(e.message)) return { advanced: false, time_budget: true };
          if (/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(e.message)) browserControlStopped = true;
          return { advanced: false, blocked: e.message };
        }
      },
    });
    posts.push(...result.posts);
    coverage.push({ url, rounds: result.rounds, posts: result.posts.length, new_candidates: result.candidates, stop_reason: result.stop_reason });
    if (result.blocked) return { posts, page_loads, coverage, blocked: result.blocked, ...(result.page?.page_shape ? { page_shape: result.page.page_shape } : {}), ...(result.page?.error_evidence ? { error_evidence: result.page.error_evidence } : {}) };
  }
  return { posts, page_loads, coverage, search_pending: coverage.filter(q => q.stop_reason === 'time_budget').length, blocked: null };
}

async function fillDatesAndNotes(posts, source) {
  let date_filled = 0, detailAttempts = 0, detail_filled = 0;
  let detailStopped = false, breaker = {};
  const date_errors = [];
  if (source.name === 'linkedin') {
    // Which way each date was read, so the index shows how many are estimates.
    const date_sources = {};
    for (const post of posts) {
      const dated = linkedinPostDate(post, now);
      if (!dated) { date_sources.none = (date_sources.none || 0) + 1; continue; }
      if (dated.posted_at_source !== 'time') date_filled++;
      Object.assign(post, dated);
      date_sources[dated.posted_at_source] = (date_sources[dated.posted_at_source] || 0) + 1;
    }
    return { date_filled, date_errors, date_sources };
  }
  for (const post of posts) {
    if (!post.posted_at && post.posted_label) {
      post.posted_at = parsePostedAt(post.posted_label, now);
      if (post.posted_at) date_filled++;
    }
  }
  if (source.name !== 'xiaohongshu') return { date_filled, date_errors };
  for (const post of posts) {
    // Cheap, conclusive gates precede a detail open; a date alone is never a JD.
    if (excludedCompany({ company: post.company || post.title })) { post.detail_skip_reason = 'excluded_company'; continue; }
    const at = Date.parse(post.posted_at);
    if (Number.isFinite(at) && (at > now || now - at > 30 * 86400000)) {
      post.detail_skip_reason = at > now ? 'future_date' : 'stale_date'; continue;
    }
    if (Date.now() + 50000 >= sourceDeadline || detailStopped || browserControlStopped || browserBlocked) continue;
    // A malformed card URL must not navigate the browser away from the source.
    if (!detailNavigable(post.url, source)) continue;
    detailAttempts++;
    const evidence = `${dir}/${source.name}/detail-${hash([post.id, post.url]).slice(0, 20)}.json`;
    let detail;
    try {
      detail = await call(`
const task = await taskSpace(${JSON.stringify(browserSpace)});
const page = task.page("p1");
await page.goto(${JSON.stringify(post.url)}, {waitUntil:"domcontentloaded", timeout:30000});
await page.waitForFunction(() => document.querySelector('.note-content #detail-desc') || /\\/(?:404|login|signin|authwall)\\b/.test(location.pathname) || /登录后查看更多|扫码登录|安全验证|完成验证/.test(document.body.innerText), undefined, {timeout:15000});
const note = await page.evaluate(${XIAOHONGSHU_DETAIL});
radarResult({ space:task.spaceId, url:await page.url(), ...note });`, 50000);
      if (/\/(?:login|signin|sign-?in|authwall|web\/user\/safe)\b/i.test(String(detail.url || ''))) throw Error('session_expired:' + source.domain);
      if (detail.status) throw Error(detail.status + ':' + source.domain);
      if (!detailNavigable(detail.url, source) || new URL(detail.url).pathname.split('/').filter(Boolean).pop() !== new URL(post.url).pathname.split('/').filter(Boolean).pop()) throw Error('detail_unexpected_url');
      if (!detail.body?.trim()) throw Error('detail_body_missing');
      const labels = detail.labels || [];
      const picked = !post.posted_at && pickPostedAt(labels, now);
      if (picked) {
        Object.assign(post, picked);
        date_filled++;
      }
      Object.assign(post, { title: detail.title || post.title, body: detail.body, detail_evidence: evidence });
      detail_filled++;
      breaker = detailBreaker(breaker, labels.length ? 'labels' : 'empty');
      detailStopped = breaker.stopped;
      if (detailStopped) date_errors.push({ evidence, error: breaker.reason });
      write(evidence, { ...detail, requested_url: post.url, posted_at: post.posted_at || null, status: 'detail_filled',
        ...(detailStopped ? { detail_stopped: true, stop_reason: breaker.reason } : {}) });
    } catch (e) {
      const error = errorEvidence(e).error;
      breaker = detailBreaker(breaker, 'failed');
      // A failed detail never promotes the search snippet into a full JD.
      if (/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(error)) browserControlStopped = true;
      if (/captcha|session_expired/.test(error)) browserBlocked = true;
      detailStopped = breaker.stopped || browserControlStopped || browserBlocked;
      const stop = detailStopped ? { detail_stopped: true, stop_reason: breaker.reason || error } : {};
      date_errors.push({ evidence, error, ...stop });
      write(evidence, { ...detail, requested_url: post.url, status: 'failed', ...errorEvidence(e), ...stop });
      if (/session_expired/.test(error) && sessions.domains?.[source.domain]) expire(source.domain);
    }
  }
  return { date_filled, date_errors, detail_opened: detailAttempts, detail_filled,
    detail_pending: posts.filter(p => !p.detail_evidence && !p.detail_skip_reason).length, detail_stopped: detailStopped };
}

async function fillMaimaiDetails(posts) {
  let detail_opened = 0, detail_filled = 0, breaker = {};
  const detail_errors = [], fetched = new Map();
  for (const post of posts) {
    if (!maimaiDetailEligible(post, { now })) continue;
    // Reuse the full body for duplicate cards without spending another open.
    if (fetched.has(post.id)) {
      Object.assign(post, fetched.get(post.id));
      continue;
    }
    if (Date.now() + 45000 >= sourceDeadline || breaker.stopped || browserControlStopped || browserBlocked) continue;
    detail_opened++;
    const evidence = `${dir}/maimai/detail-${hash(post.id).slice(0, 20)}.json`;
    let detail;
    try {
      detail = await call(`
const task = await taskSpace(${JSON.stringify(browserSpace)});
const page = task.page("p1");
await page.goto(${JSON.stringify(post.url)}, {waitUntil:"domcontentloaded", timeout:30000});
await page.waitForLoadState("networkidle").catch(() => {}); // 兜底：页面一直有网络请求也接着读，超时不算错
await page.waitForTimeout(4000);
const state = await page.evaluate(${MAIMAI_PAGE_STATE});
const innerText = state.status ? '' : await page.evaluate(() => document.body.innerText);
radarResult({ space:task.spaceId, url:await page.url(), title:await page.title(), status:state.status, innerText });`, 45000);
      if (detail.status) throw Error(detail.status + ':maimai.cn');
      const landed = new URL(detail.url);
      if (landed.origin !== 'https://maimai.cn' || !(
        (landed.pathname === '/web/feed_detail' && landed.searchParams.get('fid') === String(post.id))
        || landed.pathname === `/community/feed-detail/${post.id}`
      )) throw Error('detail_unexpected_url');
      const parsed = parseMaimaiDetail(detail.innerText, post.author);
      if (!parsed.body) throw Error('detail_body_missing');
      const full = { ...parsed, text: parsed.body, title: parsed.body.split('\n')[0].slice(0, 120), detail_evidence: evidence };
      Object.assign(post, full);
      fetched.set(post.id, full);
      detail_filled++;
      breaker = detailBreaker(breaker, 'labels');
      write(evidence, { ...detail, ...parsed, requested_url: post.url, posted_at: post.posted_at, status: 'detail_filled' });
    } catch (e) {
      const error = errorEvidence(e).error;
      fetched.set(post.id, {});
      breaker = detailBreaker(breaker, 'failed');
      if (/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(error)) browserControlStopped = true;
      if (/session_expired|captcha/.test(error)) browserBlocked = true;
      if (browserControlStopped || browserBlocked) breaker = { ...breaker, stopped: true, reason: error };
      detail_errors.push({ evidence, error });
      write(evidence, { ...detail, requested_url: post.url, status: 'detail_fetch_failed', ...errorEvidence(e),
        detail_stopped: breaker.stopped, stop_reason: breaker.reason });
    }
  }
  return { detail_opened, detail_filled, detail_errors, detail_pending: new Set(posts.filter(p => maimaiDetailEligible(p, { now }) && !p.detail_evidence).map(p => p.id)).size, detail_stopped: !!breaker.stopped, detail_stop_reason: breaker.reason || null };
}

const results = [], incoming = [];
// 这一轮读完的来源、这一轮发现登录过期的网站：一轮要十几分钟，最后在写回前重读的那份上只改这几项（lib/store.mjs patch）。
const ranNow = {}, expired = new Set();
function expire(domain) {
  sessions.domains[domain] = { ...sessions.domains[domain], logged_in: false, verified_at: date, last_probe: 'session_expired' };
  expired.add(domain);
}
const facts = loadFacts();
const selectedSources = BROWSER_SOURCES.filter(s => !only || s.name === only);
for (const source of selectedSources) {
  // 绑定了才开的来源（LinkedIn）没绑定：就是关着，不算被挡住、不催你登录（lib/discovery-policy.mjs sourceState）。
  const state = sourceState(source.name, undefined, sessions);
  if (!state.on) { results.push({source:source.name,status:'paused',reason:state.why === 'not_signed_in' ? 'not_signed_in: 登录以后自动打开' : 'disabled_by_configuration'}); continue; }
  if (!sessionReady(source, sessions)) {
    results.push({ source: source.name, status: 'skipped', reason: 'no_session:' + source.domain, rejections: summarizeRejections([]), date_filled: 0 });
    continue;
  }
  if (!force && index[date]?.[source.name] && browserScanComplete(index[date][source.name]) && now - Date.parse(index[date][source.name].at) < (read('config/pipeline.json', {}).discovery?.browser_interval_hours || 24) * 3600000) {
    results.push({ source: source.name, status: 'done_today', rejections: null, date_filled: 0, ...index[date][source.name] });
    continue;
  }
  try {
    const remaining = selectedSources.slice(selectedSources.indexOf(source)).filter(s => sourceState(s.name, undefined, sessions).on && sessionReady(s, sessions)).length;
    sourceDeadline = Date.now() + Math.max(0, scanDeadline - Date.now()) / Math.max(1, remaining);
    const { posts, page_loads, coverage, search_pending, blocked, page_shape, error_evidence } = await scrape(source);
    // Unseen posts get details before already stored posts, while spare time
    // still refreshes known bodies (including old parser damage).
    posts.sort((a, b) => Number(knownPosts.has(postKey(a, source))) - Number(knownPosts.has(postKey(b, source))));
    browserBlocked = !!blocked;
    const dates = await fillDatesAndNotes(posts, source);
    const details = source.name === 'maimai' ? await fillMaimaiDetails(posts) : {};
    const classifications = [];
    let eligible = 0;
    const prefilter_rejections = {};
    for (const post of posts) {
      const evidence = `${dir}/${source.name}/${hash([post.id, post.url]).slice(0, 20)}.json`;
      write(evidence, post);
      const skip = source.name === 'xiaohongshu' && (post.detail_skip_reason || (!post.detail_evidence && 'detail_missing')
        || (excludedCompany({ company: post.company || post.title }) && 'excluded_company'));
      const classification = skip ? { lead: null, reason: skip } : classifyPost(post, source, { now, evidence });
      classifications.push(classification);
      const l = classification.lead;
      if (!l) continue;
      if (!discoveryAllows(l)) { prefilter_rejections.outside_discovery_scope = (prefilter_rejections.outside_discovery_scope || 0) + 1; continue; }
      const reason = prefilter(l);
      if (reason && reason !== 'china_remote_unverified') l.prefilter_reason = reason;
      incoming.push(l);
      if (!l.prefilter_reason) eligible++;
      else prefilter_rejections[l.prefilter_reason] = (prefilter_rejections[l.prefilter_reason] || 0) + 1;
    }
    const rejections = summarizeRejections(classifications);
    // Diagnostic failures can overlap accepted summary fallbacks; never turn
    // a failed detail request into an automatic post rejection.
    if (details.detail_errors?.length) rejections.rejected.detail_fetch_failed = details.detail_errors.length;
    const missingLinks = posts.filter(p => p.permalink_missing).length;
    const unique = new Set(posts.map(p => postKey(p, source)));
    const summary = { posts: posts.length, unique_posts: unique.size, known_posts: [...unique].filter(id => knownPosts.has(id)).length,
      new_candidates: coverage.reduce((sum, q) => sum + q.new_candidates, 0), page_loads, coverage, search_pending: search_pending || 0, eligible, prefilter_rejections,
      ...(missingLinks ? {permalink_missing:missingLinks, error:`${missingLinks} 条帖子已读取正文，但缺少可核验原帖链接，未作为有效机会入库`} : {}),
      ...(blocked ? { reason: blocked, error: blocked + ':' + source.domain, ...sourceFailureReceipt(source, blocked), ...(error_evidence ? { error_evidence } : {}), ...(page_shape ? { page_shape } : {}) } : {}), rejections, ...dates, ...details,
      ...(details.detail_errors?.length ? { error: details.detail_errors[0].error } : {}),
      ...(dates.date_errors.length ? { error: dates.date_errors[0].error } : {}) };
    const result = { source: source.name, status: browserBlocked || browserControlStopped || dates.detail_stopped || details.detail_stopped ? 'blocked' : missingLinks || search_pending || details.detail_pending || dates.detail_pending || dates.date_errors.length ? 'partial' : 'checked', ...summary };
    results.push(result);
    ranNow[source.name] = browserScanComplete(result) ? { at: new Date(now).toISOString(), ...summary } : null;
    if (blocked === 'session_expired' && sessions.domains?.[source.domain]) expire(source.domain);
    // A login wall is that site's boundary, not the browser's: the source is
    // marked logged out (above) and the round goes on to the other sources in
    // the same space. A captcha or a user taking control still ends the round.
    // 认不出页面、这一页超时、网站被别的任务占着也一样：只是这个网站扫不了（10-10）。
    if (blocked && siteOnlyStop(blocked) && !browserControlStopped) { browserBlocked = false; continue; }
    if (browserBlocked || browserControlStopped) break;
  } catch (e) {
    ranNow[source.name] = null;
    browserBlocked = true;
    const failure = `${dir}/${source.name}/failure-${Date.now()}.json`;
    write(failure, errorEvidence(e));
    results.push({ source: source.name, status: 'blocked', error: e.message, ...sourceFailureReceipt(source, e.message), error_evidence: failure, rejections: summarizeRejections([]), date_filled: 0 });
    if (/session_expired/.test(e.message) && sessions.domains?.[source.domain]) expire(source.domain);
    if(/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(e.message)) browserControlStopped=true;
    break;
  }
}
if(browserSpace&&!browserControlStopped&&!browserBlocked&&!process.argv.includes('--keep-space')){
  try{await call(`const task=await taskSpace(${JSON.stringify(browserSpace)});await task.finish({keep:[]});radarResult({finished:true});`);}catch(e){results.push({source:'browser',status:'blocked',error:e.message.slice(0,180)});}
}

let added = 0, drafted = 0;
{
  const clustered = clusterMaimaiLeads(incoming);
  const merged = mergeLeads(lines('state/leads.ndjson'), clustered);
  const incomingKeys = new Set(clustered.flatMap(maimaiPostKeys));
  added = merged.added;
  // No published address means the only route is a platform message, which goes
  // through the same review card as an email: nothing is sent without 「发 编号」.
  // A posting whose recruiter wrote first (lib/boss-inbound.mjs, l.inbound) already has
  // its conversation: no first-contact draft for it.
  const drafts = lines('state/drafts.ndjson');
  for (const l of merged.leads.filter((l) => (clustered.some(x => x.url === l.url) || maimaiPostKeys(l).some(key => incomingKeys.has(key))) && !l.email && !l.superseded && !l.inbound)) {
    const draft = platformDraft(l, facts, { now });
    if (!draft || drafts.some((d) => d.draft_id === draft.draft_id || (draft.channel === 'maimai_friend_request' && d.record_id === draft.record_id && d.channel === draft.channel))) continue;
    // Shown only after the judgement keeps the lead: Jev (bin/judge-leads.mjs) or, in the App,
    // the text-model match (bin/match.mjs); both end with settleDrafts. Before 2026-10-05 a draft
    // written without Jev was ready at once, so a lead the match later excluded (#523) kept a
    // sendable draft in the inbox.
    draft.status = AWAITING_JUDGEMENT;
    drafts.push(draft);
    drafted++;
  }
  writeLines('state/leads.ndjson', merged.leads);
  writeLines('state/drafts.ndjson', drafts);
  patch('state/human-browser-index.json', {}, (x) => {
    for (const [name, result] of Object.entries(ranNow)) {
      if (result) (x[date] ||= {})[name] = result;
      else if (x[date]) delete x[date][name];
    }
  });
  // A Maimai-only discovery reports session boundaries in evidence without
  // rewriting the user's runtime session configuration.
  if (only !== 'maimai' && expired.size) patch('config/portal-sessions.json', { domains: {} }, (x) => {
    let n = 0;
    for (const d of expired) if (x.domains?.[d]) { x.domains[d] = { ...x.domains[d], logged_in: false, verified_at: date, last_probe: 'session_expired' }; n++; }
    if (!n) return false;
  });
}
// 扫不了的来源各带一句人话（哪个源、为什么、要你做什么，lib/human-browser.mjs browserSourceWhy）；errors 给周期的失败原因用。
for (const r of results) if (r.source !== 'browser' && ['blocked', 'skipped', 'partial'].includes(r.status) && (r.reason || r.error) && !r.say) Object.assign(r, sourceFailureReceipt(BROWSER_SOURCES.find(s => s.name === r.source), r.reason || r.error));
const errors = results.filter(r => r.status === 'blocked' && r.say).map(r => r.say);
console.log(
  JSON.stringify(
    log('discover-human-browser', {
      ...(errors.length ? { errors } : {}),
      status: results.some((r) => ['blocked','partial'].includes(r.status)) ? 'degraded' : added || drafted ? 'changed' : 'no_change',
      added,
      drafted,
      candidates: incoming.length,
      unique_candidates: new Set(incoming.map(l => maimaiPostKey(l) || l.url)).size,
      sources: results,
      rejections: Object.fromEntries(results.filter((r) => r.source !== 'browser').map((r) => [r.source, r.rejections])),
      evidence: dir,
    }),
  ),
);
