// 浏览器打开不存在的地址时仍能返回团队；接口调用继续收到 JSON 错误。
import { PAGES, href } from './routes.mjs';

export const isDocumentRequest = req => req.method === 'GET' && (req.headers['sec-fetch-dest'] === 'document' || /\btext\/html\b/.test(req.headers.accept || ''));
export function notFoundPage() {
  const nav = ['command', 'team', 'tasks', 'inbox', 'materials', 'stream', 'settings'].map(p => `<a href="/${href[p]()}" data-page="${p}">${PAGES[p]}</a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>页面不存在 · OfferCrew</title><link rel="stylesheet" href="/style.css"></head><body><aside class="sidebar"><a class="brand" href="/#command">OfferCrew</a><nav aria-label="主导航">${nav}</nav></aside><div class="shell"><main id="main"><div class="page-heading"><h1>页面不存在</h1></div><p>这个链接已失效，或地址不完整。</p><a class="primary" href="/#team">返回团队</a></main></div></body></html>`;
}
