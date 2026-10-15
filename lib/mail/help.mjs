// 「怎么拿授权码」那一页（GET /help/mail-auth-code，bin/serve.mjs）：把 docs/mail-auth-code.md 排成一页 HTML。
// 界面上的「怎么拿授权码」链接指到这里对应的那一节（#qq、#163、#icloud、#gmail、#yahoo）。
// 只认这份文档用到的几种写法：标题、段落、编号和圆点列表、**粗体**、`代码`、[文字](https://…)，以及单独一行的 <a id="…"></a>。
// 其余一律当普通文字转义；页面不带脚本。
import fs from 'node:fs';
import path from 'node:path';

const DOC = path.resolve(import.meta.dirname, '../../docs/mail-auth-code.md');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+|#[a-z0-9-]+)\)/g, (_, t, u) => `<a href="${u}"${u.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"'}>${t}</a>`);
}
export function renderHelp(md = fs.readFileSync(DOC, 'utf8')) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const line of md.split('\n')) {
    const anchor = line.match(/^<a id="([a-z0-9-]+)"><\/a>$/);
    const h = line.match(/^(#{1,3})\s+(.+)$/), ol = line.match(/^\d+\.\s+(.+)$/), ul = line.match(/^[-*]\s+(.+)$/);
    if (anchor) { flushPara(); flushList(); out.push(`<a id="${anchor[1]}"></a>`); }
    else if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (ol || ul) {
      flushPara();
      const tag = ol ? 'ol' : 'ul';
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ol || ul)[1]);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else if (list) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else para.push(line.trim());
  }
  flushPara(); flushList();
  const title = (md.match(/^#\s+(.+)$/m) || [])[1] || '授权码';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#fff;--line:#e5e5ea;--link:#0a7d4f}@media (prefers-color-scheme:dark){:root{--fg:#f2f2f7;--muted:#a1a1a6;--bg:#1c1c1e;--line:#3a3a3c;--link:#5fd4a0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:8px 0 16px}h2{font-size:18px;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:16px}a{color:var(--link)}code{font:13px ui-monospace,Menlo,monospace;background:color-mix(in srgb,var(--fg) 8%,transparent);padding:1px 4px;border-radius:4px}li{margin:4px 0}:target+h2{color:var(--link)}</style>
</head><body><main>${out.join('\n')}</main></body></html>`;
}
