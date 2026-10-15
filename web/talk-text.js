// 只渲染对话需要的 Markdown 子集；所有普通文字先转义，链接限定为网页或站内地址。
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeHref = s => /^(?:https?:\/\/|#|\/(?!\/))/.test(s) && !/[\s<>"']/.test(s);
function inline(text, lead = () => null, numberLink = null) {
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)|(https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+)|#(\d{1,6})(?!\d)/g;
  let html = '', at = 0;
  for (const m of String(text).matchAll(re)) {
    html += esc(text.slice(at, m.index)); at = m.index + m[0].length;
    if (m[1]) html += `<code>${esc(m[1])}</code>`;
    else if (m[2]) html += `<b>${inline(m[2], lead, numberLink)}</b>`;
    else if (m[3]) html += safeHref(m[4]) ? `<a href="${esc(m[4])}"${/^https?:/.test(m[4]) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(m[3])}</a>` : esc(m[0]);
    else if (m[5]) {
      // 自由文字里的中文、全角标点不属于网址；句尾英文标点也留在链接外。
      const url = m[5].replace(/[.,;:!?]+$/, '');
      html += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(m[5].slice(url.length))}`;
    }
    else if (numberLink) html += numberLink(Number(m[6]));
    else { const r = lead(Number(m[6])); html += r ? `<a href="#lead/${encodeURIComponent(r.rid)}" class="tk-num" data-reveal="${esc(r.rid)}" title="${esc([r.company, r.role].filter(Boolean).join(' · '))}">#${m[6]}</a>` : esc(m[0]); }
  }
  return html + esc(text.slice(at));
}
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
export function renderTalkText(text, options = {}) {
  const lines = String(text ?? '').split('\n'), result = [], lead = options.lead, numberLink = options.numberLink;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && lines[i + 1] && cells(lines[i + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      const head = cells(lines[i]), rows = []; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      result.push(`<div class="tk-table"><table><thead><tr>${head.map(s => `<th>${inline(s, lead, numberLink)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${head.map((_, k) => `<td>${inline(row[k] || '', lead, numberLink)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else { const h = /^#{1,6}\s+(.+)$/.exec(lines[i]); result.push(h ? `<b>${inline(h[1], lead, numberLink)}</b>` : inline(lines[i], lead, numberLink)); }
  }
  return result.join('\n');
}
