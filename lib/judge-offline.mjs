// 离线判断：不联网、不调用任何模型，按岗位原文和你的资料用规则回答判断层（Jev）的那些问题（2026-09-29）。
//
// 用在两处：演示 / 沙盒模式（lib/sandbox.mjs 挡住了一切外发，Jev 和文字模型都用不了，但端到端要能看到「判断」这一步），
// 以及还没配任何模型、想先粗筛一轮的人。打开方式：环境变量 RADAR_JUDGE=offline，或 config/judge.json 写 "driver": "offline"。
// 沙盒里 bin/judge-leads.mjs 只有 RADAR_JUDGE=offline 时才跑。
//
// 它回答的问题和 Jev 一模一样（lib/judgements.mjs 出题，规则层照常用答案），所以流程、界面、缺口的说法都是真的；
// 只是「读懂」这一步换成了关键词和数字比较，远不如模型：认不出的就答「不确定」（置信度压在门槛以下），规则层会当成待核，
// 而不是编一个答案。它的结论带 model: offline-rules，线索上记 judged_by: offline，界面上能看出来。
import { FAMILIES, DIRECTIONS, DIRECTION_DOMAIN, titleFamilies, targetFamilies, adjacentFamilies, INTERN_WORDS, isGeneral, tradeGrade, nonEngineeringTitle, tracksOf, primaryDirection, directionsOf, trackFamilyList } from './directions.mjs';
import { workRegions, US_LOCATION, remoteOutsideRegions } from './work-auth.mjs';
import { CERTS, ADDED_CERTS, candidateCertifications } from './certifications.mjs';
import { CITY_EN } from './city.mjs';
import { currentFacts } from './facts.mjs';
import { tenureFit, experienceYears } from './screening.mjs';
import { seekerPost } from './post-signals.mjs';

export const OFFLINE_MODEL = 'offline-rules';
const str = (v) => (v == null ? '' : String(v));
const choice = (value, confidence = 0.85) => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: confidence } });
const unsure = (keys) => choice(keys.find((k) => /^(other|unknown|none|not_stated|unclear|none_stated|unrelated)$/.test(k)) || keys[0], 0.3);
const noul = (p) => ({ type: 'noul', noul: p });

// ── 读 JD ────────────────────────────────────────────────────────────────────
const MANAGEMENT = /\b(director|head of|managing director|executive director|partner|chief|vp of)\b|总监|首席|合伙人|负责人|董事总经理/i;
const SENIOR = /\b(senior|sr\.?|lead(?!\s*gen)|principal|vice president|vp|avp|architect)\b|资深|高级|专家|主管|架构师/i;
const ENTRY = /analyst program|graduate|new grad|campus|early careers?|entry[- ]level|junior|rotational|trainee|assistant|coordinator|应届|校招|校园招聘|管培|初级|助理|20\d\d\s*届/i;
// 通用路径先查主方向的行业职级表（lib/directions.mjs TRADE_GRADES：四大的 Audit Senior 是有经验、律所的律师是有经验、
// 合伙人是管理……），都不命中再走下面的通用词。「实习律师」是还没拿到执业证的律师，算应届，不算实习。
function grade(title, keys, facts = {}) {
  const general = keys.includes('entry');
  if (general && /实习律师/.test(title)) return 'entry';
  if (INTERN_WORDS.test(title)) return general ? 'intern' : 'junior';
  const trade = general ? tradeGrade(title, facts) : null;
  if (trade && keys.includes(trade)) return trade;
  if (MANAGEMENT.test(title)) return 'management';
  if (SENIOR.test(title) || (!general && /\bstaff\b/i.test(title))) return 'senior_or_above';
  if (general && /\bmanager\b|经理/i.test(title.replace(/产品经理|项目经理|客户经理|理财经理|(?:总经理|总裁|经理)助理|product manager|project manager|relationship manager|account manager/gi, ''))) return 'senior_or_above';
  if (ENTRY.test(title)) return general ? 'entry' : 'junior';
  return 'mid';
}
// 软件方向的老类别（lib/judgements.mjs FAMILIES）：从标题粗分。
function legacyFamily(title) {
  if (/agent|llm|大模型|智能体|ai\s*应用|applied ai|ai engineer/i.test(title)) return 'ai_application';
  if (/算法|research|训练|machine learning/i.test(title)) return 'algorithm_or_training';
  if (/全栈|full.?stack/i.test(title)) return 'fullstack';
  if (/front.?end|前端/i.test(title)) return 'frontend_only';
  if (/ios|android|mobile|客户端/i.test(title)) return 'mobile';
  if (/devops|\bsre\b|运维/i.test(title)) return 'devops_sre';
  if (/data engineer|数仓|数据开发|etl/i.test(title)) return 'data';
  if (/back.?end|后端|server|platform|平台|infra/i.test(title)) return 'backend_platform';
  if (/\bqa\b|test|测试|product manag|产品经理|business analyst/i.test(title)) return 'qa_ba_pm';
  if (/hardware|硬件|embedded|嵌入式|mechanical|机械/i.test(title)) return 'hardware_industrial';
  if (/software|developer|engineer|开发|工程师/i.test(title)) return 'backend_platform';
  // 只用 2026-10-02 之前的类别词（新类别不算），软件方向的答案一个字不变。
  return nonEngineeringTitle(title) ? 'non_engineering' : 'other';
}
function family(state, keys) {
  if (!keys.includes('investment_banking')) return { value: legacyFamily(state.title), confidence: 0.8 };
  // 只看标题：JD 正文里「风险」「市场」这类词到处都是，按正文分类错得多。标题同时像软件开发（Quant Developer）的，算软件。
  const fams = titleFamilies(state.title).filter((f) => keys.includes(f));
  if (fams.includes('software_engineering') && /developer|engineer|程序员|开发/i.test(state.title)) return { value: 'software_engineering', confidence: 0.75 };
  // 标题同时像几个类别（「资本市场律师」= 投行 + 律所执业）：先取你方向以内的，再取相邻的。
  const pick = (isGeneral(state.facts || {}) && fams.find((f) => targetFamilies(state.facts).includes(f))) || (isGeneral(state.facts || {}) && fams.find((f) => adjacentFamilies(state.facts).includes(f))) || fams[0];
  if (pick) return { value: pick, confidence: 0.85 };
  const body = isGeneral(state.facts || {}) ? bodyOutsideFamily(state.jd, state.facts) : null;
  return body ? { value: body, confidence: 0.6 } : { value: 'other', confidence: 0.5 };
}
// 标题认不出类别的岗位（「业务发展专员」「咖啡师」），通用路径上再看一眼正文（2026-10-02，负责人：完全不在方向里的岗位直接排除）。
// 只往「排除」这一边用，两种情况才把岗位读成正文里最多的那个方向以外的类别、入库前按 outside_target_specialty 排除：
// 这个类别至少占 BODY_FAMILY_MIN 行、而且至少是碰上你方向（类别词或行业用语，lib/directions.mjs DIRECTION_DOMAIN）那几行的两倍；
// 或者正文至少 BODY_FAMILY_MIN 行、一行都没碰上你的方向。
// 「……优先 / 为佳」的行不算；「金融市场」「资本市场」这类说的是行情，不是市场营销。
export const BODY_FAMILY_MIN = 3;
const PREFERRED_LINE = /优先|为佳|加分|preferred|a plus|nice to have|desirable|bonus/i;
const MARKET_WORDS = /(?:金融|资本|证券|债券|股票|一级|二级|货币|外汇|期货|大宗商品|商品|法律)市场/g;
const bodyLines = (text) => str(text).split(/[\n。；;]|\s(?=\d+[、.．])/).map((s) => s.trim()).filter((s) => s.length >= 4 && !PREFERRED_LINE.test(s));
const keptFamilies = (facts) => new Set([...targetFamilies(facts), ...adjacentFamilies(facts)]);
const domainOf = (facts) => directionsOf(facts).map((k) => DIRECTION_DOMAIN[k]).filter(Boolean);
const insideLine = (line, facts, kept = keptFamilies(facts)) => titleFamilies(line).some((f) => kept.has(f)) || domainOf(facts).some((re) => re.test(line));
function bodyOutsideFamily(jd, facts) {
  const lines = bodyLines(jd), kept = keptFamilies(facts), counts = {};
  let inside = 0;
  for (const line of lines) {
    if (insideLine(line, facts, kept)) inside++;
    for (const f of titleFamilies(line.replace(MARKET_WORDS, ''))) if (!kept.has(f) && !FAMILIES[f].legacy) counts[f] = (counts[f] || 0) + 1;
  }
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  if (!top) return null;
  return (n >= BODY_FAMILY_MIN && n >= 2 * inside) || (inside === 0 && lines.length >= BODY_FAMILY_MIN) ? top : null;
}
const DEGREE_RANK = [['not_limited', /学历不限|不限学历|no degree required/i], ['associate', /associate degree|大专|专科/i], ['bachelor', /bachelor|undergraduate|\bB\.?A\b|\bB\.?S\b|\bBSc\b|本科|学士|university degree|degree in/i], ['master', /master|\bMBA\b|硕士|研究生/i], ['phd', /ph\.?d|doctorate|博士/i]];
const PREFERRED = /优先|加分|preferred|a plus|nice to have|desirable|bonus/i;
function degreeFloor(jd) {
  const lines = str(jd).split(/[\n。；;]|(?<=[.!?])\s+/);
  let found = null, mandatory = false;
  for (const line of lines) for (const [level, re] of DEGREE_RANK) if (re.test(line)) {
    const rank = DEGREE_RANK.findIndex(([l]) => l === level);
    if (found == null || rank < DEGREE_RANK.findIndex(([l]) => l === found)) found = level;
    if (!PREFERRED.test(line)) mandatory = true;
    break;
  }
  return { level: found || 'not_stated', mandatory };
}
// 一行里常常先写硬要求、再用逗号接一句「……优先」（「2026届硕士及以上学历，金融相关专业优先」）：按逗号拆开看，
// 只要有一段是硬要求、且那一段本身没说优先，这一行就是硬要求。
const HARD = /要求|具备|熟悉|精通|掌握|须|必须|学历|专业|经验|证书|资格|GPA|degree|required|must|minimum|at least|experience (?:in|with)|years|proficien|fluent|authorized|strong .{0,20}skills|knowledge of|expected (?:graduation|between)|currently pursuing|届/i;
const clausesOf = (t) => str(t).split(/[，,;；]/).map((c) => c.trim()).filter(Boolean);
function lineKind(text) {
  const t = str(text).trim();
  if (t.length <= 14 && /[:：]$|^(?:requirements?|qualifications?|responsibilities|duties|岗位职责|任职要求|职位描述|工作职责)[:：]?$/i.test(t)) return 'heading';
  if (PREFERRED.test(t) && clausesOf(t).some((c) => HARD.test(c) && !PREFERRED.test(c) && /学历|届|degree|required|must|须|必须|years|年以上/i.test(c))) return 'hard_requirement';
  if (PREFERRED.test(t)) return 'preferred';
  if (/benefit|salary range|compensation|equal opportunity|we are an|about us|公司简介|福利|五险一金|我们是/i.test(t)) return 'boilerplate';
  if (HARD.test(t)) return 'hard_requirement';
  if (/负责|参与|协助|支持|撰写|完成|跟踪|you will|build|support|own |manage|work on|analy[sz]e|prepare|research|assess|monitor|rotate|coordinate|perform|define|lead /i.test(t)) return 'duty';
  return 'other';
}
function readPostingAnswer(key, q, state, facts) {
  const keys = Object.keys(q.criteria || {});
  if (key === 'grade') return choice(grade(str(state.title), keys, facts));
  if (key === 'job_family') { const f = family({ ...state, facts }, keys); return choice(f.value, f.confidence); }
  if (key === 'is_software_engineering') return noul(/software|developer|engineer|开发|工程师|程序员/i.test(state.title) && !/sales|销售|financial engineer/i.test(state.title) ? 0.9 : 0.1);
  if (key === 'company_type') return choice('unknown', 0.8);
  if (key === 'degree_floor') return choice(degreeFloor(state.jd).level, 0.8);
  if (key === 'degree_mandatory') return noul(degreeFloor(state.jd).mandatory ? 0.8 : 0.2);
  if (key === 'still_open') return noul(/已招满|招聘结束|position (?:has been )?filled|no longer accepting|posting (?:is )?closed/i.test(state.jd) ? 0.05 : 0.95);
  if (key === 'is_roundup') return noul(0.05);
  // 求职者自己的帖子（open to work、#OpenToWork、求职、求内推……，lib/post-signals.mjs）不是岗位。
  if (key === 'is_job_post') return noul(seekerPost({ title: str(state.title), body: str(state.jd) }) ? 0.05 : 0.9);
  if (key === 'city') {
    const where = str(state.location_field);
    const hits = keys.filter((k) => !['remote', 'multiple', 'not_stated'].includes(k) && (where.includes(k) || (CITY_EN[k] && new RegExp(`\\b${CITY_EN[k]}\\b`, 'i').test(where))));
    if (hits.length > 1) return choice('multiple', 0.8);
    if (hits.length === 1) return choice(hits[0], 0.9);
    if (/remote|远程/i.test(where)) return choice('remote', 0.85);
    return choice('not_stated', 0.6);
  }
  if (key === 'remote_scope') {
    const where = str(state.location_field);
    if (!/remote|远程|work from home|在家办公/i.test(where)) return choice('not_remote', 0.85);
    if (remoteOutsideRegions(where, workRegions(facts))) return choice('other_region_only', 0.85);
    if (/worldwide|global|anywhere/i.test(where) || (workRegions(facts).includes('us') && US_LOCATION.test(where)) || (workRegions(facts).includes('cn') && /china|中国/i.test(where))) return choice('china_or_global', 0.85);
    return choice('unclear', 0.8);
  }
  if (key === 'min_years') {
    const mentions = (state.year_mentions || []).filter((m) => /experience|经验|工作|years? (?:of|in)/i.test(m.context) && !PREFERRED.test(m.context));
    if (!mentions.length) return choice('none_stated', 0.8);
    const number = (m) => Number(String(m.span).match(/\d+/)?.[0] ?? 0);
    return choice(mentions.sort((a, b) => number(b) - number(a))[0].id, 0.8);
  }
  if (key === 'years_mandatory') {
    const req = (state.year_mentions || []).some((m) => /experience|经验|工作/i.test(m.context) && !PREFERRED.test(m.context));
    return noul(req ? 0.8 : 0.3);
  }
  if (key.startsWith('line_')) {
    const line = (state.lines || [])[Number(key.slice(6))];
    return choice(lineKind(line?.text), 0.8);
  }
  return null;
}

// ── 对照你的资料 ─────────────────────────────────────────────────────────────
const SKILLS = ['excel', 'powerpoint', 'word', 'python', 'sql', 'tableau', 'power bi', 'bloomberg', 'capital iq', 'factset', 'wind', 'financial model', 'valuation', 'dcf', 'vba', 'r ', 'stata', 'matlab', 'c++', 'canva', 'figma', 'photoshop', 'google analytics', 'seo', '小红书', '抖音', '公众号'];
const words = (s) => {
  const t = str(s).toLowerCase();
  const latin = (t.match(/[a-z][a-z+&.-]{3,}/g) || []).filter((w) => !/^(with|from|this|that|have|will|your|their|about|using|such|also|able|must|should|including|experience|required|preferred|strong|skills|knowledge|ability|years?)$/.test(w));
  const cjk = [...t.replace(/[^一-鿿]/g, '')];
  const bigrams = cjk.slice(0, -1).map((c, i) => c + cjk[i + 1]);
  return new Set([...latin, ...bigrams]);
};
const overlap = (a, b) => { const B = words(b); let n = 0; for (const w of words(a)) if (B.has(w)) n++; return n; };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// 「December 2026 … June 2027」「2026年12月至2027年6月」→ [起, 止]（月序号）；只有一个日期时是那一个月到那一年底 / 从那年初。
function monthWindow(text) {
  const t = str(text), found = [];
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/gi)) found.push(Number(m[2]) * 12 + MONTHS[m[1].toLowerCase()] - 1);
  for (const m of t.matchAll(/(20\d\d)\s*年\s*(\d{1,2})\s*月/g)) found.push(Number(m[1]) * 12 + Number(m[2]) - 1);
  if (found.length >= 2) return [Math.min(...found), Math.max(...found)];
  return null;
}
// 你最后一段教育的结束月份（证据里「（2022-09 至 2026-05）」的后一个日期）。
function graduationOf(edu) {
  const last = edu.at(-1)?.text || '', m = [...last.matchAll(/(20\d\d)[-./年](\d{1,2})(?!\d)/g)].filter((x) => Number(x[2]) >= 1 && Number(x[2]) <= 12).at(-1);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}
const gpaOf = (s) => Number(str(s).match(/GPA[^\d]{0,12}(\d\.\d{1,2})/i)?.[1] || NaN);
function statusFor(req, candidate, facts) {
  // 学历、年限这类判断只看提到它的那一段：「硕士及以上学历，相关专业优先」里的「优先」说的是专业，不是学历。
  const whole = str(req), degreeClause = clausesOf(whole).find((c) => /ph\.?d|doctorate|博士|master|硕士|研究生|bachelor|undergraduate|degree|本科|学士|学历/i.test(c));
  const text = degreeClause && !PREFERRED.test(degreeClause) && PREFERRED.test(whole) ? degreeClause : whole, evidence = candidate.evidence || [];
  const find = (re) => evidence.find((e) => re.test(e.text));
  const edu = evidence.filter((e) => /^学历/.test(e.text));
  // 学历
  // 「Master's or PhD」「硕士或博士」：门槛是硕士，不是博士。
  if (/ph\.?d|doctorate|博士/i.test(text) && !/master|硕士|研究生|bachelor|本科/i.test(text) && !PREFERRED.test(text)) return edu.some((e) => /ph\.?d|博士|doctor/i.test(e.text)) ? ['met', edu[0]] : ['conflict', edu[0]];
  if (/master|硕士|研究生/i.test(text) && !/bachelor|本科|学士|or equivalent|or above.*bachelor/i.test(text) && !PREFERRED.test(text)) return edu.some((e) => /master|硕士|\bMS\b|MSc|MBA|M\.S/i.test(e.text)) ? ['met', edu.find((e) => /master|硕士|\bMS\b|MSc|MBA/i.test(e.text))] : ['conflict', edu[0]];
  if (/bachelor|undergraduate|degree|本科|学士|学历/i.test(text) && edu.length) {
    // 毕业时间窗口（「expected between December 2026 and June 2027」）按月比；只写了年份就按年比。
    const window = monthWindow(text), mine = graduationOf(edu);
    if (window && mine && (mine < window[0] || mine > window[1])) return ['conflict', edu.at(-1)];
    const grad = text.match(/(20\d\d)/g)?.map(Number) || [];
    const year = Math.max(0, ...edu.flatMap((e) => (e.text.match(/(20\d\d)/g) || []).map(Number)));
    if (!window && grad.length && year && (year < Math.min(...grad) || year > Math.max(...grad))) return ['conflict', edu.at(-1)];
    return ['met', edu.at(-1)];
  }
  // 毕业年份（「2026届」「expected graduation in 2027」）
  const cohort = text.match(/(20\d\d)\s*届|graduat\w*[^.]{0,40}?(20\d\d)/i);
  if (cohort && edu.length) {
    const want = Number(cohort[1] || cohort[2]), mine = Math.max(0, ...edu.flatMap((e) => (e.text.match(/(20\d\d)/g) || []).map(Number)));
    return [mine === want ? 'met' : 'conflict', edu.at(-1)];
  }
  // GPA
  const need = gpaOf(text) || Number(text.match(/GPA[^\d]{0,20}(\d\.\d)/i)?.[1] || NaN);
  if (/GPA/i.test(text) && Number.isFinite(need)) { const e = evidence.find((x) => Number.isFinite(gpaOf(x.text))); return e ? [gpaOf(e.text) >= need ? 'met' : 'conflict', e] : ['unknown', null]; }
  // 年限
  // 前后连着别的数字的是年份，不是年限（「2027年应届毕业生……1年以上工作经验」）；区间按下限读，连字符各种写法都认。
  const YEARS = /(?<!\d)(\d{1,2})\s*\+?\s*(?:(?:[-‐‑‒–—~～至到]|to\b)\s*\d{1,2}\s*)?(?:years?|年)/gi;
  // 通用路径：只认跟经验连在一起的年数（lib/screening.mjs experienceYears）；软件方向照旧取第一个。
  const years = isGeneral(facts) ? [...text.matchAll(YEARS)].find((m) => experienceYears(text, m.index, m[0].length)) : text.match(/(?<!\d)(\d{1,2})\s*\+?\s*(?:(?:[-‐‑‒–—~～至到]|to\b)\s*\d{1,2}\s*)?(?:years?|年)/i);
  if (years && (isGeneral(facts) || /experience|经验|工作/i.test(text))) {
    const n = Number(years[1]), have = Number(candidate.years_experience) || 0;
    // 通用路径（判断规则 2，2026-10-03）：差 1 年以内的那一行照样答冲突（规则层按 tenureFit 另算，lib/judgements.mjs judgeMatch），
    // 第三项记下差一点，整体匹配（fit）不因为它压低。软件方向的答案照旧。
    return n <= have || (n <= 1 && /internship/i.test(text)) ? ['met', find(/工作年限|现职/) || evidence[0]] : ['conflict', find(/工作年限/) || null, isGeneral(facts) && tenureFit(n, have)?.kind === 'close'];
  }
  // 语言
  if (/mandarin|chinese|普通话|中文/i.test(text)) { const e = find(/语言|中文|mandarin|chinese/i); return e ? ['met', e] : ['unknown', null]; }
  if (/english|英语|英文/i.test(text)) { const e = find(/english|英语|英文/i); return e ? ['met', e] : ['unknown', null]; }
  // 工作许可、签证：代码按规则判（lib/work-auth.mjs），这里不猜。
  if (/authoriz|sponsor|visa|right to work|签证|工作许可/i.test(text)) return ['unknown', null];
  // 证书：你有同一张证就算有，级别够不够由代码另算缺口（lib/certifications.mjs）。
  // 软件方向只认 2026-10-02 之前就有的证书（答案和以前一样）。
  for (const [k, c] of Object.entries(CERTS).filter(([k]) => isGeneral(facts) || !ADDED_CERTS.has(k))) if (c.jd.test(text)) {
    const mine = candidateCertifications(facts).find((m) => m.key === k || (!isGeneral(facts) && k === 'cpa' && m.key === 'us_cpa'));
    return mine ? [mine.status === 'held' ? 'met' : 'transferable', find(/^证书/)] : ['unknown', null];
  }
  // 工具和技能
  const skill = SKILLS.find((s) => text.toLowerCase().includes(s));
  if (skill) { const e = evidence.find((x) => x.text.toLowerCase().includes(skill)); if (e) return ['met', e]; }
  // 其余：和你的某条经历、技能说得上同一件事
  const best = evidence.map((e) => [overlap(text, e.text), e]).sort((a, b) => b[0] - a[0])[0];
  if (best && best[0] >= 4) return ['met', best[1]];
  if (best && best[0] >= 2) return ['transferable', best[1]];
  return ['unknown', null];
}
function directionScore(title, facts) {
  const fams = titleFamilies(title);
  if (!isGeneral(facts)) return /software|developer|engineer|开发|工程师|agent|llm|后端|全栈/i.test(title) ? 0.85 : 0.2;
  // 「Quantitative Developer」这类：标题落在方向里，但实际是写程序的活；除非你的方向里有软件，只算相邻。
  if (fams.includes('software_engineering') && /developer|engineer|程序员|开发/i.test(title) && !targetFamilies(facts).includes('software_engineering')) return 0.4;
  // 细分带 only 的（法律的「合规」：合规、反洗钱，不含信用 / 市场风险）：标题只是因为这个细分的类别才落在方向里、
  // 却不像细分本身，算相邻。
  const d = DIRECTIONS[primaryDirection(facts)], narrow = tracksOf(facts).map((t) => d.tracks[t]).filter((t) => t.only);
  const narrowOnly = narrow.length && fams.filter((f) => targetFamilies(facts).includes(f)).every((f) => narrow.some((t) => trackFamilyList(t).includes(f)) && !tracksOf(facts).some((k) => !d.tracks[k].only && trackFamilyList(d.tracks[k]).includes(f)));
  if (fams.some((f) => targetFamilies(facts).includes(f)) && narrowOnly && !narrow.some((t) => t.only.test(title))) return 0.55;
  if (fams.some((f) => targetFamilies(facts).includes(f))) return 0.9;
  if (fams.some((f) => adjacentFamilies(facts).includes(f))) return 0.55;
  return fams.length ? 0.1 : 0.5;
}
function jobRegion(location) {
  const s = str(location);
  if (US_LOCATION.test(s)) return 'us';
  if (/中国|china|上海|北京|深圳|杭州|广州|苏州|南京|成都|武汉|西安|天津|重庆|shanghai|beijing|shenzhen|hangzhou|guangzhou/i.test(s)) return 'cn';
  return null;
}
function matchAnswer(key, q, state, facts, cache) {
  const keys = Object.keys(q.criteria || {}), posting = state.posting || {}, candidate = state.candidate || {};
  if (key === 'location_eligible') {
    const cities = (str(q.criteria?.true).match(/Job is in ([^,]+),/)?.[1] || '').split('/').map((c) => c.trim()).filter(Boolean);
    const where = `${str(posting.location)} ${str(posting.city)}`;
    if (cities.some((c) => where.toLowerCase().includes(c.toLowerCase()) || (CITY_EN[c] && where.toLowerCase().includes(CITY_EN[c].toLowerCase())))) return noul(0.9);
    if (posting.remote_scope === 'china_or_global') return noul(0.85);
    // 认不出地点（「2 Locations」、只写了国家）：说不准，不当成去不了。
    const region = jobRegion(where);
    return noul(!region ? 0.45 : workRegions(facts).includes(region) ? 0.5 : 0.2);
  }
  if (key === 'work_auth_eligible') { const r = jobRegion(`${str(posting.location)} ${str(posting.city)}`); return noul(r ? (workRegions(facts).includes(r) ? 0.9 : 0.1) : 0.5); }
  if (key === 'remote_china') {
    if (!posting.remote_scope || posting.remote_scope === 'not_remote') return choice('not_applicable', 0.9);
    return choice(posting.remote_scope === 'china_or_global' ? 'met' : posting.remote_scope === 'other_region_only' ? 'conflict' : 'unknown', 0.8);
  }
  if (key === 'direction_match') return noul(directionScore(str(posting.title), facts));
  const reqs = state.requirements || [];
  const statuses = cache.statuses ||= Object.fromEntries(reqs.map((r) => [r.id, statusFor(r.text, candidate, facts)]));
  if (key === 'fit') {
    const d = directionScore(str(posting.title), facts), all = Object.values(statuses);
    const good = all.filter(([s]) => s === 'met' || s === 'transferable').length, bad = all.some(([s, , close]) => s === 'conflict' && !close);
    const base = d >= 0.85 ? 2 : d >= 0.5 ? 1 : 0;
    return { type: 'score', score: bad ? Math.min(base, 1) : Math.min(3, base + (all.length && good / all.length >= 0.5 ? 1 : 0)) };
  }
  if (key.startsWith('status_')) { const [s] = statuses[key.slice(7)] || ['unknown']; return choice(s, s === 'unknown' ? 0.7 : 0.8); }
  if (key.startsWith('evidence_')) { const [, e] = statuses[key.slice(9)] || []; return e && keys.includes(e.id) ? choice(e.id, 0.8) : choice('none', 0.7); }
  return null;
}

// ── 入口：和 Jev 同样的请求，同样形状的回答 ────────────────────────────────────
// 离线只回答两套问题：读 JD（readPosting）和对照资料（judgeMatch）。邮件、意图、真人帖作者这些它答不了，
// 照实报「不支持」，调用方就当判断不可用（以前会拿「不确定」去分邮件，收据全被当成了回复）。
export const offlineSupports = (body = {}) => { const s = body.state || {}; return (!!s.requirements && !!s.candidate) || ('jd' in s && 'year_mentions' in s); };
export function offlineAnswers(body, { facts = currentFacts() } = {}) {
  if (!offlineSupports(body)) throw Error('offline_unsupported');
  const answers = {}, cache = {}, state = body.state || {};
  const matching = !!state.requirements && !!state.candidate;
  for (const [key, q] of Object.entries(body.questions || {})) {
    const a = matching ? matchAnswer(key, q, state, facts, cache) : 'jd' in state ? readPostingAnswer(key, q, state, facts) : null;
    if (a) { answers[key] = a; continue; }
    // 其它问题（邮件、意图、真人帖作者……）离线不答：给一个低于门槛的「不确定」，规则层照「看不出」处理。
    answers[key] = q.type === 'choice' ? unsure(Object.keys(q.criteria || {})) : q.type === 'noul' ? noul(0.5) : { type: 'score', score: 1 };
  }
  return { answers, model: OFFLINE_MODEL };
}
export const offlineWanted = (conf = {}) => /^offline$/i.test(str(process.env.RADAR_JUDGE).trim()) || conf.driver === 'offline';
export const familyName = (key) => FAMILIES[key]?.zh || key;
