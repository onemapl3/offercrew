// Pool quality: the rules the user set after seeing 大专及以上 postings and
// throwaway companies in the recommendations (plans/20260915-handoff.md §四.2).
//
// This is a leaf module: it reads config/quality-rules.json and the lead, and
// nothing else, so lib/matcher.mjs can call it before any model sees a lead.
// Every rule is a plain pattern the user can read and edit; a lead that hits one
// gets a stable reason string that `prefilter` returns and the Base shows.
import { read } from './store.mjs';

export const QUALITY_REASONS = ['education_floor_too_low', 'company_excluded_by_quality_rule', 'low_quality_posting', 'company_too_young'];

const DEFAULT_RULES = {
  education_floor: { minimum: '本科', too_low: ['大专', '专科', '中专', '高中', '学历不限', '不限学历'] },
  company_exclude_patterns: ['外包', '人力资源', '劳务', '派遣', '猎头'],
  posting_exclude_patterns: [],
  company_age: { min_years: 2, young_patterns: ['刚成立', '新成立', '天使轮', '种子轮'] },
};
export const loadQualityRules = () => ({ ...DEFAULT_RULES, ...read('config/quality-rules.json', {}) });

const regex = (p) => { try { return new RegExp(p, 'i'); } catch { return null; } }; // 兜底：配置里写错的规则跳过
const DEGREE_RANK = { 博士: 5, 硕士: 4, 研究生: 4, 本科: 3, 大专: 2, 专科: 2, 中专: 1, 高中: 1, 不限: 0 };

// The degree bar a posting states, as the level it names. "本科及以上" is 本科;
// "学历：大专" is 大专; "学历不限" is a bar of zero. A mention of 大专 inside a
// sentence that also sets a 本科 bar ("本科及以上，优秀者大专可放宽") keeps the
// higher bar: the posting's floor is what it asks for, not what it tolerates.
export function educationFloor(l = {}) {
  const text = [l.jd_text, l.education, ...(Array.isArray(l.tags) ? l.tags : [])].filter(Boolean).join('\n');
  if (!text) return null;
  const bars = [];
  // The stated floor is the highest bar anywhere in the posting. 学历不限 in
  // the body of a post is a bar of zero; a board's metadata line (网易 prints
  // 学历要求：不限 on most roles) is an unfilled field, not a bar, and is ignored.
  if (/学历不限|不限学历/.test(text.replace(/学历(?:要求)?\s*[:：]\s*不限/g, ''))) bars.push('不限');
  for (const m of text.matchAll(/(博士|硕士|研究生|本科|大专|专科|中专|高中)\s*(?:学历|及以上|以上|或以上|起|学位)/g)) bars.push(m[1]);
  for (const m of text.matchAll(/学历(?:要求)?\s*[:：]\s*(博士|硕士|研究生|本科|大专|专科|中专|高中)/g)) bars.push(m[1]);
  // A Boss card tag is the bare level.
  for (const t of Array.isArray(l.tags) ? l.tags : []) if (DEGREE_RANK[String(t).trim()] !== undefined) bars.push(String(t).trim());
  if (!bars.length) return null;
  const level = bars.sort((a, b) => DEGREE_RANK[b] - DEGREE_RANK[a])[0];
  return { level, rank: DEGREE_RANK[level] };
}

export function educationFloorReason(l = {}, rules = loadQualityRules()) {
  const floor = educationFloor(l);
  if (!floor) return null;
  const min = DEGREE_RANK[rules.education_floor?.minimum] ?? 3;
  return floor.rank < min ? 'education_floor_too_low' : null;
}

// A headhunter's post is an opening written by a recruiter for a client the
// post may not name, and the user contacts 猎头 first (his outreach order).
// The company patterns exist to keep staffing and outsourcing *employers* out,
// so a search-firm consultant's post is not retired by them: the lead is kept,
// its company becomes 待核（猎头代招：<firm>） unless the client is named, and
// the judgement names the missing client as a gap (lib/judgements.mjs). A firm
// whose own name says 外包 / 劳务 / 派遣 is still an employer to avoid.
const HUMAN_POST = /真人|内推|HR直发|Boss/;
const HEADHUNTER = /猎头|猎聘顾问|headhunt|executive search/i;
const SEARCH_FIRM = /人力资源|人才|咨询|荐|search|consulting/i;
const AGENCY_ROLE = /顾问|consultant|recruiter|合伙人|partner/i;
const STAFFING_EMPLOYER = /外包|劳务|派遣/;
const ROLE_SUFFIX = /\s*[-–—|｜·,，/]?\s*(?:资深|高级|首席|金牌|独立|(?<![A-Za-z])(?:senior|sr\.?)\s*)?(?:猎头顾问|猎头|猎聘顾问|招聘顾问|顾问|合伙人|(?<![A-Za-z])(?:executive search|recruiter|consultant|partner|founder|hr)(?![A-Za-z])).*$/i;
// Not a firm: generic words, and the platforms whose headhunter badge a
// title may carry ("脉脉猎头顾问").
const GENERIC_FIRM = /^(?:ai|it|hr|资深|独立|互联网|大模型|脉脉|linkedin|领英|boss(?:直聘)?)?$/i;
export function headhunterFirm(l = {}) {
  if (!HUMAN_POST.test(String(l.source_type || '')) || l.anonymous === true) return null;
  const title = String(l.author_title || '').trim(), company = String(l.company || '').trim();
  const own = /^待核/.test(company) ? '' : company;
  const signal = HEADHUNTER.test(title) || HEADHUNTER.test(own) || (AGENCY_ROLE.test(title) && SEARCH_FIRM.test(`${title} ${own}`));
  if (!signal || STAFFING_EMPLOYER.test(own)) return null;
  // The firm is the company line when it is the agency, else the author title
  // without its role words ("杭州示例科技有限公司资深猎头" -> 杭州示例科技有限公司),
  // else the author: the person to ask is known even when the firm is not.
  const agencyLine = own && ((l.source === '脉脉' && !l.company_identification) || HEADHUNTER.test(own) || SEARCH_FIRM.test(own) || AGENCY_ROLE.test(own)) ? own : '';
  const strip = (s) => s.replace(/[（(][^）)]*[）)]/g, '').replace(ROLE_SUFFIX, '').trim();
  const firm = [agencyLine, title].map(strip).find((x) => x && !GENERIC_FIRM.test(x)) || String(l.author || '').trim() || agencyLine || title;
  return firm.slice(0, 40) || null;
}
// What the company field of a headhunter's lead holds. 脉脉 prints the author's
// own company under the name, so a detail-filled 脉脉 company is the agency; a
// placeholder or an agency-looking name is the agency too. A 待核 note someone
// wrote (待核（疑似 DeepSeek）) is kept as it is. Anything else names the client.
export function headhunterCompany(l = {}) {
  const company = String(l.company || '').trim(), title = String(l.author_title || ''), author = String(l.author || '').trim();
  if (!company || company === `待核（${author}）`) return 'agency';
  if (/^待核/.test(company)) return 'note';
  if ((l.source === '脉脉' && !l.company_identification) || HEADHUNTER.test(company) || SEARCH_FIRM.test(company) || AGENCY_ROLE.test(company) || title.includes(company)) return 'agency';
  return 'client';
}
export const headhunterClientNamed = (l = {}) => headhunterCompany(l) === 'client';

export function companyQualityReason(l = {}, rules = loadQualityRules()) {
  const company = String(l.company || '');
  if (company && !headhunterFirm(l) && (rules.company_exclude_patterns || []).some((p) => regex(p)?.test(company))) return 'company_excluded_by_quality_rule';
  const text = [l.role, l.jd_text].filter(Boolean).join('\n');
  if (text && (rules.posting_exclude_patterns || []).some((p) => regex(p)?.test(text))) return 'low_quality_posting';
  return null;
}

// "成立于 2025 年" about the company, not about a team inside a large one.
const FOUNDED = /(?:成立于|创立于|founded in|established in)\s*(\d{4})\s*年?|(\d{4})\s*年\s*(?:成立|创立)/gi;
const SUBUNIT = /团队|部门|实验室|事业部|事业群|业务线|小组|\bteam\b|\blab\b|\bunit\b|\bdivision\b/i;
export function companyAgeReason(l = {}, rules = loadQualityRules(), now = Date.now()) {
  const age = rules.company_age || {};
  const text = String(l.jd_text || '');
  if (!text) return null;
  const minYears = Number(age.min_years) || 0;
  const thisYear = new Date(now).getFullYear();
  for (const m of text.matchAll(FOUNDED)) {
    const year = Number(m[1] || m[2]);
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (SUBUNIT.test(before)) continue;
    if (year >= 1900 && year <= thisYear && thisYear - year < minYears) return 'company_too_young';
  }
  if ((age.young_patterns || []).some((p) => regex(p)?.test(text))) return 'company_too_young';
  return null;
}

// The first rule a lead breaks, or null. Order: the degree bar (the user's
// clearest complaint), then the company, then the posting, then the age.
export function qualityReason(l = {}, rules = loadQualityRules(), now = Date.now()) {
  return educationFloorReason(l, rules) || companyQualityReason(l, rules) || companyAgeReason(l, rules, now);
}

export const QUALITY_LABEL = {
  education_floor_too_low: '学历门槛低于本科',
  company_excluded_by_quality_rule: '公司类型不投（外包/派遣/猎头）',
  low_quality_posting: '招聘帖质量低',
  company_too_young: '公司成立不满两年',
};
