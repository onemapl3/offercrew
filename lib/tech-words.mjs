// 要求里提到了哪些技术、你资料里的技能有没有（第 3 轮，主会话 10-02）。两处用：
//   lib/matcher.mjs normalizeMatchEvidence  「A、B、C 之一」而你会其中一个：算满足；软素质一律非关键。
//   lib/first-round.mjs gapOf              一条说不清的要求缺的是哪一项技术（「简历里看不出 Java 的经验」）。
// 只认这张表里的名字；认不出的技术不猜。
export const TECH = [
  ['Java', /\bjava\b(?!\s*script)/i], ['C++', /c\+\+|\bcpp\b/i], ['C#', /c#|\.net\b/i], ['Go', /\bgo\b|golang/i], ['Python', /python/i], ['PHP', /\bphp\b/i],
  ['Rust', /\brust\b/i], ['Kotlin', /kotlin/i], ['Swift', /\bswift\b/i], ['Objective-C', /objective-?c/i], ['TypeScript', /typescript/i], ['JavaScript', /javascript/i],
  ['Node.js', /node\.?js/i], ['React', /\breact\b/i], ['Vue', /\bvue(?:[23])?\b/i], ['Spring', /\bspring\b/i], ['Nginx', /nginx/i], ['Redis', /redis/i], ['MySQL', /mysql/i],
  ['PostgreSQL', /postgres/i], ['MongoDB', /mongo/i], ['Kafka', /kafka/i], ['Flink', /flink/i], ['Spark', /\bspark\b/i], ['Hadoop', /hadoop/i], ['Kubernetes', /kubernetes|\bk8s\b/i],
  ['Docker', /docker/i], ['Linux', /linux/i], ['Qt', /\bqt\b/i], ['CMake', /cmake/i], ['FFmpeg', /ffmpeg/i], ['PyTorch', /pytorch/i], ['TensorFlow', /tensorflow/i],
  ['CUDA', /\bcuda\b/i], ['Unity', /\bunity\b/i], ['Unreal', /unreal/i], ['SQL', /\bsql\b/i],
];
const norm = s => String(s ?? '').toLowerCase().replace(/[\s.\-_]/g, '').replace(/^golang$/, 'go');
// 一段文字里提到的技术名（按表里的顺序，去重）。
export const techsIn = text => TECH.filter(([, re]) => re.test(String(text ?? ''))).map(([name]) => name);
// 资料里的技能：facts.skills 可以是字符串，也可以是 { name, items }。
const skillsOf = facts => (Array.isArray(facts?.skills) ? facts.skills : []).flatMap(s => typeof s === 'string' ? [s] : [s?.name, ...(s?.items || [])]).filter(Boolean).map(norm);
export const hasSkill = (facts, name) => skillsOf(facts).includes(norm(name));

// 「A、B、C 之一」「Java 或 Go」：列了两项以上技术，又说只要其中一项。你资料里会其中一项，就返回那一项。
const ANY_OF = /之一|至少一[种门个项]|其一|任一|任意一|其中一|one of|either|\bor\b|或/i;
export function anyOfSatisfied(req, facts) {
  const t = techsIn(req);
  if (t.length < 2 || !ANY_OF.test(String(req ?? ''))) return null;
  return t.find(name => hasSkill(facts, name)) || null;
}
// 年限那一句里点了哪些技术（开箱第 4 轮 F07）：「3 年以上 Golang 开发经验」→ Go；「3 年以上后端开发经验，熟悉 Go」→ 没有
// （年限说的是后端开发，Go 在另一句）。hasYears(一句) 说这一句里有没有年限要求。anyOf：「Java 或 Go」只要其一。
export function yearsClauseTechs(text, hasYears) {
  const clauses = String(text ?? '').split(/[，,。；;\n]/).filter((c) => hasYears(c));
  const techs = [...new Set(clauses.flatMap(techsIn))];
  return { techs, anyOf: techs.length > 1 && clauses.some((c) => techsIn(c).length > 1 && ANY_OF.test(c) || /[\/／]/.test(c)) };
}
// 领域（开箱第 5 轮，10-03）：「2 年以上游戏服务端开发经验」的「游戏」不是技能，这一条的年限只算写到这个领域的经历
// （lib/screening.mjs domainTenure），不拿全部年限顶上。只认这张表里的；认不出的领域不猜，照旧按总年限。
export const DOMAINS = [
  ['游戏', /游戏|\bgam(?:e|es|ing)\b/i], ['金融', /金融|银行|证券|基金|投行|期货|fintech|\bbank(?:s|ing)?\b|financ(?:e|ial)|securities/i],
  ['保险', /保险|insurance/i], ['医疗', /医疗|医药|医院|health\s?care|medical|pharma/i], ['电商', /电商|电子商务|e-?commerce/i],
  ['音视频', /音视频|直播|流媒体|live\s?stream|video streaming/i], ['广告', /广告|ad\s?tech|advertising/i], ['支付', /支付|\bpayments?\b/i],
  ['教育', /教育|在线课程|edtech|education/i], ['汽车', /汽车|车载|自动驾驶|智能驾驶|automotive|autonomous driving/i], ['芯片', /芯片|半导体|semiconductor/i],
  ['物流', /物流|供应链|logistics|supply chain/i], ['跨境', /跨境|cross-?border/i], ['区块链', /区块链|web3|blockchain|crypto/i],
  ['推荐系统', /推荐系统|推荐算法|recommend(?:ation|er) system/i], ['搜索', /搜索引擎|搜索系统|search engine/i],
  ['NLP', /\bnlp\b|自然语言处理|natural language processing/i],
  ['AI', /\bai\b|人工智能|机器学习|深度学习|\bllm\b|大模型|智能体|machine learning|deep learning/i],
  ['影视与AIGC', /影视|电影|视频制作|\baigc\b|film|video production/i],
  ['技术负责人', /技术负责人|技术管理|研发管理|带领.{0,8}(?:研发|技术|开发)团队|tech(?:nical)? lead|engineering manag/i],
  ['前端', /前端|front.?end|\bvue(?:[23])?\b|\breact\b/i],
  ['后端', /后端|服务端|back.?end|server.side/i],
];
export const domainsIn = text => {
  const names = DOMAINS.filter(([, re]) => re.test(String(text ?? ''))).map(([name]) => name);
  return names.includes('NLP') || names.includes('影视与AIGC') ? names.filter(n => n !== 'AI') : names;
};
export const domainRe = name => DOMAINS.find(([n]) => n === name)?.[1] || null;
// 年限那句话本身修饰的是哪个领域（主会话 10-03：certik 那条把公司介绍里的「Web3」「crypto」算成了「3 年区块链」）。只看年数后面紧跟的那一小段：
//   中文「N 年以上……经验 / 经历」中间那几个字（「2 年以上游戏服务端开发经验」→「游戏服务端开发」；「3 年以上工作经验，有游戏行业经验者优先」→「工作」）；
//   英文「N+ years of (experience) in / with / building / developing …」后面那一小段，到逗号、句号、分号、括号或换行为止，
//   或「N years of … experience」中间那几个词。同一段里别处的领域词（公司介绍、福利、别的列表项）一律不算。
// → [{ need: 这一句自己的年数, domains: [表里的领域] }]（只留点了领域的）
// 顿号连接同一年限下的领域列表，不是句界；仍在逗号、分号等处停止，避免把后句的优先项算成年限。
const ZH_YEARS = /(?:至少|最少|不少于|不低于)?\s*(\d{1,2})\s*(?:[-–—~至到]\s*\d{1,2}\s*)?年(?:以上|及以上|或以上)?(?:左右|以上|及以上|或以上)?(?:的)?([^，,。；;：:\n！？!?]{0,100}?)(?:经验|经历)/g;
const EN_YEARS = /(\d{1,2})\s*(?:\+\s*)?(?:[-–—]\s*\d{1,2}\s*)?(?:\+\s*)?years?['’]?(?:\s+of)?((?:\s+(?:professional|hands-on|relevant|industry|commercial|practical|proven|solid|full-time|work|working))*)(?:\s+experience)?\s+(?:(?:in|with|on|at|of|building|developing|designing|shipping|working (?:on|in|with))\s+([^.,;:\n()]{1,60})|([^.,;:\n()]{1,40}?)\s+experience\b)/gi;
export function yearsDomains(text) {
  const t = String(text ?? ''), out = [];
  for (const m of t.matchAll(ZH_YEARS)) { const d = domainsIn(m[2]); if (d.length) out.push({ need: Number(m[1]), domains: d }); }
  for (const m of t.matchAll(EN_YEARS)) { const d = domainsIn(m[3] || m[4] || ''); if (d.length) out.push({ need: Number(m[1]), domains: d }); }
  return out;
}
// 软素质：沟通、团队、抗压、责任心、学习能力……简历上永远写不明，也不是用人方筛人的门槛。语言要求（英语、日语……）不算；
// 同一条里还点了名技术的（「熟悉 Linux，问题排查能力强」）也不算，那一条照旧按技术看。
const SOFT = /沟通|团队合作|团队协作|协作|合作精神|抗压|责任心|责任感|学习能力|学习意愿|自驱|自我驱动|逻辑思维|热情|主动|钻研|执行力|积极|上进|踏实|好奇心|表达能力|领导力|结果导向|问题分析|解决问题|问题解决|communication|teamwork|team player|collaborat|self[- ]?motivat|passion|proactive|learning ability|problem[- ]solving|attention to detail|ownership|work ethic/i;
const LANGUAGE = /英语|英文|日语|日文|韩语|德语|法语|English|Japanese|Korean|German|French|普通话|粤语|Cantonese|Mandarin/i;
// 一句里混了软素质和专业要求时不能整句降级；智能体协作是系统能力，不是人际协作。
const PROFESSIONAL = /开发|研发|编程|编码|架构|算法|分布式|集群|接口|框架|排查|工程|上线|系统|平台|设计|策划|实施|交付|管理|开源|学历|本科|硕士|证书|\d+\s*(?:年|years?)|(?:技术|产品|项目).{0,8}(?:经验|设计|交付)|\b(?:experience|engineering|architecture|distributed|framework|deployment|implement|develop|program|debug|design|build)\b/i;
// 能力形容词不是缺失的履历事实；一旦同句点了技术、年限、领域或具体职责，仍按专业要求判断。
const GENERAL_ABILITY = /(?:production[- ]quality|high[- ]quality)\s+(?:software|code)|(?:strong|solid|sound)\s+fundamentals|扎实的?(?:编程|编码)能力|较强的?学习能力/i;
const CONCRETE_ABILITY = /\d+\s*\+?\s*(?:年|years?)|[一二两三四五六七八九十]+年|经验|经历|学历|本科|硕士|证书|开源|算法|架构|分布式|接口|框架|部署|排查|管理|\b(?:experience|deployments?|architectures?|distributed|framework|debugging|management)\b/i;
export const softSkill = req => {
  const r = String(req ?? '');
  return !LANGUAGE.test(r) && !techsIn(r).length && ((GENERAL_ABILITY.test(r) && !CONCRETE_ABILITY.test(r) && !domainsIn(r).length) || (SOFT.test(r) && !PROFESSIONAL.test(r)));
};

// 已引用的事实也要支撑这条要求。只纠正能确定的错配；跨语言迁移仍交给判断。
export function supportedEvidence(row) {
  const req = String(row.req || ''), ref = String(row.resume_ref || '').trim();
  if (!['met', 'transferable'].includes(row.status)) return row;
  const empty = !ref || /^unknown$/i.test(ref);
  const ui = /Vue[23]?|React|前端|视觉还原|视觉交付|\bUI\b|GUI|用户界面/i.test(req);
  const uiProof = /Vue[23]?|React|前端|front.?end|界面|交互|视觉|\bUI\b|GUI|CSS|HTML/i.test(ref);
  const coding = /AI.{0,6}(?:编程|编码)|(?:Cursor|Copilot|Claude Code|Codex)/i.test(req);
  const codingProof = /AI.{0,6}(?:编程|编码)|Cursor|Copilot|Claude Code|Codex/i.test(ref);
  if (!empty && (!ui || uiProof) && (!coding || codingProof)) return row;
  return { ...row, status: 'unknown', resume_ref: 'unknown' };
}
