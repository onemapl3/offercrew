import { MAIMAI_FRIEND_LIMIT } from './message-limits.mjs';
// People who can refer the candidate into a company, and the rule that an
// application form is only submitted when no such person could be found.
//
// The user's decision (2026-09-19): a referral or a person converts, a form
// mostly does not, so for every company worth applying to the system first
// looks for someone to write to — an author of a public 内推 post, an alumnus
// or former colleague working there, a recruiter or hiring manager who posted
// the opening — and only falls back to the ATS when the search came up empty.
//
// state/referrers.ndjson holds one row per person found; state/referrer-
// search.json holds when each company was last searched and what came of it.
import { read, write, lines, writeLines, hash } from './store.mjs';
import { educationShort, currentRoleShort, outreachIntro } from './facts.mjs';
import { chosenIntro } from './resume-choice.mjs';

export const REFERRERS_PATH = 'state/referrers.ndjson';
export const SEARCH_PATH = 'state/referrer-search.json';
// A search is fresh for this long; after that the company is searched again.
export const SEARCH_TTL_DAYS = 14;
// Never more than this many people per company, and never the same person
// twice within the cooldown.
export const MAX_PER_COMPANY = 2;
export const CONTACT_COOLDOWN_DAYS = 30;

const DAY = 86400000;
export const normalizeCompany = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/（.*?）|\(.*?\)/g, '').replace(/有限公司|股份|集团|科技|信息|网络|technolog(?:y|ies)|inc\.?|ltd\.?|co\.?|corp\.?|limited|group|\s+/gi, '').trim();
// Equal after normalization, or one contains the other when the shorter is
// long enough to be a name rather than a fragment (two CJK characters, six
// Latin ones).
export const sameCompany = (a, b) => {
  const x = normalizeCompany(a), y = normalizeCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const min = /[\u4e00-\u9fff]/.test(short) ? 2 : 6;
  return short.length >= min && long.includes(short);
};

export const loadReferrers = () => lines(REFERRERS_PATH);
export const loadSearches = () => read(SEARCH_PATH, {});

export function referrersFor(company, referrers = loadReferrers()) {
  return referrers.filter((r) => sameCompany(r.company, company) && r.status !== 'retired');
}
export function searchFor(company, searches = loadSearches()) {
  const key = normalizeCompany(company);
  return key ? searches[key] || null : null;
}
export const searchFresh = (search, now = Date.now()) => !!search?.searched_at && now - Date.parse(search.searched_at) < SEARCH_TTL_DAYS * DAY;

// Why an ATS form must wait: the company has not been searched for a person
// yet, or a person was found and the outreach has not run its course.
// Returns null when the form may go ahead.
//
// Both waits are bounded (2026-09-23). The referrer rows never advance past
// `found` (nothing writes drafted/contacted), so the old test — any `found`
// row without a contact date — held every such company's form forever,
// and a company find-referrers never picks (a verdict it skips, a 待核 name)
// waited for a search that never runs. Outreach is now read from the ledger
// that actually moves: the referral draft and the outbound receipts.
export const SEARCH_WAIT_DAYS = 3;     // a matched lead waits this long for its company's search
export const REFERRER_GRACE_DAYS = 3;  // a found person whose request the user has not released
export const REFERRER_REPLY_DAYS = 7;  // a request sent without an answer: the form goes ahead
const recipient = (u) => { try { const x = new URL(String(u)); return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase(); } catch { return String(u || '').trim().toLowerCase() || null; } };
export function referrerOutreach(r = {}, { drafts = [], outbound = [], leads = [] } = {}) {
  const mine = drafts.filter((d) => d.referrer_id === r.id || (r.draft_id && d.draft_id === r.draft_id));
  const to = recipient(r.email || r.contact_url);
  const sent = [...mine.filter((d) => ['sent', 'dispatched', 'submitted'].includes(d.status)).map((d) => ({ at: d.sent_at || d.updated_at || d.created_at, record_id: d.record_id })),
    ...(to ? drafts.filter((d) => ['sent', 'dispatched', 'submitted'].includes(d.status) && recipient(d.to) === to).map((d) => ({ at: d.sent_at || d.updated_at || d.created_at, record_id: d.record_id })) : []),
    ...(to ? outbound.filter((o) => recipient(o.to || o.url) === to && !['failed', 'pending', 'queued'].includes(o.status)).map((o) => ({ at: o.at, record_id: o.record_id })) : [])]
    .filter((x) => x.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const contacted_at = r.contacted_at || sent[0]?.at || null;
  const replied = sent.some((x) => leads.find((l) => (l.record_id || l.id) === x.record_id)?.replied_at);
  // Waiting on the user's 「发」: a request drafted and not released, or a person
  // just found whose draft is written in the same run. Cancelled / superseded
  // requests (declined, or the person is already in another thread) are not.
  const pending = !contacted_at && (!mine.length || mine.some((d) => ['ready', 'paused', 'needs_review', 'draft'].includes(d.status)));
  return { contacted_at, replied, pending };
}
export function atsBlockedByReferrer(lead = {}, { referrers = loadReferrers(), searches = loadSearches(), drafts = null, outbound = null, leads = [], now = Date.now(), policy = read('config/concierge.json', {}).auto_apply_policy || {} } = {}) {
  // Opt-in: only a policy that says so puts people before forms.
  if (policy.require_referrer_search !== true) return null;
  // A form the user has already approved (「投 N」) is the user's decision; the
  // referrer-first rule shapes what gets proposed, it does not revoke approvals.
  if (lead.auto_apply?.approved_at) return null;
  const search = searchFor(lead.company, searches);
  if (!searchFresh(search, now)) {
    const since = Date.parse(lead.matched_at || lead.discovered_at || '');
    return !Number.isFinite(since) || now - since < SEARCH_WAIT_DAYS * DAY ? 'referrer_search_pending' : null;
  }
  for (const r of referrersFor(lead.company, referrers)) {
    // Read lazily: most companies have nobody on file, and this runs per lead.
    drafts ??= lines('state/drafts.ndjson'); outbound ??= lines('state/outbound.ndjson');
    const o = referrerOutreach(r, { drafts, outbound, leads });
    if (o.contacted_at ? !o.replied && now - Date.parse(o.contacted_at) < REFERRER_REPLY_DAYS * DAY : o.pending && now - Date.parse(r.found_at || 0) < REFERRER_GRACE_DAYS * DAY) return 'referrer_outreach_in_progress';
  }
  return null;
}

export function recordSearch(company, { found = 0, sources = [], now = Date.now() } = {}) {
  const searches = loadSearches();
  const key = normalizeCompany(company);
  if (!key) return searches;
  searches[key] = { company, searched_at: new Date(now).toISOString(), found, sources };
  write(SEARCH_PATH, searches);
  return searches;
}

// Add or refresh one person. Identity is the contact channel, never the name.
export function upsertReferrer(person, { now = Date.now() } = {}) {
  const referrers = loadReferrers();
  const id = person.id || hash([normalizeCompany(person.company), person.contact_url || person.email || person.author]).slice(0, 24);
  const existing = referrers.find((r) => r.id === id);
  const row = {
    id, company: person.company, author: person.author || '', author_title: person.author_title || '',
    relationship: person.relationship || 'referral_post', // headhunter | hr | recruiter | referral_post | alumni | former_colleague | team_member
    source: person.source || '', post_url: person.post_url || null, contact_url: person.contact_url || null, email: person.email || null,
    contact_line: person.contact_line || null, evidence: person.evidence || null, judgement: person.judgement || null,
    // An explicit status/draft_id (find-referrers after it drafts a request) moves the row on; a refresh keeps it.
    status: person.status || existing?.status || 'found', found_at: existing?.found_at || new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    ...(existing ? { contacted_at: existing.contacted_at, draft_id: existing.draft_id, lead_number: existing.lead_number } : {}),
    ...(person.draft_id ? { draft_id: person.draft_id } : {}),
    ...(person.lead_number ? { lead_number: person.lead_number } : {}),
  };
  if (existing) Object.assign(existing, row); else referrers.push(row);
  writeLines(REFERRERS_PATH, referrers);
  return row;
}

export function setReferrerStatus(id, status, extra = {}) {
  const referrers = loadReferrers();
  const r = referrers.find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, { status, updated_at: new Date().toISOString(), ...extra });
  writeLines(REFERRERS_PATH, referrers);
  return r;
}

// The message the user reviews before a referral request goes out. Facts only:
// the lead, the person's own post, and candidate/facts.yaml.
export function referralMessage(referrer, lead = {}, facts = {}) {
  const id = facts.identity || {};
  const summary = facts.experience_summary?.outreach_wording || '';
  const project = String(facts.positioning?.project_priority?.[0]?.name || '').split(/[（(]/)[0].trim();
  const shared = referrer.relationship === 'alumni' ? '看到您也是校友，' : referrer.relationship === 'former_colleague' ? '看到您也在我之前待过的公司工作过，' : '';
  const role = lead.role ? `${lead.company} 的「${String(lead.role).slice(0, 40)}」` : `${lead.company || referrer.company} 的岗位`;
  const opener = referrer.relationship === 'referral_post' ? `${referrer.author || '您好'}，看到您发的内推信息。`
    : referrer.relationship === 'headhunter' ? `${referrer.author || '您好'}，看到您在推 ${lead.company || referrer.company} 的岗位。`
    : ['hr', 'recruiter'].includes(referrer.relationship) ? `${referrer.author || '您好'}，看到您在为 ${lead.company || referrer.company} 招人。`
    : `${referrer.author || '您好'}，冒昧打扰。${shared}`;
  // 学历和「现职做……」来自 facts.yaml `outreach`（以前写死在这里）；缺哪句就不写哪句。
  const current = currentRoleShort(facts);
  const intro = [educationShort(facts), summary, current ? `现职做 ${current}` : ''].filter(Boolean).join('，');
  const own = [intro, project ? `独立搭过 ${project}` : ''].filter(Boolean).map((s) => '，' + s).join('');
  const ask = `${opener}我在关注${role}，想请您帮忙内推或指点一下。`, tail = '方便的话我把简历发给您，谢谢！';
  // 你在「简历 → 求职信」里选定的那段中文自我介绍（Tailor 写、逐句核对过出处）优先；放不进 300 字才用原来的拼法。
  const tailored = chosenIntro('zh', lead);
  const mine = tailored ? `${ask}${tailored.replace(/[。.!！\s]*$/, '')}。${tail}` : null;
  const body = mine && mine.length <= 300 ? mine : `${ask}我是${id.name_zh || id.name_en}${own}。${tail}`;
  return { body: body.slice(0, 300), within_limit: body.length <= 300 };
}

// One draft row per referrer, in the shape state/drafts.ndjson already uses,
// so the existing draft card and 「发 编号」 release it. `purpose: referral`
// keeps it distinct from a first application to the same lead.
export function referralDraft(referrer, lead, facts, { now = Date.now() } = {}) {
  if (!referrer || !lead?.number) return null;
  const channel = referrer.email ? 'email' : /maimai\.cn/.test(referrer.contact_url || '') ? 'maimai_friend_request' : 'platform_dm';
  const message = referralMessage(referrer, lead, facts);
  if (channel === 'maimai_friend_request' && [...message.body].length > MAIMAI_FRIEND_LIMIT) {
    // Maimai's friend note is fifty characters; the long form goes after acceptance.
    const intro = outreachIntro(facts);
    message.body = `您好，看到您能内推${String(lead.company).slice(0, 12)}。${intro ? intro + '，' : ''}想请您帮忙内推，加个好友可以吗？`.slice(0, MAIMAI_FRIEND_LIMIT);
  }
  const record = lead.record_id || lead.id;
  return {
    record_id: record, number: lead.number, referrer_id: referrer.id,
    draft_id: 'ref-' + hash([record, referrer.id, message.body]).slice(0, 24),
    channel, platform: channel === 'email' ? '邮件' : channel === 'maimai_friend_request' ? '脉脉加好友附言' : '平台私信',
    to: referrer.email || referrer.contact_url, subject: `${lead.company} · 内推请求 · ${String(lead.role || '').slice(0, 40)}`,
    body: message.body, attachments: [], purpose: 'referral', status: 'ready', created_at: new Date(now).toISOString(),
    referrer: { author: referrer.author, relationship: referrer.relationship, post_url: referrer.post_url },
  };
}
