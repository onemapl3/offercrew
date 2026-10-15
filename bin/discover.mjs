import { sourceEnabled, excludedCompany, discoveryAllows } from '../lib/discovery-policy.mjs';
import { waitForLock } from "../lib/lock.mjs";
import YAML from "yaml";
import { primaryCity, cityPattern } from "../lib/city.mjs";
import fs from 'node:fs';
import { text, write, writeLines, lines, log, arg, read, file, today, deadlineNear } from "../lib/store.mjs";
import { mergeLeads } from "../lib/dedupe.mjs";
import { refreshOfficialPostings } from '../lib/posting-check.mjs';
import {prefilter} from '../lib/matcher.mjs';
import {fetchSource, selectSources, recordSuccess, recordFailure, recordOutage, networkOutage, mergeFieldsText, sourceState} from '../lib/discovery-source.mjs';
import { TZ } from '../lib/tz.mjs';
import { politely, siteQueue, robotsReport, tooSlow, MAX_PER_SITE } from '../lib/ats/politeness.mjs';
import { applySourceFixesSafely } from '../lib/source-fixes.mjs';
import { rankedCities } from '../lib/city.mjs';
import { inTargetCity, cnCities } from '../lib/ats/cn.mjs';
import { noteDiscover } from '../lib/discover-fresh.mjs';
import { noteSwallowed } from '../lib/swallow.mjs';
// 记下这次读没读通（lib/discover-fresh.mjs：团队页上「上次找岗位」、醒来补跑带不带找岗位都看它）。只扫一家的不算。
const noteRun = r => { if (arg('--company')) return; try { noteDiscover(r); } catch (e) { noteSwallowed('discover.note', e, { member: 'scout', doing: '记下这次找岗位读没读通', then: '团队页上的「上次找岗位」这次没更新' }); } };
// 随新版带来的招聘源改正（lib/source-fixes.mjs）：扫描前对一遍，改过的这一轮就按新的读。
if (!process.argv.includes('--dry-run')) applySourceFixesSafely();
const companies = YAML.parse(text("config/companies.yaml"));
if(process.argv.includes('--wide'))for(const c of YAML.parse(text('config/companies.archive.yaml'))||[]){
  if(c.status==='verified'&&!companies.some(x=>x.name===c.name))companies.push({...c,wide_source:true});
}
if (!sourceEnabled('official')) { const r = log('discover', {status:'no_change', sources:[{source:'official',status:'paused',reason:'disabled_by_configuration'}]}); noteRun(r); console.log(JSON.stringify(r)); process.exit(0); }
const company = arg("--company");
if (company && excludedCompany({name:company})) { console.log(JSON.stringify(log('discover', {status:'no_change', sources:[{company,status:'paused',reason:'company_excluded_by_user'}]}))); process.exit(0); }
if (company && !companies.some(c => c.name === company)) throw Error("unknown_company:" + company);
const retryUnverified = process.argv.includes("--retry-unverified");
// Excluded companies are dropped before the retry budget is spent on them.
const selected = selectSources(companies.filter(c => (!company || c.name === company) && !excludedCompany(c)), { retryUnverified });
if (process.argv.includes("--dry-run") && company) {
  const c = companies.find(c => c.name === company);
  try {
    const adapter = await import(`../lib/ats/${c.ats_type}.mjs`);
    const jobs = await adapter.fetchJobs(c);
    // 核实来源：第一个目标城市（lib/city.mjs，本人是杭州）有岗位才算 verified；没配置城市时任何城市都算。
    // 输出字段名 hangzhou_job_count / no_hangzhou_jobs 沿用旧名，companies.yaml 里记着它们。
    const first = primaryCity(), hangzhou = jobs.filter(j => !first || cityPattern(first).test(j.location || ''));
    console.log(JSON.stringify({ company, read_only: true, status: hangzhou.length ? 'verified' : 'unverified',
      job_count: jobs.length, hangzhou_job_count: hangzhou.length, eligible_job_count: hangzhou.filter(j => !prefilter(j)).length,
      checked_at: new Date().toISOString(), ...(hangzhou.length ? {} : { error: 'no_hangzhou_jobs' }),
      sample: hangzhou.slice(0, 3).map(({ role, location, url }) => ({ role, location, url })) }));
  } catch (e) {
    console.log(JSON.stringify({ company, read_only: true, status: 'unverified', job_count: 0, hangzhou_job_count: 0, error: e.message, checked_at: new Date().toISOString() }));
  }
  process.exit(0);
}
if (process.argv.includes("--dry-run")) {
  console.log(
    JSON.stringify({
      sources: companies.length,
      verified: companies.filter((c) => c.status === "verified").length,
      by_adapter: Object.fromEntries(
        [...new Set(companies.map((c) => c.ats_type))].map((a) => [a, companies.filter((c) => c.ats_type === a).length]),
      ),
    }),
  );
  process.exit(0);
}
await waitForLock('discovery');
const outcomes = [];
// 按网站分队列（lib/ats/politeness.mjs）：5 路并发先领现在就能读的网站，等某个网站名额时去读别的网站。
// 网站按来源的地址估（origin、订阅源、招聘页；都没有的按适配器，比如 Greenhouse 的接口站），真正发请求时按实际主机排队。
const sourceSite = (c) => c.origin || c.feed_url || c.careers_url || (c.ats_type ? `ats-${c.ats_type}.invalid` : null);
const queue = siteQueue(selected, sourceSite);
const incoming = [];
// robots.txt 要求每次间隔超过 60 秒的网站跨轮隔开（lib/ats/politeness.mjs）：离上次读还不够久、或这一轮已经读过它的
// 一个来源，这个来源这一轮不读，健康记录照旧（不算失败），日志记一笔；到了间隔照常读，读完记下时间。
const slowSources = [];
const waitedOut = [];
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (queue.size) {
      // 到了周期给的收尾点：不再开新的源，已读到的照常入库，其余源下一轮再读。
      if (deadlineNear(60000)) break;
      const job = await queue.next();
      if (!job) break;
      // 领活时可能等过别的网站让出名额：等完已到收尾点，这个来源留到下一轮。
      if (deadlineNear(60000)) { waitedOut.push(job.item.name); job.done(); break; }
      const c = job.item,
        start = Date.now(),
        retried = c.status !== "verified" && c.status !== "unconfirmed";
      try {
        const cache = `runs/discovery/${c.board || c.name}.json`;
        const stat = process.argv.includes('--resume') && fs.existsSync(file(cache)) ? fs.statSync(file(cache)) : null;
        const cacheDay = stat && new Intl.DateTimeFormat('en-CA', {timeZone:TZ}).format(stat.mtime).replaceAll('-','');
        const reused = cacheDay === today();
        // 每一跳请求按网站排队：同一网站同时最多 2 路，照 robots.txt 的 Crawl-delay 隔开（子进程的请求经 IPC 回这里排）。
        const jobs = reused ? read(cache) : await politely(() => fetchSource(c), { max: MAX_PER_SITE, robots: true });
        incoming.push(...jobs);
        if (!reused) write(cache, jobs);
        outcomes.push({ c, jobs, reused, retried, at: reused ? stat.mtime : new Date(), ms: Date.now() - start });
      } catch (e) {
        const slow = tooSlow(e);
        if (slow) slowSources.push({ company: c.name, ...slow });
        // 在网站门口等到了收尾点（或等太久）：这一轮没读完，下一轮再读，不算失败（lib/discovery-source.mjs fetchSource）。
        else if (e.code === 'source_deferred') waitedOut.push(c.name);
        else outcomes.push({ c, error: e, retried, ms: Date.now() - start });
      } finally { job.done(); }
    }
  }),
);
// Health is settled once the whole run is known: a run where nearly every
// source died in transport is the machine's network, not the sources.
const outage = networkOutage(outcomes);
const results = outcomes.map(({ c, jobs, error, reused, retried, at, ms }) => {
  // 读到的岗位里有几个在目标城市（全球招聘板说「读到 12 个岗位，没有杭州的」）；没配城市不算。
  const cities = rankedCities().length ? cnCities() : null;
  const cityCount = jobs && cities ? jobs.filter((j) => inTargetCity(j.location, cities)).length : undefined;
  const health = error ? (outage ? recordOutage(c, error) : recordFailure(c, error)) : recordSuccess(c, jobs, { at, cityCount });
  // Every source carries why it is (not) fine: reason is the raw code or error, note the same in plain words
  // (2026-10-01 #7: the report only had an error when nothing was read, so pages said 「有问题」 with no why).
  const row = {
    company: c.name,
    // "failing" = still read every run (verified or unconfirmed), but this run's read failed.
    status: health === "kept" ? "failing" : c.status,
    health,
    ...(jobs ? { count: jobs.length, reused_cache: reused, checked_at: c.verified_at, ...(cityCount != null ? { city_count: cityCount } : {}) } : { error: error.message, checked_at: new Date().toISOString() }),
    ...(c.consecutive_failures ? { consecutive_failures: c.consecutive_failures } : {}),
    ...(c.retry_at && c.status !== "verified" ? { retry_at: c.retry_at } : {}),
    ...(retried ? { retried: true } : {}),
    // --wide 读的存档公司不在清单里：Radar 页照样列出（不能改）；清单里没有、又不带这个的旧行不列（lib/sources.mjs）。
    ...(c.wide_source ? { wide_source: true } : {}),
    ms,
  };
  const st = sourceState({ ...row, last_error: c.last_error, verification_error: c.verification_error });
  return { ...row, reason: st.reason || c.last_error || null, note: st.text };
});
const eligible=incoming.filter(l=>discoveryAllows(l)&&!prefilter(l));
const merged = mergeLeads(lines("state/leads.ndjson"), eligible);
writeLines("state/leads.ndjson", merged.leads);
const scanned = outcomes.map((o) => o.c).filter((c) => !c.wide_source);
if (scanned.length) write("config/companies.yaml", mergeFieldsText(text("config/companies.yaml"), scanned));
// --company 只扫了一家：只换掉这一家的结果，其它来源的健康记录留着（告警、Radar 页的「官方招聘源 N 个」都读这份）。
// 这一轮因 Crawl-delay 太长、或排队等到收尾点没读的来源也一样：上一次的记录留着。
const slowNames=new Set([...slowSources.map(s=>s.company),...waitedOut]);
const kept=company||slowNames.size?(read('state/discovery-sources.json',{}).sources||[]).filter(s=>!results.some(r=>r.company===s.company)&&(company||slowNames.has(s.company))):[];
if(outcomes.length)write('state/discovery-sources.json',{at:new Date().toISOString(),wide:process.argv.includes('--wide'),...(outage?{network_outage:true}:{}),sources:[...kept,...results]});
const posting_checks = await refreshOfficialPostings(outcomes, { stop: () => deadlineNear(60000) });
const count = (health) => results.filter((r) => r.health === health).length;
// 这一轮读过的 robots.txt（没有、读不到、写了 Crawl-delay 的、太长没读的），记进日志。
const robots = await robotsReport();
const result = {
  status: merged.added || posting_checks.closed ? "changed" : "no_change",
  posting_checks,
  raw: incoming.length,
  eligible: eligible.length,
  added: merged.added,
  verified: companies.filter((c) => c.status === "verified").length,
  unconfirmed: count("unconfirmed"),
  broken: results.filter((r) => sourceState(r).bad).length,
  retried: results.filter((r) => r.retried).length,
  recovered: count("recovered"),
  failing: count("kept"),
  quiet: count("quiet"),
  demoted: count("demoted"),
  ...(outage ? { network_outage: true } : {}),
  ...(queue.size + waitedOut.length ? { deferred: queue.size + waitedOut.length } : {}),
  ...(slowSources.length ? { skipped_slow_site: slowSources } : {}),
  ...(Object.keys(robots).length ? { robots } : {}),
  sources: results,
};
log("discover", result);
noteRun(result);
console.log(JSON.stringify(result));
