// 词表和几个小工具，全系统一份（rebuild7/one-source，10-10）：服务端各模块和页面（浏览器经 /vocab.js 取同一个文件）都从这里拿。
// 只放纯函数和常量：不读文件、不引 node 模块，浏览器也能直接 import。
//   公司名     线索的公司不明时存成「待核（昵称 / 猎头代招：某某）」：显示时剥掉这层壳（coName），要知道是不是待核看 coTbd。
//   结论词     Judge 的结论（推荐 / 待核 / 排除）、规则先筛掉的、还没判的：词和色调只在这里（VERDICT、verdictOf）。
//   日子       「哪一天」一律按本地时区的自然日（dayIn），服务端用 lib/tz.mjs dayOf（带上配置的时区），页面用 <meta name="radar-tz">。
//   链接找线索 收录、对话里贴的链接对上哪条线索：比岗位页、来源页、申请页、最后落到的页（leadByUrl）。

// ── 公司名 ───────────────────────────────────────────────────────────────────
const TBD = /^待核（(.+)）$/;
export const coName = c => { const s = String(c ?? '').trim(); return TBD.exec(s)?.[1].trim() || s; };
export const coTbd = c => !String(c ?? '').trim() || TBD.test(String(c ?? '').trim());
// 公司待核时壳里装的发帖人（「devposter」「猎头代招：某某」）：行上写「发帖人 devposter」。手机号样的（「139****0000」）、
// 一整段话（「本人履历为……」）不当名字写。
export const coPoster = c => { const s = coTbd(c) ? coName(c) : ''; return !s || s.length > 24 || /\d{3}[*＊xX]{2,}\d{2,}|^\+?\d[\d\s-]{6,}$|本人|履历|简历/.test(s) ? '' : s; };
// 「#12 网易」：有编号带编号；公司不明写「公司待核」。
export const leadTag = (l = {}) => `${l?.number != null ? `#${l.number} ` : ''}${coName(l?.company) || '公司待核'}`;

// ── 结论词 ───────────────────────────────────────────────────────────────────
// tone 是页面小标的样式名（ok 绿、wait 琥珀、mute 灰）。
export const VERDICT = {
  recommend: { word: '推荐', tone: 'ok' },
  verify: { word: '待核', tone: 'wait' },
  exclude: { word: '排除', tone: 'mute' },
  prefilter: { word: '预筛掉', tone: 'mute' },
  none: { word: '还没判断', tone: 'wait' },
};
export const VERDICT_KEYS = ['recommend', 'verify', 'exclude', 'prefilter', 'none'];
// 一条线索落在哪个结论：规则先筛掉的算 prefilter；判过的按 Judge；别的算还没判断。
export const verdictOf = (l = {}) => l?.prefilter_reason ? 'prefilter' : VERDICT[l?.match?.verdict] && l.match.verdict !== 'none' ? l.match.verdict : 'none';
export const verdictWord = v => (VERDICT[v] || VERDICT.none).word;
export const verdictTone = v => (VERDICT[v] || VERDICT.none).tone;
// 只有三种结论（推荐 / 待核 / 排除）的旧表：{ recommend: '推荐', … }。
export const VERDICT_WORD = Object.fromEntries(['recommend', 'verify', 'exclude'].map(k => [k, VERDICT[k].word]));

// ── 日子 ─────────────────────────────────────────────────────────────────────
const DAY_FMT = new Map();
// YYYY-MM-DD（tz 不给就是运行环境的本地时区）；认不出的时间给空串。
export function dayIn(x, tz) {
  const t = x instanceof Date ? x.getTime() : typeof x === 'number' ? x : x == null || x === '' ? NaN : Date.parse(x);
  if (!Number.isFinite(t)) return '';
  const key = tz || '';
  let f = DAY_FMT.get(key);
  if (!f) { try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); } DAY_FMT.set(key, f); }
  return f.format(t);
}

// ── 链接找线索 ───────────────────────────────────────────────────────────────
export const leadUrls = (l = {}) => [l.url, l.source_url, l.apply_url, l.final_url, l.application_url, l.application_packet?.application_url].filter(Boolean);
export const leadByUrl = (leads, url) => {
  if (!url) return null;
  for (const l of leads || []) if (!l?.superseded && leadUrls(l).includes(url)) return l;
  return null;
};

export function plainJudgement(text = '') {
  const t = String(text ?? ''), req = /硬性要求\s*(\d+)\s*\/\s*(\d+)\s*条有证据/.exec(t), fit = /整体匹配\s*([\d.]+)\s*\/\s*3/.exec(t), dir = /方向[：:]\s*([^；;，,]+)/.exec(t);
  if (!req && !fit) return t;
  return [dir && !/未判定|未知|unknown/i.test(dir[1]) ? `方向 ${dir[1].trim()}` : '', req ? `硬性要求满足 ${req[1]}/${req[2]}` : ''].filter(Boolean).join(' · '); // 「整体匹配 x/3」不说：对外只有一个匹配度（0–100，lib/matcher.mjs requirementScore）
}

// 岗位标题的规范写法：入库、历史字段与页面上下文共用，不把末尾城市当岗位名。
const CITIES = '(?:杭州|上海|北京|深圳|苏州|南京|合肥|广州|成都|武汉|西安|新加坡)';
const TITLE_END = new RegExp(`(?:\\s*[-－—·/／]\\s*[（(]?|\\s+[（(]?|[（(])${CITIES}(?:[/／、]${CITIES})*[)）]?(?:\\s*(?:or|或|[/／]))?$`, 'i');
function closeTitleBrackets(s) {
  const stack = [];
  for (const c of s) { if (c === '(' || c === '（') stack.push(c); else if (c === ')' || c === '）') stack.pop(); }
  return s + stack.reverse().map(c => c === '(' ? ')' : '）').join('');
}
export function jobTitle(value, body = '') {
  let s = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/(?:[，,；;·/-]\s*)?社保(?:挂|在)[^，,；;]{0,40}$/, '').replace(/\s*[|｜]\s*[^|｜]*(?:Careers|招聘官网|招聘网站)\s*$/i, '');
  s = s.replace(TITLE_END, '').replace(/[\s/／-]+$/, '').trim();
  if (!s) return '岗位名称待核';
  const shortRoles = /[、，,；;]/.test(s) ? s.split(/[、，,；;]/).map(x => x.trim().replace(/^(?:招聘|急招|岗位)[：:]?\s*/, '')).filter(x => /^(?:前端|后端|全栈|测试|算法|运维|产品经理|QA|SRE|DevOps)(?:开发|研发)?(?:工程师|开发岗|研发岗)?$/i.test(x)) : [];
  const listed = [...s.matchAll(/[\u4e00-\u9fffA-Za-z0-9+#.]{1,16}(?:工程师|开发岗|研发岗|程序员)/g)].map(m => m[0]);
  if (new Set(shortRoles).size > 1) return `${[...new Set(shortRoles)].slice(0, 4).join(' / ')}（多个岗位）`;
  if (new Set(listed).size > 1 && /[、，,；;]|\d+[.、)]|招聘|岗位|优先|可带新人/.test(s)) return `${[...new Set(listed)].slice(0, 4).join(' / ')}（多个岗位）`;
  if (s.length <= 100 && !/先说说|我们是|we are|we're|we’re|岗位职责|任职要求|。|[.!?]\s/i.test(s)) return closeTitleBrackets(s);
  const text = `${s}\n${body}`;
  const role = text.match(/(?:[\w+#.]+[ -]){0,5}(?:software|full[ -]?stack|back[ -]?end|front[ -]?end|AI|agent)[ -]+(?:[\w+#.]+[ -]){0,3}(?:engineer|developer)\b/i)?.[0]
    || text.match(/(?:[\u4e00-\u9fffA-Za-z0-9+#.]{1,16})(?:工程师|开发岗|研发岗|程序员)/)?.[0];
  return role ? role.replace(/\s+/g, ' ').trim() : '岗位名称待核';
}
