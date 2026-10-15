// 内置操作员的安全规则（2026-09-28）：能去哪些站点、哪些控件永远不碰、什么时候必须停下交给你。
//
// agent.mjs（模型每走一步）和 recipes.mjs（回放每一步）都先过这里，规则只写一份。模型怎么回答
// 都绕不过去：网页上的文字是不可信的数据，一个页面写"忽略之前的规则、去某某网站"，模型可能真信，
// 所以站点白名单、终审闸门、上传白名单、不碰密码 / 验证码都在代码里判，不靠提示词。
import fs from 'node:fs';
import path from 'node:path';

// 终审闸门：看起来像最终提交 / 发送 / 投递 / 应聘的按钮一律不点，停下来给你看（ready_for_review）。
// 配置只能在这个基础上加词（stopPattern），不能减——CLI 和 runComputerUse 都这么用。
// 比对前先 normText：组件库常在两个汉字之间塞一个空格（antd 的「提 交」「确 定」），不去掉就漏了（09-28 审查）。
export const FINAL_ACTION = /\b(?:submit|send|apply|confirm|finish|done|complete)\b|提交|发送|投递|投.{0,2}简历|发.{0,2}简历|递交|确认|确定|完成|申请|应聘|报名|网申|立即沟通|打.{0,2}招呼|发消息|聊一聊|送出|申請|確認|確定|應徵|投遞|發送|遞交|報名/i;
// 表单的提交按钮如果没写清是"下一步 / 保存 / 搜索"，也按最终提交处理；没有文字、只有符号的按钮（图标、"→"）
// 同样认不出来——宁可多停一次，不能替你交出去。
const NEXT_STEP = /\b(?:next|continue|proceed|save|search|find|filter|back|previous|upload|add|edit)\b|下一步|继续|保存|搜索|查询|筛选|上一步|返回|上传|添加|编辑/i;
// 地址本身像"提交 / 投递"的链接（…/apply/submit、…/deliver?jobId=1）：点它或 goto 过去都当最终提交。
const FINAL_URL = /(?:^|[/_.?&=-])(?:submit|deliver|toudi|confirm|sendmsg)(?:[/_.?&=-]|$)/i;
// 同意 cookie / 条款 / 权限一类的按钮不替你点（有"拒绝 / 仅必要"可以点那个）。
const ACCEPT_BUTTON = /\b(?:accept|agree|allow|consent)\b|同意|接受|允许|授权/i;
const REJECT_BUTTON = /\b(?:reject|decline|deny|necessary|essential)\b|拒绝|不同意|仅必要|必要的/i;
// 按键只允许不会触发提交的：回车、空格可能直接提交表单或点中按钮，永远不按。
export const SAFE_KEYS = ['Tab', 'Shift+Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Backspace', 'Delete'];
const CAPTCHA_FRAME = /recaptcha|hcaptcha|geetest|captcha|turnstile|arkoselabs|funcaptcha|nc_iconfont|aliyuncaptcha/i;
const CAPTCHA_TEXT = /recaptcha|hcaptcha|人机验证|安全验证|拖动滑块|滑动验证|请完成验证|请输入验证码|获取验证码|短信验证码|verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|enter the (?:verification )?code/i;
const OTP_TEXT = /短信|手机验证码|动态码|动态密码|sms|one[\s-]?time|\botp\b|code (?:we|was) sent|发送至/i;
// 已登录的证据只认"退出登录"一类的按钮 / 链接：个人中心、我的简历这种入口没登录时也常挂在导航栏上。
const SIGNED_IN = /退出登录|注销登录|安全退出|退出账号|sign ?out|log ?out/i;
// 同意条款、隐私授权、"我确认以上信息真实"这类声明：是你本人的表态，终审时由你自己勾。
const CONSENT = /agree|accept|consent|terms|privacy|policy|certify|declar|acknowledg|attest|同意|接受|条款|协议|隐私|授权|声明|承诺|确认/i;

export const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }; // 兜底：地址解析不了就没有主机名，闸门按不认识的主机拦
// 单页应用的路由写在 # 后面（Moka 这类 …/#/job/9/deliver）：这种 # 要留着，普通的页内锚点才去掉。
const routeHash = h => /^#[/!]/.test(h || '');
export const normUrl = url => { try { const u = new URL(url); if (!routeHash(u.hash)) u.hash = ''; return u.href; } catch { return String(url || ''); } };
// 比对前统一文字：全角 / 兼容字符归一（NFKC），去掉零宽字符，汉字之间的空白去掉。
export const normText = s => String(s ?? '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/([\u3400-\u9fff\uf900-\ufaff])[\s\u3000]+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '$1').replace(/\s+/g, ' ').trim();
export const finalUrl = url => { try { const u = new URL(url); return FINAL_URL.test(u.pathname + u.search + (routeHash(u.hash) ? u.hash.slice(1) : '')); } catch { return false; } }; // 兜底：解析不了就不算终审页；goto 时 hostAllowed 也不放行解析不了的地址
// 记下这一页出现过的地址（页面本身 + 链接）和对应的链接元素：goto 只能去这些地方，
// 而且去之前按那个链接过一遍闸门——点不得的链接，goto 过去也不行（09-28 审查）。
export function rememberUrls(known, obs = {}, links = null) {
  if (obs.url) known.add(normUrl(obs.url));
  // 同一个地址可能有好几个链接（"查看" 和 "一键投递" 指向同一处）：全记下，goto 时只要有一个点不得就不去。
  for (const e of obs.elements || []) if (e.href && /^https?:/i.test(e.href)) { const k = normUrl(e.href); known.add(k); if (links) { const list = links.get(k) || []; if (!list.some(x => x.label === e.label)) list.push(e); links.set(k, list); } }
  return known;
}
export function hostAllowed(url, hosts = []) {
  let u; try { u = new URL(url); } catch { return false; } // 兜底：解析不了的地址不放行
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  return hosts.some(d => { const x = String(d || '').toLowerCase().replace(/^\*\./, '').trim(); return !!x && (h === x || h.endsWith('.' + x)); });
}
// 默认闸门 + 配置追加的词（字符串 / 正则 / 数组）。replace=true 才整体替换，只给程序内部用。
export function stopPattern(extra = null, { replace = false } = {}) {
  const parts = (Array.isArray(extra) ? extra : extra == null || extra === '' ? [] : [extra]).map(x => (x instanceof RegExp ? x.source : String(x))).filter(Boolean);
  if (replace && parts.length) return new RegExp(parts.join('|'), 'i');
  return parts.length ? new RegExp(`${FINAL_ACTION.source}|${parts.join('|')}`, 'i') : FINAL_ACTION;
}

const textOf = el => `${el.label || ''} ${el.name || ''} ${el.placeholder || ''}`;
export const isPassword = el => el.type === 'password' || /(?:current|new)-password/i.test(el.autocomplete || '') || /password|passwd|密码|口令/i.test(textOf(el));
export const isCodeField = el => el.autocomplete === 'one-time-code' || /captcha|验证码|校验码|动态码|动态密码|one[\s-]?time|\botp\b|sms code|verification code|security code|人机验证/i.test(textOf(el));
// 单选按钮常是正常的问题（"是否接受调剂：接受 / 不接受"），只在明确讲条款、隐私、授权、声明时才当作表态。
const TERMS = /terms|privacy|policy|consent|协议|条款|隐私|政策|授权|声明/i;
export const isConsent = el => {
  const t = normText(`${el.label || ''} ${el.group || ''}`);
  if (el.type === 'radio' || el.role === 'radio') return TERMS.test(t);
  return (el.type === 'checkbox' || /^(checkbox|switch)$/.test(el.role || '')) && CONSENT.test(t);
};
// 与脚本投递同一条规则：同意框（隐私、个人信息、数据处理、条款、营销、人才库、声明）一律不替你勾，留给你自己
// （负责人 09-30 21:4x；以前必填的隐私同意会代勾，终审里写「将代你勾选：…」）。
const OPTIONAL_CONSENT = /marketing|newsletter|talent (?:pool|community)|future opportunit|third[- ]part|第三方|营销|订阅|推送|人才库/i;
// 营销 / 人才库 / 订阅这类勾选框，措辞里没有「同意」也不替你勾。
export const optInBox = el => (el.type === 'checkbox' || el.role === 'checkbox') && OPTIONAL_CONSENT.test(normText(`${el.label || ''} ${el.group || ''}`));
export const tickableConsent = () => false;
export const buttonLike = el => el.tag === 'button' || el.tag === 'a' || (el.tag === 'input' && /^(submit|button|image|reset)$/.test(el.type || '')) || /^(button|link|menuitem)$/.test(el.role || '');
export const plainLink = el => { if (el?.tag !== 'a' || !/^https?:/i.test(el.href || '')) return false; const i = String(el.href).indexOf('#'); return i === -1 || routeHash(String(el.href).slice(i)); };
// 没有字、只有符号的按钮认不出意图，按最终提交处理；关闭 / 增删这几个符号的意思很明确，放行。
const SAFE_SYMBOLS = /^[×✕✖✗+＋−－\-]$/;
// 普通链接（http(s) 地址、不带 #）只是打开下一页——Lever 的「Apply for this job」就是去申请表的链接，
// 所以链接上只有 apply / 申请 这类词不拦；带「提交 / 发送 / 投递」的链接、地址像提交接口的链接、
// javascript: 和 # 链接照样拦。
const APPLY_WORDS = /\bapply(?:ing)?\b|申请/gi;
export const isFinalLooking = (el, gate = FINAL_ACTION) => {
  if (!el || !buttonLike(el)) return false;
  let text = normText(`${el.label || ''} ${el.tag === 'input' ? el.value || '' : ''}`);
  if (plainLink(el)) { if (finalUrl(el.href)) return true; text = text.replace(APPLY_WORDS, ' '); }
  else if (!/[\p{L}\p{N}]/u.test(text) && !SAFE_SYMBOLS.test(text)) return true;
  return gate.test(text) || (!!el.submit && !NEXT_STEP.test(text));
};
export const fillable = el => (el.tag === 'input' && !/^(checkbox|radio|file|submit|button|image|reset|hidden|range|color)$/.test(el.type || '')) || el.tag === 'textarea' || el.type === 'contenteditable';
export const safeKey = k => SAFE_KEYS.find(x => x.toLowerCase() === String(k ?? '').trim().toLowerCase()) || null;
// 页面里（包括收在菜单里没展开的）有"退出登录"：extractPage 的 signals.logout；看得见的控件也算。
export const signedIn = obs => !!obs?.signals?.logout || (obs?.elements || []).some(e => buttonLike(e) && SIGNED_IN.test(normText(e.label)));
// 申请表在不在：有简历上传框，或者至少三个不是搜索框的输入框、其中有姓名 / 邮箱 / 手机一类。
// 只有一个搜索框、两个筛选框的职位列表页不算。
export function applicationForm(obs) {
  const els = (obs?.elements || []).filter(e => !e.disabled);
  const tag = e => `${e.label || ''} ${e.name || ''} ${e.placeholder || ''}`;
  if (els.some(e => e.type === 'file' && /resume|\bcv\b|简历|附件|upload|上传|attach/i.test(tag(e)))) return true;
  const fields = els.filter(e => fillable(e) && e.type !== 'search' && !/search|搜索|查询|关键词|keyword/i.test(tag(e)));
  return fields.length >= 3 && fields.some(e => /name|姓名|e-?mail|邮箱|phone|mobile|手机|电话/i.test(tag(e)));
}
export const toBool = v => (typeof v === 'string' ? !/^(false|no|0|off|unchecked|否|不)$/i.test(v.trim()) : v !== false && v != null);

// 这一页能不能继续：离开允许的站点（多半是跳去了第三方登录）、验证码 / 短信码、要输密码的登录墙，
// 都得你来。只看确定的信号：页面上真有密码框才算登录墙，不猜。
export function wallOf(obs = {}, hosts = []) {
  if (obs.url && !/^about:/.test(obs.url) && !hostAllowed(obs.url, hosts)) return { reason: 'left_allowed_hosts', detail: hostOf(obs.url) || String(obs.url).slice(0, 80) };
  const els = obs.elements || [];
  const txt = `${obs.title || ''} ${String(obs.text || '').slice(0, 4000)}`;
  const code = els.find(e => isCodeField(e) && !e.disabled);
  if ((obs.iframes || []).some(s => CAPTCHA_FRAME.test(s)) || CAPTCHA_TEXT.test(txt) || code) {
    const otp = OTP_TEXT.test(`${code ? textOf(code) : ''} ${txt}`);
    return { reason: otp ? 'otp_required' : 'captcha', detail: code ? code.label || code.name || '' : '' };
  }
  const pw = els.find(e => e.type === 'password' && !e.disabled);
  if (pw) return { reason: 'login_wall', detail: pw.label || '' };
  return null;
}

// data 可以是嵌套对象：拍平成 a.b 的键，回放时按键取值、录制时按值找键。
export function flatten(data, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(data || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out[key] = v;
  }
  return out;
}
// 能上传的只有 data 里给出的、真实存在的绝对路径（简历、作品集）。模型说别的路径一律拒绝。
export function allowedFiles(data = {}, extra = []) {
  const out = new Set();
  const visit = v => {
    if (typeof v === 'string') { if (path.isAbsolute(v)) { try { if (fs.statSync(v).isFile()) out.add(v); } catch {} } } // 兜底：不是现成的文件就不当成要上传的文件
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(data); visit(extra);
  return out;
}
export function resolveUpload(value, data, files) {
  const v = String(value ?? '').trim();
  if (files.has(v)) return v;
  const flat = flatten(data);
  if (typeof flat[v] === 'string' && files.has(flat[v])) return flat[v];
  // 小模型常只报文件名：文件名唯一对得上也认。
  const byName = [...files].filter(p => path.basename(p) === v);
  return byName.length === 1 ? byName[0] : null;
}

// 一个动作能不能执行。返回 { ok, el, value } / { refused, message } / { stop: 'ready_for_review', el }。
// 拒绝不是失败：原因会写回给模型，让它换一步。
export function checkAction(a, obs, ctx) {
  const refuse = (code, message) => ({ ok: false, refused: code, message });
  const els = obs.elements || [];
  const el = a.id != null ? els.find(e => e.id === a.id) : null;
  if (['click', 'fill', 'select', 'check', 'upload'].includes(a.action)) {
    if (a.id == null) return refuse('missing_id', `${a.action} needs the element number`);
    if (!el) return refuse('unknown_element', `there is no element [${a.id}] on this page`);
    if (el.disabled) return refuse('disabled', `[${a.id}] is disabled`);
    if (isCodeField(el)) return refuse('code_field', 'captcha and verification-code fields are for the human');
  }
  // 只看不填的任务：只能点普通链接、滚动、goto 看到过的页面；按钮一律不点（点按钮就可能"应聘"了）。
  if (ctx.readonly) {
    if (['fill', 'select', 'check', 'upload'].includes(a.action)) return refuse('read_only', 'this task only looks; do not fill anything');
    if (a.action === 'click' && !plainLink(el)) return refuse('read_only', 'this task only looks: follow links, do not press buttons');
  }
  switch (a.action) {
    case 'click': {
      if (el.href && /^(mailto|tel|sms|file|data|blob|chrome|about):/i.test(el.href)) return refuse('external_scheme', 'that link leaves the browser');
      if (el.href && /^https?:/i.test(el.href) && !hostAllowed(el.href, ctx.hosts)) return refuse('off_host', `that link goes to ${hostOf(el.href)}, outside the allowed sites`);
      if (el.role === 'switch') return refuse('switch', 'settings switches are left for the human');
      if (isFinalLooking(el, ctx.gate)) return { ok: false, stop: 'ready_for_review', el };
      // 表单交到别的网站去（form action 在白名单外）：点"下一步"就把填的东西发出去了。先过闸门：真正的提交钮停在终审。
      if (el.form_action && !hostAllowed(el.form_action, ctx.hosts)) return refuse('off_host_form', `that button sends the form to ${hostOf(el.form_action) || 'another site'}`);
      if (el.type === 'file') return refuse('use_upload', 'use upload for file fields');
      if ((isConsent(el) || optInBox(el)) && !el.checked) return refuse('consent', tickableConsent(el) ? 'use check for this required privacy consent, so the review lists it' : 'leave consent / terms / marketing boxes for the human review');
      if (buttonLike(el) && ACCEPT_BUTTON.test(normText(el.label)) && !REJECT_BUTTON.test(normText(el.label))) return refuse('consent', 'do not accept cookies, terms or permissions for the user; pick "reject" / "necessary only" if offered, or reply need_user');
      return { ok: true, el };
    }
    case 'fill':
      if (isPassword(el)) return refuse('password', 'never type passwords');
      if (!fillable(el)) return refuse('not_fillable', `[${a.id}] is not a text field${el.tag === 'select' ? ' (use select)' : ''}`);
      if (a.value == null) return refuse('missing_value', 'fill needs a value');
      // 单行输入框不带换行：有的浏览器把 \n 当回车键，回车会提交表单。
      return { ok: true, el, value: el.tag === 'input' ? String(a.value).replace(/[\r\n]+/g, ' ') : String(a.value) };
    case 'select': {
      if (el.tag !== 'select') return refuse('not_a_select', `[${a.id}] is not a dropdown; click it to open the list, then click the option`);
      const want = String(a.value ?? '').trim();
      if (!want) return refuse('missing_value', 'select needs the option text');
      const opts = el.options || [];
      if (opts.length && !opts.some(o => o.toLowerCase() === want.toLowerCase() || o.toLowerCase().includes(want.toLowerCase()))) return refuse('unknown_option', `no option like "${want}"; options: ${opts.slice(0, 15).join(' | ')}`);
      return { ok: true, el, value: want };
    }
    case 'check': {
      const on = toBool(a.value ?? true);
      if (el.role === 'switch') return refuse('switch', 'settings switches are left for the human');
      if (!/^(checkbox|radio)$/.test(el.type || '') && !/^(checkbox|radio)$/.test(el.role || '')) return refuse('not_checkable', `[${a.id}] is not a checkbox or radio`);
      if (on && ((isConsent(el) && !tickableConsent(el)) || optInBox(el))) return refuse('consent', 'leave consent / terms / marketing boxes for the human review');
      return { ok: true, el, value: on };
    }
    case 'upload': {
      if (el.type !== 'file' && !/upload|上传|resume|简历|\bcv\b|attach|附件/i.test(el.label || '')) return refuse('not_upload', `[${a.id}] is not a file field`);
      // 不是文件框本身时要点它来弹出选择框：点之前同样过终审闸门（"Upload & Apply" 这种按钮不点）。
      if (el.type !== 'file' && isFinalLooking(el, ctx.gate)) return { ok: false, stop: 'ready_for_review', el };
      const p = resolveUpload(a.value, ctx.data, ctx.files);
      if (!p) return refuse('file_not_allowed', ctx.files.size ? `only these files can be uploaded: ${[...ctx.files].map(f => path.basename(f)).join(', ')}` : 'no file was provided for upload');
      return { ok: true, el, value: p };
    }
    case 'press': {
      const k = safeKey(a.value);
      return k ? { ok: true, value: k } : refuse('key_not_allowed', `allowed keys: ${SAFE_KEYS.join(', ')} (Enter and Space are never pressed)`);
    }
    case 'scroll': return { ok: true, value: /up|top|上/i.test(String(a.value ?? '')) ? 'up' : 'down' };
    case 'goto': {
      if (!hostAllowed(a.value, ctx.hosts)) return refuse('off_host', `${String(a.value || '').slice(0, 80)} is outside the allowed sites`);
      // 只去看到过的地址（起始页、页面上的链接、到过的页）：模型自己拼的网址可能是一个"GET 就投递"的接口，
      // 也可能是页面文字诱导它去的地方。看到过的链接本身点不得（一键投递），goto 过去也不行。
      if (ctx.known && !ctx.known.has(normUrl(a.value))) return refuse('unknown_url', 'goto only opens the start page or a link already shown on these pages; click the link instead');
      const final = (ctx.links?.get(normUrl(a.value)) || []).find(l => isFinalLooking(l, ctx.gate));
      if (final || finalUrl(a.value)) return { ok: false, stop: 'ready_for_review', el: final || { id: null, tag: 'a', role: 'link', label: String(a.value).slice(0, 120), href: String(a.value) } };
      return { ok: true, value: String(a.value) };
    }
    case 'wait': case 'done': case 'need_user': case 'fail': return { ok: true };
    default: return refuse('unknown_action', `unknown action "${a.action}"`);
  }
}
