// 招聘网站的网页标题有固定写法，能直接拆出职位和公司，不用让判断模型从一整行里挑（2026-09-30 真实测试：
// Ashby 的「<职位> @ <公司>」整行被当成了公司名和职位）。拆不开就返回 {}，照旧交给模型。
//   Ashby        「<职位> @ <公司>」
//   Lever        「<公司> - <职位>」
//   Greenhouse   「Job Application for <职位> at <公司>」
import { plain } from './http.mjs';

export function atsTitleParts(title = '', host = '') {
  const t = plain(title), h = String(host || '').toLowerCase();
  const split = (sep, fromEnd = false) => { const i = fromEnd ? t.lastIndexOf(sep) : t.indexOf(sep); return i > 0 && i + sep.length < t.length ? [t.slice(0, i).trim(), t.slice(i + sep.length).trim()] : null; };
  if (/(?:^|\.)ashbyhq\.com$/.test(h)) { const p = split(' @ ', true); if (p) return { role: p[0], company: p[1] }; }
  if (/(?:^|\.)lever\.co$/.test(h)) { const p = split(' - '); if (p) return { company: p[0], role: p[1] }; }
  if (/(?:^|\.)greenhouse\.io$/.test(h)) { const m = /^job application for\s+(.+)\s+at\s+(.+)$/i.exec(t); if (m) return { role: m[1].trim(), company: m[2].trim() }; }
  return {};
}
