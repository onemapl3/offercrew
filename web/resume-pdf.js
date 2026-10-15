// 原文件预览使用已随引擎打包的 PDF.js；不依赖浏览器 PDF 插件，不执行文档脚本或读取外部资源。
let pdfModule;
export function mountOriginalPdf(box, href, { loadPdf = () => pdfModule ||= import('/vendor/resume-pdfjs.mjs') } = {}) {
  const abort = new AbortController();
  let stopped = false, destroyed = false, loading = null, pdf = null, observer = null, drawing = null, queue = Promise.resolve();
  // PDF.js 6 的文档代理只有 cleanup；loading task 才拥有 worker/transport 的 destroy。
  const destroy = () => {
    if (!loading || destroyed) return Promise.resolve();
    destroyed = true;
    return Promise.resolve().then(() => loading.destroy()).catch(() => {});
  };
  const status = document.createElement('p'); status.className = 'su-resume-file-note'; status.setAttribute('role', 'status'); status.textContent = '正在打开原始 PDF…'; box.replaceChildren(status);
  const fail = message => { if (!stopped) { status.classList.add('su-err'); status.setAttribute('role', 'alert'); status.textContent = message; } };
  (async () => {
    const r = await fetch(href, { signal: abort.signal });
    if (!r.ok) { let why = ''; try { why = (await r.json()).error || ''; } catch {} throw Error(why || '原文件暂时无法读取'); }
    const bytes = new Uint8Array(await r.arrayBuffer());
    const { getDocument } = await loadPdf();
    if (stopped) return;
    loading = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, disableFontFace: true, useWorkerFetch: false, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' });
    pdf = await loading.promise;
    if (stopped) { await destroy(); return; }
    status.textContent = `原始 PDF · 共 ${pdf.numPages} 页`;
    const render = async figure => {
      if (stopped || figure.dataset.state !== 'waiting') return;
      figure.dataset.state = 'loading';
      const n = Number(figure.dataset.page), page = await pdf.getPage(n);
      if (stopped) return;
      const base = page.getViewport({ scale: 1 }), width = Math.min(900, Math.max(480, box.clientWidth - 32));
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); canvas.setAttribute('aria-label', `原始 PDF 第 ${n} 页`);
      drawing = page.render({ canvasContext: canvas.getContext('2d'), viewport }); await drawing.promise;
      if (stopped) return;
      figure.prepend(canvas); figure.dataset.state = 'ready'; figure.style.minHeight = ''; page.cleanup();
    };
    observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) if (isIntersecting) {
        observer.unobserve(target);
        queue = queue.then(() => render(target)).catch(() => { if (!stopped) { target.dataset.state = 'failed'; target.querySelector('figcaption').textContent += ' · 这一页无法显示，可下载原文件查看'; } });
      }
    }, { root: box, rootMargin: '500px' });
    for (let n = 1; n <= pdf.numPages; n++) {
      const figure = document.createElement('figure'); figure.dataset.page = String(n); figure.dataset.state = 'waiting'; figure.style.minHeight = `${Math.max(400, (box.clientWidth - 32) * 1.414)}px`;
      const caption = document.createElement('figcaption'); caption.textContent = `第 ${n} / ${pdf.numPages} 页`; figure.append(caption); box.append(figure); observer.observe(figure);
    }
  })().catch(e => { if (!stopped && e.name !== 'AbortError') fail(`${e.message || '原始 PDF 无法显示'}。可以下载原文件，或查看提取的文字。`); });
  return () => { if (stopped) return; stopped = true; abort.abort(); observer?.disconnect(); drawing?.cancel(); void destroy(); };
}
