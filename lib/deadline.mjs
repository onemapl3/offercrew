// 网申截止日期（design P1-1）：从接口字段或 JD 文字里读出「最后一天」，记成线索上的 apply_deadline（YYYY-MM-DD）。
//
// 校招每一步都有截止时间，错过网申就没有下一步了，所以值得单独记。但日期读错比不读更糟：收件箱会按它催你、
// 按它排序。所以只认两种来源：
//   1. 招聘系统自己给的字段（甲骨文的 PostingEndDate、北森的 EndTime、Oleeo 的 Program closing date）；
//   2. JD 里紧跟在「截止」「deadline」「closing date」这类字眼后面（或「…前截止」前面）的日期。
// 别的日期（发布日期、入职时间、毕业时间）一概不当截止日；读不出就返回 null，不猜。
//
// 没写年份的日期（「截止日期：10/15」「10月15日」）按离今天最近的那一年算：九月底读到的 10/15 是今年，
// 十二月读到的 1/10 是明年。月/日的顺序按中文和美国的习惯（10/15 = 十月十五日）；第一个数大于 12 时只能是日/月。
import { TZ, dayOf } from './tz.mjs';

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = (n) => String(n).padStart(2, '0');
function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null; // 2 月 30 日这种不存在的日子不要
}
function nearestYear(m, d, now) {
  const y = now.getUTCFullYear();
  const options = [y - 1, y, y + 1].map((year) => iso(year, m, d)).filter(Boolean);
  return options.sort((a, b) => Math.abs(Date.parse(a) - now) - Math.abs(Date.parse(b) - now))[0] || null;
}
const monthOf = (name) => MONTHS[String(name).toLowerCase().replace(/\.$/, '')];

// 一段文字里的第一个日期（从最具体的写法试起）。
export function parseDate(text, { now = new Date() } = {}) {
  const s = String(text || '');
  let m;
  if ((m = s.match(/(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?!\d)/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'i')))) return iso(+m[3], monthOf(m[1]), +m[2]);
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+(20\\d{2})\\b`, 'i')))) return iso(+m[3], monthOf(m[2]), +m[1]);
  if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/))) return +m[1] > 12 ? iso(+m[3], +m[2], +m[1]) : iso(+m[3], +m[1], +m[2]);
  if ((m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) return nearestYear(+m[1], +m[2], now);
  if ((m = s.match(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*[,:]?\\s*\\d)`, 'i')))) return nearestYear(monthOf(m[1]), +m[2], now);
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'i')))) return nearestYear(monthOf(m[2]), +m[1], now);
  if ((m = s.match(/(?<![\d/.])(\d{1,2})[/.](\d{1,2})(?![\d/.])/))) return +m[1] > 12 ? nearestYear(+m[2], +m[1], now) : nearestYear(+m[1], +m[2], now);
  return null;
}

// 截止的说法。中文：（网申/报名/投递/申请）截止（日期/时间）、网申结束时间；「截至」单独出现多半是「截至 2025 年底，
// 公司管理规模……」这种统计口径，只有跟着日期/时间或者前面有网申、报名这类字眼时才算。英文：application deadline、
// applications close、apply by、closing date、deadline to apply、accepting applications until……
const AFTER = /(?:网申|报名|投递|申请|简历投递|在线申请)(?:截止|截至)(?:日期|时间)?|截止(?:日期|时间)?|截至(?:日期|时间)|(?:报名|网申|申请)结束(?:日期|时间)?|(?:program(?:me)? |application )?closing date|applications?\s+(?:deadline|due|close[sd]?(?:\s+on)?)|deadline(?:\s+(?:to|for)\s+(?:apply|applications?))?|apply\s+(?:by|before)|(?:accepting|accepted|accept)\s+applications?\s+(?:until|through)|applications?\s+(?:will\s+be\s+)?accepted\s+(?:until|through)/gi;
const BEFORE = /(?:前|之前)?\s*(?:截止|结束)(?:申请|投递|报名|网申)?/g;

export function deadlineFromText(text, { now = new Date() } = {}) {
  const s = String(text || '');
  for (const m of s.matchAll(AFTER)) {
    // 「截止日期：10/15」「Application deadline: October 15, 2026」：日期在字眼后面不远处。
    const found = parseDate(s.slice(m.index + m[0].length, m.index + m[0].length + 40), { now });
    if (found) return found;
  }
  for (const m of s.matchAll(BEFORE)) {
    // 「请于 2026年10月15日前截止」「10月15日截止」：日期紧挨在字眼前面。
    const head = s.slice(Math.max(0, m.index - 24), m.index);
    const found = /\d\s*$|[日号]\s*$/.test(head) ? parseDate(head.slice(head.search(/(?:20\d{2}|\d{1,2}\s*月|\d{1,2}[/.]\d)/)), { now }) : null;
    if (found) return found;
  }
  return null;
}

// 接口字段：「2026-10-15T23:59:59」「2026-10-15」取年月日（按对方写的当地日期，不换时区）；
// 北森没截止时给的是「0001-01-01T00:00:00」，毫秒数给 0，都当没有。
export function deadlineField(value) {
  if (value == null || value === '' || value === 0) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? iso(+m[1], +m[2], +m[3]) : null;
}

// 当地的今天（YYYY-MM-DD，按 lib/tz.mjs 的时区）。
export const localDay = (now = new Date(), tz = TZ) => dayOf(now, tz);
// 校招和实习的岗位，板子给的截止日已经过了（截止日在今天之前；截止当天还算开着）：读的时候就不要了。
// 社招岗位、没给截止日的岗位一律不动。
export const pastDeadline = (l, now = new Date()) =>
  (l?.recruit_type === 'campus' || l?.recruit_type === 'intern') && /^\d{4}-\d{2}-\d{2}$/.test(String(l.apply_deadline || '')) && l.apply_deadline < localDay(now);
