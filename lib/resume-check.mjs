// 简历助手 · 体检（2026-09-29）：给整理好的简历按七类打分、列出问题，再给出能直接套用的改法。
//
// 纯函数：不读文件、不联网、不调模型，同样的输入永远得到同样的结果（「至今」按 now 算，测试里传固定的 now）。
// 输入 content 是简历助手整理好的结构：header 行（第一行是名字）+ sections（按 kind 分：经历、教育、项目……）
// + entries（一段经历一条：head 是标题行，lines 是要点），每行都有 id，问题靠 id 指回原文。
// 可选：facts（个人资料，candidate/facts.yaml 读出来的对象）拿来核对前后一致；source（上传原件的
// ext / method / warning / text）拿来判断招聘方读简历的软件（ATS）能不能读懂这份文件。
// 分数：七类各有满分，每类按问题扣（high 0.5、medium 0.25、low 0.1，扣满为止），各类取整后相加 = 总分，
// 页面上各类分数加起来正好等于总分。内容太少时（要点不到 3 条、全文不到半页）几类按写了多少折算，见 COVERAGE：
// 空简历不能靠「没挑出毛病」拿高分。同一种毛病出现很多处只算一条问题（lines 列出全部行、count 写处数）：
// 扣分看「有没有这种毛病」，不看处数，免得一种小毛病把一整类扣光。
// 问题的文字写给不懂技术的人：先说为什么要紧，再说怎么改，带一个小例子；数字永远由本人给，助手只问不编。

// 公司名、职位比对前把兼容汉字（「⼤」）换成标准汉字。
import { normalizeCjkCompat } from './resume-text.mjs';

export const CATEGORIES = [
  { key: 'structure', label: '结构', max: 15 },
  { key: 'clarity', label: '清晰', max: 15 },
  { key: 'impact', label: '量化', max: 20 },
  { key: 'ats', label: 'ATS 能不能读', max: 15 },
  { key: 'typos', label: '错别字', max: 10 },
  { key: 'length', label: '长度', max: 10 },
  { key: 'consistency', label: '前后一致', max: 15 },
];
const WEIGHT = { high: 0.5, medium: 0.25, low: 0.1 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const CAT_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.key, i]));
const KINDS = new Set(['summary', 'experience', 'education', 'projects', 'skills', 'awards', 'other']);
const WORK = new Set(['experience', 'projects']);

// ── 输入整形：什么形状都不抛错 ───────────────────────────────────────────────────
// 整理器给的可能缺 id、title 是 null、行是字符串甚至 null；这里统一成 { id, text }，缺 id 的按位置补一个
// （~ 开头，和整理器给的 L1、E2 不会撞）。数量和长度都设上限：再怪的输入也只花线性时间。
const str = v => typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
const arr = v => Array.isArray(v) ? v : [];
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const uniq = xs => [...new Set(xs.filter(Boolean))];
const MAX_CHARS = 3000, MAX_LINES = 4000;
const lineOf = (l, fallback) => {
  const o = typeof l === 'string' ? { text: l } : obj(l);
  return { id: str(o.id) || fallback, text: str(o.text).slice(0, MAX_CHARS), bullet: o.bullet === true, locked: o.locked === true };
};
function model(content) {
  const c = obj(content);
  let budget = MAX_LINES; // 全文最多看这么多行，后面的不看（真实简历远到不了）
  const take = (list, max) => { const out = arr(list).slice(0, Math.max(0, Math.min(max, budget))); budget -= out.length; return out; };
  const header = take(c.header, 40).map((l, i) => lineOf(l, `~h${i}`));
  const sections = arr(c.sections).slice(0, 60).map((s0, si) => {
    const s = obj(s0), title = s.title == null ? null : lineOf(s.title, `~s${si}t`);
    const entries = arr(s.entries).slice(0, 100).map((e0, ei) => {
      const e = obj(e0);
      return { id: str(e.id) || `~s${si}e${ei}`, head: take(e.head, 12).map((l, i) => lineOf(l, `~s${si}e${ei}h${i}`)), lines: take(e.lines, 200).map((l, i) => lineOf(l, `~s${si}e${ei}l${i}`)), locked: e.locked === true };
    });
    return { id: str(s.id) || `~s${si}`, kind: KINDS.has(s.kind) ? s.kind : 'other', title, entries, locked: s.locked === true };
  });
  // 全文按阅读顺序排成一列：where 说明这一行在哪（名字那几行 / 栏目标题 / 经历标题行 / 要点）。
  const all = header.map(l => ({ ...l, where: 'header', kind: 'header' }));
  for (const s of sections) {
    if (s.title) all.push({ ...s.title, where: 'title', kind: s.kind, section: s });
    for (const e of s.entries) {
      for (const l of e.head) all.push({ ...l, where: 'head', kind: s.kind, section: s, entry: e });
      for (const l of e.lines) all.push({ ...l, where: 'body', kind: s.kind, section: s, entry: e });
    }
  }
  const text = all.slice(0, MAX_LINES).map(l => l.text).join('\n');
  const lang = c.lang === 'en' || c.lang === 'zh' ? c.lang : cjkCount(text) * 2 >= (text.match(/[A-Za-z]/g) || []).length ? 'zh' : 'en'; // 一个字都没有时按中文
  return { header, sections, all: all.slice(0, MAX_LINES), lang };
}

// ── 文字小工具 ──────────────────────────────────────────────────────────────────
const CJK_SRC = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const cjkCount = t => (t.match(new RegExp(`[${CJK_SRC}]`, 'g')) || []).length;
const latinWords = t => (t.replace(new RegExp(`[${CJK_SRC}]`, 'g'), ' ').match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
// 一行算中文还是英文：一个英文词大约占一个半汉字的信息量；中文句子里夹几个英文术语仍算中文。
const isZh = (t, fallback = 'en') => { const c = cjkCount(t), w = latinWords(t); return c || w ? c >= w * 1.5 : fallback === 'zh'; };
const wordCount = t => (t.replace(new RegExp(`[${CJK_SRC}]`, 'g'), ' ').match(/[A-Za-z0-9]+(?:['’.+#-][A-Za-z0-9]+)*/g) || []).length;
// 行首的项目符号不算内容（「• 」「- 」「● 」）。
const clean = t => String(t).replace(/^[\s•·\-–—*▪▫◦●○■□◆◇►▶➤✓✔→]+/u, '').trim();
// 截短：英文不从单词中间切，退到前一个空格（至少留一半）。
const clip = (t, n) => {
  const cs = Array.from(String(t).trim());
  if (cs.length <= n) return cs.join('');
  let cut = n;
  if (/[A-Za-z0-9]/.test(cs[n - 1]) && /[A-Za-z0-9]/.test(cs[n])) { const sp = cs.slice(0, n).lastIndexOf(' '); if (sp >= n / 2) cut = sp; }
  return cs.slice(0, cut).join('').trimEnd() + '…';
};

// ── 数字：一句话里有没有能让人相信的量 ────────────────────────────────────────────
// 阿拉伯数字（不算 S3、K8s 这种名字里的数字，不算 Python 3 这种版本号，不算 2021 这种年份）、
// 百分比、中文数量（两个、三家、上百、数十万；「一个」「一套」不算，「十分重要」不算）、英文数词。
const TECH_BEFORE = /(?:python|java|vue|ios|android|windows|office|excel|http|jdk|php|node|react|angular|swift|mysql|redis|oracle|tls|ssl|html|css|es|ecmascript|macos|ubuntu|centos|win|iphone|ipad|version|v)\s*\/?\s*$/i;
const YEAR_AS_COUNT = /^\s*(?:%|\+|[万千百亿多余倍个名人家条次项元]|[xXkKmMwW](?![A-Za-z])|(?:users?|customers?|clients?|people|students|members|downloads|orders|records|companies|stores|hours|days|samples|accounts|transactions)\b)/;
const UNIT_AFTER = /^(?:x|k|m|b|w|bn|mm|kg|km|ms|s|h|hrs?|mins?|pp|bps|bp|st|nd|rd|th)\b/i;
function digitMetric(t) {
  for (const m of t.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const before = t.slice(Math.max(0, m.index - 16), m.index), after = t.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (/[A-Za-z]$/.test(before)) continue; // S3、EC2、K8s、Vue3：名字里的数字
    if (/(?:19|20)\d{2}\s*[-./年]\s*$/.test(before)) continue; // 2021-07 的月份
    if (TECH_BEFORE.test(before) && !/^\s*(?:%|\+|[万千百倍xX])/.test(after)) continue; // Python 3、Excel 2016
    if (/^(?:19|20)\d{2}$/.test(m[0]) && !YEAR_AS_COUNT.test(after)) continue; // 年份，不是「2000 个」
    if (/^[A-Za-z]/.test(after) && !UNIT_AFTER.test(after)) continue; // 5G、3D：型号
    return true;
  }
  return false;
}
const ZH_MEASURE = '个|名|位|人|家|条|次|项|款|套|种|倍|天|周|月|年|小时|分钟|秒|篇|场|门|支|组|台|份|元|块|行|页|轮|期|所|座|笔|单|户|张|本|类|批|届|区|省|市|城|国|店|部|章|节|遍|层|级|步|成|折|亿|万|千|百';
const ZH_NUMBER = new RegExp(`(?:[两三四五六七八九十][十百千万亿]*|一[十百千万亿]+)(?:多|余|来|几)?(?:${ZH_MEASURE})|[数几上近超逾达][十百千万亿]+|[一二两三四五六七八九十]+[十百千万亿]+|百分之|[两三四五六七八九十数几]\\s*倍|翻(?:了)?(?:一)?(?:倍|番)|一半|减半|第[一二三四五六七八九十\\d]+(?:名|位)`);
const EN_NUMBER = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|doubled|tripled|quadrupled|halved|twice)\b/i;
export const hasNumber = t => { const s = String(t ?? ''); return digitMetric(s) || ZH_NUMBER.test(s) || EN_NUMBER.test(s); };

// ── 日期：2019-07、2019.7、2019/07、07/2019、Jul 2019、2019年7月、2019、至今 / Present ──────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_SRC = [
  '((?:19|20)\\d{2})\\s*年(?:\\s*(\\d{1,2})\\s*月)?',
  '(?<![\\d.])((?:19|20)\\d{2})\\s*([-./])\\s*(\\d{1,2})(?!\\d)',
  '(?<![\\d./])(\\d{1,2})\\s*([/.])\\s*((?:19|20)\\d{2})(?!\\d)',
  `\\b(${MON})\\.?\\s*,?\\s*((?:19|20)\\d{2})(?!\\d)`,
  '(?<![\\d./])((?:19|20)\\d{2})(?!\\d)',
  `(至今|现在|目前|(?<![${CJK_SRC}])今(?![${CJK_SRC}])|\\b(?:present|now|current|ongoing|today)\\b)`,
].join('|');
const FORMAT_OF = { '-': 'ym-dash', '.': 'ym-dot', '/': 'ym-slash' };
export function dateTokens(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(new RegExp(DATE_SRC, 'gi'))) {
    let t;
    if (m[1]) t = { y: +m[1], m: m[2] ? +m[2] : null, fmt: m[2] ? 'zh' : 'year' };
    else if (m[3]) t = { y: +m[3], m: +m[5], fmt: FORMAT_OF[m[4]] };
    else if (m[6]) t = { y: +m[8], m: +m[6], fmt: 'my' };
    else if (m[9]) t = { y: +m[10], m: MONTHS[m[9].slice(0, 3).toLowerCase()], fmt: 'month-name' };
    else if (m[11]) t = { y: +m[11], m: null, fmt: 'year' };
    else t = { present: true };
    if (t.m != null && !(t.m >= 1 && t.m <= 12)) Object.assign(t, { m: null, fmt: 'year' });
    out.push({ ...t, text: m[0].trim() });
  }
  return out;
}
const dateRange = text => { const ts = dateTokens(text), i = ts.findIndex(t => !t.present); return i < 0 ? null : { start: ts[i], end: ts[i + 1] || null, tokens: ts.filter(t => !t.present) }; };
// 去掉日期：两个日期之间的「至 / - / to」跟着去掉；公司和职位之间的「–」留着当分隔。
const stripDates = t => String(t).replace(new RegExp(DATE_SRC, 'gi'), '\x01').replace(/\x01\s*(?:至|到|~|～|-|–|—|to|until)\s*(?=\x01)/gi, '').replace(/\x01/g, ' ');
const dateOnly = t => dateTokens(t).length > 0 && !/[\p{L}\p{N}]/u.test(stripDates(t));
const startKey = t => t.y * 12 + (t.m ?? 1) - 1;
const endKey = (d, now) => !d.end ? startKey(d.start) : d.end.present ? now : d.end.y * 12 + (d.end.m ?? 12) - 1;
const showDate = t => t.m ? `${t.y}-${String(t.m).padStart(2, '0')}` : String(t.y);
const sameStart = (a, b) => a.y === b.y && (a.m == null || b.m == null || a.m === b.m);
const monthOf = now => { const d = new Date(now); return Number.isFinite(d.getTime()) ? d.getUTCFullYear() * 12 + d.getUTCMonth() : 0; };
// 一段经历的起止：先看标题行；标题行没有，第一行要点整行只是日期（「2021.07 - 至今」）也算。
function entryDates(e) {
  const withDate = e.head.filter(l => dateTokens(l.text).some(t => !t.present));
  if (withDate.length) return { ...dateRange(e.head.map(l => l.text).join(' | ')), lines: withDate.map(l => l.id) };
  const first = e.lines[0];
  if (first && dateOnly(first.text)) return { ...dateRange(first.text), lines: [first.id] };
  return null;
}

// ── 公司、职位、工作年限 ──────────────────────────────────────────────────────────
// 公司名按「去掉有限公司 / Inc 这类后缀、只留字母数字」比；四个字以上允许包含（Contoso 和 Contoso Shanghai）。
const normCo = s => normalizeCjkCompat(s).toLowerCase().replace(/股份有限公司|有限责任公司|有限公司|公司|集团|\b(?:inc|ltd|llc|co|corp|corporation|limited|gmbh|plc)\b\.?/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const sameCo = (a, b) => { const x = normCo(a), y = normCo(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };
// 标题行拆成几块（公司、职位、地点），日期先去掉：「Contoso · Software Engineer | 2021-07 – Present」。
const SEP = /\s*(?:[·•|｜,，、/／;；]|\s[-–—~]\s|\s+(?:at|@)\s+|\s{2,})\s*/i;
const headParts = e => e.head.flatMap(l => stripDates(l.text).split(SEP)).map(p => p.replace(/^[\s\-–—~:：()（）]+|[\s\-–—~:：()（）]+$/g, '')).filter(p => /[\p{L}\p{N}]/u.test(p));
const hitsCompany = (company, e, parts = headParts(e)) => parts.some(p => sameCo(p, company)) || (normCo(company).length >= 4 && normCo(e.head.map(l => l.text).join(' ')).includes(normCo(company)));
const TITLE_WORDS = /\b(?:engineer|developer|analyst|manager|intern(?:ship)?|associate|consultant|designer|scientist|lead|director|specialist|officer|assistant|architect|researcher|accountant|auditor|trader|banker|partner|head|president|founder|representative|coordinator|administrator)s?\b|工程师|经理|分析师|实习|专员|总监|主管|顾问|设计师|研究员|助理|负责人|开发|运营|产品|架构师|会计|审计|出纳|总裁|创始人|合伙人|主任|专家|组长/i;
const normTitle = s => normalizeCjkCompat(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const sameTitle = (a, b) => { const x = normTitle(a), y = normTitle(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
// 个人资料里的工作：现职（current_work）+ 以前的经历（career_highlights.entries，dates 写「2020-06 至 2020-09」）。
function factJobs(facts) {
  const out = [], cw = obj(facts.current_work);
  if (str(cw.company).trim()) { const start = dateTokens(str(cw.start)).find(t => !t.present) || null; out.push({ company: str(cw.company), title: str(cw.title), start, range: start ? { start, end: { present: true } } : null, current: true }); }
  for (const e0 of arr(obj(facts.career_highlights).entries)) {
    const e = obj(e0);
    if (!str(e.company).trim()) continue;
    const r = dateRange(str(e.dates));
    out.push({ company: str(e.company), title: str(e.role), start: r?.start || null, range: r, current: false });
  }
  return out;
}
const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const cnNumber = s => { if (!s.includes('十')) return CN_DIGIT[s] ?? null; const [a, b] = s.split('十'); return (a ? CN_DIGIT[a] ?? 0 : 1) * 10 + (b ? CN_DIGIT[b] ?? 0 : 0); };
const EN_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
// 「约3年半软件研发经历」「around three and a half years」→ 3.5；认不出来就是 null。
function yearsIn(text) {
  const t = str(text);
  let m = t.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:年|years?|yrs?)\s*(半)?/i);
  if (m && +m[1] <= 50) return +m[1] + (m[2] ? 0.5 : 0);
  m = t.match(/([一二两三四五六七八九十]{1,3})\s*年\s*(半)?/);
  if (m && cnNumber(m[1]) != null) return cnNumber(m[1]) + (m[2] ? 0.5 : 0);
  m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(\s+and\s+a\s+half)?\s+years?\b/i);
  if (m) return EN_WORD[m[1].toLowerCase()] + (m[2] ? 0.5 : 0);
  return /半年|half\s+a\s+year/i.test(t) ? 0.5 : null;
}
// 几段时间合起来一共多少年：重叠的月份只算一次（实习和正职重叠不重复计）。
function spanYears(ranges, now) {
  const iv = ranges.filter(r => r?.start).map(r => [startKey(r.start), Math.max(startKey(r.start), endKey(r, now))]).filter(([a, b]) => b - a < 12 * 60).sort((p, q) => p[0] - q[0]);
  if (!iv.length) return null;
  let total = 0, cur = null;
  for (const [a, b] of iv) { if (!cur || a > cur[1] + 1) { if (cur) total += cur[1] - cur[0] + 1; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
  total += cur[1] - cur[0] + 1;
  return Math.round(total / 12 * 10) / 10;
}
// 工作年限：先信个人资料里写的说法，其次算简历上有日期的工作经历，最后算个人资料里的各段工作。
function experienceYears(m, facts, now) {
  const sum = facts.experience_summary, s = obj(sum);
  for (const v of [sum, s.years, s.total_years, s.outreach_wording, s.outreach_wording_en]) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 50) return v;
    const y = typeof v === 'string' ? yearsIn(v) : null;
    if (y != null) return y;
  }
  return spanYears(m.sections.filter(x => x.kind === 'experience').flatMap(x => x.entries.map(entryDates)), now) ?? spanYears(factJobs(facts).map(j => j.range), now);
}

// ── 错别字与写法：只收有把握的；网址、邮箱、路径、代码里的字一律不碰 ──────────────────
// 英式拼法（analyse、optimisation、colour）是对的，不在表里。
const MISSPELLED = {
  accomodate: 'accommodate', acheive: 'achieve', acheived: 'achieved', acheivement: 'achievement', achievment: 'achievement', acounting: 'accounting', accouting: 'accounting',
  adress: 'address', agressive: 'aggressive', analize: 'analyze', analysys: 'analysis', apparant: 'apparent', arguement: 'argument', begining: 'beginning', beleive: 'believe',
  benifit: 'benefit', buisness: 'business', busines: 'business', calender: 'calendar', catagory: 'category', collegue: 'colleague', comittee: 'committee', commitee: 'committee',
  commited: 'committed', communciation: 'communication', completly: 'completely', comunication: 'communication', concensus: 'consensus', custormer: 'customer', databse: 'database',
  definately: 'definitely', develope: 'develop', developement: 'development', devlopment: 'development', diffrent: 'different', efficency: 'efficiency', enginer: 'engineer',
  enginner: 'engineer', enviornment: 'environment', enviroment: 'environment', existance: 'existence', experiance: 'experience', explaination: 'explanation', familar: 'familiar',
  finacial: 'financial', financal: 'financial', finaly: 'finally', fourty: 'forty', freind: 'friend', goverment: 'government', grammer: 'grammar', guidence: 'guidance',
  happend: 'happened', immediatly: 'immediately', implemention: 'implementation', improvment: 'improvement', independant: 'independent', infomation: 'information',
  intergration: 'integration', knowlege: 'knowledge', langauge: 'language', liase: 'liaise', lisence: 'license', maintainance: 'maintenance', maintanance: 'maintenance',
  maintenence: 'maintenance', managment: 'management', millenium: 'millennium', neccesary: 'necessary', neccessary: 'necessary', necessery: 'necessary', noticable: 'noticeable',
  occassion: 'occasion', occured: 'occurred', occurence: 'occurrence', oppertunity: 'opportunity', oppurtunity: 'opportunity', optimzation: 'optimization', perfomance: 'performance',
  performence: 'performance', persue: 'pursue', posession: 'possession', prefered: 'preferred', profesional: 'professional', proffesional: 'professional', publically: 'publicly',
  realy: 'really', recieve: 'receive', recieved: 'received', recomend: 'recommend', recommand: 'recommend', refered: 'referred', relevent: 'relevant', reponsible: 'responsible',
  requirment: 'requirement', resposible: 'responsible', responsibilty: 'responsibility', responsiblity: 'responsibility', resturant: 'restaurant', schedual: 'schedule',
  seperate: 'separate', seperated: 'separated', seperately: 'separately', sofware: 'software', stratergy: 'strategy', succesful: 'successful', successfull: 'successful',
  successfuly: 'successfully', sucess: 'success', sucessful: 'successful', sucessfully: 'successfully', supercede: 'supersede', techinal: 'technical', tecnical: 'technical',
  thier: 'their', tomorow: 'tomorrow', tommorow: 'tomorrow', transfered: 'transferred', truely: 'truly', untill: 'until', useing: 'using', wierd: 'weird', writting: 'writing',
};
// 技术名词的正式写法。excel 也是动词（excel at…），api 只改英文句子里的：下面 caseFix 里再把关。
const CASE_ALWAYS = {
  javascript: 'JavaScript', typescript: 'TypeScript', github: 'GitHub', gitlab: 'GitLab', mysql: 'MySQL', postgresql: 'PostgreSQL', nodejs: 'Node.js', 'node.js': 'Node.js',
  mongodb: 'MongoDB', linkedin: 'LinkedIn', powerpoint: 'PowerPoint', ios: 'iOS', macos: 'macOS', kubernetes: 'Kubernetes', docker: 'Docker', redis: 'Redis', graphql: 'GraphQL',
  jquery: 'jQuery', tensorflow: 'TensorFlow', pytorch: 'PyTorch', numpy: 'NumPy', wechat: 'WeChat', matlab: 'MATLAB', elasticsearch: 'Elasticsearch', excel: 'Excel', api: 'API',
};
// 这几个也常被有意写成小写：同一份简历别处写过正式写法（Python），才把小写的（python）改过来。
const CASE_IF_SEEN = { python: 'Python', java: 'Java', tableau: 'Tableau', kafka: 'Kafka', django: 'Django', flask: 'Flask', vue: 'Vue' };
function caseFix(word, key, { seen, zh, before, after }) {
  const want = CASE_ALWAYS[key] ?? (CASE_IF_SEEN[key] && seen.has(CASE_IF_SEEN[key]) ? CASE_IF_SEEN[key] : null);
  if (!want || word === want) return null;
  if (word.length > 1 && word === word.toUpperCase() && key !== 'ios' && key !== 'macos') return null; // 全大写多半是有意的排版
  if (key === 'api' && zh) return null;
  if (key === 'excel' && (/^\s+(?:in|at)\b/i.test(after) || /\b(?:to|and|will|can|who|i|we|they|you)\s+$/i.test(before))) return null; // 动词：excel at …
  return want;
}
// 中文常见错字：只收几乎不会误判的；「登陆」只在说系统、账号时改（台风登陆是对的）。其它 / 其他、反应 / 反映不碰。
const ZH_WORDS = [
  { from: '登陆', to: '登录', near: /账号|帐号|账户|系统|页面|界面|接口|态|验证|功能|模块|流程|注册|密码|用户|扫码|后台|认证|鉴权|token|app|网站|平台|微信|手机号/i, why: '进入系统、账号叫「登录」；「登陆」是船靠岸、台风上岸的意思。' },
  { from: '帐号', to: '账号', why: '现在的规范写法是「账号」，「帐号」是旧写法。' },
  { from: '帐户', to: '账户', why: '现在的规范写法是「账户」，「帐户」是旧写法。' },
  { from: '做为', to: '作为', why: '表示「身为、当作」要写「作为」，例如「作为项目负责人」；「做为」是常见错写。' },
  { from: '布署', to: '部署', why: '安排、上线的意思写「部署」，例如「部署到服务器」。' },
  { from: '部暑', to: '部署', why: '安排、上线的意思写「部署」，例如「部署到服务器」。' },
  { from: '调式', to: '调试', unless: /音乐|大调|小调|音阶|和声|乐理/, why: '找错、改错叫「调试」，例如「调试接口」；「调式」是音乐里的词。' },
  { from: '按装', to: '安装', why: '「安装」的「安」是安放的意思，「按装」是常见错写。' },
  { from: '既使', to: '即使', why: '表示「就算」要写「即使」，例如「即使数据缺失也能出报表」。' },
  { from: '迭带', to: '迭代', why: '一轮一轮改进产品叫「迭代」，例如「每两周迭代一次」。' },
  { from: '兼融', to: '兼容', why: '能一起正常工作叫「兼容」，例如「兼容老版本」。' },
  { from: '撤消', to: '撤销', why: '现在的规范写法是「撤销」。' },
];
// 中文连写两遍：只认「的的」「是是」。别的字连写常常是对的（在在线系统、以及及时、与与会者），
// 「的的确确」「的的士」「目的的」「是是否」「是是非非」也是对的。
const ZH_DOUBLE = /(?<!目)的的(?![确士])|是是(?![否非])/g;
// 网址、邮箱、域名（github.com/alex）。邮箱和域名只从一串字母数字的开头试（前面的后视），长串乱码也只花线性时间。
const URLISH = /(?:https?:\/\/|www\.)[^\s，。；、）)]+|(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|(?<![A-Za-z0-9.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|cn|net|org|io|dev|ai|me|co|edu|gov|app|xyz|info|tech|site|cc|us|uk|hk|tw|jp|de|sg)\b(?:\/[^\s，。；、）)]*)?/gi;
const mask = t => t.replace(URLISH, m => '\u0000'.repeat(m.length)); // 长度不变：位置还能对回原文
const TOKEN = /(?<![A-Za-z0-9_\u0000@#.\\-])[A-Za-z][A-Za-z0-9]*(?:\.js)?(?![A-Za-z0-9_\u0000@\\-])/g;
const chunkAt = (t, a, b) => { while (a > 0 && !/\s/.test(t[a - 1])) a--; while (b < t.length && !/\s/.test(t[b])) b++; return t.slice(a, b); };
const keepCase = (from, to) => from.length > 1 && from === from.toUpperCase() ? to.toUpperCase() : /^[A-Z]/.test(from) ? to[0].toUpperCase() + to.slice(1) : to;
function findTypos(text, { seen = new Set(), zh = false } = {}) {
  const out = [], masked = mask(text), push = (kind, at, from, to, rule, why) => out.push({ kind, at, from, to, rule, why });
  for (const m of masked.matchAll(TOKEN)) {
    const word = m[0], at = m.index, key = word.toLowerCase(), chunk = chunkAt(masked, at, at + word.length);
    if (/^[/~]/.test(chunk) || (chunk.match(/\//g) || []).length >= 2 || /[=_`{}<>\\]/.test(chunk)) continue; // 路径、代码
    if (MISSPELLED[key]) { const to = keepCase(word, MISSPELLED[key]); push('misspelling', at, word, to, `typo:${key}→${MISSPELLED[key]}`, `英文拼写错了：「${word}」应为「${to}」。拼错的词按关键词搜不到，也显得不够细心。`); continue; }
    const want = caseFix(word, key, { seen, zh, before: text.slice(Math.max(0, at - 12), at), after: text.slice(at + word.length, at + word.length + 8) });
    if (want) push('casing', at, word, want, `case:${word}→${want}`, `「${want}」是这个名字的正式写法，大小写写对，显得你熟悉这个工具。`);
  }
  for (const m of masked.matchAll(/\b([A-Za-z]+)\s+\1\b/gi)) {
    if (/^(?:had|that)$/i.test(m[1])) continue; // had had、that that 在英文里可以是对的
    push('repeat', m.index, m[0], m[1], `repeat:${m[1].toLowerCase()} ${m[1].toLowerCase()}→${m[1].toLowerCase()}`, `「${m[1]}」连着写了两遍，删掉一个就好。`);
  }
  for (const m of masked.matchAll(ZH_DOUBLE)) push('repeat', m.index, m[0], m[0][0], `repeat:${m[0]}→${m[0][0]}`, `「${m[0][0]}」连着写了两遍，删掉一个就好。`);
  for (const w of ZH_WORDS) {
    for (let i = masked.indexOf(w.from); i >= 0; i = masked.indexOf(w.from, i + w.from.length)) {
      const around = text.slice(Math.max(0, i - 6), i + w.from.length + 6);
      if ((w.near && !w.near.test(around)) || (w.unless && w.unless.test(around))) continue;
      push('zh', i, w.from, w.to, `zh:${w.from}→${w.to}`, w.why);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
// 全文出现过的英文词（区分大小写）：判断「python」要不要改成「Python」用。
const seenWords = m => new Set(m.all.flatMap(l => mask(l.text).match(TOKEN) || []));
// 名字那一行不查错别字：人名不是拼错的词（Teh、Calender 这样的姓都有）。
const typoLines = m => m.all.filter(l => l.text && !(l.where === 'header' && l === m.all[0]));

// ── 体检用到的共同材料 ────────────────────────────────────────────────────────────
// 「要点」：经历 / 项目里讲一件事的行。整理器标了 bullet 的就用标了的；一条都没标，就用这段下面所有的行。
// 「技术栈：Go、Redis」这种标签行、整行只是日期的行不算要点。
const LABEL_LINE = /^\s*(?:tech(?:nology)?\s*stack|tools?|skills?|environment|keywords?|技术栈|技术|工具|技能|环境|关键词|使用技术)\s*[:：]/i;
const statements = e => { const body = e.lines.filter(l => clean(l.text)), flagged = body.filter(l => l.bullet); return (flagged.length ? flagged : body).filter(l => !LABEL_LINE.test(clean(l.text)) && !dateOnly(l.text)); };
const eg = (x, zh, en) => x.lang === 'en' ? en : zh; // 例子跟着简历的语言走，说明文字一律中文
const firstText = ls => ls.find(l => l.text.trim());
function context(m, facts, source, now) {
  const nowKey = monthOf(now), work = [];
  for (const s of m.sections) if (WORK.has(s.kind)) for (const e of s.entries) for (const line of statements(e)) work.push({ line, entry: e, section: s });
  const text = m.all.map(l => l.text).join('\n'), words = wordCount(text), cjk = cjkCount(text), pages = words / 550 + cjk / 1100;
  const issues = [];
  return {
    m, facts, source, now: nowKey, lang: m.lang, work, pages, issues, add: i => issues.push(i),
    years: experienceYears(m, facts, nowKey),
    stats: { words, cjk_chars: cjk, pages: Math.round(pages * 10) / 10, bullets: work.length, bullets_with_numbers: work.filter(w => hasNumber(w.line.text)).length, sections: m.sections.map(s => s.kind) },
  };
}

// ── 1 结构：名字、联系方式、该有的栏目、每段经历的起止时间、栏目顺序 ─────────────────────
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
function hasPhone(t) {
  for (const m of String(t).matchAll(/(?:\+\s?\d{1,3}[\s-]?)?(?:\(\d{1,4}\)\s?)?\d[\d\s-]{5,16}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (!m[0].startsWith('+') && m[0].split(/[\s-]+/).filter(Boolean).every(g => /^(?:19|20)\d{2}$|^\d{1,2}$/.test(g))) continue; // 2019 - 2021 这类日期
    return true;
  }
  return false;
}
const HEADING = /^(?:resume|résumé|curriculum vitae|cv|个人简历|简历|求职简历|个人履历|履历|个人信息|基本信息|personal (?:information|details|profile)|contact(?: information)?|profile|summary|about me|experience|work experience|education|projects|skills|工作经历|教育经历|教育背景|项目经历|专业技能|技能|自我评价)$/i;
const looksLikeHeading = t => { const s = t.replace(/[\s:：|·•\-–—_#*]+/g, ' ').trim(); return HEADING.test(s) || EMAIL.test(t) || hasPhone(t) || /https?:\/\/|www\./i.test(t) || Array.from(s).length > 40; };
function checkStructure(x) {
  const { m, add } = x, cat = 'structure', name = m.header[0];
  if (!name || !name.text.trim()) add({ id: 'structure.no-name', cat, severity: 'high', title: '简历最上面没有名字', detail: '招聘方打开简历第一眼要知道这是谁，系统存档、转给面试官也都按名字来。请在第一行单独写上你的名字，例如「张三」或「Alex Example」。', lines: [] });
  else if (looksLikeHeading(name.text)) add({ id: 'structure.name-heading', cat, severity: 'medium', title: '第一行看起来不是名字', detail: `第一行写的是「${clip(name.text, 20)}」，而招聘方和读简历的软件都默认第一行是姓名，容易把名字认错。请把第一行改成只写你的名字，例如「张三」；「个人简历」这类标题可以删掉。`, lines: [name.id] });
  // 联系方式：名字那几行，再往下看 4 行（有的简历把邮箱电话放在第一栏里）。
  const top = [...m.header, ...m.all.filter(l => l.where !== 'header').slice(0, 4)].map(l => l.text).join('\n');
  if (!EMAIL.test(top)) add({ id: 'structure.no-email', cat, severity: 'high', title: '开头找不到邮箱', detail: '面试邀请、笔试链接大多发到邮箱，招聘方找不到邮箱就没法联系你。请在名字下面一行写上常用邮箱，例如「alex@example.com」。', lines: [] });
  if (!hasPhone(top)) add({ id: 'structure.no-phone', cat, severity: 'medium', title: '开头找不到手机号', detail: '很多 HR 约面试会直接打电话，简历上没有号码就只能等你回邮件，机会容易溜走。请在名字下面一行写上手机号，例如「+86 138 0000 0000」。', lines: [] });
  const kinds = new Set(m.sections.map(s => s.kind));
  if (!kinds.has('experience') && !kinds.has('projects')) add({ id: 'structure.no-experience', cat, severity: 'high', title: '没有工作经历或项目经历这一栏', detail: `招聘方最想看的是你做过什么，没有这一栏，其他部分写得再好也缺少证据。没有正式工作也可以写实习、课程项目或比赛，例如${eg(x, '「Contoso · 财务分析实习 · 2023-06 至 2023-09」', '「Contoso · Finance Intern · 2023-06 – 2023-09」')}。`, lines: [] });
  if (!kinds.has('education')) add({ id: 'structure.no-education', cat, severity: 'medium', title: '没有教育经历这一栏', detail: `大多数岗位都要核对学历，招聘软件也会专门找学校和专业这一栏。请加上学校、学位和专业、起止年月，例如${eg(x, '「示例大学 · 金融学学士 · 2019-09 至 2023-06」', '「Example University · BSc Finance · 2019-09 – 2023-06」')}。`, lines: [] });
  const undated = [];
  let serious = false;
  for (const s of m.sections) {
    if (!WORK.has(s.kind) && s.kind !== 'education') continue;
    for (const e of s.entries) {
      const first = firstText(e.head) || firstText(e.lines);
      if (!first || entryDates(e)) continue;
      undated.push(first.id);
      if (s.kind !== 'projects') serious = true; // 项目没写时间问题小一些；工作、教育没写时间问题大
    }
  }
  if (undated.length) add({ id: 'structure.no-date', cat, severity: serious ? 'medium' : 'low', title: `有 ${undated.length} 段经历没写起止时间`, detail: `招聘方靠起止时间判断你做了多久、中间有没有空档，没写时间容易让人起疑。请在每段经历的标题行写上起止年月，例如${eg(x, '「2021-07 至今」', '「2021-07 – Present」')}。`, lines: uniq(undated), count: undated.length });
  // 工作两年以上还把教育放在工作经历前面：招聘方先看到的是最不重要的部分。应届生教育在前没问题。
  const edu = m.sections.findIndex(s => s.kind === 'education'), exp = m.sections.findIndex(s => s.kind === 'experience');
  if (edu >= 0 && exp > edu && x.years != null && x.years >= 2) add({ id: 'structure.edu-first', cat, severity: 'low', title: '工作几年了，工作经历可以放到教育前面', detail: `你已经有大约 ${Math.round(x.years * 2) / 2} 年工作经验，招聘方更关心你做成过什么，先看到工作经历能更快抓住重点。应届生把教育放前面没问题；工作两年以上，一般把「工作经历」挪到「教育经历」上面。`, lines: uniq([m.sections[edu].title?.id, m.sections[exp].title?.id]) });
}

// ── 2 清晰：太长、太短、开头太虚、被动句 ────────────────────────────────────────────
const WEAK_EN = /^(?:(?:was|were)\s+)?(?:responsible\s+for|worked\s+on|helped(?:\s+to)?|involved\s+in|duties\s+included|tasked\s+with|assisted\s+(?:in|with)|participated\s+in|in\s+charge\s+of)\b/i;
const WEAK_ZH = /^(?:负责|参与|协助)(.*)$/;
// 被动句：was/were + 过去分词开头。「Was promoted / awarded / selected」是成绩，不算。
const PASSIVE = /^(?:was|were|been|is|are)\s+(?!(?:promoted|awarded|selected|recognized|recognised|invited|nominated|chosen|elected|named|honored|honoured|granted|admitted|responsible)\b)(?:[a-z]+ed|built|made|done|given|taken|written|led|run|sent|shown|held|kept|brought|taught|found|set|put|paid|told|sold|drawn|grown|known)\b/i;
function checkClarity(x) {
  const cat = 'clarity', long = [], short = [], weak = [], passive = [], workIds = new Set(x.work.map(w => w.line.id));
  const summary = x.m.sections.filter(s => s.kind === 'summary').flatMap(s => s.entries.flatMap(e => e.lines));
  for (const l of [...x.work.map(w => w.line), ...summary]) {
    const t = clean(l.text);
    if (!t) continue;
    const zh = isZh(t, x.lang), cjk = cjkCount(t);
    if (zh ? cjk > 90 : t.length > 220) long.push(l.id);
    if (!workIds.has(l.id)) continue; // 自我介绍只看长短
    // 中文「负责 / 参与 / 协助」开头要保守：后面不到 12 个字、也没有数字和英文名词（负责相关工作、参与项目开发）才算虚。
    const mz = zh ? t.match(WEAK_ZH) : null;
    if (zh ? !!mz && cjkCount(mz[1]) < 12 && !/[\dA-Za-z]/.test(mz[1]) : WEAK_EN.test(t)) weak.push(l.id);
    else if (zh ? cjk + latinWords(t) * 2 < 8 : wordCount(t) < 6) short.push(l.id);
    if (!zh && PASSIVE.test(t)) passive.push(l.id);
  }
  const group = (id, severity, ids, title, detail) => { const lines = uniq(ids); if (lines.length) x.add({ id, cat, severity, title: title(lines.length), detail, lines, count: lines.length }); };
  // 开头太虚：一半以上的要点都这样是 high，三条以上 medium，零星几条 low。
  group('clarity.too-long', 'medium', long, n => `有 ${n} 条要点写得太长`, `超过两三行的要点，快速浏览的人往往直接跳过，重点反而被埋掉。把一条拆成「做了什么 + 带来什么结果」，删掉过程细节，例如${eg(x, '「重做月度报表流程，出报表从 3 天缩短到半天」', '「Rebuilt the monthly reporting flow, cutting turnaround from 3 days to half a day」')}。`);
  group('clarity.weak-opener', uniq(weak).length >= Math.max(3, x.work.length / 2) ? 'high' : uniq(weak).length >= 3 ? 'medium' : 'low', weak, n => `有 ${n} 条要点开头太虚，看不出你做成了什么`, `${eg(x, '「负责」「参与」「协助」', '「Responsible for」「Worked on」「Helped」')}这样的开头只说明你在场，没说你亲手做成了什么。改成用具体动作开头，例如${eg(x, '把「负责报销工作」写成「审核部门报销单，退回不合规的票据」', '把「Responsible for reporting」写成「Built a weekly sales report for the regional team」')}。`);
  group('clarity.too-short', 'low', short, n => `有 ${n} 条要点太短，看不出具体做了什么`, `只有几个字的要点，招聘方读完还是不知道你具体做了什么。补上做事的对象和结果，例如${eg(x, '把「做数据分析」写成「分析门店销售数据，找出滞销商品并调整进货」', '把「Data analysis」写成「Analyzed store sales data to find slow sellers and adjust orders」')}。`);
  group('clarity.passive', 'low', passive, n => `有 ${n} 条是被动句，看不出是你做的`, '「Reports were prepared…」这种被动句读起来像别人在做事，你的作用被藏起来了。改成以你为主语的动作句，例如把「Reports were prepared weekly」写成「Prepared weekly sales reports for the regional team」。');
}

// ── 3 量化：经历和项目的要点里有没有数字 ─────────────────────────────────────────────
function checkImpact(x) {
  const cat = 'impact', without = x.work.filter(w => !hasNumber(w.line.text));
  if (without.length) {
    const lines = uniq(without.map(w => w.line.id)), ratio = without.length / x.work.length;
    x.add({ id: 'impact.no-number', cat, severity: ratio >= 0.6 ? 'high' : ratio >= 0.3 ? 'medium' : 'low', title: `有 ${without.length} 条经历要点没写数字`, detail: `数字是让一句话可信的东西：${eg(x, '「做了报表」谁都能写，「每周给 3 个部门出报表」', '「Made reports」谁都能写，「Built weekly reports for 3 teams」')}才让人相信你真做过、做得好。助手会一条条问你真实的数字（做了多少、快了多少、省了多少），答不上来就跳过，绝不会替你编。`, lines, count: without.length });
  }
  const bare = [];
  for (const s of x.m.sections) if (WORK.has(s.kind)) for (const e of s.entries) { const h = firstText(e.head); if (h && !statements(e).length) bare.push(h.id); }
  if (bare.length) x.add({ id: 'impact.no-bullets', cat, severity: 'medium', title: `有 ${bare.length} 段经历只有标题，没写做了什么`, detail: `只写了公司和职位，招聘方看不出你在那里做成了什么。每段经历写 2～4 条要点，每条讲一件你做成的事，例如${eg(x, '「搭建客户回款跟进表，每周提醒逾期客户」', '「Set up a payment follow-up tracker that flags overdue clients every week」')}。`, lines: uniq(bare), count: bare.length });
}

// ── 4 ATS 能不能读：招聘方的软件先把简历转成纯文字，读错、读漏的内容 HR 可能根本看不到 ─────────
const ATS_INTRO = 'ATS 是招聘方用来自动读取、筛选简历的软件，很多公司先让它按关键词过一遍，HR 才会看到。';
const CONTACT_LABEL = /e-?mail|邮箱|电子邮件|电话|手机|联系方式|phone|mobile|\btel\b|linkedin|github|微信|wechat/i;
// 装饰符号：★ ✦ ▶ ☎ ✉ ✔ 和表情。最常见的实心圆点、方块当项目符号用，一般读得出来，不算；行首的箭头算。
const DECOR = /[\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u;
const PLAIN_BULLETS = new Set('●○■□◆◇▪▫◦');
const decorative = t => [...t].some(ch => !PLAIN_BULLETS.has(ch) && DECOR.test(ch)) || /^\s*[\u2190-\u21FF]/.test(t);
function checkAts(x) {
  const cat = 'ats', s = x.source, add = x.add, text = typeof s.text === 'string' ? s.text : null, ext = str(s.ext).toLowerCase().replace(/^\./, '');
  if (s.method === 'unpdf' || str(s.warning).trim()) add({ id: 'ats.hard-to-read', cat, severity: 'medium', title: ext && ext !== 'pdf' ? '这份文件的文字不好读' : '这份 PDF 的文字不好读', detail: '我们只能用备用方法读出这份文件的文字，说明它的字体或排版让机器难以识别，招聘方的软件也可能读漏内容。请用 Word 或 WPS 打开原文件，重新「另存为 PDF」再上传，不要用截图或「打印成图片」的方式生成。', lines: [] });
  if (text != null && !text.trim()) add({ id: 'ats.no-text', cat, severity: 'high', title: '文件里读不出文字，可能是扫描件或图片', detail: '扫描件或图片做成的 PDF 在机器眼里只是一张图，读不到任何字，筛选时你的简历等于一片空白。请从 Word 或 WPS 原文件直接导出 PDF：导出后能用鼠标选中文字，就说明机器也能读。', lines: [] });
  else if (text) {
    // (cid:12) 是字体没嵌进 PDF 时读出来的样子；U+FFFD「�」是认不出的字。
    const cid = (text.match(/\(cid:\d+\)/g) || []).length, bad = (text.match(/\uFFFD/g) || []).length;
    if (cid + bad) add({ id: 'ats.garbled', cat, severity: cid || bad >= 5 ? 'high' : 'medium', title: '读出来的文字里有乱码', detail: `我们从这份文件里读到了 ${cid + bad} 处「(cid:12)」或「�」这样的乱码，通常是字体没有嵌进 PDF，招聘方的软件读到的也是乱码，关键词就对不上。请换成常见字体（如宋体、微软雅黑、Arial）重新导出 PDF，再上传检查一次。`, lines: [], count: cid + bad });
    const lig = (text.match(/[\uFB00-\uFB06]/g) || []).length;
    if (lig) add({ id: 'ats.ligature', cat, severity: 'medium', title: '有些字母被读成了连体字', detail: '有的字体会把 fi、fl 这样的两个字母合成一个特殊字符，机器读出来的「finance」就不再是「finance」，按关键词搜你时会漏掉。请换一种常见字体（如 Arial、Calibri）重新导出 PDF。', lines: [], count: lig });
    const n = text.replace(/\s/g, '').length;
    if (n < 400) add({ id: 'ats.little-text', cat, severity: n < 150 ? 'high' : 'medium', title: '从文件里读出的文字太少', detail: `这份文件只读出了 ${n} 个字符，正常一页简历有一两千字，说明大部分内容可能在图片、文本框或表格里，机器读不到。请改用普通段落排版，再重新导出 PDF。`, lines: [] });
  }
  if (ext === 'txt' || ext === 'md') add({ id: 'ats.plain-text-file', cat, severity: 'low', title: '投递前记得导出成 PDF', detail: `你上传的是 .${ext} 纯文字文件，适合在这里修改，但直接发给招聘方会丢掉排版。改好以后用 Word 或 WPS 排好版，导出成 PDF 再投递。`, lines: [] });
  // 图标字体：电话、邮箱前的小图标落在 Unicode 私用区（U+E000–U+F8FF），机器读出来是方块。
  const iconLines = uniq(x.m.all.filter(l => /[\uE000-\uF8FF]/.test(l.text)).map(l => l.id)), icons = text ? (text.match(/[\uE000-\uF8FF]/g) || []).length : 0;
  if (iconLines.length || icons) add({ id: 'ats.icon-font', cat, severity: 'medium', title: '简历里的小图标机器读不出来', detail: '电话、邮箱前面的小图标是用特殊字体画的，机器读出来是一个个看不懂的方块。请把图标换成文字标签，例如写「电话：138 0000 0000」「邮箱：alex@example.com」。', lines: iconLines, count: icons || iconLines.length });
  const deco = uniq(x.m.all.filter(l => decorative(l.text)).map(l => l.id));
  if (deco.length) add({ id: 'ats.symbols', cat, severity: 'low', title: `有 ${deco.length} 行用了装饰符号或表情`, detail: '★、▶、☎ 这类符号在招聘方的软件里经常变成问号或方块，看起来像乱码。项目符号用普通的「•」或「-」就好，电话、邮箱前面直接写文字标签。', lines: deco, count: deco.length });
  // 开头只看得到「邮箱」「电话」这些字、看不到内容：多半做成了图标或超链接，机器读不到。
  // 标签去掉以后什么都不剩（「Email | Phone | LinkedIn」）才算；「GitHub: alex-example」有内容，不算。
  const top = x.m.header.map(l => l.text).join('\n'), labelled = x.m.header.slice(1).filter(l => CONTACT_LABEL.test(l.text));
  const bare = labelled.length > 0 && labelled.every(l => !/[\p{L}\p{N}]/u.test(l.text.replace(new RegExp(CONTACT_LABEL.source, 'gi'), '')));
  if (bare && !EMAIL.test(top) && !hasPhone(top)) add({ id: 'ats.contact-labels', cat, severity: 'medium', title: '联系方式只有名称，读不到内容', detail: '开头能看到「邮箱」「电话」这样的字，却读不到号码和地址，多半是做成了图标或超链接，机器读不出来。请把内容直接写成文字，例如「邮箱：alex@example.com」。', lines: uniq(labelled.map(l => l.id)) });
}

// ── 5 错别字：拼错的英文词、技术名词大小写、中文常见错字、连写两遍、标点混用、连续空格 ──────────
function checkTypos(x) {
  const cat = 'typos', seen = seenWords(x.m), found = { misspelling: [], zh: [], repeat: [], casing: [] };
  for (const l of typoLines(x.m)) for (const f of findTypos(l.text, { seen, zh: isZh(l.text, x.lang) })) found[f.kind].push({ ...f, line: l.id });
  const examples = fs => uniq(fs.map(f => `「${f.from}」→「${f.to}」`)).slice(0, 3).join('、');
  const group = (kind, id, severity, title, detail) => { const fs = found[kind]; if (fs.length) x.add({ id, cat, severity: severity(fs.length), title: title(fs.length), detail: detail(examples(fs)), lines: uniq(fs.map(f => f.line)), count: fs.length }); };
  group('misspelling', 'typos.misspelling', n => n >= 3 ? 'high' : 'medium', n => `有 ${n} 个英文单词拼错了`, ex => `拼错的词会让人觉得不够细心，招聘软件按关键词搜你时，拼错的词也搜不到。找到的有：${ex}，可以一键改正。`);
  group('zh', 'typos.zh-word', () => 'medium', n => `有 ${n} 处常见错别字`, ex => `错别字在中文简历里特别扎眼，会让人怀疑你不够仔细。找到的有：${ex}，每一处都写了原因，可以一键改正。`);
  group('repeat', 'typos.repeated-word', () => 'medium', n => `有 ${n} 处同一个词连写了两遍`, ex => `像「the the」「的的」这样连着写两遍的词，一眼就能看出简历没检查过。找到的有：${ex}，删掉多余的一个就好。`);
  group('casing', 'typos.casing', n => n >= 3 ? 'medium' : 'low', n => `有 ${n} 处技术名词大小写不对`, ex => `「GitHub」「JavaScript」这类名字有固定写法，写成「github」「javascript」会显得对这个工具不熟。找到的有：${ex}，可以一键改正。`);
  // 中文句子里，紧挨着汉字的英文标点（,;:!?()）和中文标点（，。（））同时出现，才算混用。
  const touching = new RegExp(`[${CJK_SRC}][,;:!?()]|[,;!?()]\\s*[${CJK_SRC}]`), mixed = [], spaces = [];
  for (const l of x.m.all) {
    if (l.where === 'header') continue; // 联系方式那几行常这样写，不挑
    const t = mask(l.text);
    if (isZh(t, x.lang) && /[，。；：！？（）、]/.test(t) && touching.test(t)) mixed.push(l.id);
    if (l.where === 'body' && /\S {2,}\S/.test(l.text)) spaces.push(l.id);
  }
  if (mixed.length) x.add({ id: 'typos.mixed-punct', cat, severity: 'low', title: `有 ${uniq(mixed).length} 行中英文标点混着用`, detail: '中文句子里夹着英文的逗号、括号（「,」「(」），和中文的「，」「（」放在一起显得不整齐。中文句子统一用中文标点，例如「整理报表，核对数据」。', lines: uniq(mixed), count: uniq(mixed).length });
  if (spaces.length) x.add({ id: 'typos.double-space', cat, severity: 'low', title: `有 ${uniq(spaces).length} 行出现了连续空格`, detail: '两个空格连在一起，在 PDF 里会显得字距忽大忽小，像排版出了错。把连续的空格改成一个就好。', lines: uniq(spaces), count: uniq(spaces).length });
}

// ── 6 长度：英文约 550 词一页，中文约 1100 字一页，中英混排两者相加 ──────────────────────
function checkLength(x) {
  const cat = 'length', p = x.pages, years = x.years ?? 0;
  if (p > 2 || (p > 1.3 && years < 5)) x.add({ id: 'length.too-long', cat, severity: p > 2 ? 'high' : 'medium', title: `简历大约 ${Math.round(p * 10) / 10} 页，太长了`, detail: `招聘方初筛一份简历通常只看 10 秒左右，内容越多，重点越容易被淹没。${years < 5 ? '工作 5 年以内一般控制在 1 页' : '一般不要超过 2 页'}：删掉和目标岗位无关的经历，合并意思相近的要点。`, lines: [] });
  else if (p < 0.4) x.add({ id: 'length.too-thin', cat, severity: 'medium', title: '内容太少，还不到半页', detail: '招聘方初筛只看 10 秒左右，可内容太少会让人觉得经历单薄，招聘软件也找不到足够的关键词。每段经历补 2～4 条做成的事，再写上会用的技能和工具，写到大半页到一页为宜。', lines: [] });
}

// ── 7 前后一致：日期写法、时间顺序、要点结尾标点、和个人资料对不对得上 ──────────────────────
const entryName = e => clip(headParts(e).slice(0, 2).join(' · ') || firstText(e.head)?.text || '', 30);
function checkConsistency(x) {
  const cat = 'consistency', { m } = x, dated = [];
  for (const s of m.sections) if (WORK.has(s.kind) || s.kind === 'education') for (const e of s.entries) { const d = entryDates(e); if (d) dated.push({ s, e, d }); }
  // 日期写法：用得最多的那种算「主写法」，其余写法的行列出来。
  const byFmt = new Map();
  for (const { d } of dated) for (const t of d.tokens) { if (!byFmt.has(t.fmt)) byFmt.set(t.fmt, []); byFmt.get(t.fmt).push({ text: t.text, lines: d.lines }); }
  if (byFmt.size >= 2) {
    const [main, ...rest] = [...byFmt.values()].sort((a, b) => b.length - a.length), others = rest.flat();
    const minority = new Set(others.flatMap(u => u.lines)); // 行按简历里的先后列
    x.add({ id: 'consistency.date-format', cat, severity: byFmt.size >= 3 ? 'medium' : 'low', title: '日期的写法不统一', detail: `有的写「${main[0].text}」，有的写「${others[0].text}」，看起来不细心，招聘软件也可能因此算错你的工作年限。全文统一成一种写法，例如都写成「${main[0].text}」这样。`, lines: uniq(dated.flatMap(z => z.d.lines).filter(id => minority.has(id))), count: others.length });
  }
  // 顺序：工作经历应该最近的在最上面。下一段的开始和结束都比上一段晚，才算排反了（实习和正职重叠不算）。
  const pairs = [];
  for (const s of m.sections.filter(s => s.kind === 'experience')) {
    const ds = dated.filter(z => z.s === s);
    for (let i = 1; i < ds.length; i++) if (startKey(ds[i].d.start) > startKey(ds[i - 1].d.start) && endKey(ds[i].d, x.now) > endKey(ds[i - 1].d, x.now)) pairs.push([ds[i - 1], ds[i]]);
  }
  if (pairs.length) { const [a, b] = pairs[0]; x.add({ id: 'consistency.order', cat, severity: 'medium', title: '工作经历没有按从近到远排', detail: `「${entryName(b.e)}」比排在它上面的「${entryName(a.e)}」更近，招聘方习惯先看最近的工作，顺序乱了容易误会你现在在哪里。请按时间倒序排列，最近的一段放在最上面。`, lines: uniq(pairs.flatMap(([p, q]) => [...p.d.lines, ...q.d.lines])), count: pairs.length }); }
  // 同一栏里要点结尾的句号：有的有、有的没有。列出少的那一边。
  const endings = [], END = /[.。;；!！]$/;
  for (const s of m.sections) {
    if (s.kind === 'skills') continue;
    const bl = s.entries.flatMap(e => e.lines.filter(l => l.bullet && clean(l.text)));
    const ended = bl.filter(l => END.test(clean(l.text))), open = bl.filter(l => !END.test(clean(l.text)));
    if (bl.length >= 3 && ended.length && open.length) endings.push(...(ended.length <= open.length ? ended : open).map(l => l.id));
  }
  if (endings.length) x.add({ id: 'consistency.bullet-ending', cat, severity: 'low', title: '要点结尾的句号有的有、有的没有', detail: '同一栏里有的要点以句号结尾，有的没有，读起来不整齐。统一一下：要么都加句号，要么都不加（简历里多数人不加）。', lines: uniq(endings), count: uniq(endings).length });
  // 和个人资料对照：同一家公司的开始年月不一样（背景调查会核对）；现职的职位名不一样。
  const jobs = factJobs(x.facts), exp = dated.filter(z => z.s.kind === 'experience').map(z => ({ ...z, parts: headParts(z.e) }));
  const flagged = new Set();
  for (const j of jobs) {
    if (!j.start) continue;
    const hits = exp.filter(z => hitsCompany(j.company, z.e, z.parts));
    if (!hits.length || hits.some(z => sameStart(z.d.start, j.start))) continue;
    const z = (j.current && hits.find(h => h.d.end?.present)) || hits[0];
    // 同一家公司待过两段（资料里记了两段）：简历这段对得上另一段就不算错。
    if (flagged.has(z.e.id) || jobs.some(o => o !== j && o.start && hitsCompany(o.company, z.e, z.parts) && sameStart(z.d.start, o.start))) continue;
    flagged.add(z.e.id);
    const co = z.parts.find(p => sameCo(p, j.company)) || j.company; // 标题里用简历上的写法
    x.add({ id: `consistency.facts-start:${z.e.id}`, cat, severity: 'medium', title: `「${clip(co, 12)}」的开始时间和个人资料对不上`, detail: `简历上写的是 ${showDate(z.d.start)} 开始，你的个人资料里记的是 ${showDate(j.start)}。背景调查会核对入职时间，两边要一致：确认哪个是对的，再把另一边改过来。`, lines: z.d.lines });
  }
  const cw = jobs.find(j => j.current);
  if (cw && cw.title.trim()) {
    const all = m.sections.filter(s => s.kind === 'experience').flatMap(s => s.entries).map(e => ({ e, d: entryDates(e), parts: headParts(e) })).filter(z => hitsCompany(cw.company, z.e, z.parts));
    const z = all.find(h => h.d?.end?.present) || all[0];
    const rest = z ? z.parts.filter(p => !sameCo(p, cw.company)) : [], co = z ? z.parts.find(p => sameCo(p, cw.company)) || cw.company : '';
    const shown = rest.some(p => sameTitle(p, cw.title)) ? null : rest.find(p => TITLE_WORDS.test(p));
    if (shown) x.add({ id: `consistency.facts-title:${z.e.id}`, cat, severity: 'low', title: `「${clip(co, 12)}」的职位和个人资料写的不一样`, detail: `简历上写「${clip(shown, 30)}」，个人资料里是「${clip(cw.title, 30)}」。填申请表时用的是个人资料里的说法，两边不一致会让招聘方疑惑，请确认正式的职位名后统一。`, lines: uniq(z.e.head.filter(l => l.text.includes(shown)).map(l => l.id)) });
  }
}

// ── 汇总：排序、编号去重、打分 ─────────────────────────────────────────────────────
// 排序：先 high 再 medium 再 low，同级按七类的固定顺序，再同级按检查的先后（sort 是稳定的）。
// ATS 这个词第一次出现的那条问题前面补一句解释。标题超过 30 个字就截断。
function finalize(raw) {
  const used = new Map();
  const issues = raw.map(i => {
    const n = (used.get(i.id) || 0) + 1, title = Array.from(i.title);
    used.set(i.id, n);
    return { id: n > 1 ? `${i.id}#${n}` : i.id, cat: i.cat, severity: i.severity, title: title.length > 30 ? title.slice(0, 29).join('') + '…' : i.title, detail: i.detail, lines: uniq(arr(i.lines)), ...(i.count != null ? { count: i.count } : {}) };
  });
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || CAT_ORDER[a.cat] - CAT_ORDER[b.cat]);
  const ats = issues.find(i => i.cat === 'ats');
  if (ats) ats.detail = ATS_INTRO + ats.detail;
  return issues;
}
// 内容太少时不能靠「没挑出毛病」拿满分（空简历不该有 80 分）：清晰、量化看经历 / 项目里的要点，
// 不到 3 条按条数折算；错别字、前后一致看全文，不到半页按页数折算。折算过的类带一句 note 说明原因。
const COVERAGE = {
  clarity: x => [x.work.length / 3, '经历和项目里的要点还不到 3 条，这一项先按写了多少折算。'],
  impact: x => [x.work.length / 3, '经历和项目里的要点还不到 3 条，这一项先按写了多少折算。'],
  typos: x => [x.pages / 0.4, '简历内容还不到半页，这一项先按写了多少折算。'],
  consistency: x => [x.pages / 0.4, '简历内容还不到半页，这一项先按写了多少折算。'],
};
function scoreOf(issues, x) {
  const categories = CATEGORIES.map(c => {
    const penalty = Math.min(1, Math.round(issues.filter(i => i.cat === c.key).reduce((s, i) => s + WEIGHT[i.severity], 0) * 1000) / 1000);
    const [ratio, note] = COVERAGE[c.key] ? COVERAGE[c.key](x) : [1, ''], cover = Math.max(0, Math.min(1, ratio));
    return { key: c.key, label: c.label, score: Math.round(c.max * (1 - penalty) * cover), max: c.max, ...(cover < 1 ? { note } : {}) };
  });
  return { categories, score: categories.reduce((s, c) => s + c.score, 0) };
}

// ── 对外 ────────────────────────────────────────────────────────────────────────
// checkResume(content, { facts, source, now }) → { score, categories, issues, stats }
export function checkResume(content, opts = {}) {
  const { facts, source, now } = obj(opts), when = Number.isFinite(new Date(now ?? NaN).getTime()) ? now : Date.now();
  const x = context(model(content), obj(facts), obj(source), when);
  for (const check of [checkStructure, checkClarity, checkImpact, checkAts, checkTypos, checkLength, checkConsistency]) check(x);
  const issues = finalize(x.issues), { categories, score } = scoreOf(issues, x);
  return { score, categories, issues, stats: x.stats };
}
// ruleFixes(content) → [{ line_id, before, after, rule, why, from, to, at }]：每处一条，after 只改了这一处。
// 同一行有几处时，from / to / at（在 before 里的位置）够页面从右往左依次套用。上锁的栏目、段、行不给改法。
export function ruleFixes(content) {
  const m = model(content), seen = seenWords(m), out = [], done = new Set();
  for (const l of typoLines(m)) {
    if (l.locked || l.entry?.locked || l.section?.locked) continue;
    for (const f of findTypos(l.text, { seen, zh: isZh(l.text, m.lang) })) {
      const key = `${l.id}|${f.at}|${f.rule}`;
      if (done.has(key)) continue;
      done.add(key);
      out.push({ line_id: l.id, before: l.text, after: l.text.slice(0, f.at) + f.to + l.text.slice(f.at + f.from.length), rule: f.rule, why: f.why, from: f.from, to: f.to, at: f.at });
    }
  }
  return out;
}
// quantQuestions(content) → [{ line_id, entry_id, question }]：经历 / 项目里没写数字的要点，每条问一句。
// 只问、不填：本人给了真实数字才写进简历，没有就跳过。上锁的栏目、段、行不问。
export function quantQuestions(content) {
  const m = model(content), seen = new Set(), out = [];
  for (const s of m.sections) {
    if (!WORK.has(s.kind) || s.locked) continue;
    for (const e of s.entries) {
      if (e.locked) continue;
      for (const l of statements(e)) {
        if (l.locked || seen.has(l.id) || hasNumber(l.text)) continue;
        seen.add(l.id);
        out.push({ line_id: l.id, entry_id: e.id, question: `「${clip(clean(l.text), 24)}」这件事有没有能写进简历的数字？比如做了多少、快了多少、省了多少、影响了多少人。没有就跳过，不会替你编。` });
      }
    }
  }
  return out;
}
