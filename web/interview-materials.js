// 已有面试资料的只读入口。登记内容当作数据，永不执行原文 HTML。
import { getJson } from './resume-api.js';
import { renderTalkText } from './talk-text.js';
import { esc } from './resume-paper.js';

const home = '#materials?tab=interviews';
const stamp = s => String(s || '').slice(0, 10);
const webUrl = s => /^https?:\/\//i.test(String(s || '')) ? s : null;
let sig = null, sequence = 0, mountedRoute = null;
export const interviewSig = () => sig;
export function leaveInterview() { sequence++; mountedRoute = null; }
export function mountInterviewCss() {
  if (document.querySelector('link[data-interview-css]')) return;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/interview-materials.css'; l.dataset.interviewCss = '1'; document.head.append(l);
}
export function interviewListHtml(v = {}) {
  const groups = new Map();
  for (const item of v.items || []) { const name = item.company || '通用'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(item); }
  if (!groups.size) return '<section class="rs-card im-empty"><h2>面试资料</h2><p>还没有面试资料。岗位的「怎么准备」和已有的通用讲义会收在这里。</p></section>';
  return `<p class="im-library-count">共 ${(v.items || []).length} 份资料</p><div class="im-groups">${[...groups].sort(([a], [b]) => a === '通用' ? 1 : b === '通用' ? -1 : a.localeCompare(b)).map(([name, items]) => {
    const categories = new Map();
    for (const x of [...items].sort((a, b) => (a.category_order || 0) - (b.category_order || 0) || (a.order || 0) - (b.order || 0))) { const category = x.category || '已登记资料'; if (!categories.has(category)) categories.set(category, []); categories.get(category).push(x); }
    return `<section class="rs-card im-group"><header><h2>${esc(name)}</h2><span class="rs-count">${items.length}</span></header>${[...categories].map(([category, entries]) => `${categories.size > 1 || category !== '已登记资料' ? `<h3 class="im-category">${esc(category)}<span>${entries.length}</span></h3>` : ''}${entries.map(x => `<a class="im-row" href="${esc(x.href)}"><span><b>${esc(x.title)}</b><small>${esc([x.version_label, x.number ? `#${x.number}` : '', x.record_missing ? '原岗位不在当前库' : '', x.source_label, stamp(x.updated_at)].filter(Boolean).join(' · '))}</small></span><span aria-hidden="true">打开 →</span></a>`).join('')}`).join('')}</section>`;
  }).join('')}</div>`;
}
const slug = text => String(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
function materialText(text) {
  // 图片只来自本机已登记文件接口；原文中的外站图片仍作为文字，不发出跟踪请求。
  const image = /!\[([^\]\n]*)\]\((\/api\/materials\/interview\/file\?key=[A-Za-z0-9_%:-]+&asset=[A-Za-z0-9_-]+)\)/g;
  let html = '', at = 0;
  for (const m of text.matchAll(image)) {
    html += renderTalkText(text.slice(at, m.index));
    html += `<figure class="im-figure"><a class="im-image-link" href="${esc(m[2])}" target="_blank" rel="noopener noreferrer" aria-label="查看配图：${esc(m[1])}"><img src="${esc(m[2])}" alt="${esc(m[1])}" loading="lazy"></a>${m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : ''}</figure>`;
    at = m.index + m[0].length;
  }
  return html + renderTalkText(text.slice(at));
}
function markdown(text) {
  const parts = [], headings = [], ids = new Map(); let chunk = [], title = null, fence = null, code = [];
  const flush = () => { if (chunk.length) parts.push(`<div class="im-prose">${materialText(chunk.join('\n'))}</div>`); chunk = []; };
  const flushCode = () => { parts.push(`<pre class="im-code"><code>${esc(code.join('\n'))}</code></pre>`); code = []; fence = null; };
  for (const line of String(text || '').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) flushCode(); else code.push(line); continue; }
    if (marker) { flush(); fence = marker[1]; continue; }
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!m) { chunk.push(line); continue; }
    if (!title && !parts.length && !chunk.some(x => x.trim()) && m[1].length === 1) { title = m[2]; chunk = []; continue; }
    flush(); const base = slug(m[2]) || 'section', count = ids.get(base) || 0, id = base + (count ? `-${count}` : ''), level = Math.min(6, m[1].length + 1); ids.set(base, count + 1);
    parts.push(`<h${level} id="${esc(id)}">${renderTalkText(m[2])}</h${level}>`);
    if (m[1].length <= 2) headings.push({ id, text: m[2] });
  }
  if (fence) flushCode(); flush(); return { html: parts.join(''), headings, title };
}
export function documentHtml(body) {
  const doc = new DOMParser().parseFromString(String(body || ''), 'text/html');
  const allowed = new Set(['p', 'b', 'strong', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'code', 'pre', 'br', 'hr']);
  const blocked = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'img', 'input', 'button', 'form', 'title']);
  function render(node) {
    if (node.nodeType === 3) return esc(node.textContent);
    if (node.nodeType !== 1 || blocked.has(node.localName)) return '';
    const tag = node.localName, inner = [...node.childNodes].map(render).join('');
    if (tag === 'a') { const url = webUrl(node.getAttribute('href')); return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner; }
    if (tag === 'checkbox') return `<span>${node.getAttribute('checked') === 'true' ? '☑' : '☐'} ${inner}</span>`;
    if (!allowed.has(tag)) return inner;
    const safeTag = /^h[1-4]$/.test(tag) ? `h${Math.min(5, +tag[1] + 1)}` : tag;
    return `<${safeTag}>${inner}</${safeTag}>`;
  }
  return [...doc.body.childNodes].map(render).join('');
}
export async function interviewPage(_ctx, route) {
  mountInterviewCss(); const request = ++sequence, startingHash = location.hash;
  let v;
  try { v = await getJson(`/api/materials/interview?key=${encodeURIComponent(route.key || '')}`); }
  catch (e) { if (request !== sequence || location.hash !== startingHash) return ''; sig = `interview-error:${route.key}:${e.message}`; return `<div class="rs im" id="rs" data-route="interview" data-interview-route="${esc(startingHash)}"><a href="${home}">← 面试资料</a><p class="rs-error">${esc(e.message)}</p></div>`; }
  if (request !== sequence || location.hash !== startingHash) return '';
  sig = `interview:${v.key}:${v.content_sig || v.reason || ''}`;
  let body = '', headings = [], title = v.title;
  if (v.format === 'markdown') { const md = markdown(v.body); body = md.html; headings = md.headings; title = md.title || title; }
  else if (v.format === 'document') body = documentHtml(v.body);
  else if (v.format === 'sections') body = (v.sections || []).map(s => `<h2>${esc(s.title)}</h2><ul>${s.items.map(x => `<li>${esc(x.text)}${x.sources?.length ? `<small>出自：${esc(x.sources.join('、'))}</small>` : ''}</li>`).join('')}</ul>`).join('');
  else body = `<p class="${v.format === 'unavailable' ? 'rs-error' : 'muted'}">${esc(v.reason || '暂无可预览正文')}</p>`;
  return `<div class="rs im" id="rs" data-route="interview" data-interview-route="${esc(startingHash)}"><header class="im-head"><a href="${home}">← 面试资料</a><span class="rs-sp"></span>${v.record_id && !v.record_missing ? `<a href="#lead/${encodeURIComponent(v.record_id)}?tab=co">#${esc(v.number || '—')} 岗位</a>` : ''}${v.download_url ? `<a href="${esc(v.download_url)}" download>下载本地原件</a>` : ''}${webUrl(v.source_url) ? `<a href="${esc(v.source_url)}" target="_blank" rel="noopener noreferrer">原网页参考 ↗</a>` : ''}</header><article class="rs-card im-paper"><header><p class="muted">${esc([v.company || '通用', v.category, v.version_label, v.record_missing ? '原岗位不在当前库' : '', v.source_label, stamp(v.updated_at)].filter(Boolean).join(' · '))}</p><h1>${esc(title)}</h1>${v.attachments?.length ? `<nav class="im-attachments" aria-label="本地附件">${v.attachments.map(f => `<a href="${esc(f.href)}" download>${esc(f.title)}</a>`).join('')}</nav>` : ''}</header>${headings.length > 3 ? `<details class="im-contents"><summary>目录</summary><nav>${headings.map(x => `<a href="#${esc(x.id)}" data-im-section="${esc(x.id)}">${esc(x.text)}</a>`).join('')}</nav></details>` : ''}<div class="im-content">${body}</div></article></div>`;
}
export function mountInterview() {
  const scroll = section => {
    let id; try { id = decodeURIComponent(section); } catch { id = section; }
    const target = document.getElementById(id) || [...document.querySelectorAll('.im-content [id]')].find(el => el.id.startsWith(id + '-'));
    target?.scrollIntoView({ block: 'start' });
  };
  document.querySelectorAll('[data-im-section]').forEach(a => { a.onclick = e => { e.preventDefault(); scroll(a.dataset.imSection); }; });
  document.querySelectorAll('.im-content a[href^="#"]').forEach(a => {
    const hash = a.getAttribute('href');
    if (hash.startsWith('#materials/')) return;
    a.onclick = e => { e.preventDefault(); scroll(hash.slice(1)); };
  });
  const root = document.querySelector('[data-interview-route]'), hash = root?.dataset.interviewRoute;
  if (hash && hash !== mountedRoute) {
    mountedRoute = hash;
    const section = new URLSearchParams(hash.split('?')[1] || '').get('section');
    // app.js 会先恢复同类页面的滚动位置；换讲义/章节后再定位，后台刷新则保留阅读位置。
    requestAnimationFrame(() => { if (root.isConnected && location.hash === hash) { if (section) scroll(section); else window.scrollTo(0, 0); } });
  }
}
