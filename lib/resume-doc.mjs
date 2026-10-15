// 简历助手 · 简历的结构（2026-09-29）：抽出来的文字 → 栏目 / 段落 / 行，每行一个固定编号。
//
// 切分只按原文的行来，不改一个字：去掉行首的项目符号、把 PDF 折行拼回去，别的原样留着
// （tests/resume-doc.test.mjs 逐行核对拼回的文字和原文一致）。行编号在导入时定下，之后的改写
// 不换编号，所以「这一行原来写的是什么」永远查得到——出处核对（lib/resume-provenance.mjs）
// 只拿原简历（v1）、facts.yaml 和你亲口说的话当证据，不拿改过的版本当证据。
//
// content = { lang, header: [行], sections: [{ id, kind, title: 行|null, entries: [{ id, head: [行], lines: [行] }] }] }
// 行 = { id, text, bullet?, em?, origin? }；kind 取 summary / experience / education / projects / skills / awards / other。

// ── 栏目标题 ─────────────────────────────────────────────────────────────────
const HEADINGS = {
  summary: ['summary', 'professional summary', 'career summary', 'profile', 'professional profile', 'about', 'about me', 'objective', 'career objective', 'personal statement', '个人简介', '个人总结', '自我评价', '自我介绍', '个人优势', '个人评价', '简介', '概述', '职业目标', '求职意向'],
  experience: ['experience', 'work experience', 'professional experience', 'relevant experience', 'employment', 'employment history', 'work history', 'career history', 'internship experience', 'internships', 'internship', 'work & internship experience',
    'leadership', 'leadership experience', 'leadership & activities', 'leadership and activities', 'activities', 'extracurricular activities', 'campus involvement', 'volunteer experience', 'volunteering',
    '工作经历', '工作经验', '实习经历', '实习经验', '职业经历', '工作履历', '任职经历', '实践经历', '社会实践', '校园经历', '在校经历', '社团经历', '学生工作', '社团活动', '志愿经历', '志愿者经历'],
  education: ['education', 'education background', 'educational background', 'academic background', 'academics', '教育背景', '教育经历', '学历', '教育', '学习经历'],
  projects: ['projects', 'project experience', 'personal projects', 'selected projects', 'side projects', 'academic projects', 'research projects', 'research experience', 'research', '项目经历', '项目经验', '个人项目', '项目', '科研经历', '研究经历'],
  skills: ['skills', 'technical skills', 'core skills', 'key skills', 'skills & interests', 'skills and interests', 'skills & languages', 'skills, languages & interests', 'additional information', 'core competencies', 'competencies', 'technologies', 'languages',
    '技能', '专业技能', '技能特长', '技术栈', '个人技能', '技能证书', '技能与证书', '专业能力', '语言能力', '其他技能'],
  awards: ['awards', 'honors', 'honours', 'awards & honors', 'honors & awards', 'achievements', 'scholarships', '获奖', '获奖经历', '获奖情况', '荣誉', '荣誉奖项', '奖项', '奖学金'],
  other: ['certifications', 'certificates', 'licenses', 'licenses & certifications', 'publications', 'papers', 'interests', 'hobbies', 'references', '证书', '资格证书', '论文', '发表', '兴趣爱好', '爱好', '其他'],
};
const HEADING_OF = new Map(Object.entries(HEADINGS).flatMap(([kind, words]) => words.map(w => [w, kind])));
export const ENTRY_KINDS = new Set(['experience', 'education', 'projects']);
// 「一、工作经历」「1. Education」「■ 教育背景」「EDUCATION:」「E X P E R I E N C E」都认。
const headingKey = line => {
  let t = String(line).trim();
  if (/^([A-Za-z] ){3,}[A-Za-z]$/.test(t)) t = t.replace(/ /g, '');
  t = t.replace(/^(?:[一二三四五六七八九十]+[、.．]|\d{1,2}[.、)]|[（(]\d{1,2}[)）])\s*/, '').replace(/[（(][^)）]{0,20}[)）]\s*$/, '');
  return t.replace(/^[\s■□●○◆◇▶►•·|:：—–\-_=*#]+|[\s■□●○◆◇▶►•·|:：—–\-_=*#]+$/g, '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*(&|and|和|与)\s*/g, ' & ').trim();
};
export const headingKind = line => String(line).trim().length <= 40 ? HEADING_OF.get(headingKey(line)) || HEADING_OF.get(headingKey(line).replace(/ & /g, ' and ')) || null : null;
// 表里没有的栏目名（「Open Source」「Talks & Writing」「VOLUNTEER WORK」「开源贡献」）：以前被当成上一栏的一行，
// 后面的内容也一起并进上一栏（10-04 负责人：解析出来的顺序、段落和原文对不上）。认法只看这一行自己的样子：
//   · 短（英文 1–5 个词，中文 2–8 个字），没有数字、逗号、句号、@、| 这些正文才有的东西；
//   · 英文：结尾是栏目常用的名词（…Experience / Projects / Writing / Contributions…），每个词大写开头；
//     或者这份简历认得出的栏目名都是全大写，这一行也是全大写；
//   · 中文：结尾是栏目常用的词（…经历 / 项目 / 贡献 / 作品…）。
// 「个人信息」「联系方式」这类不算：它们在抬头里。kind 按词猜，猜不出是 other（一行一条，原样）。
const HEAD_NOUNS = new Set(['experience', 'experiences', 'projects', 'project', 'education', 'skills', 'awards', 'honors', 'honours', 'certifications', 'certificates', 'publications', 'talks', 'writing', 'speaking', 'presentations', 'volunteering', 'leadership', 'activities', 'interests', 'languages', 'coursework', 'contributions', 'source', 'patents', 'research', 'teaching', 'service', 'summary', 'profile', 'objective', 'achievements', 'accomplishments', 'references', 'training', 'courses', 'hobbies', 'involvement', 'affiliations', 'memberships', 'competencies', 'expertise', 'highlights', 'portfolio', 'work', 'qualifications', 'background', 'history', 'employment', 'internships', 'tools', 'technologies', 'stack']);
const ZH_HEAD = /(?:经历|经验|项目|技能|证书|荣誉|奖项|背景|贡献|论文|专利|爱好|评价|作品|成果|培训|活动|能力|简介|总结|优势|语言|社区|演讲|发表|著作|特长|课程)$/;
const NOT_SECTION = /^(?:个人信息|基本信息|联系方式|contact|contact information|personal information|personal details)$/i;
const KIND_WORDS = [['projects', /project|项目|作品|portfolio/i], ['education', /education|coursework|courses|课程|教育|学历/i], ['skills', /skill|tools|technolog|stack|competenc|expertise|languages|技能|语言|特长|能力/i], ['awards', /award|honou?r|achievement|accomplishment|获奖|荣誉|奖项|成果/i], ['summary', /summary|profile|objective|简介|总结|评价|优势/i], ['experience', /experience|employment|volunteer|leadership|internship|teaching|service|经历|经验|实践|活动/i]];
// 弱的词（Research、Work、Service、Leadership…）也常是一段经历、一个项目的名字：下面紧跟着时间（next / next2 是日期行）时不算栏目名。
const WEAK_NOUNS = new Set(['research', 'work', 'service', 'teaching', 'leadership', 'source', 'history', 'background', 'profile', 'project', 'tools', 'stack', 'portfolio', 'training', 'highlights', 'expertise', 'summary', 'objective']);
export function customHeading(line, { caps = false, next = '', next2 = '' } = {}) {
  const t = String(line).trim().replace(/[:：]$/, '').trim();
  if (!t || t.length > 40 || NOT_SECTION.test(t) || /[\d@|,，.。;；!?！？()（）"“”]/.test(t) || isBullet(line)) return null;
  const kindOf = () => (KIND_WORDS.find(([, re]) => re.test(t)) || ['other'])[0];
  if (cjk(t)) return /^[㐀-鿿·&/、 ]{2,8}$/.test(t) && ZH_HEAD.test(t) ? kindOf() : null;
  const words = t.split(/\s+/).filter(w => !/^(?:&|and|of|the|for|in|to|\/)$/i.test(w));
  if (!words.length || words.length > 5 || !words.every(w => /^[A-Za-z][A-Za-z'’/-]*$/.test(w))) return null;
  const upper = !/[a-z]/.test(t) && t.replace(/[^A-Z]/g, '').length >= 3;
  const last = words.at(-1).toLowerCase(), dated = isDateLine(next || '') || isDateLine(next2 || '');
  if (caps && upper && (HEAD_NOUNS.has(last) || !dated)) return kindOf();
  return HEAD_NOUNS.has(last) && !(WEAK_NOUNS.has(last) && dated) && words.every(w => /^[A-Z]/.test(w)) ? kindOf() : null;
}
// 「EXPERIENCE  Contoso Robotics  Austin, TX」：栏目名写在左边一窄条、和第一段同一行（lib/resume-layout.mjs 不当双栏切）。拆成两行。
const marginHeading = line => { const m = /^(\S.{0,38}?) {2,}(\S.*)$/.exec(line); return m && !/[a-z]/.test(m[1]) && (headingKind(m[1]) || customHeading(m[1], { caps: true })) ? [m[1], m[2]] : null; };

// ── 行的样子 ─────────────────────────────────────────────────────────────────
const BULLET = /^\s*(?:[•●○◦▪▫■□◆◇►▶➢➤✓✔✦★☆*·・\-–—]|\d{1,2}[.)、](?!\d)|[（(]\d{1,2}[)）])\s*/;
export const isBullet = line => BULLET.test(line) && String(line).replace(BULLET, '').trim().length > 0;
const stripBullet = line => String(line).replace(BULLET, '').trim();
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const YEAR = '(?:19|20)\\d{2}';
const RANGE = new RegExp(`(?:${YEAR}|${MON}\\s*${YEAR})[^\\n]{0,14}?(?:[-–—~～至到]|\\bto\\b)\\s*(?:${MON}\\s*)?(?:${YEAR}|至今|今|现在|present|now|current|ongoing)`, 'i');
const DATED = new RegExp(`${YEAR}\\s*(?:[./\\-年]\\s*\\d{1,2}\\s*月?)|${MON}\\s*${YEAR}|(?:expected|预计)\\s*.{0,8}${YEAR}|${YEAR}\\s*(?:届|级|毕业)`, 'i');
// 有起止时间（或一个带月份的时间）的非项目符号行，是一段经历的抬头。
export const isDateLine = line => !isBullet(line) && (RANGE.test(line) || DATED.test(line)) && String(line).length <= 120;
const width = s => [...String(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(c) ? 2 : 1), 0);
const TERMINAL = /[。！？.!?；;]$/;
const LABEL = /^[\p{L}\s&/]{1,24}[:：]/u;
const CONTACT = /@|https?:\/\/|(?:linkedin|github)\.com\b|^\+?[\d(][\d\s()+.-]{6,}$/i;
const cjk = s => /[\u3400-\u9fff]/.test(s);
// 折行拼回：英文加空格（行末是连字符的去掉连字符），中文直接接上。
const joinWrap = (a, b) => /-$/.test(a) && /^[a-z]/.test(b) ? a.slice(0, -1) + b : cjk(a.slice(-1)) && cjk(b[0]) ? a + b : `${a} ${b}`;

// ── 切分 ─────────────────────────────────────────────────────────────────────
// 文字 → content。不认识结构时退回「一个栏目、一段、每行一条」，文字一样不丢。
export function parseResume(text, { lang = null } = {}) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '').replace(/^\s+/, '')).filter(l => l && !/^[-_=*·•\s]+$/.test(l))
    .flatMap(l => marginHeading(l) || [l]);
  // 这份简历认得出的栏目名是不是都全大写：是的话，别的全大写短行也是栏目名（customHeading）。
  const known = raw.filter(l => headingKind(l));
  const caps = known.length >= 2 && known.filter(l => !/[a-z]/.test(l) && /[A-Z]/.test(l)).length >= known.length * 0.6;
  const widths = raw.filter(l => !headingKind(l)).map(width).sort((a, b) => a - b);
  const p90 = widths.length >= 8 ? widths[Math.floor(widths.length * 0.9)] : Infinity;
  // 这一行像是被 PDF 折断的：够长、没有句末标点，下一行不是新的一条 / 标题 / 时间 / 「标签：」。
  const wrapped = (a, b) => b != null && width(a) >= 0.82 * p90 && !TERMINAL.test(a) && !isBullet(b) && !headingKind(b) && !isDateLine(b) && !LABEL.test(b) && (cjk(a.slice(-1)) || /^[a-z(]/.test(b) || /[,，、\-–(]$/.test(a) || /\b(and|or|the|of|to|for|with|in|on|by|a|an)$/i.test(a));
  // 带日期的抬头只有已在日期后写「：正文」才接续句；单独的公司 / 职位 / 时间不能吞掉下方正文。
  const headWrap = (a, b) => {
    if (!wrapped(a, b)) return false;
    if (!isDateLine(a)) return true;
    const date = RANGE.exec(a) || DATED.exec(a);
    return /[:：]\s*\S/.test(a.slice(date.index + date[0].length));
  };
  const first = raw.findIndex(l => headingKind(l));
  const header = [], sections = [];
  // 没有任何栏目标题时，抬头只取第一行和紧跟着的联系方式行。
  let top = first;
  if (first < 0) { top = raw.length ? 1 : 0; while (top < raw.length && top < 4 && /@|\+?\d[\d\s()-]{6,}|linkedin|github|https?:\/\//i.test(raw[top])) top++; }
  // 抬头里的长句也会折行，不能让导出器在半句话中间加联系方式分隔点。
  for (let i = 0; i < top; i++) {
    const text = raw[i], last = header.at(-1), next = raw[i + 1];
    const wrap = wrapped(text, next) && !CONTACT.test(next || '');
    if (last?.wrap) { last.text = joinWrap(last.text, text); last.wrap = wrap; }
    else header.push({ text, wrap });
  }
  const body = raw.slice(top);
  let sec = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i], kind = headingKind(line) || (sec && i + 1 < body.length ? customHeading(line, { caps, next: body[i + 1], next2: body[i + 2] }) : null);
    if (kind) { sec = { kind, title: { text: line.replace(/[:：]\s*$/, '').trim() }, entries: [] }; sections.push(sec); continue; }
    if (!sec) { sec = { kind: 'other', title: null, entries: [] }; sections.push(sec); }
    let entry = sec.entries.at(-1);
    const next = body[i + 1], next2 = body[i + 2];
    const newEntry = () => { entry = { head: [], lines: [] }; sec.entries.push(entry); return entry; };
    if (!ENTRY_KINDS.has(sec.kind)) {
      // 简介、技能、其它：一段，按原样一行一条（折行拼回）。
      if (!entry) newEntry();
      const last = entry.lines.at(-1);
      if (last && !isBullet(line) && last.wrap) { last.text = joinWrap(last.text, line); last.wrap = wrapped(line, next); continue; }
      entry.lines.push({ text: isBullet(line) ? stripBullet(line) : line, bullet: isBullet(line), wrap: wrapped(line, next) });
      continue;
    }
    // 经历 / 项目 / 教育：抬头（公司、职位、时间）+ 下面的条目。
    // 「公司 / 职位 / 时间」三行的抬头：中间那行也得像抬头（短、不是一句话）——条目没有项目符号的简历里，
    // 职位下面那句正文后面紧跟着下一段的时间，不能让职位单独成一段（10-04）。
    // 这一段的条目用了项目符号（marked）：之后没符号的行都是上一条的折行，除非它像下一段的抬头。
    if (isBullet(line)) { if (!entry) newEntry(); entry.lines.push({ text: stripBullet(line), bullet: true, wrap: wrapped(line, next) }); entry.marked = true; continue; }
    const shortHead = width(line) <= 90 && !TERMINAL.test(line);
    const headAhead = isDateLine(line) || (shortHead && (isDateLine(next || '') || (!!next && width(next) <= 60 && !TERMINAL.test(next) && !isBullet(next) && isDateLine(next2 || ''))));
    // 一行里写完的经历抬头也可能被 PDF 折断；续句归原行，不凭换行生出一条 bullet。
    const lastHead = entry?.head.at(-1);
    if (!entry?.lines.length && lastHead?.wrap && !headAhead) { lastHead.text = joinWrap(lastHead.text, line); lastHead.wrap = wrapped(line, next); continue; }
    const last = entry?.lines.at(-1);
    if (last && !headAhead && (last.wrap || (entry.marked && !LABEL.test(line)))) { last.text = joinWrap(last.text, line); last.wrap = wrapped(line, next); continue; }
    // dated 记原始行的结构；拼回的长句可能超过 isDateLine 的长度上限，仍要和下一段分开。
    const head = { text: line, dated: isDateLine(line), wrap: headWrap(line, next) };
    // 抬头里已经有时间了，又来一段带时间的抬头（两段教育连着写、下面没有条目）：是下一段，不接在这一段的抬头后面。
    if (headAhead && (!entry || entry.lines.length || entry.head.some(h => h.dated))) { newEntry().head.push(head); continue; }
    // 抬头里已经有时间了：再往下只有短行（职位、地点）还算抬头，长的一行是正文的第一条（没有项目符号的 PDF，10-04）。
    const headRoom = !entry?.head.some(h => h.dated) || width(line) <= 60;
    if (entry && !entry.lines.length && entry.head.length < 3 && headRoom && (shortHead || isDateLine(line))) { entry.head.push(head); continue; }
    if (!entry) newEntry();
    entry.lines.push({ text: line, bullet: true, wrap: wrapped(line, next) });
  }
  return number({ lang: lang || languageOf(raw.join('\n')), header, sections: sections.filter(s => s.entries.length || s.title) });
}
// 编号：按阅读顺序 L1、L2……；栏目 S1……；段 E1……。
function number(c) {
  let l = 0, s = 0, e = 0;
  const line = x => ({ id: `L${++l}`, text: x.text, ...(x.bullet ? { bullet: true } : {}) });
  return {
    lang: c.lang,
    header: c.header.map(line),
    sections: c.sections.map(sec => ({ id: `S${++s}`, kind: sec.kind, title: sec.title ? line(sec.title) : null, entries: sec.entries.map(en => ({ id: `E${++e}`, head: en.head.map(line), lines: en.lines.map(line) })) })),
  };
}
export const languageOf = t => { const c = (String(t).match(/[\u3400-\u9fff]/g) || []).length, a = (String(t).match(/[A-Za-z]/g) || []).length; return c * 2 > a ? 'zh' : 'en'; };

// ── 遍历、查找、改 ────────────────────────────────────────────────────────────
// 每一行连同它在哪：{ line, role: header|title|head|line, section, entry }。
export function* walk(content) {
  for (const line of content?.header || []) yield { line, role: 'header', section: null, entry: null };
  for (const section of content?.sections || []) {
    if (section.title) yield { line: section.title, role: 'title', section, entry: null };
    for (const entry of section.entries || []) {
      for (const line of entry.head || []) yield { line, role: 'head', section, entry };
      for (const line of entry.lines || []) yield { line, role: 'line', section, entry };
    }
  }
}
export const lineIndex = content => new Map([...walk(content)].map(x => [x.line.id, x]));
export const allLines = content => [...walk(content)].map(x => x.line);
export const clone = content => JSON.parse(JSON.stringify(content));
export const maxLineNumber = content => Math.max(0, ...allLines(content).map(l => Number(String(l.id).slice(1)) || 0));
export function findEntry(content, entryId) {
  for (const section of content?.sections || []) for (const entry of section.entries || []) if (entry.id === entryId) return { section, entry };
  return null;
}
// 一段经历的名字（公司 / 学校 / 项目）：抬头第一行在分隔符前的那部分。
export const entryName = entry => String(entry?.head?.[0]?.text || '').split(/\s[|·—–-]\s|[|｜·,，]|\s{2,}|\t/)[0].trim();

// ── 两个版本逐条对比 ──────────────────────────────────────────────────────────
// 按行编号对齐：改了的、新加的、删掉的；位置（在哪一段）跟着 b 走，删掉的跟着 a。
export function diffContent(a, b) {
  const A = lineIndex(a), B = lineIndex(b), out = [];
  const where = x => ({ section: x.section?.title?.text || (x.role === 'header' ? '抬头' : ''), entry: x.entry ? entryName(x.entry) : '' });
  for (const [id, x] of B) {
    const y = A.get(id);
    if (!y) out.push({ id, op: 'added', after: x.line.text, ...where(x) });
    else if (y.line.text !== x.line.text || JSON.stringify(y.line.em || []) !== JSON.stringify(x.line.em || [])) out.push({ id, op: 'changed', before: y.line.text, after: x.line.text, ...where(x) });
  }
  for (const [id, y] of A) if (!B.has(id)) out.push({ id, op: 'removed', before: y.line.text, ...where(y) });
  const order = [...B.keys()], pos = id => { const i = order.indexOf(id); return i < 0 ? [...A.keys()].indexOf(id) : i; };
  return out.sort((x, y) => pos(x.id) - pos(y.id));
}

// ── 证据：原简历 + facts.yaml + 你说过的话 ────────────────────────────────────
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/股份有限公司|有限责任公司|有限公司|公司|集团|\b(inc|ltd|llc|co|corp|corporation|limited|gmbh|university|college)\b/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const str = v => v == null ? '' : typeof v === 'object' ? '' : String(v).trim();
const list = v => Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
// facts.yaml 里能当证据的每一项：{ ref, text, key（公司 / 学校 / 项目名，用来对上是哪一段）, scope }。
export function factsEvidence(facts = {}) {
  const out = [], add = (ref, text, key = '', scope = 'entry') => { for (const t of list(text).map(str).filter(Boolean)) out.push({ ref, text: t, key: norm(key), scope }); };
  const id = facts.identity || {};
  for (const k of ['name_zh', 'name_en', 'email', 'phone_cn', 'linkedin', 'github']) add(`facts:identity.${k}`, id[k], '', 'header');
  const cw = facts.current_work || {};
  if (str(cw.company)) {
    add('facts:current_work', [cw.company, cw.title, cw.start, cw.focus], cw.company);
    list(cw.responsibilities).forEach((r, i) => { add(`facts:current_work.responsibilities[${i}]`, r?.area, cw.company); list(r?.work).forEach((w, j) => add(`facts:current_work.responsibilities[${i}].work[${j}]`, w, cw.company)); });
  }
  list(facts.career_highlights?.entries).forEach((e, i) => { add(`facts:career_highlights[${i}]`, [e?.company, e?.role, e?.dates], e?.company); list(e?.evidence).forEach((x, j) => add(`facts:career_highlights[${i}].evidence[${j}]`, x, e?.company)); });
  list(facts.personal_projects?.entries).forEach((p, i) => { add(`facts:personal_projects[${i}]`, [p?.name, p?.ownership, p?.url], p?.name); add(`facts:personal_projects[${i}].evidence`, p?.evidence, p?.name); add(`facts:personal_projects[${i}].relevance`, list(p?.relevance).map(str).join('、'), p?.name); });
  list(facts.education).forEach((e, i) => add(`facts:education[${i}]`, [e?.school, e?.degree, e?.dates], e?.school));
  const skills = facts.skills;
  if (Array.isArray(skills)) add('facts:skills', skills.map(s => typeof s === 'object' && s ? Object.values(s).flat().map(str).join('、') : str(s)).join('、'), '', 'skills');
  else if (skills && typeof skills === 'object') for (const [k, v] of Object.entries(skills)) add(`facts:skills.${k}`, list(v).map(str).join('、'), '', 'skills');
  const ex = facts.experience_summary || {};
  add('facts:experience_summary', [ex.outreach_wording, ex.outreach_wording_en], '', 'summary');
  const pos = facts.positioning || {};
  add('facts:positioning', [pos.headline, pos.lead_with], '', 'summary');
  list(pos.project_priority).forEach((p, i) => add(`facts:positioning.project_priority[${i}]`, [p?.name, p?.why], p?.name));
  add('facts:standard_answers.languages', list(facts.standard_answers?.languages).map(str).join('、'), '', 'skills');
  add('facts:outreach.language_evidence', facts.outreach?.language_evidence, '', 'skills');
  return out;
}
// 这一条 facts 说的是不是这一段：公司 / 学校 / 项目名出现在抬头里（或者反过来）。
export function factsMatchEntry(item, entry) {
  if (!item.key || !entry) return false;
  const head = norm((entry.head || []).map(l => l.text).join(' ')), name = norm(entryName(entry));
  const enough = s => (/[\u3400-\u9fff]/.test(s) ? s.length >= 2 : s.length >= 4);
  return (enough(item.key) && head.includes(item.key)) || (enough(name) && item.key.includes(name));
}
// 新归属只接受本人肯定的事实陈述。否定、询问、计划和改写要求里提到的词不能变成已使用的技术。
function affirmativeProjectAnswer(text, name = '') {
  const at = String(text).search(/[:：]/);
  const body = at >= 0 && name && norm(text.slice(0, at)) === name ? text.slice(at + 1) : text;
  const negative = /不|没|未|无|\b(?:not|no|never|without|cannot|can['’]t|didn['’]t|doesn['’]t|haven['’]t|hasn['’]t|wasn['’]t|weren['’]t)\b/i;
  const uncertain = /[?？]|是否|能否|可否|要不要|有没有|吗|么|可能|计划|打算|希望|拟(?:用|做|加入)|\b(?:whether|maybe|might|could|would|should|will|plan|planned|planning|intend|intended|wish|hypothetical|todo)\b/i;
  const instruction = /请|(?:帮|替)我|改(?:写|成)|写(?:成|为|上)|加(?:上|入)|新增|添加|补(?:上|写)|删(?:去|除|掉)?|移除|\b(?:please|rewrite|write|add|include|remove|delete|pretend|imagine)\b/i;
  return !negative.test(body) && !uncertain.test(body) && !instruction.test(body);
}
// 一个事实问题可能问到多个个人项目。只把本人按名称分开的回答归到对应项目，不能把整份回答给每段共用。
function namedProjectAnswers(answers, entry, entries, facts) {
  const projects = entries.filter(e => list(facts.personal_projects?.entries).some(p => factsMatchEntry({ key: norm(p?.name) }, e)));
  if (!projects.some(e => e.id === entry.id)) return [];
  const names = projects.map(e => ({ id: e.id, name: norm(entryName(e)) })).filter(e => e.name.length >= 4);
  const targets = text => names.filter(e => norm(text).includes(e.name)).map(e => e.id);
  const out = [];
  for (const a of answers) {
    if (a.by !== 'you' || a.entry_id || a.line_id || !str(a.text)) continue;
    const clauses = String(a.text).split(/[。；;\n]/).map(s => s.trim()).filter(Boolean);
    const named = new Set(clauses.flatMap(targets));
    if (!named.has(entry.id)) continue;
    for (const text of clauses) {
      const ids = targets(text);
      if (!affirmativeProjectAnswer(text, ids.length === 1 ? names.find(n => n.id === ids[0]).name : '')) continue;
      if (ids.length === 1 && ids[0] === entry.id) out.push({ ref: `answer:${a.id}`, text });
      // 共同确认只用于独立/AI辅助这个归属，不把其它项目技术或总项目数变成每个项目的事实。
      const count = /^(两|二|三|四|五|六|七|八|九|十|\d+)项均/.exec(text)?.[1];
      const n = Number(count) || ({ 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })[count];
      const common = /独立个人项目(?:并|且)?(?:使用|采用)?\s*AI\s*辅助开发/i.exec(text)?.[0];
      if (!ids.length && n === named.size && n >= 2 && common && !/不|未|没有|\b(?:not|no|without)\b/i.test(text)) out.push({ ref: `answer:${a.id}`, text: common, nonum: true });
    }
  }
  return out;
}
// 核对某一行时能用的证据：本段（这段经历的原文 + 对上的 facts + 这段的回答）和全文。
// 简介、技能、抬头说的是整个人，本段就是全文。original 是原简历（v1）；新加的行按它所在的段找。
// 你自己加的一段经历（v1 里没有）：本段只有你为这一段写的字和回答，外加它的抬头（抬头只有你能写）；current 是这一版的内容，
// 用来找这一段在哪一节、抬头写的什么。不给 current 也按经历算（宁可错拦）。
export function poolsFor({ lineId = null, entryId = null } = {}, { original, facts = {}, answers = [], userTexts = [], current = null } = {}) {
  const idx = lineIndex(original), at = lineId ? idx.get(lineId) : null;
  const found = at?.entry ? { section: at.section, entry: at.entry } : entryId ? findEntry(original, entryId) : null;
  const items = factsEvidence(facts);
  // 抬头（电话、邮箱、网址）和资料里的联系方式：名字可以引用，里面的数字（+86、手机号）不算任何一条经历的数字（nonum）。
  const heads = new Set((original?.header || []).map(l => l.id));
  const global = [
    ...allLines(original).map(l => ({ ref: `resume:${l.id}`, text: l.text, ...(heads.has(l.id) ? { nonum: true } : {}) })),
    ...items.map(f => ({ ref: f.ref, text: f.text, ...(f.scope === 'header' ? { nonum: true } : {}) })),
    ...answers.filter(a => str(a.text)).map(a => ({ ref: `answer:${a.id}`, text: a.text })),
    ...userTexts.filter(u => str(u.text)).map(u => ({ ref: `user:${u.line_id}`, text: u.text })),
  ];
  if (!found && !at && entryId) {
    const mine = current ? findEntry(current, entryId) : null;
    if (!mine || ENTRY_KINDS.has(mine.section.kind)) {
      const ids = new Set([...(mine?.entry.head || []), ...(mine?.entry.lines || [])].map(l => l.id));
      const local = [
        ...(mine?.entry.head || []).filter(l => str(l.text)).map(l => ({ ref: `user:${l.id}`, text: l.text })),
        ...answers.filter(a => str(a.text) && (a.entry_id === entryId || ids.has(a.line_id))).map(a => ({ ref: `answer:${a.id}`, text: a.text })),
        ...userTexts.filter(u => str(u.text) && (u.entry_id === entryId || ids.has(u.line_id))).map(u => ({ ref: `user:${u.line_id}`, text: u.text })),
      ];
      return { local, global, scope: 'entry', entry: entryId };
    }
  }
  const kind = found?.section?.kind || at?.section?.kind || null;
  if (!found || !ENTRY_KINDS.has(kind)) return { local: global, global, scope: 'global', entry: found?.entry?.id || null };
  const { entry } = found, ids = new Set([...entry.head, ...entry.lines].map(l => l.id));
  const local = [
    ...[...entry.head, ...entry.lines].map(l => ({ ref: `resume:${l.id}`, text: l.text })),
    ...items.filter(f => factsMatchEntry(f, entry)).map(f => ({ ref: f.ref, text: f.text })),
    ...answers.filter(a => str(a.text) && (a.entry_id === entry.id || ids.has(a.line_id))).map(a => ({ ref: `answer:${a.id}`, text: a.text })),
    ...namedProjectAnswers(answers, entry, original.sections.flatMap(s => s.entries), facts),
    ...userTexts.filter(u => str(u.text) && (ids.has(u.line_id) || u.entry_id === entry.id)).map(u => ({ ref: `user:${u.line_id}`, text: u.text })),
  ];
  return { local, global, scope: 'entry', entry: entry.id };
}
// 给人看的出处名：「原简历 · Contoso 第 2 条」「个人资料 · 现职」「你的回答」。
export function refLabel(ref, original) {
  const [kind, rest] = String(ref).split(/:(.*)/s);
  if (kind === 'resume') {
    const x = lineIndex(original).get(rest);
    if (!x) return '原简历';
    if (x.role === 'line' && x.entry) return `原简历 · ${entryName(x.entry) || x.section?.title?.text || ''} 第 ${x.entry.lines.indexOf(x.line) + 1} 条`.replace(/\s+/g, ' ');
    return `原简历 · ${x.role === 'header' ? '抬头' : x.role === 'title' ? '栏目标题' : entryName(x.entry) || '抬头'}`;
  }
  if (kind === 'answer') return '你的回答';
  if (kind === 'user') return '你改写的';
  if (kind === 'facts') return `个人资料 · ${/current_work/.test(rest) ? '现职' : /career_highlights/.test(rest) ? '工作经历' : /personal_projects/.test(rest) ? '个人项目' : /education/.test(rest) ? '教育' : /skills|languages/.test(rest) ? '技能' : /identity/.test(rest) ? '联系方式' : '定位'}`;
  return ref;
}
