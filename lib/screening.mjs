// 入库前的硬筛按「你是谁」来：年限、级别和方向都从 candidate/facts.yaml 推出来。
//
// 以前这几样是写死的：约 2.5 年经验（lib/matcher.mjs、lib/judgements.mjs 的 CANDIDATE_YEARS），
// 标题带 Senior / Staff / Lead / 经理 / 资深 / 高级 / 专家……一律排除，JD 要求 8 年以上排除，前端、移动端、
// 测试、产品、销售、硬件、算法训练方向排除。换一个人用，大部分岗位在入库前就没了。
//
// 年限按这个顺序取：experience_summary.years（明写的数字）→ 工作经历的起止日期推算（current_work.start
// 和 career_highlights.entries[].dates，重叠的月份只算一次，实习算，教育和个人项目不算，向下取到半年）→ 2.5。
// experience_summary 里的其它键（as_of、source、outreach_wording、calculation、rules……）只给人和模型看，这里不读。
// 级别跟着年限：不到 5 年，资深及以上的标题都排除（缺省就是这一档，规则与以前逐字相同）；5–8 年只排除
// 管理和高管；8 年以上只排除总监 / VP / 首席这类。JD 的硬性年限超过「你的年限 + 5.5」才排除（2.5 年正好是以前的 8 年）。
// 方向：preferences.role_families 里写了「前端」「移动端」「测试」「产品经理」「算法 / 研究」「硬件 / 嵌入式」
// 「销售 / 运营」「量化」「实习」这类词，对应的方向就不再在入库前排除；没写就和以前一样，只收软件研发类。
//
// 2026-09-29 起按求职方向走（lib/directions.mjs）：主方向不是软件的人（金融、咨询、市场、产品、运营、数据分析）
// 拿到一份「通用」的筛选口径——级别词换成这些行业的说法（Analyst / Associate / VP、专员 / 主管 / 经理），实习按方向
// 折算年限（金融、咨询不算，市场、运营、产品、数据算一半），应届生不因为「没有全职年限」被挡在门外。
// 软件方向（没写方向的老用户）拿到的对象和以前逐字相同，一个键都不多（tests/golden-software.test.mjs）。
import { currentFacts } from './facts.mjs';
import { isGeneral, directionsOf, targetFamilies, adjacentFamilies, internshipWeight, candidateStage, internshipsWanted, INTERN_WORDS, engineeringTracks, DIRECTIONS, tradeJobNames } from './directions.mjs';
import { workRegions } from './work-auth.mjs';
import { TECH, hasSkill, yearsClauseTechs, yearsDomains, domainRe } from './tech-words.mjs';

export const DEFAULT_YEARS = 2.5;

const NOW = /至今|今|现在|present|now|current|ongoing/i;
const monthIndex = (y, m) => y * 12 + (m - 1);
const nowIndex = (now) => monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1);
const TOKEN = /(\d{4})(?:\s*[-./年]\s*(\d{1,2})(?!\d))?/g;
const month = (t, fallback) => (t[2] ? Math.min(12, Math.max(1, Number(t[2]))) : fallback);
// 「2020-09 至 2021-08」「2022-07 至今」「2019.07 - 2019.09」「2020 to 2022」→ [起, 止]（月序号，止含当月）。
export function parseSpan(dates, now = new Date()) {
  const text = String(dates ?? ''), tokens = [...text.matchAll(TOKEN)];
  if (!tokens.length) return null;
  const start = monthIndex(Number(tokens[0][1]), month(tokens[0], 1));
  const end = tokens.length >= 2 ? monthIndex(Number(tokens[1][1]), month(tokens[1], 12)) : NOW.test(text) ? nowIndex(now) : null;
  return end != null && end >= start ? [start, end] : null;
}
// current_work.start：「2022-07」「2022」。
function parseStart(value) {
  const t = [...String(value ?? '').matchAll(TOKEN)][0];
  return t ? monthIndex(Number(t[1]), month(t, 1)) : null;
}

// 一组区间合并后覆盖多少个月（重叠的月份只算一次）。
function coveredMonths(spans) {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let months = 0, [s, e] = sorted[0];
  for (const [a, b] of sorted.slice(1)) { if (a <= e + 1) e = Math.max(e, b); else { months += e - s + 1; [s, e] = [a, b]; } }
  return months + e - s + 1;
}
// 工作经历推算的年限；一条可用的日期都没有时是 null。
// 实习按方向折算（lib/directions.mjs internship_weight）：全职覆盖的月份算满，只有实习覆盖的月份乘以权重。
// 软件方向权重是 1，结果就是以前「所有经历合并」的月份数，逐字不变。
export function derivedYears(facts = {}, now = new Date()) {
  return workYears(facts, now, () => true);
}
// 有起止日期的工作经历里，keep(那一段) 为真的那几段合并后的年数（实习按方向折算，向下取到半年）；一段都没有：null。
function workYears(facts, now, keep) {
  const spans = [], full = [];
  const current = facts?.current_work;
  const add = (span, title) => { spans.push(span); if (!INTERN_WORDS.test(String(title ?? ''))) full.push(span); };
  if (current?.start && keep(current)) { const s = parseStart(current.start); if (s != null && s <= nowIndex(now)) add([s, nowIndex(now)], current.title); }
  for (const e of facts?.career_highlights?.entries || []) { if (!keep(e)) continue; const span = parseSpan(e?.dates, now); if (span) add(span, e?.role ?? e?.title); }
  if (!spans.length) return null;
  const all = coveredMonths(spans), weight = internshipWeight(facts);
  const months = weight === 1 ? all : coveredMonths(full) + weight * (all - coveredMonths(full));
  return Math.floor(months / 6) / 2;
}

// 某门技术用了几年（开箱第 4 轮 F07）：工作经历里写到这门技术的那几段（current_work、career_highlights.entries，有起止日期的）
// 合并后的年数。一段都没写到：null——技能表里列了 Go，不等于这几年都在写 Go。几门技术「之一」取最多的，都要取最少的。
const textOf = (x) => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(textOf).join(' ') : x && typeof x === 'object' ? Object.values(x).map(textOf).join(' ') : '');
// 公司名不是技术或领域经历；只从职位和做过的事推相关年限。
const workText = e => { const { company, employer, dates, start, end, url, id, ...work } = e || {}; return textOf(work); };
const NOT_GO = /\bgo[\s-]+(?:live|to[\s-]+market|ahead|through)\b|\bon the go\b/gi;
export function techYears(facts = {}, techs = [], { anyOf = true, now = new Date() } = {}) {
  const res = techs.map((t) => TECH.find(([name]) => name === t)?.[1]).filter(Boolean);
  const each = res.map((re) => workYears(facts, now, (e) => re.test(workText(e).replace(NOT_GO, ' '))));
  if (!each.length || each.every((y) => y == null)) return null;
  const known = each.map((y) => y ?? 0);
  return anyOf ? Math.max(...known) : Math.min(...known);
}

// 一条写了年限、又点了技术的要求（「3 年以上 Golang 开发经验」，开箱第 4 轮 F07）：总年限和这门技术的年限分开看，两条路
// （文字模型 lib/matcher.mjs softwareTenure、Jev lib/judgements.mjs judgeMatch）同一条。
//   总年限先比（判断规则 2）：差 2 年及以上「不符合」，差 1–2 年「待核」（这门技术的年限只会更少）。
//   总年限够、或只差 1 年以内：工作经历里写到这门技术的年数够了「符合」；不够、或只在技能表里列了：「待核」，
//   而且不算年限缺口——它是「这一项简历里看不出来，请你确认」（判断规则 1），不拿全部年限顶上。
// 不是这种要求（年限那一句没点技术），或点的技术你资料里没有（缺的是技术，照判断的说法）：null。
// hasYears(一句) 判断这一句里有没有年限要求（两条路各自的读法）。
export function techTenure(text, need, facts = {}, { years, hasYears, now = new Date() } = {}) {
  const clause = yearsClauseTechs(text, hasYears);
  if (!clause.techs.length || !(Number(need) > 0)) return null;
  const held = clause.techs.filter((t) => hasSkill(facts, t));
  if (!held.length || (!clause.anyOf && held.length < clause.techs.length)) return null;
  const name = held.join(' / '), total = tenureFit(need, years);
  if (total && total.kind !== 'close') return { status: total.kind === 'far' ? 'conflict' : 'unknown', techs: held, need: Number(need), have: null, tenure_gap: total.gap, ref: `资料里约 ${years} 年` };
  const have = techYears(facts, held, { anyOf: clause.anyOf, now });
  if (have != null && have >= need) return { status: 'met', techs: held, need: Number(need), have, ref: `工作经历里用 ${name} 约 ${have} 年` };
  return { status: 'unknown', techs: held, need: Number(need), have, ref: have ? `工作经历里写到 ${name} 的约 ${have} 年，其余年份看不出` : `${name} 只在技能里，看不出用了几年` };
}

// 一条写了年限、又点了领域的要求（「2 年以上游戏服务端开发经验」，开箱第 5 轮）：和 techTenure 同一个算法，只是数的是
// 工作经历里写到这个领域的那几段（职位、做的事里出现「游戏」……），资料里的总年限不算。总年限先比（判断规则 2）；
// 写到这个领域的年数够了「符合」，不够或看不出：「待核」（这一项简历里看不出来，请你确认），不算年限缺口。
// 只看年限那句话本身修饰的领域（lib/tech-words.mjs yearsDomains），年数也用那一句自己的；没点表里的领域：null（照旧按总年限）。
export function domainTenure(text, _need, facts = {}, { years, now = new Date() } = {}) {
  const hits = yearsDomains(text);
  if (!hits.length) return null;
  const need = Math.max(...hits.map((h) => h.need)), domains = [...new Set(hits.filter((h) => h.need === need).flatMap((h) => h.domains))];
  if (!(need > 0)) return null;
  const any = /或|\bor\b|[\/／]/i.test(String(text)), name = domains.map((d) => `「${d}」`).join(any ? '或' : '与'), total = tenureFit(need, years);
  if (total && total.kind !== 'close') return { status: total.kind === 'far' ? 'conflict' : 'unknown', domains, need: Number(need), have: null, tenure_gap: total.gap, ref: `资料里约 ${years} 年` };
  const res = domains.map(domainRe).filter(Boolean), have = workYears(facts, now, (e) => any ? res.some(re => re.test(workText(e))) : res.every(re => re.test(workText(e))));
  if (have != null && have >= need) return { status: 'met', domains, need: Number(need), have, ref: `工作经历里做${name}相关的约 ${have} 年` };
  return { status: 'unknown', domains, need: Number(need), have, ref: have ? `工作经历里做${name}相关的约 ${have} 年，不到 ${need} 年` : `工作经历里看不出做${name}相关的年数` };
}
// 技术年限和领域年限都有的那一条（「3 年以上游戏服务端 C++ 经验」）：取差的那个。
const TENURE_RANK = { conflict: 3, unknown: 2, transferable: 1, met: 0 };
export const worseTenure = (a, b) => (!a ? b : !b ? a : TENURE_RANK[b.status] > TENURE_RANK[a.status] ? b : a);
// 年限状态按可验证的经历计算。未知不能被模型的一句「不符合」变成确定冲突。
export const keepDomainConflict = t => t;

export function candidateYears(facts = {}, now = new Date()) {
  const explicit = facts?.experience_summary?.years;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '' && Number.isFinite(Number(explicit)) && Number(explicit) >= 0) return Number(explicit);
  // 通用路径（主方向不是软件）什么经历日期都没有：按 0 年算，不套作者本人的 2.5 年（软件方向照旧）。
  return derivedYears(facts, now) ?? (isGeneral(facts) ? 0 : DEFAULT_YEARS);
}

// 标题里的级别词。不到 5 年排除的这一串就是以前 lib/matcher.mjs 写死的那一串。
const SENIOR_ALL = String.raw`\b(senior|sr\.?|staff|principal|lead|leader|architect|director|vp|manager|head(?: of)?)\b|资深|高级|专家|架构师|总监|负责人|经理|首席`;
const SENIOR_MANAGEMENT = String.raw`\b(director|vp|manager|head(?: of)?)\b|总监|经理|首席`;
const SENIOR_EXECUTIVE = String.raw`\b(director|vp|head of)\b|总监|首席`;
export const levelOf = (years) => (years < 5 ? 'early' : years < 8 ? 'senior' : 'staff');

// preferences.role_families 里的写法 → 不再在入库前排除的方向。词要具体：「AI 应用」「后端」「全栈」「分布式」不解锁任何方向。
export const FAMILY_WORDS = {
  frontend: /前端|front-?end/i,
  mobile: /移动端|客户端|\bmobile\b|\bios\b|\bandroid\b|flutter|react\s*native/i,
  qa: /测试|\bqa\b|\bsdet\b|quality assurance|\btest(ing)?\s+engineer/i,
  product: /产品经理|产品运营|product manager|\bpm\b|项目经理|项目管理|project manag|business analyst|业务分析/i,
  research: /算法|研究员|研究方向|\bresearch|模型训练|预训练|训练框架|machine learning engineer|\bml engineer/i,
  hardware: /硬件|嵌入式|embedded|firmware|hardware|芯片|机械|汽车|automotive|机器人|robot|制造|manufactur|电子工程|electronics/i,
  non_engineering: /销售|\bsales\b|招聘|recruit|运营|\boperations\b|市场|marketing|设计师|designer|财务|finance|\bhr\b|人力/i,
  quant: /量化|\bquant|\btrading\b|交易员/i,
  intern: /实习|\bintern/i,
};
// 做产品 / 项目的人，「产品经理」「Project Manager」是岗位名，不是级别：看级别之前先把它们拿掉。
const PM_TITLE = /产品经理|项目经理|product manager|project manager|program manager/gi;
// 通用路径：这些行业里带「经理 / Manager」的岗位名很多不是级别——银行校招的「客户经理」「理财经理」、
// 「Relationship Manager」「总经理助理」——看级别之前一样先拿掉。
const JOB_NAMES = /产品经理|项目经理|客户经理|理财经理|储备经理|大堂经理|(?:总经理|总裁|董事长|经理)助理|product manager|project manager|program manager|relationship manager|account manager|(?:assistant|associate|junior) (?:brand|marketing|product) manager|(?:social media|community) manager/gi;
// 主方向有自己的岗位名表时（lib/directions.mjs TRADE_JOB_NAMES：会计的 Audit Senior、审计项目经理，销售的销售经理、客户经理）
// 也先拿掉；别的通用方向和以前一样。
const tradeNames = (S) => (S.directions ? tradeJobNames({ preferences: { directions: [...S.directions] } }) : null);
export const levelText = (role, S) => (S.general ? String(role ?? '').replace(JOB_NAMES, ' ').replace(tradeNames(S) || /$^/g, ' ') : S.allow.has('product') ? String(role ?? '').replace(PM_TITLE, ' ') : String(role ?? ''));
// 通用路径的级别词。不同于软件：「Staff Accountant」「Staff Auditor」是会计的入门岗，staff 不算资深；
// 银行的 VP / AVP 是资深档；市场的「Lead Generation」不是 lead。5–8 年只挡总监以上（VP、经理正合适），8 年以上只挡高管。
const G_SENIOR_ALL = String.raw`\b(senior|sr\.?|lead(?!\s*gen)|principal|vice president|vp|svp|avp|evp|executive director|managing director|director|head(?: of)?|partner(?!\s*(?:marketing|success|operations|relations|ships?))|chief|manager)\b|资深|高级|专家|主管|总监|负责人|经理|首席|合伙人|副总裁|董事|总经理`;
const G_MANAGEMENT = String.raw`\b(director|executive director|managing director|head of|partner|chief)\b|总监|首席|合伙人|董事总经理|执行董事|总经理`;
const G_EXECUTIVE = String.raw`\b(managing director|head of|partner|chief)\b|首席|合伙人|董事总经理|总经理`;
export function familiesAllowed(facts = {}) {
  const text = [].concat(facts?.preferences?.role_families ?? []).map((x) => String(x ?? '')).join('\n');
  return new Set(Object.entries(FAMILY_WORDS).filter(([, re]) => re.test(text)).map(([k]) => k));
}

export function screeningFrom(facts = {}, now = new Date()) {
  const years = candidateYears(facts, now), level = levelOf(years);
  if (isGeneral(facts)) return generalScreening(facts, years, level, now);
  const title = level === 'early' ? SENIOR_ALL : level === 'senior' ? SENIOR_MANAGEMENT : SENIOR_EXECUTIVE;
  // 工程师选了子方向（lib/directions.mjs engineeringTracks）：子方向解锁对应的方向（选了前端就不再排除前端岗），
  // 另外带上子方向本身，排序、判断问题、职级对标按它走。没选子方向的工程师（作者本人）拿到的对象和以前一模一样。
  const eng = engineeringTracks(facts);
  if (eng.length) {
    const T = DIRECTIONS.software.tracks;
    return Object.freeze({
      years, level, seniorTitle: new RegExp(title, 'i'),
      excludedGrades: Object.freeze(level === 'early' ? ['senior_or_above', 'management'] : level === 'senior' ? ['management'] : []),
      jdYearsCap: years + 5.5, tenureGapMax: years + 2.5,
      allow: new Set([...familiesAllowed(facts), ...eng.map((t) => T[t].allow).filter(Boolean)]),
      engineering: true, tracks: Object.freeze(eng), trackFamilies: Object.freeze(eng.map((t) => T[t].legacy)),
    });
  }
  return Object.freeze({
    years, level,
    seniorTitle: new RegExp(title, 'i'),
    // Jev 读出的级别：不到 5 年资深和管理都排除；5–8 年只排除管理；8 年以上都不排除。
    excludedGrades: Object.freeze(level === 'early' ? ['senior_or_above', 'management'] : level === 'senior' ? ['management'] : []),
    jdYearsCap: years + 5.5,
    // 一条要求只差年限、且不超过「你的年限 + 2.5」时，算年限缺口（待你决定）而不是冲突（2.5 年时正好是以前的 5 年）。
    tenureGapMax: years + 2.5,
    allow: familiesAllowed(facts),
  });
}

// 通用路径（主方向不是软件）。和软件方向同名的键含义相同，多出来的键只有通用路径有（软件方向的对象里没有 general）。
function generalScreening(facts, years, level, now) {
  const stage = candidateStage(facts, years, now), internships = internshipsWanted(facts, stage);
  const title = level === 'early' ? G_SENIOR_ALL : level === 'senior' ? G_MANAGEMENT : G_EXECUTIVE;
  const grades = level === 'early' ? ['senior_or_above', 'management'] : level === 'senior' ? ['management'] : [];
  return Object.freeze({
    years, level,
    seniorTitle: new RegExp(title, 'i'),
    excludedGrades: Object.freeze(internships ? grades : [...grades, 'intern']),
    jdYearsCap: years + 5.5,
    tenureGapMax: years + 2.5,
    allow: familiesAllowed(facts),
    general: true,
    directions: Object.freeze(directionsOf(facts)),
    families: Object.freeze(targetFamilies(facts)),
    adjacent: Object.freeze(adjacentFamilies(facts)),
    stage, internships,
    regions: Object.freeze(workRegions(facts)),
  });
}

// 排序和筛选时一秒调很多次：同一份 facts（lib/facts.mjs 的缓存对象）同一天只算一次。
let memo = { facts: null, day: null, value: null };
export function screening(facts = currentFacts(), now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (memo.facts === facts && memo.day === day && memo.value) return memo.value;
  memo = { facts, day, value: screeningFrom(facts, now) };
  return memo.value;
}

// 年限差多少怎么判（第 3 轮负责人 10-02，判断规则 2）：JD 写明的最低年限比你的多出几年。
//   差 1 年以内（close）：照常推荐，注明差一点；差 1–2 年（between）：待核，和以前一样；差 2 年及以上（far）：不合适，排除。
// 软件方向的两条路同一条（文字模型 validateMatch、Jev lib/judgements.mjs judgeMatch）；职级推算的年限（仅供参考）不按这条。
export const TENURE_CLOSE_YEARS = 1, TENURE_FAR_YEARS = 2;
export function tenureFit(need, have) {
  const gap = Math.round((Number(need) - Number(have)) * 10) / 10;
  if (!(Number(need) > 0) || !(gap > 0)) return null;
  return { need: Number(need), have: Number(have), gap, kind: gap <= TENURE_CLOSE_YEARS ? 'close' : gap >= TENURE_FAR_YEARS ? 'far' : 'between' };
}
export const TENURE_WORD = { close: '年限差一点', between: '年限缺口', far: '年限不够' };

// 通用路径从 JD 原文读年限要求（方向会话 10-03）：只认跟经验连在一起的年数——「N 年以上工作 / 相关经验」「执业 N 年以上」
// 「从业 N 年」「经验要求：N 年」「N+ years of experience」；「公司成立 10 年以上」「N 年以上历史」「深耕行业 N 年」这类不算。
// text 里从 index 起、长 length 的那一段是读到的年数。两条方向路径共用，限定语长也不能漏掉明确的经验要求。
const CLAUSE_END = /[，,。；;\n]/;
const EXPERIENCE_AFTER = /^[^，,。；;\n]{0,100}?(?:经验|经历|工作|从业|执业|PQE)|^[^,;.\n]{0,100}?\b(?:experience|work(?:ing)?|practice|PQE|post[- ]qualification|role|position)\b/i;
const EXPERIENCE_BEFORE = /(?:工作|从业|执业|工龄|经验|经历)(?:年限|要求)?[：:\s]*(?:要求)?\s*(?:在|满|达)?\s*(?:至少|不少于|不低于|最少)?\s*$|\b(?:experience|worked|working)\s+(?:of\s+|for\s+)?(?:at least\s+|over\s+|more than\s+|a minimum of\s+)?$/i;
// JD 也常省略 experience，写成「3+ years in application security」。只认工作领域，
// 不把 years in university / a degree program / business 等持续时间当作工作年限。
const EXPERIENCE_DISCIPLINE = /^\s+in\s+(?:[a-z-]+\s+){0,5}(?:security|engineering|development|programming|testing|management|marketing|sales|operations|accounting|recruiting|consulting|research|design)\b/i;
const NOT_EXPERIENCE = /成立|创立|创办|历史|深耕|founded|established|history|in business/i;
export function experienceYears(text, index, length) {
  const s = String(text ?? ''), before = s.slice(Math.max(0, index - 30), index).split(CLAUSE_END).pop(), after = s.slice(index + length);
  if (NOT_EXPERIENCE.test(before) || NOT_EXPERIENCE.test(after.split(CLAUSE_END)[0].slice(0, 8))) return false;
  const discipline = EXPERIENCE_DISCIPLINE.test(after) && !/\b(?:degree|diploma|school|college|university|training|stud(?:y|ies))\b/i.test(after.split(CLAUSE_END)[0]);
  return EXPERIENCE_AFTER.test(after) || EXPERIENCE_BEFORE.test(before) || discipline || /^\s*(?:of\s+)?(?:building|developing|designing|shipping|implementing|programming|coding|managing|leading)\b/i.test(after);
}
