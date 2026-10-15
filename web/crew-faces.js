// 团队成员的脸（2026-09-30）：一枚圆片，底色 fill、图标线条 ink；你和团队是中性圆片（页面底色 + 一圈细线）。
// 哪位用哪个图标、什么颜色在 lib/crew.mjs 的 FACES（服务端经 /api/hq、/api/snapshot 的 face 字段发过来：
// { icon, fill, ink }）；这里只有图标本身，随代码发，不从网上、不从字体加载——离线和沙盒里一样能画。
//
// 用法（整个模块就两样）：
//   faceHtml(face, { size = 22, dot = null, dotTitle = '', title = '' })  → 一枚圆片的 HTML
//       face     /api/hq 给的 { icon, fill, ink }；fill 为 null 是中性圆片；认不出的图标画一个空圆片
//       dot      状态灯，圆片右上角一个小点：'wait' 琥珀（等你）· 'run' 绿色（在做，不动；团队页和面板现在都不传它）· 'off' 灰（暂停）·
//                'warn' 红（最近一次没做成）· 'ok' 绿（正常）；不给就没有灯
//   ICONS    图标名 → SVG 里面的 <path>（24×24 画布，线宽 2，圆头）
// 样式在 web/style.css 的 .crew-face。
//
// 图标来自 Tabler Icons（outline，https://tabler.io/icons），MIT 许可。路径逐字取自 npm 包 @tabler/icons 3.48.0 的
// icons/outline/<名字>.svg（去掉每个文件开头那条 stroke="none" 的画布框），2026-09-30 核对过；换图标照同样取。
//   MIT License. Copyright (c) 2020-2026 Paweł Kuna.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
//   the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.
export const ICONS = {
  'radar-2': '<path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M15.51 15.56a5 5 0 1 0 -3.51 1.44"/><path d="M18.832 17.86a9 9 0 1 0 -6.832 3.14"/><path d="M12 12v9"/>',
  scale: '<path d="M7 20l10 0"/><path d="M6 6l6 -1l6 1"/><path d="M12 3l0 17"/><path d="M9 12l-3 -6l-3 6a3 3 0 0 0 6 0"/><path d="M21 12l-3 -6l-3 6a3 3 0 0 0 6 0"/>',
  writing: '<path d="M20 17v-12c0 -1.121 -.879 -2 -2 -2s-2 .879 -2 2v12l2 2l2 -2"/><path d="M16 7h4"/><path d="M18 19h-13a2 2 0 1 1 0 -4h4a2 2 0 1 0 0 -4h-3"/>',
  send: '<path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/>',
  eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
  settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  user: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>',
  users: '<path d="M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  // 收件箱分类和发件人（2026-09-30，替换 📅🔑📝⚖✍⏳🔐📮✉ 这些 emoji）：同一套 Tabler outline，也逐字取自 3.48.0（2026-09-30 核对，原先 6 个多了结尾的 z）。
  calendar: '<path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/><path d="M11 15h1"/><path d="M12 15v3"/>',
  key: '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0"/><path d="M15 9h.01"/>',
  'file-check': '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2"/><path d="M9 15l2 2l4 -4"/>',
  'arrows-split': '<path d="M21 17h-8l-3.5 -5h-6.5"/><path d="M21 7h-8l-3.495 5"/><path d="M18 10l3 -3l-3 -3"/><path d="M18 20l3 -3l-3 -3"/>',
  pencil: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  repeat: '<path d="M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3"/><path d="M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3"/>',
  filter: '<path d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227"/>',
  hourglass: '<path d="M6.5 7h11"/><path d="M6.5 17h11"/><path d="M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1"/><path d="M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1"/>',
  lock: '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>',
  // 左栏「问团队」（2026-09-30）：两个对话气泡，Tabler outline messages，已和 @tabler/icons 3.48.0 的 icons/outline/messages.svg 逐字核对。
  messages: '<path d="M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10"/><path d="M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2"/>',
  robot: '<path d="M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4"/><path d="M12 2v2"/><path d="M9 12v9"/><path d="M15 12v9"/><path d="M5 16l4 -2"/><path d="M15 14l4 2"/><path d="M9 18h6"/><path d="M10 8v.01"/><path d="M14 8v.01"/>',
};
// 一个单独的线条图标（不带圆片），和文字同高同色：收件箱的分类、发件人用。认不出的名字画空。
export function iconHtml(name, { size = 16, title = '' } = {}) {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg class="ui-icon" width="${Number(size) || 16}" height="${Number(size) || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${title ? ` role="img" aria-label="${attr(title)}"` : ' aria-hidden="true"'}>${paths}</svg>`;
}
// 小灯只认这几种颜色；灯上的那句话是服务端给的（成员的 status.label，lib/team.mjs 查账得来），这里不自带词。
const DOTS = new Set(['wait', 'run', 'off', 'warn', 'ok']);
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const attr = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function faceHtml(face, { size = 22, dot = null, dotTitle = '', title = '' } = {}) {
  const f = face || {}, paths = ICONS[f.icon] || '';
  const neutral = !(HEX.test(f.fill || '') && HEX.test(f.ink || ''));
  const style = `--face-size:${Number(size) || 22}px${neutral ? '' : `;--face-fill:${f.fill};--face-ink:${f.ink}`}`;
  const light = dot && DOTS.has(dot) ? `<span class="crew-dot is-${dot}"${dotTitle ? ` title="${attr(dotTitle)}"` : ''}></span>` : '';
  return `<span class="crew-face${neutral ? ' is-neutral' : ''}" style="${style}"${title ? ` title="${attr(title)}"` : ''} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>${light}</span>`;
}
// web/inbox.js 在测试里是去掉 import 后放进 vm 跑的，从这里拿图标。
globalThis.OfferCrewIcons = { iconHtml };
