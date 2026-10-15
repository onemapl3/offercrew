// 自动预填 / 自动投递停下来的原因码 → 给人看的话（线 P，10-04，负责人：「这个提示给用户，我怎么看得懂呢？」）。
//
// lib/auto-apply.mjs 和两个浏览器驱动（lib/ego-apply.mjs、lib/playwright-apply.mjs）、沙盒驱动（lib/apply-dry.mjs）、
// 填表前的材料（lib/application-form.mjs）和浏览器脚本（lib/ego-browser.mjs）报的原因码都在这张表里：
//   reason  一句人话：为什么停了（卡片、收件箱、成员页、对话里的那一句）；
//   next    下一步该做什么；
//   step    停在哪一步（证据里写，「打开申请页」「填表」「找提交按钮」）。
// 原始的码只留在证据里（lead.auto_apply.error、stop.code、runs/<日>/auto-apply/<编号>/stop.json），卡上不露。
// tests/apply-words.test.mjs 扫这几个文件里会落到卡上的码：新加一个没写进这张表，测试就红。
import { crewName } from './crew.mjs';
import { fieldQuestions, clipText } from './field-labels.mjs';

// 没填成的：系统不会自己再来一次（周期、操作台、System 都不重投，负责人 10-05 O5），只说能怎么办：重新预填，或者自己投。
// 收件箱那封信、投递卡上都有重来的按钮（lib/apply-retry.mjs）。
const RETRY = '可以重新预填一次，或者打开申请页自己投';
// {portal}：门户的名字（「阿里招聘」）；{button}：页面上那个按钮的字（「投递简历」）。
export const APPLY_WORDS = {
  // ── 等你：要你在页面上做一步，或者这类门户只能你自己投 ──
  one_click_portal: { step: '岗位页', reason: '{portal}是在岗位页点「{button}」一键投出的，用的是你{portal}账号里的简历，没有表要填', next: '要投就在打开的页面上自己点「{button}」，投完点「我已经投了」。账号里的简历要是旧的，先在{portal}里更新' },
  one_click_page: { step: '岗位页', reason: '这个页面没有表要填，只有一个「{button}」按钮，点下去多半就直接投出去了，用的是你在{portal}账号里存的简历', next: '要投就在打开的页面上自己点，投完点「我已经投了」。账号里的简历要是旧的，先在那边更新' },
  ego_required: { step: '打开申请页', reason: '这个门户要在登录过的浏览器里投，这次用的浏览器没有登录', next: '打开申请页自己投，投完点「我已在页面上提交了」' },
  captcha_required: { step: '打开申请页', reason: '申请页上有验证码，系统不代做这一步', next: '在页面上完成验证后点「好了，继续」，系统接着填' },
  login_required: { step: '打开申请页', reason: '申请页要求先登录', next: '在页面上登录后点「好了，继续」，系统接着填' },
  redirected_to_login: { step: '打开申请页', reason: '这个门户没登录，打开申请页跳到了登录页', next: '在浏览器里登录这个门户，登好了系统接着填' },
  login_form_present: { step: '打开申请页', reason: '这个门户没登录，申请页上是登录框', next: '在浏览器里登录这个门户，登好了系统接着填' },
  login_required_notice: { step: '打开申请页', reason: '这个门户没登录，页面上写着要先登录才能投', next: '在浏览器里登录这个门户，登好了系统接着填' },
  cover_letter_needed: { step: '读申请表', reason: '这份申请表要求写求职信', next: () => `让 ${crewName('tailor')} 写一封，你选定以后系统接着填` },
  unanswered_required_fields: { step: '读申请表', reason: '申请表上有几项必填，系统不知道怎么填', next: '在收件箱里补上，记进答案簿以后系统接着填' },
  prefill_incomplete: { step: '读回核对', reason: '有几项填过了，读回来还是空的', next: '在页面上补好点「好了，继续」，或者直接在页面上自己提交' },
  // ── 没做成：系统这一次没填成 ──
  submit_button_missing: { step: '找提交按钮', reason: '填完以后页面上没找到「提交」按钮，可能是分几步的表，或者这一页不是申请表', next: RETRY },
  fill_failed: { step: '填表', reason: '有一项填不进去，页面上的控件和读到的对不上', next: RETRY },
  application_form_not_rendered: { step: '读申请表', reason: '申请页上没出现能填的表，可能还没加载出来，或者要先点「申请」才出来', next: RETRY },
  resume_upload_control_missing: { step: '读申请表', reason: '申请表上没找到上传简历的地方', next: '打开申请页自己传简历并提交' },
  approval_changed_before_submit: { step: '提交前核对', reason: '你批准以后材料或申请入口变了，这次没交', next: '按现在的材料重新确认一次' },
  sandbox_dry_run: { step: '提交', reason: '演示环境只走到终审，没有真的提交', next: '换到正式的数据目录再投' },
  prefill_unsupported: { step: '填表', reason: '这次用的浏览器只能直接提交，做不了预填', next: '打开申请页自己投' },
  prefill_failed: { step: '填表', reason: '预填中途停了', next: RETRY },
  auto_submit_off: { step: '提交', reason: '自动提交关着，系统不点提交', next: '打开申请页自己提交' },
  presubmit_failed: { step: '提交前', reason: '还没点提交就停了', next: RETRY },
  submission_unconfirmed: { step: '提交', reason: '点了提交，页面上没看到投递成功的字样', next: '打开申请页或邮箱看一眼投上没有；投上了点「我已在页面上提交了」' },
  builtin_browser_missing: { step: '打开浏览器', reason: '这台电脑上没找到能用的 Chrome', next: '装好 Chrome 再试，或者打开申请页自己投' },
  page_closed: { step: '打开申请页', reason: '之前填好的那一页已经关了', next: '要的话可以让系统重新预填' }, // lib/apply-retry.mjs（重新预填之前）
  ego_browser_failed: { step: '打开浏览器', reason: '浏览器这次没跑起来，打不开或者太久没回', next: RETRY },
  ego_browser_result_count: { step: '打开浏览器', reason: '浏览器回来的结果读不懂', next: RETRY },
  ego_browser_result_invalid_json: { step: '打开浏览器', reason: '浏览器回来的结果读不懂', next: RETRY },
  resume_file_missing: { step: '准备材料', reason: '要上传的简历文件找不到了', next: '在「材料」里重新导出简历再投' },
  application_url_missing: { step: '准备材料', reason: '这个岗位没有申请页地址', next: '在岗位页补上申请链接，或者自己投' },
  contact_facts_missing: { step: '准备材料', reason: '资料里还没有邮箱或手机号', next: '在「资料」里补上邮箱和手机号再投' },
};
// 门户自己的说法（ego_required:portal、captcha_required:captcha_text、fill_failed:resume_path:…）：冒号前面是码。
export const applyCode = error => { const m = /^\s*([a-z]+(?:_[a-z0-9]+)+)/.exec(String(error ?? '')); return m ? m[1] : null; };
const RAW = /[a-z]+_[a-z0-9_]+|\b(?:error|exit|http|ECONN\w*|ENOENT)\b|Error:|net::/i;
const fill = (s, v) => String(typeof s === 'function' ? s(v) : s).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// 一条停下来的记录 → { code, reason, next, step, line }。line 是卡上那一句（原因。下一步。）。
// vars：{ portal, button }（一键投递的门户）。表里没有的码：已经是人话的照用，原始报错只说「中途出错停了」。
export function applyWords(error, vars = {}) {
  const raw = String(error ?? '').trim(), code = applyCode(raw), w = code && APPLY_WORDS[code];
  if (w) { const reason = fill(w.reason, vars), next = fill(w.next, vars); return { code, reason, next, step: w.step, line: `${reason}。${next}。` }; }
  const said = raw && !RAW.test(raw) && /[一-龥]/.test(raw) ? raw.replace(/[。；;\s]+$/, '') : null;
  const reason = said || '中途出错停了';
  return { code: code || null, reason, next: RETRY, step: null, line: `${reason}。${RETRY}。` };
}
// 一条线索现在的投递记录 → 那几个字（一键投递门户的名字和按钮从记录上取）。
export const leadApplyWords = (a = {}) => applyWords(a.error, { portal: a.one_click?.portal || '这个网站', button: a.one_click?.button || '投递' });

// 自动预填停下来时留的证据（lib/auto-apply.mjs stopAt）：那一页的截图、地址、停在哪一步、原始的码。收件箱和任务卡的「详情与证据」照它列。
// 只在停着的时候给（等你、没做成、要登录、拿不准）；预填好了、终审有自己的截图。
const STOPPED = new Set(['waiting_user', 'failed', 'needs_login', 'uncertain']);
export const proofOf = l => { const a = l?.auto_apply, p = a?.stop; return p && STOPPED.has(a.status) ? { step: p.step || null, code: p.code || null, url: p.url || null, screenshot: p.screenshot || null, at: p.at || null } : null; };

// 预填完读回来还空着的必填项（lib/auto-apply.mjs prefillGaps：读回是空的、整页扫出来的、系统认不出没去填的、不替你勾的同意框）。
// 有就照实列出来、说要你自己填（负责人 10-05 #482：国籍、所在国家、同意框都空着，信里却写「能填的已经预填好了」）。
// 自绘的下拉框读回可能不准，所以说「读回来是空的」，不说「没填」。没有空着的是 null。
export function missingLine(missing = [], { max = 6 } = {}) {
  const qs = fieldQuestions(missing).map(q => clipText(q, 36));
  if (!qs.length) return null;
  const shown = qs.slice(0, max).join('、') + (qs.length > max ? ` 等 ${qs.length} 项` : '');
  return { count: qs.length, list: shown, line: `还有 ${qs.length} 项必填读回来是空的，要你在页面上自己填：${shown}` };
}
