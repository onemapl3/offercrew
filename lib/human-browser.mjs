import { MAIMAI_FRIEND_LIMIT } from './message-limits.mjs';
import { redact } from './error-evidence.mjs';
// Browser-driven discovery of posts a real recruiter wrote.
//
// Mass applying to ATS listings converts badly, so the daily round prioritises
// posts written by a named person: LinkedIn posts, Boss 直聘 HR who post their
// own openings, 脉脉 / 小红书 when a session exists. Everything here is pure —
// bin/discover-human-browser.mjs supplies the pages and writes the evidence.
import { familySession } from './accounts.mjs';
import { hash } from './store.mjs';
import { educationShort, currentRoleShort, outreachExtra, outreachIntro, projectLines, tightCjk } from './facts.mjs';
import { primaryCity, cityEn } from './city.mjs';
import { isGeneral, directionQueries, targetFamilies, adjacentFamilies, FAMILIES, engineeringTracks, DIRECTIONS } from './directions.mjs';
import { currentFacts } from './facts.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { closedByUser, contactLead } from './lead-state.mjs';
import { seekerPost, companyPage, postReason, postLanguage, remotePlaces } from './post-signals.mjs';
export { clusterMaimaiLeads } from './maimai-clusters.mjs';

// LinkedIn searches ask for the newest posts of the past month. The window is
// also the only bound on a post whose card shows no readable age
// (linkedinPostDate below), so it must stay on every LinkedIn search.
const LINKEDIN_WINDOW = 'past-month';
const linkedinSearch = (query) => `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&datePosted=%22${LINKEDIN_WINDOW}%22&sortBy=%22date_posted%22`;

// Each source declares where to look and what a result row looks like once the
// page script has scraped it. A source whose domain has no session is skipped
// rather than half-scraped behind a login wall.
// The searches name the first target city (lib/city.mjs, e.g. 杭州). Boss
// filters by its own city code; a city missing from BOSS_CITY searches nationwide.
const BOSS_CITY = { 北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100', 杭州: '101210100', 宁波: '101210400', 苏州: '101190400', 南京: '101190100', 无锡: '101190200', 合肥: '101220100', 武汉: '101200100', 长沙: '101250100', 广州: '101280100', 深圳: '101280600', 成都: '101270100', 西安: '101110100', 厦门: '101230200' };
// 主方向不是软件的人（lib/directions.mjs）：搜的词换成自己方向的（「招聘 投行」「hiring analyst」），来源不变。
// 这些来源默认都关着（config/human-source-policy.json），而且只读你自己登录的浏览器里能看到的帖子，不打招呼、不群发。
function generalSources(city, facts) {
  const at = (q) => (city ? `${city} ${q}` : q);
  const en = cityEn(city) || (/^[A-Za-z .'-]+$/.test(String(city || '')) ? city : '');
  const eng = engineeringTracks(facts);
  const zh = directionQueries(facts, 'zh').slice(0, 4), english = eng.length ? eng.slice(0, 3).map((t) => `${DIRECTIONS.software.tracks[t].en} engineer`) : directionQueries(facts, 'en').slice(0, 3);
  const boss = BOSS_CITY[city] ? `&city=${BOSS_CITY[city]}` : '';
  return [
    { name: 'linkedin', domain: 'www.linkedin.com', requires_session: true, source_type: '真人直招帖',
      searches: [...zh.slice(0, 2).map((q) => at(`招聘 ${q}`)), ...english.map((q) => `${en ? en + ' ' : ''}hiring ${q}`)].map(linkedinSearch) },
    { name: 'boss', domain: 'www.zhipin.com', requires_session: true, source_type: 'Boss直聘HR直发',
      searches: zh.slice(0, 3).map((q) => `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(q)}${boss}`) },
    { name: 'maimai', domain: 'maimai.cn', requires_session: true, source_type: '真人招聘帖',
      searches: [...zh.map((q) => at(`招聘 ${q}`)), at('内推')].map((query) => `https://maimai.cn/web/search_center?type=feed&query=${encodeURIComponent(query)}&highlight=true`) },
    { name: 'xiaohongshu', domain: 'www.xiaohongshu.com', requires_session: true, source_type: '真人内推帖', searches: zh.slice(0, 1).map((q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(`内推 ${q}`)}`) },
  ];
}
function browserSources(city = primaryCity()) {
  const facts = currentFacts();
  // 通用方向，或选了子方向的工程师：按方向 / 子方向的词搜。没选子方向的工程师（作者本人）还是下面这一套。
  if (isGeneral(facts) || engineeringTracks(facts).length) return generalSources(city, facts);
  const at = (q) => (city ? `${city} ${q}` : q);
  const en = cityEn(city);
  const boss = BOSS_CITY[city] ? `&city=${BOSS_CITY[city]}` : '';
  return [
  {
    name: 'linkedin',
    domain: 'www.linkedin.com',
    requires_session: true,
    source_type: '真人直招帖',
    searches: [at('招聘 AI Agent'), at('招聘 后端 全栈'), at('大模型 应用 内推'), `${en ? en + ' ' : ''}hiring software engineer`, 'hiring LLM engineer China remote', 'hiring AI agent worldwide remote']
      .map(linkedinSearch),
  },
  {
    name: 'boss',
    domain: 'www.zhipin.com',
    requires_session: true,
    source_type: 'Boss直聘HR直发',
    // Boss shows the poster's identity and last-active time on the job card.
    searches: [
      `https://www.zhipin.com/web/geek/jobs?query=AI%20Agent${boss}`,
      `https://www.zhipin.com/web/geek/jobs?query=大模型%20应用${boss}`,
      `https://www.zhipin.com/web/geek/jobs?query=%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91${boss}`,
    ],
  },
  {
    name: 'maimai', domain: 'maimai.cn', requires_session: true, source_type: '真人招聘帖',
    // Cover every query, then follow visible pages while new candidates appear.
    // Detail reads have their own wall-clock share, never a leftover page count.
    // The feed search requires every word and returns about ten posts newest
    // first: on 2026-09-23 three- and four-word queries returned 0–4 posts,
    // mostly a year old, so each query here is two words (city + one topic).
    searches: [
      ...[at('招聘 Agent'), at('招聘'), at('内推'), at('大模型'), at('全栈'), at('后端'), '远程 Agent', '远程 后端']
        .map(query => `https://maimai.cn/web/search_center?type=feed&query=${encodeURIComponent(query)}&highlight=true`),
      ...[at('招聘 Agent'), at('内推')].map(query => `https://maimai.cn/search/gossips?query=${encodeURIComponent(query)}`),
    ],
  },
  { name: 'xiaohongshu', domain: 'www.xiaohongshu.com', requires_session: true, source_type: '真人内推帖', searches: ['https://www.xiaohongshu.com/search_result?keyword=%E5%86%85%E6%8E%A8%20AI%20%E5%B7%A5%E7%A8%8B%E5%B8%88'] },
  ];
}
export const BROWSER_SOURCES = browserSources();

// 登录态按账号看（lib/accounts.mjs familySession）：工作台「我登好了」记的是 linkedin.com，
// 这里的来源写的是 www.linkedin.com，以前两边对不上，登录了也永远跳过。
export const sessionReady = (source, sessions = {}) =>
  !source.requires_session || !!(sessions.domains || {})[source.domain]?.logged_in || !!familySession(source.domain, sessions)?.logged_in;

export const availableSources = (sessions = {}, names = null) =>
  BROWSER_SOURCES.filter((s) => (!names || names.includes(s.name)) && sessionReady(s, sessions));

// A recruiter who is a person, not a careers-page byline. Only the author's own
// name and title are examined: the post body says "招聘" either way.
// 「某某 Opportunities Hub」这类转发岗位的页面也不是人（2026-10-05 #524）。
const ORG_NAME = /公司|科技|有限|集团|官方|招聘助手|人才库|careers?|jobs?|talent acquisition|opportunit|\bhub\b|staffing|recruit(?:ing|ment)\b|vacanc|\b(?:inc|ltd|llc|gmbh|group|corp|co)\b/i;
const PERSON_TITLE = /HR|recruit|talent|猎头|人事|负责人|招聘|founder|创始|CTO|CEO|总监|经理|主管|manager|lead|engineer|工程师/i;
export function namedPerson(post = {}) {
  const name = String(post.author || '').trim();
  if (!name || ORG_NAME.test(name) || companyPage(post.author_url)) return false;
  if (PERSON_TITLE.test(String(post.author_title || ''))) return true;
  return /^[\u4e00-\u9fa5]{2,4}$/.test(name) || /^[A-Za-z][\w.'-]*\s+[A-Za-z][\w.'-]*/.test(name);
}

// A post by someone looking for work is not an opening, however many hiring
// words it contains. It only survives if it also plainly offers a role
// (lib/post-signals.mjs seekerPost: open to work, #OpenToWork, 求职, 求内推,
// a headline that says 「Available Immediately」……).
const HIRING = /招聘|招人|内推|急招|岗位职责|任职要求|简历|投递|hiring|we(?:'re| are) hiring|join (?:us|our)|looking for/i;
const TARGET_ROLE = /agent|LLM|大模型|AI\s*应用|后端|全栈|开发工程师|平台|backend|full.?stack|software engineer|developer|infra/i;
// 通用路径：帖子里提到的岗位落在你方向以内或相邻的类别（lib/directions.mjs 的标题词）才算目标岗位。
const targetRole = () => {
  const facts = currentFacts();
  const eng = engineeringTracks(facts);
  if (eng.length) return new RegExp([...eng.map((t) => DIRECTIONS.software.tracks[t].title.source), '开发工程师|software engineer|developer'].join('|'), 'i');
  if (!isGeneral(facts)) return TARGET_ROLE;
  const fams = [...targetFamilies(facts), ...adjacentFamilies(facts)].map((f) => FAMILIES[f]?.title).filter(Boolean);
  return new RegExp(fams.map((re) => re.source).join('|'), 'i');
};
const CLOSED = /已招满|招聘结束|职位关闭|已下线|no longer hiring|position filled/i;
const MAIMAI_RECRUITER = /猎头|HR|招聘|人力|Recruiter|HRBP/i;
const MAIMAI_HIRING = /招聘|内推|HC|急招/i;

// Snippets can omit the entire opening. Only stable, cheap gates run before
// fetching a detail; length, city and role are evaluated against the full body.
export function maimaiDetailEligible(post = {}, { now = Date.now() } = {}) {
  const at = Date.parse(post.posted_at);
  const body = String(post.body || '');
  return post.anonymous !== true && !!String(post.author || '').trim() && !ORG_NAME.test(post.author)
    && !!post.id && detailNavigable(post.url, { name: 'maimai', domain: 'maimai.cn' })
    && Number.isFinite(at) && at <= now && now - at <= 30 * 86400000
    && (MAIMAI_RECRUITER.test(post.author_title || '') || MAIMAI_HIRING.test(body))
    && !CLOSED.test(body) && !seekerPost({ body, author_title: post.author_title });
}

// A partial source is not a completed scan. Also reject old cached summaries
// which recorded a stopped Maimai detail pass as done for the interval.
export function browserScanComplete(result = {}) {
  return (!result.status || ['checked', 'done_today'].includes(result.status))
    && !result.reason && !result.error && !result.detail_stopped && !result.detail_pending && !result.search_pending
    && !result.detail_errors?.length && !result.date_errors?.length;
}

// One scraped row becomes a lead, or nothing. The rules mirror
// lib/human-discovery.humanLead: a named author, a dated post, a real opening.
export function classifyPost(post = {}, source = {}, { now = Date.now(), evidence = null, maxAgeDays = 30 } = {}) {
  const maimai = source.name === 'maimai';
  const anonymous = maimai && post.anonymous === true;
  const author = String(post.author || '').trim();
  const body = String(post.body || '').trim();
  const bodyLines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = maimai ? (bodyLines[0] || '').slice(0, 120) : post.title || '';
  const all = maimai ? body : `${title}\n${body}`;
  const at = Date.parse(post.posted_at);
  const reject = (reason) => ({ lead: null, reason });
  if (!author) return reject('missing_author');
  if (!body || body.length < (maimai ? 20 : 60)) return reject('short_body');
  if (!/^https?:\/\//.test(String(post.url || ''))) return reject('bad_url');
  if (!Number.isFinite(at)) return reject('missing_date');
  if (at > now) return reject('future_date');
  if (now - at > maxAgeDays * 86400000) return reject('stale_date');
  if (CLOSED.test(all)) return reject('closed');
  const recruiter = MAIMAI_RECRUITER.test(post.author_title || '');
  if (maimai ? !(recruiter || MAIMAI_HIRING.test(all)) : !HIRING.test(all)) return reject('not_hiring');
  const TARGET = targetRole();
  if (!TARGET.test(all)) return reject('not_target_role');
  if (seekerPost({ body: all, author_title: post.author_title })) return reject('seeking');
  // A company careers byline is not a person to write to.
  if (maimai ? (!anonymous && ORG_NAME.test(author)) : !namedPerson(post)) return reject('not_person');
  if (maimai && !post.id) return reject('missing_post_id');
  const cities = [...new Set(all.match(/上海|杭州|苏州|北京|深圳|成都|\b(?:Shanghai|Hangzhou|Suzhou|Beijing|Shenzhen|Chengdu)\b/gi) || [])];
  const remote = /远程|remote/i.test(all);
  const needsCityCheck = !cities.length && !remote;
  if (needsCityCheck && (!maimai || anonymous)) return reject('no_city');
  // 远程、却写明了在中国以外（「remote Eastern Time role, ideally based near Charlotte, NC」）：地点照写，预筛按你能工作的地区看。
  const abroad = remote && !cities.length ? remotePlaces(all) : [];
  const email = all.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || null;
  const role = String(maimai ? bodyLines.find(line => TARGET.test(line)) || title : post.role || title).replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!role || !TARGET.test(maimai ? all : role)) return reject('role_not_target');
  const lead = {
    company: String(post.company || '').trim() || `待核（${author}）`,
    role,
    location: needsCityCheck ? '未标注' : [...cities, ...abroad, remote ? '远程' : null].filter(Boolean).join(' / '),
    url: post.url,
    source: maimai ? '脉脉' : source.name,
    source_job_id: `${source.name}:${post.id}`,
    source_type: maimai ? (anonymous ? '内推帖' : '真人招聘帖') : source.source_type,
    human: !anonymous,
    author,
    author_title: post.author_title || null,
    ...(maimai && post.author_affiliation ? { author_affiliation: post.author_affiliation } : {}),
    contact_profile_url: post.author_url || null,
    posted_at: new Date(at).toISOString(),
    ...(post.posted_at_estimated ? { posted_at_estimated: true, posted_within_days: post.posted_within_days } : {}),
    jd_text: all,
    original_body: body,
    evidence,
    content_hash: hash(body),
    ...(maimai ? {
      title,
      ...(needsCityCheck ? { needs_city_check: true } : {}),
      profile_url: anonymous ? null : post.profile_url,
      contact_profile_url: anonymous ? null : post.profile_url,
      text: body,
      ...(post.detail_evidence ? { detail_evidence: post.detail_evidence } : {}),
      anonymous,
      contact_channel: anonymous ? null : 'maimai_friend_request',
      assisted_only: true,
    } : {}),
    // An address in the post is a contact the person published. Without one the
    // only route is a platform message, which the user has to approve first.
    ...(maimai ? { entry_type: anonymous ? '匿名线索' : '脉脉加好友' } : email ? { email, entry_type: '邮箱' } : { entry_type: source.name === 'boss' ? 'Boss直聘私信' : source.name === 'linkedin' ? 'LinkedIn 私信' : '平台私信' }),
  };
  return { lead, reason: null };
}

export function browserLead(post = {}, source = {}, opts = {}) {
  return classifyPost(post, source, opts).lead;
}

export function summarizeRejections(items) {
  const summary = { total: items.length, accepted: 0, rejected: {} };
  for (const { lead, reason } of items) {
    if (lead) summary.accepted++;
    else summary.rejected[reason] = (summary.rejected[reason] || 0) + 1;
  }
  return summary;
}

// Calendar-only dates use Shanghai midnight; relative durations retain the
// supplied clock time. Never let Date.parse guess the host's local timezone.
export function parsePostedAt(label, now = Date.now()) {
  const clock = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
  if (!Number.isFinite(clock)) return null;
  // Preserve prefixed day words and spaced duration units when trimming regions.
  const text = String(label ?? '').trim().replace(/^(?:编辑于|发布于)\s*/, '').trim()
    .replace(/\s+(?!(?:分钟|小时|天)前$)[\u4e00-\u9fff]{2,8}$/, '');
  const iso = (value) => Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? new Date(value).toISOString() : null;
  const englishRelative = text.match(/^(\d+)\s*(m|h|d|w|mo|minutes?|hours?|days?|weeks?|months?)(?:\s+ago)?(?:\s*[•·].*)?$/i);
  if (englishRelative) { const unit = englishRelative[2].toLowerCase(), days = /^mo/.test(unit) ? 30 : /^w/.test(unit) ? 7 : /^d/.test(unit) ? 1 : /^h/.test(unit) ? 1/24 : 1/1440; return iso(clock - Number(englishRelative[1]) * days * 86400000); }
  if (text === '刚刚') return iso(clock);
  const relative = text.match(/^(\d+)\s*(分钟|小时|天)前$/);
  if (relative) return iso(clock - Number(relative[1]) * ({ 分钟: 60000, 小时: 3600000, 天: 86400000 }[relative[2]]));
  const local = new Date(clock + 8 * 3600000);
  const calendar = (year, month, day) => {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? date.getTime() - 8 * 3600000 : NaN;
  };
  if (text === '昨天' || text === '前天') {
    return iso(calendar(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate()) - (text === '昨天' ? 1 : 2) * 86400000);
  }
  const dayTime = text.match(/^(今天|昨天|前天)\s+(\d{2}):(\d{2})$/);
  if (dayTime) {
    if (+dayTime[2] > 23 || +dayTime[3] > 59) return null;
    return iso(calendar(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate())
      - ({ 今天: 0, 昨天: 1, 前天: 2 }[dayTime[1]]) * 86400000
      + Number(dayTime[2]) * 3600000 + Number(dayTime[3]) * 60000);
  }
  const chinese = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (chinese) return iso(calendar(...chinese.slice(1).map(Number)));
  const dated = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/i);
  if (dated) {
    const midnight = calendar(...dated.slice(1, 4).map(Number));
    if (!Number.isFinite(midnight)) return null;
    if (!dated[4]) return iso(midnight);
    if (+dated[4] > 23 || +dated[5] > 59 || +(dated[6] || 0) > 59) return null;
    return iso(Date.parse(`${text.slice(0, 10)}T${dated[4]}:${dated[5]}:${dated[6] || '00'}${dated[7] || ''}${dated[8] || '+08:00'}`));
  }
  const monthDay = text.match(/^(\d{1,2})-(\d{1,2})$/);
  const english = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i);
  if (!monthDay && !english) return null;
  const month = monthDay ? +monthDay[1] : 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(english[1].toLowerCase()) + 1;
  const day = +(monthDay ? monthDay[2] : english[2]);
  // Searching backward also handles Feb 29 across non-leap years.
  for (let year = local.getUTCFullYear(); year >= local.getUTCFullYear() - 8; year--) {
    const at = calendar(year, month, day);
    if (Number.isFinite(at) && at <= clock) return iso(at);
  }
  return null;
}

// Keep the original label alongside the first usable date, in selector order.
export function pickPostedAt(labels = [], now = Date.now()) {
  for (const posted_label of labels) {
    const posted_at = parsePostedAt(posted_label, now);
    if (posted_at) return { posted_at, posted_label };
  }
  return null;
}

// ---- LinkedIn post dates -------------------------------------------------
// A card's age ("3d", "5h •", "Edited • 1w", "3 days ago", "2 周"). Units LinkedIn
// prints but parsePostedAt does not know (yr, 周, 个月) are read here so the
// other sites keep their parser unchanged.
const LI_UNIT = [[/^(?:m|mins?|minutes?|分钟)$/i, 60000], [/^(?:h|hrs?|hours?|小时)$/i, 3600000], [/^(?:d|days?|天)$/i, 86400000],
  [/^(?:w|wks?|weeks?|周)$/i, 7 * 86400000], [/^(?:mo|mos|months?|个月|月)$/i, 30 * 86400000], [/^(?:y|yrs?|years?|年)$/i, 365 * 86400000]];
export function linkedinAge(label, now = Date.now()) {
  for (const part of String(label ?? '').split(/[•·]/).map((p) => p.replace(/[\u200b-\u200f\u2060\ufeff]/g, '').trim())) {
    if (/^(?:just now|刚刚)$/i.test(part)) return new Date(now).toISOString();
    const m = part.match(/^(\d+)\s*([a-z]+|分钟|小时|天|周|个月|月|年)(?:\s+ago|前)?$/i);
    const unit = m && LI_UNIT.find(([re]) => re.test(m[2]));
    if (unit) return new Date(now - Number(m[1]) * unit[1]).toISOString();
  }
  return null;
}

// LinkedIn post ids (urn:li:activity / share / ugcPost, and the "-activity-<id>-"
// part of a /posts/ link) keep the creation time in milliseconds in their top
// 41 bits. An id before 2015 (or, in linkedinPostDate, after now) is not trusted.
export function linkedinIdTime(...values) {
  for (const value of values) {
    let text = String(value ?? '');
    try { text = decodeURIComponent(text); } catch {} // 兜底：不是合法的编码就按原样用
    const id = text.match(/urn:li:(?:activity|share|ugcPost):(\d{16,20})/)?.[1] || text.match(/[-_]activity-(\d{16,20})(?:-|$|[/?#])/)?.[1];
    if (!id) continue;
    const at = Number(BigInt(id) >> 22n);
    if (at >= Date.UTC(2015, 0, 1)) return at;
  }
  return null;
}

// Days covered by a LinkedIn search's 「发布时间」 filter, or null without one.
export function linkedinWindowDays(url) {
  try {
    const value = new URL(url).searchParams.get('datePosted')?.replace(/"/g, '');
    return { 'past-24h': 1, 'past-week': 7, 'past-month': 30 }[value] || null;
  } catch { return null; } // 兜底：解析不了就是没有发布时间筛选
}

// Exact first: the card's own <time>, then the post id, then the printed age.
// A post with none of those, found by a search limited to the past N days, is
// dated N days back (the oldest it can be) and marked as an estimate, so it
// reaches the judgement instead of being dropped, and nothing reads it as
// newer than it may be. Without a window it stays undated (missing_date).
export function linkedinPostDate(post = {}, now = Date.now()) {
  if (Number.isFinite(Date.parse(post.posted_at))) return { posted_at: post.posted_at, posted_at_source: 'time' };
  const fromId = linkedinIdTime(post.url, post.id);
  if (fromId != null && fromId <= now + 3600000) return { posted_at: new Date(Math.min(fromId, now)).toISOString(), posted_at_source: 'post_id' };
  const fromLabel = linkedinAge(post.posted_label, now);
  if (fromLabel) return { posted_at: fromLabel, posted_at_source: 'label' };
  const days = linkedinWindowDays(post.search_url);
  if (days) return { posted_at: new Date(now - days * 86400000).toISOString(), posted_at_source: 'search_window', posted_at_estimated: true, posted_within_days: days };
  return null;
}

export function detailNavigable(url, source) {
  try {
    const parsed = new URL(url);
    if (source.name === 'maimai') return parsed.origin === 'https://maimai.cn' && !parsed.username && !parsed.password
      && parsed.pathname === '/web/feed_detail' && !!parsed.searchParams.get('fid');
    return parsed.origin === `https://${source.domain}` && !parsed.username && !parsed.password
      && /^\/(?:explore|search_result)\/[^/]+\/?$/.test(parsed.pathname);
  } catch { return false; } // 兜底：解析不了的地址不去打开
}

// Pure transition: each response breaks the failure streak; a failure or a
// nonempty response breaks the empty-label streak. A stopped phase stays stopped.
export function detailBreaker(state = {}, outcome) {
  if (state.stopped) return { ...state };
  const failures = outcome === 'failed' ? (state.failures || 0) + 1 : 0;
  const emptyLabels = outcome === 'empty' ? (state.emptyLabels || 0) + 1 : 0;
  const reason = failures >= 2 ? 'detail_consecutive_failures'
    : emptyLabels >= 3 ? 'detail_empty_labels:possible_login_overlay' : null;
  return { failures, emptyLabels, stopped: !!reason, reason };
}

const DM_LIMIT = 300;
// 私信里怎么称呼岗位（2026-10-05 #523 #524：以前把帖子第一行原样塞进句子，「看到您发的I'm open to new opportunities in …」）。
// 帖子标题够短、像个岗位名，就用它（去掉【】、括号、「招聘」「Hiring:」这类前缀，只取第一个分句）；不像就退到帖子里认得的
// 方向词（「后端」「LLM」）；什么都认不出就说「招聘帖」。
const ROLE_NOUN_ZH = /(?:工程师|开发|架构师|专家|经理|分析师|研究员|设计师|顾问|专员|实习生|岗位|岗|职位|负责人|总监|主管|leader|Leader)$/;
const ACRONYM = /^(?:AI|LLM|LLMs|ML|NLP|RAG|GenAI|AIGC|SRE|QA|API|SaaS|AWS|GCP|iOS|C\+\+|C#|\.NET|HR|PM|UX|UI|CV|B2B|IT|AGI|MLOps|DevOps)$/i;
const FIRST_PERSON = /\b(?:I|I'm|I’m|my|me|we|our|us)\b|我|咱/i;
// 标题的每个分句（第一行里，按标点、破折号断开），去掉【】、括号、话题标签和「招聘」「We're hiring」这类前缀。
function roleClauses(raw) {
  const line = String(raw || '').split(/\r?\n/)[0].replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ').replace(/#\S+/g, ' ');
  return line.split(/[。！？!?；;，,｜|]|\s[—–-]+\s|\s?—\s?/).map((c) => c
    .replace(/^\s*(?:(?:高薪|急|诚|热|直)?招聘?|内推|(?:we(?:'re|’re| are)\s+|now\s+)?hiring|job opening|opening)\s*(?:[:：!！]\s*)?(?:(?:an?|for)\s+)?/i, '')
    .replace(/\s+/g, ' ').trim().replace(/^[:：\-–—·•\s]+|[:：\-–—·•\s]+$/g, '')
    .replace(/\b(engineer|developer|architect|scientist|analyst|designer)s\b/gi, '$1')).filter(Boolean);
}
export function roleWords(lead = {}, lang = 'zh') {
  const TARGET = targetRole();
  const fits = (t) => (lang === 'en' ? t.split(/\s+/).length <= 6 && t.length <= 48 : [...t].length >= 2 && [...t].length <= 24) && !FIRST_PERSON.test(t) && TARGET.test(t);
  const text = `${lead.role || ''}\n${lead.original_body || lead.jd_text || ''}`;
  let phrase = roleClauses(lead.role).find(fits) || '';
  // 标题不像岗位名：英文找正文里的「<一两个词> Engineer / Developer」，再不行取认得的方向词（取整个词，「Agentic」不截成「Agent」）。
  if (!phrase && lang === 'en') phrase = [...text.matchAll(/\b(?:[A-Za-z][\w+#.]*\s){0,2}(?:engineer|developer|architect|scientist)\b/gi)]
    .map((m) => m[0].replace(/^(?:(?:a|an|the|as|for|of|our|your|to|and|or|with|is|are|hiring|seeking|looking)\s)+/i, '').trim()).find((t) => t && TARGET.test(t)) || '';
  if (!phrase) {
    const m = text.match(TARGET);
    // 方向词只是另一个词的一部分（「Agentic」里的 agent）：不拿它当岗位，说「招聘帖」。
    const whole = m && !(/[A-Za-z]/.test(m[0]) && (/[A-Za-z0-9]$/.test(text.slice(0, m.index)) || /^[A-Za-z0-9]/.test(text.slice(m.index + m[0].length))));
    phrase = whole ? m[0].trim() : '';
  }
  if (!phrase) return '';
  // 全大写的标题（「AI + SOFTWARE ENGINEERING」）在句子里写成小写，缩写照旧大写。
  if (lang === 'en' && phrase === phrase.toUpperCase() && /[A-Z]{3}/.test(phrase)) phrase = phrase.split(' ').map((w) => (ACRONYM.test(w) ? w.toUpperCase().replace('LLMS', 'LLMs') : w.toLowerCase())).join(' ');
  if (lang === 'en') return `the ${phrase}${/\b(?:role|position|opening)$/i.test(phrase) ? '' : ' role'}`;
  return `${tightCjk(phrase)}${ROLE_NOUN_ZH.test(phrase) ? '' : '岗位'}`;
}

// 一段一段往上拼，超出字数就先丢后面列着的可选句（必须有的几句不丢）。
function fitParts(parts, limit) {
  const keep = parts.map(() => true);
  const join = () => parts.filter((p, i) => keep[i] && p.text).map((p) => p.text).join('');
  for (const i of parts.map((p, i) => [p.drop ?? -1, i]).filter(([d]) => d >= 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if ([...join()].length <= limit) break;
    keep[i] = false;
  }
  return join();
}
const LATIN = /^[\x20-\x7e’]+$/;
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

// The message the user reviews before anything is sent. Short, specific, and
// built only from facts already on the lead and in candidate/facts.yaml.
// 语言跟着对方的帖子走：英文帖写英文（facts.yaml 里的英文说法：name_en、experience_summary.outreach_wording_en、
// outreach.education_en / current_role_en / extra_en，缺哪句就不写哪句），中文帖写中文。
export function platformMessage(lead = {}, facts = {}) {
  const lang = postLanguage(lead.original_body || lead.jd_text || lead.role || '');
  const body = lang === 'en' ? englishMessage(lead, facts) : chineseMessage(lead, facts);
  return { body: body.slice(0, DM_LIMIT), lang, platform: lead.entry_type || '平台私信', profile_url: lead.contact_profile_url || lead.url, within_limit: body.length <= DM_LIMIT };
}
function chineseMessage(lead, facts) {
  const id = facts.identity || {};
  const summary = facts.experience_summary?.outreach_wording || '';
  const city = (facts.location?.target_cities || []).join('、');
  const intro = [tightCjk(educationShort(facts)), summary].filter(Boolean).join('，');
  const current = tightCjk(currentRoleShort(facts));
  const work = [current ? `现职做${current}` : '', tightCjk(outreachExtra(facts))].filter(Boolean).join('，');
  const role = roleWords(lead, 'zh');
  return fitParts([
    { text: `${lead.author || '您好'}，${role ? `看到您在招${role}` : '看到您发的招聘信息'}。` },
    // 学历、现职与补充的一句来自 facts.yaml `outreach`；私信里汉字和字母之间不留空格。
    { text: `我是${id.name_zh || id.name_en}${intro ? '，' + intro : ''}。` },
    { text: work ? work + '。' : '', drop: 1 },
    { text: `${city ? `目标城市${city}，` : ''}接 offer 后约 ${facts.availability?.notice_period_days ?? 30} 天可到岗。`, drop: 0 },
    { text: '方便的话我把简历发您看看？' },
  ], DM_LIMIT);
}
function englishMessage(lead, facts) {
  const id = facts.identity || {};
  const o = facts.outreach || {};
  const en = (v) => (LATIN.test(String(v || '').trim()) ? String(v).trim() : '');
  const author = String(lead.author || '').trim();
  const first = /^[A-Za-z]/.test(author) ? author.split(/\s+/)[0] : author;
  const role = roleWords(lead, 'en');
  const summary = en(facts.experience_summary?.outreach_wording_en);
  const education = en(o.education_en);
  const title = en(facts.current_work?.title);
  const company = en(facts.current_work?.company);
  const work = en(o.current_role_en) ? `I currently work on ${en(o.current_role_en)}.` : title ? `I'm currently ${article(title)} ${title}${company ? ` at ${company}` : ''}.` : '';
  const cities = (facts.location?.target_cities || []).map((c) => cityEn(c) || en(c)).filter(Boolean);
  const where = cities.length ? `I'm looking at roles in ${cities.length > 1 ? `${cities.slice(0, -1).join(', ')} or ${cities.at(-1)}` : cities[0]}, and ` : 'I ';
  return fitParts([
    { text: `Hi${first ? ' ' + first : ''}, ${role ? `I saw your post about ${role}` : 'I saw your recent hiring post'}. ` },
    { text: `I'm ${en(id.name_en) || id.name_zh || ''}${education ? `, ${education}` : ''}${summary ? `, with ${summary}` : ''}. `.replace(/^I'm , /, "I'm ") },
    { text: work ? work + ' ' : '', drop: 2 },
    { text: en(o.extra_en) ? en(o.extra_en).replace(/[.\s]*$/, '. ') : '', drop: 3 },
    { text: `${where}can start about ${facts.availability?.notice_period_days ?? 30} days after an offer. `.replace(/^I can/, 'I can'), drop: 1 },
    { text: 'Could I send you my resume?' },
  ], DM_LIMIT);
}

// One draft row per lead with no published address, so the existing draft-review
// card shows the full text and only a user's 「发 编号」 releases it.
export function platformDraft(lead, facts, { now = Date.now() } = {}) {
  const maimai = lead.source === '脉脉' || lead.source === 'maimai';
  if (lead.prefilter_reason || postReason(lead)) return null;
  if (maimai && (lead.anonymous || lead.source_type !== '真人招聘帖' || !lead.profile_url)) return null;
  if (lead.email) return null;
  const message = maimai ? maimaiFriendMessage(lead, facts) : platformMessage(lead, facts);
  if (!message || companyPage(message.profile_url)) return null;
  const record = lead.record_id || lead.id;
  return {
    record_id: record,
    number: lead.number,
    draft_id: 'dm-' + hash([record, message.body]).slice(0, 24),
    channel: maimai ? 'maimai_friend_request' : 'platform_dm',
    platform: message.platform,
    to: message.profile_url,
    subject: `${lead.company} · ${lead.role}`,
    body: message.body,
    attachments: [],
    purpose: 'application',
    status: 'ready',
    created_at: new Date(now).toISOString(),
  };
}

// Keep the first project in the user's positioning, with room for the actual
// post keyword. Missing positioning or wording is a missing draft, never
// invented facts: the self-introduction and the project line are the user's own
// (facts.yaml outreach.intro / project_line / project_line_short).
export function maimaiFriendMessage(lead = {}, facts = {}) {
  const positioning = facts.positioning || {};
  const intro = outreachIntro(facts), lines = projectLines(facts);
  if (!intro) return null;
  const project = String(positioning.project_priority?.[0]?.name || '').split(/[（(]/)[0].trim();
  const keyword = String(lead.role || lead.text || '').match(isGeneral(facts) ? targetRole() : /(?:AI\s*)?Agent|大模型|AI\s*应用|LLM|全栈|后端|开发工程师|backend|developer|infra|平台/i)?.[0];
  if (!project || !keyword) return null;
  // 现居城市和想去的城市都来自 facts.yaml；缺一个就只用不提城市的那一句。
  const here = String(facts.location?.current_city || '').trim();
  const target = (facts.location?.target_cities || []).map(String).find((c) => c !== here) || '';
  const kw = keyword.replace(/\s+/g, '');
  const say = (...parts) => `您好，看到您招${kw}。${parts.filter(Boolean).join('，')}，想加好友了解岗位。`;
  const long = say(intro, lines.long, `在${here}、可去${target}`);
  const short = say(intro, lines.short, `在${here}可去${target}`);
  const compact = say(intro, lines.short);
  const body = (here && target ? [long, short, compact] : [compact]).find(text => [...text].length <= MAIMAI_FRIEND_LIMIT);
  if (!body) return null;
  return { body, platform: '脉脉加好友附言', profile_url: lead.profile_url, within_limit: true };
}

// Drafts written at discovery wait for the judgement: a friend request or a
// platform message is only worth reviewing for a lead Jev kept. Discovery
// stores them as `awaiting_judgement`, which no card, list or sender shows
// (they all require `ready`); bin/judge-leads.mjs then promotes the drafts of
// leads judged recommend/verify and cancels those of leads it retired. A ready
// draft whose lead was retired later is cancelled too, unless the user chose to
// contact that lead or already approved the send.
export const AWAITING_JUDGEMENT = 'awaiting_judgement';
const PLATFORM_CHANNELS = ['maimai_friend_request', 'platform_dm'];
const DRAFT_PURPOSES = ['application', 'referral'];
const SETTLED_REQUEST = /^(?:sent|failed|cancelled|rejected|expired)$/;
export function retiredReason(l = {}) {
  if (l.superseded || l.status === 'superseded') return 'superseded';
  if (closedByUser(l)) return 'passed';
  if (excludedCompany(l)) return 'company_excluded_by_user';
  // 求职者自己的帖子、公司主页发的帖子（lib/post-signals.mjs）：入库时没认出来的，这里收回。
  const post = postReason(l);
  if (post) return post;
  if (l.prefilter_reason && l.prefilter_reason !== 'china_remote_unverified') return l.prefilter_reason;
  if (l.match?.verdict === 'exclude') return 'verdict_exclude';
  return null;
}
// 收件箱里还没批准、没改过的首联私信，是以前那套模板写的（「看到您发的<帖子第一行>」，一律中文）：按现在的写法重写一遍
// （跟着对方帖子的语言、岗位用人话说），收件箱下次显示新的这一版，批准要按新的这一版来。
const OLD_TEMPLATE = /^[^，。\n]{0,60}，看到您发的/;
export function settleDrafts(drafts = [], leads = [], { requests = [], now = Date.now(), facts = null } = {}) {
  const byId = new Map(leads.map((l) => [l.record_id || l.id, l]));
  const at = new Date(now).toISOString();
  const out = { promoted: [], cancelled: [], rewritten: [] };
  for (const d of drafts) {
    if (!PLATFORM_CHANNELS.includes(d.channel) || !DRAFT_PURPOSES.includes(d.purpose)) continue;
    const l = byId.get(d.record_id);
    if (!l || ![AWAITING_JUDGEMENT, 'ready'].includes(d.status)) continue;
    const asked = requests.some((r) => (r.draft_id === d.draft_id || (r.record_id === d.record_id && r.channel === d.channel)) && !SETTLED_REQUEST.test(r.status || ''));
    // 写给 LinkedIn 公司主页的私信：不是人，不发（你已经批准的那一份由发送那一步拦下，lib/send-dm.mjs）。
    const why = (d.channel === 'platform_dm' && companyPage(d.to) && !asked && 'company_page') || retiredReason(l);
    const rewrite = () => {
      if (!facts || asked || d.edited_at || d.channel !== 'platform_dm' || d.purpose !== 'application' || !OLD_TEMPLATE.test(String(d.body || ''))) return;
      const body = platformMessage(l, facts).body;
      if (!body || body === d.body) return;
      Object.assign(d, { body, rewritten_at: at });
      delete d.displayed_hash; delete d.notified_at;
      out.rewritten.push(d.draft_id);
    };
    if (d.status === 'ready' && why !== 'company_page' && (!why || contactLead(l) || asked)) {
      if (!why) rewrite();
      continue;
    }
    if (why) {
      Object.assign(d, { status: 'cancelled', cancelled_at: at, cancelled_reason: `judgement_retired:${why}` });
      delete d.displayed_hash;
      out.cancelled.push(d.draft_id);
    } else if (['recommend', 'verify'].includes(l.match?.verdict)) {
      rewrite();
      Object.assign(d, { status: 'ready', judged_at: at });
      out.promoted.push(d.draft_id);
    }
  }
  return out;
}

// ---- 一个来源扫不了：哪个源、为什么、要你做什么 ------------------------------------------
// bin/discover-human-browser.mjs 的每个来源结果带上这一句（say），团队页的招聘源那一行、周期「没跑全」的原因直接用。
// 10-10：领英动态从 10-06 起每次都是「ego_browser_failed: page.waitForFunction: Timeout 15000ms exceeded」，
// 页面上被说成「模型太久没回」；原始报错只留在证据文件里。
const SOURCE_NAME = { linkedin: 'LinkedIn', boss: 'BOSS 直聘', maimai: '脉脉', xiaohongshu: '小红书' };
export const browserSourceName = name => SOURCE_NAME[name] || name;
// 只关这一个网站、别的来源照常扫的情况（登录过期、页面认不出、这一页超时、网站被别的任务占着）；
// 验证页和你接手专用 Chrome 照旧整轮停下。
export const siteOnlyStop = raw => !/site_check|captcha|user.*control|inactive|unassigned|not.*owned|control.*lost|chrome_missing/i.test(String(raw || ''));
export function browserSourceWhy(name, raw, { login = null } = {}) {
  const n = browserSourceName(name), s = String(raw || '');
  const context = login?.logged_in === true ? `最近登录检查${login.checked_at ? `（${login.checked_at}）` : ''}显示已登录；` : '';
  if (!s) return '';
  if (/site_check|captcha/i.test(s)) return `${n}：网站要先验证，一小时内不再自动打开。在专用 Chrome 里打开 ${n} 完成验证`;
  if (/user.*control|inactive|unassigned|not.*owned|control.*lost/i.test(s)) return `${n}：你接手了专用 Chrome，这一轮先停下`;
  if (/chrome_missing/i.test(s)) return `这台电脑上没找到 Google Chrome，装上以后才能扫 ${n}`;
  if (/session_expired|no_session|authwall/i.test(s)) return `${n}：${context}${context ? /no_session/.test(s) ? '但扫描使用的登录记录仍是未登录，两个记录不一致，这次没有打开搜索页' : '但这次扫描落到了登录页，两个结果不一致，请在专用 Chrome 里检查这个页面' : `专用 Chrome 里没登录或登录过期了。在专用 Chrome 里重新登录 ${n}`}`;
  if (/linkedin_page_unrecognized|page_unrecognized/i.test(s)) return `${n}：搜索页打开了，但认不出上面的帖子（页面版式变了），这一源先跳过；你不用做什么，修好后自动恢复`;
  if (/site_busy/i.test(s)) return `${n}：专用 Chrome 里另一个任务正在用这个网站，这次先跳过，下一轮再扫`;
  if (/time_sort_missing/i.test(s)) return `${n}：没找到「按时间排序」，这次先跳过，下一轮再扫`;
  if (/detail_body_missing/i.test(s)) return `${n}：${context}打开帖子详情后没有读到正文，这一源没扫完，下一轮再试`;
  if (/Execution context was destroyed|Cannot find context|context.*destroyed/i.test(s)) return `${n}：${context}读取帖子时页面跳转了，原来的页面已失效，下一轮再试`;
  if (/Target.*closed|page.*closed|browser.*closed|session.*closed|cdp.*disconnect/i.test(s)) return `${n}：${context}读取帖子时浏览器连接断了或页面被关了，下一轮再试`;
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(s)) return `${n}：${context}这个网站的地址解析失败，下一轮再试`;
  if (/ERR_(?:CONNECTION|PROXY|TUNNEL)|ECONN|fetch failed/i.test(s)) return `${n}：${context}连不上这个网站，下一轮再试`;
  const sec = /Timeout (\d+)ms/i.exec(s);
  if (sec || /timeout|timed out/i.test(s)) return `${n}：${context}页面${sec ? ` ${Math.round(Number(sec[1]) / 1000)} 秒` : '一直'}没加载出来，下一轮再试`;
  // 未识别的错误也保留脱敏后的具体原因；不凭浏览器出错推断「没登录」。
  const detail = redact(s).replace(/^ego_browser_failed:\s*/i, '').split('\n').map(x => x.trim()).filter(x => x && !/^at\s|^Call log:|^\s*-/.test(x))[0] || '浏览器没有返回原因';
  return `${n}：${context}浏览器返回「${detail.slice(0, 180)}」，这一源先跳过，下一轮再试`;
}
