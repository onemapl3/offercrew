import { recoverPostingCompany } from './lead-fields.mjs';
import { roleRequirementText, mandatoryExperienceClauses, mandatoryExperienceMention, tenureQuoteText } from './experience-requirements.mjs';
// The question sets. Each function turns one thing the pipeline holds (a lead,
// a mail, a post, a sentence the user typed) into a structured conclusion by
// asking Jev narrow questions and combining the answers in code.
//
// Two rules hold everywhere here. Candidates are found by code and the model
// only selects among them, so a chosen value is always a literal span of the
// source (the pre-parsed value extraction pattern). And a policy — what grade
// is out of range, what counts as a hard gap — is applied by code after the
// model has said what the text says.
import YAML from 'yaml';
import { judge, choice, noul, score, pick, prob, yes, level, threshold } from './judge.mjs';
import fs from 'node:fs';
import { languageEvidence, schoolNames, formerEmployers, factsPath } from './facts.mjs';
import { cityConfigFrom, targetCities, primaryCity, cityBuckets, cityEn, CITY_EN, REMOTE, OTHER } from './city.mjs';
import { screening, screeningFrom, candidateYears, DEFAULT_YEARS, tenureFit, TENURE_WORD, experienceYears, techTenure, domainTenure, worseTenure, keepDomainConflict } from './screening.mjs';
// 求职方向（lib/directions.mjs）、工作许可（lib/work-auth.mjs）、证书（lib/certifications.mjs）：主方向不是软件的人
// 拿到另一套岗位类别、级别和说法；只能在中国工作的人，工作许可那几问是以前的原句。软件方向 + 只在中国的人（作者本人）
// 被问到的每一个问题、按规则得出的每一个结论都和以前逐字相同（tests/golden-software.test.mjs）。
import { isGeneral, directionsOf, tracksOf, primaryDirection, DIRECTIONS, FAMILIES as GENERAL_FAMILIES, GRADES as GENERAL_GRADES, familyLabel as generalFamilyLabel, candidateStage, engineeringTracks, levelYears, trackWhats, tradeLevelYears, cohortMismatch } from './directions.mjs';
import { chinaOnly, judgeWording, usStatus, sponsorshipVerdict, workAuthStated, WORK_AUTH_REQ, UNSTATED_REF, NOT_STATED, asksWorkAuth } from './work-auth.mjs';
import { domainRe, techsIn, hasSkill, supportedEvidence, softSkill } from './tech-words.mjs';
import { certificationEvidence, hardGateGaps } from './certifications.mjs';
import { currentFacts } from './facts.mjs';

// 2026-09-23a: posts are judged from their own body (needs_jd instead of a
// silent skip), a 3–5 year line conflict is a tenure gap (verify), anonymous
// reposts are retired as roundups, a social post that offers no job is
// retired (not_a_job_post). Only people's posts get a new question; every
// other reading is served from state/judge-cache when its text is unchanged,
// so a re-judge mostly re-applies the policy.
// accuracy-h also reviews persisted g results after the worded-tenure citation
// fix; the existing queue keeps batch/budget limits and user/outbound history.
export const JUDGEMENT_VERSION = 'jev-2026-10-11-accuracy-h';
// 候选人的年限来自 candidate/facts.yaml（lib/screening.mjs）；这个常量只是 facts 里什么都推不出来时的缺省值。
export const CANDIDATE_YEARS = DEFAULT_YEARS;
// The largest mandatory tenure a single requirement line may ask for and still
// be a gap the user decides on (verify) rather than a conflict (exclude). Eight
// years and more retires the lead before matching (postingPrefilterReason).
// 缺省年限（2.5）下的上限；按候选人算的是 lib/screening.mjs 的 tenureGapMax（年限 + 2.5）。
export const TENURE_GAP_MAX = 5;

// ---------------------------------------------------------------------------
// Candidate generation (code, no model).

const CITY_NAMES = ['杭州', '上海', '苏州', '北京', '深圳', '广州', '成都', '南京', '合肥', '武汉', '西安', '重庆', '天津', '厦门', '青岛', '大连', '长沙', '珠海', '无锡', '宁波', '香港', '新加坡',
  'Hangzhou', 'Shanghai', 'Suzhou', 'Beijing', 'Shenzhen', 'Guangzhou', 'Chengdu', 'Nanjing', 'Hefei', 'Wuhan', "Xi'an", 'Chongqing', 'Tianjin', 'Xiamen', 'Qingdao', 'Dalian', 'Changsha', 'Zhuhai', 'Wuxi', 'Ningbo', 'Hong Kong', 'Singapore', 'Taipei', 'Tokyo', 'London', 'Berlin', 'San Francisco', 'New York', 'Seattle', 'Toronto', 'Sydney', 'Bangalore', 'Dublin', 'Amsterdam', 'Paris', 'Kunshan'];
export function cityCandidates(...texts) {
  const s = texts.filter(Boolean).join('\n');
  const found = CITY_NAMES.filter((c) => (/^[A-Za-z' ]+$/.test(c) ? new RegExp(`\\b${c.replace(/'/g, "'?")}\\b`, 'i') : new RegExp(c)).test(s));
  return [...new Set(found.map((c) => canonicalCity(c)))];
}
const CITY_ALIAS = { Hangzhou: '杭州', Shanghai: '上海', Suzhou: '苏州', Beijing: '北京', Shenzhen: '深圳', Guangzhou: '广州', Chengdu: '成都', Nanjing: '南京', Hefei: '合肥', Wuhan: '武汉', "Xi'an": '西安', Chongqing: '重庆', Tianjin: '天津', Xiamen: '厦门', Qingdao: '青岛', Dalian: '大连', Changsha: '长沙', Zhuhai: '珠海', Wuxi: '无锡', Ningbo: '宁波', 'Hong Kong': '香港', Singapore: '新加坡', Kunshan: '昆山' };
const canonicalCity = (c) => CITY_ALIAS[c] || c;

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
function parseYears(s) {
  const m = String(s).match(/(\d{1,2})/);
  if (m) return Number(m[1]);
  const cn = String(s).match(/([一二两三四五六七八九十]+)/);
  if (cn) {
    const t = cn[1];
    if (t.length === 1) return CN_NUM[t];
    if (t.startsWith('十')) return 10 + (CN_NUM[t[1]] || 0);
    if (t.endsWith('十')) return CN_NUM[t[0]] * 10;
    if (t.includes('十')) return CN_NUM[t[0]] * 10 + CN_NUM[t[2]];
  }
  const en = String(s).toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b/);
  return en ? EN_NUM[en[1]] : null;
}
// Over-inclusive on purpose: every "N years / N年" mention with 30 characters
// of context. The model decides which one, if any, is the minimum required.
// A number glued to more digits is a calendar year, not a span: 「2027年硕士应届毕业生」 is not 27 years
// (2026-10-02 端到端：中信建投的 2027 届校招全被当成要 27 年经验，在预筛就挡掉了). A range is read from its
// lower end whatever the dash — 「2‑5年」 (U+2011) and "1 to 5 years" are 2 and 1, not 5.
// 只在通用路径（主方向不是软件）这样读；软件方向（没写方向的资料，包括作者本人）照旧用改之前的写法，
// 发给 Jev 的问题和规则结论逐字节不变（tests/golden-software.test.mjs）。
const YEAR_SPANS = [
  /(?<!\d)(\d{1,2})\s*\+?\s*(?:(?:[-‐‑‒–—~～至到]|to\b)\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?|年)/gi,
  /([一二两三四五六七八九十]+)\s*(?:[至到]\s*[一二两三四五六七八九十]+\s*)?年/g,
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\+?\s+(?:\w+\s+)?years?\b/gi,
];
const LEGACY_YEAR_SPANS = [
  /(\d{1,2})\s*\+?\s*(?:[-–—~至到]\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?|年)/gi,
  YEAR_SPANS[1],
  YEAR_SPANS[2],
];
export function yearCandidates(jd = '', { general = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const re of general ? YEAR_SPANS : LEGACY_YEAR_SPANS) for (const m of String(jd).matchAll(re)) {
    const years = parseYears(m[1]);
    if (!years || years > 30) continue;
    // 通用路径：只认跟经验连在一起的年数（lib/screening.mjs experienceYears）；「公司成立 10 年以上」不是年限要求。
    if (general && !experienceYears(jd, m.index, m[0].length)) continue;
    const start = Math.max(0, m.index - 30), end = Math.min(jd.length, m.index + m[0].length + 30);
    const context = jd.slice(start, end).replace(/\s+/g, ' ').trim();
    const key = `${years}|${context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = { id: `y${out.length}`, years, span: m[0].trim(), context };
    Object.defineProperty(candidate, 'source_index', { value: m.index });
    out.push(candidate);
    if (out.length >= 20) break;
  }
  return out;
}

// The posting's own lines. `quote` is the untouched substring of jd_text so a
// citation built from it always passes the "quoted verbatim" check; `text` is
// the cleaned display form.
export function postingLines(jd = '', max = 60) {
  const raw = String(jd);
  // ATS adapters collapse whitespace, so a sentence boundary followed by a
  // capital, a CJK character or a bullet is a line break too.
  const parts = raw.split(/\r?\n|(?<=[。！？；;])|(?<=[.!?])\s+(?=[A-Z\u4e00-\u9fff•·▪●-])|(?<=(?:要求|职责|Requirements|Responsibilities|Qualifications)\s{0,2}[：:])\s*|(?=\s[·•▪●]\s*)|(?=\s\d{1,2}[.、)）]\s)|(?=\s[-–—]\s)/);
  const out = [];
  for (const p of parts) {
    const quote = p.trim();
    const text = quote.replace(/^(?:[-*+•·▪●—–]|\d{1,2}\s*[.、)）])\s*/, '').replace(/\s+/g, ' ').trim();
    if (text.length < 4 || !raw.includes(quote)) continue;
    out.push({ id: `l${out.length}`, quote, text });
    if (out.length >= max) break;
  }
  return out;
}

// What a lead must hold before Jev reads it. An ATS page is a full JD; a post by
// a person is often three lines ("招 Agent 开发，base 杭州，私聊") and is still a
// real opening, so the floor is a named role and something to read, not a JD
// length. Whether the text states duties or requirements is Jev's reading of the
// lines (postingGaps); code only refuses to spend a request on nothing.
export const PLACEHOLDER_ROLE = '软件工程岗位（原帖待核）';
export const MIN_POST_CHARS = 20;
const visibleChars = (s) => String(s || '').replace(/\s+/g, '').length;
export function leadContent(lead = {}) {
  const role = String(lead.role || '').trim();
  const body = visibleChars(lead.jd_text || lead.jd);
  const named = !!role && role !== PLACEHOLDER_ROLE;
  const missing = [];
  // A long body can name the role itself; a short one without a title cannot.
  if (!named && body < 100) missing.push('岗位名称');
  if (body < MIN_POST_CHARS) missing.push('帖子正文');
  return { readable: !missing.length, missing, chars: body };
}
// Which parts of a read posting are absent. `blocking` means there is nothing
// to match requirement by requirement: no duty, no requirement, not even a
// preferred skill. Such a lead can still be retired by grade, family or city,
// but never recommended; the gap names what to ask the poster for.
export function postingGaps(posting, lead = {}) {
  const kinds = new Set((posting?.lines || []).map((l) => l.kind));
  const missing = [];
  if (!kinds.has('duty')) missing.push('职责');
  if (!kinds.has('hard_requirement') && !kinds.has('preferred')) missing.push('任职要求');
  const blocking = !kinds.has('duty') && !kinds.has('hard_requirement') && !kinds.has('preferred');
  if (posting?.city === 'not_stated' && !cityCandidates(lead.location).length && !/远程|remote/i.test(String(lead.location || ''))) missing.push('工作城市');
  return { missing, blocking };
}
const HUMAN_SOURCE = /真人|内推|HR直发|Boss/;
export const isHuman = (lead = {}) => HUMAN_SOURCE.test(String(lead.source_type || ''));

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export const emailCandidates = (...texts) => [...new Set((texts.filter(Boolean).join('\n').match(EMAIL) || []).map((e) => e.toLowerCase()))].slice(0, 30);

// Evidence the model may cite for the candidate. Every item is a fact from
// candidate/facts.yaml, so a `resume_ref` is always something the user wrote.
export function candidateEvidence(facts = loadFacts()) {
  const items = [];
  const add = (text) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); if (t && !items.some((i) => i.text === t)) items.push({ id: `e${items.length}`, text: t }); };
  const general = isGeneral(facts);
  for (const e of facts.education || []) add(general && e.gpa ? `学历：${e.school} ${e.degree}（${e.dates}）GPA ${e.gpa}` : `学历：${e.school} ${e.degree}（${e.dates}）`);
  add(`工作年限：${facts.experience_summary?.outreach_wording || ''}；${facts.experience_summary?.calculation || ''}`);
  const cw = facts.current_work || {};
  if (cw.company) add(`现职：${cw.company} ${cw.title}（${cw.start} 至今）：${cw.focus || ''}`);
  for (const r of cw.responsibilities || []) add(`现职 · ${r.area}：${(r.work || []).join(' ')}`);
  for (const e of facts.career_highlights?.entries || []) add(`${e.company}（${e.role}，${e.dates}）：${(e.evidence || []).join(' ')}`);
  for (const p of facts.personal_projects?.entries || []) add(`个人项目 ${p.name}（${p.ownership || ''}）：${p.evidence}${p.relevance ? '；相关：' + p.relevance.join('、') : ''}`);
  // 工作许可一项都没填：照实说没填，不写「中国大陆公民」（开箱第 5 轮：模型据此写「按题设中国公民」）。
  add(!workAuthStated(facts) ? '工作资格：资料里没填' : chinaOnly(facts) ? `工作资格：中国大陆公民（${facts.work_authorization?.china_mainland || ''}）；海外远程：${facts.work_authorization?.overseas_remote || ''}；美国：${facts.work_authorization?.us || ''}` : `工作资格：美国 ${WORK_US[usStatus(facts)] || usStatus(facts)}；中国大陆 ${facts.work_authorization?.china_mainland || '未写'}；海外远程：${facts.work_authorization?.overseas_remote || '未写'}`);
  add(`所在地：现居${facts.location?.current_city || ''}，目标城市 ${(facts.location?.target_cities || []).join('、')}，可搬迁：${facts.location?.relocation_ok || ''}；工作方式偏好 ${(facts.location?.work_mode_preference || []).join(' > ')}`);
  // 语言那一条是本人的原话（facts.yaml outreach.language_evidence），以前写死在这里。
  const lang = languageEvidence(facts);
  if (lang) add(`语言：${lang}`);
  // 通用路径多两条：证书、技能（金融、市场的岗位常按这两样要人；软件方向的证据还是以前那些）。
  if (general) {
    const certs = certificationEvidence(facts);
    if (certs) add(certs);
    const skills = (Array.isArray(facts.skills) ? facts.skills : []).map(String).filter(Boolean);
    if (skills.length) add(`技能：${skills.slice(0, 30).join('、')}`);
  }
  return items.slice(0, 40);
}
const WORK_US = { citizen: '公民', permanent_resident: '绿卡', f1_opt: 'F-1 OPT（现在可以工作，以后需要 H-1B 担保）', f1_stem_opt: 'F-1 STEM OPT（现在可以工作，以后需要 H-1B 担保）', h1b: 'H-1B（换雇主要转签）', needs_sponsorship: '需要签证担保', authorized: '有工作许可', none: '没有工作许可' };
// candidate/facts.yaml（或 RADAR_FACTS 指的文件，见 lib/facts.mjs）；缺文件照旧抛错。
export const loadFacts = () => YAML.parse(fs.readFileSync(factsPath(), 'utf8'));
export function candidateSummary(facts = loadFacts()) {
  return {
    years_experience: candidateYears(facts),
    education: (facts.education || []).map((e) => `${e.school} ${e.degree}`).join('；'),
    location: `现居${facts.location?.current_city}；目标 ${(facts.location?.target_cities || []).join('、')}；可搬迁 ${facts.location?.relocation_ok || ''}`,
    work_authorization: facts.work_authorization || {},
    target_roles: (facts.preferences?.role_families || []).join('；'),
    hard_exclusions: (facts.preferences?.hard_exclusions || []).join('；'),
    positioning: facts.positioning?.headline || '',
    // 通用路径：方向、细分、阶段（应届 / 在读）。软件方向的摘要和以前一样，没有这几个键。
    ...(isGeneral(facts) ? { direction: directionsOf(facts).join(', '), tracks: tracksOf(facts).join(', '), stage: candidateStage(facts, candidateYears(facts)) } : {}),
  };
}

// ---------------------------------------------------------------------------
// A. Read a posting: what the text says about grade, family, city, tenure,
// degree, company type and which lines are duties or requirements.

export const GRADES = {
  junior: 'Entry level: junior, 初级, 应届, 校招, graduate, intern, 实习',
  mid: 'No grade word in the title, or 中级 / intermediate / "Software Engineer II"',
  senior_or_above: 'Senior, Sr., Staff, Principal, Lead, Tech Lead, Architect, Expert, 资深, 高级, 专家, 架构师, 技术负责人. "Lead" as a verb or in a product name does not count.',
  management: 'People management: Manager, Director, Head of, VP, AVP, SVP, 总监, 经理, 负责人 (of a department), 首席',
};
export const FAMILIES = {
  ai_application: 'Builds products on top of LLMs: AI application, applied AI, agent engineering, RAG, prompt/workflow orchestration, AI engineer, 大模型应用, 智能体, AI 应用开发',
  backend_platform: 'Backend, server, platform, infrastructure, distributed systems, microservices, middleware, API services, 后端, 服务端, 平台, 基础架构',
  fullstack: 'Full-stack or product engineering with both frontend and backend, web application development, 全栈',
  algorithm_or_training: 'Training or researching models: algorithm engineer, ML/DL researcher, pre-training, post-training, RLHF/SFT/DPO, multimodal research, 算法工程师, 模型训练, 强化学习',
  data: 'Data engineering, data platform, ETL, data warehouse, BI, analytics engineering, 数据开发, 数仓',
  devops_sre: 'DevOps, SRE, release engineering, CI/CD, cloud operations, 运维, 研发效能',
  mobile: 'iOS, Android, Flutter, React Native, mobile client development, 客户端',
  frontend_only: 'Frontend only: web UI, React/Vue without backend responsibility, 前端开发, UI 开发',
  qa_ba_pm: 'QA, test engineer, SDET, business analyst, project manager, product manager, 测试, 产品经理, 项目经理',
  hardware_industrial: 'Hardware, embedded, firmware, automotive, robotics, manufacturing, mechanical, electrical, chip, 硬件, 嵌入式, 汽车, 机械, 制造',
  non_engineering: 'Sales, recruiting, marketing, operations, finance, legal, customer support, 销售, 招聘, 运营, 财务',
  other: 'Something else, or the text does not say what the work is',
};
export const COMPANY_TYPES = {
  foreign_mnc: 'Foreign or global company, overseas headquarters, multinational, 外企',
  chinese_big_tech: 'Large Chinese internet or technology company (阿里, 腾讯, 字节, 网易, 百度, 美团, 华为 and similar)',
  state_owned: 'State-owned enterprise, government-affiliated, 国企, 央企, 事业单位',
  startup: 'Startup or small company, venture-backed, 创业公司, 初创',
  outsourcing: 'Outsourcing, staffing, labour dispatch, headhunter posting on behalf of a client, 外包, 人力资源公司, 猎头',
  unknown: 'The text does not make the company type clear',
};
export const DEGREES = {
  phd: 'Doctorate required, 博士',
  master: 'Master required, 硕士, 研究生',
  bachelor: 'Bachelor required, 本科, 学士, 本科及以上',
  associate: 'Associate/college required, 大专, 专科',
  not_limited: 'Explicitly no degree requirement, 学历不限, 不限学历',
  not_stated: 'The posting does not state a degree level',
};
export const LINE_KINDS = {
  duty: 'A responsibility of the role: what the hire will do (负责, 你将, build, own, develop)',
  hard_requirement: 'A qualification the hire must have: required skills, years, degree, language (要求, 具备, 熟悉, 精通, must, required)',
  preferred: 'A nice-to-have: 优先, 加分, preferred, bonus, plus, nice to have',
  boilerplate: 'About the company, team, culture, benefits, salary, process, legal notice, address',
  heading: 'A section label with no content of its own (岗位职责, 任职要求, Requirements)',
  other: 'None of the above',
};

// 通用路径（主方向不是软件）读 JD 时换的几问：级别（实习 / 应届 / 有经验 / 资深 / 管理）、岗位类别（投行、资管、咨询、
// 市场……），不问「是不是软件工程岗」。读出来的 posting 带 question_set: 'general'，换了方向的人会被重新读一遍。
const generalGrades = () => GENERAL_GRADES;
// 只用来显示旧结果的 legacy 类别（拆掉的「人力 / 行政 / 法务」）不再当选项。
const generalFamilies = () => Object.fromEntries(Object.entries(GENERAL_FAMILIES).filter(([, f]) => !f.legacy).map(([k, f]) => [k, f.what]));
export const questionSet = (facts = currentFacts()) => (isGeneral(facts) ? 'general' : 'software');
// 用量页上给人看的一句：「判断 #12 · 某公司」。
const judgeWhat = lead => `判断 ${lead.number != null ? `#${lead.number} · ` : ''}${[lead.company, lead.role].filter(Boolean).join(' · ') || '一个岗位'}`.slice(0, 80);
export async function readPosting(lead, { request_id } = {}) {
  lead = { ...lead, ...recoverPostingCompany(lead) };
  const facts = currentFacts(), general = isGeneral(facts), wording = judgeWording(facts);
  const scoped = roleRequirementText(lead), jd = scoped || String(lead.jd_text || lead.jd || '');
  const years = yearCandidates(jd, { general });
  const lines = postingLines(jd);
  const cities = cityCandidates(lead.location, lead.role, jd);
  const state = {
    title: String(lead.role || ''),
    company: String(lead.company || ''),
    location_field: String(lead.location || ''),
    salary_field: String(lead.salary || lead.salary_range || ''),
    source_type: String(lead.source_type || ''),
    jd,
    year_mentions: years.map(({ id, span, context }) => ({ id, span, context })),
    lines: lines.map(({ id, text }) => ({ id, text })),
  };
  const q = {
    grade: choice('What seniority grade does the job `title` advertise? Judge the title first; use `jd` only when the title has no grade word.', general ? generalGrades() : GRADES),
    job_family: choice('Which family does this job belong to, judging by what the hire will spend most of their time doing (`title`, then `jd`)?', general ? generalFamilies() : FAMILIES),
    ...(general ? {} : { is_software_engineering: noul('This is a software engineering role whose main work is writing and shipping software (not research-only, not hardware, not non-technical). 产品全栈工程师 / Product Fullstack Engineer builds product software and belongs to fullstack, not product management.') }),
    company_type: choice('What type of employer is `company`, judging by the name and anything `jd` says about the company?', COMPANY_TYPES),
    degree_floor: choice('What is the minimum education level `jd` REQUIRES? A level that is only preferred (优先) does not count.', DEGREES),
    degree_mandatory: noul('`jd` states a hard minimum education level as a requirement (e.g. 本科及以上学历), not merely preferred.'),
    still_open: noul('The posting reads as a currently open position (not 已招满, 招聘结束, closed, filled, expired).'),
    is_roundup: noul('This is a roundup or repost listing several unrelated openings or copied from another source, rather than one specific opening by the hiring side.'),
    city: choice('In which city is the job located? Use `location_field` first, then `jd`. Pick the job\'s city, not the author\'s or headquarters\' city.', {
      ...Object.fromEntries(cities.map((c) => [c, `The job is in ${c}`])),
      remote: 'Remote / work from home / 远程 (no office city required)',
      multiple: 'Several cities are offered and the candidate may choose',
      not_stated: 'No city is stated',
    }),
    remote_scope: choice('If the job is remote, whom can it employ?', wording.remote_scope),
  };
  // Social feeds carry news, commentary and job-seekers' posts beside real
  // openings, and a short post gives the other questions little to refuse
  // ("招聘平台以后也会是 agent 和 agent 先聊" reads as an AI-application topic).
  // Asked only of people's posts: careers pages, watched job pages and links the
  // user forwarded are openings by construction, and keep their cached readings.
  if (isHuman(lead)) q.is_job_post = noul('The text offers at least one specific job opening that a reader can apply for or ask the author about (a hiring or referral post), rather than news, commentary, an advertisement, a course, or a job-seeker describing themselves.');
  if (years.length) {
    q.min_years = choice('Which entry in `year_mentions` states the MINIMUM years of work experience the hire must have? Founding years, project durations, tenure of the team, and years that are only preferred (优先/加分/preferred) do not count.', {
      ...Object.fromEntries(years.map((y) => [y.id, `"${y.span}" in: ${y.context}`])),
      none_stated: 'None of them is a required minimum',
    });
    q.years_mandatory = noul('`jd` sets a MANDATORY minimum number of years of experience (a requirement, not 优先/preferred/nice to have).');
  }
  for (const l of lines) q[`line_${l.id}`] = choice(`What kind of line is \`lines[${l.id.slice(1)}]\` ("${l.text.slice(0, 80)}")?`, LINE_KINDS);
  const r = await judge(request_id || `posting-${lead.id || lead.record_id || 'x'}`, state, q, { meta: { member: 'radar', step: 'judge', lead_id: lead.id || lead.record_id || null, what: judgeWhat(lead) } });
  const a = r.answers;
  const floor = threshold('prefilter_choice');
  const yearPick = years.length ? pick(a.min_years, 0.5) : 'none_stated';
  const yearHit = years.find((y) => y.id === yearPick) || null;
  const posting = {
    version: JUDGEMENT_VERSION, at: r.at, model: r.model, cached: !!r.cached,
    grade: pick(a.grade, 0.5), grade_confident: (a.grade?.confidence ?? 0) >= floor, grade_p: a.grade?.probabilities || {},
    job_family: pick(a.job_family, 0.5), family_confident: (a.job_family?.confidence ?? 0) >= floor, job_family_p: a.job_family?.probabilities || {},
    is_software: general ? null : yes(a.is_software_engineering, 0.5), is_software_p: general ? null : a.is_software_engineering?.noul ?? null,
    company_type: pick(a.company_type, 0.5),
    degree: { level: pick(a.degree_floor, 0.5), mandatory: yes(a.degree_mandatory, 0.6) },
    min_years: yearHit && yes(a.years_mandatory, 0.6) && mandatoryExperienceMention({ ...lead, jd_text: jd }, yearHit.source_index, yearHit.span.length) ? { years: yearHit.years, span: yearHit.span, context: yearHit.context, mandatory: true } : yearHit ? { years: yearHit.years, span: yearHit.span, context: yearHit.context, mandatory: false } : null,
    still_open: yes(a.still_open, 0.4), is_roundup: yes(a.is_roundup, 0.7),
    // Only a confident "no" retires: a spread answer leaves the post to matching.
    ...(a.is_job_post ? { is_job_post: !(a.is_job_post.noul <= 0.25), is_job_post_p: a.is_job_post.noul ?? null } : {}),
    city: pick(a.city, 0.5), city_p: a.city?.probabilities || {},
    remote_scope: pick(a.remote_scope, 0.5),
    lines: lines.map((l) => ({ ...l, kind: pick(a[`line_${l.id}`], 0.45) || 'other' })),
    ...(general ? { question_set: 'general' } : {}),
  };
  return softwarePosting(posting, lead);
}

// The policy layer over a read posting: the same reason codes lib/matcher.mjs
// `prefilter` has always produced, so Base views, tests and metrics keep their
// vocabulary. Returns null when nothing retires the lead.
// 产品说明的是服务的产品，全栈工程师仍按实际写软件的职责归类。保留原模型答案供复核。
export function softwarePosting(posting, lead = {}) {
  const title = String(lead.role || ''), jd = String(lead.jd_text || '');
  const fullstack = /全栈|full[ -]?stack/i.test(title) && /工程师|开发|engineer|developer/i.test(title)
    && !/经理|总监|manager|director|硬件|固件|firmware/i.test(title) && /软件|前端|后端|代码|接口|API|web|software/i.test(jd);
  if (!posting || posting.question_set === 'general' || !fullstack) return posting;
  return { ...posting, job_family: 'fullstack', is_software: true, ...(posting.job_family !== 'fullstack' || posting.is_software === false ? { family_correction: { job_family: posting.job_family, is_software: posting.is_software, reason: 'fullstack_software_duties' } } : {}) };
}

export function postingPrefilterReason(posting, lead = {}) {
  if (!posting) return null;
  posting = softwarePosting(posting, lead);
  // A named person's post that lists several openings is still that person
  // hiring; only an anonymous or official-page roundup is retired. An anonymous
  // 脉脉 gossip is filed as 内推帖 but has no author to ask, so a repost there
  // ("某公司又开了 150 个 HC") is a roundup like any other.
  const human = isHuman(lead) && lead.anonymous !== true;
  if (posting.is_job_post === false) return 'not_a_job_post';
  if (posting.is_roundup && !human) return 'human_not_direct_hiring';
  if (posting.still_open === false) return 'posting_closed';
  // Grades and families follow the candidate (lib/screening.mjs); the default profile keeps every rule as it was.
  const S = screening();
  if (S.general) return generalPostingReason(posting, S);
  if (S.excludedGrades.includes(posting.grade)) return 'seniority_out_of_range';
  if (posting.min_years?.mandatory && posting.min_years.years >= S.jdYearsCap) return 'seniority_out_of_range';
  if (posting.job_family === 'qa_ba_pm' && !S.allow.has('qa') && !S.allow.has('product')) return 'excluded_role';
  if (posting.job_family === 'non_engineering' && !S.allow.has('non_engineering')) return 'excluded_role';
  if (posting.job_family === 'hardware_industrial' && !S.allow.has('hardware')) return 'non_software_role';
  if ((posting.job_family === 'algorithm_or_training' && !S.allow.has('research')) || (posting.job_family === 'mobile' && !S.allow.has('mobile')) || (posting.job_family === 'frontend_only' && !S.allow.has('frontend'))) return 'outside_target_specialty';
  if (posting.is_software === false && posting.job_family !== 'ai_application' && !S.allow.has('product') && !S.allow.has('non_engineering')) return 'non_target_role';
  if (posting.remote_scope === 'other_region_only') return 'remote_region_conflict';
  if (posting.degree?.mandatory && posting.degree.level === 'associate') return null; // a floor below 本科 is a quality rule, decided by lib/quality.mjs
  return null;
}

// 通用路径的规则：级别按你的年限（实习岗只有在读或你说要实习时才推）；岗位类别在方向以内或相邻的留下，别的方向排除
// （拿提成的销售算你不做的岗位）；远程只对别的地区开放的排除。用软件那套问题读过的 JD（换方向之前读的）按对应的大类看。
const LEGACY_TO_GENERAL = { ai_application: 'software_engineering', backend_platform: 'software_engineering', fullstack: 'software_engineering', algorithm_or_training: 'software_engineering', devops_sre: 'software_engineering', mobile: 'software_engineering', frontend_only: 'software_engineering', data: 'data_analytics', qa_ba_pm: 'other', hardware_industrial: 'hardware_industrial', non_engineering: 'other', other: 'other' };
function generalPostingReason(posting, S) {
  const grade = posting.question_set === 'general' ? posting.grade : { junior: 'entry', mid: 'mid', senior_or_above: 'senior_or_above', management: 'management' }[posting.grade];
  if (grade === 'intern' && !S.internships) return 'excluded_role';
  if (S.excludedGrades.includes(grade)) return 'seniority_out_of_range';
  if (posting.min_years?.mandatory && posting.min_years.years >= S.jdYearsCap) return 'seniority_out_of_range';
  const family = posting.question_set === 'general' ? posting.job_family : LEGACY_TO_GENERAL[posting.job_family] || null;
  // 拆掉的旧类别（「人力 / 行政 / 法务」）：拆出来的几个里有一个在方向以内或相邻，就留给匹配看，不在这里排除。
  const kept = (f) => S.families.includes(f) || S.adjacent.includes(f) || (GENERAL_FAMILIES[f]?.split_into || []).some((x) => S.families.includes(x) || S.adjacent.includes(x));
  // 拿提成的销售（以前在「销售 / 商务」里，2026-10-02 分成 commission_sales）算你不做的岗位，选了销售方向也一样。
  if (family && family !== 'other' && GENERAL_FAMILIES[family] && !kept(family)) return family === 'sales_bd' || family === 'commission_sales' ? 'excluded_role' : 'outside_target_specialty';
  if (posting.remote_scope === 'other_region_only') return 'remote_region_conflict';
  return null;
}

// ---------------------------------------------------------------------------
// B. Judge the match: each hard requirement against the candidate's evidence.

export const STATUS = {
  met: 'The candidate evidence clearly satisfies this requirement',
  transferable: 'Not literally satisfied, but closely related evidence makes it reasonable (adjacent language, framework or domain)',
  unknown: 'The evidence says nothing that decides it either way',
  conflict: 'The evidence shows the candidate does NOT satisfy it (years too short, wrong degree, wrong location, exclusive technology the candidate lacks)',
};
// The mandatory years a requirement line states, when that is all it can be
// failing on: above what the resume proves and at most TENURE_GAP_MAX. A line
// asking for less than the candidate has ("2年以上 Java") fails on its subject,
// not its tenure, and stays a conflict.
function tenureOnlyYears(text, S = screening()) {
  const years = yearCandidates(text, { general: !!S.general }).map((y) => y.years);
  if (!years.length) return null;
  const most = Math.max(...years);
  return most > S.years && most <= S.tenureGapMax ? most : null;
}
// 一条要求写明的年数（最多的那个；「2024 年毕业」这种年份不算）。
const lineYears = (text, general) => Math.max(0, ...mandatoryExperienceClauses(text).flatMap(c => yearCandidates(c, { general: true }).map(y => y.years)));
const sourceMinimum = (posting, lead) => {
  const scoped = { ...lead, jd_text: roleRequirementText(lead) };
  return posting?.min_years?.mandatory && yearCandidates(scoped.jd_text, { general: false }).some(y => y.years === Number(posting.min_years.years) && (!posting.min_years.context || y.context === posting.min_years.context) && mandatoryExperienceMention(scoped, y.source_index, y.span.length));
};
const tenureGapText = (years, S = screening()) => `年限缺口：JD 要求 ${years} 年以上经验，候选人约 ${S.years} 年${S.general ? tenureNote(S) : '（含实习）'}`;
// 通用路径的括注：实习按方向折算（金融、咨询不算，市场、运营、产品、数据算一半）。
const tenureNote = (S) => { const w = DIRECTIONS[S.directions?.[0]]?.internship_weight; return w === 1 ? '（含实习）' : w === 0 ? '全职经验（实习不算全职年限）' : '经验（实习按一半算）'; };
// The cities Jev is told the candidate can work in: the target cities, the
// relocation cities (lib/city.mjs rules applied to these facts), then any other
// city named in the free-text relocation_ok — 杭州/上海/苏州/南京/合肥/成都 for
// the owner, as written here before.
export function eligibleCities(facts) {
  const { ranked, relocation } = cityConfigFrom(facts);
  const named = [...ranked, ...relocation];
  const free = String(facts?.location?.relocation_ok ?? '');
  const extra = Object.keys(CITY_EN).map((c) => [c, free.indexOf(c)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]).map(([c]) => c);
  return [...new Set([...named, ...extra])];
}
// 通用路径：方向那一问写成你的方向（金融写到细分），合适程度的四档按应届 / 早期职业的证据来说。
// 年龄、性别、婚育（「35 岁以下」「女性优先」「已婚已育」）：通用路径不拿来判断。
export const PERSONAL_TERMS = /\d{2}\s*周?岁|年龄|性别|男性|女性|限男|限女|男女不限|已婚|未婚|已育|婚育|生育|\bage(?:d)?\s+(?:under|below|between|\d)|\bgender\b|\bmarried\b/i;
export const OTHER_FAMILY_DIRECTION_NO = 0.3;
const GENERAL_FIT = [
  'Not a fit: outside the candidate\'s direction, hard conflicts, or clearly beyond the candidate\'s level',
  'Weak fit: right direction but several requirements unknown or a notable gap (experience, certification, degree, visa)',
  'Good fit: right direction, most requirements met or transferable through coursework, internships, activities or earlier jobs; gaps are minor',
  'Strong fit: the candidate\'s education, internships, experience and skills in this direction line up directly with the requirements',
];
function generalDirectionQuestion(facts) {
  const S = screeningFrom(facts), en = (f) => GENERAL_FAMILIES[f].en.toLowerCase();
  // 相邻的类别不写进「而不是」：它们留给你定，不该被问成「肯定不是」。
  const others = Object.keys(GENERAL_FAMILIES).filter((f) => f !== 'other' && !GENERAL_FAMILIES[f].legacy && !S.families.includes(f) && !S.adjacent.includes(f)).map(en).join(', ');
  // 主方向选了的细分都带说明（法律、会计等 2026-10-02 起的细分）：用细分的说明，加上「也看」的方向的类别。
  // 法律选了合规时，纯风控岗（信用、市场风险）这样就不会被当成方向以内。
  const whats = trackWhats(facts);
  if (whats) {
    const also = [...new Set(S.directions.slice(1).flatMap((k) => DIRECTIONS[k].families))].map(en);
    return `The core work of this role is ${[...whats, ...also].join('; or ')} — the candidate's target direction — rather than ${others}.`;
  }
  return `The core work of this role is ${S.families.map(en).join(', ')} — the candidate's target direction — rather than ${others}.`;
}
// 工程师选了子方向：方向那一问写成你选的子方向，其余工程方向、硬件、非技术岗是「而不是」；合适程度的最高一档说你这些子方向的证据。
const ENGINEERING_OTHERS = 'hardware, non-technical work, and the engineering areas the candidate did not choose';
function engineeringDirectionQuestion(eng) {
  const T = DIRECTIONS.software.tracks;
  return `The core work of this role is ${eng.map((t) => T[t].what).join('; or ')} (the candidate's target), rather than ${ENGINEERING_OTHERS}.`;
}
const engineeringFit = (eng) => [
  'Not a fit: wrong family, hard conflicts, or the role is clearly beyond the candidate',
  'Weak fit: right family but several requirements unknown or a notable gap (years, seniority)',
  'Good fit: right family, most requirements met or transferable, gaps are minor',
  `Strong fit: the candidate's ${eng.map((t) => DIRECTIONS.software.tracks[t].en).join(' / ')} evidence lines up directly with the requirements`,
];
export async function judgeMatch(lead, posting, { facts = loadFacts(), request_id, gaps = null } = {}) {
  const general = isGeneral(facts), wording = judgeWording(facts), eng = engineeringTracks(facts);
  const evidence = candidateEvidence(facts);
  // 通用路径：年龄、性别、婚育这类要求不参与判断（不问、不算缺口），JD 原文照常能看到。软件方向和以前一样。
  const hard = (posting?.lines || []).filter((l) => l.kind === 'hard_requirement' && !(general && PERSONAL_TERMS.test(l.text || ''))).slice(0, 25);
  // Always at least one requirement to judge: hard requirements, else duties,
  // else the title itself, so every match carries a cited must-have.
  const reqs = hard.length ? hard : (posting?.lines || []).filter((l) => l.kind === 'duty').slice(0, 8);
  if (!reqs.length && lead.role) reqs.push({ id: 'l_title', quote: String(lead.role), text: String(lead.role), kind: 'hard_requirement' });
  const state = {
    posting: { title: lead.role || '', company: lead.company || '', location: lead.location || '', family: posting?.job_family || null, grade: posting?.grade || null, min_years: posting?.min_years || null, degree: posting?.degree || null, city: posting?.city || null, remote_scope: posting?.remote_scope || null },
    requirements: reqs.map(({ id, text }) => ({ id, text })),
    candidate: { ...candidateSummary(facts), evidence: evidence.map(({ id, text }) => ({ id, text })) },
  };
  const q = {
    location_eligible: noul(chinaOnly(facts) ? 'Given `posting.city`, `posting.remote_scope` and `candidate.location`, the candidate can work where this job is (target city, an acceptable relocation, or China-eligible remote).' : 'Given `posting.city`, `posting.remote_scope` and `candidate.location`, the candidate can work where this job is (target city, an acceptable relocation, or remote the candidate is eligible for).', { true: `Job is in ${eligibleCities(facts).join('/') || 'a city the candidate targets'}, or ${wording.location_remote}, or the candidate is willing to relocate there`, false: 'Job requires presence in a city or region the candidate has not accepted' }),
    work_auth_eligible: noul(wording.work_auth, wording.work_auth_criteria),
    remote_china: choice(wording.remote, wording.remote_criteria),
    direction_match: noul(general ? generalDirectionQuestion(facts) : eng.length ? engineeringDirectionQuestion(eng) : 'The core work of this role is building AI applications, agents, backends, platforms or full-stack products (the candidate\'s target), rather than training/researching models, hardware, QA, or non-technical work.'),
    fit: score('Overall, how well does `candidate` fit `posting` and `requirements`?', general ? GENERAL_FIT : eng.length ? engineeringFit(eng) : [
      'Not a fit: wrong family, hard conflicts, or the role is clearly beyond the candidate',
      'Weak fit: right family but several requirements unknown or a notable gap (years, seniority)',
      'Good fit: right family, most requirements met or transferable, gaps are minor',
      'Strong fit: the candidate\'s AI-application, agent or backend evidence lines up directly with the requirements',
    ]),
  };
  for (const r of reqs) {
    q[`status_${r.id}`] = choice(`Does the candidate satisfy \`requirements[${r.id.slice(1)}]\` ("${r.text.slice(0, 100)}"), judging only by \`candidate\`?`, STATUS);
    q[`evidence_${r.id}`] = choice(`Which item in \`candidate.evidence\` actually supports satisfying \`requirements[${r.id.slice(1)}]\`? Choose none for unrelated evidence. Total work years do not prove years of NLP, AI, management or another specific field; a backend language migration does not prove Vue or visual UI delivery.`, { ...Object.fromEntries(evidence.map((e) => [e.id, e.text.slice(0, 120)])), none: 'No evidence item supports it' });
  }
  const r = await judge(request_id || `match-${lead.id || lead.record_id || 'x'}`, state, q, { meta: { member: 'radar', step: 'judge', lead_id: lead.id || lead.record_id || null, what: judgeWhat(lead) } });
  const a = r.answers;
  const sFloor = threshold('match_status');
  const must_haves = reqs.map((req) => {
    const status = pick(a[`status_${req.id}`], sFloor) || 'unknown';
    // The model said met/transferable: cite its best evidence even when the
    // pick was spread over two similar items. Otherwise cite only a confident one.
    const evAnswer = a[`evidence_${req.id}`];
    const ev = pick(evAnswer, 0.5);
    const evidenceText = ev && ev !== 'none' ? evidence.find((e) => e.id === ev)?.text || null : null;
    return supportedEvidence({
      req: req.text, status, critical: req.kind === 'hard_requirement' && !softSkill(req.text), jd_quote: req.quote,
      resume_ref: evidenceText || 'unknown',
      status_p: a[`status_${req.id}`]?.probabilities || {},
    });
  });
  // 签证担保（只在不只能在中国工作的人身上看；代码直接读 JD 的说法）：写明将来也不担保而你以后需要 → 冲突；
  // 只写了「无需担保」而你现在能工作、以后需要 → 缺口，你来定。
  const stated = workAuthStated(facts), visa = stated ? sponsorshipVerdict(lead.jd_text || lead.jd || '', facts) : null;
  const eligibility = {
    location: yes(a.location_eligible, 0.6) ? 'met' : prob(a.location_eligible, 'true') <= 0 && a.location_eligible?.noul <= 0.25 ? 'conflict' : 'unknown',
    work_auth: visa?.level === 'conflict' ? 'conflict' : yes(a.work_auth_eligible, 0.6) ? 'met' : a.work_auth_eligible?.noul <= 0.25 ? 'conflict' : 'unknown',
    remote_china: posting?.city && !['remote', 'not_stated', 'multiple'].includes(posting.city) && posting?.remote_scope !== 'china_or_global' ? 'not_applicable' : pick(a.remote_china, 0.5) || 'unknown',
  };
  // 工作许可一项都没填（开箱第 5 轮，B 方案；文字模型那条路 lib/matcher.mjs unstatedWorkAuth 同一条）：不假定身份。资格结论写「没填，不假定」
  // （not_stated，不拦推荐）；JD 硬性要求里明确要工作资格或身份的那一条待核，这时整个岗位待核。福利里的「提供户口」不算。
  if (!stated) {
    eligibility.work_auth = NOT_STATED;
    for (const m of must_haves) if (m.critical && WORK_AUTH_REQ.test(m.req) && asksWorkAuth(m.jd_quote || m.req)) Object.assign(m, { status: 'unknown', resume_ref: UNSTATED_REF, work_auth_unstated: true });
  }
  const authAsked = must_haves.some((m) => m.work_auth_unstated);
  const fit = level(a.fit);
  const direction = yes(a.direction_match, 0.6);
  // Only a confident "wrong direction" excludes; a spread answer is a verify.
  // 通用路径里，读出来是相邻类别的岗位（选了投行，这是量化岗）不因为方向排除，最多到「待核」。
  const adjacentPosting = general && screeningFrom(facts).adjacent.includes(posting?.job_family);
  // 通用路径（负责人 2026-10-02：完全不在方向里的岗位直接排除）：读 JD 时类别落成「其他」、认不出的，方向那一问
  // 答「不是」的把握到 70%（noul ≤ OTHER_FAMILY_DIRECTION_NO）就排除，原因记 outside_target_specialty；
  // 读出了类别的照旧要 75%（≤ 0.25）。答得模棱两可的照旧是待核。
  const otherFamily = general && !(GENERAL_FAMILIES[posting?.job_family] && posting.job_family !== 'other' && !GENERAL_FAMILIES[posting.job_family].legacy);
  const directionConflict = (a.direction_match?.noul ?? 0.5) <= (otherFamily ? OTHER_FAMILY_DIRECTION_NO : 0.25) && !adjacentPosting;
  // A named person's post is cheap to answer and converts best, so a single
  // requirement conflict there is the user's call, not an exclusion.
  const human = isHuman(lead);
  const S = screeningFrom(facts);
  // 校招届别（负责人 2026-10-02，只在通用路径、只对在读和应届）：标题或 JD 写了届别、和你的届别对不上，直接排除；看不出届别的照常判断。
  const cohort = general ? cohortMismatch(`${lead.role || ''}\n${lead.jd_text || lead.jd || ''}`, facts, { years: S.years }) : null;
  let tenureGap = sourceMinimum(posting, lead) && posting.min_years.years > S.years ? tenureGapText(posting.min_years.years, S) : null;
  let tenureNeed = sourceMinimum(posting, lead) ? Number(posting.min_years.years) || 0 : 0;
  // 工程师选了子方向：标题或 JD 写了大厂职级、而这一级通常要的年限比你多，写成年限缺口（仅供参考的对标，见 lib/directions.mjs LEVELS）。
  if (eng.length && !tenureGap) { const need = levelYears(`${lead.role || ''}\n${lead.jd_text || ''}`, lead.company); if (need != null && need > S.years) tenureGap = `职级缺口：岗位写的职级一般要 ${need} 年左右经验（大厂职级对标，仅供参考），候选人约 ${S.years} 年`; }
  // 通用路径：标题写了金融、会计、律所的职级（四大 Senior、投行 Associate、资深律师……），这一级通常要的年限比你多，写成年限缺口
  // （只看标题、只在主方向对得上时；粗略归纳，仅供参考，见 lib/directions.mjs TRADE_LEVELS）。
  if (general && !tenureGap) { const need = tradeLevelYears(lead.role || '', facts); if (need != null && need > S.years) tenureGap = `职级缺口：岗位写的职级一般要 ${need} 年左右经验（行业职级粗略对应，仅供参考），候选人约 ${S.years} 年`; }
  // A confident conflict on a hard requirement, an eligibility conflict or a
  // role outside the target direction excludes. Unknowns are gaps the brief
  // names, not a reason to withhold a recommendation: a JD that asks for
  // Redis the resume never mentions is the normal case, and the letter only
  // ever cites evidence that exists.
  // 年限那一句点了技术、你资料技能里也有的（「3 年以上 Golang 开发经验」，开箱第 4 轮 F07；文字模型那条路 lib/matcher.mjs
  // softwareTenure 同一条，lib/screening.mjs techTenure）：总年限和这门技术的年限分开看，不照 Jev 拿全部年限顶上的说法。
  // 这一句也说明总年限至少这么多，和 JD 的最低年限一起比（tenureNeed）。
  for (const m of must_haves) {
    const source = tenureQuoteText(m.jd_quote || m.req, lead), years = Math.min(lineYears(m.req, general), lineYears(source, general));
    if (!years && yearCandidates(m.jd_quote || m.req).length) Object.assign(m, { critical: false, tenure_preference: true });
    // 年限那一句点了领域（「2 年以上游戏服务端开发经验」，开箱第 5 轮）：只算写到这个领域的经历，取技术、领域两边差的那个。
    const opts = { years: S.years, hasYears: (c) => lineYears(c, general) > 0 };
    const techOnly = years ? techTenure(m.req, years, facts, opts) : null;
    // 点了你资料里没有的技术（「2 年以上 Java 游戏客户端」而你不会 Java）：缺的是技术，照 Jev 的说法，领域不另算（和文字模型那条路一样）。
    const tech = years && (techOnly || !techsIn(m.req).some((t) => !hasSkill(facts, t))) ? keepDomainConflict(worseTenure(techOnly, domainTenure(m.req, years, facts, opts)), m.status) : null;
    if (!tech) {
      // 总工作年限按同一容差重算，不能保留模型对「3年左右」的硬冲突。
      // 技术、领域要求不走总年限；证书和执业年限仍由其专门规则判断。
      if (years && /经验|经历|工作|experience/i.test(m.req) && !techsIn(m.req).some(t => !hasSkill(facts, t))) {
        const fit = tenureFit(years, S.years);
        tenureNeed = Math.max(tenureNeed, years);
        Object.assign(m, { status: !fit ? 'met' : fit.kind === 'close' ? 'transferable' : fit.kind === 'far' ? 'conflict' : 'unknown', resume_ref: `资料里约 ${S.years} 年${S.general ? tenureNote(S) : '（含实习）'}`, ...(fit ? { tenure_gap: fit.gap } : {}) });
      }
      continue;
    }
    if (tenureFit(years, S.years)) tenureNeed = Math.max(tenureNeed, years);
    const cite = tech.status === 'met' && ['met', 'transferable'].includes(m.status) && m.resume_ref !== 'unknown' && (!tech.domains || tech.domains.some((d) => domainRe(d)?.test(m.resume_ref)));
    Object.assign(m, { status: tech.status, resume_ref: cite ? m.resume_ref : tech.ref, ...(tech.tenure_gap ? { tenure_gap: tech.tenure_gap } : {}), ...(tech.techs ? { tech_years: { techs: tech.techs, need: tech.need, have: tech.have } } : { domain_years: { domains: tech.domains, need: tech.need, have: tech.have } }) });
  }
  const hardConflicts = must_haves.filter((m) => m.critical && m.status === 'conflict' && (m.status_p.conflict ?? 0) >= 0.6);
  // A mid-level posting that asks for 3–5 years is the tenure gap again, stated
  // line by line ("3年以上后端开发经验" marked conflict at 2.5 years). The user
  // decides on those (verify with the gap named) when the role is in the right
  // direction; a senior title never reaches here, 8+ years is retired before
  // matching, and any non-tenure conflict still excludes.
  const tenureLines = hardConflicts.map((m) => tenureOnlyYears(m.req, S));
  const tenureOnly = hardConflicts.length > 0 && tenureLines.every((y) => y != null) && (direction || (fit ?? 0) >= 1);
  if (tenureOnly) tenureGap = tenureGap || tenureGapText(Math.max(...tenureLines), S);
  if (tenureOnly) tenureNeed = Math.max(tenureNeed, ...tenureLines);
  // 证书、机构背景、执业年限（只看你的方向用得上的；软件方向三样都是空的）：JD 要求而你没满足的，写成缺口，结论最多到待核。
  const gates = general ? hardGateGaps(lead.jd_text || lead.jd || '', facts) : null;
  // 判断规则 2（软件方向第 3 轮负责人 10-02，通用路径 10-03 起；lib/screening.mjs tenureFit；文字模型那条路 lib/matcher.mjs 同一条）：JD 写明的年限
  // 差 1 年以内照常推荐、注明差一点；差 1–2 年待核（和以前一样）；差 2 年及以上排除（真人帖照旧不因一条要求排除，最多待核）。
  // 职级推算出来的年限（「职级缺口」，仅供参考）不按这条；法律方向 JD 写了执业年限的按执业证日期算（gates.practice），也不按这条。
  const tenureNow = !gates?.practice && !/^职级缺口/.test(tenureGap || '') ? tenureFit(tenureNeed, S.years) : null;
  if (tenureNow) tenureGap = tenureGapText(tenureNow.need, S).replace(/^年限缺口/, TENURE_WORD[tenureNow.kind]);
  const tenureClose = tenureNow?.kind === 'close';
  const certRows = gates?.certs || [];
  // 法律方向 JD 写了执业年限：按执业证日期算（gates.practice），不再按工作年限另写一条。
  if (gates?.practice && tenureGap && !/^职级缺口/.test(tenureGap)) tenureGap = null;
  const blockingConflicts = tenureOnly ? [] : hardConflicts;
  const conflict = (blockingConflicts.length > 0 && !human) || (tenureNow?.kind === 'far' && !human) || eligibility.location === 'conflict' || eligibility.work_auth === 'conflict' || eligibility.remote_china === 'conflict' || directionConflict || !!cohort;
  const eligibilityOpen = eligibility.location === 'unknown' || eligibility.work_auth === 'unknown' || eligibility.remote_china === 'unknown';
  // A post that states no duty and no requirement can be in range but cannot
  // be matched line by line: never a recommendation, and the gap says what to
  // ask the poster (or the official page) for.
  const jdGap = gaps?.blocking ? `JD 待补：${human ? '帖子未写明' : '页面未读到'}${gaps.missing.filter((m) => m !== '工作城市').join('与') || '职责与任职要求'}，${human ? '需向发帖人索取完整 JD' : '需打开原链接核对完整 JD'}` : null;
  // A headhunter's post whose client is not named: the company rules (the
  // user's exclusions, company quality) cannot be checked yet, so it is the
  // user's call after asking the headhunter, never a recommendation.
  const clientGap = gaps?.headhunter ? '猎头代招，客户公司待核' : null;
  const certGap = gates?.text || null;
  const visaGap = visa?.level === 'gap' ? `签证：${visa.note}` : visa?.level === 'conflict' ? `签证：${visa.note}` : null;
  // 差 1 年以内（tenureClose）：年限这一条不拦推荐，只因年限冲突的那几行也不拦；缺口照样写在 seniority_gap、biggest_gap 上。
  const unknownCritical = must_haves.filter(m => m.critical && m.status === 'unknown' && !m.tenure_gap);
  const verdict = conflict ? 'exclude' : (fit ?? 0) >= threshold('recommend_fit') && !eligibilityOpen && !(tenureGap && !tenureClose) && !jdGap && !clientGap && !certGap && !(visa?.level === 'gap') && direction && !authAsked && unknownCritical.length <= 1 && !(hardConflicts.length && !(tenureOnly && tenureClose)) ? 'recommend' : 'verify';
  const met = must_haves.filter((m) => ['met', 'transferable'].includes(m.status));
  const open = [...must_haves.filter((m) => m.critical && m.status === 'conflict'), ...must_haves.filter((m) => m.critical && m.status === 'unknown')];
  const familyLabel = general && GENERAL_FAMILIES[posting?.job_family] ? generalFamilyLabel(posting.job_family) : { ai_application: 'AI 应用', backend_platform: '后端平台', fullstack: '全栈', data: '数据', devops_sre: '工具链', ...(eng.length ? { frontend_only: '前端', mobile: '客户端', qa_ba_pm: '测试开发', algorithm_or_training: '算法' } : {}) }[posting?.job_family] || posting?.job_family || '未判定';
  const reasons = [
    `方向：${familyLabel}；硬性要求 ${met.length}/${must_haves.length} 条有证据，整体匹配 ${fit == null ? '未评' : fit.toFixed(1)}/3`,
    met[0]?.resume_ref && met[0].resume_ref !== 'unknown' ? `「${met[0].req.slice(0, 30)}」← ${met[0].resume_ref.slice(0, 60)}` : general ? (direction ? '核心工作在你的求职方向以内' : '核心工作不在你的求职方向') : eng.length ? (direction ? `核心工作是${eng.map((t) => DIRECTIONS.software.tracks[t].zh).join(' / ')}，和你选的方向一致` : '核心工作不在你选的工程方向') : direction ? '核心工作是应用/后端类开发，与候选人定位一致' : '核心工作与候选人定位不一致',
  ];
  const firstOpen = open.find((m) => !(tenureOnly && m.status === 'conflict')) || null;
  // 通用路径上因为方向排除的，缺口直接说方向不对（和入库前的 outside_target_specialty 同一个说法）。
  const directionGap = general && directionConflict ? `方向不对：${GENERAL_FAMILIES[posting?.job_family] && !otherFamily ? `这是${generalFamilyLabel(posting.job_family)}岗，` : ''}核心工作不在你的求职方向` : null;
  const primary = cohort?.text || directionGap || jdGap || (visa ? visaGap : null) || tenureGap || certGap || (firstOpen ? `${firstOpen.status === 'conflict' ? '冲突' : '待核'}：${firstOpen.req.slice(0, 60)}` : eligibility.location !== 'met' ? '工作地点待核' : !['met', NOT_STATED].includes(eligibility.work_auth) ? '工作资格待核' : general && !direction ? `方向待核：${GENERAL_FAMILIES[posting?.job_family] && posting.job_family !== 'other' ? `这是${generalFamilyLabel(posting.job_family)}岗，` : ''}不完全在你的主方向里，你来定` : null);
  const biggest_gap = [primary, clientGap, primary !== certGap ? certGap : null].filter(Boolean).join('；') || '暂无明确缺口';
  return {
    version: JUDGEMENT_VERSION, at: r.at, model: r.model, cached: !!r.cached,
    must_haves, eligibility, verdict, reasons, biggest_gap,
    ...(verdict === 'recommend' && unknownCritical.length === 1 ? { confirm: { req: unknownCritical[0].req, jd_quote: unknownCritical[0].jd_quote, text: `这一项简历里看不出来，请你确认：${unknownCritical[0].req}` } } : {}),
    fit, fit_p: a.fit?.probabilities || {}, direction_match: direction,
    score: Math.round(((fit ?? 0) / 3) * 100),
    ...(tenureGap ? { seniority_gap: tenureGap } : {}),
    ...(tenureOnly ? { tenure_conflicts_relaxed: hardConflicts.length } : {}),
    ...(gaps?.missing?.length ? { needs_jd: { missing: gaps.missing, blocking: !!gaps.blocking } } : {}),
    ...(clientGap ? { headhunter: { firm: gaps.headhunter } } : {}),
    ...(certRows.length ? { certifications: certRows.map(({ key, label, required, after_hire, level, state, gap }) => ({ key, label, required, after_hire, level, state, ...(gap ? { gap } : {}) })) } : {}),
    ...(gates?.background?.length ? { background: gates.background.map(({ key, need, met, gap }) => ({ key, need, met, ...(gap ? { gap } : {}) })) } : {}),
    ...(gates?.practice ? { practice_years: { need: gates.practice.need, have: gates.practice.have, ...(gates.practice.gap ? { gap: gates.practice.gap } : {}) } } : {}),
    ...(visa ? { visa } : {}),
    ...(cohort ? { cohort: { want: cohort.want, mine: cohort.mine } } : {}),
    ...(cohort ? { exclude_reason: 'cohort_mismatch' } : directionGap ? { exclude_reason: 'outside_target_specialty' } : {}),
  };
}

// ---------------------------------------------------------------------------
// C. Read a mail from the inbox.

export const MAIL_KINDS = {
  interview: { what: 'Invites the candidate to an interview, a call or a screening, or reschedules/cancels/confirms one', examples: ['邀请您参加面试', 'schedule a 30-min call', 'please pick a time on Calendly', '改期到周四'] },
  reply: { what: 'A person from the hiring side writes back substantively: interest, questions, next steps, asks to talk', not_for: 'Automated receipts' },
  needs_material: { what: 'Asks the candidate to send or fill something: resume, portfolio, form, assessment, test, 补材料, 笔试' },
  rejection: { what: 'Declines the candidate: 很遗憾, not moving forward, 不合适, position filled' },
  receipt: { what: 'An automatic acknowledgement that an application was received, with no human action requested', not_for: 'Any mail that asks for action, proposes a time, or contains a personal reply, even if it quotes an earlier receipt', examples: ['Thank you for applying. We have received your application.', '已收到你的申请'] },
  code: { what: 'A one-time verification code, login link, password reset or security alert' },
  unrelated: { what: 'Newsletter, job alert digest, marketing, or anything not about this candidate\'s application' },
};
export async function classifyMail(mail, { request_id } = {}) {
  const state = { from: String(mail.from || mail.sender || ''), subject: String(mail.subject || ''), body: String(mail.body || mail.summary || '').slice(0, 12000) };
  const q = {
    kind: choice('What is this mail, judging by `subject` and `body` (the newest text first, quoted history last)?', MAIL_KINDS),
    has_code: noul('`body` contains a one-time verification code, magic login link or password reset link.'),
    asks_pick_time: noul('The mail asks the candidate to choose or confirm an interview time (a link to a scheduler, proposed slots, 请选择时间).'),
    mentions_datetime: noul('The mail states a specific interview date and time.'),
    about_application: noul('The mail is about a job application or hiring conversation involving this candidate (not marketing, not an alert digest).'),
  };
  const r = await judge(request_id || `mail-${String(mail.message_id || mail.id || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_')}`, state, q);
  const a = r.answers;
  return {
    version: JUDGEMENT_VERSION, at: r.at, cached: !!r.cached,
    kind: pick(a.kind, threshold('mail_kind')), kind_p: a.kind?.probabilities || {},
    has_code: yes(a.has_code, threshold('mail_code')), asks_pick_time: yes(a.asks_pick_time, 0.6), mentions_datetime: yes(a.mentions_datetime, 0.6), about_application: yes(a.about_application, 0.5),
  };
}
// The category vocabulary bin/inbox.mjs and the Base already use.
export const MAIL_CATEGORY = { interview: '面试邀约', reply: '回复', needs_material: '需补材料', rejection: '拒绝', receipt: '申请确认', code: '验证码', unrelated: '无关' };

// ---------------------------------------------------------------------------
// D. Read a person: can this post's author refer the candidate into `company`?

export async function readPerson(post, { company, facts = loadFacts(), request_id } = {}) {
  const body = String(post.body || post.text || post.jd_text || '');
  const lines = postingLines(body, 40);
  const emails = emailCandidates(body);
  const state = {
    target_company: String(company || post.company || ''),
    author: String(post.author || ''), author_title: String(post.author_title || ''), source: String(post.source || ''),
    body, lines: lines.map(({ id, text }) => ({ id, text })), emails,
    candidate_background: { schools: (facts.education || []).map((e) => e.school), former_employers: (facts.career_highlights?.entries || []).map((e) => e.company), alumni_networks: facts.alumni_networks || [] },
  };
  const schools = schoolNames(facts), employers = formerEmployers(facts);
  const q = {
    offers_referral: noul('The author offers to refer (内推) candidates into `target_company`, or invites candidates to contact them about an opening there.'),
    works_at_company: noul('The author currently works at `target_company` (or its parent/subsidiary), judging by `author_title`, `body` and `source`.'),
    is_recruiter_or_hiring_manager: noul('The author is a recruiter, HR, or the hiring manager for the opening described.'),
    is_headhunter: noul('The author is a third-party headhunter or agency recruiter (猎头, 猎聘顾问, executive search) placing candidates at `target_company`, not an employee of it.'),
    is_hr: noul('The author is in-house HR / talent acquisition / HRBP at `target_company` (人事, 招聘专员, HR).'),
    is_individual: noul('The author is an individual person, not a company account, careers page or recruiting bot.'),
    is_seeking: noul('The author is looking for a job themselves (求职, 求内推) rather than offering one.'),
    still_open: noul('The opening or referral offer reads as still open (not 已招满, closed, expired).'),
    shared_background: choice('Does the author share a background with the candidate (`candidate_background`)?', {
      // 学校叫法与前雇主来自 facts.yaml（outreach.school_names、career_highlights），以前写死在这里。
      same_school: schools ? `Same university (${schools})` : 'Same university',
      same_former_employer: employers.length ? `Worked at one of the candidate's former employers (${employers.join(', ')})` : 'Worked at one of the candidate\'s former employers',
      none: 'No shared background is visible',
    }),
    contact_line: choice('Which line in `lines` tells how to contact the author or apply (email, WeChat, 私信, 加好友, a form link)?', { ...Object.fromEntries(lines.map((l) => [l.id, l.text.slice(0, 100)])), none: 'No contact instruction is given' }),
    ...(emails.length ? { best_email: choice('Which address in `emails` should an applicant write to?', { ...Object.fromEntries(emails.map((e) => [e, e])), none: 'None of them is for applicants' }) } : {}),
  };
  const r = await judge(request_id || `person-${String(post.id || post.source_job_id || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_')}`, state, q, { textOk: true, meta: { member: 'quill', step: 'referrers' } });
  const a = r.answers;
  const f = threshold('referral');
  const contact = pick(a.contact_line, 0.5);
  return {
    version: JUDGEMENT_VERSION, at: r.at, cached: !!r.cached,
    offers_referral: yes(a.offers_referral, f), offers_referral_p: a.offers_referral?.noul ?? null,
    works_at_company: yes(a.works_at_company, f), is_recruiter_or_hiring_manager: yes(a.is_recruiter_or_hiring_manager, f),
    is_headhunter: yes(a.is_headhunter, f), is_hr: yes(a.is_hr, f),
    is_individual: yes(a.is_individual, 0.6), is_seeking: yes(a.is_seeking, 0.6), still_open: yes(a.still_open, 0.4),
    shared_background: pick(a.shared_background, 0.6) || 'none',
    contact_line: contact && contact !== 'none' ? lines.find((l) => l.id === contact)?.text || null : null,
    email: emails.includes(pick(a.best_email, threshold('contact_email'))) ? pick(a.best_email, threshold('contact_email')) : null,
  };
}

// Which of several addresses on a company page is for applications.
export async function chooseApplicationEmail({ company, texts = [], request_id }) {
  const emails = emailCandidates(...texts);
  if (!emails.length) return { email: null, candidates: [] };
  const state = { company: String(company || ''), emails, context: texts.filter(Boolean).map((t) => String(t).slice(0, 6000)) };
  const r = await judge(request_id || `contact-${String(company).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)}`, state, {
    application_email: choice('Which address in `emails` is meant for job applicants to send resumes to (招聘邮箱, careers@, hr@, join@, jobs@, talent@)? Generic support, press, sales, legal or privacy addresses do not count.', { ...Object.fromEntries(emails.map((e) => [e, e])), none: 'None of them is for applicants' }),
  }, { textOk: true, meta: { member: 'quill', step: 'contacts' } });
  const e = pick(r.answers.application_email, threshold('contact_email'));
  return { email: e && e !== 'none' && emails.includes(e) ? e : null, candidates: emails, confidence: r.answers.application_email?.confidence ?? null };
}

// ---------------------------------------------------------------------------
// E. Intent: what a free-form room message asks for.

export const VERBS = {
  send: 'Approve sending a drafted email or platform message (发, 发吧, 可以发, 发出去)',
  cancel_send: 'Do not send / withdraw a draft (别发, 不发, 先不发, 取消)',
  revise: 'Change the wording of a draft (改成, 把第二段删掉, 语气更谦虚)',
  pass: 'Reject or exclude a job (pass, 不合适, 排除, 不要这个, 太偏研究)',
  contact: 'Pursue a job: contact, prepare materials, express interest (联系, 要这个, 想投, 争取)',
  queue_apply: 'Approve submitting applications for listed jobs (投, 投递, 帮我投, 全部投)',
  schedule_interview: 'Record an interview time or reschedule (面试, 改期, 约在周四下午三点)',
  snooze: 'Postpone or pause reminders (晚点提醒, 暂停, 明天再说)',
  brief: 'Ask what a job is / show details (详情, 是啥, 招聘贴, 讲讲这个岗位)',
  progress: 'Ask for status or todo list (进展, 待办, 状态, 到哪一步了)',
  // 例子里的城市是第一个目标城市（lib/city.mjs）；routeIntent 每次按当时的配置出题。
  get adjust_preference() { return `Change what kinds of jobs to prioritise or avoid (${primaryCity() ? `多推${primaryCity()}的, ` : ''}外企多一点, 少推创业公司, ${isGeneral(currentFacts()) ? '不要销售岗' : '不要算法岗'})`; },
  other: 'Anything else: a question, a request that needs reasoning or research, small talk',
};
// 通用路径：「方向」这一维的选项是你方向以内和相邻的岗位类别（投行、资管、咨询……），软件方向还是以前那几个。
const generalPrefFamilies = () => { const S = screening(); return [...S.families, ...S.adjacent]; };
export const PREF_DIMENSIONS = { get city() { return `City or location (${targetCities().join(', ')})`; }, company_type: 'Type of employer (外企, 大厂, 国企, 创业公司, 外包)', get job_family() { return isGeneral(currentFacts()) ? `Kind of work (${generalPrefFamilies().map((f) => GENERAL_FAMILIES[f].zh).join(', ')})` : 'Kind of work (AI 应用, 后端, 全栈, 算法, 数据)'; }, seniority: 'Grade (初级, 资深, 管理岗)', source_type: 'Where jobs come from (真人帖, 内推, 官网)', salary: 'Pay level', none: 'No preference dimension is named' };
export const PREF_DIRECTIONS = { more: 'Show more of this / prioritise it', less: 'Show less of this / deprioritise', only: 'Only this', exclude: 'Never this', reset: 'Undo an earlier preference', none: 'No direction stated' };
export const PREF_VALUES = {
  // The city values are the buckets lib/preference-signals.mjs files a lead under (lib/city.mjs leadCity).
  get city() { return Object.fromEntries(cityBuckets().map((c) => [c, c === REMOTE ? '远程 / remote' : c === OTHER ? '其他城市' : cityEn(c) ? `${c} / ${cityEn(c)}` : c])); },
  company_type: { foreign_mnc: '外企 / global companies', chinese_big_tech: '大厂 / big Chinese tech', state_owned: '国企', startup: '创业公司 / startups', outsourcing: '外包' },
  get job_family() { return isGeneral(currentFacts()) ? Object.fromEntries(generalPrefFamilies().map((f) => [f, `${GENERAL_FAMILIES[f].zh} / ${GENERAL_FAMILIES[f].en}`])) : { ai_application: 'AI 应用 / agent', backend_platform: '后端 / 平台', fullstack: '全栈', algorithm_or_training: '算法 / 模型训练', data: '数据', devops_sre: '运维 / 工具链', frontend_only: '纯前端' }; },
  seniority: { junior: '初级', mid: '中级 / 未标注', senior_or_above: '资深 / 高级', management: '管理岗' },
  source_type: { 真人直发: '真人帖 / 内推 / HR 直发', 公司官方页: '公司官网 / ATS' },
  salary: { 薪资高档: '高薪', 薪资中档: '中等', 薪资低档: '低薪' },
};
export async function routeIntent(text, { card = null, numbers = [], request_id } = {}) {
  const state = { text: String(text || ''), card: card ? { number: card.number ?? null, kind: card.kind || null } : null, numbers_in_text: numbers };
  const q = {
    verb: choice('What does the user want, judging by `text` (and `card` when the message is a reply under a card)?', VERBS),
    refers_to_card: noul('`text` is about the job or draft shown on `card` (a bare reply like 发吧 or 不要 under a card refers to it).'),
    states_reason: noul('`text` gives a reason for the decision (公司不明, 太偏研究, 地点不行).'),
    pref_dimension: choice('If the user is adjusting preferences, which dimension?', PREF_DIMENSIONS),
    pref_direction: choice('If the user is adjusting preferences, in which direction?', PREF_DIRECTIONS),
    ...Object.fromEntries(Object.entries(PREF_VALUES).map(([dim, vals]) => [`pref_value_${dim}`, choice(`If the preference is about ${dim}, which value does the user name?`, { ...vals, none: 'Not this dimension / no value named' })])),
  };
  const r = await judge(request_id || `intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state, q, { cache: false });
  const a = r.answers;
  const verb = pick(a.verb, threshold('intent_verb'));
  const dim = pick(a.pref_dimension, 0.6);
  const value = dim && dim !== 'none' ? pick(a[`pref_value_${dim}`], 0.6) : null;
  return {
    version: JUDGEMENT_VERSION, at: r.at,
    verb, verb_p: a.verb?.probabilities || {}, confidence: a.verb?.confidence ?? 0,
    refers_to_card: yes(a.refers_to_card, 0.6), states_reason: yes(a.states_reason, 0.6),
    preference: verb === 'adjust_preference' && dim && dim !== 'none' ? { dimension: dim, direction: pick(a.pref_direction, 0.5) || 'more', value: value && value !== 'none' ? value : null } : null,
  };
}
