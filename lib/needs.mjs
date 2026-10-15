// 「要你处理的事」的唯一格式（harness）。
//
// 以前执行器卡住时写一段中文（"网易已登录，但须先建立在线简历……"），收件箱、指挥台、旧版页面三处
// 各自用关键词猜它要什么；猜错一次，你就得多登录一次、多点一次（2026-09-28）。现在谁卡住谁就填
// 固定字段，收件箱只读字段、不猜：
//   kind      login 登录 · info 补充信息 · decide 拍板 · approve 批准
//   account   login：哪个账号（config/accounts.json 的家族名，或 workday:<租户域名>）
//   fields    info：缺哪几项（key、给你看的名字、类型）
//   options   decide：给你选的几个选项
//   question  一句写给你看的话（全文，详情里给你看）
//   title     可选：短标题，约 20 个字的一句中文人话，不带代码名（卡片、成员卡、横幅上只放这一行）。没写的由
//             lib/short-title.mjs needTitle 从 question / 字段 / 选项推一个（needShort 带上账号的名字）
//   url       在哪儿处理（登录页、申请页），可选
// 执行器用 `node bin/job.mjs need …` 写（校验不过会被拒，并告诉它怎么改）；我们自己的代码（自动投递、
// 发私信）直接用 validateNeed 写同样的结构。
import { familyOf, loadAccounts } from './accounts.mjs';
import { crewName } from './crew.mjs';
import { browserLabel } from './browser-run.mjs';
import { needTitle, textWidth } from './short-title.mjs';
import { leadApplyWords } from './apply-words.mjs';
import { cleanFieldLabel, clipText, fieldQuestion, fieldQuestions } from './field-labels.mjs';
export { cleanFieldLabel, clipText, fieldQuestion, fieldQuestions };

export const NEED_KINDS = ['login', 'info', 'decide', 'approve'];
export const FIELD_TYPES = ['text', 'long_text', 'date', 'month', 'number', 'choice', 'file'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
// 证件号、银行卡、密码这类不经收件箱收集：只能你自己在网页上填。
export const NEVER_COLLECT = /身份证|护照|passport|social security|\bssn\b|社保号|银行卡|bank account|信用卡|credit card|密码|password|验证码|verification code/i;

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const required = (v, max, what) => { const s = clean(v); if (!s) throw Error(`${what}不能为空`); if (s.length > max) throw Error(`${what}最多 ${max} 个字`); return s; };
const optional = (v, max) => { const s = clean(v); return s ? s.slice(0, max) : null; };

// 账号：家族名（linkedin）、租户（workday:x.wd1.myworkdayjobs.com），或任意站点域名 / 链接（按家族认）。
export function accountKeyOf(value, cfg = loadAccounts()) {
  const v = clean(value);
  if (!v) return null;
  const [family, tenant] = v.split(/:(?!\/\/)(.+)/);
  const f = cfg.families?.[family];
  if (f && !f.per_tenant && !tenant) return family;
  if (f?.per_tenant && tenant) return familyOf(tenant, cfg)?.key || null;
  return familyOf(v, cfg)?.key || null;
}
// login 的账号 → 站点（给旧字段 resume_condition: portal_login:<站点> 用）。
export function accountHost(key, cfg = loadAccounts()) {
  const [family, tenant] = String(key || '').split(/:(.+)/);
  return tenant || (cfg.families?.[family]?.hosts || [])[0] || null;
}

export function validateNeed(input = {}, { now = Date.now(), cfg = loadAccounts() } = {}) {
  const kind = String(input.kind || '');
  if (!NEED_KINDS.includes(kind)) throw Error(`kind 必须是 ${NEED_KINDS.join(' / ')} 之一（收到「${kind}」）`);
  const need = { kind, since: new Date(input.since || now).toISOString() };
  const url = optional(input.url, 2000);
  if (url) { if (!/^https?:\/\//i.test(url)) throw Error('url 必须是 http(s) 链接'); need.url = url; }
  const note = optional(input.note, 500);
  if (note) need.note = note;
  const title = optional(input.title, 200);
  if (title) need.title = checkTitle(title);
  if (kind === 'login') {
    const account = accountKeyOf(input.account, cfg);
    if (!account) throw Error(`不认识的账号「${clean(input.account)}」：写 config/accounts.json 里的名字（如 linkedin、maimai、xiaohongshu），租户账号写 workday:<域名>，或者直接给站点域名`);
    need.account = account;
    const q = optional(input.question, 200);
    if (q) need.question = q;
    return need;
  }
  need.question = required(input.question, 200, 'question');
  if (kind === 'info') {
    const fields = (input.fields || []).map(f => {
      const key = clean(f.key);
      if (!KEY.test(key)) throw Error(`字段 key「${key}」只能用小写字母、数字、下划线，并以字母开头`);
      const label = required(f.label, 40, `字段 ${key} 的名字`);
      if (NEVER_COLLECT.test(`${key} ${label}`)) throw Error(`「${label}」这类信息不经收件箱收集：改成 approve，请用户在网页上自己填`);
      const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
      const field = { key, label, type };
      if (type === 'choice') {
        const options = (f.options || []).map(o => required(o, 40, `字段 ${key} 的选项`));
        if (options.length < 2) throw Error(`字段 ${key} 是选择题，至少给两个选项`);
        field.options = options;
      }
      return field;
    });
    if (!fields.length) throw Error('info 至少列一项缺的信息（--field key:名字[:类型]）');
    if (fields.length > 10) throw Error('info 一次最多问 10 项');
    if (new Set(fields.map(f => f.key)).size !== fields.length) throw Error('字段 key 重复了');
    need.fields = fields;
  } else if (kind === 'decide') {
    const options = (input.options || []).map(o => required(typeof o === 'string' ? o : o?.label, 30, '选项'));
    if (options.length < 2 || options.length > 5) throw Error('decide 要给 2–5 个选项');
    if (new Set(options).size !== options.length) throw Error('选项重复了');
    need.options = options;
  }
  return need;
}

// 短标题：一句中文人话，不超过 24 个字宽（英文、数字算半个），不带代码名、路径、编号以外的内部 id。
export function checkTitle(t) {
  const s = clean(t);
  if (!/[\u4e00-\u9fa5]/.test(s)) throw Error(`title 要用中文写一句短话（收到「${s}」）`);
  if (textWidth(s) > 24) throw Error(`title 最多 24 个字（英文、数字算半个），现在 ${textWidth(s)}：把全文写进 --question，这里只写一句，比如「补 Contoso 的岗位 JD」`);
  const code = s.match(/[a-z][a-z0-9]*[-_][a-z0-9_-]+|(?:runs|state|config|bin|lib)\/\S*|\S+\.(?:mjs|js|json|ndjson|md)\b/);
  if (code) throw Error(`title 里不写代码名（「${code[0]}」）：换成人话，比如「浏览器扫真人帖卡住了」`);
  return s;
}
// 一条「等你」的短标题（卡片、成员卡、横幅用）：执行器写了 title 用它的，没写的推一个；登录写账号的名字。
export function needShort(need, cfg = null) {
  const label = k => { try { const c = cfg || loadAccounts(); const [family, tenant] = String(k || '').split(/:(.+)/); const f = c.families?.[family]; return f ? `${f.label.replace(/（.*）$/, '')}${tenant ? ` · ${tenant.split('.')[0]}` : ''}` : k; } catch { return k; } };
  return needTitle(need, { account: label });
}

// 同一件事：同一种、同一账号（登录）或同一个问题。
export const sameNeed = (a, b) => a.kind === b.kind && (a.kind === 'login' ? a.account === b.account : a.question === b.question);

// 一句话概括（写进旧字段 waiting_user，老页面和飞书卡片照样能显示）。
export function needsSummary(needs = [], cfg = loadAccounts()) {
  const label = k => { const [family, tenant] = String(k).split(/:(.+)/); const f = cfg.families?.[family]; return f ? (tenant ? `${f.label.replace(/（.*）$/, '')} · ${tenant.split('.')[0]}` : f.label) : k; };
  const logins = needs.filter(n => n.kind === 'login').map(n => label(n.account));
  return [
    logins.length ? `需要你登录 ${logins.join('、')}` : null,
    ...needs.filter(n => n.kind !== 'login').map(n => n.kind === 'decide' ? `${n.question}（${n.options.join(' / ')}）` : n.kind === 'info' ? `${n.question}（${n.fields.map(f => f.label).join('、')}）` : n.question),
  ].filter(Boolean).join('；');
}

// 写到一条记录上（宿主任务或线索）：needs 追加（同一件事只留最新一份），状态改为 waiting_user，
// 同时写旧字段 waiting_user（概括）和 resume_condition（portal_login:<站点>），老代码照样能读。
export function attachNeeds(record, needs, { now = Date.now(), cfg = loadAccounts() } = {}) {
  const merged = [...(record.status === 'waiting_user' ? record.needs || [] : [])];
  for (const n of needs) { const i = merged.findIndex(m => sameNeed(m, n)); if (i >= 0) merged[i] = n; else merged.push(n); }
  const at = new Date(now).toISOString();
  Object.assign(record, { status: 'waiting_user', needs: merged, updated_at: at, waiting_user: needsSummary(merged, cfg) });
  const hosts = merged.filter(n => n.kind === 'login').map(n => accountHost(n.account, cfg)).filter(Boolean);
  if (hosts.length) record.resume_condition = `portal_login:${[...new Set(hosts)].join(',')}`;
  else if (/^portal_login:/.test(record.resume_condition || '')) delete record.resume_condition;
  return record;
}

// 申请表题目的清理和截短在 lib/field-labels.mjs（lib/apply-words.mjs 也用，放在这里会和它互相引用）。

// 从名字看得出格式的（出生年月、出生日期），按格式检查你填的值。
const guessType = label => /出生年月|birth ?month/i.test(label) ? 'month' : /出生日期|生日|date of birth|birth ?date|\bdob\b/i.test(label) ? 'date' : 'text';

// 自动投递（我们自己的代码）停下来的原因码 → 同样的结构。原因码是固定的，映射是确定的，不猜：
//   needs_login                                             → login（这个门户的账号）
//   waiting_user + unanswered_required_fields:<名字|名字>   → info（表上这几项）
// 已经写了 auto_apply.needs 的直接用。终审、预填好等你提交、材料变了要重新确认，各有专门的信。
export function autoApplyNeeds(lead, { cfg = loadAccounts(), url = null } = {}) {
  const a = lead?.auto_apply;
  if (!a) return [];
  if (Array.isArray(a.needs) && a.needs.length) return a.needs;
  const since = a.at || a.approved_at || null;
  if (a.status === 'needs_login') {
    const account = accountKeyOf(url || a.domain, cfg);
    return account ? [{ kind: 'login', account, since, ...(url ? { url } : {}) }] : [];
  }
  // 页面上要你亲手做的一步（验证码、无账号表单的登录）：你在页面上处理完点「继续」。
  // 预填后读回核对没过（lib/auto-apply.mjs prefill_incomplete）：这几项没填上，你在页面上补好点「继续」，或自己提交。
  const gap = a.status === 'waiting_user' && /^prefill_incomplete:(.*)$/s.exec(a.error || '');
  if (gap) {
    const labels = fieldQuestions(gap[1]).slice(0, 10);
    return [{ kind: 'approve', since, question: `这几项没填上：${labels.join('、') || '（页面上的必填项）'}`, url: a.url || url || null, note: '系统填过这几项，读回来是空的，真提交会因为缺必填项失败。在页面上补好点「继续」，系统重新检查，仍停在提交前给你终审；也可以直接在页面上提交，再点「我已在页面上提交了」。' }];
  }
  // 一键投递的门户（lib/one-click-apply.mjs）：岗位页上那个按钮一点就投出去，只能你自己点。不给「好了，继续」（系统接着也没有表可填），
  // 给打开那一页和「我已经投了」。话照 lib/apply-words.mjs 那张表说。
  if (a.status === 'waiting_user' && /^one_click_(?:portal|page)\b/.test(a.error || '')) {
    const w = leadApplyWords(a);
    return [{ kind: 'approve', since, title: `在${a.one_click?.portal || '门户'}上自己投`, question: `${w.reason}。${w.next}。`, url: a.url || url || null, continue: false, done: '我已经投了' }];
  }
  const step = a.status === 'waiting_user' && /^(captcha_required|login_required|ego_required)/.exec(a.error || '');
  if (step?.[1] === 'ego_required') return [{ kind: 'approve', since, question: '这个门户要在登录过的浏览器里投，这次用的是不带登录的内置浏览器：请打开申请页自己投，投完点「我已在页面上提交了」', url: a.url || url || null, continue: false, note: `内置浏览器只能投无账号的官方表单。在${browserLabel()}里登录这个门户后，回「投 编号」可以重新交给系统。` }];
  if (step) return [{ kind: 'approve', since, question: step[1] === 'captcha_required' ? '页面有验证码，请在页面上完成后点继续' : '申请页要求先登录，请在页面上登录后点继续', url: a.url || url || null, note: '系统不代做这一步。处理完点「继续」，系统接着填表，填好仍停在提交前给你终审；要是每次打开都有验证码，就在页面上自己提交，再点「我已在页面上提交了」。' }];
  // 申请表要求必填求职信（lib/auto-apply.mjs cover_letter_needed）：请 Tailor 按这家公司写一封，你选定后接着填表。
  const letter = a.status === 'waiting_user' && /^cover_letter_needed/.test(a.error || '') ? [{ kind: 'approve', letter: true, since, question: `这份申请表要求写求职信。让 ${crewName('tailor')} 先读公司调研再写一封，你在「简历 → 求职信」里看过、点「用这封」，系统就接着填表`, note: '求职信针对这个岗位写，不进答案簿；信里说你的每句话都核对过出处' }] : [];
  // 旧版已经交给本人提交的预填也可能还缺普通事实；无需迁移，直接投影为同一份补信息表。
  const tried = new Set((a.prefill?.fields || a.final_review?.fields || []).map(f => cleanFieldLabel(f.key).toLowerCase()));
  const missing = ['prepared_for_user', 'awaiting_final_review'].includes(a.status)
    ? (a.prefill?.missing || a.final_review?.missing || []).filter(l => !NEVER_COLLECT.test(l) && !tried.has(cleanFieldLabel(l).toLowerCase()) && !/resum|\bcv\b|简历|cover\s*letter|求职信|consent|privacy|gdpr|data\s*(?:processing|protection)|同意|隐私|个人信息/i.test(l)) : [];
  const m = missing.length ? [null, missing.join('|')] : a.status === 'waiting_user' && /unanswered_required_fields:([^;]+)/.exec(a.error || '');
  if (!m) return letter;
  // 给你看的是整道题（fieldQuestion），不是截到 40 字的答案簿键；答案簿存取时自己再按键归一（lib/answer-book.mjs bookKey）。
  const labels = fieldQuestions(m[1]).filter(l => !NEVER_COLLECT.test(l)).slice(0, 10);
  if (!labels.length) return [];
  // 填表时记下了控件的样子（lib/auto-apply.mjs unanswered_controls）：选择题带上页面上的选项，长回答用多行框。
  const shapes = new Map((Array.isArray(a.unanswered_controls) ? a.unanswered_controls : []).map(c => [cleanFieldLabel(c.label), c]));
  const typed = (label) => { const c = shapes.get(cleanFieldLabel(label)); return c?.type === 'choice' && c.options?.length ? { type: 'choice', options: c.options } : c?.type === 'long_text' ? { type: 'long_text' } : { type: guessType(label) }; };
  return [...letter, { kind: 'info', since, question: `申请表上有 ${labels.length} 项必填，系统不知道怎么填：${labels.join('、')}`, fields: labels.map((label, i) => ({ key: `f${i + 1}`, label, ...typed(label) })), note: '填一次就记进本地答案簿，以后别的申请表问同样的问题会自动填。' }];
}
