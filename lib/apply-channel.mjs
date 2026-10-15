import { excludedCompany } from './discovery-policy.mjs';
// Which route actually gets an application in front of a human.
//
// The user's rule (2026-09-15): forms that a stranger can fill in and submit
// without an account are ours to submit automatically. Portals that demand a
// registered account stay with the user. Email and real-recruiter posts are the
// only ones worth reading an application letter for.
import { outOfScopeNow, prefilter } from './matcher.mjs';
import { read, write } from './store.mjs';
import {titlePolicyReason, titlePolicyHit, DEFAULT_EXCLUDE_TITLES, APPROVAL_SOURCES} from './submission-policy.mjs';
import { leadCity, targetCities, acceptableCity } from './city.mjs';
import { atsBlockedByReferrer } from './referrers.mjs';
import { sprintAllows } from './city-sprint.mjs';
import { familySession } from './accounts.mjs';
import { inLoginBrowser } from './browser-run.mjs';
import { endedLead, appliedLead, postingClosed } from './lead-state.mjs';

// Hosts whose public application form can be completed and submitted without
// creating an account. Matched on the registrable suffix, so regional and
// per-tenant subdomains are covered.
export const AUTO_APPLY_HOSTS = ['ashbyhq.com', 'greenhouse.io', 'lever.co', 'workable.com'];
// Hosts that require a registered candidate account, an app login, or a portal
// profile before a submission is accepted. The user submits these personally.
export const PORTAL_HOSTS = [
  'myworkdayjobs.com',
  'myworkdaysite.com',
  'jobs.bytedance.com',
  'jobs.feishu.cn',
  'hr.163.com',
  'careers.tencent.com',
  'join.qq.com',
  'smartrecruiters.com',
  'careers.microsoft.com',
  'apply.careers.microsoft.com',
  // Platform adapters added 2026-09-23 (lib/ats/alitalent, beisen, moka): applying needs a
  // Taobao/Alipay login, a Beisen registration or Moka phone verification. Without these the
  // leads were 'unknown' and the to-do list filed them under 平台私信.
  'talent.alibaba.com',
  // 2026-09 起阿里各业务集团的社招详情在自己的站点上（talent.alibaba.com 只剩导航页）。
  'talent-holding.alibaba.com',
  'careers.aliyun.com',
  'aidc-jobs.alibaba.com',
  'talent.taotian.com',
  'talent.antgroup.com',
  'zhiye.com',
  'career.h3c.com',
  'mokahr.com',
];

// Shared display keys; applyChannel keeps its original policy vocabulary.
export const CHANNELS = Object.freeze({ email: '邮件', platform_dm: '平台私信', wechat: '微信', ats_form: '官方表单', portal: '门户', referral: '内推请求' });
export function unifyChannel(x) {
  if (x && typeof x === 'object') {
    if (x.purpose === 'referral' || x.kind === '内推请求') return 'referral';
    const explicit = x.channel_key || x.channel;
    if (explicit) return unifyChannel(explicit);
    if (emailChannel(x)) return 'email';
    if (/微信|wechat/i.test(x.entry_type || '') || x.wechat) return 'wechat';
    if (/私信|脉脉|boss|linkedin/i.test([x.entry_type, x.source, x.url].join(' '))) return 'platform_dm';
    return unifyChannel(applyChannel(x));
  }
  const value = String(x || '').toLowerCase();
  if (Object.hasOwn(CHANNELS, value)) return value;
  if (value.startsWith('portal_') || /门户/.test(value)) return 'portal';
  if (/微信|wechat|weixin/.test(value)) return 'wechat';
  if (/内推|referral/.test(value)) return 'referral';
  if (/邮件|邮箱|email/.test(value)) return 'email';
  if (/platform_application|表单|自动投递/.test(value)) return 'ats_form';
  if (/platform_dm|maimai_friend_request|私信|脉脉|boss|linkedin/.test(value)) return 'platform_dm';
  return 'unknown';
}

// 自动提交开关（config/pipeline.json auto_submit，默认关）。给人看的说法跟着它走（09-30 #26）：关着是「自动预填」——
// 系统填好认得出的项、你在页面上检查后自己提交；只有开着才能说「自动投递」。
export const autoSubmitOn = () => read('config/pipeline.json', {}).auto_submit === true;
export const applyWord = () => autoSubmitOn() ? '自动投递' : '自动预填';
export const CHANNEL_LABEL = { get ats_form() { return autoSubmitOn() ? '自动投递' : '官方表单'; }, portal: '本人门户', email: '邮件申请', unknown: '待定' };

const hostOf = (u) => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase();
  // 兜底：写得不像网址就没有主机名
  } catch {
    return '';
  }
};
const onList = (host, list) => !!host && list.some((d) => host === d || host.endsWith('.' + d));
export const applyUrl = (l = {}) => l.application_packet?.application_url || l.application_url || l.url || '';
const entryUrls = (l = {}) => [l.application_packet?.application_url, l.application_url, l.url].filter(Boolean);

// A real person posting a job, or any lead whose verified entry is a mailbox.
export function emailChannel(l = {}) {
  return l.entry_type === '邮箱' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(l.email || ''));
}

export function applyChannel(l = {}) {
  if (emailChannel(l)) return 'email';
  const hosts = entryUrls(l).map(hostOf);
  // A portal claim wins a tie: needing the account holder is the safe answer.
  if (hosts.some((h) => onList(h, PORTAL_HOSTS))) return 'portal';
  if (hosts.some((h) => onList(h, AUTO_APPLY_HOSTS))) return 'ats_form';
  return 'unknown';
}

// The city buckets and their order live in lib/city.mjs, which imports nothing,
// so the preference table can share the same definition without an import cycle.
export { leadCity, TARGET_CITIES } from './city.mjs';

// The user's standing auto-apply policy (config/concierge.json). Titles above
// the band the user is targeting never get submitted automatically, and the
// target cities (lib/city.mjs) have a fixed order the whole system sorts by.
export const applyPolicy = () => read('config/concierge.json', {}).auto_apply_policy || {};
export { DEFAULT_EXCLUDE_TITLES };
// A title the user does not want auto-submitted, with the reason in words for
// the 拟投清单 card. The gate itself is `titlePolicyHit` in
// lib/submission-policy.mjs; `titlePolicyReason` (used by `autoApplyReady`
// below and by the Base projection) wraps the same call, so the card, the
// queue and the Base can never disagree about a title.
export function titleExcluded(l = {}, policy = applyPolicy()) {
  const hit = titlePolicyHit(l, policy);
  if (!hit) return null;
  return hit.invalid ? `职级规则「${hit.pattern}」不是合法的正则，请修正 config/concierge.json` : `标题含「${hit.pattern}」，超出目标职级`;
}
// The target cities (lib/city.mjs, e.g. 杭州 > 上海) > 远程 > everything
// else, everywhere a list is ordered; config/concierge.json city_priority overrides.
export const cityRank = (l = {}, policy = applyPolicy()) => {
  const order = policy.city_priority || targetCities();
  const i = order.indexOf(leadCity(l));
  return i < 0 ? order.length : i;
};

// A gap the user must rule on personally. Years of experience, a degree bar and
// a city outside the target set are the three the user named.
const HARD_TENURE = /年限|\d+\s*[-–~至到]?\s*\d*\s*年(?:以上|及以上|或以上|的?(?:相关)?(?:工作|开发|研发|工程)?经验)|\b\d+\+?\s*(?:-|–|to)?\s*\d*\s*years?\b/i;
const HARD_EDUCATION = /学历|本科|硕士|博士|学位|统招|双一流|\b(?:degree|bachelor|master'?s|ph\.?d|doctorate|graduate degree)\b/i;

// A requirement whose own text says the posting sets no minimum is not a bar.
// Without this, "JD未规定最低年数" reads as a tenure gate and blocks every lead.
const NO_MINIMUM = /JD\s*未|未设|未规定|未要求|未明确|无明确|无最低|不限|not specified|no minimum/i;
// Named cities the user is not searching in. A posting that says only "China",
// or says nothing, is unspecified rather than rejected, and an application there
// is reversible — postings genuinely outside China are already excluded upstream
// by matcher.prefilter.
const NON_TARGET_CITY = /北京|深圳|广州|成都|南京|合肥|苏州|武汉|西安|重庆|天津|\b(?:Beijing|Shenzhen|Guangzhou|Chengdu|Nanjing|Hefei|Suzhou|Wuhan|Xi'?an|Chongqing|Tianjin)\b/i;
export const nonTargetCity = (l = {}) => !acceptableCity(l) && NON_TARGET_CITY.test(String(l.location || ''));

export function hardGapReason(l = {}) {
  const items = [
    String(l.match?.biggest_gap || ''),
    ...(l.match?.must_haves || []).filter((r) => r.status === 'unknown' || r.status === 'conflict').map((r) => String(r.req || '')),
  ].filter(Boolean);
  const gates = items.filter((t) => !NO_MINIMUM.test(t));
  if (gates.some((t) => HARD_TENURE.test(t))) return '硬性年限待你判断';
  if (gates.some((t) => HARD_EDUCATION.test(t))) return '学历要求待你判断';
  if (nonTargetCity(l)) return '非目标城市待你判断';
  return null;
}

// `recommend` is already the user's yes. `verify` only qualifies when nothing
// left open is one of the three hard gaps.
export function autoApplyVerdict(l = {}) {
  if (l.match?.verdict === 'recommend') return { eligible: true, reason: null };
  if (l.match?.verdict !== 'verify') return { eligible: false, reason: `匹配结论不支持${applyWord()}` };
  const hard = hardGapReason(l);
  return hard ? { eligible: false, reason: hard } : { eligible: true, reason: null };
}

// Same bar as auto-apply: an outright recommend, or a verify whose open points
// are not one of the three hard gaps.
export const verdictReady = (l = {}) => autoApplyVerdict(l).eligible;

export const loadPortalSessions = () => read('config/portal-sessions.json', { domains: {}, never_auto: [] });

// A portal the user is already signed into in ego-browser can be submitted for
// them; one that still needs a registration (Workday) never can. The record here
// only saves a wasted round trip — the executor still probes the live page, and
// a login wall downgrades the lead back to the user.
export function portalSession(l = {}, sessions = loadPortalSessions()) {
  if (applyChannel(l) !== 'portal') return null;
  const host = hostOf(applyUrl(l));
  if (!host) return null;
  const entries = Object.entries(sessions.domains || {});
  // `never_auto` (Workday) means the account is the user's to create: this
  // system never registers or signs in there. It used to also mean "never
  // submit", which left a Workday lead unsubmittable after the user had signed in. Now an
  // exact-tenant session the user (or a live probe) recorded as logged in is
  // honoured like any other portal; without one the lead stays with the user.
  if (onList(host, sessions.never_auto || [])) {
    const own = entries.find(([d]) => d.toLowerCase() === host);
    if (own?.[1]?.logged_in === true) return { domain: own[0], ...own[1], register_by_owner: true, never_auto: false };
    return { domain: host, logged_in: false, never_auto: true, register_by_owner: true, login: sessions.never_auto_reason || '需本人注册账号' };
  }
  const hit = entries.find(([d]) => host === d) || entries.find(([d]) => host.endsWith('.' + d));
  const own = hit ? { domain: hit[0], ...hit[1] } : null;
  if (own?.logged_in) return own;
  // 同一账号家族（config/accounts.json，如阿里集团各业务招聘站）里别的站点登录过，就算登录；
  // 但这个站点自己更晚一次探测明确没登录的，以它为准。
  const latest = familySession(host, sessions);
  if (latest?.logged_in && latest.via_family) return latest;
  return own || { domain: host, logged_in: false, login: '未记录登录态' };
}

// Account-free forms, plus portals with a live session.
export function autoSubmittable(l = {}, sessions = loadPortalSessions()) {
  const channel = applyChannel(l);
  if (channel === 'ats_form') return true;
  if (channel !== 'portal') return false;
  const session = portalSession(l, sessions);
  return !!session?.logged_in && !session.never_auto;
}

export const AUTO_APPLY_MAX_ATTEMPTS = 3;

// A 「投 N」 the user gave through a trusted channel (lib/submission-policy.mjs).
// Whether it still matches the current plan is checked at submit time.
export const ownerApproved = (l = {}) => !!l.auto_apply?.approved_at && APPROVAL_SOURCES.includes(l.auto_apply?.approval_source) && l.auto_apply?.status !== 'closed';

// The lead is one this system may submit on its own, right now.
export function autoApplyReady(l = {}, sessions = loadPortalSessions()) {
  if (postingClosed(l)) return false;
  if (excludedCompany(l)) return false;
  // waiting_user：停在只有你能做的一步上（表上缺答案、验证码、登录），收件箱有信；你答完 / 点「继续」才重新排队。
  if(titlePolicyReason(l)||['submitting','uncertain','prepared_for_user','closed','waiting_user'].includes(l.auto_apply?.status))return false;
  if (!autoSubmittable(l, sessions)) return false;
  // A form is the last resort: a person to write to at this company comes
  // first (the user's 2026-09-19 rule, lib/referrers.mjs).
  if (atsBlockedByReferrer(l)) return false;
  // A probe that found a login wall hands the lead back until the user signs in.
  if (l.auto_apply?.status === 'needs_login') return false;
  // A city sprint (config/pipeline.json) holds what the system proposes; the
  // user's own 「投 N」 for a posting elsewhere is the user's decision, as is
  // the user's ruling on the verdict's open gaps.
  const approved = ownerApproved(l);
  if (!approved && !sprintAllows(l)) return false;
  if (l.legacy || l.superseded || endedLead(l)) return false;
  // 预筛（lib/matcher.mjs prefilter：非软件岗、不在目标方向、年限……）是系统的判断：你说了「投」就按你的，
  // 和「投」跳过 Judge 一样（2026-09-30 真实链路测试：以前这里不声不响地一直不投）。岗位已经关了照样拦，
  // bin/queue-apply.mjs 的回执会说；排除公司、职级规则是你自己定的规矩，上面和 queue-apply 各自拦、各自说明。
  if (outOfScopeNow(l) && (!approved || prefilter(l) === 'posting_closed')) return false;
  if (appliedLead(l)) return false;
  if (l.auto_apply?.status === 'submitted') return false;
  if (!approved && !autoApplyVerdict(l).eligible) return false;
  return true;
}

// What still stands between an approved lead and a submission, each with the
// one person who can clear it. Used for the 「投」 receipt and the host job, so
// a blocked approval produces one concrete next step instead of a silent skip.
export function applyBlockers(l = {}, sessions = loadPortalSessions()) {
  const out = [], url = applyUrl(l), session = portalSession(l, sessions);
  if (applyChannel(l) === 'portal' && (!session?.logged_in || l.auto_apply?.status === 'needs_login'))
    out.push({ code: session?.never_auto ? 'register_by_owner' : 'needs_login', owner: 'user', domain: session?.domain || hostOf(url),
      // 收件箱里没有「我已登录」按钮了：登录好以后在这个账号的登录提问里点「我登好了，检查并继续」。
      text: `${inLoginBrowser()}打开 ${url} ，本人${session?.never_auto ? '注册/' : ''}登录 ${session?.domain || hostOf(url)}（密码、验证码只由你输入），看到申请表或个人资料后，回收件箱在这个账号的登录提问里点「我登好了，检查并继续」；系统随后按这次批准自动填写并提交，不用再回「投」。` });
  if (autoApplyExhausted(l)) out.push({ code: 'attempts_exhausted', owner: 'user', text: `${applyWord()}已失败 ${l.auto_apply?.attempts} 次，请本人打开 ${url} 提交，提交后把回执发来。` });
  return out;
}
// Attempts are bounded. After that the form goes back to the user rather than
// being retried forever against a page this system cannot complete.
export const autoApplyExhausted = (l = {}) => Number(l.auto_apply?.attempts || 0) >= AUTO_APPLY_MAX_ATTEMPTS;
// Why a submittable form is waiting, in words for the 拟投清单 card.
export function atsWaitReason(l = {}) {
  const r = atsBlockedByReferrer(l);
  return r === 'referrer_search_pending' ? '先找内推人，找不到再投表单' : r === 'referrer_outreach_in_progress' ? '已找到内推人，联系中；无回应再投表单' : null;
}

// 用户在工作台点「我已登录」：把该 host 的登录态记为已登录（config/portal-sessions.json）。
// by：谁确认的（user_dashboard 你点了「我登好了」；login_watch 系统在浏览器里自动看到的）。
// 记完整时间（原来只记日期）：收件箱要比较"停下来之后有没有确认过登录"。
export function markPortalLoggedIn(host, { now = new Date(), sessions = loadPortalSessions(), save = (v) => write('config/portal-sessions.json', v), by = 'user_dashboard', probe = null } = {}) {
  const key = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!key) throw Error('缺少 host');
  sessions.domains = sessions.domains || {};
  // www.linkedin.com 和 linkedin.com 是同一个站点：已有的几行一起更新（2026-09-28 只更新了其中一行，
  // 另一行 9-24 的"未登录"一直留着）。
  const same = Object.keys(sessions.domains).filter(k => k.toLowerCase().replace(/^www\./, '') === key);
  const ks = same.length ? same : [key];
  for (const k of ks) sessions.domains[k] = { ...(sessions.domains[k] || {}), logged_in: true, verified_at: new Date(now).toISOString(), verified_by: by, last_probe: probe, login: sessions.domains[k]?.login || (by === 'login_watch' ? '浏览器里已登录（自动检测）' : '本人确认已登录') };
  save(sessions);
  return { domain: ks[0], ...sessions.domains[ks[0]] };
}
