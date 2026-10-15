// Conservative read-only probe for official pages with Schema.org JobPosting.
// A reachable SPA, category count or corporate address is not a job posting.
import { request, plain, lead, challenged } from './http.mjs';
import { cityGate, citiesOf } from './cn.mjs';
export function normalize(c, html) {
  return postings(c, html).jobs;
}
// 页面上的结构化岗位：jobs 是目标城市的，found 是一共认出几条（不分城市）。
export function postings(c, html) {
  const jobs = new Map(), cities = citiesOf(c);
  let found = 0;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ([value['@type']].flat().includes('JobPosting')) {
      const places = [value.jobLocation].flat().filter(Boolean);
      const location = places.map(p => [p.address?.addressLocality, p.address?.addressRegion, p.address?.addressCountry].filter(Boolean).join(', ')).join(' / ');
      let url; try { url = new URL(value.url, c.careers_url).href; } catch { return; } // 兜底：写得不像网址的那一条跳过
      if (!value.url || !/^https?:/.test(url) || !value.title || !value.description) return;
      found++;
      const l = cityGate(c, lead(c, { role: value.title, location, url, jd_text: plain(value.description), posted_at: value.datePosted || null, source_job_id: String(value.identifier?.value || url) }), cities);
      if (l) jobs.set(url, l);
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* 兜底：结构化数据写坏了不能用来开一个招聘源，跳过；Invalid structured data cannot enable a source. */ }
  }
  return { jobs: [...jobs.values()], found };
}
// 读不到的照实说（10-05）：页面是反爬验证 → bot_challenge；页面上一条结构化岗位都没有（自建的单页程序）→ no_job_list，
// 不是「没有岗位」。认出了岗位、只是不在目标城市的，返回空的，扫描按 cityTally 记成「没有目标城市的岗位」。
export async function fetchJobs(c) {
  const response = await request(c.careers_url), html = await response.text();
  if (challenged(response.status, response.headers, html)) throw Error(`bot_challenge_${response.status}: ${c.careers_url}`);
  const { jobs, found } = postings(c, html);
  if (!found) throw Error(`no_job_list: ${c.careers_url}`);
  return jobs;
}
