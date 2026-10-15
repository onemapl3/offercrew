// 证书（2026-09-29，方向通用化的一部分）：JD 要什么证、你有什么证，差在哪。
//
// 金融、会计、咨询、市场的招聘里，证书常常是一条硬要求或加分项：「CFA 二级及以上」「须持有基金从业资格」「CPA 优先」。
// 判断模型会逐条看 JD 的要求，但「要求 vs 你有的」这件事用代码做更稳：证书名是固定的一小串，要求 / 优先 / 入职后
// 取得这几种说法也有限，按规则认出来，写成一句看得懂的缺口（「证书：JD 要求 CFA 二级，你一级已过」）。
//
// 只看你的方向用得上的证书（lib/directions.mjs 每个方向的 certifications）：软件方向这张表是空的，老规则一条不变。
// 你的证书写在 candidate/facts.yaml 的 certifications：
//   - { name: CFA, status: Level I passed, date: 2026-02 }
//   - { name: 证券从业资格, status: 已通过 }
// 也可以直接写一行字（「CFA Level I passed」）。
import { directionCertifications, directionInstitutions, primaryDirection, INSTITUTIONS } from './directions.mjs';

// label：界面上的名字；jd：在 JD 里认这张证的写法；levels：分级的证书，JD 和你各自写到第几级。
// 2026-10-02 起还有三种比法：
//   rank：有高低的证书（会计职称初 < 中 < 高、建造师二级 < 一级、JLPT N2 < N1、英语四级 < 六级 < 专八、法考 C < B < A 证），
//         按顺序写，第一条命中的算；JD 要求某一档，你在这一档或以上就算满足。
//   score：考试成绩（雅思、托福）：两边都读得出分数就比，读不出来只看有没有。
//   subjects：CPA 通过几科（「通过 CPA 2 科及以上」对「已通过 3 科」是满足）。
// us_cpa 排在 cpa 前面：你的资料里写「US CPA」时认成美国 CPA，不当成中国 CPA。
const rank = (...rows) => rows.map(([re, n, label]) => ({ re, n, label }));
export const CERTS = {
  cfa: { label: 'CFA', jd: /\bCFA\b|特许金融分析师/i, levels: true },
  us_cpa: { label: 'US CPA', jd: /\bUS\s*CPA\b|\bU\.S\.\s*CPA\b|\bAICPA\b|美国注册会计师|美国\s*CPA/i },
  cpa: { label: 'CPA / 注册会计师', jd: /\bCPA\b|\bCICPA\b|certified public accountant|注册会计师/i, subjects: true },
  acca: { label: 'ACCA', jd: /\bACCA\b/i },
  frm: { label: 'FRM', jd: /\bFRM\b|金融风险管理师/i, levels: true },
  cma: { label: 'CMA', jd: /\bCMA\b|管理会计师/i },
  caia: { label: 'CAIA', jd: /\bCAIA\b/i, levels: true },
  cfp: { label: 'CFP', jd: /\bCFP\b|国际金融理财师/i },
  finra: { label: 'FINRA 执照（SIE / Series 7 / 63 / 79 …）', jd: /\bSIE\b|\bSeries\s*(?:7|24|57|63|65|66|79|82|86|87|99)\b|FINRA licen/i },
  sac: { label: '证券从业资格', jd: /证券(?:业)?从业(?:人员)?资格|证券从业/ },
  amac: { label: '基金从业资格', jd: /基金从业(?:人员)?资格|基金从业/ },
  futures: { label: '期货从业资格', jd: /期货从业/ },
  banking_cn: { label: '银行从业资格', jd: /银行(?:业)?从业(?:人员)?资格|银行从业/ },
  pmp: { label: 'PMP', jd: /\bPMP\b/i },
  npdp: { label: 'NPDP', jd: /\bNPDP\b/i },
  cspo: { label: 'CSPO', jd: /\bCSPO\b/i },
  google_analytics: { label: 'Google Analytics 认证', jd: /Google Analytics(?:\s*4)?\s*(?:certif|认证|IQ)|\bGAIQ\b/i },
  google_ads: { label: 'Google Ads 认证', jd: /Google Ads\s*(?:certif|认证)/i },
  hubspot: { label: 'HubSpot 认证', jd: /HubSpot\s*(?:certif|认证)/i },
  meta_blueprint: { label: 'Meta Blueprint 认证', jd: /Meta (?:Blueprint|Certified)/i },
  tableau: { label: 'Tableau 认证', jd: /Tableau\s*(?:certif|认证|Desktop Specialist)/i },
  cda: { label: 'CDA 数据分析师', jd: /\bCDA\b/ },
  legal_cn: { label: '法律职业资格', jd: /法律职业资格|司法考试|法考/, rank: rank([/A\s*证|A\s*类/i, 3, 'A 证'], [/B\s*证|B\s*类/i, 2, 'B 证'], [/C\s*证|C\s*类/i, 1, 'C 证']) },
  teacher_cn: { label: '教师资格证', jd: /教师资格/ },
  // ── 2026-10-02：金融、法律、会计、人力、项目、销售、语言 ──
  sponsor_rep: { label: '保荐代表人', jd: /保荐代表人|保代(?:资格)?/ },
  sac_advisor: { label: '证券投资顾问 / 证券分析师', jd: /(?:证券投资顾问|投资顾问|证券分析师)(?:执业)?(?:资格|证书|注册|胜任能力)|投顾资格/ },
  hk_sfc: { label: '香港证监会牌照（SFC / HKSI）', jd: /\bSFC\b|\bHKSI\b|香港证监会|证监会牌照|(?<!\d)[149]\s*号牌|\bType\s*[149]\s*(?:licen|regulated)/i },
  lawyer_license: { label: '律师执业证', jd: /律师执业(?:证|资格)|执业律师|律师证/ },
  patent_agent: { label: '专利代理师资格', jd: /专利代理(?:师|人)?(?:资格|执业证|证)|通过专利代理(?:师|人)?考试|patent bar|registered patent (?:agent|attorney)|USPTO registration/i },
  // 「Trainee Solicitor」是岗位名，不是要你有律师资格：只认「qualified / admitted」这类说法。
  foreign_bar: { label: '境外律师资格（纽约州、英格兰及威尔士、香港）', jd: /New York (?:State )?Bar|\bNY Bar\b|admitted (?:to practi[cs]e )?(?:law )?in (?:New York|England|Hong Kong)|qualified (?:to practi[cs]e )?(?:law )?in (?:New York|England|Hong Kong)|(?<!trainee )qualified solicitor|solicitor qualification|纽约州?律师(?:执业)?资格|英格兰及威尔士律师|香港律师(?:执业)?资格|境外律师资格|外国律师资格/i },
  tax_agent: { label: '税务师', jd: /税务师/ },
  // 「会计师事务所」不是证书；「注册会计师」是 CPA。会计师（不带初级、高级）就是中级职称的名字。
  accounting_title: { label: '会计职称', jd: /(?:初级|中级|高级|助理)?会计(?:专业技术)?(?:职称|资格)|(?<!注册|特许|管理)会计师(?!事务所)|(?:初级|中级|高级)(?:及以上)?职称/, rank: rank([/高级/, 3, '高级'], [/中级|(?<!助理|注册|特许|管理)会计师(?!事务所)/, 2, '中级'], [/初级|助理会计师/, 1, '初级']) },
  cia: { label: 'CIA（国际注册内部审计师）', jd: /\bCIA\b|注册内部审计师/ },
  cisa: { label: 'CISA（信息系统审计师）', jd: /\bCISA\b|信息系统审计师/i },
  hr_cert: { label: '企业人力资源管理师', jd: /人力资源管理师|人力资源师/ },
  economist_hr: { label: '经济师（人力资源）', jd: /经济师/ },
  shrm: { label: 'SHRM', jd: /\bSHRM(?:-S?CP)?\b/i },
  cipd: { label: 'CIPD', jd: /\bCIPD\b/i },
  prince2: { label: 'PRINCE2', jd: /PRINCE\s*2/i },
  ruankao_pm: { label: '软考信息系统项目管理师', jd: /信息系统项目管理师|系统集成项目管理工程师|软考.{0,6}(?:高级|中级|项目管理)/ },
  constructor: { label: '建造师', jd: /建造师/, rank: rank([/一级/, 2, '一级'], [/二级/, 1, '二级']) },
  driver: { label: '驾照', jd: /驾照|驾驶证|驾驶执照|driver'?s licen[cs]e|driving licen[cs]e|(?<![A-Za-z0-9])C[12]\s*(?:及以上|以上)?\s*(?:驾照|驾驶证|证)/i },
  // 语言：也从你的 languages、standard_answers.languages、skills 里读（「英语六级」「IELTS 7.5」）。
  cet: { label: '大学英语四六级 / 专八', language: true, jd: /(?:大学)?英语\s*[四六]级|\bCET[-\s]?[46]\b|(?<![一二三五七九十\d])[四六]级(?:证书|及以上|以上|成绩|水平)|专(?:业)?八|英语专业八级|\bTEM[-\s]?8\b/i, rank: rank([/专(?:业)?八|专业八级|TEM[-\s]?8/i, 3, '专八'], [/六级|CET[-\s]?6/i, 2, '六级'], [/四级|CET[-\s]?4/i, 1, '四级']) },
  ielts: { label: '雅思', language: true, jd: /\bIELTS\b|雅思/i, score: /(?:IELTS|雅思)\D{0,12}?(\d(?:\.5)?)(?!\d)/i },
  toefl: { label: '托福', language: true, jd: /\bTOEFL\b|托福/i, score: /(?:TOEFL|托福)(?:\s*iBT)?\D{0,12}?(\d{2,3})(?!\d)/i },
  jlpt: { label: '日语能力考试（JLPT）', language: true, jd: /\bJLPT\b|日语能力(?:考试)?|日语\s*N[1-5]|(?<![A-Za-z0-9])N[12](?:级|水平)/i, rank: rank([/N1|一级/i, 5, 'N1'], [/N2|二级/i, 4, 'N2'], [/N3|三级/i, 3, 'N3'], [/N4/i, 2, 'N4'], [/N5/i, 1, 'N5']) },
};
// 2026-10-02 加的证书。软件方向的离线判断（lib/judge-offline.mjs）不认它们，答案一个字不变。
export const ADDED_CERTS = new Set(['us_cpa', 'sponsor_rep', 'sac_advisor', 'hk_sfc', 'lawyer_license', 'patent_agent', 'foreign_bar', 'tax_agent', 'accounting_title', 'cia', 'cisa', 'hr_cert', 'economist_hr', 'shrm', 'cipd', 'prince2', 'ruankao_pm', 'constructor', 'driver', 'cet', 'ielts', 'toefl', 'jlpt']);
// 有高低 / 有分数 / 有科数的证书在一句话里写到哪一档。
const rankOf = (cert, s) => (cert.rank ? cert.rank.find((r) => r.re.test(String(s || ''))) || null : null);
const scoreOf = (cert, s) => { const m = cert.score && String(s || '').match(cert.score); return m ? Number(m[1]) : null; };
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
const subjectsOf = (s) => { const m = String(s || '').match(/(?:通过|过|passed)\s*(\d|[一二两三四五六七])\s*(?:科|门|个科目|of|\/|exams?|sections?|parts?)|(\d|[一二两三四五六七])\s*(?:科|门)\s*(?:及以上|以上|已过|通过)/i); if (!m) return null; const t = m[1] || m[2]; return Number(t) || CN_NUM[t] || null; };

// 一句话里要求到第几级：CFA Level II / 二级 / Part II。
const LEVEL = /\b(?:level|part|L)\s*(III|II|I|[123])\b|([一二三])级/i;
const ROMAN = { I: 1, II: 2, III: 3, 1: 1, 2: 2, 3: 3, 一: 1, 二: 2, 三: 3 };
const levelOf = (s) => { const m = String(s || '').match(LEVEL); if (!m) return null; const t = m[1] || m[2]; return ROMAN[/^[iI]+$/.test(t) ? t.toUpperCase() : t] || null; };

// ── JD 这一侧 ────────────────────────────────────────────────────────────────
// 按句子切开，一句一句看：这句提到哪张证、是要求还是优先、能不能入职后再考。
const PREFERRED = /优先|加分|preferred|a plus|is a plus|nice to have|desirable|bonus|progress toward|pursuing|candidates? (?:are|is) (?:a plus|preferred)/i;
const AFTER_HIRE = /入职后|入职.{0,6}内|within \d+ (?:days|months) of (?:hire|start|joining)|after (?:hire|joining)|ability to obtain|obtain within|sponsored/i;
const OR_ABOVE = /及以上|以上|or above|or higher|at least/i;
// 「CPA eligible」「具备报考 CPA 的条件」说的是学分 / 学历够不够报考，不是要你持证：不算证书缺口（学历要求由判断模型逐条看）。
const ELIGIBLE = /\bCPA[- ]eligible|eligible (?:to sit )?for the (?:CPA|bar)|CPA eligibility|具备.{0,6}报考|(?:bar|CPA)[- ]eligible/i;
const clauses = (text) => String(text || '').split(/[\n。；;]|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
// 一句话提到证书，不等于要求它：团队里有几位 CFA、公司报销考试费、「降低 CPA（获客成本）」都不是。
// 要求要有要求的说法；优先、加分另算；两样都没有的句子不算。「如有雅思、托福成绩，请注明」「请附 CET-6、托福等成绩证明」是请你附上，
// 不是要求（2026-10-02 端到端：汉坤的律师岗因此记了「JD 要求雅思、托福」两条缺口）。
const REQUIRE_CUE = /要求|须|必须|需(?:要|具备|持有)?|持有|具备|取得|通过|required|require|must|need|holder|certified|licen[cs]e|minimum|candidates? (?:with|for)|level\s*(?:I{1,3}|[123])|及以上|or above/i;
const NOT_A_REQUIREMENT = /reimburs|sponsor(?:ship)? (?:for|of) (?:the )?(?:exam|cfa|cpa)|pay for|支持考|报销|our (?:team|investment team|analysts?) (?:includes?|has|have)|团队(?:中|里)?(?:有|拥有)|\d+\s*(?:名|位)?\s*(?:CFA|CPA)\s*持证|cost per|CPA\s*[<>≤≥]|(?:降低|优化|控制)[^。；;]{0,8}CPA|CPA[^。；;]{0,8}(?:目标|优化|降低)|\bCPC\b|\bCPM\b|\bROAS\b|协助.{0,8}(?:执业律师|律师|保荐代表人|保代|专利代理师)|(?:配合|带领|跟随).{0,6}(?:保荐代表人|保代|律师)|公司(?:提供|报销|补贴).{0,6}(?:驾照|考证)|如有[^。；;]{0,24}(?:请注明|请附|请提供|请写明|请备注)|请(?:附|提供|注明)[^。；;]{0,30}(?:成绩|证明|证书)/i;

// CPA 一句话里只写了「US CPA / AICPA」时是美国 CPA，不另算一条中国 CPA；写明「中国注册会计师」「CICPA」的只认中国 CPA；
// 只写「CPA」「注册会计师」的，中国、美国 CPA 都算满足。
const CPA_CHINA = /中国注册会计师|\bCICPA\b|中国\s*CPA|中注协/i;
const US_CPA_ALL = new RegExp(CERTS.us_cpa.jd.source, 'gi');
export function jdCertifications(text = '', keys = Object.keys(CERTS)) {
  const found = new Map();
  for (const clause of clauses(text)) {
    if (NOT_A_REQUIREMENT.test(clause)) continue;
    for (const key of keys) {
      const cert = CERTS[key];
      if (!cert?.jd.test(clause)) continue;
      if (key === 'cpa' && !cert.jd.test(clause.replace(US_CPA_ALL, ' '))) continue;
      const preferred = PREFERRED.test(clause), afterHire = AFTER_HIRE.test(clause);
      if (!preferred && !REQUIRE_CUE.test(clause)) continue;
      const from = clause.slice(clause.search(cert.jd));
      const level = cert.levels ? levelOf(from) : null;
      // 有高低的：一句里写了几档（「四级或六级」）取最低的那档。
      const ranked = cert.rank ? [...cert.rank].reverse().find((r) => r.re.test(clause)) || null : null;
      const row = { key, label: cert.label, required: !preferred && !ELIGIBLE.test(clause), after_hire: afterHire, level, or_above: level != null && OR_ABOVE.test(clause), quote: clause.slice(0, 160) };
      if (ranked) Object.assign(row, { rank: ranked.n, rank_label: ranked.label, or_above: OR_ABOVE.test(clause) });
      const score = scoreOf(cert, clause);
      if (score != null) row.score = score;
      const subjects = cert.subjects ? subjectsOf(from) : null;
      if (subjects != null) row.subjects = subjects;
      if (key === 'cpa') row.scope = CPA_CHINA.test(clause) ? 'cn' : 'any';
      const prev = found.get(key);
      // 同一张证在几句里都出现：要求压过优先，级别取最高的那句。
      const grade = (r) => r.level || r.rank || r.score || r.subjects || 0;
      if (!prev || (row.required && !prev.required) || (row.required === prev.required && grade(row) > grade(prev))) found.set(key, row);
    }
  }
  return [...found.values()];
}

// ── 你这一侧 ─────────────────────────────────────────────────────────────────
// 「已通过 3 科」「专业阶段已通过」「passed 2 of 4」是进行中，不是持证：先认这些，再认持有。
const PARTIAL_FIRST = /通过\s*\d+\s*(?:科|门)|已通过\s*\d+|阶段|passed\s*\d+\s*(?:of|\/)|\d+\s*(?:of|\/)\s*\d+\s*(?:exams|sections|parts)/i;
const HELD = /持证|已取得|已拿到|charterholder|licensed|certified|已通过(?!.{0,4}[一二三]级)|^passed$|全科通过|通过全部/i;
const PARTIAL = /candidate|在考|备考|in progress|pursuing|registered|报名|level|part|[一二三]级|通过\s*\d+\s*科|passed \d|部分/i;
// 有高低、有分数的证书（语言、职称、建造师、法考）：写出来就是有，除非明说还在考。
const STUDYING = /在考|备考|报名|准备|candidate|in progress|pursuing|registered|studying/i;
const norm = (x) => (typeof x === 'string' ? { name: x, status: x } : { name: String(x?.name || ''), status: String(x?.status || ''), date: x?.date || null });
const flat = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => (x && typeof x === 'object' ? Object.values(x).join(' ') : String(x ?? ''))).filter(Boolean);
function certRow(key, text, status, date = null) {
  const cert = CERTS[key], ranked = rankOf(cert, text), score = scoreOf(cert, text), subjects = cert.subjects ? subjectsOf(text) : null;
  return { key, label: cert.label, status, level: cert.levels ? levelOf(text) : null, ...(ranked ? { rank: ranked.n, rank_label: ranked.label } : {}), ...(score != null ? { score } : {}), ...(subjects != null ? { subjects } : {}), ...(date ? { date: String(date) } : {}), text };
}
export function candidateCertifications(facts = {}) {
  const out = [];
  for (const raw of Array.isArray(facts?.certifications) ? facts.certifications : []) {
    const c = norm(raw), text = `${c.name} ${c.status}`;
    const key = Object.keys(CERTS).find((k) => CERTS[k].jd.test(c.name) || CERTS[k].jd.test(text));
    if (!key) continue;
    const cert = CERTS[key], label = `${c.name}${c.status && c.status !== c.name ? ` ${c.status}` : ''}`.trim();
    if (cert.rank || cert.score || cert.language) { out.push(certRow(key, label, STUDYING.test(text) ? 'partial' : 'held', c.date)); continue; }
    const level = cert.levels ? levelOf(text) : null;
    // 「CFA Level I passed」是一级已过（进行中），不是持证；「CFA charterholder」「已持证」才是持有。
    const held = PARTIAL_FIRST.test(text) ? false : HELD.test(c.status) && !(cert.levels && level != null) ? true : /charterholder|持证/i.test(text);
    const status = held ? 'held' : PARTIAL.test(text) || level != null || /passed|通过/i.test(text) ? 'partial' : 'held';
    out.push({ ...certRow(key, label, status, c.date), level });
  }
  // 语言证书也写在语言、技能里（「英语六级」「IELTS 7.5」）：没在 certifications 里出现过的补上。
  for (const text of [...flat(facts?.languages), ...flat(facts?.standard_answers?.languages), ...flat(facts?.skills)]) {
    for (const key of Object.keys(CERTS).filter((k) => CERTS[k].language && CERTS[k].jd.test(text) && !out.some((m) => m.key === k))) out.push(certRow(key, text.trim(), 'held'));
  }
  return out;
}

// ── 对照 ─────────────────────────────────────────────────────────────────────
const LEVEL_ZH = ['', '一', '二', '三'];
function needText(req) {
  const label = req.key === 'cpa' && req.scope === 'cn' ? '中国注册会计师' : req.label;
  if (req.rank != null) return `${label} ${req.rank_label}${req.or_above ? '及以上' : ''}`;
  if (req.score != null) return `${label} ${req.score} 分及以上`;
  if (req.subjects != null) return `${label} 通过 ${req.subjects} 科及以上`;
  return `${label}${req.level ? ` ${LEVEL_ZH[req.level]}级${req.or_above ? '及以上' : ''}` : ''}`;
}
function stateOf(req, have) {
  if (!have) return 'missing';
  if (req.rank != null && have.rank != null) return have.rank >= req.rank ? 'met' : 'partial';
  if (req.score != null && have.score != null) return have.score >= req.score ? 'met' : 'partial';
  if (req.subjects != null) return have.status === 'held' || (have.subjects ?? 0) >= req.subjects ? 'met' : 'partial';
  return have.status === 'held' || (req.level != null && have.level != null && have.level >= req.level) ? 'met' : 'partial';
}
// 每张 JD 要求的证书一行：met / partial / missing；gap 是给你看的一句话（只有「要求、且不能入职后再考、你还没满足」才有）。
export function certificationGaps(text, facts = {}, keys = directionCertifications(facts)) {
  if (!keys.length) return [];
  const mine = candidateCertifications(facts);
  const rows = jdCertifications(text, keys).map((req) => {
    // JD 只写「CPA」：中国 CPA、US CPA 有一个就算；写明中国的只认中国的。
    const have = mine.find((m) => m.key === req.key) || (req.key === 'cpa' && req.scope === 'any' && keys.includes('us_cpa') ? mine.find((m) => m.key === 'us_cpa') : null);
    const state = stateOf(req, have);
    // 资料里压根没写证书（没有 certifications 这一项）：不当成「没有」，说成「还没写」，请你补上。
    const yours = have ? `你：${have.text}` : Array.isArray(facts?.certifications) ? '你还没有' : '你的资料里还没写证书，去「设置 → 检查清单 → 个人资料」补上';
    const gap = req.required && !req.after_hire && state !== 'met' ? `证书：JD 要求 ${needText(req)}（${yours}）` : null;
    return { ...req, state: !have && !Array.isArray(facts?.certifications) ? 'unknown' : state, have: have?.text || null, gap };
  });
  // 同一句里要求几样语言成绩（「雅思 7 或托福 100」）是几选一：满足其中一样，这句的其余几样不再记缺口。
  for (const r of rows) if (r.gap && CERTS[r.key]?.language && rows.some((o) => o !== r && o.quote === r.quote && CERTS[o.key]?.language && o.state === 'met')) r.gap = null;
  return rows;
}
export const certificationGapText = (rows = []) => rows.filter((r) => r.gap).map((r) => r.gap).join('；') || null;
// 候选人证据里的一条（给判断模型引用）。
export function certificationEvidence(facts = {}) {
  const mine = candidateCertifications(facts);
  return mine.length ? `证书：${mine.map((m) => m.text).join('；')}` : null;
}

// ── 机构背景（2026-10-02） ───────────────────────────────────────────────────
// JD 要求「四大审计经验」「红圈所经验」（不是「优先」）时，对照你的经历：current_work.company、career_highlights 的公司。
// 名单在 lib/directions.mjs INSTITUTIONS；名单不固定的（「头部券商」）交给判断模型。只看你的方向用得上的那几张。
// 「四大或大型内资所」「四大或同等」不是非四大不可，不算。
const commaParts = (c) => c.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
const OR_SIMILAR = /或(?:其他|大型|知名|内资|本土|同等|同类|相关|国内)|或.{0,6}(?:所|事务所|律所)(?:工作)?经验|or (?:other|similar|equivalent|comparable|top|a leading|another)/i;
export function backgroundGaps(text = '', facts = {}, keys = directionInstitutions(facts)) {
  if (!keys.length) return [];
  const companies = [facts?.current_work?.company, ...(facts?.career_highlights?.entries || []).map((e) => e?.company)].filter(Boolean).map(String);
  const out = [];
  for (const key of keys) {
    const inst = INSTITUTIONS[key];
    const clause = clauses(text).flatMap(commaParts).find((c) => inst.jd.test(c) && /经验|经历|背景|工作|出身|experience|background/i.test(c) && !PREFERRED.test(c) && !OR_SIMILAR.test(c) && REQUIRE_CUE.test(c) || (inst.jd.test(c) && /\d+\s*年.{0,4}以上/.test(c) && !PREFERRED.test(c) && !OR_SIMILAR.test(c)));
    if (!clause) continue;
    const kind = clause.match(inst.jd)?.[1];
    const need = `${inst.zh}${kind && !/事务所/.test(kind) ? kind : ''}经验`;
    const met = companies.some((c) => inst.names.test(c));
    out.push({ key, need, met, quote: clause.slice(0, 160), ...(met ? {} : { gap: `背景：JD 要求${need}（${companies.length ? '你的经历里没有' : '你的资料里还没写工作经历'}）` }) });
  }
  return out;
}

// ── 执业年限（法律方向，2026-10-02） ─────────────────────────────────────────
// 律所说的年限是 PQE：拿到执业资格以后的年数，不是毕业以后的年数。JD 写「3 年以上执业经验」「2–4 年 PQE」时，
// 用你资料里律师执业证那一条的 date 算；没写日期就是待核。只对法律方向生效。
// 律所常在年数和「执业经验」之间写业务领域（「1-3年资产管理和金融监管相关内资或外资律所执业经验」），中间最多隔 20 个字，不跨逗号。
const PRACTICE = /(?<!\d)(\d{1,2})\s*\+?\s*(?:[-‐‑–—~至到]\s*\d{1,2}\s*)?年(?:以上|及以上)?(?:[^，,。；;\d]{0,20}?(?:执业经验|执业年限)|(?:的)?(?:律师)?(?:执业|PQE))|(\d{1,2})\s*\+?\s*(?:[-–~]\s*\d{1,2}\s*)?(?:years?['’]?\s*)?(?:of\s+)?(?:PQE|post[- ]qualification)/i;
export function practiceYearsGap(text = '', facts = {}, now = new Date()) {
  if (primaryDirection(facts) !== 'legal') return null;
  // 一句里常用逗号接一句「……优先」（「2–4 年 PQE，有红圈所经验优先」）：按逗号拆开，只看写年限的那一段。
  const clause = clauses(text).flatMap(commaParts).find((c) => PRACTICE.test(c) && !PREFERRED.test(c));
  if (!clause) return null;
  const m = clause.match(PRACTICE), need = Number(m[1] || m[2]);
  const license = candidateCertifications(facts).find((c) => c.key === 'lawyer_license');
  const d = String(license?.date || '').match(/(\d{4})(?:\D{1,3}(\d{1,2}))?/);
  if (!d) return { need, have: null, gap: `年限：JD 要求 ${need} 年执业经验，你的资料里没写执业证日期` };
  const months = now.getUTCFullYear() * 12 + now.getUTCMonth() - (Number(d[1]) * 12 + (Number(d[2]) || 1) - 1);
  const have = Math.max(0, Math.floor(months / 6) / 2);
  return { need, have, ...(have < need ? { gap: `年限：JD 要求 ${need} 年执业经验，你约 ${have} 年（按律师执业证日期算）` } : {}) };
}
// 证书、背景、执业年限三样缺口连成一句（判断层、文字模型那条路共用）。
export function hardGateGaps(text = '', facts = {}, now = new Date()) {
  const certs = certificationGaps(text, facts), background = backgroundGaps(text, facts), practice = practiceYearsGap(text, facts, now);
  const parts = [certificationGapText(certs), ...background.filter((b) => b.gap).map((b) => b.gap), practice?.gap].filter(Boolean);
  return { certs, background, practice, text: parts.join('；') || null };
}
