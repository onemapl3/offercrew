// Turns one lead plus candidate/facts.yaml into the exact values an ATS form
// needs. Everything here is deterministic: the browser step fills what this
// produces and invents nothing of its own.
import YAML from 'yaml';
import { file, lines } from './store.mjs';
import { mailboxOf, contactEmailOf } from './facts.mjs';
import { applyUrl } from './apply-channel.mjs';
import { factsPath } from './facts.mjs';
import { chosenLetter, pickResume, resumeLabel, fileVersion, jobLanguage, fallbackLine, routingSlot } from './resume-choice.mjs';
// 不只能在中国工作、主方向不是软件、或选了子方向的工程师（lib/directions.mjs、lib/work-auth.mjs）：申请表里的签证和薪资
// 按岗位所在的国家如实填。只在中国工作、没选子方向的软件方向（作者本人）走以前的原文，一个字不变。
import { isGeneral, engineeringTracks } from './directions.mjs';
import { chinaOnly, formWorkAuthorization, formSalary, postingInMainland, MAINLAND_CITY_EN } from './work-auth.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import { noteSwallowed } from './swallow.mjs';

// candidate/facts.yaml（或 RADAR_FACTS 指的文件，见 lib/facts.mjs）；缺文件照旧抛错。
export const loadFacts = () => YAML.parse(fs.readFileSync(factsPath(), 'utf8'));

const cjk = (s) => (String(s).match(/[㐀-鿿぀-ヿ]/g) || []).length;
const latin = (s) => (String(s).match(/[A-Za-z0-9][A-Za-z0-9'’./+-]*/g) || []).length;
// Two CJK characters count as one word, the usual convention for a bilingual
// length budget. A letter is measured the same way whichever language it is in.
export const wordCount = (s) => latin(s) + Math.ceil(cjk(s) / 2);

// Letter language follows the posting, not the candidate's preference.
// 同一条规矩也决定投递用中文还是英文那一份（lib/resume-choice.mjs jobLanguage）。
export const jdLanguage = jobLanguage;

// 这次上传哪一份（设计说明 4.4，lib/resume-choice.mjs pickResume）：你在岗位页选的 → 这个岗位的定制版 → 默认投递里同语言的那一版，
// 上传那一版的 PDF（投递前由 lib/resume-versions.mjs preparePick 导好）。那一版还没有能用的 PDF（比如本机没有浏览器）：
// 和以前一样按岗位语言用 resume_routing 的文件，fallback 写明原因；label 说的是真正上传的那个文件。
// { file, doc, version, by:'you'|'reacher', label, pending_tailor, fallback }
export function resumePick(lead, facts = loadFacts()) {
  let pick = null;
  try { pick = pickResume(lead, { lang: jdLanguage(lead) }); } catch (e) { noteSwallowed('application-form.pick', e, { member: 'quill', doing: '挑这次上传哪一份简历', then: '按岗位语言用设置里的文件' }); }
  if (pick?.file) return { file: pick.file, doc: pick.docId, version: pick.vid, by: pick.by, label: pick.label, pending_tailor: !!pick.pending_tailor, fallback: null };
  const routing = facts.resume_routing || {};
  const f = (jdLanguage(lead) === 'zh' ? routing.chinese_pdf || routing.english_pdf : routing.english_pdf || routing.chinese_pdf) || null;
  const known = f ? fileVersion(f) : null;
  const label = f ? resumeLabel(f)?.label || null : null;
  // wanted：本来要用的那一版（lib/auto-apply.mjs 拿 preparePick 给的原因重写 fallback 那一句）。
  return { file: f, doc: known?.doc || null, version: known?.version || null, by: 'reacher', label, pending_tailor: !!pick?.pending_tailor, fallback: pick ? fallbackLine({ label: pick.label, by: pick.by, used: label }) : null, ...(pick ? { wanted: { label: pick.label, by: pick.by } } : {}) };
}
export const resumeFor = (lead, facts = loadFacts()) => resumePick(lead, facts).file;

const firstNumber = (s) => Number(String(s ?? '').replace(/[,，]/g, '').match(/\d{4,}/)?.[0] || 0);
// 新画像：导入简历来的资料、不在中国工作、或换了方向的人（见上）。
const newProfile = (facts) => isGeneral(facts) || !chinaOnly(facts) || engineeringTracks(facts).length > 0;
// 求职信不再由这里拼（2026-09-30，团队计划 E）：Tailor 先读公司调研再写，逐句核对出处，你点「用这封」才算数
// （lib/resume-letters.mjs）。这里只取你选定的那封；没有就留空——申请表要求必填时，投递停下来等你（lib/auto-apply.mjs）。

// 中国主要城市的中英对照：英文表单、或岗位不在中国大陆时，地点类字段（location、current_city）用英文，例如「Shanghai, China」。
// 大陆城市的中英文对照放在 lib/work-auth.mjs（签证那一项也按它认「岗位在大陆」），这里照旧叫 CITY_EN。
export const CITY_EN = MAINLAND_CITY_EN;
const OUTSIDE_MAINLAND = /香港|澳门|台湾|台北|\bHK(?:SAR)?\b|\bHong\b|\bMaca[ou]\b|\bTaiwan\b|\bTaipei\b/i;
// 「上海」「上海市」→「Shanghai, China」；已经是英文的、表里没有的（含港澳台）原样返回。
export function englishCity(city) {
  const s = String(city || '').trim();
  if (!/[\u3400-\u9fff]/.test(s)) return s;
  const en = CITY_EN[s.replace(/(?:特别行政区|市)$/, '')];
  return en ? `${en}, China` : s;
}
// 岗位所在地：mainland 中国大陆 · abroad 大陆以外（含港澳台）· null 没写或只写了远程。
export function postingRegion(location) {
  const s = String(location || '').trim();
  if (!s || /^(?:未标注|未知|不限|待定|remote|远程|anywhere|worldwide)$/i.test(s)) return null;
  if (OUTSIDE_MAINLAND.test(s)) return 'abroad';
  if (/\bChina\b|\bPRC\b|中国|大陆/i.test(s) || Object.entries(CITY_EN).some(([zh, en]) => s.includes(zh) || new RegExp(`\\b${en}\\b`, 'i').test(s))) return 'mainland';
  return 'abroad';
}

// The answer set the form filler is allowed to use. A question this map cannot
// answer is a reason to stop and hand the form back, never to guess.
// resume：这次上传哪一份（resumePick 的结果）；applicationPlan 只算一次、传进来，单独调用时现算。
export function applicationFields(lead, facts = loadFacts(), resume = null) {
  const id = facts.identity || {};
  const letter = chosenLetter(lead) || '';
  const en = String(id.name_en || '').trim().split(/\s+/);
  const salary = firstNumber(facts.compensation?.expected_annual_cny) || firstNumber(facts.compensation?.floor_annual_cny);
  const recordedLeads=lines('state/leads.ndjson'),outbound=lines('state/outbound.ndjson');
  // 「以前投过这家公司吗」：只算同一家公司别的岗位真投出去的（申请表 / 门户提交，或你点过「我已提交」的）。
  // 给招聘方发的邮件、私信不算投递；这一条自己也不算（10-05 #316 网易：拟填里 previously_applied 成了 true）。
  const me=lead.record_id||lead.id;
  const appliedToCompany=recordedLeads.some(l=>(l.record_id||l.id)!==me&&l.company===lead.company&&(l.auto_apply?.status==='submitted'||outbound.some(o=>o.record_id===(l.record_id||l.id)&&(o.channel==='ats_form'||/^portal/.test(o.channel||'')))));
  // 岗位确实在中国大陆（不是远程、没写别的国家）才按「在中国工作」答签证 / 工作许可；说不准留给你填（D9，#482）。
  const chinaLocation=postingInMainland(lead.location||'');
  return {
    first_name: en[0] || '',
    last_name: en.slice(1).join(' ') || '',
    full_name: id.name_en || id.name_zh || '',
    full_name_zh: id.name_zh || '',
    // 申请表上的邮箱：个人资料里的联系邮箱（G4）。和系统收信的邮箱不同时，拟填内容里写明（planRows），对方回信到这个邮箱。
    email: contactEmailOf(facts),
    phone: id.phone_cn || (newProfile(facts) ? id.phone : '') || '',
    // 表上问「所在地 / Location (City/State)」问的是你住哪儿，不是岗位在哪儿（2026-09-30 真实测试：Ashby 的所在地一栏填成了岗位地点）。
    // 「你申请的是哪个办公室 / 地点」这类题才用岗位地点（job_location）；岗位没写地点（未标注）就留空，交给你补。
    location: facts.location?.current_city || '',
    job_location: /^(?:未标注|未知|unknown)?$/i.test(String(lead.location || '').trim()) ? '' : lead.location,
    current_city: facts.location?.current_city || '',
    linkedin: id.linkedin || '',
    website: id.github || '',
    resume_path: (resume || resumePick(lead, facts)).file,
    cover_letter: letter,
    cover_letter_words: letter ? wordCount(letter) : 0,
    // China citizen applying to China-based or China-eligible remote roles.
    // 不只能在中国工作的人按岗位所在国家如实填（lib/work-auth.mjs）：OPT 的人问「将来要不要担保」答「要」。
    work_authorization: formWorkAuthorization(lead, facts) || {
      authorized_in_posting_country: chinaLocation&&facts.work_authorization?.china_mainland==='citizen',
      china_mainland: facts.work_authorization?.china_mainland || null,
      requires_sponsorship: chinaLocation ? false : null,
      note: chinaLocation ? '中国大陆公民，在中国境内合法工作；不需要中国工作签证担保。' : '岗位在哪个国家工作说不准，这一项留给你填',
    },
    salary_expectation: formSalary(lead, facts) || { currency: 'CNY', annual_from: salary, negotiable: true },
    availability: {
      notice_period_days: facts.availability?.notice_period_days ?? null,
      earliest_start: facts.availability?.earliest_start || '',
    },
    // Voluntary EEO / demographic / disability / veteran questions.
    voluntary_disclosure: 'decline',
    // Only the consent a submission genuinely requires.
    data_processing_consent: true,
    referral_source: facts.standard_answers?.referral_source_default || '',
    previously_applied: appliedToCompany?true:(facts.standard_answers?.previously_applied_default??null),
    relatives_at_company: facts.standard_answers?.relatives_at_company??null,
    application_url: applyUrl(lead),
    // 新画像：填表时按它换几处说法（lib/auto-apply.mjs answerFor：没有通知期写最早入职时间、没写美元期望就交给你）。
    ...(newProfile(facts) ? { general: true } : {}),
  };
}

// 拟填内容给人看（岗位页「申请表拟填」、收件箱和指挥台的「看拟填内容」）：中文名字、说人话的值，不露字段代码和 JSON（10-05 #316）。
// 只给人看，填表照旧用 applicationFields 的原值。
const FIELD_LABEL = {
  first_name: '名（英文）', last_name: '姓（英文）', full_name: '姓名', full_name_zh: '中文姓名', email: '邮箱', phone: '电话',
  location: '现居城市', job_location: '申请的工作地点', current_city: '现居城市', linkedin: 'LinkedIn', website: '个人主页',
  cover_letter: '求职信', work_authorization: '工作许可', salary_expectation: '期望薪资', availability: '到岗时间',
  voluntary_disclosure: '自愿披露的个人信息（性别、族裔等）', data_processing_consent: '同意处理个人信息', referral_source: '从哪里得知这个职位',
  previously_applied: '以前投过这家公司', relatives_at_company: '有亲属在这家公司', application_url: '申请入口',
};
const HIDDEN = new Set(['resume_path', 'cover_letter_words', 'general']);
const yes = (v, y = '是', n = '否') => (v === true ? y : v === false ? n : '');
function fieldText(k, v) {
  if (v == null || v === '') return '';
  if (k === 'work_authorization') return v.note || [yes(v.authorized_in_posting_country, '可以在岗位所在国家工作', '不能在岗位所在国家工作'), v.requires_sponsorship === true ? '需要工作签证担保' : v.requires_sponsorship === false ? '不需要工作签证担保' : ''].filter(Boolean).join('；');
  if (k === 'salary_expectation') { const cur = v.currency === 'USD' ? '美元' : '元'; return v.annual_from ? `年薪 ${Number(v.annual_from).toLocaleString('zh-CN')} ${cur}起${v.negotiable ? '，可谈' : ''}` : v.negotiable ? '可谈' : ''; }
  if (k === 'availability') return [v.notice_period_days != null ? `离职通知期 ${v.notice_period_days} 天` : '', v.earliest_start ? `最早 ${v.earliest_start} 入职` : ''].filter(Boolean).join('；');
  if (k === 'voluntary_disclosure') return v === 'decline' ? '不披露' : String(v);
  if (k === 'data_processing_consent') return yes(v, '同意', '不同意');
  if (k === 'relatives_at_company') return yes(v, '有', '没有');
  if (typeof v === 'boolean') return yes(v);
  if (typeof v === 'object') return Object.values(v).filter(x => x != null && x !== '' && typeof x !== 'object').map(String).join('；');
  return String(v);
}
// 申请表上的邮箱和系统收信的邮箱不是同一个：这一行写明用的是哪个、对方回信系统读不到（G4，负责人 10-05）。
export function emailNote(email, facts = loadFacts()) {
  const box = mailboxOf(facts), e = String(email || '').trim();
  return e && box && e.toLowerCase() !== box.toLowerCase() ? `个人资料里的联系邮箱；系统读的是 ${box}，回到这个邮箱的信系统看不到` : null;
}
export function planRows(fields = {}, facts = null) {
  const out = [], seen = new Set();
  for (const [k, v] of Object.entries(fields)) {
    if (HIDDEN.has(k)) continue;
    let value = fieldText(k, v);
    const label = FIELD_LABEL[k] || k;
    if (k === 'email' && value) { let note = null; try { note = emailNote(value, facts || loadFacts()); } catch {} if (note) value = `${value}（${note}）`; } // 兜底：资料读不了就只写邮箱本身
    if (!value || seen.has(`${label}|${value}`)) continue; // location 和 current_city 是同一个值时只列一行
    seen.add(`${label}|${value}`);
    out.push({ key: k, label, value });
  }
  return out;
}

// applicationPlan 的原因码给人看时的说法：能照着做的一句话；认不出的只说没准备好（原码由调用方记进运行日志）。
const PLAN_PROBLEM = {
  resume_file_missing: '找不到要上传的简历文件，去「设置 → 检查清单」设一下投递用的简历',
  application_url_missing: '没有可用的申请链接，系统会先去核实入口',
  contact_facts_missing: '个人资料里缺邮箱或电话，去「设置 → 检查清单」补上',
};
export const planProblem = code => PLAN_PROBLEM[String(code || '').trim()] || '申请材料还没准备好，原因记在运行日志里';
export function applicationPlan(lead, facts = loadFacts()) {
  // 这次上传的是哪一份：只算一次；不进 fields（批准指纹 planFingerprint 不变），跟着计划走到终审记录（lib/auto-apply.mjs）。
  const chosen = resumePick(lead, facts), fields = applicationFields(lead, facts, chosen);
  const resume = fields.resume_path;
  if (!resume || !fs.existsSync(file(resume))) throw Error('resume_file_missing');
  if (!/^https?:\/\//.test(fields.application_url)) throw Error('application_url_missing');
  if (!fields.email || !fields.phone) throw Error('contact_facts_missing');
  return {
    record_id: lead.record_id || lead.id,
    number: lead.number,
    company: lead.company,
    role: lead.role,
    location: lead.location,
    url: fields.application_url,
    resume_absolute_path: file(resume),
    resume_sha256: createHash('sha256').update(fs.readFileSync(file(resume))).digest('hex'),
    // slot：这种语言的投递简历（resume_routing 那一栏）。「投 N」的批准按它认，不按文件名（lib/submission-policy.mjs approvalKey）。
    resume: { ...chosen, slot: routingSlot(jdLanguage(lead)) },
    // 这一栏现在指着的文件：只给批准核对用（lib/submission-policy.mjs approvalKeys）——2026-10-02 以前的批准按文件名记，记的就是它。
    resume_routed: facts.resume_routing?.[routingSlot(jdLanguage(lead))] || null,
    fields,
  };
}
