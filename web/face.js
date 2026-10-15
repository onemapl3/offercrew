// 成员的脸（2026-09-30）：团队一排、成员卡片、对话里的发言人、任务卡、@ 选人、会话切换，全从这一个函数画。
// 圆片本身由 web/crew-faces.js 画（名册 lib/crew.mjs 的 FACES：{ icon, fill, ink }，服务端经 /api/talk 的 members、
// /api/hq 的 workers 发过来）；这里只把服务端给的成员（{ name, face }）交给它，再挂上调用方的 class（大小由外面的格子定）。
// 服务端没给 face 的（认不出的编号）画一个中性的圆，写名字的第一个字。这里不写死任何一位。
import { faceHtml as chip, ICONS } from './crew-faces.js';

const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function faceHtml(m = {}, cls = '') {
  const f = m.face;
  if (f && ICONS[f.icon]) return chip(f).replace('class="crew-face', `class="oc-face ${esc(cls)} crew-face`);
  const initial = [...String(m.name || m.key || '·').trim()][0] || '·';
  return `<span class="oc-face ${esc(cls)}" aria-hidden="true">${esc(/^[a-z]$/i.test(initial) ? initial.toUpperCase() : initial)}</span>`;
}
