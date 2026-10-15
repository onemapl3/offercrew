// 离线整理（2026-09-29）：没有模型可用时（演示 / 沙盒模式，或这台电脑上一个能用的文字模型都没有），
// 按简历的版式用规则整理一份资料草稿。lib/resume-import.mjs 在这两种情况下调它，草稿上写明「没调用模型，只按版式整理」。
//
// 只认常见的写法：
//   - 开头几行：姓名（中文 2–5 个字，或 2–4 个首字母大写的英文词）、邮箱、电话、LinkedIn / GitHub / 作品集链接；
//   - 带冒号的标签，中英文都认：现居、求职意向、期望城市、期望薪资、到岗时间、工作许可、国籍……（在哪一行都行）；
//   - 小节标题：教育背景 / EDUCATION、工作经历 / 实习经历 / EXPERIENCE、技能 / SKILLS、证书 / CERTIFICATIONS……
//     项目、校园活动、获奖、自我评价这些小节不当成经历；
//   - 一行里用两个以上空格、制表符或「|」隔开的几栏（右对齐的地点、日期都这么排）；
//   - 日期：2022.09 - 2026.05、2022-09 至 2026-05、Sep 2022 – May 2026、2025年6月 - 至今、Expected May 2026；
//   - GPA：GPA: 3.7/4.0、GPA 3.6/4.0、绩点 3.6；
//   - 证书：证书名 + 状态原话（Level I passed、已通过、在考）+ 时间。
// 认不准的宁可空着，不猜：每一项都要你核对、勾选才写进资料。输出和模型抽取同一个形状（resume-import 的 EXTRACT_SCHEMA），
// 交给同一个 normalizeDraft 清洗、截断。特制的长文本也是线性时间：每行的空白先压到最多两格，正则里没有「两段可长可短的空白
// 中间只隔一个可有可无的字符」这种写法（tests/resume-offline.test.mjs 拿开头一长段空白、GPA / 年 / graduation 后跟长空白来试）。

// ── 日期 ────────────────────────────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const POINT = `(?:${MON}\\s+\\d{4}|\\d{4}\\s*年\\s*\\d{1,2}(?:\\s*月)?|\\d{4}\\s*[./-]\\s*\\d{1,2}(?!\\d)|\\d{1,2}\\s*/\\s*\\d{4}|\\d{4})`;
const NOW = '(?:至今|现在|目前|present|current|now)';
const RANGE = new RegExp(`(${POINT})\\s*(?:-|–|—|~|～|至|到|to|until)\\s*(${POINT}|${NOW})`, 'i');
const EXPECTED = new RegExp(`(?:expected|anticipated|预计|预期)\\s*(?:graduation(?:\\s*[:：])?\\s*)?(${POINT})(?:\\s*毕业)?`, 'i');
const SINGLE = new RegExp(`^${POINT}$`, 'i');
const NOW_RE = new RegExp(`^${NOW}$`, 'i');
function toMonth(token) {
  const s = String(token ?? '').trim().toLowerCase();
  if (!s) return '';
  if (NOW_RE.test(s)) return '至今';
  const ok = (y, m) => y >= 1950 && y <= 2100 && (m == null || (m >= 1 && m <= 12));
  let m = s.match(new RegExp(`^(${MON})\\s+(\\d{4})$`, 'i'));
  if (m) { const y = Number(m[2]), mo = MONTHS[m[1].slice(0, 3)]; return ok(y, mo) ? `${y}-${String(mo).padStart(2, '0')}` : ''; }
  m = s.match(/^(\d{4})\s*(?:年\s*(\d{1,2})(?:\s*月)?|[./-]\s*(\d{1,2}))$/);
  if (m) { const y = Number(m[1]), mo = Number(m[2] || m[3]); return ok(y, mo) ? `${y}-${String(mo).padStart(2, '0')}` : ''; }
  m = s.match(/^(\d{1,2})\s*\/\s*(\d{4})$/);
  if (m) { const y = Number(m[2]), mo = Number(m[1]); return ok(y, mo) ? `${y}-${String(mo).padStart(2, '0')}` : ''; }
  m = s.match(/^(\d{4})$/);
  return m && ok(Number(m[1])) ? m[1] : '';
}
// 一栏或一行里的日期：区间 → 起止；「Expected May 2026」→ 只有结束；整栏就是一个日期 → single（由调用方决定算开始还是结束）。
function datesOf(text) {
  const t = String(text ?? '');
  let m = t.match(RANGE);
  if (m) { const start = toMonth(m[1]), end = toMonth(m[2]); if (start || end) return { start, end, raw: m[0] }; }
  m = t.match(EXPECTED);
  if (m) { const end = toMonth(m[1]); if (end) return { start: '', end, raw: m[0] }; }
  const whole = t.trim(), d = SINGLE.test(whole) ? toMonth(whole) : '';
  return d ? { start: '', end: d, raw: whole, single: true } : null;
}
const stripDates = s => String(s).replace(RANGE, ' ').replace(EXPECTED, ' ').trim().replace(new RegExp(`^${POINT}$`, 'i'), '');

// ── 一行怎么拆 ───────────────────────────────────────────────────────────────
const cellsOf = line => String(line).split(/\t+|\s{2,}|\s*[|｜]\s*/).map(s => s.trim()).filter(Boolean);
// 去掉空括号和两头的分隔符：两头用循环剪，不用「[…]+$」这种在长空白上会退化成平方的正则。
const EDGE = new Set([...' ,，;；:：|—–·-']);
const clean = s => { const t = String(s ?? '').replace(/\s+/g, ' ').replace(/[（(] ?[)）]/g, ''); let a = 0, b = t.length; while (a < b && EDGE.has(t[a])) a++; while (b > a && EDGE.has(t[b - 1])) b--; return t.slice(a, b); };
const BULLET = /^\s*(?:[•·▪●◦○■□♦◆➢➤►‣⁃∙*]|[-–](?=\s)|\d{1,2}[.、)）](?=\s*\D))\s*/;
const bulletText = line => BULLET.test(line) ? clean(String(line).replace(BULLET, '')) : null;
// 括号里的逗号不拆（「Python（pandas、numpy）」「CFA（Level I, 2026）」）。
function items(text, seps = ',，、;；|') {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(text)) {
    if ('（(【['.includes(ch)) depth++;
    else if ('）)】]'.includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && seps.includes(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(clean).filter(Boolean);
}

// ── 小节标题和标签 ────────────────────────────────────────────────────────────
const SECTIONS = [
  ['education', /^(?:education(?:al background)?|academic (?:background|history)|教育(?:经历|背景|情况)|学历(?:背景)?)$/i],
  ['experience', /^(?:(?:professional|work|relevant|employment|internship|industry|work (?:and|&) internship) experiences?|experiences?|employment(?: history)?|work history|internships?|工作经历|实习经历|工作(?:与|和|及|、)实习经历|实习(?:与|和|及|、)工作经历|职业经历|工作经验|实习经验|实践经历|工作背景)$/i],
  ['skills', /^(?:skills?|technical skills|core (?:skills|competencies)|skills?\s*(?:&|and|,)\s*(?:interests|certifications?|languages|tools|qualifications)(?:\s*(?:&|and|,)\s*[a-z]+)?|additional(?: information)?|技能|专业技能|个人技能|技能特长|技能证书|技能与证书|证书与技能|技能与语言|语言与技能|其他信息|其它信息|附加信息)$/i],
  ['certifications', /^(?:certifications?|certificates?|licen[cs]es?(?:\s*(?:&|and)\s*certifications?)?|证书|资格证书|职业资格|获得证书|证书资质)$/i],
  ['other', /^(?:(?:academic |research |selected )?projects?|项目经历|项目经验|个人项目|leadership(?:\s*(?:&|and)\s*(?:activities|involvement))?|activities|extracurricular(?: activities)?|campus (?:involvement|experience)|volunteer(?:ing| experience)?|校园经历|在校经历|学生工作|社团经历|课外活动|志愿(?:者)?经历|honou?rs?(?:\s*(?:&|and)\s*awards?)?|awards?|获奖(?:情况|经历)?|荣誉(?:奖项)?|奖项|publications?|论文)$/i],
  ['summary', /^(?:summary|profile|objective|career objective|about me|个人简介|自我评价|个人总结|个人优势|求职意向|基本信息|个人信息|联系方式|contact(?: information)?|personal (?:information|details))$/i],
];
function headingOf(line) {
  // 标题都很短：长行直接跳过（下面剪两头的正则碰上很长的一段空格会退化成平方）。
  if (String(line).trim().length > 60) return null;
  const t = String(line).replace(/^[\s#*=_—–【[（(]+|[\s#*=_—–】\]）):：]+$/g, '').trim();
  if (!t || t.length > 40 || BULLET.test(line)) return null;
  for (const [k, re] of SECTIONS) if (re.test(t)) return k;
  // 中英对照的标题（「教育背景 Education」）：任何一半认得就算。
  const parts = t.split(/\s+|\s*\/\s*/).filter(Boolean);
  if (parts.length === 2) for (const [k, re] of SECTIONS) if (parts.some(p => re.test(p))) return k;
  return null;
}
const LABELS = [
  ['name', /^(?:姓\s*名|name)$/i],
  ['email', /^(?:邮\s*箱|电子邮[箱件]|e-?mail)$/i],
  ['phone', /^(?:电\s*话|手\s*机|联系电话|手机号(?:码)?|phone|mobile|tel(?:ephone)?|cell)$/i],
  ['city', /^(?:现居(?:地|城市)?|所在(?:地|城市)|居住(?:地|城市)|现居住地|location|based in|current location)$/i],
  ['roles', /^(?:求职意向|意向岗位|目标岗位|期望职位|应聘岗位|意向职位|目标职位|objective|target (?:role|position)s?|desired (?:role|position)s?)$/i],
  ['cities', /^(?:期望城市|意向城市|目标城市|期望地点|期望工作地点|意向地点|preferred locations?|target locations?|location preferences?)$/i],
  ['salary', /^(?:期望薪资|期望薪酬|期望年薪|期望月薪|薪资要求|expected salary|salary expectations?|expected compensation|desired salary)$/i],
  ['availability', /^(?:到岗时间|最快到岗|入职时间|可到岗时间|可入职时间|availability|available(?: from)?|start date)$/i],
  ['auth', /^(?:工作许可|工作签证|签证(?:状态)?|work authori[sz]ation|visa(?: status)?|work permit)$/i],
  ['citizenship', /^(?:国\s*籍|citizenship|nationality)$/i],
  ['portfolio', /^(?:作品集|个人主页|个人网站|portfolio|website|homepage)$/i],
  ['certs', /^(?:证\s*书|资格证书|certifications?|certificates?|licen[cs]es?)$/i],
  ['skills', /^(?:技\s*能|专业技能|工具|软件|technical(?: skills)?|skills?|software|tools|computer(?: skills)?|programming)$/i],
  ['languages', /^(?:语\s*言|外语|语言能力|languages?)$/i],
  ['skip', /^(?:兴趣(?:爱好)?|爱好|interests|hobbies|主修课程|相关课程|核心课程|课程|(?:relevant )?coursework|courses|荣誉|奖项|获奖|honou?rs?|awards?|scholarships?)$/i],
];
// 「标签：内容」。loose：技能小节里认不得的短标签（Frameworks:、办公软件：）也当技能的分类。
function labelOf(text, { loose = false } = {}) {
  const m = String(text).match(/^\s*([^:：\d@/\s][^:：\d@/]{0,23}?)\s*[:：]\s*(.*)$/);
  if (!m || m[2].startsWith('//')) return null; // https://… 不是标签
  const key = LABELS.find(([, re]) => re.test(m[1].trim()))?.[0];
  if (key) return { key, value: m[2].trim() };
  return loose && m[1].trim().length <= 20 ? { key: 'skills', value: m[2].trim() } : null;
}

// ── 认东西 ──────────────────────────────────────────────────────────────────
// 量词都有上限：一整段没有空格的长文字（特制的文件）也不会让它们来回试到卡住。
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/;
const LINKEDIN = /(?:https?:\/\/)?(?:[\w-]{1,30}\.)?linkedin\.com\/in\/[\w%-]{1,100}\/?/i;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]{1,100}(?:\/[\w.-]{1,100})?\/?/i;
const URL_RE = /https?:\/\/[^\s|｜，,；;]{1,300}/i;
const CN_MOBILE = /(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/;
const phoneLike = s => /^\+?[\d\s().-]{7,24}$/.test(s) && (s.match(/\d/g) || []).length >= 7 && !SINGLE.test(s) && !RANGE.test(s);
const SCHOOL = /大学|学院|学校|中学|University|College|Institute|School|Universit[äé]|Polytechnic|Academy/i;
const DEGREE = /\b(?:Bachelor|Master|B\.?\s?S\.?c?|B\.?\s?A\.?|B\.?\s?Eng|M\.?\s?S\.?c?|M\.?\s?A\.?|M\.?\s?Eng|MBA|MPA|MFin|MSF|Ph\.?\s?D|Doctor|Associate(?:'s)? degree|BBA|BEc|JD|LLM|LLB)\b|学士|硕士|博士|本科|研究生|专科|大专|双学位|辅修|MBA/i;
const HONOR = /dean'?s list|honou?rs?\b|scholarship|award|奖学金|荣誉|优秀|三好|排名|rank/i;
const ORG = /公司|集团|银行|证券|基金|资本|资产|投资|保险|信托|期货|咨询|事务所|工作室|研究院|研究所|有限|股份|电商|科技|传媒|广告|\b(?:Inc|LLC|LP|LLP|Ltd|Limited|Corp|Corporation|Co|Company|Group|Bank|Capital|Partners|Securities|Holdings|Advisors|Advisory|Management|Asset|Investments?|Financial|Consulting|Associates|Fund|Trust|Labs?|Technologies|Technology|Studio|Media|Agency|Bancorp)\b/i;
const TITLE = /\b(?:analyst|associate|intern(?:ship)?|manager|specialist|coordinator|assistant|engineer|developer|consultant|director|officer|representative|lead|trainee|fellow|researcher|strategist|planner|executive|designer|editor|summer analyst)\b|实习生|实习|分析师|专员|经理|主管|助理|顾问|工程师|策划|编辑|总监|负责人|管培生|研究员|运营(?!中心)|设计师|代表/i;
// 地点（右对齐的那一栏）：「New York, NY」「Shanghai, China」、常见城市名、远程。
const COUNTRY = '(?:[A-Z]{2}|China|PRC|USA?|United States|UK|United Kingdom|Hong Kong(?: SAR)?|Singapore|Japan|Canada|Australia|Germany|France|中国)';
const PLACE = new RegExp(`^(?:[A-Z][a-zA-Z.'-]+(?:\\s[A-Z][a-zA-Z.'-]+){0,2},\\s*${COUNTRY}|remote|远程|(?:北京|上海|深圳|广州|杭州|苏州|南京|成都|武汉|西安|天津|重庆|厦门|香港|澳门|台北|新加坡|纽约|伦敦|东京|旧金山|波士顿|芝加哥|西雅图)(?:市)?|New York(?: City)?|NYC|Hong Kong|Singapore|London|Shanghai|Beijing|Shenzhen|Hangzhou|Guangzhou|Tokyo|San Francisco|Boston|Chicago|Seattle)$`, 'i');
const isPlace = s => PLACE.test(String(s).trim());
const GPA = /(?:GPA|绩点|平均绩点)\s*(?:[:：]\s*)?(\d(?:\.\d{1,2})?)(?:\s*\/\s*(\d(?:\.\d{1,2})?))?/i;
const gpaOf = s => { const m = String(s).match(GPA); return m ? (m[2] ? `${m[1]}/${m[2]}` : m[1]) : ''; };
const stripGpa = s => String(s).replace(GPA, ' ');
// 中文一栏里单空格隔开的「示例大学 市场营销 本科」「Fabrikam 消费品有限公司 品牌营销专员」：在学校 / 公司字样后面断开。
const HAN_SCHOOL = /^(.{2,30}?(?:大学|学院|学校))\s+(\S.*)$/u;
const HAN_ORG = /^(.{2,40}?(?:有限公司|公司|集团|银行|证券|基金|资本|事务所|工作室|研究院|研究所))\s+(\S.*)$/u;
const titleCase = s => s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s;

// 证书：证书名 + 状态原话 + 时间。状态照原文取（Level I passed、已通过、在考、通过 3 科），判断层再分已持有 / 在考。
const CERT = /\b(?:CFA|FRM|CPA|ACCA|CMA|CAIA|CFP|SIE|FINRA|PMP|NPDP|CSPO|CDA|CIIA|TOEFL|IELTS)\b|Series\s*\d+|从业资格|注册会计师|会计师|资格证|证书|认证|执照|英语[四六]级|\bCET-?[46]\b|TEM-?[48]|专[四八]|计算机[二三]级|普通话|certified|certification|certificate|qualification|licen[cs]e/i;
const STATUS = /\blevel\s+(?:iii|ii|i|[123])\b(?:\s+(?:candidate|passed|pass|cleared|completed))?|\b(?:candidate|charterholder|charter holder|passed|cleared|completed|in progress|registered|enrolled)\b|(?<=(?:CFA|FRM|CPA|CMA|CAIA)\s*)[一二三]级(?:已通过|已过|通过|候选人|在考|备考)?|[一二三]级(?:已通过|已过|通过|候选人|在考|备考)|已通过|已获得|已取得|已考取|通过\s*\d+\s*科|已过\s*\d+\s*科|持证|在考|备考中?|报考中?/gi;
const DATE_IN = new RegExp(`${MON}\\s+\\d{4}|\\d{4}\\s*年\\s*\\d{1,2}(?:\\s*月)?|\\d{4}\\s*[./-]\\s*\\d{1,2}(?!\\d)`, 'i');
function certOf(item) {
  let text = String(item);
  const dm = text.match(DATE_IN), date = dm ? toMonth(dm[0].replace(/\s+/g, ' ')) : '';
  if (dm) text = text.replace(dm[0], ' ');
  const status = [...text.matchAll(STATUS)].map(m => m[0].replace(/\s+/g, ' ').trim());
  const name = clean(text.replace(STATUS, ' ').replace(/[（(]\s*[)）]/g, ' ').replace(/[（(]\s*$|^\s*[)）]/g, ' '));
  return name ? { name, status: status.join(' ') || null, date: date || null } : null;
}

// ── 小节 ────────────────────────────────────────────────────────────────────
function sectionsOf(lines) {
  const out = [{ kind: 'header', lines: [] }];
  for (const line of lines) { const k = headingOf(line); if (k) out.push({ kind: k, lines: [] }); else out.at(-1).lines.push(line); }
  return out;
}
function educationOf(lines) {
  const out = []; let cur = null;
  const fresh = () => ({ school: '', degree: '', major: null, start: '', end: '', gpa: '' });
  for (const line of lines) {
    if (bulletText(line) != null) continue; // 教育下面的列点是课程、荣誉
    const lab = labelOf(line);
    if (lab && lab.key !== 'name') continue; // 主修课程：…、荣誉：…
    const gpa = gpaOf(line), dates = datesOf(line) || cellsOf(line).map(datesOf).find(Boolean) || null;
    const cells = cellsOf(line).map(c => clean(stripGpa(stripDates(c)))).filter(c => c && !isPlace(c) && !labelOf(c));
    const parts = cells.flatMap(c => { const m = c.match(HAN_SCHOOL); return m ? [m[1], m[2]] : [c]; });
    const school = parts.find(c => SCHOOL.test(c) && !HONOR.test(c));
    if (school && (!cur || cur.school)) { if (cur?.school) out.push(cur); cur = fresh(); }
    cur ??= fresh();
    if (school && !cur.school) cur.school = school;
    const degree = parts.find(c => c !== school && DEGREE.test(c)) || parts.find(c => c !== school && !HONOR.test(c) && !SCHOOL.test(c) && c.length <= 80);
    if (degree && !cur.degree) cur.degree = degree;
    if (dates && !cur.start && !cur.end) Object.assign(cur, { start: dates.start, end: dates.end });
    if (gpa && !cur.gpa) cur.gpa = gpa;
  }
  if (cur?.school) out.push(cur);
  return out;
}
function experienceOf(lines) {
  const out = []; let cur = null;
  const open = () => { cur = { head: [], highlights: [] }; out.push(cur); };
  for (const line of lines) {
    const b = bulletText(line);
    if (b != null) { if (!cur) open(); if (b) cur.highlights.push(b); continue; }
    const lab = labelOf(line);
    if (lab?.key === 'skip') continue;
    const dated = !!(datesOf(line) || cellsOf(line).some(datesOf));
    // 没有列点、接在抬头后面的描述句（只有一栏，而且长或以句号结尾）算这一段做了什么；
    // 有好几栏的（「Fabrikam Capital    Shanghai, China」）是下一段的抬头。
    const flat = clean(line), single = cellsOf(line).length === 1;
    if (cur && !dated && single && (flat.length > 60 || /[。；;]$/.test(flat) || (flat.length > 40 && /\.$/.test(flat)))) { cur.highlights.push(flat); continue; }
    // 上一句被 PDF 折断了（没有句末标点），这一行小写开头：是上一句的后半截（「… from 800」「ms to 200 ms.」），不是新的一段。
    if (cur?.highlights.length && !dated && single && /^[a-z]/.test(flat) && !/[.。;；!?！？]$/.test(cur.highlights.at(-1))) { cur.highlights[cur.highlights.length - 1] += ` ${flat}`; continue; }
    // 新的一段：前一段已经有列点，或者前一段的抬头里已经有日期、这一行又带日期。
    if (!cur || cur.highlights.length || (dated && cur.head.some(l => datesOf(l) || cellsOf(l).some(datesOf)))) open();
    cur.head.push(line);
  }
  return out.map(entryOf).filter(e => e.company);
}
function entryOf({ head, highlights }) {
  let dates = null; const cands = [];
  for (const line of head) for (const c of cellsOf(line)) {
    const d = datesOf(c);
    if (d && !dates) dates = d.single ? { start: d.end, end: '' } : d;
    const rest = clean(stripDates(c));
    if (!rest || isPlace(rest)) continue;
    const m = rest.match(HAN_ORG);
    cands.push(...(m ? [m[1], m[2]] : [rest]));
  }
  let company = cands.find(c => ORG.test(c) && !TITLE.test(c)) || null;
  let title = cands.find(c => c !== company && TITLE.test(c)) || null;
  company ??= cands.find(c => c !== title) || null;
  title ??= cands.find(c => c !== company) || null;
  // 只有一栏：「Summer Analyst, Woodgrove Bank」「Woodgrove Bank — Summer Analyst」
  if (cands.length === 1) {
    const [a, b] = cands[0].split(/\s+[—–|@]\s+|\s+-\s+|,\s+|，|\s+at\s+/).map(clean);
    if (a && b) [company, title] = TITLE.test(a) && !TITLE.test(b) ? [b, a] : [a, b];
  }
  // 分不出公司（整行挤在一栏里）：整栏先当公司，不丢这一段，核对时再改。
  if (!company && title) [company, title] = [title, null];
  return { company: company || '', title: title || null, start: dates?.start || null, end: dates?.end || null, highlights };
}
function skillsOf(sections) {
  const skills = [], certs = [];
  for (const { kind, lines } of sections) {
    if (kind !== 'skills' && kind !== 'certifications') continue;
    for (const raw of lines) {
      const line = bulletText(raw) ?? String(raw).trim();
      if (!line) continue;
      const lab = labelOf(line, { loose: kind === 'skills' });
      if (lab && !['skills', 'languages', 'certs'].includes(lab.key)) continue; // 兴趣、课程、工作许可……在别处读
      const asCert = kind === 'certifications' || lab?.key === 'certs';
      // 证书：先按分号、顿号、竖线分开；逗号后面不像证书的（「CFA Level I, passed Feb 2026」的后半截）是前一个证书的状态，接回去。
      const body = lab ? lab.value : line;
      const pieces = asCert ? items(body, '；;|、').flatMap(p => items(p, ',，').reduce((out, q) => { if (out.length && !CERT.test(q)) out[out.length - 1] += `, ${q}`; else out.push(q); return out; }, [])) : items(body);
      for (const it of pieces) {
        if (it.length > 80) continue; // 一整句话不是技能
        if (asCert || (!lab && CERT.test(it))) { const c = certOf(it); if (c) certs.push(c); }
        else if (it.length <= 60) skills.push(it);
      }
    }
  }
  return { skills, certs };
}
// 美国工作许可：只认写明了的几种说法。「STEM OPT eligible」是现在用 OPT、将来可以延期，按 f1_opt。
function usAuthOf(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (/stem\s*opt/i.test(t) && !/eligible|可申请|符合/i.test(t)) return 'f1_stem_opt';
  if (/\bOPT\b/.test(t)) return 'f1_opt';
  if (/h-?1b/i.test(t)) return 'h1b';
  if (/green card|permanent resident|绿卡/i.test(t)) return 'permanent_resident';
  if (/\bu\.?s\.? citizen|american citizen|美国公民/i.test(t)) return 'citizen';
  if (/(?:require|need)s?\s+(?:visa\s+)?sponsorship|需要.{0,6}担保/i.test(t)) return 'needs_sponsorship';
  return null;
}
const chinaOf = text => /中国(?:大陆)?公民|中国国籍|^中国$|中华人民共和国|chinese citizen|PRC citizen|citizen of (?:the )?(?:PRC|People's Republic of China|China)/i.test(String(text ?? '').trim()) ? 'citizen' : null;
const nameWords = /简历|个人简历|求职简历|resume|curriculum|vitae|\bcv\b/i;
function nameOf(lines) {
  for (const raw of lines.slice(0, 4)) {
    const lab = labelOf(raw);
    const line = lab?.key === 'name' ? lab.value : lab ? '' : String(raw).trim();
    if (!line || line.length > 60 || EMAIL.test(line) || /\d|https?:|www\./.test(line)) continue;
    const t = line.replace(/\s*[|｜/／]\s*/g, ' / ').trim();
    const zh = t.match(/^([\p{Script=Han}·]{2,5})(?:\s*\/\s*|\s+)?([A-Za-z][A-Za-z .'’-]*)?$/u);
    if (zh && !nameWords.test(zh[1])) return { zh: zh[1], en: zh[2] ? titleCase(zh[2].trim()) : '' };
    const en = t.match(/^([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,3})(?:\s*\/\s*([\p{Script=Han}·]{2,5}))?$/u);
    if (en && !nameWords.test(en[1])) return { en: titleCase(en[1]), zh: en[2] || '' };
  }
  return { zh: '', en: '' };
}

// 整份简历文字 → 草稿（EXTRACT_SCHEMA 的形状；空的一律 null / 空数组）。
export function offlineDraft(text) {
  // 每一行先把空白压到最多两格、去掉两头：分栏还认得出（两格以上就是分栏），正则也碰不上长空白（特制的文件）。
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\u00a0/g, ' ').replace(/\s{3,}/g, '  ').trim()).filter(Boolean);
  const sections = sectionsOf(lines), header = sections[0].lines;
  const labels = {};
  for (const line of lines) for (const cell of cellsOf(line)) { const lab = labelOf(cell); if (lab && lab.value && !(lab.key in labels)) labels[lab.key] = lab.value; }
  const all = lines.join('\n');
  const email = (labels.email?.match(EMAIL) || all.match(EMAIL) || [])[0] || null;
  // 抬头的联系方式行也常用「 · 」「 • 」隔开（jane@example.com · (646) 555-0199 · New York, NY）。
  const headerCells = header.flatMap(cellsOf).flatMap(c => c.split(/\s+[·•]\s+/)).map(c => c.trim()).filter(Boolean);
  const phone = (labels.phone && labels.phone.match(/[+\d][\d\s().-]{5,}/)?.[0]?.trim()) || headerCells.find(phoneLike) || (header.join(' ').match(CN_MOBILE) || [])[0] || null;
  const portfolio = labels.portfolio?.match(URL_RE)?.[0] || null;
  const name = nameOf(header);
  const byKind = k => sections.filter(s => s.kind === k).flatMap(s => s.lines);
  const { skills, certs } = skillsOf(sections);
  const auth = [labels.auth, ...lines.filter(l => /\bOPT\b|\bH-?1B\b|green card|visa sponsorship|绿卡|工作签证/i.test(l))].filter(Boolean).join(' ');
  return {
    language: null,
    identity: { name_zh: name.zh || null, name_en: name.en || null, email, phone, linkedin: (all.match(LINKEDIN) || [])[0] || null, github: (all.match(GITHUB) || [])[0] || portfolio },
    education: educationOf(byKind('education')),
    experience: experienceOf(byKind('experience')),
    skills,
    certifications: certs,
    location: { current_city: labels.city || headerCells.find(isPlace) || null, target_cities: labels.cities ? items(labels.cities, '，,、;；/／|') : [] },
    work_authorization: { china_mainland: chinaOf(labels.citizenship) || chinaOf(labels.auth), overseas_remote: null, us: usAuthOf(auth) },
    compensation_expectation: labels.salary || null,
    availability: labels.availability || null,
    target_roles: labels.roles ? items(labels.roles, '，,、;；/／|') : [],
  };
}
