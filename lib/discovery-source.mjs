import { spawn } from './spawn.mjs';
import YAML from 'yaml';
import { root } from './store.mjs';
import { currentScope, parentGate, CrawlDelayTooLong } from './ats/politeness.mjs';
import { rankedCities } from './city.mjs';

// Source health (config/companies.yaml). 2026-09-21 one resolver outage failed
// every source in a single run; each was demoted on the spot, normal runs only
// scan verified sources and nothing read retry_at, so official discovery went
// silent for two days. A verified source now survives failures until they are
// both repeated and old; an unverified one is retried with backoff, a few per
// run, and a read that returns jobs again restores it.
export const SOURCE_HEALTH = { demote_after_failures: 3, demote_after_hours: 24, retry_base_hours: 1, retry_cap_hours: 72, retries_per_run: 8, network_retries: 6, quiet_hours: 24, held_hours: 168 };
const HOUR = 3600000;
// Fields discover owns. Everything else in an entry belongs to the person or
// tool that configured it and is never touched by a scan.
export const HEALTH_FIELDS = ['status', 'job_count', 'city_count', 'http_status', 'verified_at', 'retry_at', 'last_error', 'last_error_at', 'consecutive_failures', 'failing_since', 'error', 'verification_error'];
export const retryDelay = (failures, h = SOURCE_HEALTH) => Math.min(h.retry_cap_hours, h.retry_base_hours * 2 ** Math.max(0, failures - 1)) * HOUR;
const time = (now) => (now instanceof Date ? now : new Date(now));

// What kind of trouble a source is in (10-05 负责人：「radar很多招聘源读不到」——62 个源里 13 个写着「读不到」，
// 其中一半能读、只是没有杭州的岗位，一半是官网有反爬或者根本没有能读的列表，还有一家网络断过一次就再没读过)：
//   network   连接阶段不通（代理、直连都试过）：下一轮扫描就再读，连着 network_retries 轮都不通才退避
//   blocked   官网有反爬验证（EdgeOne 567、JS 挑战、接口签名……）：不绕过，一周看一次
//   no_feed   官网没有能自动读的岗位列表（自建的单页程序、只在 BOSS 直聘）：一周看一次
//   no_city   读到了岗位，但没有目标城市的：不算失败，一天看一次
//   empty     读通了，一个岗位都没有：不算失败，一天看一次
//   other     别的错（404、对方服务器出错、读回来看不懂……）：照旧按失败次数退避
// 扫描自己的错（last_error）和以前核对时写下的说明（verification_error，有的是人写的中文）都认。
const TRANSPORT = /public_http_transport_|public_http_proxy_failed_|source_timeout|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i;
const KINDS = [
  ['blocked', /bot_challenge|反爬|人机验证|安全验证|JS 挑战|EdgeOne|(?<!\d)567(?!\d)|签名/i],
  ['network', TRANSPORT],
  ['no_feed', /no_job_list|needs_browser_extraction|无机读|没有能(?:自动)?读|不写单站适配器|无通用平台适配器|非通用平台|没有岗位列表/i],
  ['no_city', /no_city_jobs|no_hangzhou_jobs|无杭州岗位|没有杭州|全部在[^，；。]*无/i],
  ['empty', /(?:^|\b)no_jobs\b/],
];
export function problemKind(error) {
  // 链接里的字（数字、路径）不算：先去掉链接再认。
  const e = String(error?.message ?? error ?? '').replace(/https?:\/\/\S+/g, '').trim();
  if (!e) return null;
  return KINDS.find(([, re]) => re.test(e))?.[0] || 'other';
}
// 读得通、只是没有（目标城市的）岗位：不算失败。
export const readable = (kind) => kind === 'no_city' || kind === 'empty';
// 官网的限制（反爬、没有列表）：不是坏了，也不是这边能修的。
export const held = (kind) => kind === 'blocked' || kind === 'no_feed';

export function recordFailure(c, error, { now = new Date(), health = SOURCE_HEALTH } = {}) {
  now = time(now);
  const kind = problemKind(error);
  if (readable(kind)) return recordQuiet(c, error, { now, health });
  const failures = (Number(c.consecutive_failures) || 0) + 1;
  const since = failures > 1 && Date.parse(c.failing_since) <= now.getTime() ? c.failing_since : now.toISOString();
  Object.assign(c, { last_error: String(error?.message || error).slice(0, 500), last_error_at: now.toISOString(), consecutive_failures: failures, failing_since: since });
  delete c.error; // superseded by last_error
  const stale = failures >= health.demote_after_failures && now.getTime() - Date.parse(since) >= health.demote_after_hours * HOUR;
  // A source that reads jobs (verified, or unconfirmed: reads jobs, careers page not yet checked) gets the same grace.
  const reading = c.status === 'verified' || c.status === 'unconfirmed';
  if (reading && !stale) { delete c.retry_at; return 'kept'; }
  const demoted = reading;
  c.status = 'unverified';
  // 网络不通：下一轮就再读（retry_at 就是现在）；官网的限制一周看一次；别的照旧按次数退避。
  const delay = kind === 'network' && failures <= health.network_retries ? 0 : held(kind) ? health.held_hours * HOUR : retryDelay(failures, health);
  c.retry_at = new Date(now.getTime() + delay).toISOString();
  return demoted ? 'demoted' : 'unverified';
}
// 读通了、没有（目标城市的）岗位：记下读过的时间和原因，不算失败、不往失败次数上加。读着的源照旧每轮扫；
// 没读通过的一天后再看。
export function recordQuiet(c, error, { now = new Date(), at = now, health = SOURCE_HEALTH } = {}) {
  now = time(now);
  Object.assign(c, { job_count: 0, http_status: 200, verified_at: time(at).toISOString(), last_error: String(error?.message || error).slice(0, 500), last_error_at: now.toISOString() });
  for (const k of ['error', 'consecutive_failures', 'failing_since']) delete c[k];
  if (c.status === 'verified' || c.status === 'unconfirmed') { delete c.retry_at; return 'quiet'; }
  c.status = 'unverified';
  c.retry_at = new Date(now.getTime() + health.quiet_hours * HOUR).toISOString();
  return 'quiet';
}

// `careers_http_status` stays part of the bar for `verified`: bin/verify-sources.mjs
// confirms the page a person would open. A read without jobs is not proof the
// source broke, so it takes the failure path and its grace period instead of a demotion.
// A read that returns jobs while the careers page is still unchecked (company packs
// carry no careers_http_status) is `unconfirmed`: it works, it is scanned every run
// like a verified source, and it is not a failure (2026-10-01 #7: 26 working sources
// were shown as broken and backed off to one retry every few days).
const CLEAR = ['error', 'retry_at', 'last_error', 'last_error_at', 'consecutive_failures', 'failing_since', 'verification_error'];
export function recordSuccess(c, jobs, { now = new Date(), at = now, health = SOURCE_HEALTH, cityCount } = {}) {
  const wasVerified = c.status === 'verified', wasReading = wasVerified || c.status === 'unconfirmed';
  if (!jobs.length) return recordQuiet(c, Error('no_jobs'), { now, at, health });
  Object.assign(c, { job_count: jobs.length, http_status: 200, verified_at: time(at).toISOString() });
  // 读到的岗位里有几个在目标城市（全球的招聘板：Zilliz 读到 12 个，没有一个在杭州）。
  if (cityCount != null) c.city_count = cityCount; else delete c.city_count;
  for (const k of CLEAR) delete c[k];
  if (c.careers_http_status !== 200) { c.status = 'unconfirmed'; return 'unconfirmed'; }
  c.status = 'verified';
  return wasVerified ? 'verified' : wasReading ? 'confirmed' : 'recovered';
}

// Why a source is or is not working, in plain words, from a discovery report row
// (state/discovery-sources.json) or a config/companies.yaml entry. Old reports
// (before `unconfirmed`) wrote a working read with an unchecked careers page as
// `unverified` with a count and no error; that is read as working too.
//   { state: ok | unconfirmed | failing | broken | paused | new, bad, text, reason }
const REASONS = [
  [/careers_page_unconfirmed/, '官网地址待核实'],
  [/bot_challenge/, '官网有反爬验证，不绕过'],
  [/no_job_list/, '官网没有能自动读的岗位列表'],
  [/department_missing/, '招聘站上找不到设定的部门'],
  [/proxy_and_direct/, '代理和直连都连不上'],
  [/^no_jobs$|no_jobs/, '招聘页上一个岗位都没读到'],
  [/no_hangzhou_jobs|no_city_jobs/, '目标城市没有岗位'],
  [/needs_browser_extraction/, '这个招聘页要用浏览器读，定时扫描读不了'],
  [/source_timeout/, '读取超时（2 分钟没读完）'],
  [/public_http_proxy_failed_/, '代理连不上'],
  [/public_http_transport_|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/, '网络连不上'],
  // 状态码前后不是数字就算（「HTTP 404」「status 404」「http_404」都认，QA 第 2 轮 #12：http_404 原样露了出来）。
  [/(?<!\d)404(?!\d)/, '招聘页不存在了（404）'],
  [/(?<!\d)40[13](?!\d)/, '招聘页拒绝访问'],
  [/(?<!\d)429(?!\d)/, '对方限流了，稍后再读'],
  [/(?<!\d)5\d\d(?!\d)/, '对方服务器出错'],
  [/ENOTFOUND|EAI_AGAIN/, '域名解析不了'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND|unknown ats/i, '没有这种招聘系统的读取方式'],
  [/source_output_limit|too_large/, '返回的内容太大'],
  [/source_result_(missing|invalid)|Unexpected token|JSON/, '读回来的内容看不懂'],
  [/session_expired/, '登录过期了'],
  [/pagination_limit/, '岗位太多，没读完'],
  [/_missing\b/, '招聘页的设置缺了一项，读不了'],
  [/_failed(?:_|\b)/, '招聘系统返回了错误'],
];
// 认不出的程序代码（一串小写字母、数字和下划线）不原样给人看。
const CODE = /^[a-z][a-z0-9_.:-]*$/i;
export function sourceReason(error) {
  const e = String(error || '').trim();
  if (!e) return '';
  // 链接里的数字不算状态码：先去掉链接再认。
  const rest = e.replace(/https?:\/\/\S+/g, '').replace(/[:：]\s*$/, '').trim();
  const hit = REASONS.find(([re]) => re.test(rest));
  if (hit) return hit[1];
  return !rest || CODE.test(rest) ? '读取出错' : `读取出错：${rest.slice(0, 60)}`;
}
// 暂停的原因说成一句人话（10-02 开箱第 2 轮 N08）：你自己写的原因原样给；模板里写给维护的人看的那种（「这个适配器要驱动
// 已登录的 ego 浏览器；要用时删掉这一行」「Cloudflare 返回 HTTP 403」）换成一句用户看得懂的，不露代码、命令、状态码。
const DEV_WORDS = /适配器|adapter|\bego\b|删掉这一行|删除本字段|核实后|\bstat(?:us)?\b|要用时|示例|lib\/|\.m?js\b|\.json\b|cloudflare|HTTP\s*\d{3}|(?<!\d)40[13](?!\d)/i;
export function pauseReason(reason) {
  const r = String(reason ?? '').trim();
  if (/996/.test(r) && /核实|未确认|可能/.test(r)) return '可能 996，尚未核实';
  if (!r || r === '你暂停的') return '';
  if (!DEV_WORDS.test(r)) return r;
  if (/cloudflare|(?<!\d)40[13](?!\d)|拦/i.test(r)) return '网站拦住了自动读取';
  if (/登录|login/i.test(r)) return '要先登录这个网站';
  return '暂时不扫';
}
// 目标城市的说法：「杭州」「杭州、上海」，没配城市时「目标城市」。
function cityWords() {
  let ranked = [];
  try { ranked = rankedCities(); } catch {} // 兜底：读不到求职城市就说「目标城市」
  return ranked.length ? ranked.slice(0, 3).join('、') : '目标城市';
}
// 以前核对时写下的说明（verification_error）。人写的中文说明（「官网无机读岗位列表，社招只在 BOSS 直聘」）比扫描自己的
// 「没读到结构化的岗位」更具体；只有一个代码的（no_hangzhou_jobs：旧的核对命令读通用官网页时的输出，其实什么都没读到）最弱。
const humanNote = (note) => /[\u4e00-\u9fff]/.test(String(note || ''));
const onlyOn = (note) => (String(note || '').match(/(?:社招)?只在\s*([^，。；,;（(\n]{1,20})/)?.[1] || '').trim();
// 一个源现在怎样，一句人话（{ state, bad, text, reason, kind }）：
//   ok / unconfirmed  读到了岗位（全球招聘板顺带说目标城市有几个）
//   quiet             读得通，没有（目标城市的）岗位——不算读不到
//   held              官网有反爬、或者没有能自动读的列表——不绕过，也不是坏了；一周看一次
//   failing           之前正常，这一次没读成，照常扫
//   broken            读不到（bad）：网络不通、招聘页没了、读回来看不懂……
//   paused / new
export function sourceState(s = {}) {
  const count = Number(s.count ?? s.job_count), n = Number.isFinite(count) ? count : null;
  const err = s.error || s.last_error || s.reason || '';
  const note = s.verification_error || '';
  const status = s.status || null;
  const city = Number(s.city_count);
  const cityPart = n > 0 && Number.isFinite(city) && city === 0 ? `，没有${cityWords()}的` : '';
  if (s.paused) { const why = typeof s.paused === 'string' ? pauseReason(s.paused) : ''; return { state: 'paused', bad: false, text: `暂停了${why ? `：${why}` : ''}`, reason: 'paused', kind: null }; }
  const mk = problemKind(err), nk = problemKind(note);
  if (status === 'verified' && s.health !== 'kept' && !(s.consecutive_failures > 0) && !readable(mk)) return { state: 'ok', bad: false, text: n != null ? `读到 ${n} 个岗位${cityPart}` : '正常', reason: null, kind: null };
  if (status === 'unconfirmed' || (status === 'unverified' && n > 0 && (!err || /careers_page_unconfirmed/.test(err)))) return { state: 'unconfirmed', bad: false, text: `读到 ${n ?? 0} 个岗位${cityPart}，官网地址待核实`, reason: 'careers_page_unconfirmed', kind: null };
  const kind = kindOf({ last_error: err, verification_error: note });
  const reason = (kind === nk && kind !== mk ? note : err) || null;
  if (status === 'failing' || s.health === 'kept' || (status === 'verified' && s.consecutive_failures > 0)) return { state: 'failing', bad: false, text: `这次没读成：${sourceReason(err) || '原因没记下'}；之前正常，先照常扫`, reason: err || null, kind: mk };
  if (!status) return { state: 'new', bad: false, text: '还没扫过，下一轮会读', reason: null, kind: null };
  if (kind === 'blocked') return { state: 'held', bad: false, text: '官网有反爬验证，不绕过', reason, kind };
  if (kind === 'no_feed') {
    const where = onlyOn(note), also = nk === 'no_city' && humanNote(note) ? `；核对时没有${cityWords()}的岗位` : '';
    return { state: 'held', bad: false, text: `官网没有能自动读的岗位列表${where ? `，社招只在 ${where}` : ''}${also}`, reason, kind };
  }
  if (kind === 'no_city') {
    // 扫描读通了、只是没有目标城市的岗位：能读。只有以前核对时的说明：照说明说。
    const read = mk === 'no_city';
    // 人写的说明说没有目标城市的岗位，而这一次扫描读到的是「没有能自动读的列表」：两句都说。
    if (!read && mk === 'no_feed') return { state: 'held', bad: false, text: `官网没有能自动读的岗位列表；核对时没有${cityWords()}的岗位`, reason, kind: 'no_feed' };
    return { state: 'quiet', bad: false, text: read ? `能读，没有${cityWords()}的岗位` : `核对时没有${cityWords()}的岗位`, reason, kind };
  }
  if (kind === 'empty') return { state: 'quiet', bad: false, text: '能读，这次一个岗位都没有', reason, kind };
  if (kind === 'network') return { state: 'broken', bad: true, text: `${sourceReason(err)}，下一轮扫描再读`, reason, kind };
  return { state: 'broken', bad: true, text: sourceReason(err) || sourceReason(note) || '没读到岗位', reason: reason || 'no_jobs', kind };
}

// 同一份读取结果在招聘源、上一轮结果和最近运行里说同一件事。
// 保留正常身份的失败源、网站限制也算没读成，不能只数 bad。
export function sourceReadSummary(sources = []) {
  const rows = sources.map(s => s.state ? s : sourceState(s)), unread = rows.filter(s => ['held', 'failing', 'broken'].includes(s.state));
  const groups = new Map();
  for (const s of unread) {
    const why = s.state === 'held' ? '招聘站限制自动读取' : /proxy|代理/i.test(s.reason || s.text) ? '代理连不上' : /403|401|拒绝访问/i.test(s.reason || s.text) ? '招聘页拒绝访问' : /限流|429/i.test(s.reason || s.text) ? '网站限流' : '这次没读成';
    groups.set(why, (groups.get(why) || 0) + 1);
  }
  const advice = [...groups.keys()].map(k => k === '代理连不上' ? '检查代理或换节点，下一轮会再读' : k === '招聘页拒绝访问' || k === '招聘站限制自动读取' ? '招聘页可以手动打开，自动读取会稍后再试' : '稍后再读，已找到的岗位仍可处理');
  return {
    unread: unread.length,
    text: `${rows.filter(s => ['ok', 'unconfirmed', 'quiet'].includes(s.state)).length} 个源读通了${unread.length ? `，${unread.length} 个没读成` : ''}`,
    note: [...groups].map(([why, n]) => `${n} 个${why}`).concat([...new Set(advice)]).join('；'),
  };
}

// A run where nearly every fresh read died in transport says the machine's
// network (DNS, proxy) is down, not that the sources are. Such a run records
// the error but counts toward no demotion and pushes no retry back.
export const transportError = (error) => TRANSPORT.test(error?.message || String(error || ''));
export function networkOutage(outcomes) {
  const fresh = outcomes.filter((o) => !o.reused);
  const down = fresh.filter((o) => o.error && transportError(o.error));
  return fresh.length >= 3 && down.length >= fresh.length * 0.8;
}
export function recordOutage(c, error, { now = new Date() } = {}) {
  Object.assign(c, { last_error: String(error?.message || error).slice(0, 500), last_error_at: time(now).toISOString() });
  delete c.error;
  return c.status === 'verified' || c.status === 'unconfirmed' ? 'kept' : 'unverified';
}

// Normal runs scan every verified or unconfirmed source plus the unverified ones that are due, at most
// `retries_per_run` of them, so a long dead list cannot stretch the cycle. When one is due (dueAt):
// its retry_at; an entry that has none (read once, then parked — the 13 sources of 10-05 sat for two weeks
// waiting for a --retry-unverified nobody runs) is due by its kind after the last time it was read.
// A network failure is due on the very next run and does not count against the budget. Entries never read
// at all (no status: just added by hand) are read once like any other. `paused: <reason>` is a person's
// decision (e.g. a work-schedule rule still unchecked): no mode scans it, even
// when its read would succeed and bin/verify-sources.mjs marks it verified.
const lastRead = (c) => Math.max(0, ...['last_error_at', 'verified_at', 'careers_checked_at'].map((k) => Date.parse(c[k])).filter(Number.isFinite));
// 这一次的结果是网络不通、或者撞上了反爬验证：照这一次说。别的时候，人写的说明比扫描「没读到列表 / 没有岗位」更具体。
export const kindOf = (c) => {
  const mk = problemKind(c.last_error || c.error), nk = problemKind(c.verification_error);
  return mk === 'network' || mk === 'blocked' ? mk : humanNote(c.verification_error) && (held(nk) || nk === 'no_city') ? nk : mk || nk;
};
export function dueAt(c, health = SOURCE_HEALTH) {
  const kind = kindOf(c);
  if (kind === 'network' && (Number(c.consecutive_failures) || 0) <= health.network_retries) return 0;
  if (c.retry_at && Number.isFinite(Date.parse(c.retry_at))) return Date.parse(c.retry_at);
  const hours = held(kind) ? health.held_hours : readable(kind) ? health.quiet_hours : health.retry_cap_hours;
  return lastRead(c) + hours * HOUR;
}
export function selectSources(companies, { retryUnverified = false, now = new Date(), health = SOURCE_HEALTH } = {}) {
  companies = companies.filter((c) => !c.paused);
  if (retryUnverified) return companies.filter((c) => c.status !== 'verified' && c.status !== 'unconfirmed');
  const at = time(now).getTime();
  // An entry a person just added has never been read (no status at all). Read it
  // in the next normal run too, not only under --retry-unverified: a new user
  // edits config/companies.yaml, presses 扫描官方源 and otherwise gets nothing
  // back. After that read it has a status and follows the rules above.
  const fresh = companies.filter((c) => c.status == null);
  const waiting = companies.filter((c) => c.status != null && c.status !== 'verified' && c.status !== 'unconfirmed' && dueAt(c, health) <= at);
  const network = waiting.filter((c) => dueAt(c, health) === 0);
  const due = waiting.filter((c) => dueAt(c, health) !== 0).sort((a, b) => dueAt(a, health) - dueAt(b, health)).slice(0, health.retries_per_run);
  return [...companies.filter((c) => c.status === 'verified' || c.status === 'unconfirmed'), ...fresh, ...network, ...due];
}

// Apply the health fields of scanned entries onto the file as it is now, so an
// entry added or edited while the scan ran is not overwritten by a stale copy.
export function mergeHealth(current, scanned) {
  const byName = new Map(scanned.map((c) => [c.name, c]));
  for (const entry of current) {
    const c = byName.get(entry.name);
    if (!c) continue;
    for (const k of HEALTH_FIELDS) if (c[k] === undefined) delete entry[k]; else entry[k] = c[k];
  }
  return current;
}

// The same merge on the file's text: only the given fields of the scanned
// entries change, everything else in config/companies.yaml — comments, key
// order, entries added while the scan ran — stays as the person wrote it
// (YAML.stringify of the parsed list used to drop every comment on the first
// write-back). A file that is not a plain list falls back to the old rewrite.
export function mergeFieldsText(text, scanned, fields = HEALTH_FIELDS) {
  const doc = YAML.parseDocument(String(text || '[]'));
  if (!YAML.isSeq(doc.contents)) return YAML.stringify(mergeHealth(YAML.parse(String(text || '[]')) || [], scanned));
  const byName = new Map(scanned.map((c) => [c.name, c]));
  for (const item of doc.contents.items) {
    if (!YAML.isMap(item)) continue;
    const c = byName.get(item.get('name'));
    if (!c) continue;
    for (const k of fields) if (c[k] === undefined) item.delete(k); else item.set(k, c[k]);
  }
  return doc.toString();
}

// Bound a whole source, not just each HTTP request/page. Kill its process
// group so a stalled adapter cannot leave curl/browser CLI children behind.
export function fetchSource(company, { timeout = 120000, adapterUrl, maxWait = 10 * 60000 } = {}) {
  const url = adapterUrl || new URL(`./ats/${company.ats_type}.mjs`, import.meta.url).href;
  // 在 politely() 里调用时（bin/discover.mjs）：子进程的每一跳请求经 IPC 回到这里，按网站排队（lib/ats/politeness.mjs），
  // 几个来源同时读同一个网站也照样最多几路、照 Crawl-delay 隔开。在门口等的时间不算这个来源的超时；
  // 碰到 Crawl-delay 超过上限的网站，整个来源这一轮不读（CrawlDelayTooLong），调用的一方不把它当失败。
  // 在门口等也有头：等到了阶段的收尾点（RADAR_MATCH_DEADLINE，周期给的），或一共等了 maxWait，这个来源这一轮
  // 不读完（source_deferred），也不算失败——周期到点会强杀整个扫描，那样已读到的也存不下。
  const store = currentScope();
  // The adapter's own message (e.g. `public_http_transport_6: <url>`) is what
  // lands in companies.yaml last_error, so it is passed up without a stack.
  // 一个岗位都没留下、但看过岗位（都不在目标城市，lib/ats/cn.mjs cityTally）：报 no_city_jobs，扫描记成「能读，没有目标城市的岗位」。
  const tally = JSON.stringify(new URL('./ats/cn.mjs', import.meta.url).href);
  let script = `const {fetchJobs}=await import(process.argv[1]); try { const jobs=await fetchJobs(JSON.parse(process.argv[2])); if(!jobs.length){const {cityTally:t}=await import(${tally}); if(t.seen) throw Error('no_city_jobs: read '+t.seen+', none in the target cities');} console.log('RADAR_SOURCE_RESULT:'+JSON.stringify(jobs)); } catch (e) { console.log('RADAR_SOURCE_ERROR:'+JSON.stringify(String(e?.message||e))); process.exitCode=1; }`;
  const args = [url, JSON.stringify(company)];
  if (store) {
    script = `(await import(process.argv[3])).gateThroughParent(); try { ${script} } finally { process.disconnect(); }`;
    args.push(new URL('./ats/politeness.mjs', import.meta.url).href);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(store ? ['ipc'] : [])] });
    let stdout = '', stderr = '', ended = false, gate = null;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }; // 兜底：进程已经退了就不用再杀
    const finish = (error, jobs) => {
      if (ended) return;
      ended = true; clearTimeout(timer); gate?.close();
      if (error) { kill(); child.stdout.destroy(); child.stderr.destroy(); reject(error); }
      else resolve(jobs);
    };
    let left = timeout, since = Date.now(), timer = null, waited = 0, pausedAt = 0;
    const arm = () => { since = Date.now(); timer = setTimeout(() => finish(Error(`source_timeout:${company.name}:${timeout}ms`)), left); };
    arm();
    const deferred = () => finish(Object.assign(Error(`source_deferred:${company.name}: waited ${Math.round((waited + Date.now() - pausedAt) / 1000)}s for its turn on the site`), { code: 'source_deferred' }));
    const pause = () => {
      clearTimeout(timer); left -= Date.now() - since; pausedAt = Date.now();
      const stop = Date.parse(process.env.RADAR_MATCH_DEADLINE || '');
      timer = setTimeout(deferred, Math.max(0, Math.min(maxWait - waited, Number.isFinite(stop) ? stop - Date.now() : Infinity)));
    };
    const resume = () => { clearTimeout(timer); waited += Date.now() - pausedAt; arm(); };
    if (store) gate = parentGate(child, store, { waiting: (w) => { if (!ended) (w ? pause : resume)(); } });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 64 * 1024 * 1024) finish(Error('source_output_limit')); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (ended) return;
      const over = gate?.overCap();
      if (over) return finish(new CrawlDelayTooLong(over.host, over.crawl_delay));
      if (code !== 0) {
        const reported = stdout.split('\n').find(s => s.startsWith('RADAR_SOURCE_ERROR:'));
        let message = null;
        try { message = reported && JSON.parse(reported.slice('RADAR_SOURCE_ERROR:'.length)); } catch {} // 兜底：报的原因不是 JSON 就用 stderr 的末尾（下一行）
        return finish(Error(message || `source_failed:${company.name}:${stderr.slice(-1000)}`));
      }
      try {
        const rows = stdout.split('\n').filter(s => s.startsWith('RADAR_SOURCE_RESULT:'));
        if (rows.length !== 1) throw Error('source_result_missing');
        const jobs = JSON.parse(rows[0].slice('RADAR_SOURCE_RESULT:'.length));
        if (!Array.isArray(jobs)) throw Error('source_result_invalid');
        finish(null, jobs);
      } catch (error) { finish(error); }
    });
  });
}
