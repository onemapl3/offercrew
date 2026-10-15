// 线索字段只装事实，核实状态和原始抽取另存。入库和旧数据升级共用。
import { jobTitle } from './vocab.mjs';
export { jobTitle } from './vocab.mjs';
import { companyAliasGroups } from './company-aliases.mjs';
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const UNKNOWN = /^(?:待核|公司(?:待核|未确认|未知)|未披露|发帖人未披露|未知|未标注|地点待核实)/;
const PHONE = /\d{3}[*＊xX]{2,}\d{2,}|^\+?\d[\d\s-]{6,}$/;
const NOTE = /本人(?:履历|简历|求职)|个人(?:履历|简历)|疑似|某(?:头部|大型|上市)|邮箱域名|员工$|内推小助手|产品负责人$|约\d+人|公司.*团队/;
const companyBase = value => clean(value).replace(/(?:集团|\s+Group)$/i, '').replace(/\.(?:com|cn|net|org)$/i, '').trim();
export function companyVariants(value) {
  const s = clean(value), wrapped = /^(.+?)[（(]([^）)]*)[）)]$/.exec(s);
  const base = companyBase(wrapped?.[1] || s), first = wrapped?.[2].split(/[，,；;]/)[0].trim();
  const alias = first && /^[A-Za-z][A-Za-z0-9.& +'’-]{1,60}$/.test(first) && !/^(?:China|Shanghai|Beijing|Hangzhou|remote|headquarters)$/i.test(first) ? companyBase(first) : null;
  return [...new Set([base, alias].filter(Boolean))];
}
export function canonicalCompany(value, groups = companyAliasGroups()) {
  const variants = companyVariants(value), norm = s => s.normalize('NFKC').toLowerCase();
  const names = new Set(variants.map(norm));
  const group = groups.find(g => g.some(s => companyVariants(s).some(x => names.has(norm(x)))));
  return group ? clean(group[0]) : variants[1] || variants[0] || '';
}
// 名称由招聘原文声明，不等于招聘身份已核实；不从昵称、邮箱或网站猜公司。
export function postingCompanyClaim(l = {}) {
  if (l.headhunter?.client_named === false) return null;
  const found = [];
  for (const line of [String(l.jd_text || ''), String(l.role || '')].flatMap(s => s.split('\n'))) {
    const quote = line.trim(), text = quote.replace(/^\s*(?:\[招聘帖\]|【招聘帖】|#{1,6})\s*/, '');
    const name = /^(?:公司名称|招聘公司|招聘主体|雇主|Company|Employer)\s*[:：]\s*([^，,；;。\n]+)/i.exec(text)?.[1]
      || /^(.{2,40}?)[—–-](?:.{1,25}?)(?:部门|团队)招聘/.exec(text)?.[1];
    if (!name || UNKNOWN.test(name) || /^(?:某|头部|匿名)|猎头|代招|岗位|工程师|内推|邮箱|https?:|[：:]/i.test(name)) continue;
    found.push({ name: canonicalCompany(name), quote, source: 'posting', verified: false });
  }
  return new Set(found.map(x => x.name)).size === 1 ? found[0] : null;
}
export function recoverPostingCompany(l = {}) {
  if (l.company && !UNKNOWN.test(l.company)) return {};
  const claim = postingCompanyClaim(l);
  return claim ? { company: claim.name, company_status: 'named', company_claim: claim,
    ...(l.company && !l.field_sources?.company ? { field_sources: { ...l.field_sources, company: l.company } } : {}) } : {};
}
export function leadFields(l = {}) {
  const raw = clean(l.company), wrapped = /^待核[（(](.*)[）)]$/.exec(raw);
  const unknown = !raw || UNKNOWN.test(raw) || PHONE.test(raw) || NOTE.test(raw) || raw.length > 60 || (!!l.author && raw === clean(l.author));
  const company = unknown ? '' : canonicalCompany(raw);
  const loc = clean(l.location), pending = !loc || UNKNOWN.test(loc);
  const location = pending ? '' : loc.replace(/[（(](?:原帖|帖内|附言|已核|明确)[^）)]*[）)]/g, '').trim();
  const title = clean(l.role || l.title);
  const role = jobTitle(title, title.length > 100 || /先说说|我们是|we are|we're|we’re/i.test(title) ? l.jd_text : '');
  const original = { ...(l.field_sources || {}) };
  for (const [key, value] of [['company', raw], ['location', loc], ['role', clean(l.role)]]) if (value && value !== ({ company, location, role })[key] && !original[key]) original[key] = value;
  const poster = wrapped?.[1];
  return { company, company_status: unknown ? 'unknown' : 'named', ...recoverPostingCompany(l), location, needs_city_check: pending || l.needs_city_check === true, location_status: pending ? 'unknown' : 'named', role,
    ...(role === '岗位名称待核' ? { needs_role_check: true } : {}),
    ...(!l.author && poster && !PHONE.test(poster) && !NOTE.test(poster) && poster.length < 40 ? { author: poster } : {}),
    ...(Object.keys(original).length ? { field_sources: original } : {}) };
}
