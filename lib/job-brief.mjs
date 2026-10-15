// The job brief: the unit every card is built from.
//
// A number and a company name do not tell the user whether to spend an afternoon
// on a posting. Every card that mentions a job now carries the same seven facts,
// derived from the JD text and the match result and never invented: who posted
// it, the role / place / pay, the problem the team is hiring against, three
// requirement keywords, one line of fit and one of the biggest gap, how it is
// applied to, and the original post. Anything the posting does not say is
// written as 未写 rather than guessed.
import { read, lines } from './store.mjs';
import { applyWord, applyChannel, applyUrl, leadCity, portalSession, CHANNEL_LABEL } from './apply-channel.mjs';
import { fitLine } from './positioning.mjs';
import { learningNote } from './preferences.mjs';
import { loadFacts } from './application-form.mjs';
import { archivedLead } from './lead-state.mjs';

export const BRIEF_MIN = 150;
export const BRIEF_MAX = 250;
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (clean(s).length > n ? clean(s).slice(0, n - 1) + '…' : clean(s));
export const NOT_STATED = '未写';

// A named person posted it, or a company page did. The difference is the single
// best predictor of a reply, so it leads the brief.
export function briefSource(l = {}) {
  const type = String(l.source_type || '');
  const human = /真人|内推|HR直发|Boss/.test(type);
  const who = clean(l.author || l.contact_name || '');
  if (human) return { human: true, text: `${who || '发帖人未署名'}（${type || '真人直招'}）本人发帖` };
  if (who) return { human: false, text: `${who} 发布于 ${type || '公开来源'}` };
  return { human: false, text: `${l.source || type || '官方招聘页'}（公司官方页面，非本人发帖）` };
}

// The problem the team is hiring against, in the posting's own words. Sentences
// that describe work come first; boilerplate about the company does not.
const WORK = /(负责|你将|你会|我们正在|我们需要|构建|搭建|开发|设计|优化|解决|落地|主导|参与|build|develop|design|own|drive|ship|improve|scale|responsible for|you will)/i;
export function briefProblem(l = {}) {
  const jd = clean(l.jd_text || l.jd || '');
  if (!jd) return null;
  const sentences = jd.split(/(?<=[。！？!?;；\n])|(?<=\.\s)/).map(clean).filter(s => s.length > 8);
  // Prefer the first duty the digest found: it is already the posting's own
  // sentence about the work, trimmed of the section label.
  const duty = jdDigest(l, { max: 1, min: 0 }).duties[0];
  if (duty) return duty;
  const hit = sentences.find(s => WORK.test(s)) || sentences[0];
  return hit ? cut(hit, 60) : null;
}

// The part the user said he cannot judge a job without: what the JD actually
// asks for, compressed but not paraphrased. Bullets and sentences are split as
// the posting wrote them, sorted into 职责 and 要求 by the words the posting uses,
// and each line is cut to 25 characters with its numbers and technology names
// intact (the user's 2026-09-15 rule).
const DUTY = /(负责|职责|你将|你会|主导|参与|构建|搭建|开发|设计|落地|优化|维护|推动|own|build|develop|design|drive|ship|implement|maintain|responsible|you will)/i;
const REQ = /(要求|任职|资格|熟悉|精通|掌握|具备|至少|以上|优先|加分|经验|学历|本科|硕士|requirement|qualification|must have|nice to have|proficient|familiar|experience|degree|\byears?\b|\d\s*年)/i;
export const JD_LINE_MAX = 25;
export const jdLines = jd =>
  // The posting's own line breaks and bullets are the structure; collapsing the
  // whitespace first would destroy it.
  String(jd)
    .split(/\r?\n|[·•▪●]\s*|\s+[-–—]\s+|^[-–—]\s+|(?<=[。！？;；])/m)
        // Strip only a list marker. "3 年以上经验" must keep its 3.
    .map(x => clean(x).replace(/^(?:[-*+•·—–]|\d{1,2}\s*[.、)）])\s*/, ''))
    .filter(x => x.length >= 4 && !/^(职责|岗位职责|工作职责|要求|任职要求|岗位要求|职位描述|responsibilities|requirements|qualifications)[：:）)]?$/i.test(x));

export function jdDigest(lead = {}, { max = 5, min = 3, lineMax = JD_LINE_MAX } = {}) {
  const jd = String(lead.jd_text || lead.jd || '');
  const duties = [], requirements = [];
  for (const line of jdLines(jd)) {
    const isReq = REQ.test(line) && !/^负责|^你将/.test(line);
    const bucket = isReq ? requirements : DUTY.test(line) ? duties : null;
    if (!bucket || bucket.length >= max) continue;
    const short = cut(line, lineMax);
    if (!bucket.includes(short)) bucket.push(short);
  }
  // A posting that never separates the two still owes the user its requirements:
  // what the match recorded as a must-have is the honest fallback.
  if (requirements.length < min)
    for (const r of (lead.match?.must_haves || []).map(x => clean(x.req)).filter(Boolean)) {
      if (requirements.length >= max) break;
      const short = cut(r, lineMax);
      if (!requirements.includes(short)) requirements.push(short);
    }
  return { duties, requirements, complete: duties.length >= min && requirements.length >= min };
}

export function jdDigestText(lead = {}, options = {}) {
  const d = jdDigest(lead, options);
  if (!d.duties.length && !d.requirements.length) return `原帖正文未抓取到，${NOT_STATED}职责与要求，已排队回填。`;
  return [
    d.duties.length ? `职责：\n${d.duties.map(x => '· ' + x).join('\n')}` : `职责：${NOT_STATED}`,
    d.requirements.length ? `要求：\n${d.requirements.map(x => '· ' + x).join('\n')}` : `要求：${NOT_STATED}`,
  ].join('\n');
}

// Three requirement keywords, taken from what the JD actually asks for.
const SKILL = /\b(python|typescript|javascript|java|go(?:lang)?|rust|c\+\+|react|vue|node(?:\.js)?|django|fastapi|flask|spring|kubernetes|docker|aws|gcp|azure|postgres(?:ql)?|mysql|redis|kafka|spark|flink|llm|rag|agent|langchain|langgraph|pytorch|tensorflow|transformer|微服务|分布式|高并发|全栈|后端|前端|算法|数据库|大模型|智能体|检索增强|提示词|向量)\b/gi;
export function briefRequirements(l = {}, max = 3) {
  const source = clean(`${l.jd_text || l.jd || ''} ${l.role || ''}`);
  const found = (source.match(SKILL) || []).map(s => s.trim());
  const must = (l.match?.must_haves || []).map(r => clean(r.req)).filter(Boolean);
  // What the match actually tested leads; loose keyword hits fill the rest.
  // `LLM` and `llm` are one requirement, not two, so the dedupe ignores case.
  const seen = new Set(), keywords = [];
  for (const k of [...must.map(m => cut(m, 14)), ...found]) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(k);
    if (keywords.length >= max) break;
  }
  return keywords;
}

// How the user would actually apply, in one phrase.
export function briefEntry(l = {}) {
  const channel = applyChannel(l);
  if (channel === 'email') return l.email ? `邮件投递 ${l.email}` : l.contact_profile_url ? '平台私信（无公开邮箱）' : '真人帖，联系方式待核';
  if (channel === 'portal') {
    const s = portalSession(l);
    return s?.never_auto ? '门户投递，需本人注册账号' : s?.logged_in ? '门户投递，已有登录态可代投' : '门户投递，需先登录';
  }
  return CHANNEL_LABEL[channel] || '官方表单';
}

// The brief. `missing` names the facts the posting never stated, so a caller can
// queue a backfill instead of a card that says nothing.
export function jobBrief(lead = {}, { facts = null } = {}) {
  const l = lead;
  const source = briefSource(l);
  const problem = briefProblem(l);
  const requirements = briefRequirements(l);
  // The fit line leads with the project the user's positioning ranks first for
  // this posting, not whichever project happens to be first in the file.
  let fit = '';
  try { fit = clean(fitLine(l, facts || loadFacts())); } catch { fit = ''; } // 兜底：说不出合不合适就空着，卡片照常显示
  if (!fit) fit = clean((l.match?.reasons || [])[0] || '') || (l.match?.verdict === 'recommend' ? '匹配结论为推荐，未记录具体理由' : '匹配理由未记录');
  const gap = clean(l.match?.biggest_gap || '') || '未记录明确缺口';
  let note = '';
  try { note = learningNote(l); } catch { note = ''; } // 兜底：没有学到的就空着
  const missing = [];
  if (!l.jd_text && !l.jd) missing.push('jd_text');
  if (!l.salary) missing.push('salary');
  const rows = [
    `**来源**：${source.text}`,
    `**岗位**：${clean(l.role) || NOT_STATED} ｜ **地点**：${clean(l.location) || NOT_STATED}（${leadCity(l)}）｜ **薪资**：${clean(l.salary) || NOT_STATED}`,
    `**要解决什么**：${problem || `原帖正文未抓取到，${NOT_STATED}明确职责，已排队回填`}`,
    `**JD 重点**\n${jdDigestText(l)}`,
    // The fit line, and — when the preference table has something to say about
    // this kind of posting — one sentence of what it learned and from what
    // (lib/preferences.mjs). Silent when nothing has been learned yet.
    `**匹配点**：${cut(fit, 70)}${note ? `\n　${note}` : ''}`,
    `**最大缺口**：${cut(gap, 50)}`,
    `**投递方式**：${briefEntry(l)}`,
  ];
  const url = /^https?:\/\//.test(l.url || '') ? l.url : applyUrl(l);
  if (/^https?:\/\//.test(url || '')) rows.push(`**原帖**：${url}`);
  const text = rows.join('\n');
  // The readable length, without the markdown scaffolding.
  const length = text.replace(/\*\*/g, '').length;
  return { number: l.number ?? null, company: clean(l.company) || '待核', role: clean(l.role) || NOT_STATED, human: source.human, rows, text, url: url || null, missing, length, needs_backfill: missing.includes('jd_text') };
}

// The one-line form the 拟投清单 and 真人线索 cards put under each row.
export function briefLine(lead = {}) {
  const b = jobBrief(lead);
  const req = briefRequirements(lead, 3);
  return `${b.company} · ${b.role} · ${leadCity(lead)} · ${briefEntry(lead)}｜要求：${req.length ? req.join('/') : NOT_STATED}｜缺口：${cut(lead.match?.biggest_gap || '未记录', 18)}`;
}

// Leads whose posting body was never captured. The executor fills these in with
// curl / gh before the next round of cards (bin/backfill-jd.mjs).
export function needsBackfill(leads = [], max = 20) {
  return leads
    .filter(l => !l.superseded && !l.legacy && l.match && !l.jd_text && !l.jd && /^https?:\/\//.test(l.url || ''))
    .slice(0, max)
    .map(l => ({ record_id: l.record_id || l.id, number: l.number, company: l.company, url: l.url }));
}

export const briefConfig = () => read('config/concierge.json', {}).brief || {};


// The lead a brief command refers to, by number.
export const leadByNumber = (n, leads = lines('state/leads.ndjson')) => leads.find(l => l.number === Number(n) && !archivedLead(l)) || null;

// ---------------------------------------------------------------------------
// The Base cell form of the brief.
//
// The phone view of the Base is where the user now screens jobs, so the same
// seven facts have to fit one cell: no markdown scaffolding, no link row (原帖
// is its own column), and a length the user reads in a few seconds. Anything the
// posting does not say still reads 未写.

// Pay, from the field the scraper filled or, failing that, from the posting's
// own words. Never a guess: only a literal salary expression counts.
const SALARY_PATTERNS = [
  /\d{1,3}\s*[-–~至到]\s*\d{1,3}\s*[kK](?:\s*[·*]\s*\d{2}薪|\s*\/\s*月)?/,
  /\d{1,3}\s*[-–~至到]\s*\d{1,3}\s*万(?:\s*\/\s*年|年薪)?/,
  /(?:年薪|月薪|薪资|薪酬|待遇)\s*[:：]?\s*[^\n，。;；]{0,4}\d[^\n，。;；]{0,14}/,
  /[¥$]\s?\d[\d,]{2,}\s*(?:[-–~]\s*[¥$]?\d[\d,]{2,})?[^\n，。;；]{0,10}/,
];
// A match runs on into whatever the JD says next, so keep only up to the last
// character that is part of a pay figure.
const tidySalary = (s) => {
  const t = clean(s).replace(/^(?:年薪|月薪|薪资|薪酬|待遇)\s*[:：]?\s*/, '');
  const last = [...t].reduce((acc, ch, i) => (/[0-9kK万元薪月年]/.test(ch) ? i : acc), -1);
  return last < 0 ? '' : t.slice(0, last + 1).trim();
};
export function briefSalary(l = {}) {
  const stated = clean(l.salary || l.salary_range || '');
  if (stated) return stated;
  const jd = clean(l.jd_text || l.jd || '');
  for (const re of SALARY_PATTERNS) {
    const hit = jd.match(re);
    if (hit) {
      const tidy = tidySalary(hit[0]);
      if (/\d/.test(tidy)) return cut(tidy, 24);
    }
  }
  return '';
}

// Who the user would be replying to. A named person is the whole reason a 真人
// lead is worth more than an ATS row, so the name leads; an official page says
// so plainly rather than leaving the column blank.
export function briefPoster(l = {}) {
  const who = clean(l.author || l.contact_name || '');
  const title = clean(l.author_title || '');
  if (who) return title ? `${who}（${title}）` : who;
  if (/真人|内推|HR直发|Boss/.test(String(l.source_type || ''))) return '发帖人未署名';
  return `${clean(l.source) || '公司'}官方页面`;
}

// As much of the posting's own description of the work as the budget allows,
// starting at the first sentence that describes the job rather than the company.
export function briefProblemText(l = {}, budget = 80) {
  const jd = clean(l.jd_text || l.jd || '');
  if (!jd || budget < 8) return null;
  const sentences = jd.split(/(?<=[。！？!?;；\n])|(?<=\.\s)/).map(clean).filter((s) => s.length > 8);
  if (!sentences.length) return cut(jd, budget);
  const first = sentences.findIndex((s) => WORK.test(s));
  let out = '';
  for (const s of sentences.slice(first < 0 ? 0 : first)) {
    if (out.length >= budget) break;
    out = out ? `${out} ${s}` : s;
  }
  return cut(out, budget);
}

// The seven rows, sized to land inside [min, max] readable characters. The two
// summary rows give up length first, then the problem row absorbs whatever is
// left — so a rich JD fills the budget and a thin one stays honest and short.
export function baseBrief(lead = {}, { min = BRIEF_MIN, max = BRIEF_MAX } = {}) {
  const l = lead;
  const requirements = briefRequirements(l, 5);
  const salary = briefSalary(l);
  const rowsFor = (limit, problem) =>
    [
      `来源：${cut(briefSource(l).text, 34)}`,
      `岗位：${cut(clean(l.role) || NOT_STATED, 42)} · ${cut(clean(l.location) || NOT_STATED, 18)}（${leadCity(l)}） · 薪资 ${cut(salary || NOT_STATED, 18)}`,
      `要解决什么：${problem || `原帖正文未抓取到，${NOT_STATED}明确职责，已排队回填`}`,
      `关键要求：${requirements.length ? cut(requirements.join(' · '), 48) : NOT_STATED}`,
      `匹配点：${cut((l.match?.reasons || [])[0] || '匹配理由未记录', limit)}`,
      `最大缺口：${cut(l.match?.biggest_gap || '未记录明确缺口', limit)}`,
      `投递方式：${cut(briefEntry(l), 28)}`,
    ];
  const size = (rows) => rows.join('\n').length;
  // The two summary rows give up length first; whatever is left is the problem
  // row's budget. The first setting that fits wins, so a rich JD fills the cell
  // and a thin one stays short rather than padded.
  const fit = (limit) => {
    const spent = size(rowsFor(limit, 'x'));
    const problem = briefProblemText(l, Math.max(0, max - spent + 1));
    const rows = rowsFor(limit, problem);
    return { rows, ok: size(rows) <= max };
  };
  let attempt = fit(50);
  for (const limit of [40, 32, 24, 16, 12]) {
    if (attempt.ok) break;
    attempt = fit(limit);
  }
  const rows = attempt.rows;
  const text = rows.join('\n');
  return { text, rows, length: text.length, short: text.length < min, requirements, salary, poster: briefPoster(l) };
}
