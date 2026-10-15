// 搜好的入口（lib/entry-sources.mjs）：引导「渠道」一步和「设置 → 求职偏好 → 渠道」共用。
// 每个平台一行：名字、按你的细分和城市填好的链接（新窗口打开）、地址放不进搜索词的站给能复制的词、「加为来源」开关。
// 加上 / 撤掉走 POST /api/onboarding/entries，调用方存完重新读一遍再画。不加说明文字，只有「需要能访问国际互联网」这一句。
const T = { label: '搜好的入口', add: '加为来源', added: '已加', undo: '撤掉', copy: '复制', copied: '已复制', net: '需要能访问国际互联网' };

// entries：GET /api/onboarding 的 channels.entries（null = 这个方向没有，什么都不画）。
export function entriesHtml(entries, esc) {
  const items = entries?.items || [];
  if (!items.length) return '';
  const item = e => {
    const words = !e.keywords_in_url && e.keywords?.length ? e.keywords.join(' ') : '';
    return `<li class="ce-item${e.added ? ' on' : ''}" data-ce-item="${esc(e.key)}">`
      + `<div class="ce-head"><b>${esc(e.name)}</b>${e.needs_international ? `<small class="ce-net">${esc(T.net)}</small>` : ''}`
      + `<button type="button" class="ob-chip ce-toggle${e.added ? ' on' : ''}" data-ce-key="${esc(e.key)}" data-ce-preset="${esc(e.preset || '')}" aria-pressed="${!!e.added}"${e.added ? ` title="${esc(T.undo)}"` : ''}>${esc(e.added ? `✓ ${T.added}` : T.add)}</button></div>`
      + (e.links?.length ? `<div class="ce-links">${e.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}</div>` : '')
      + (words ? `<div class="ce-copy"><span class="ce-words">${esc(words)}</span><button type="button" class="secondary mini" data-ce-copy="${esc(words)}">${esc(T.copy)}</button></div>` : '')
      + '</li>';
  };
  return `<div class="ce"><p class="ob-label">${esc(T.label)}</p><ul class="ce-list">${items.map(item).join('')}</ul></div>`;
}

// 已经加上的入口名字（总结一行用）。
export const addedNames = entries => (entries?.items || []).filter(e => e.added).map(e => e.name);

// 点击：加上 / 撤掉交给 save(body)（调用方发请求、重读、重画）；复制只在本机剪贴板。返回 true = 这一下是入口的。
export function entriesClick(t, { save, toast }) {
  const d = t?.dataset || {};
  if (d.ceKey) {
    const on = t.getAttribute('aria-pressed') === 'true';
    save(on ? { key: d.ceKey, action: 'remove' } : { key: d.ceKey, preset: d.cePreset || null, action: 'add' });
    return true;
  }
  if (d.ceCopy != null) {
    const done = () => toast?.(T.copied);
    const fallback = () => { const s = t.parentElement?.querySelector('.ce-words'); if (!s) return; const r = document.createRange(); r.selectNodeContents(s); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(d.ceCopy).then(done, fallback);
    else fallback();
    return true;
  }
  return false;
}
