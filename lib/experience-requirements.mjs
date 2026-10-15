// 年限只属于当前岗位的明确要求。整份招聘合集、偏好、上限不提供最低年限。
const roleKey = text => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/engineers?|工程师|developers?|开发人员|开发工程师/g, '')
  .replace(/^[\s#\d.、）)]+/, '').replace(/[^\p{L}\p{N}]+/gu, '');
export function roleRequirementText(lead = {}) {
  const text = String(lead.jd_text || '');
  const headings = [...text.matchAll(/^#{2,6}\s+(.+)$/gm)].filter(m => /工程师|开发|经理|engineer|developer|manager|analyst|designer|researcher/i.test(m[1]) && !/要求|职责|requirements|responsibilit/i.test(m[1]));
  if (headings.length < 2) return text;
  const key = roleKey(lead.role), selected = headings.filter(m => {
    const h = roleKey(m[1]);
    return key && h && (key === h || key.length >= 4 && h.includes(key) || h.length >= 4 && key.includes(h));
  });
  if (selected.length !== 1) return ''; // 没确定哪一个岗位，不把别岗的下限说成这个岗位的。
  const h = selected[0], next = text.slice(h.index + h[0].length).search(/^#{2,6}\s+/m);
  return text.slice(h.index, next < 0 ? text.length : h.index + h[0].length + next);
}
const OPTIONAL = /优先|加分|最好|最佳|为佳|preferred|preferably|\bnice.to.have\b|\ba plus\b|\bbonus\b|\bideally\b|\bideal\b/i;
const UPPER = /(?:不超(?:过)?|最多|上限|至多)\s*[：:]?\s*[\d一二两三四五六七八九十]|(?:年|years?)\s*(?:以内|以下)|\b(?:up to|at most|less than|under|within|no more than)\s+\d/i;
function mandatoryEntries(text = '') {
  let optional = false;
  const full = String(text), cuts = new Set([0, full.length]);
  for (const m of full.matchAll(/[，,；;。\n]|\.(?=\s|$)|(?=加分项|优先条件|经验要求\s*[:：]|\bpreferred qualifications\b|\brequired qualifications\b|\bminimum qualifications\b|任职要求|岗位要求)/gi)) { cuts.add(m.index); cuts.add(m.index + m[0].length); }
  const points = [...cuts].sort((a, b) => a - b);
  return points.slice(0, -1).map((start, i) => Object.assign([full.slice(start, points[i + 1])], { index: start })).filter(m => {
    const s = m[0].trim();
    if (/^(?:[#*\s\d.、）)]*)(?:任职要求|岗位要求|基本要求|必备条件|硬性要求|经验要求|required qualifications|requirements|minimum qualifications)\s*[:：*]?/i.test(s)) optional = false;
    if (/加分项|优先条件|以下.{0,10}优先|^(?:[#*\s]*)(?:preferred qualifications|nice.to.have)/i.test(s)) optional = true;
    return s && !/^[，,；;。.]$/.test(s) && !optional && !OPTIONAL.test(s) && !UPPER.test(s);
  });
}
export const mandatoryExperienceClauses = text => mandatoryEntries(text).map(m => m[0].trim());
export function mandatoryExperienceMention(lead, index, length) {
  const full = String(lead.jd_text || ''), scoped = roleRequirementText(lead), offset = full.indexOf(scoped);
  if (!scoped || offset < 0 || /\d/.test(full[index - 1] || '')) return false;
  return mandatoryEntries(scoped).some(m => index >= offset + m.index && index + length <= offset + m.index + m[0].length);
}
export const tenureClauses = lead => mandatoryExperienceClauses(roleRequirementText(lead));
// 保留原句上下文的限定，不能只截一个「3年」就把「3年最好」变成硬要求。
export function tenureQuoteText(quote, lead) {
  if (!quote) return '';
  const text = roleRequirementText(lead), parts = [];
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    for (const m of mandatoryEntries(text)) {
      const left = Math.max(start, m.index), right = Math.min(end, m.index + m[0].length);
      if (right > left) parts.push(text.slice(left, right));
    }
  }
  return parts.join('\n');
}
