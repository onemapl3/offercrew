import { evidenceLabel } from './labels.js';
import { evidenceSummary, evidenceSafe } from './evidence-summary.js';
// 证据 / 日志在页面里看（负责人 10-04：「查看日志的时候提示我 404 还是啥」）：/api/evidence?file=… 的链接不再开新窗口，
// 点了在当前页上盖一层，用这一页自己的登录（cookie）去读。先给步骤摘要，诊断原文按需展开；截图/PDF/网页有明确的读取结果。
// 按住 ⌘ / Ctrl / Shift 点的照浏览器的老规矩开。
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rawHtml = '<details class="ev-raw"><summary>诊断原文（高级）</summary><pre class="ev-text"></pre></details>';
const emptyHtml = '<p class="ev-msg">这份记录没有正文。当前进度和业务结果请回到对应任务查看。</p>';
function archivedHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]').forEach(el => el.remove());
  if (!doc.body.textContent.trim() && !doc.body.querySelector('img[src^="data:"]')) return null;
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'"; doc.head.prepend(policy);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

export async function openEvidence(href, { leads = [], context = '' } = {}) {
  const ref = new URL(href, location.href).searchParams.get('file') || '', name = evidenceLabel(ref);
  const dlg = document.createElement('dialog');
  dlg.className = 'ev-view';
  dlg.innerHTML = `<div class="ev-head"><b>${esc(name)}</b><button type="button" class="secondary" data-ev-close>关闭</button></div>${context ? `<p class="ev-context">${esc(context)}</p>` : ''}<div class="ev-body"><p class="ev-msg" role="status">正在打开…</p></div><div class="ev-foot"><span>记录保留执行当时的事实；当前进度和结果以任务、岗位为准。</span><a href="#tasks" data-ev-task>查看任务</a></div>`;
  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-ev-close], [data-ev-task]')) close(); });
  document.body.append(dlg);
  dlg.showModal();
  const body = dlg.querySelector('.ev-body');
  try {
    const r = await fetch(href, { credentials: 'same-origin' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok) { let why = ''; try { why = (await r.json()).error || ''; } catch { /* 非 JSON 错误响应仍显示 HTTP 状态。 */ } throw Error(r.status === 404 || why === '文件不存在' ? '证据文件不存在或已被移走；执行记录仍保留。' : /不允许访问|仅可打开/.test(why) ? '这份记录不是可预览的证据文件，请回任务或材料页查看结果。' : why || `打不开（${r.status}）`); }
    if (/^(text\/plain|application\/json)/.test(type)) {
      const text = await r.text();
      if (!text.trim()) { body.innerHTML = emptyHtml; return; }
      let json = null; try { json = JSON.parse(text); } catch { /* 普通日志继续展示原文。 */ }
      if (json && typeof json === 'object') {
        const summary = evidenceSummary(json, { leads });
        body.innerHTML = `${summary.length ? `<dl class="ev-summary">${summary.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : '<p class="ev-msg">这份记录只保留了诊断细节，没有独立的业务结果。需要排查时可展开原文。</p>'}${rawHtml}`;
        body.querySelector('pre').textContent = JSON.stringify(evidenceSafe(json), null, 2);
      } else if (/\.(log|json)$/i.test(ref)) {
        body.innerHTML = `<p class="ev-msg">保存了 ${text.trim().split(/\r?\n/).length} 行诊断文本，供排查执行问题时查看。</p>${rawHtml}`;
        body.querySelector('pre').textContent = evidenceSafe(text);
      } else { const pre = document.createElement('pre'); pre.className = 'ev-text'; pre.textContent = evidenceSafe(text); body.replaceChildren(pre); }
      return;
    }
    if (/^image\//.test(type)) {
      // The page permits same-origin images, not blob: images. Keep the
      // registered evidence URL and surface decode/read failures explicitly.
      const img = document.createElement('img');
      img.className = 'ev-img'; img.alt = name; img.src = href;
      body.replaceChildren(img);
      try { await img.decode(); } catch { throw Error('证据图片无法加载，文件可能已损坏或被移走'); }
      return;
    }
    if (/^text\/html/.test(type)) {
      const html = archivedHtml(await r.text());
      if (!html) { body.innerHTML = emptyHtml; return; }
      const frame = document.createElement('iframe'); frame.className = 'ev-frame'; frame.title = name; frame.setAttribute('sandbox', ''); frame.srcdoc = html; body.replaceChildren(frame); return;
    }
    if (/^application\/pdf/.test(type)) {
      if (!(await r.blob()).size) { body.innerHTML = emptyHtml; return; }
      body.innerHTML = `<p class="ev-msg">PDF 预览；若浏览器未显示文档，可<a href="${esc(href)}" target="_blank" rel="noopener" data-ev-native>单独打开</a>或<a href="${esc(href)}" download data-ev-native>下载文件</a>。</p><iframe class="ev-frame" src="${esc(href)}" title="${esc(name)}"></iframe>`; return;
    }
    throw Error('这种文件暂时不能在这里预览，请回对应任务查看结果。');
  } catch (e) { body.innerHTML = `<p class="ev-msg bad" role="alert">${esc(e.message || '打不开')}</p>`; }
}

// 整个页面上的证据链接都走这里（各页还是普通的 <a href="/api/evidence?…">，不用一处处改）。
export function bindEvidenceLinks(root = document, { leads = () => [] } = {}) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="/api/evidence"]');
    if (!a || a.hasAttribute('data-ev-native') || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openEvidence(a.getAttribute('href'), { leads: leads(), context: a.closest('.event-row')?.querySelector('.event-text > p')?.textContent || '' });
  }, true);
}
