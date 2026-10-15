import { leadErrorsNote } from '../lib/event-reasons.mjs';
import { recoverPostingCompany } from '../lib/lead-fields.mjs';
import { selectCityQuota } from "../lib/city-quota.mjs";
import { MATCH_QUEUE, matchQueueOrder, otherMatchQueue } from '../lib/match-queue.mjs';
import { waitForLock } from "../lib/lock.mjs";
const noWrite = process.argv.includes("--no-write");
// --rejudge-filled：只重判补上资料（工作许可、技能、经历、学历）以后该重判的那几条（lib/first-round.mjs rejudgeReady），别的线索不碰（保存资料时起，lib/command-center.mjs rejudgeFilled）。
const onlyFilled = process.argv.includes("--rejudge-filled");
// --record <id>：只判这一条（收件箱、岗位页上的「先判断」，lib/ask-actions.mjs judge 步骤）。已经有结论、但结论下面一条要求都没有
// （算不出匹配度，lib/recommend-gate.mjs judgedFully）的也重判。
const onlyRecord = arg("--record", "") ? new Set(arg("--record", "").split(",").filter(Boolean)) : null;
// 公司找岗有持久队列：锁忙立即回队列，不让子进程占着等；其它入口沿用原来的等待上限。
if (!noWrite) await waitForLock('matching',{timeout:Math.max(0, Number(arg('--wait-lock-ms', 15*60000)))});
import YAML from "yaml";
import { lines, writeLines, read, text, write, arg, log, today, deadlineNear } from "../lib/store.mjs";
import { infer } from "../lib/model.mjs";
import { decodeEntities } from "../lib/ats/http.mjs";
import { politely, robotsReport, tooSlow, MAX_PER_SITE } from "../lib/ats/politeness.mjs";
import { prefilter, priority, byPriority, byFirstRound, pendingLead, hasFullDescription, policyReviewNeeded } from "../lib/matcher.mjs";
import { validatedMatchOutput, cachedCitationMatch, saveMatchOutput } from '../lib/match-recovery.mjs';
import { matchInput } from '../lib/match-input.mjs';
import { JUDGEMENT_VERSION } from '../lib/judgements.mjs';
import { recordPolicyReview, reviewBudgetHold, reviewSnapshot, syncPolicyReviewQueue } from '../lib/judge-review.mjs';
import { FAILURE_FIELDS, backfillFailure, clearMatchFailure, matchEligible, recordMatchFailure, isTransportError } from "../lib/match-retry.mjs";
import { loadPreferences } from "../lib/preferences.mjs";
import { currentFacts } from "../lib/facts.mjs";
import { budgetGate, spendTier, economyAllows } from "../lib/spend.mjs";
import { rejudgeReady, backlogNow } from "../lib/first-round.mjs";
import { event } from "../lib/events.mjs";
import { stopIfFactsBad } from "../lib/facts-gate.mjs";
import { settleDrafts } from "../lib/human-browser.mjs";
import { sourceStats, penaltyOf, MATCH_PENALTY } from "../lib/source-stats.mjs";
// 资料文件读坏了、或者引导走完以后不见了：预筛、匹配都不跑（lib/facts-gate.mjs），不按空资料写下预筛理由。
stopIfFactsBad("match");
const leads = lines(arg("--input", noWrite ? "state/sample/leads.ndjson" : "state/leads.ndjson")),
  cs = [...YAML.parse(text("config/companies.yaml")),...YAML.parse(text('config/companies.archive.yaml'))];
// 判断时资料里缺了东西（工作许可、技能、经历、学历）、判成待核的，补上以后重新判断（lib/first-round.mjs rejudgeReady）。
const due=l=>onlyRecord?onlyRecord.has(l.record_id||l.id)&&!l.superseded:onlyFilled?rejudgeReady(l,currentFacts()):policyReviewNeeded(l)||pendingLead(l)||rejudgeReady(l,currentFacts());
if (!noWrite) syncPolicyReviewQueue(leads);
const policyRows = leads.filter(l => due(l) && policyReviewNeeded(l));
const policyBefore = reviewSnapshot(policyRows);
const policyIds = new Set(policyRows.map(l => l.record_id || l.id));
const reviewedRow = l => policyIds.has(l.record_id || l.id);
const persistLead=async l=>{
  if(noWrite)return true;
  {
    const current=lines('state/leads.ndjson'),row=current.find(x=>x.id===l.id);
    if(row&&due(row)&&(policyReviewNeeded(row)||!lines('state/feedback.ndjson').some(e=>e.record_id===(row.record_id||row.id)))){
      if (l.match?.recovered_from && !row.match?.verdict) {
        // 落库前用刚读回的岗位再次核验；同时变过的正文/个人资料不靠旧快照盖回去。
        const recoveredMatch = cachedCitationMatch(row, { preferencesVersion: l.match.preferences_version });
        if (!recoveredMatch || recoveredMatch.recovered_from.sha256 !== l.match.recovered_from.sha256) return false;
        row.match = l.match = recoveredMatch; row.matched_at = l.matched_at; clearMatchFailure(row);
        writeLines('state/leads.ndjson', current); return true;
      }
      for(const k of ['company','company_status','company_claim','field_sources','jd_text','judgement','prefilter_reason','match','matched_at','rejudged_at','wide_source'])if(l[k]!==undefined)row[k]=l[k];
      if (!l.prefilter_reason) delete row.prefilter_reason;
      if (onlyRecord && !l.judgement) delete row.judgement;
      // Failure fields mirror the in-memory lead exactly: a retry time that was
      // dropped on finalization must disappear from disk as well.
      for(const k of FAILURE_FIELDS)if(l[k]===undefined)delete row[k];else row[k]=l[k];
      writeLines('state/leads.ndjson',current);
      return true;
    }
  }
  return false;
};
let prefiltered=0;
const preferences = loadPreferences(), recovered = [];
const mainCompanies = new Set(YAML.parse(text('config/companies.yaml')).map(c=>c.name));
const feedbackIds = new Set(lines('state/feedback.ndjson').map(e=>e.record_id));
for (const l of leads) {
  if (!l.source_type?.includes('真人')) l.wide_source = !mainCompanies.has(l.company);
  // Restore old service failures for pending and policy-review leads alike;
  // do not reopen a user's ended/parked record or erase real validation counts.
  if (due(l) && (policyReviewNeeded(l) || !feedbackIds.has(l.record_id || l.id)) && backfillFailure(l)) await persistLead(l);
  if (!noWrite && due(l) && !feedbackIds.has(l.record_id || l.id)) {
    const cached = cachedCitationMatch(l, { preferencesVersion: preferences.version });
    if (cached) {
      l.match = cached; l.matched_at = new Date().toISOString(); clearMatchFailure(l);
      if (await persistLead(l)) {
        recovered.push(l);
        if (!noWrite) event('lens', 'match-recovery', 'ok', '原判断输出经当前规则核验通过，未再次调用模型', { lead_id: l.record_id || l.id, recovered_from: l.match.recovered_from });
      }
      continue;
    }
  }
  if (onlyRecord?.has(l.record_id || l.id) && !feedbackIds.has(l.record_id || l.id)) {
    delete l.judgement; // 点名重判不能沿用旧的岗位类别答案。
    l.prefilter_reason = prefilter(l) || null;
    await persistLead(l);
  }
  if (!onlyFilled && pendingLead(l) && !feedbackIds.has(l.record_id || l.id)) {
    const reason = prefilter(l);
    if (reason && l.prefilter_reason !== reason) { l.prefilter_reason = reason; prefiltered++; await persistLead(l); }
  }
}
const perCompany=Math.max(1,Number(arg('--per-company',read('config/pipeline.json',{}).match_per_company||6)));
// 花费档位（lib/spend.mjs）：省钱档只匹配你按标题留下的（和你转发 / 收录来的）；高级档用清单里最好的模型。
const tier = spendTier();
// 长期不准的来源（lib/source-stats.mjs）先判的次序排后，不关掉。
const srcStats = sourceStats(leads), byPriorityAndSource = (a, b) => (priority(b) - penaltyOf(b, srcStats, MATCH_PENALTY)) - (priority(a) - penaltyOf(a, srcStats, MATCH_PENALTY)) || byPriority(a, b);
const matchLimit = Math.min(noWrite ? 5 : 60, Math.max(0, Number(arg('--limit', noWrite ? 5 : read('config/pipeline.json', {}).match_limit || 40))));
const reviews = policyRows.filter(l => matchEligible(l) && (!arg('--company', '') || l.company === arg('--company', '')))
  .sort((a,b) => Number(b.number != null) - Number(a.number != null) || byPriority(a,b)).slice(0, matchLimit);
const fresh = leads
  .filter(
    (l) => due(l) && !recovered.includes(l) && !reviewedRow(l) && !feedbackIds.has(l.record_id || l.id) && !l.prefilter_reason && matchEligible(l) && (onlyRecord || tier !== "economy" || economyAllows(l)),
  )
  .filter((l) => !arg("--company", "") || l.company === arg("--company", ""))
  // 首轮（--fit-first，op round-first 经 bin/cycle.mjs 传来）先判和你的技能对得上的（lib/matcher.mjs byFirstRound）。
  .sort(process.argv.includes("--fit-first") ? byFirstRound() : byPriorityAndSource);
const pickFresh = limit => selectCityQuota(fresh, { perCompany: onlyFilled || onlyRecord ? 60 : perCompany, limit });
const order = matchQueueOrder({ fresh: pickFresh(matchLimit).length, review: reviews.length, limit: matchLimit, next: read(MATCH_QUEUE, {}).next });
const queues = { fresh: pickFresh(order.filter(q => q === 'fresh').length), review: reviews };
const selected = order.map(q => queues[q].shift());
const previouslyExcluded=leads.filter(l=>l.match?.verdict==="exclude").length;
// 一次匹配最坏要把文字清单里每个底座都等到超时（2026-09-23 下午起 3 个 × 120 秒）：离收尾点不够一次就不开新的，
// 免得被周期强杀在半路（在途的 claude -p / codex 会成孤儿）。
const textConf = read("config/model.json", {}).text || {};
const callMs = Math.max(180000, (Number(textConf.timeout_ms) || 120000) * Math.max(1, (textConf.backends || []).length));
let calls = 0;
let transportFailures = 0;
let judgedNow = recovered.length; // 这一轮判成了几条（含无需再调模型的原输出恢复）
const errors = [];
const reviewReasons = new Map();
for (const l of policyRows) if (arg('--company', '') && l.company !== arg('--company', '')) reviewReasons.set(l.record_id || l.id, '本轮只重判指定公司，这条未被选中');
let cursor = 0;
// robots.txt 要求每次间隔超过 60 秒的网站跨轮隔开（lib/ats/politeness.mjs）：到了间隔这一轮取 1 条，其余（和没到间隔的）
// 不取详情，线索原样留着（不记失败），日志记一笔。
const slowSites = {};
let skippedSlow = 0;
// 今天的花费上限到了：一条都不匹配，留到明天（lib/spend.mjs）；匹配到一半到了上限，也在下一条之前停。
let spendHold = !noWrite && budgetGate('match');
let spendCapped = !!spendHold;
// 这一批要判几个：指挥台和对话里的「Judge 判了 6/15」读它（lib/hq.mjs runningNow）。
if (!noWrite && !spendCapped && selected.length) write('state/match-progress.json', { started_at: new Date().toISOString(), total: selected.length, pid: process.pid });
// 同时判几个（10-03 第 4 轮 F09：首轮一个一个判，每个约 50 秒，15 个要 13 分钟）。首轮（--fit-first）3 个；平时按
// config/pipeline.json 的 match_concurrency，没写就 1 个（和以前一样）。花费上限每判一个之前都查一次：同时判的几个里，
// 最多多出正在判的那几个。取详情另有按网站的排队（同一网站最多 2 路），不受这个数影响。
const concurrency = Math.max(1, Math.min(4, Number(arg('--concurrency', '')) || (process.argv.includes('--fit-first') ? 3 : Number(read('config/pipeline.json', {}).match_concurrency) || 1)));
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < selected.length && !spendCapped) {
      if(deadlineNear(callMs))break;
      if(calls&&!noWrite&&(spendHold=budgetGate('match'))){spendCapped=true;break;}
      const l = selected[cursor++];
      // Advance on an actual attempt, not a planned selection. Explicit scoped
      // judgements do not consume the normal round's fairness turn.
      if (!noWrite && !onlyRecord && !onlyFilled) write(MATCH_QUEUE, { next: otherMatchQueue(reviewedRow(l) ? 'review' : 'fresh') });
      try {
        if (!hasFullDescription(l)) {
          const c = cs.find((c) => c.name === l.company);
          if(!l.ats_type || !c)throw Error("full_jd_missing");
          const adapter = await import(`../lib/ats/${l.ats_type}.mjs`);
          if (!adapter.detail) throw Error("full_jd_missing");
          // 取详情按网站排队（lib/ats/politeness.mjs）：同一网站同时最多 2 路，照 robots.txt 的 Crawl-delay 隔开。
          Object.assign(l, await politely(() => adapter.detail(c, l), { max: MAX_PER_SITE, robots: true }));
        }
        if (!hasFullDescription(l)) throw Error("full_jd_missing");
        l.jd_text=decodeEntities(l.jd_text);
        Object.assign(l, recoverPostingCompany(l));
        // 旧 Jev 的 grade/family 不是本轮重新读到的事实，不能抢先把同一条再次筛掉。
        const contextLead = reviewedRow(l) ? { ...l, judgement: null, prefilter_reason: null } : l;
        const reason=prefilter(contextLead);
        if(reason){clearMatchFailure(l);l.prefilter_reason=reason;if(reviewedRow(l))l.judgement={version:JUDGEMENT_VERSION,at:new Date().toISOString(),reason,posting:null};prefiltered++;await persistLead(l);continue;}
        const input = matchInput(l, { leads }), { prompt } = input;
        calls++;
        const raw = await infer(prompt, l.id, input.schema, { persist: !noWrite, role: "lens", step: "match", lead_id: l.id, parallel: concurrency > 1, cache_split: Math.max(0, prompt.indexOf(`Company:${l.company}\nRole:`)), prefer: tier === 'premium' ? 'best' : null, what: `判断 ${l.number != null ? `#${l.number} · ` : ''}${[String(l.company || '').replace(/^待核（(.+)）$/, '$1'), l.role].filter(Boolean).join(' · ')}（第 ${cursor}/${selected.length} 个）` });
        if (!noWrite) saveMatchOutput(`runs/${today()}/matches/${l.id}.json`, raw, input);
        transportFailures = 0;
        // Which version of the preference table informed this judgement, so a
        // verdict can always be read back against what the system believed then.
        // 能在资料里补的缺口也记下（lib/first-round.mjs fillGaps）：补上以后只重判因为它待核的这几条。
        // 推荐线（lib/recommend-gate.mjs）：Judge 说推荐、匹配度没到线的，记成待核（below_line）。规则判断本身（validateMatch）不变。
        const judged = validatedMatchOutput(raw, contextLead, { preferencesVersion: input.preferencesVersion });
        const previous = l.match?.verdict, at = new Date().toISOString();
        l.match = judged;
        if (!previous || previous !== judged.verdict || !l.matched_at) l.matched_at = at;
        if (reviewedRow(l)) { l.judgement = { version: JUDGEMENT_VERSION, at, posting: null, source: 'text_model' }; l.prefilter_reason = null; l.rejudged_at = at; }
        clearMatchFailure(l);
        judgedNow++;
      } catch (e) {
        const slow = tooSlow(e);
        if (slow) { reviewReasons.set(l.record_id || l.id, `网站要求抓取间隔 ${slow.crawl_delay} 秒，详情留到下一轮`); skippedSlow++; (slowSites[slow.host] ||= { crawl_delay: slow.crawl_delay, leads: 0 }).leads++; continue; }
        const outcome = recordMatchFailure(l, e.message);
        if (isTransportError(e.message)) transportFailures++;
        errors.push({ id: l.id, error: e.message, attempts: l.match_attempts, outcome, ...(outcome === "final" ? { company: l.company, role: l.role } : {}) });
      }
      await persistLead(l);
      if (transportFailures >= 3 || errors.at(-1)?.error.startsWith("model_http_")) {
        cursor = selected.length;
        break;
      }
    }
  }),
);
const finalLeads=noWrite?leads:lines("state/leads.ndjson");
const review = !noWrite && policyRows.length ? recordPolicyReview({ before: policyBefore, after: finalLeads, selected, reasons: reviewReasons, blocked: transportFailures ? '模型连接中断，本轮停止继续判断' : null, ...reviewBudgetHold(spendCapped && spendHold) }) : null;
if(review)event('lens','policy-review','ok',review.summary);
// 发现时写下的平台私信、脉脉加好友附言，判断留下才进收件箱；判断排除的、求职帖、公司主页的收回（lib/human-browser.mjs settleDrafts）。
// App 里没有 Jev，判断就是这一步（以前只有 bin/judge-leads.mjs 做这件事，App 里从来没做过：#523 判了排除，私信草稿还在收件箱里）。
let drafts={promoted:[],cancelled:[],rewritten:[]};
if(!noWrite){
  const all=lines("state/drafts.ndjson");
  drafts=settleDrafts(all,finalLeads,{requests:lines("state/send-requests.ndjson"),facts:currentFacts()});
  if(drafts.promoted.length||drafts.cancelled.length||drafts.rewritten.length)writeLines("state/drafts.ndjson",all);
}
// 推荐线（lib/recommend-sweep.mjs）：判完核线并按用户展示偏好放出；默认全部可见。
let gate=null;
if(!noWrite){try{const {sweepRecommendations}=await import("../lib/recommend-sweep.mjs");gate=sweepRecommendations();}catch(e){event("lens","recommend","fail",`推荐没放成：${String(e.message||e).slice(0,120)}`);}}
const robots = await robotsReport();
// 还没判的有多少、什么时候判，写进运行日志（第 3 轮负责人：进度进运行日志，不挂在指挥台顶上；lib/first-round.mjs backlogNow）。
const backlog=finalLeads.filter((l) => pendingLead(l) && !l.prefilter_reason && !l.match_error_final).length;
if(!noWrite&&calls&&backlog)event("lens","backlog","ok",backlogNow(backlog));
// 哪些错算这一轮没跑全（R1，主会话 10-10：一条岗位没抓到全文，整轮记成失败、团队页标红）：
//   模型连不上、超时这类（lib/match-retry.mjs isTransportError、model_http_）是这一轮的事；
//   某一条的岗位描述抓不到全文、模型给这一条的回答没过核对，是那一条的事：记在那条线索上（下次再试，试满了停在「判不了」），不把整轮记失败。
//   只有这一轮一条都没判成、两条以上都没过核对时，才当成模型出了问题记这一轮没跑全。
const roundError = e => isTransportError(e.error) || /^model_http_/.test(e.error);
const leadErrors = errors.filter(e => !roundError(e)), checkFailed = leadErrors.filter(e => !/full_jd_missing/.test(e.error));
const roundErrors = errors.filter(roundError).concat(!judgedNow && checkFailed.length >= 2 && checkFailed.length === leadErrors.length ? checkFailed : []);
console.log(
  JSON.stringify(
    (noWrite ? (_name, data) => ({ ...data, preview: selected }) : log)("match", {
      status: roundErrors.length ? "degraded" : calls || recovered.length || drafts.promoted.length || drafts.cancelled.length || drafts.rewritten.length ? "changed" : "no_change",
      calls,prefiltered,preferences_version:preferences.version,tier,...(gate?{released:gate.released.length,queued:gate.held}:{}),
      ...(recovered.length ? { recovered: recovered.map(l => ({ id: l.record_id || l.id, source: l.match.recovered_from.source, sha256: l.match.recovered_from.sha256 })) } : {}),
      ...(review ? { review_summary: review.summary } : {}),
      ...(drafts.promoted.length||drafts.cancelled.length||drafts.rewritten.length?{drafts:{promoted:drafts.promoted.length,cancelled:drafts.cancelled.length,rewritten:drafts.rewritten.length}}:{}),
      ...(spendCapped ? { reason: "spend_cap", deferred: selected.length - cursor } : {}),
      ...(skippedSlow ? { skipped_slow_site: skippedSlow, slow_sites: slowSites } : {}),
      ...(Object.keys(robots).length ? { robots } : {}),
      round_recommend:[...recovered,...selected].filter(l=>l.match?.verdict==="recommend").length,
      round_verify:[...recovered,...selected].filter(l=>l.match?.verdict==="verify").length,
      round_exclude:leads.filter(l=>l.match?.verdict==="exclude").length-previouslyExcluded+recovered.filter(l=>l.match?.verdict==="exclude").length,
      recommended: finalLeads.filter((l) => l.match?.verdict === "recommend").length,
      verify: finalLeads.filter((l) => l.match?.verdict === "verify").length,
      exclude: finalLeads.filter((l) => l.match?.verdict === "exclude").length,
      pending: finalLeads.filter((l) => pendingLead(l) && !l.prefilter_reason && !l.match_error_final).length,
      match_failed_final: finalLeads.filter((l) => pendingLead(l) && !l.prefilter_reason && l.match_error_final).length,
      errors: roundErrors,
      ...(leadErrors.length ? { lead_errors: leadErrors, lead_errors_note: leadErrorsNote(leadErrors) } : {}),
    }),
  ),
);
