// 页面里的确认框和输入框（代替 window.confirm / window.prompt）。
// 为什么：App（Electron）里 window.prompt 不支持，内置浏览器里 window.confirm 不弹框、直接当「取消」，
// 改名、解除配对、删除这类按钮点了就像没反应。手机端是 P.confirm（web/phone/app.js），这里是电脑这一边的同一件事。
//
//   await askConfirm({ title, lines, go, cancel, danger })  → true（点了 go）/ false（取消、Esc、点外面）
//   await askText({ title, lines, value, go, cancel, max })  → 写的字（去掉首尾空白，空的算取消）/ null
//
// title 是要做的事，lines 写后果（「这部手机的密钥会立刻作废」）；按钮写动作本身，不写「确定」。
// 放在 web/settings/ 下只是因为工作台按白名单发文件，这个目录整个能发（bin/serve.mjs）；哪一页都能用。
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function open({ title = '', lines = [], go = '好', cancel = '取消', danger = false, input = null }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'oc-ask';
    const ls = (Array.isArray(lines) ? lines : [lines]).filter(Boolean), body = ls.length ? `<div class="oc-ask-lines">${ls.map(l => `<p>${esc(l)}</p>`).join('')}</div>` : '';
    const field = input ? `<input class="oc-ask-in" type="text" value="${esc(input.value || '')}" maxlength="${Number(input.max) || 60}" aria-label="${esc(title)}">` : '';
    d.innerHTML = `<form method="dialog" class="oc-ask-f"><h2>${esc(title)}</h2>${body}${field}<div class="dialog-actions"><button type="button" class="secondary" data-ask-no>${esc(cancel)}</button><button type="submit" class="primary${danger ? ' is-danger' : ''}" data-ask-go>${esc(go)}</button></div></form>`;
    let answered = false;
    const done = v => { if (answered) return; answered = true; resolve(v); if (d.open) d.close(); d.remove(); };
    const box = d.querySelector('.oc-ask-in');
    d.querySelector('form').onsubmit = e => { e.preventDefault(); if (!box) return done(true); const v = box.value.trim(); if (v) done(v); else box.focus(); };
    d.querySelector('[data-ask-no]').onclick = () => done(input ? null : false);
    d.addEventListener('cancel', e => { e.preventDefault(); done(input ? null : false); });
    d.addEventListener('close', () => done(input ? null : false));
    d.addEventListener('click', e => { if (e.target === d) done(input ? null : false); });
    document.body.append(d);
    d.showModal();
    // 输入框：光标在框里、字全选；要删东西的：光标先停在「取消」上，回车不会误删。
    if (box) { box.focus(); box.select(); } else (danger ? d.querySelector('[data-ask-no]') : d.querySelector('[data-ask-go]')).focus();
  });
}
export const askConfirm = (o = {}) => open({ ...o, input: null });
export const askText = (o = {}) => open({ ...o, input: { value: o.value || '', max: o.max } });
// web/command.js 不 import（测试用 vm 直接跑它），从这里拿。
if (typeof globalThis !== 'undefined') globalThis.OfferCrewAsk = { askConfirm, askText };
