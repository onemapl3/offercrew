// Auto-submission of account-free ATS forms.
//
// The browser step is deliberately thin: it extracts the form controls as JSON,
// this module decides every value from candidate/facts.yaml, and the browser
// step writes exactly those values back. Nothing is improvised in the page, and
// a required control this module cannot answer aborts the submission instead of
// guessing an answer on the user's behalf.
import { hash, today, read } from './store.mjs';
import { computerUseConfig, runComputerUse } from './computer-use.mjs';
import { leadKey } from './journey.mjs';
import { setApply } from './lead-state.mjs';
import { applicationPlan, englishCity, postingRegion } from './application-form.mjs';
import { fallbackLine } from './resume-choice.mjs';
import { applyChannel, portalSession } from './apply-channel.mjs';
import {loadSubmissionPolicy,loadSubmissionApprovals,submissionPolicyReason,priorSubmission,planFingerprint} from './submission-policy.mjs';
import { loadBook, lookup } from './answer-book.mjs';
import { cleanFieldLabel, fieldQuestion, NEVER_COLLECT } from './needs.mjs';
import { event } from './events.mjs';
import { applyWords } from './apply-words.mjs';
import { oneClickPortal } from './one-click-apply.mjs';
import { judgeLanding } from './landing.mjs';
import { applyPostingCheck } from './posting-check.mjs';

// Label patterns are ordered: the first match wins, so narrow labels such as
// "first name" are tested before the generic "name".
export const FIELD_MATCHERS = [
  [/resum|\bcv\b|简历/i, 'resume_path'],
  [/cover\s*letter|求职信|附信|motivation letter/i, 'cover_letter'],
  [/first\s*name|given\s*name|名字/i, 'first_name'],
  [/last\s*name|family\s*name|surname|姓氏/i, 'last_name'],
  [/preferred\s*name|full\s*name|your\s*name|姓名|名字/i, 'full_name'],
  [/e-?mail|邮箱|电子邮件/i, 'email'],
  [/phone|mobile|telephone|\btel\b|电话|手机/i, 'phone'],
  [/linkedin|领英/i, 'linkedin'],
  [/github|portfolio|personal\s*(?:site|website)|website|个人主页|作品集/i, 'website'],
  // 「Do you have legal authorization to work in this country?」这种反着说的也算（09-30 真实测试：认不出来，落进答案簿，存成了一条不分国家的「No」）。
  [/sponsor|visa\b|work\s*(?:authoriz|authoris|permit|eligib)|legally\s*(?:allowed|authorized)|authori[sz](?:ation|ed)\s+to\s+work|legal\s+authori[sz]ation|right\s+to\s+work|eligib(?:le|ility)\s+to\s+work|工作许可|工作签证|工作资格/i, 'work_authorization'],
  [/salary|compensation|expected\s*pay|pay\s*expectation|期望薪|薪资期望|薪酬期望/i, 'salary_expectation'],
  [/start\s*date|notice\s*period|availabilit|when\s*can\s*you\s*start|available\s*to\s*start|when\s*(?:are|would|will)\s*you\s*(?:be\s*)?available|到岗|入职时间|离职通知/i, 'availability'],
  [/gender|\brace\b|ethnic|veteran|disabilit|sexual orientation|pronoun|性别|民族|残疾|退伍/i, 'voluntary_disclosure'],
  [/consent|privacy|gdpr|data\s*(?:processing|protection)|同意|隐私|个人信息/i, 'data_processing_consent'],
  [/how\s*did\s*you\s*(?:hear|find)|referr|source|了解到|来源/i, 'referral_source'],
  [/previously\s*(?:applied|worked)|former\s*employee|曾(?:经)?申请|前员工/i, 'previously_applied'],
  [/relative|family\s*member|friend\s*(?:at|who works)|亲属|家属/i, 'relatives_at_company'],
  // 国家 / 国籍不能用城市代答；有明确的历史回答时仍可从答案簿读取。
  [/\bcountr(?:y|ies)\b|\bnationality\b|\bcitizenship\b|国籍|国家/i, null],
  [/current.*(?:location|city)|currently.*based|现居|目前.*(?:城市|所在地)|居住地/i, 'current_city'],
  [/(?:which|what)\s+(?:office|location|site)s?\b[^?]*(?:apply|interest|prefer|consider)|(?:office|location|site)s?\s+(?:you(?:'re|\s+are)\s+)?(?:applying|interested)|preferred\s+(?:office|work\s*location)|申请(?:的)?(?:哪个|哪一个)?(?:办公室|工作地点|城市)/i, 'job_location'],
  [/location|city|based|地点|城市|所在地/i, 'location'],
];

// 只写「Name」的题（Ashby 的 _systemfield_name）就是全名；「Name Pronunciation」这类不算。先去掉占位字和内部编号再认。
export const fieldForLabel = (label) => /^(?:name|legal name|姓名)$/i.test(cleanFieldLabel(label)) ? 'full_name' : FIELD_MATCHERS.find(([re]) => re.test(String(label || '')))?.[1] || null;

// 自动提交开关（config/pipeline.json auto_submit，默认关，2026-09-30 负责人拍板）：关着的时候系统只预填、绝不点提交，
// 你在页面上检查后自己提交。只有写成 true 才会走「终审确认 → 系统点提交」。
export const autoSubmitEnabled = () => read('config/pipeline.json', {}).auto_submit === true;

// 表单是不是中文的：一半以上的题目带汉字才算。
const HAN = /[\u3400-\u9fff]/;
export function formLanguage(controls = []) {
  const labels = controls.map((c) => cleanFieldLabel(c.label || '')).filter(Boolean);
  return labels.length && labels.filter((l) => HAN.test(l)).length * 2 >= labels.length ? 'zh' : 'en';
}
// 地点类的值（location、current_city）：英文表单、或岗位不在中国大陆，用英文城市名（「上海」→「Shanghai, China」）；中文表单照旧。
export function localizeFields(fields, controls = [], posting = '') {
  if (formLanguage(controls) === 'zh' && postingRegion(posting) !== 'abroad') return fields;
  return { ...fields, current_city: englishCity(fields.current_city), location: englishCity(fields.location) };
}
// 自动补全框：role=combobox、aria-autocomplete，或者地点类的输入框（Lever 的 location-input 打字后才出下拉）。
const comboboxOf = (c) => String(c.role || '').toLowerCase() === 'combobox' || /^(?:list|both)$/i.test(String(c.autocomplete || ''));
const autocompleteOf = (c, entry) => entry.action === 'fill' && (comboboxOf(c) || ['location', 'current_city'].includes(entry.key));

// 预填以后还空着的必填项：计划里标了必填、读回是空的（「（没找到控件）」、没有文件名、没勾上也算）；
// 页面整页扫出来的空必填项（driver 的 missing，控件可能根本不在计划里）；以及系统认不出、没去填的必填项。按题目去重，返回原标签。
export function prefillGaps({ entries = [], readback = [], scanned = [], unanswered = [] } = {}) {
  const out = [];
  const push = (label) => { const c = cleanFieldLabel(label); if (c && !out.some((x) => cleanFieldLabel(x) === c)) out.push(String(label)); };
  for (const l of unanswered) push(l);
  entries.forEach((e, i) => {
    if (!e.required) return;
    const r = readback[i]?.key === e.key ? readback[i] : null, v = String(r?.value ?? '').trim();
    if (!v || v === '（没找到控件）' || (e.action === 'check' && v === '未勾选')) push(e.label);
  });
  for (const l of Array.isArray(scanned) ? scanned : []) push(l);
  return out;
}
// 预填时简历已经传到对方页面上了吗（09-30 真实测试 #8：Lever 一选文件就上传，没提交对方页面上也有了）：
// 读回里文件框有文件名才算；沙盒演示（dry）没打开真的页面，不算。
export const resumeOnPage = (pre, entries = []) => !pre?.dry && entries.some((e, i) => { const r = pre?.readback?.[i]; const v = String(r?.value ?? '').trim(); return e.action === 'files' && r?.key === e.key && !!v && v !== '（没找到控件）'; });
const readbackFilled = (readback = []) => readback.filter((r) => { const v = String(r?.value ?? '').trim(); return v && v !== '（没找到控件）' && v !== '未勾选'; }).length;

const DECLINE = /prefer\s*not|decline|don'?t\s*wish|do\s*not\s*wish|not\s*(?:wish\s*to\s*)?(?:answer|disclose)|self-?identify.*not|不愿|不方便|拒绝回答|不透露/i;
// 选项开头这个词后面不能紧跟别的字母或汉字：\b 在两个汉字之间从不成立，中文「是 / 否」以前一个都认不出来；
// 换成 Unicode 的「后面不是字母数字」，英文照旧，「是否」「是的」「否则」也不会被当成是 / 否。
const YES = /^\s*(?:yes|y|true|是|对|同意|接受|我同意)(?![\p{L}\p{N}_])/iu;
const NO = /^\s*(?:no|n|false|否|不是|不需要|不要求)(?![\p{L}\p{N}_])/iu;
const pickOption = (options = [], ...tests) => {
  for (const test of tests) {
    const hit = options.find((o) => test.test(String(o)));
    if (hit !== undefined) return hit;
  }
  return null;
};

const money = (s) => (s.annual_from ? `${s.currency} ${s.annual_from.toLocaleString('en-US')}` : 'Negotiable');

// One control plus the resolved facts produce one concrete instruction, or null
// when this system has no honest answer for it.
export function answerFor(control, fields) {
  const key = fieldForLabel(control.label ?? control.name ?? control.id);
  if (!key) return null;
  const type = String(control.type || control.tag || '').toLowerCase();
  const options = control.options || [];
  const label = String(control.label || '');
  const choose = (value) => (value == null ? null : { key, selector: control.selector, action: 'select', value });
  const click = (value) =>
    value == null ? null : { key, selector: control.selector, action: 'choose', value, option_selector: control.option_selectors?.[options.indexOf(value)] || control.selector };
  const chooser = options.length ? (type === 'radio' ? click : choose) : null;

  if (key === 'resume_path') return { key, selector: control.selector, action: 'files', value: fields.resume_path };
  if (key === 'voluntary_disclosure')
    return chooser ? chooser(pickOption(options, DECLINE)) : { key, selector: control.selector, action: 'skip', value: null };
  // 隐私、数据处理、人口统计这类同意，不管哪种模式（只预填、自动提交）都不替你勾、不替你选「同意」，留给你自己
  // （负责人 09-30 21:4x）。以前必填的隐私同意会代勾，终审里写「将代你勾选：…」。
  if (key === 'data_processing_consent') return null;
  if (key === 'work_authorization') {
    // 不只能在中国工作的人（lib/work-auth.mjs formWorkAuthorization，带 us 这一项）：按岗位所在国家如实答。
    // 只答两种问法，而且只答是 / 否的选择题：「你现在或将来是否需要签证担保？」「你是否有权在（岗位所在国）工作？」。
    //   - 反着问的（「无需担保就能工作吗」「我确认不需要担保」）、写成勾选声明的、问身份是什么的自由填空：交给你；
    //   - 问的是别的国家（岗位在美国却问中国 / 英国，或反过来）：交给你；
    //   - 「现在或将来」「未来」「以后」「at any point」都算将来；只问「现在」的按现在答。拿 OPT 的人：将来要担保，现在不用。
    if ('us' in (fields.work_authorization || {})) {
      const wa = fields.work_authorization;
      const other = wa.country === 'us' ? /\b(?:United Kingdom|UK|Canada|Australia|EU|European Union|China|PRC|Hong Kong|Singapore)\b|英国|加拿大|澳大利亚|中国|香港|新加坡/i : /\b(?:United States|USA|US|United Kingdom|UK|Canada|Australia|EU|Hong Kong|Singapore)\b|美国|英国|加拿大|澳大利亚|香港|新加坡/;
      if (other.test(label)) return null;
      if (/without (?:the need for |requiring |needing |any )?(?:current or future |future )?(?:visa |employment |immigration )?sponsor|do(?:es)? not (?:need|require)|don'?t (?:need|require)|not (?:need|require)|no need|无需|不需要|不用/i.test(label)) return null;
      if (type === 'checkbox' || !chooser) return null;
      const sponsorQ = /sponsor|担保|签证|\bvisa\b/i.test(label) && /require|need|需要|要求|will you|do you|是否/i.test(label);
      const authQ = !sponsorQ && /authori[sz]|eligible|legally (?:allowed|able|entitled)|right to work|有权|合法|工作许可|工作资格/i.test(label);
      if (!sponsorQ && !authQ) return null;
      const future = /future|later|at any (?:point|time)|\bever\b|down the road|going forward|将来|未来|今后|日后|以后/i.test(label);
      const onlyNow = sponsorQ && !future && /\bnow\b|current|at this time|today|目前|现在|当前/i.test(label);
      const yes = sponsorQ ? (onlyNow ? wa.requires_sponsorship_now : wa.requires_sponsorship) : wa.authorized_in_posting_country;
      if (yes == null) return null;
      // YES / NO 认得「是 / 否」；「需要 / 有」「不需要 / 没有」这类说法再单独认一次。
      return chooser(pickOption(options, yes ? YES : NO, yes ? /^\s*(?:是|需要|有)/ : /^\s*(?:否|不需要|没有)/));
    }
    if(!fields.work_authorization.authorized_in_posting_country||/\b(?:US|USA|United States|United Kingdom|UK|Canada|Australia)\b|美国|英国|加拿大|澳大利亚/i.test(label))return null;
    // 「Do you need a work visa?」问需求，不是问工作许可。旧画像同样按明确的担保事实回答；
    // 持有什么签证、反向问法或未知需求都留给本人。
    if (/\bvisa\b/i.test(label) && !/sponsor/i.test(label)) {
      if (!chooser || type === 'checkbox' || !/^(?:do|will|would)\s+you\b.*\b(?:need|require)\b/i.test(label.trim()) || /\b(?:not|without|no)\b|don'?t|won'?t/i.test(label)) return null;
      const needs = fields.work_authorization.requires_sponsorship;
      return typeof needs === 'boolean' ? chooser(pickOption(options, needs ? YES : NO)) : null;
    }
    // Polarity comes from the question: sponsorship is not needed, authorization is held.
    const wantsYes = !/sponsor|担保|签证/i.test(label);
    if (type === 'checkbox') return { key, selector: control.selector, action: 'check', value: wantsYes };
    if (chooser) return chooser(pickOption(options, wantsYes ? YES : NO, wantsYes ? /authoriz|eligible|可以|合法/i : /not\s*require|无需|不需要/i));
    return { key, selector: control.selector, action: 'fill', value: fields.work_authorization.note };
  }
  if (key === 'previously_applied' || key === 'relatives_at_company') {
    if(/previously\s*worked|former\s*employee|前员工|曾.*工作|friend|this (?:role|position)|本岗位|这个职位/i.test(label))return null;
    const value=fields[key];if(typeof value!=='boolean')return null;
    if (type === 'checkbox') return { key, selector: control.selector, action: 'check', value };
    return chooser ? chooser(pickOption(options, value?YES:NO)) : { key, selector: control.selector, action: 'fill', value: value?'Yes':'No' };
  }
  if (key === 'salary_expectation') {
    // 美元期望（美国的岗位，lib/work-auth.mjs formSalary）：写着 USD 的问题照答，写着人民币的交给你。
    if(fields.salary_expectation.currency==='USD'?/current|previous|现薪|当前|目前|上份|月|monthly|per month|hour|时薪|EUR|GBP|RMB|CNY|人民币|欧元|英镑|万元/i.test(label):/current|previous|现薪|当前|目前|上份|月|monthly|per month|hour|时薪|USD|EUR|GBP|美元|欧元|英镑|万元/i.test(label))return null;
    if(type==='number'&&!/annual|year|年/i.test(label))return null;
    // 通用画像没写期望（annual_from 是 0）：不替你挑一个区间，也不写「Negotiable per year」，交给你。
    if (fields.general && !(Number(fields.salary_expectation.annual_from) > 0)) return null;
    const value = /^number$/.test(type) ? String(fields.salary_expectation.annual_from || '') : `${money(fields.salary_expectation)} per year, negotiable`;
    return chooser ? chooser(pickOption(options, /negotiab|面议/i, new RegExp(String(fields.salary_expectation.annual_from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))) : { key, selector: control.selector, action: 'fill', value };
  }
  if (key === 'availability') {
    if(type==='date'||type==='datetime-local')return null;
    // 应届生没有通知期：写最早入职时间，不编一个「30 天」（通用画像的 fields 带 general，软件方向照旧）。
    const value = fields.general && fields.availability.notice_period_days == null ? (fields.availability.earliest_start ? `Available from ${fields.availability.earliest_start}` : 'Negotiable') : `${fields.availability.notice_period_days ?? 30} days after offer (${fields.availability.earliest_start || 'negotiable'})`;
    // 下拉框只挑「可商量」；「立即到岗」只在你没写最早入职时间、也不是还没毕业时才会被选——这里一律不挑，交给你。
    if (fields.general && fields.availability.notice_period_days == null) return chooser ? chooser(pickOption(options, /negotiab|面议|flexible/i)) : { key, selector: control.selector, action: 'fill', value };
    return chooser ? chooser(pickOption(options, /30|1 month|一个月/i, /negotiab|面议/i)) : { key, selector: control.selector, action: 'fill', value };
  }
  if (key === 'referral_source')
    return chooser ? chooser(pickOption(options, /career|company (?:site|website)|官网/i, /other|其他/i)) : { key, selector: control.selector, action: 'fill', value: fields.referral_source };
  const plain = key==='full_name'&&/中文|姓名/.test(label)?fields.full_name_zh:fields[key];
  if (typeof plain !== 'string' || !plain) return null;
  return chooser ? chooser(pickOption(options, new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))) : { key, selector: control.selector, action: 'fill', value: plain };
}

// Every control the page reports, mapped. Required controls left without an
// answer are returned so the caller can abort rather than submit a half-truth.
// 个人资料里没有的必填项，再查答案簿（lib/answer-book.mjs：你在收件箱答过一次的问题）。
function fromBook(control, book) {
  const value = lookup(book, control.label || control.name || control.id || '');
  if (value == null) return null;
  const type = String(control.type || control.tag || '').toLowerCase(), options = control.options || [];
  if (options.length) {
    const norm = s => String(s).trim().toLowerCase();
    const label = control.label || control.name || control.id || '';
    // 旧补信息表是文本框；用户确认的「中国」遇到英文国家选择题仍是同一个答案。
    // 只换明确国籍/国家题中的同义值，绝不据此回答签证或工作许可。
    const china = /^(?:中国|中华人民共和国|china|prc|people'?s republic of china)$/i;
    const equivalent = o => /country|nationality|citizenship|国家|国籍/i.test(label) && china.test(String(value).trim()) && china.test(String(o).trim());
    const hit = options.find(o => norm(o) === norm(value)) || options.find(equivalent);
    if (!hit) return null;
    return type === 'radio'
      ? { key: 'form_answer', selector: control.selector, action: 'choose', value: hit, option_selector: control.option_selectors?.[options.indexOf(hit)] || control.selector }
      : { key: 'form_answer', selector: control.selector, action: 'select', value: hit };
  }
  if (['checkbox', 'file'].includes(type)) return null;
  return { key: 'form_answer', selector: control.selector, action: 'fill', value };
}
// 求职信是针对这个岗位写的：只用你在「简历 → 求职信」里选定的那封（fields.cover_letter，lib/resume-letters.mjs），
// 不查答案簿（别的岗位的信不能拿来用）。必填而你还没选：cover_letter_needed，投递停下来等你。
// consents：必填的同意框（隐私、数据处理……）。不管哪种模式都不替你勾，也不从答案簿里找答案、不在收件箱问；
// 开着自动提交时有它，这一份也停在提交前交给你（09-30 21:4x）。
export function planEntries(controls = [], fields, { book = {}, posting = '' } = {}) {
  const entries = [], unanswered = [], consents = [];
  let cover_letter_needed = false, letter_label = null;
  const local = localizeFields(fields, controls, posting);
  for (const c of controls) {
    if (c.hidden || /^(?:submit|button|reset|image)$/i.test(String(c.type || ''))) continue;
    if (fieldForLabel(c.label ?? c.name ?? c.id) === 'data_processing_consent') { if (c.required) consents.push(c.label || c.name || c.id || c.selector); continue; }
    const letter = fieldForLabel(c.label ?? c.name ?? c.id) === 'cover_letter';
    const entry = answerFor(c, local) || (letter ? null : fromBook(c, book));
    if (entry && entry.action !== 'skip' && entry.value !== null && entry.value !== undefined)
      entries.push({ ...entry, label: c.label || c.name || c.id || '', ...(c.required ? { required: true } : {}), ...(autocompleteOf(c, entry) ? { autocomplete: true, ...(comboboxOf(c) ? { combobox: true } : {}) } : {}) });
    else if (c.required) { if (letter) { cover_letter_needed = true; letter_label = c.label || c.name || c.id || 'Cover letter'; } else unanswered.push(c.label || c.name || c.id || c.selector); }
  }
  return { entries, unanswered, consents, cover_letter_needed, ...(letter_label ? { letter_label } : {}) };
}

export const evidenceDir = (number, date = today()) => `runs/${date}/auto-apply/${number}`;

// 用哪个浏览器驱动投递：专用 Chrome 上的脚本驱动（lib/chrome-apply.mjs）；config/pipeline.json auto_apply_driver 写 "builtin"
// 就用内置的 playwright 驱动（只做无账号的官方表单）。旧配置里的 "ego" 当作专用 Chrome。
export const pickApplyDriver = ({ mode = 'auto' } = {}) => ['builtin', 'playwright'].includes(mode) ? 'builtin' : 'chrome';

// A recorded session is a hint, not a fact. The live page decides: a redirect to
// a login path, a password field, or a sign-in-to-apply notice means the session
// is gone and the form goes back to the user this round.
export function loginWallReason(inspected = {}) {
  if (/\/(?:login|signin|sign-?in|sso|passport|account\/login|user\/login)\b/i.test(String(inspected.url || ''))) return 'redirected_to_login';
  if ((inspected.controls || []).some((c) => String(c.type || '').toLowerCase() === 'password')) return 'login_form_present';
  // Eightfold portals (apply.careers.microsoft.com …) render a sign-in modal
  // instead of the form: "Select a method below to Sign in … Sign in using
  // Microsoft / LinkedIn / Facebook … First time here? Create an account".
  // A bare "Sign in" header link on a logged-in page must not match.
  if (/请先登录|立即登录|登录后(?:才能|再)?(?:投递|申请)|扫码登录|sign in to apply|log ?in to apply|please sign in|select a method below to sign in|sign in (?:using|with) (?:microsoft|linkedin|google|facebook|apple)\b|first time here\?\s*create an account|create an account (?:to|before you) (?:apply|continue)/i.test(String(inspected.text || '')))
    return 'login_required_notice';
  return null;
}

// 页面上要人来做的一步：验证码 / 人机验证（driver 在页面里看到的 challenge，或页面文字），以及无账号表单上的硬登录墙
// （跳到登录页、出现密码框；文字里的 "Sign in with LinkedIn" 不算）。门户的登录墙仍走 needs_login（账号、登录巡检）。
const CHALLENGE_TEXT = /i'?m not a robot|verify (?:that )?you(?:'re| are) (?:a )?human|complete the (?:captcha|security check)|请完成(?:安全)?验证|人机验证|拖动滑块|滑动验证|请输入(?:图形)?验证码|安全验证/i;
export function humanStepReason(inspected = {}, channel = null) {
  if (inspected?.challenge || CHALLENGE_TEXT.test(String(inspected?.text || ''))) return { code: 'captcha_required', reason: inspected?.challenge || 'captcha_text' };
  if (channel !== 'portal') { const wall = loginWallReason(inspected); if (wall === 'redirected_to_login' || wall === 'login_form_present') return { code: 'login_required', reason: wall }; }
  return null;
}

const CONFIRMED = /thank you for (?:applying|your application)|application (?:received|submitted|complete)|we(?:'ve| have) received (?:your|the) application|submission received|successfully submitted|提交成功|已收到你的申请|申请已提交/i;
export const confirmsSubmission = text => !/not (?:been )?submitted|unable to submit|submission failed|提交失败|尚未提交|未(?:成功)?提交/i.test(String(text||''))&&CONFIRMED.test(String(text||''));

// The orchestration. `driver` performs the two browser rounds; tests pass a
// fixture and no browser is opened.
// 终审（2026-09-28 规则：系统填表可能填错，最后一遍要人看过才提交）：driver 有 prefill 时，批准后
// 第一次只填不交——填好、截图、读回字段，停在提交前（awaiting_final_review），由收件箱给你看；
// 你点「确认提交」记下 final_approved_at 和这一版材料的指纹，下一次才真正提交。材料变了就再给你看一遍。
// 终审一直开着（2026-09-30 拍板）：config 里写 final_review=false 也不算数；只有测试能显式传 finalReview:false。
export const finalApproved = (lead, fingerprint) => !!lead.auto_apply?.final_approved_at && !!fingerprint && lead.auto_apply?.final_plan_fingerprint === fingerprint;
// What the form will actually receive (field, how, value), independent of selectors and generated ids. The plan
// fingerprint covers the posting, the facts and the résumé; the page can change under a confirmation too (a new
// required question, an answer-book value), so the confirmation also has to match the entries the user was shown.
// 终审表里每一行写页面上的问题（「出生年月」「Resume/CV」），不写内部键（form_answer、resume_path）：读回和填写是同一顺序。
const shownFields = (readback = [], entries = []) => readback.map((f, i) => {
  const e = entries[i]?.key === f.key ? entries[i] : null;
  return { ...f, key: e ? fieldQuestion(e.label) || f.key : f.key };
});
export const entriesFingerprint = (entries = []) => hash(entries.map(e => JSON.stringify([e.key, e.action, e.value == null ? null : String(e.value)])).sort());
// ── 这次上传哪一份简历（设计说明 4.4）和投递留底 ─────────────────────────────────────
// 填表之前：pickResume 选中的那一版备好 PDF（lib/resume-versions.mjs preparePick；导不出就照旧用 resume_routing，原因记下来）。
const prepareResumeDefault = async lead => (await import('./resume-versions.mjs')).preparePick(lead);
const snapshotDefault = async args => (await import('./resume-versions.mjs')).snapshotResume(args);
// 写终审（或预填）记录时定下来：resume_pick 记这次上传的是哪一版（终审信照它写，不再另算），snapshot 是留底
// （runs/<日期>/auto-apply/<编号>/resume-snapshot.pdf + .txt）。留底没做成只记一句，不拦投递。Reacher 在运行日志里说一句用的是哪一份。
async function lockResume({ lead, plan, dir, now, snapshot }) {
  const r = plan.resume || {}, n = lead.number ?? '—', rid = leadKey(lead);
  const resume_pick = { doc: r.doc || null, version: r.version || null, by: r.by === 'you' ? 'you' : 'reacher', label: r.label || null, ...(r.pending_tailor ? { pending_tailor: true } : {}), ...(r.fallback ? { fallback: String(r.fallback).slice(0, 200) } : {}) };
  let snap = null;
  try { snap = await snapshot({ plan, dir, pick: resume_pick, now }); }
  catch (e) {
    const text = `#${n} 投递留底没做成（${String(e?.message || e).slice(0, 120)}），投递照常进行`;
    try { event('quill', 'auto-apply', 'fail', text, { text, lead_id: rid }); } catch { /* 兜底：运行日志写不进去（磁盘满）不挡投递，留底没做成已经写在 text 里给调用方 */ }
  }
  const said = resume_pick.fallback ? `#${n} ${resume_pick.fallback}。` : `#${n} 投递时用${resume_pick.label || '设置里的投递文件'}${resume_pick.by === 'you' ? '（你选的）' : ''}。`;
  try { event('quill', 'auto-apply', 'ok', said, { text: said, lead_id: rid, refs: snap ? [{ file: snap.pdf }] : [] }); } catch { /* 兜底：只是运行日志少一行用了哪份简历，返回值里照样带着 */ }
  return { resume_pick, ...(snap ? { snapshot: snap } : {}) };
}
export async function runAutoApply({ leads = [], outbound = [], actions = [], facts, driver, now = Date.now(), limit = 6, date = today(), save = () => {}, saveEvidence = () => {}, policy=loadSubmissionPolicy(), approvals=loadSubmissionApprovals(), computerUse=runComputerUse, finalReview = true, book = loadBook(), autoSubmit = autoSubmitEnabled(), prepareResume = prepareResumeDefault, snapshot = snapshotDefault } = {}) {
  const at = new Date(now).toISOString();
  const submitted = [], failed = [], needs_login = [], awaiting_review=[], skipped=[], uncertain=[], awaiting_final=[], needs_info=[], prepared=[];
  for (const a of actions.filter((x) => x.kind === 'auto_apply').slice(0, limit)) {
    const lead = leads.find((l) => leadKey(l) === a.record_id);
    if (!lead) continue;
    // Never twice, whatever the queue says.
    if (priorSubmission(lead,a.url||lead.application_url||lead.url,outbound,leads)) continue;
    if(lead.auto_apply?.status === 'prepared_for_user') { skipped.push({record_id:a.record_id,reason:'chrome_handoff_pending'}); continue; }
    if(['submitting','uncertain'].includes(lead.auto_apply?.status)){uncertain.push({record_id:a.record_id,number:lead.number,reason:'reconcile_before_retry'});continue;}
    // 自动提交关着：停在终审的老记录不再往下走（确认过也不提交），等你在页面上自己提交。
    if(!autoSubmit && lead.auto_apply?.status === 'awaiting_final_review'){ skipped.push({record_id:a.record_id,number:lead.number,reason:'auto_submit_off'}); continue; }
    if(lead.auto_apply?.status === 'awaiting_final_review' && !lead.auto_apply?.final_approved_at){ skipped.push({record_id:a.record_id,number:lead.number,reason:'final_review_pending'}); continue; }
    if(lead.auto_apply?.status === 'waiting_user'){ skipped.push({record_id:a.record_id,number:lead.number,reason:'waiting_for_user'}); continue; }
    const attempts = Number(lead.auto_apply?.attempts || 0) + 1;
    const dir = evidenceDir(lead.number || String(a.record_id).slice(-6), date);
    const fail = (error, stop = null) => {
      setApply(lead, { ...lead.auto_apply,status: 'failed', error: String(error).slice(0, 220), attempts, at, evidence: dir, ...(stop ? { stop } : {}) }, { at, source: 'auto-apply', note: 'failed' });
      failed.push({ record_id: a.record_id, number: lead.number, company: lead.company, error: lead.auto_apply.error, attempts });
      save();
    };
    // 先按现在的计划看规矩（批准按岗位、入口和投递简历那一栏认，不看文件名）：挡下的岗位不为它导 PDF。
    // 放行了再备好这次要上传的那一版（preparePick），按备好以后的计划填表。
    let plan, prep = null;
    // 停下来的证据（线 P，10-04）：那一页的截图、地址、停在哪一步、原始的码。存在本机数据目录（<dir>/stop.json、stopped.png，
    // 截图里有个人信息，只在本机），挂到线索上（auto_apply.stop），卡片和收件箱的「详情与证据」照它列。
    // 页面没打开过（材料不全、这个驱动不接）就只有地址；浏览器本身没跑起来的不再去截。
    let page = null, step = '准备材料';
    const stopAt = async (code, { url = null } = {}) => {
      const raw = String(code || ''), w = applyWords(raw);
      let snap = null;
      if (page && typeof driver.snap === 'function' && !/^(?:ego_browser_failed|builtin_browser_missing)/.test(raw)) { try { snap = await driver.snap({ plan, dir, space: page.space }); } catch {} } // 兜底：截不到图照样记下地址和原因，停下这件事本身不能因为截图失败而丢
      const stop = { step: w.step || step, code: raw.slice(0, 220), url: snap?.url || url || page?.url || plan?.url || lead.application_url || lead.url || null, screenshot: snap?.screenshot || null, at };
      try { saveEvidence(`${dir}/stop.json`, stop); } catch {} // 兜底：证据文件写不下，记录照样挂在线索上（auto_apply.stop）
      return stop;
    };
    try { plan = applicationPlan(lead, facts); } catch (e) { if (e.message !== 'resume_file_missing') { fail(e.message, await stopAt(e.message)); continue; } }
    const early = plan ? submissionPolicyReason(lead, plan, policy, approvals) : null;
    if (!early) {
      try { prep = await prepareResume(lead); } catch (e) { prep = { reason: `导出没成功：${String(e?.message || e).slice(0, 160)}` }; }
      try {
        plan = applicationPlan(lead, facts);
        if (prep?.reason && plan.resume?.wanted) plan.resume.fallback = fallbackLine({ ...plan.resume.wanted, why: prep.reason, used: plan.resume.label });
      } catch (e) {
        fail(e.message, await stopAt(e.message));
        continue;
      }
    }
    const blocked=early||submissionPolicyReason(lead,plan,policy,approvals);
    if(blocked){
      const item={record_id:a.record_id,number:lead.number,company:lead.company,role:lead.role,url:plan.url,reason:blocked,plan_fingerprint:planFingerprint(plan)};
      (blocked==='batch_review_required'||blocked==='approval_stale'?awaiting_review:skipped).push(item);
      if(blocked==='batch_review_required'||blocked==='approval_stale'){
        saveEvidence(`${dir}/review-plan.json`,plan);
        // The approval fields stay on the lead as evidence; `approval_stale`
        // says the plan moved on under it, so lib/journey.mjs asks again.
        setApply(lead, {...lead.auto_apply,status:'awaiting_batch_review',plan_fingerprint:item.plan_fingerprint,evidence:dir,...(blocked==='approval_stale'?{approval_stale:{approved_plan_fingerprint:lead.auto_apply?.approved_plan_fingerprint||null,current_plan_fingerprint:item.plan_fingerprint,at}}:{})}, { at, source: 'auto-apply' });
        save();
      }
      continue;
    }
    // 这个驱动做不了的（内置驱动没有登录态，门户要在登录过的 ego 浏览器里投）：不打开页面，交给你，信里说清楚。
    if (typeof driver.accepts === 'function' && !driver.accepts(lead)) {
      setApply(lead, { ...lead.auto_apply, status: 'waiting_user', error: 'ego_required:portal', attempts: attempts - 1, at, url: plan.url, stop: await stopAt('ego_required:portal', { url: plan.url }) }, { at, source: 'auto-apply', note: 'ego_required' });
      needs_info.push({ record_id: a.record_id, number: lead.number, company: lead.company, step: 'ego_required' });
      save();
      continue;
    }
    let dispatched=false;
    try {
      saveEvidence(`${dir}/plan.json`, plan);
      if (plan.fields.cover_letter) saveEvidence(`${dir}/cover-letter.txt`, plan.fields.cover_letter);
      step = '打开申请页'; page = { space: null };
      const inspected = await driver.inspect({ plan, dir });
      page = { space: inspected?.space ?? null, url: inspected?.url || null }; step = '读申请表';
      saveEvidence(`${dir}/inspection.json`, inspected);
      saveEvidence(`${dir}/controls.json`, inspected?.controls || []);
      const landing = judgeLanding({ requested: plan.url, page: inspected, lead });
      if (landing.verdict === 'gone') {
        applyPostingCheck(lead, { ...landing, url: plan.url, reason: 'posting_page_closed', evidence: { file: `${dir}/inspection.json`, url: inspected.url, text: String(inspected.text || '').slice(0, 1000) } }, { now, source: 'auto-apply' });
        skipped.push({ record_id: a.record_id, number: lead.number, reason: 'posting_closed' });
        save(); continue;
      }
      const wall = applyChannel(lead) === 'portal' ? loginWallReason(inspected) : null;
      if (wall) {
        // Not a failure of the form, and not a retry: the user has to sign in.
        const session = portalSession(lead);
        setApply(lead, { ...lead.auto_apply,status: 'needs_login', error: wall, attempts: attempts - 1, at, evidence: dir, url: inspected?.url || plan.url, domain: session?.domain || null, stop: await stopAt(wall) }, { at, source: 'auto-apply', note: wall });
        if (computerUseConfig().enabled === true) {
          const recovery = await computerUse({ goal: '只恢复登录态，不提交申请', url: plan.url, lead, plan });
          lead.auto_apply.evidence = recovery.evidence || dir;
          if (recovery.ok) {
            const { error: _was, ...kept } = lead.auto_apply;
            setApply(lead, { ...kept, status: 'prepared_for_user' }, { at, source: 'computer-use-recovery' });
            lead.computer_use = { ...recovery, at };
            save();
            continue; // Chrome stays at review. Never resume the ego submission driver.
          }
        }
        needs_login.push({ record_id: a.record_id, number: lead.number, company: lead.company, domain: session?.domain || null, reason: wall });
        save();
        continue;
      }
      // 验证码 / 无账号表单上的登录墙：系统不代做，也不把这样的表填好当成「可以终审」——交给你在页面上处理，点「继续」再来。
      // 只预填（auto_submit 关着）时验证码不挡：系统不点提交，验证码只会在你自己点提交时出现；只有登录墙（看不到表）才停。
      const human = humanStepReason(inspected, applyChannel(lead));
      if (human && (autoSubmit || human.code !== 'captcha_required')) {
        setApply(lead, { ...lead.auto_apply, status: 'waiting_user', error: `${human.code}:${human.reason}`, attempts: attempts - 1, at, evidence: dir, url: inspected?.url || plan.url, stop: await stopAt(`${human.code}:${human.reason}`) }, { at, source: 'auto-apply', note: human.code });
        needs_info.push({ record_id: a.record_id, number: lead.number, company: lead.company, step: human.code });
        save();
        continue;
      }
      // 一键投递的门户（lib/one-click-apply.mjs，阿里招聘的「投递简历」）：岗位页上那个按钮一点就投出去了，用的是门户账号里的简历，
      // 没有表要填。那一下就是提交，只能你自己点：不填、不点，记「等你」，信里给你打开那一页和「我已经投了」。不算一次失败。
      const oneClick = oneClickPortal(inspected, { url: plan.url });
      if (oneClick) {
        const code = `${oneClick.known ? 'one_click_portal' : 'one_click_page'}:${oneClick.family || 'page'}`;
        setApply(lead, { ...lead.auto_apply, status: 'waiting_user', error: code, attempts: attempts - 1, at, evidence: dir, url: inspected?.url || plan.url, one_click: { portal: oneClick.portal, button: oneClick.button }, stop: await stopAt(code) }, { at, source: 'auto-apply', note: 'one_click_portal' });
        needs_info.push({ record_id: a.record_id, number: lead.number, company: lead.company, step: 'one_click_portal' });
        save();
        continue;
      }
      const { entries, unanswered, consents, cover_letter_needed, letter_label } = planEntries(inspected?.controls || [], plan.fields, { book, posting: plan.location });
      saveEvidence(`${dir}/entries.json`, { entries, unanswered, consents, cover_letter_needed });
      // 只预填，或者表上有必填的同意框（系统不替你勾）：填好认得出的项，停在提交前交给你。
      const handOver = !autoSubmit || consents.length > 0;
      // 申请表要求必填求职信、你还没选定：等你（lib/needs.mjs 出一封「缺求职信」的信，Tailor 写好你点「用这封」就接着填表）。
      // 只预填也先问齐普通必填项；同意框、证件和密码仍由本人在网页处理。
      if (cover_letter_needed) {
        setApply(lead, { ...lead.auto_apply, status: 'waiting_user', error: 'cover_letter_needed' + (unanswered.length ? ';unanswered_required_fields:' + unanswered.slice(0, 10).join('|') : ''), attempts: attempts - 1, at, evidence: dir, stop: await stopAt('cover_letter_needed') }, { at, source: 'auto-apply', note: 'cover_letter_needed' });
        needs_info.push({ record_id: a.record_id, number: lead.number, company: lead.company, fields: ['cover_letter', ...unanswered.slice(0, 9)] });
        save();
        continue;
      }
      // Only the user can answer these: not a failed attempt to retry (that burnt the attempt ceiling on the same
      // question), but a wait for him. lib/needs.mjs turns this code into an info letter; the answers go to the
      // answer book and requeueApply sends the application back here. Labels are kept whole (no length cut), or a
      // truncated label would be remembered under a key the next fill never looks up.
      if (unanswered.length && (autoSubmit || unanswered.some(label => !NEVER_COLLECT.test(label)))) {
        // 选择题把页面上的选项一起记下：收件箱就给你一个下拉框，选的就是页面上的原话，答案簿下次能对上（以前只记题目，
        // 你打的字对不上选项，这一题会一直卡着）。
        const controls = (inspected?.controls || []).filter((c) => c.required && unanswered.includes(c.label || c.name || c.id || c.selector));
        const shape = controls.slice(0, 10).map((c) => ({ label: c.label || c.name || c.id || '', type: (c.options || []).length ? 'choice' : /textarea/i.test(String(c.tag || c.type || '')) ? 'long_text' : 'text', ...((c.options || []).length ? { options: c.options } : {}) }));
        setApply(lead, { ...lead.auto_apply, status: 'waiting_user', error: 'unanswered_required_fields:' + unanswered.slice(0, 10).join('|'), attempts: attempts - 1, at, evidence: dir, stop: await stopAt('unanswered_required_fields'), ...(shape.some((f) => f.type !== 'text') ? { unanswered_controls: shape } : {}) }, { at, source: 'auto-apply', note: 'unanswered_required_fields' });
        needs_info.push({ record_id: a.record_id, number: lead.number, company: lead.company, fields: unanswered.slice(0, 10) });
        save();
        continue;
      }
      // No input at all means the form never rendered (or an unrecognised wall);
      // say so instead of blaming a missing upload control.
      // 有 tag 的按 tag 判，没 tag 的（旧 driver / 测试替身只给 type）按 type 判；一个控件都没有才算表单没渲染。
      if (!(inspected?.controls || []).some((c) => /^(input|textarea|select)$/i.test(String(c.tag || '')) || (!c.tag && c.type))) throw Error('application_form_not_rendered');
      if (autoSubmit && !entries.some((e) => e.key === 'resume_path')) throw Error('resume_upload_control_missing');
      if(submissionPolicyReason(lead,plan,loadSubmissionPolicy(),loadSubmissionApprovals()))throw Error('approval_changed_before_submit');
      const fp = planFingerprint(plan), efp = entriesFingerprint(entries);
      // 沙盒演示的终审（final_review.dry）从来不算「你确认过的真终审」：确认之后只记一句没投成，换成真驱动也要重新填、重新终审。
      if (lead.auto_apply?.final_review?.dry && finalApproved(lead, fp)) throw Error('sandbox_dry_run: 沙盒只演示到终审，没有真的提交');
      // 只预填：填好认得出的项，整页扫出还空着的必填项，停在提交前交给你（prepared_for_user）；系统不点提交。
      if (handOver) {
        if (typeof driver.prefill !== 'function') throw Error('prefill_unsupported');
        step = '填表';
        const pre = await driver.prefill({ plan, dir, entries, space: inspected?.space });
        if (!pre?.prefilled) throw Error(pre?.error || 'prefill_failed');
        // 必填的同意框系统不替你勾（09-30 21:4x），所以它一定还空着：一起算进「要你自己填」的那几项（#482：同意框空着，信里却说填好了）。
        const missing = prefillGaps({ entries, readback: pre.readback || [], scanned: pre.missing || [], unanswered: [...(cover_letter_needed ? [letter_label] : []), ...unanswered, ...consents] });
        saveEvidence(`${dir}/prefilled.json`, { url: pre.url || plan.url, fields: pre.readback || [], missing, screenshot: pre.screenshot || null });
        const locked = await lockResume({ lead, plan, dir, now, snapshot });
        const { final_approved_at, final_plan_fingerprint, final_approved_by, final_review, error, needs, unanswered_controls, stop, one_click, ...rest } = lead.auto_apply || {};
        setApply(lead, { ...rest, status: 'prepared_for_user', at, attempts: attempts - 1, evidence: dir, plan_fingerprint: fp, url: pre.url || plan.url,
          prefill: { ...locked, filled: readbackFilled(pre.readback), missing: missing.slice(0, 20), fields: shownFields(pre.readback, entries).slice(0, 40), screenshot: pre.screenshot || null, url: pre.url || plan.url, space: inspected?.space ?? null, browser: pre.dry ? 'dry' : driver.name || 'chrome', at, resume: plan.fields?.resume_path || null, ...(resumeOnPage(pre, entries) ? { resume_on_page: true } : {}) } }, { at, source: 'auto-apply', note: 'prefilled' });
        prepared.push({ record_id: a.record_id, number: lead.number, company: lead.company, filled: lead.auto_apply.prefill.filled, missing: missing.length });
        save();
        continue;
      }
      const confirmed = finalApproved(lead, fp) && lead.auto_apply?.final_review?.entries_fingerprint === efp && !lead.auto_apply?.final_review?.dry;
      if (finalReview && typeof driver.prefill === 'function' && !confirmed) {
        step = '填表';
        const pre = await driver.prefill({ plan, dir, entries, space: inspected?.space });
        if (!pre?.prefilled) throw Error(pre?.error || 'prefill_failed');
        const missing = prefillGaps({ entries, readback: pre.readback || [], scanned: pre.missing || [] });
        saveEvidence(`${dir}/prefilled.json`, { url: pre.url || plan.url, fields: pre.readback || [], missing, screenshot: pre.screenshot || null });
        // 读回核对：必填项没填上（读回是空的，或整页扫出空着的必填项）不进终审——真提交会因为缺必填项失败。交给你在页面上补。
        if (missing.length) {
          setApply(lead, { ...lead.auto_apply, status: 'waiting_user', error: 'prefill_incomplete:' + missing.slice(0, 10).join('|'), attempts: attempts - 1, at, evidence: dir, url: pre.url || plan.url, stop: await stopAt('prefill_incomplete', { url: pre.url }) }, { at, source: 'auto-apply', note: 'prefill_incomplete' });
          needs_info.push({ record_id: a.record_id, number: lead.number, company: lead.company, step: 'prefill_incomplete', fields: missing.slice(0, 10) });
          save();
          continue;
        }
        const locked = await lockResume({ lead, plan, dir, now, snapshot });
        const { final_approved_at, final_plan_fingerprint, final_approved_by, stop, one_click, ...rest } = lead.auto_apply || {};
        setApply(lead, { ...rest, status: 'awaiting_final_review', at, attempts: attempts - 1, evidence: dir, plan_fingerprint: fp, final_review: { ...locked, screenshot: pre.screenshot || null, fields: shownFields(pre.readback, entries).slice(0, 40), url: pre.url || plan.url, space: inspected?.space ?? null, at, entries_fingerprint: efp, resume: plan.fields?.resume_path || null, ...(resumeOnPage(pre, entries) ? { resume_on_page: true } : {}), ...(pre.dry ? { dry: true } : {}) } }, { at, source: 'auto-apply' });
        awaiting_final.push({ record_id: a.record_id, number: lead.number, company: lead.company, screenshot: pre.screenshot || null });
        save();
        continue;
      }
      if (!autoSubmit) throw Error('auto_submit_off');
      setApply(lead, {...lead.auto_apply,status:'submitting',attempts,at,evidence:dir,plan_fingerprint:planFingerprint(plan)}, { at, source: 'auto-apply' });save();dispatched=true;
      step = '提交';
      const result = await driver.apply({ plan, dir, entries, space: inspected?.space });
      // The driver's word that submit was never pressed: an ordinary failure
      // (retry within the ceiling), not an uncertain submission to reconcile.
      if (!result?.submitted && result?.presubmit === true) { dispatched = false; throw Error(result.error || 'presubmit_failed'); }
      if (!result?.submitted || !confirmsSubmission(result.confirmation)) throw Error(result?.error || 'submission_unconfirmed');
      saveEvidence(`${dir}/confirmation.txt`, result.confirmation);
      outbound.push({
        id: hash(['auto_apply', a.record_id, plan.url]).slice(0, 32),
        record_id: a.record_id,
        number: lead.number,
        channel: 'ats_form',
        at,
        url: plan.url,
        external_id: result.external_id || null,
        evidence: dir,
        screenshot: result.screenshot || `${dir}/submitted.png`,
        confirmation: String(result.confirmation).slice(0, 500),
      });
      setApply(lead, { ...lead.auto_apply,status: 'submitted', at, attempts, evidence: dir, confirmation: String(result.confirmation).slice(0, 500) }, { at, source: 'auto-apply' });
      submitted.push({ record_id: a.record_id, number: lead.number, company: lead.company, url: plan.url, evidence: dir });
      save();
    } catch (e) {
      const stop = await stopAt(e.message);
      if(dispatched){setApply(lead,{...lead.auto_apply,status:'uncertain',attempts,at,evidence:dir,error:String(e.message).slice(0,220),stop},{at,source:'auto-apply'});uncertain.push({record_id:a.record_id,number:lead.number,reason:'reconcile_before_retry',error:lead.auto_apply.error});save();}
      else fail(e.message, stop);
    } finally {
      driver.finishLead?.({ plan, status: lead.auto_apply?.status });
    }
  }
  return { submitted, failed, needs_login,awaiting_review,skipped,uncertain,awaiting_final,needs_info,prepared };
}
