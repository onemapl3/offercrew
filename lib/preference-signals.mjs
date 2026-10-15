// What the user did, turned into signed signals.
//
// Every preference the system claims to have learned has to be traceable back to
// something the user actually did: tapped 跳过 on a card, replied 联系, let a form
// be submitted, got an interview. This file does that translation and nothing
// else — it reads events, attaches the features of the job they were about, and
// returns a flat list of `{kind, sign, features, reasons}` rows. The weighting,
// the decay and the learned rules all live in lib/preferences.mjs, so the
// question "why does the system think this" is always answerable by reading a
// list of events rather than a model.
//
// It imports only the store and the city rules, so lib/preferences.mjs can be
// imported by the matcher without an import cycle. (lib/directions.mjs and
// lib/facts.mjs import nothing of ours, so they keep that true.)
import { lines, read, hash } from './store.mjs';
import { leadCity } from './city.mjs';
import { FAMILIES, isGeneral } from './directions.mjs';
import { currentFacts } from './facts.mjs';
import { leadState, PASSED, CONTACT } from './lead-state.mjs';

// ---------------------------------------------------------------------------
// Features of a posting. These are the axes a preference can exist on: a
// direction ("Agent 应用"), a company, a city, a grade, a piece of stack, a pay
// band and how the job was found. A lead carries several of each; a preference
// is always about one `dim:value` pair, never about a whole posting.

export const DIMENSIONS = ['direction', 'company', 'company_type', 'city', 'seniority', 'stack', 'salary_band', 'source_type'];

// The job families the user's search actually distinguishes between. The first
// pattern that matches contributes its name; a posting can belong to more than
// one (an "Agent 平台后端" is both), which is the point — the user's likes and
// dislikes are usually about one of the two, not the pair.
export const DIRECTION_RULES = [
  ['Agent应用', /agent|智能体|llm\s*应用|ai\s*应用|applied\s*ai|大模型应用|\brag\b|检索增强|prompt|工作流编排|ai\s*engineer/i],
  ['算法研究', /算法|research|科学家|模型训练|预训练|后训练|强化学习|rlhf|多模态|machine learning engineer|策略工程/i],
  ['后端平台', /backend|back.end|后端|服务端|platform|平台|基础设施|infra(?:structure)?|中间件|分布式|微服务|架构/i],
  ['全栈产品', /全栈|full.?stack|产品工程|\bweb\b|前端|node\.?js/i],
  ['数据', /数据平台|数据工程|数仓|\bdata\s*(?:engineer|platform|pipeline)\b|\betl\b|\bbi\b/i],
  ['工具链', /工具链|devops|\bsre\b|运维|ci\/cd|研发效能|平台工程/i],
];
// 主方向不是软件的人（金融、咨询、市场……）学的是另一张类别表：岗位标题落在哪个类别（投行、资管、风控……），
// 名字就是界面上的中文名。软件方向还是上面那张。
export const GENERAL_DIRECTION_RULES = Object.values(FAMILIES).filter((f) => f.title).map((f) => [f.zh, f.title]);
export const directionRules = (facts = currentFacts()) => (isGeneral(facts) ? GENERAL_DIRECTION_RULES : DIRECTION_RULES);
// Grade words as the posting writes them. 未标注 is a real answer: most postings
// state no grade, and "the user keeps skipping postings that state no grade" is
// not a preference worth learning.
export const SENIORITY_RULES = [
  ['管理岗', /manager|director|\bhead of\b|总监|负责人|经理|首席/i],
  ['资深岗', /\bsenior\b|\bsr\.?\b|\bstaff\b|\bprincipal\b|\blead\b|架构师|资深|高级|专家/i],
  ['初级岗', /\bjunior\b|初级|应届|校招|\bentry\b|\bgraduate\b|实习/i],
];
// Stack words worth remembering. Deliberately short: a preference for "Python"
// is meaningful, a preference for "敏捷" is noise.
export const STACK_RULES = [
  // "Go" the language, not "go" the verb: it must sit next to a stack word.
  ['Python', /\bpython\b/i], ['Go', /\bgolang\b|\bGo\b(?=\s*(?:语言|开发|工程师|服务|后端|\/|,|，|、|\)|$))|(?:[\/,，、(]\s*)Go\b/], ['Java', /\bjava\b(?!script)/i],
  ['TypeScript', /\btypescript\b/i], ['Rust', /\brust\b/i], ['C++', /c\+\+/i],
  ['大模型', /\bllm\b|大模型|gpt|claude|通义|豆包/i], ['RAG', /\brag\b|检索增强|向量/i],
  ['K8s', /kubernetes|k8s|docker|容器/i], ['云', /\baws\b|\bgcp\b|\bazure\b|阿里云|云原生/i],
  ['分布式', /分布式|高并发|微服务/i], ['React', /\breact\b|\bvue\b/i],
];
export const STACK_MAX = 4;

const text = (l = {}) => `${l.role || ''} ${l.jd_text || l.jd || ''}`;
const matchRules = (rules, s) => rules.filter(([, re]) => re.test(s)).map(([name]) => name);
export const ruleRegex = (rules, value) => (rules.find(([name]) => name === value) || [])[1] || null;

// Pay, from the field the scraper filled or from a literal salary expression in
// the posting. A band, not a number: the user's rule is "below my floor", and a
// band is the coarsest thing that can express it without inventing precision.
const SALARY_PATTERNS = [
  /(\d{1,3})\s*[-–~至到]\s*(\d{1,3})\s*[kK]/,
  /(\d{1,3})\s*[-–~至到]\s*(\d{1,3})\s*万/,
];
export function salaryBand(l = {}) {
  const s = `${l.salary || l.salary_range || ''} ${l.jd_text || l.jd || ''}`;
  const k = s.match(SALARY_PATTERNS[0]);
  if (k) return band((Number(k[1]) + Number(k[2])) / 2);
  const w = s.match(SALARY_PATTERNS[1]);
  // 万 is an annual figure; a year is about fourteen months of pay in this market.
  if (w) return band(((Number(w[1]) + Number(w[2])) / 2) * 10 / 14);
  return '薪资未写';
}
const band = (monthlyK) => (monthlyK < 20 ? '薪资低档' : monthlyK <= 35 ? '薪资中档' : '薪资高档');

// Every feature of one posting, as `{dim, value}` pairs.
export function leadFeatures(lead = {}) {
  const l = lead || {};
  const blob = text(l);
  const out = [];
  const push = (dim, value) => { if (value && !out.some((f) => f.dim === dim && f.value === value)) out.push({ dim, value }); };
  // The direction comes from the title first. A JD body mentions 算法 or 平台 in
  // passing all the time; a title that says 算法工程师 means it. Only a title that
  // matches nothing falls back to the body.
  const rules = directionRules();
  const titled = matchRules(rules, String(l.role || ''));
  for (const d of (titled.length ? titled : matchRules(rules, blob))) push('direction', d);
  if (l.company) push('company', String(l.company).trim());
  // What kind of employer it is comes from Jev's reading of the posting
  // (lib/judgements.mjs); it is the axis "外企多一点" is about.
  const ctype = l.judgement?.posting?.company_type;
  if (ctype && ctype !== 'unknown') push('company_type', ctype);
  // The judged grade and family are sharper than the title regexes when present.
  push('city', leadCity(l));
  // entry / intern 只出现在通用路径读过的 JD 里（lib/directions.mjs GRADES）。
  const judgedGrade = { junior: '初级岗', senior_or_above: '资深岗', management: '管理岗', entry: '初级岗', intern: '实习岗' }[l.judgement?.posting?.grade];
  const grade = judgedGrade || matchRules(SENIORITY_RULES, String(l.role || ''))[0];
  if (grade) push('seniority', grade);
  for (const s of matchRules(STACK_RULES, blob).slice(0, STACK_MAX)) push('stack', s);
  // Pay the posting never stated is not a preference, so it is not a feature.
  const pay = salaryBand(l);
  if (pay !== '薪资未写') push('salary_band', pay);
  const type = String(l.source_type || '').trim();
  if (type) push('source_type', /真人|内推|HR直发|Boss/.test(type) ? '真人直发' : '公司官方页');
  return out;
}
export const featureKey = (f) => `${f.dim}:${f.value}`;

// ---------------------------------------------------------------------------
// Why the user said no. `pass` reasons are free text — "太偏研究了"、"年限不够"、
// "地点不行" — so they are read with keyword rules, never with a model, and a
// reason that matches nothing stays unparsed rather than being guessed at.

export const PASS_REASON_RULES = [
  ['算法研究', /算法|太偏研究|偏研究|research|模型训练|预训练|强化学习|多模态|科研|论文/i],
  ['年限', /年限|年以上|经验要求|经验不足|资历|年经验|工作年数/],
  ['职级', /职级|\bsenior\b|\bstaff\b|资深|高级|专家|总监|负责人|架构师|太高/i],
  ['地点', /地点|城市|不在|异地|通勤|外地|搬家|relocat|北京|深圳|广州|成都|西安|武汉/i],
  ['薪资低', /薪资低|薪资|工资|待遇|薪水|低于底线|给的少|钱少|package/i],
  ['实习', /实习|\bintern\b/i],
  ['方向不符', /方向|不符|不感兴趣|不合适|不对口|不是我/],
  ['公司', /公司|规模|外包|不明|没听过|外派|小作坊/],
];
// 刷卡跳过 is what the flashcard writes when the user taps 跳过 without saying
// why. It is a real negative, but it is not a stated reason, so it can never on
// its own justify a learned exclusion rule.
export const SILENT_REASON = '刷卡跳过';
export function parsePassReason(reason = '') {
  const t = String(reason || '').trim();
  if (!t) return [];
  if (t.includes(SILENT_REASON)) return [SILENT_REASON];
  const codes = PASS_REASON_RULES.filter(([, re]) => re.test(t)).map(([code]) => code);
  return codes.length ? codes : [];
}
export const explicitReasons = (codes = []) => codes.filter((c) => c !== SILENT_REASON);

// ---------------------------------------------------------------------------
// The events themselves.
//
// A signal is one thing the user did about one posting. The sign says whether it
// was a yes or a no; the size says how much of a yes — an interview the user sat
// is worth more than a card they tapped 联系 on, and a 稍后 is barely a no at all.

export const EVENT_WEIGHTS = {
  interview: 4,   // 招聘方回复或面试：这条路真的走通了
  submitted: 3,   // state/outbound.ndjson 里有提交回执
  apply: 3,       // 刷卡「投递」或「发」：用户主动要投
  contact: 2,     // 「联系」/刷卡「邮件联系」
  followup: 1,    // 「跟进」
  later: -0.5,    // 刷卡「稍后」：不是拒绝，只是没兴趣现在看
  rejected: -0.5, // 招聘方拒信：不是用户的偏好，但这一类确实没走通
  skip: -1.5,     // 刷卡「跳过」，没写原因
  pass: -2.5,     // 明确 pass，通常带原因
};
export const POSITIVE_KINDS = ['interview', 'submitted', 'apply', 'contact', 'followup'];
export const NEGATIVE_KINDS = ['pass', 'skip', 'later', 'rejected'];

const FEEDBACK_KIND = { 联系: 'contact', 跟进: 'followup', 发: 'apply', pass: 'pass' };
// The two flashcard taps that leave no feedback event of their own: 投递 goes to
// bin/queue-apply.mjs and 稍后 only parks the card. 跳过 and 邮件联系 already
// arrive as feedback events, so reading them here as well would count twice.
const SESSION_KIND = { flash_apply: 'apply', flash_later: 'later' };

const leadIndex = (leads) => new Map(leads.map((l) => [l.record_id || l.id, l]));

// One signal per (lead, kind): a posting the user tapped 联系 on three times
// through three different cards is still one opinion about that posting.
export function extractSignals({
  feedback = lines('state/feedback.ndjson'),
  leads = lines('state/leads.ndjson'),
  outbound = lines('state/outbound.ndjson'),
  session = read('state/flashcard-session.json', {}),
  now = Date.now(),
} = {}) {
  const byId = leadIndex(leads);
  const seen = new Map();
  const add = (record_id, kind, at, { reasons = [], source = '', raw = '' } = {}) => {
    const lead = byId.get(record_id);
    if (!lead || !kind || !EVENT_WEIGHTS[kind]) return;
    const key = `${record_id}|${kind}`;
    const prior = seen.get(key);
    if (prior && String(prior.at) >= String(at)) {
      // Keep the earliest reason text but remember every reason that was given.
      for (const r of reasons) if (!prior.reasons.includes(r)) prior.reasons.push(r);
      return;
    }
    const signal = {
      id: hash([record_id, kind]).slice(0, 24),
      record_id, number: lead.number ?? null, company: lead.company || '', role: lead.role || '',
      kind, at: at || new Date(now).toISOString(), base: EVENT_WEIGHTS[kind],
      sign: EVENT_WEIGHTS[kind] >= 0 ? 1 : -1,
      // A reason only ever explains a no. Text attached to a 联系 is a note about
      // that job, not a complaint about its kind.
      reasons: EVENT_WEIGHTS[kind] < 0 ? [...new Set([...(prior?.reasons || []), ...reasons])] : [],
      source, raw: String(raw || '').slice(0, 120),
      features: leadFeatures(lead),
    };
    seen.set(key, signal);
  };

  for (const e of feedback) {
    const kind = e.action === 'pass' && String(e.reason || '').includes(SILENT_REASON) ? 'skip' : FEEDBACK_KIND[e.action];
    if (!kind) continue;
    add(e.record_id, kind, e.at, { reasons: parsePassReason(e.reason), source: e.source || 'feedback', raw: e.reason || e.raw || '' });
  }
  for (const o of outbound) add(o.record_id, 'submitted', o.at, { source: `outbound:${o.channel || '未记录'}` });
  for (const [record_id, answer] of Object.entries(session.processed || {})) {
    const kind = SESSION_KIND[answer?.action];
    if (kind) add(record_id, kind, answer.at, { source: 'flashcard' });
  }
  for (const l of leads) {
    const id = l.record_id || l.id;
    // A decision the user made in the Base rather than in chat leaves no event
    // row, only the lead's state and `note`. Same decision, same signal; the
    // dedupe above keeps it from being counted twice.
    const st = leadState(l), decided = PASSED.has(st) ? 'pass' : CONTACT.has(st) ? '联系' : l.follow_up_at ? '跟进' : null;
    const kind = decided === 'pass' && String(l.note || '').includes(SILENT_REASON) ? 'skip' : FEEDBACK_KIND[decided];
    if (kind) add(id, kind, l.feedback_at || l.updated_at, { reasons: parsePassReason(l.note), source: 'lead', raw: l.note || '' });
    if (l.interview_at || l.interview_completed_at || /^interview_/.test(st)) add(id, 'interview', l.interview_at || l.updated_at || l.feedback_at, { source: 'interview' });
    else if (l.replied_at || st === 'replied') add(id, 'interview', l.replied_at, { source: 'reply' });
    if (st === 'rejected') add(id, 'rejected', l.updated_at || l.feedback_at, { source: 'stage' });
  }
  return [...seen.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// The recent history the model is shown when it judges a new posting: what the
// user went after, and what he threw away and why.
export function recentDecisions(signals = [], { positive = 3, negative = 5 } = {}) {
  const newest = [...signals].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const pick = (kinds, max) => {
    const rows = [];
    const companies = new Set();
    for (const s of newest) {
      if (!kinds.includes(s.kind) || rows.length >= max) continue;
      const key = `${s.company}|${s.role}`;
      if (companies.has(key)) continue;
      companies.add(key);
      rows.push(s);
    }
    return rows;
  };
  return { pursued: pick(['submitted', 'apply', 'contact'], positive), dropped: pick(['pass', 'skip'], negative) };
}
