// 材料 · 一张纸（2026-10-01，设计说明 3.3 / 5.3）：页面上的简历和导出的 PDF 用同一套 CSS、同一种标记。
//   EXPORT_CSS   lib/resume-export.mjs 里打印用的 CSS，一个字不差（tests/resume-page.test.mjs 拿 renderHtml 的 <style> 逐字核对）。
//   sheetCss()   把它收进 .rs-sheet 里（body → .rs-sheet，html 和 @page 不要），页面上只插一次。
//   paperHtml()  和 renderHtml 的 <body> 一样的标记（只读时逐字一样，测试核对）；editable 时每一行能改（contenteditable），
//                空行照样画出来（导出时不画），每一段后面一个「+」。lineHtml / lineClass 给对比页、Writer 刚改过的行上色用。
// 纯函数，不碰 DOM（除了 mountSheetCss），node 里能直接 import。
const FONTS = '"Helvetica Neue", Arial, "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", sans-serif';
export const EXPORT_CSS = `@page{size:A4;margin:16mm}
html{background:#fff}
body{margin:0;color:#111;font-family:${FONTS};font-size:10.5pt;line-height:1.4;font-variant-ligatures:none;overflow-wrap:break-word}
h1,h2,h3,p,ul{margin:0;padding:0}
h1{font-size:20pt;line-height:1.2;font-weight:700}
.contact{margin-top:3pt;font-size:9.5pt;color:#333}
section{margin-top:10pt}
h2{font-size:11.5pt;line-height:1.3;font-weight:700;padding-bottom:2pt;margin-bottom:4pt;border-bottom:.75pt solid #999;break-after:avoid}
.entry+.entry{margin-top:6pt}
.head{break-inside:avoid;break-after:avoid}
.head h3{font-size:1em;font-weight:700}
.head p{margin-top:1pt;font-size:10pt;color:#555}
.head .gap{display:inline-block;width:1.5em}
ul{margin-top:2pt;padding-left:12pt;list-style-type:"\\2022\\a0\\a0"}
li,.line{margin-top:1.5pt;break-inside:avoid}
strong{font-weight:700}
@media screen{html{background:#eceff3}body{box-sizing:border-box;max-width:210mm;min-height:297mm;margin:24px auto;padding:16mm;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}}`;

// ── CSS 收进一个范围 ─────────────────────────────────────────────────────────
// 只认这份 CSS 用到的写法：规则、@page、@media { 规则 }。
function blocks(css) {
  const out = [];
  for (let i = 0; i < css.length;) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const sel = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < css.length && depth; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; }
    out.push({ sel, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}
export function scopeCss(css, scope) {
  return blocks(css).map(({ sel, body }) => {
    if (sel.startsWith('@page')) return '';
    if (sel.startsWith('@media')) { const inner = scopeCss(body, scope); return inner ? `${sel}{${inner}}` : ''; }
    const sels = sel.split(',').map(s => s.trim()).filter(s => s !== 'html').map(s => s === 'body' ? scope : `${scope} ${s}`);
    return sels.length ? `${sels.join(',')}{${body}}` : '';
  }).filter(Boolean).join('\n');
}
export const sheetCss = () => scopeCss(EXPORT_CSS, '.rs-sheet');
export function mountSheetCss(doc = globalThis.document) {
  if (!doc || doc.getElementById('rs-sheet-css')) return;
  const s = doc.createElement('style');
  s.id = 'rs-sheet-css';
  s.textContent = sheetCss();
  doc.head.append(s);
}

// 材料页和导入核对共用整份纸张，不在引导里另画一份截短的文本预览。
export const paperPreviewHtml = content => `<div class="rs-pv-frame"><div class="rs-sheet">${paperHtml(content)}</div></div>`;
export function fitPaperPreviews(root = globalThis.document) {
  for (const frame of root?.querySelectorAll('.rs-pv-frame') || []) {
    const sheet = frame.querySelector('.rs-sheet');
    if (sheet && frame.clientWidth > 24) sheet.style.zoom = String(Math.min(1, (frame.clientWidth - 24) / 794));
  }
}

// ── 标记：和 renderHtml 一样 ─────────────────────────────────────────────────
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const clean = s => String(s ?? '').replace(BAD, '').replace(/[\t\r\n]+/g, ' ');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const line = l => l && typeof l === 'object' ? { id: String(l.id ?? ''), text: clean(l.text).trim(), bullet: l.bullet === true, em: Array.isArray(l.em) ? l.em.map(e => clean(e).trim()).filter(Boolean) : [] } : null;
// keepEmpty：编辑时空行也画（刚按回车起的那一行）；导出和只读时不画。
function shape(c, keepEmpty = false) {
  const lines = xs => (Array.isArray(xs) ? xs : []).map(line).filter(l => l && (keepEmpty || l.text));
  const sections = (Array.isArray(c?.sections) ? c.sections : []).map(s => {
    const title = line(s?.title);
    const entries = (Array.isArray(s?.entries) ? s.entries : []).map(e => ({ id: String(e?.id ?? ''), head: lines(e?.head), lines: lines(e?.lines) })).filter(e => keepEmpty || e.head.length || e.lines.length);
    return { id: String(s?.id ?? ''), kind: String(s?.kind ?? 'other'), title: title && (keepEmpty || title.text) ? title : null, entries };
  }).filter(s => keepEmpty || s.title || s.entries.length);
  return { lang: c?.lang === 'zh' ? 'zh' : 'en', header: lines(c?.header), sections };
}
const WORD = /[A-Za-z0-9]/;
export function segments({ text, em }) {
  const bold = new Uint8Array(text.length);
  for (const k of em) for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) {
    const j = i + k.length;
    if (!(WORD.test(k[0]) && WORD.test(text[i - 1] ?? '')) && !(WORD.test(k.at(-1)) && WORD.test(text[j] ?? ''))) bold.fill(1, i, j);
  }
  const out = [];
  for (let i = 0, j; i < text.length; i = j) { for (j = i + 1; j < text.length && bold[j] === bold[i]; j++); out.push({ text: text.slice(i, j), bold: bold[i] === 1 }); }
  return out;
}
export const inline = l => segments(l).map(s => s.bold ? `<strong>${esc(s.text)}</strong>` : esc(s.text)).join('');
export const gapped = html => String(html).replace(/ {2,}/g, ' <span class="gap"></span>');

// opts：
//   editable        每一行能改；带上 data-part / data-entry / data-section，给按键找位置
//   lineHtml(l)     这一行里面的 HTML（对比页的逐字标记）；不给就是 inline(l)
//   lineClass(l)    这一行多加的 class（Writer 刚改过的、对比页整行加 / 删的）
export function paperHtml(content, { editable = false, lineHtml = null, lineClass = null } = {}) {
  const c = shape(content, editable), [name, ...contacts] = c.header;
  const cls = l => { const k = lineClass?.(l); return k ? ` class="${esc(k)}"` : ''; };
  const at = o => ` data-id="${esc(o.id)}"`;
  const ce = (l, part, where = '') => editable ? ` contenteditable="plaintext-only" spellcheck="false" data-line data-part="${part}"${where}${l.text ? '' : ' data-empty'}` : '';
  const body = l => lineHtml ? lineHtml(l) : inline(l);
  const merge = (l, base) => { const k = lineClass?.(l); return k ? ` class="${esc(base ? `${base} ${k}` : k)}"` : base ? ` class="${base}"` : ''; };
  let out = '';
  if (name) out += `<header><h1${at(name)}${cls(name)}${ce(name, 'header')}>${body(name)}</h1>${contacts.length ? `<p class="contact">${contacts.map(l => `<span${at(l)}${cls(l)}${ce(l, 'header')}>${body(l)}</span>`).join('<span class="sep"> · </span>')}</p>` : ''}</header>`;
  for (const s of c.sections) {
    const sw = ` data-section="${esc(s.id)}"`;
    out += `<section${at(s)} data-kind="${esc(s.kind)}">${s.title ? `<h2${at(s.title)}${cls(s.title)}${ce(s.title, 'title', sw)}>${body(s.title)}</h2>` : ''}`;
    for (const e of s.entries) {
      const ew = `${sw} data-entry="${esc(e.id)}"`;
      out += `<div class="entry"${at(e)}>`;
      // 抬头里原文隔开的几栏（「Contoso Robotics  Austin, TX」，两格以上空白）：只读的时候拉开一点，读起来和原版一样分得清；文字不变。
      const hb = l => editable || lineHtml ? body(l) : gapped(body(l));
      if (e.head.length) out += `<div class="head">${e.head.map((l, i) => i ? `<p${at(l)}${cls(l)}${ce(l, 'head', ew)}>${hb(l)}</p>` : `<h3${at(l)}${cls(l)}${ce(l, 'head', ew)}>${hb(l)}</h3>`).join('')}</div>`;
      let ul = false;
      for (const l of e.lines) {
        if (l.bullet !== ul) { out += ul ? '</ul>' : '<ul>'; ul = l.bullet; }
        out += l.bullet ? `<li${at(l)}${cls(l)}${ce(l, 'lines', ew)}>${body(l)}</li>` : `<p${merge(l, 'line')}${at(l)}${ce(l, 'lines', ew)}>${body(l)}</p>`;
      }
      out += `${ul ? '</ul>' : ''}${editable ? `<button type="button" class="rs-plus" data-plus="${esc(e.id)}" data-plus-section="${esc(s.id)}" aria-label="加一段或一节" tabindex="-1">+</button>` : ''}</div>`;
    }
    out += '</section>';
  }
  return out;
}
