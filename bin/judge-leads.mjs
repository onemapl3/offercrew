// Judge every pending lead with Jev: read the posting, apply the prefilter
// policy, and when the lead survives, judge the match against the candidate.
//
// This replaces the serial generative matcher as the verdict authority. Each
// lead costs one or two sub-second requests, so a backlog of hundreds is judged
// in one run instead of forty leads per cycle. The generative model is no longer
// on the path to a verdict; it only writes prose later, for leads that survive.
// A scheduled cycle passes `--limit` (pipeline.judge_limit) and a deadline
// (RADAR_MATCH_DEADLINE): the highest-priority leads first, the rest stay
// pending for the next cycle; a batch that fails whole (Jev unreachable) ends
// the run early for the same reason.
//
//   node bin/judge-leads.mjs                 # all pending leads, persist
//   node bin/judge-leads.mjs --limit 50      # first 50 by priority
//   node bin/judge-leads.mjs --no-write      # judge, print, change nothing
//   node bin/judge-leads.mjs --rejudge       # ignore an existing judgement
import { waitForLock } from '../lib/lock.mjs';
import { MATCH_QUEUE, matchQueueOrder, otherMatchQueue } from '../lib/match-queue.mjs';
const noWrite = process.argv.includes('--no-write');
if (!noWrite) await waitForLock('matching', { timeout: 15 * 60000 });
import YAML from 'yaml';
import { lines, writeLines, read, text, arg, log, today, write, deadlineNear } from '../lib/store.mjs';
import { event } from '../lib/events.mjs';
import { byPriority, policyReviewNeeded } from '../lib/matcher.mjs';
import { judgeAvailable, loadJudgeConfig, judgeOffline } from '../lib/judge.mjs';
import { loadFacts } from '../lib/judgements.mjs';
import { judgeLead, judgeWanted, numberRecommended, detailFetcher, detailSite } from '../lib/judge-leads.mjs';
import { robotsReport, runBySite } from '../lib/ats/politeness.mjs';
import { settleDrafts } from '../lib/human-browser.mjs';
import { budgetGate, spendTier, economyAllows } from '../lib/spend.mjs';
import { stopIfFactsBad } from '../lib/facts-gate.mjs';
import { errorReason } from '../lib/say-error.mjs';
import { recordPolicyReview, reviewBudgetHold, reviewSnapshot } from '../lib/judge-review.mjs';

// 资料文件读坏了、或者引导走完以后不见了：一条都不判（lib/facts-gate.mjs）。
stopIfFactsBad('judge-leads');
if (!judgeAvailable({ offlineOk: true })) {
  console.log(JSON.stringify(log('judge-leads', { status: 'no_change', reason: 'judge_unavailable' })));
  process.exit(0);
}
const rejudge = process.argv.includes('--rejudge');
const limit = Math.max(0, Number(arg('--limit', 0)));
const leads = lines(arg('--input', noWrite ? 'state/sample/leads.ndjson' : 'state/leads.ndjson'));
const policyBefore = reviewSnapshot(leads);
const companies = [...YAML.parse(text('config/companies.yaml')), ...YAML.parse(text('config/companies.archive.yaml'))];
const feedbackIds = new Set(lines('state/feedback.ndjson').map((e) => e.record_id));
const facts = loadFacts();
const mainCompanies = new Set(YAML.parse(text('config/companies.yaml')).map((c) => c.name));

// A lead is judged when it has never been judged, was judged by an older
// question set, or waits for a JD whose text has since changed. Leads the user
// already ended remain history; visible old-policy evidence is reviewed separately.
// 省钱档（lib/spend.mjs）：只判断你按标题留下的，和你自己转发 / 收录来的。
const economy = spendTier() === 'economy';
const wanted = leads.filter((l) => judgeWanted(l, { rejudge, feedbackIds }))
  .filter((l) => !arg('--company', '') || l.company === arg('--company', ''))
  .filter((l) => policyReviewNeeded(l) || !economy || economyAllows(l))
  .sort(byPriority);
const queues = { fresh: wanted.filter(l => !policyReviewNeeded(l)), review: wanted.filter(policyReviewNeeded) };
const reviewIds = new Set(queues.review.map(l => l.id));
const order = matchQueueOrder({ fresh: queues.fresh.length, review: queues.review.length, limit: limit || wanted.length, next: read(MATCH_QUEUE, {}).next });
const selected = order.map(q => queues[q].shift());
// 今天的花费上限到了：一条都不判断，留到明天（lib/spend.mjs）。离线规则判断不调用模型，不受上限管。
let spendHold = null;
const spendCapped = () => !!(spendHold = !noWrite && !judgeOffline() && budgetGate('judge'));
if (spendCapped()) {
  const review = policyBefore.length && recordPolicyReview({ before: policyBefore, after: leads, ...reviewBudgetHold(spendHold) });
  console.log(JSON.stringify(log('judge-leads', { status: 'no_change', reason: 'spend_cap', pending: wanted.length, selected: 0, deferred: selected.length, ...(review ? { review_summary: review.summary } : {}) })));
  process.exit(0);
}

// The official page's own detail call, for an ATS row stored without its JD:
// 按网站排队（同一网站最多 2 路、照 robots.txt 的 Crawl-delay），见 lib/judge-leads.mjs detailFetcher。
const fetchDetail = detailFetcher(companies);

const persist = async (batch) => {
  if (noWrite) return;
  const current = lines('state/leads.ndjson');
  for (const l of batch) {
    const row = current.find((x) => x.id === l.id);
    if (!row || !judgeWanted(row, { rejudge, feedbackIds: new Set(lines('state/feedback.ndjson').map(e => e.record_id)) })) continue;
    for (const k of ['jd_text', 'judgement', 'prefilter_reason', 'match', 'matched_at', 'rejudged_at', 'wide_source', 'judged_at', 'needs_jd', 'company', 'company_status', 'company_claim', 'field_sources', 'headhunter']) if (l[k] !== undefined) row[k] = l[k];
    for (const k of ['prefilter_reason', 'needs_jd', 'headhunter']) if (l[k] === null) delete row[k];
    numberRecommended(row, current);
  }
  writeLines('state/leads.ndjson', current);
};

const started = Date.now();
event('radar', 'judge', 'start', `Jev 判断 ${selected.length} 条线索`);
let judged = 0, prefiltered = 0, matched = 0, parked = 0, capped = 0, failed = 0, done = 0, skipped = 0;
// robots.txt 要求间隔超过 60 秒的网站跨轮隔开（到了间隔一轮取 1 条）：这一轮没取详情、原样留着的线索，按网站记
// （{ 主机: { crawl_delay, leads } }）。
const slowSites = {};
const verdicts = { recommend: 0, verify: 0, exclude: 0 };
const missingParts = {};
const errors = [];
const reviewReasons = new Map();
const conf = loadJudgeConfig();
for (let i = 0; i < selected.length; i += conf.concurrency * 4) {
  const batch = selected.slice(i, i + conf.concurrency * 4);
  // 按网站分队列（lib/ats/politeness.mjs runBySite）：等某个网站名额时先判别的网站的线索，总并发照旧是 conf.concurrency。
  // 只有取详情那一段占网站的名额，取完（成没成都算）就让出来，Jev 判断照旧 conf.concurrency 路并发。
  const results = await runBySite(batch, async (l, _, job) => {
    if (!noWrite && !rejudge) write(MATCH_QUEUE, { next: otherMatchQueue(reviewIds.has(l.id) ? 'review' : 'fresh') });
    if (!l.source_type?.includes('真人')) l.wide_source = !mainCompanies.has(l.company);
    const r = await judgeLead(l, { facts, fetchDetail: (x) => fetchDetail(x).finally(job.release) });
    // 这条没取详情、什么都没改（lib/judge-leads.mjs judgeLead）：不落盘，不算判过，下一轮再看。
    if (r.outcome === 'skipped') {
      reviewReasons.set(l.record_id || l.id, `网站要求抓取间隔 ${r.crawl_delay} 秒，详情留到下一轮`);
      skipped++;
      const s = (slowSites[r.host] ||= { crawl_delay: r.crawl_delay, leads: 0 });
      s.leads++;
      return r;
    }
    if (r.outcome === 'needs_jd') { parked++; for (const m of r.missing) missingParts[m] = (missingParts[m] || 0) + 1; }
    else if (r.outcome === 'prefiltered') prefiltered++;
    else {
      matched++; verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
      if (r.needs_jd) { capped++; for (const m of l.needs_jd?.missing || []) missingParts[m] = (missingParts[m] || 0) + 1; }
      if (!noWrite) write(`runs/${today()}/matches/${l.id}.json`, l.match);
    }
    return r;
  }, { concurrency: conf.concurrency, siteOf: detailSite });
  for (const [j, r] of results.entries()) { if (r.ok) { if (r.value?.outcome !== 'skipped') judged++; } else { failed++; reviewReasons.set(batch[j].record_id || batch[j].id, `这条没判成：${errorReason(r.error)}`); errors.push({ id: batch[j].id, number: batch[j].number, error: r.error }); } }
  await persist(batch.filter((_, j) => results[j].ok && results[j].value?.outcome !== 'skipped'));
  done += batch.length;
  // 整批都没判成（Jev 连不上、Mac 合盖断网）、到了周期给的收尾点、到了今天的花费上限，都停。
  if (results.every((r) => !r.ok) || deadlineNear(60000) || spendCapped()) break;
}
// Friend requests and platform messages written at discovery are shown only
// for leads the judgement kept; drafts of retired leads are cancelled.
let drafts = { promoted: [], cancelled: [], rewritten: [] };
if (!noWrite) {
  const all = lines('state/drafts.ndjson');
  drafts = settleDrafts(all, lines('state/leads.ndjson'), { requests: lines('state/send-requests.ndjson'), facts });
  if (drafts.promoted.length || drafts.cancelled.length || drafts.rewritten.length) writeLines('state/drafts.ndjson', all);
}
// Jev 主判断路径同样在落盘后放量；此前只 match 路径调了这一处。
if (!noWrite) (await import('../lib/recommend-sweep.mjs')).sweepRecommendations();
// `no_jd` keeps its old meaning for the cycle report: leads with nothing to
// read. They are now parked with `needs_jd` and are not selected again until
// their text changes. `needs_jd.capped` are read and matched, but state no
// duty or requirement, so the verdict stops at verify with the gap named.
// 这一轮读过的 robots.txt（没有、读不到、写了 Crawl-delay 的都在这里），记进日志。
const robots = await robotsReport();
const review = !noWrite && policyBefore.length ? recordPolicyReview({ before: policyBefore, after: lines('state/leads.ndjson'), selected, reasons: reviewReasons, ...reviewBudgetHold(spendCapped() && spendHold) }) : null;
if (review) event('radar', 'policy-review', 'ok', review.summary);
const summary = { status: prefiltered || matched || parked || drafts.promoted.length || drafts.cancelled.length ? 'changed' : failed ? 'degraded' : 'no_change', pending: wanted.length, selected: selected.length, deferred: selected.length - done, judged, prefiltered, matched, verdicts, no_jd: parked, needs_jd: { parked, capped, missing: missingParts }, drafts: { promoted: drafts.promoted.length, cancelled: drafts.cancelled.length, rewritten: drafts.rewritten.length }, failed, errors: errors.slice(0, 10), ...(skipped ? { skipped_slow_site: skipped, slow_sites: slowSites } : {}), ...(Object.keys(robots).length ? { robots } : {}), duration_ms: Date.now() - started };
if (review) summary.review_summary = review.summary;
event('radar', 'judge', failed && !judged ? 'fail' : 'ok', `Jev 判断完成：判 ${judged}，预筛 ${prefiltered}，匹配 ${matched}（推荐 ${verdicts.recommend}）${parked + capped ? `，JD 待补 ${parked + capped}` : ''}${summary.deferred ? `，留到下一轮 ${summary.deferred}` : ''}${skipped ? `，网站要求每次间隔超过 60 秒、这轮没取 ${skipped}` : ''}`, { duration_ms: summary.duration_ms });
console.log(JSON.stringify(log('judge-leads', summary)));
