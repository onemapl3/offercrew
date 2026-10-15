// 自动投递在页面里跑的脚本：ego 驱动和内置 playwright 驱动共用。
//   EXTRACT        读出页面上所有表单控件（标题、类型、选项、是否必填、选择器）
//   READBACK       预填后读回每个控件现在的值
//   CHALLENGE      页面上看得见的验证码 / 人机验证（reCAPTCHA v3 隐形徽标不算）
//   REQUIRED_EMPTY 预填后整页扫一遍：还空着的必填项（输入框、单选组、勾选组、Yes/No 按钮组），给出页面上的题目
//   PICK_OPTION    自动补全框打字后看下拉候选；只有和要填的值完全一样的候选才标出来给驱动点
// 页面里的函数只能用自己带的东西：pageHelpers 按源码整段嵌进每段脚本。

// Ashby 默认展示岗位介绍；只沿页面实际提供的同一岗位 Application 链接进入表单。
// 不改批准的入口、不猜链接、不点击任何提交按钮。两个驱动都可直接调用或嵌入本函数。
export async function openApplicationForm(page) {
  const url = await page.evaluate(() => {
    if (location.hostname !== 'jobs.ashbyhq.com' || location.protocol !== 'https:') return null;
    const base = location.pathname.replace(/\/$/, '');
    if (!/^\/[^/]+\/[^/]+$/.test(base)) return null;
    for (const a of document.querySelectorAll('a[href]')) {
      const target = new URL(a.href, location.href);
      if (target.origin === location.origin && target.pathname === base + '/application' &&
          (a.getAttribute('role') === 'tab' || /^(Application|Apply for this Job)$/i.test(a.textContent.trim()))) return target.href;
    }
    return null;
  });
  if (!url) return null;
  await page.goto(url);
  await page.waitForSelector('input:not([type=hidden]), textarea, select', { state: 'visible', timeout: 15000 }).catch(() => {}); // 兜底：等不到输入框也接着读页面，下面会照实说没找到表单
  return url;
}

// 一个控件（或一组选项的容器）属于哪道题：往上找最小的、不含别的输入控件的那一层里的题目（label、legend、题目样式）。
// Ashby 的 label[for] 指向不存在的 id、单选组用 fieldset 里的 label 而不是 legend、Yes/No 是两个按钮——都靠这个认出题目。
// 必填：required / aria-required，或题目带红星（✱ / * / 类名里有 required / ::after 的 *）。
export function pageHelpers() {
  const visible = el => !!(el && (el.offsetParent || el.getClientRects().length));
  const text = n => String((n && (n.innerText || n.textContent)) || '').replace(/\s+/g, ' ').trim();
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), select, textarea';
  const HEAD = 'label, legend, [class*="question-title" i], [class*="application-label" i], [class*="field-label" i]';
  const GROUP_OPTION = 'button[aria-pressed], [role=radio]:not(input), [role=switch]:not(input)';
  const optionLabel = h => { const f = h.htmlFor ? document.getElementById(h.htmlFor) : null; return !!((f && /^(radio|checkbox)$/i.test(f.type || '')) || h.querySelector('input[type=radio], input[type=checkbox]')); };
  const questionOf = el => {
    const own = el.name || '';
    for (let n = el.parentElement, d = 0; n && n !== document.body && d < 7; n = n.parentElement, d++) {
      const others = [...n.querySelectorAll(FIELD)].filter(o => o !== el && !el.contains(o) && !(own && o.name === own) && visible(o));
      if (others.length) return null;
      const head = [...n.querySelectorAll(HEAD)].find(h => !h.contains(el) && !optionLabel(h) && text(h));
      if (head) return head;
    }
    return null;
  };
  const starred = head => !!head && (/required/i.test(String(head.getAttribute('class') || '')) || /[*✱]$/.test(text(head)) || !!head.querySelector('.required, [class*="required" i], abbr[title*="required" i]') || /[*✱]/.test(String(getComputedStyle(head, '::after').content || '')));
  const requiredOf = (el, head) => !!(el.required || el.getAttribute('aria-required') === 'true' || starred(head));
  const pressed = o => o.getAttribute('aria-pressed') === 'true' || o.getAttribute('aria-checked') === 'true' || /(?:^|[\s_-])(?:selected|active|checked|isSelected)(?:$|[\s_-])/i.test(String(o.getAttribute('class') || ''));
  // Yes/No 这类按钮组：同一个父元素下至少两个带 aria-pressed / role=radio 的按钮。
  const buttonGroups = () => {
    const groups = new Set();
    for (const b of document.querySelectorAll(GROUP_OPTION)) if (visible(b) && b.parentElement) groups.add(b.parentElement);
    return [...groups].map(g => ({ box: g, options: [...g.children].filter(c => c.matches(GROUP_OPTION) && visible(c)) })).filter(g => g.options.length >= 2);
  };
  const optionText = el => text((el.labels && el.labels[0]) || el.closest('label')) || el.getAttribute('aria-label') || el.value || '';
  return { visible, text, FIELD, questionOf, requiredOf, starred, pressed, buttonGroups, optionText };
}

export const EXTRACT = `() => {
  const H = (${pageHelpers})();
  const visible = H.visible;
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, m => '\\\\\\\\' + m));
  const selectorFor = el => {
    if (el.id) return '#' + esc(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      const i = [...n.parentElement.children].filter(c => c.tagName === n.tagName).indexOf(n) + 1;
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
    }
    return parts.join(' > ');
  };
  const labelFor = el => {
    const questionText = n => { const copy = n.cloneNode(true); for (const c of copy.querySelectorAll('input, select, textarea')) c.remove(); return copy.textContent; };
    const parts = [];
    if (el.id) { const l = document.querySelector('label[for="' + esc(el.id) + '"]'); if (l) parts.push(questionText(l)); }
    const wrap = el.closest('label'); if (wrap) parts.push(questionText(wrap));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)) {
      const n = document.getElementById(id); if (n) parts.push(n.innerText);
    }
    const fs = el.closest('fieldset'); const lg = fs && fs.querySelector('legend'); if (lg) parts.push(lg.innerText);
    if (!parts.join('').trim()) { const q = H.questionOf(el); if (q) parts.push(H.text(q)); }
    // 题目用可见文字；控件 id/name 和下拉选项不是问题的一部分。
    // 同一道题才能对上以前保存的答案，题目缺失时才用占位字/控件名兜底。
    const label = [...new Set(parts.map(s => String(s).replace(/\\s+/g, ' ').trim()).filter(Boolean))].join(' ');
    return (label || el.placeholder || el.name || el.id || '').slice(0, 240);
  };
  const out = [], radios = new Map(), groups = H.buttonGroups();
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el.disabled || el.type === 'hidden' || !visible(el)) continue;
    if (groups.some(g => g.box.contains(el))) continue;
    if (el.type === 'radio') {
      const key = el.name || labelFor(el);
      if (!radios.has(key)) radios.set(key, { tag: 'radio', type: 'radio', name: el.name || '', label: '', required: false, options: [], option_selectors: [], selector: selectorFor(el) });
      const group = radios.get(key);
      group.options.push(H.optionText(el) || labelFor(el));
      group.option_selectors.push(selectorFor(el));
      const fs = el.closest('fieldset'); const lg = fs && fs.querySelector('legend'); const q = lg ? null : H.questionOf(el);
      group.required = group.required || H.requiredOf(el, q);
      group.label = group.label || (lg ? lg.innerText : H.text(q) || el.name || '');
      continue;
    }
    const q = H.questionOf(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      type: (el.type || el.tagName).toLowerCase(),
      name: el.name || '',
      id: el.id || '',
      required: H.requiredOf(el, q),
      label: labelFor(el),
      options: el.tagName === 'SELECT' ? [...el.options].map(o => o.text.trim()) : [],
      selector: selectorFor(el),
      role: el.getAttribute('role') || '',
      autocomplete: el.getAttribute('aria-autocomplete') || (el.getAttribute('list') ? 'list' : ''),
    });
  }
  // Ashby 的 Yes/No 是两个按钮（后面藏着一个看不见的 checkbox）：当成一道单选题，选项就是按钮上的字。
  const buttons = groups.map(g => { const q = H.questionOf(g.box); return { tag: 'button', type: 'radio', name: '', id: '', group: 'buttons', required: H.requiredOf(g.box, q) || [...g.box.querySelectorAll('input')].some(i => i.required), label: H.text(q), options: g.options.map(H.text), option_selectors: g.options.map(selectorFor), selector: selectorFor(g.box) }; }).filter(g => g.label);
  return [...out, ...radios.values(), ...buttons];
}`;

// 单选 / 按钮组（action choose）读的是选中的那一项：选中了给它的字，没选中是空的（以前读第一个单选框的「未勾选」，空着也像填了）。
export const READBACK = `(entries) => entries.map(e => { const H = (${pageHelpers})(); if (e.action === 'choose' && e.option_selector && e.option_selector !== e.selector) { const o = document.querySelector(e.option_selector); if (!o) return { key: e.key, value: '（没找到控件）' }; const on = o.tagName === 'INPUT' ? o.checked : H.pressed(o); return { key: e.key, value: on ? String(H.optionText(o) || H.text(o) || '已选').slice(0, 300) : '' }; } const el = document.querySelector(e.selector); if (!el) return { key: e.key, value: '（没找到控件）' }; const v = el.type === 'file' ? [...(el.files || [])].map(f => f.name).join('、') : (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '已勾选' : '未勾选') : el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].text : '') : (el.value || ''); return { key: e.key, value: String(v).slice(0, 300) }; })`;

// 整页扫一遍还空着的必填项。空：输入框没值（地点这类自动补全框只打了字、旁边隐藏的 selected* 还是空的也算空）、文件框没有文件
// （页面上也没显示文件名 / 上传成功）、单选 / 勾选组一个都没选、Yes/No 按钮组一个都没按下。返回页面上的题目文字。
export const REQUIRED_EMPTY = `() => {
  const H = (${pageHelpers})();
  const out = [], groups = H.buttonGroups(), sets = new Map();
  const add = (head, el) => { const label = H.text(head) || (el && (H.text(el.labels && el.labels[0]) || el.getAttribute('aria-label') || el.placeholder || el.name)) || ''; if (label && !out.includes(label)) out.push(label.slice(0, 240)); };
  for (const g of groups) {
    const q = H.questionOf(g.box);
    if ((H.requiredOf(g.box, q) || [...g.box.querySelectorAll('input')].some(i => i.required)) && !g.options.some(H.pressed)) add(q, null);
  }
  for (const el of document.querySelectorAll(H.FIELD)) {
    if (el.disabled || groups.some(g => g.box.contains(el))) continue;
    const type = String(el.type || '').toLowerCase();
    if (type === 'file' ? !H.visible(el.parentElement) : !H.visible(el)) continue;
    if (type === 'radio' || type === 'checkbox') { const k = type + ':' + (el.name || Math.random()); if (!sets.has(k)) sets.set(k, []); sets.get(k).push(el); continue; }
    const q = H.questionOf(el);
    if (!H.requiredOf(el, q)) continue;
    let empty;
    if (type === 'file') empty = !(el.files && el.files.length) && !/\\.(?:pdf|docx?|txt|rtf|odt|md|pages)\\b|success|uploaded|已上传|上传成功/i.test(H.text(q && q.parentElement ? q.parentElement : el.parentElement));
    else if (el.tagName === 'SELECT') empty = !el.value;
    else {
      empty = !String(el.value || '').trim();
      const box = el.parentElement, picked = box && box.querySelector('input[type=hidden][name^="selected" i]');
      if (!empty && picked && !picked.value) empty = true;
    }
    if (empty) add(q, el);
  }
  for (const els of sets.values()) {
    const fs = els[0].closest('fieldset'), lg = fs && fs.querySelector('legend'), q = lg || H.questionOf(els[0]);
    const required = els.some(e => e.required || e.getAttribute('aria-required') === 'true') || H.starred(q);
    if (required && !els.some(e => e.checked)) add(q, els[0]);
  }
  return out;
}`;

// 自动补全框打完字以后：看看下拉里有哪些候选。和要填的值完全一样的候选打上 data-radar-pick，驱动去点它；
// open 表示下拉出现过（有候选、没有匹配结果的提示、或 aria-expanded），这时没选中的值不能留在框里。
export const PICK_OPTION = `(arg) => {
  const H = (${pageHelpers})();
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const input = document.querySelector(arg.selector);
  document.querySelectorAll('[data-radar-pick]').forEach(n => n.removeAttribute('data-radar-pick'));
  let pool = [];
  const ids = input ? ((input.getAttribute('aria-controls') || '') + ' ' + (input.getAttribute('aria-owns') || '')).split(/\\s+/).filter(Boolean) : [];
  for (const id of ids) { const box = document.getElementById(id); if (box) pool.push(...box.querySelectorAll('[role=option], li')); }
  if (!pool.length) pool = [...document.querySelectorAll('[role=option], [role=listbox] li, .dropdown-results > *, .pac-item, [class*="suggestion" i] li, [class*="autocomplete" i] li')];
  pool = pool.filter(n => H.visible(n) && norm(H.text(n)));
  let open = !!input && input.getAttribute('aria-expanded') === 'true';
  for (let n = input && input.parentElement, d = 0; n && d < 3 && !open; n = n.parentElement, d++) open = [...n.querySelectorAll('[role=listbox], [class*="dropdown" i]')].some(H.visible);
  const hit = pool.find(n => norm(H.text(n)) === norm(arg.value));
  if (hit) hit.setAttribute('data-radar-pick', '1');
  return { options: pool.length, exact: !!hit, open: open || pool.length > 0 };
}`;

// 填一项（两个驱动共用；ego 驱动把它的源码嵌进浏览器脚本，所以只能用 page 的方法和传进来的参数）。
// 自动补全框（地点这类）：一个键一个键地打（Lever 只认键盘事件，fill 不出下拉），最多等 3 秒看候选；
// 只有和值完全一样的候选才点；下拉出现过却没有一样的，就把框清空——留给你在页面上选，不替你挑一个「差不多」的。
// 不按回车（没选中候选时回车可能直接提交表单）。
export async function fillEntry(page, e, resumePath, pickScript) {
  if (e.action === 'fill' && e.autocomplete) {
    await page.fill(e.selector, '');
    await page.click(e.selector);
    await page.keyboard.type(String(e.value), { delay: 30 });
    let seen = null;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      seen = await page.evaluate('(' + pickScript + ')(' + JSON.stringify({ selector: e.selector, value: String(e.value) }) + ')');
      if (seen && seen.exact) break;
    }
    if (seen && seen.exact) { await page.click('[data-radar-pick="1"]'); await page.waitForTimeout(300); return 'picked'; }
    if ((seen && seen.open) || e.combobox) { await page.fill(e.selector, ''); await page.keyboard.press('Escape').catch(() => {}); return 'cleared'; } // 兜底：下拉框已经收起来了
    return 'typed';
  }
  if (e.action === 'fill') await page.fill(e.selector, String(e.value));
  else if (e.action === 'select') await page.selectOption(e.selector, { label: String(e.value) });
  else if (e.action === 'choose') await page.click(e.option_selector || e.selector);
  else if (e.action === 'files') await page.setInputFiles(e.selector, resumePath);
  else if (e.action === 'check') {
    const on = await page.evaluate('document.querySelector(' + JSON.stringify(e.selector) + ')?.checked === true');
    if (on !== !!e.value) await page.click(e.selector);
  }
  return 'done';
}

// 整页截图前把页面放回顶上（09-30 真实测试 #14：预填截图的上半截重复了一遍）。填完最后一项、找提交按钮以后
// 页面停在底部，焦点还在输入框里；整页截图从滚动过的位置拼，吸顶栏、平滑滚动会让同一段出现两次。
// 关掉平滑滚动、让输入框失焦、页面和每个滚动过的区域回到 0；返回还没回到顶的个数（0 才算好）。
export const SHOT_READY = `async () => {
  for (const el of [document.documentElement, document.body]) if (el) el.style.scrollBehavior = 'auto';
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const reset = () => {
    window.scrollTo(0, 0);
    let left = 0;
    for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) { el.scrollTop = 0; if (el.scrollTop > 0) left++; }
    return left + (window.scrollY > 0 ? 1 : 0);
  };
  // 等滚动停下来再截图：填表时聚焦输入框带出来的平滑滚动，回到顶上以后还可能接着走（机器忙时多走几个像素）。
  // 连着两次（隔 50 毫秒）都停在顶上才算停稳，最多等 1.5 秒；用定时器不用动画帧，后台窗口里也不会卡住。
  let left = reset(), still = 0;
  const until = Date.now() + 1500;
  while (still < 2 && Date.now() < until) {
    await new Promise(r => setTimeout(r, 50));
    const moved = window.scrollY !== 0 || [...document.querySelectorAll('*')].some(el => el.scrollTop > 0);
    if (moved) { still = 0; left = reset(); } else still++;
  }
  return left;
}`;

// 页面上看得见的按钮的字（短的，最多 60 个）：一键投递的门户认「投递简历」那个按钮用（lib/one-click-apply.mjs）。
// 正文只截了开头 4000 字，岗位描述长的时候按钮在后面（线 R 10-04）。只读，不点。
export const BUTTONS = `() => {
  const vis = el => !!(el.offsetParent || el.getClientRects().length);
  const out = [];
  for (const el of document.querySelectorAll('button, [role=button], a, input[type=submit], input[type=button]')) {
    if (!vis(el)) continue;
    const t = String(el.tagName === 'INPUT' ? el.value : (el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();
    if (t && t.length <= 20 && !out.includes(t)) out.push(t);
    if (out.length >= 60) break;
  }
  return out;
}`;
export const CHALLENGE = `() => {
  // 看得见：占版面，而且没被设成隐藏、透明或者缩成一点（Lever 的 hCaptcha 平时就挂着一个 visibility:hidden 的框，只在点提交时才可能真弹出来）。
  const vis = el => { if (!(el.offsetParent || el.getClientRects().length)) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8; };
  const frame = [...document.querySelectorAll('iframe')].filter(vis).map(f => f.src || '').find(s => /recaptcha\\/(?:api2|enterprise)\\/(?:anchor|bframe)|hcaptcha\\.com|challenges\\.cloudflare\\.com|geetest|captcha/i.test(s) && !/size=invisible/i.test(s));
  if (frame) return 'captcha_frame';
  const el = [...document.querySelectorAll('.g-recaptcha:not([data-size="invisible"]), .h-captcha, .cf-turnstile, [class*="geetest"], img[src*="captcha" i], input[name*="captcha" i], input[id*="captcha" i]')].find(vis);
  return el ? 'captcha_widget' : null;
}`;
