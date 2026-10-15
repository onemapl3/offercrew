// Workday 职位站：POST <origin>/wday/cxs/<tenant>/<site>/jobs，每页 20 条。
//
// 大公司要按地点筛：Workday 报的 total 最多是 2000（花旗当天按国家合计 4270），读到 2000 就停了。公司配置写
// applied_facets（同一个接口返回的 facets 里地点、国家的 Id，原样放进请求的 appliedFacets）就只读那一块；地点常按
// 办公楼列，一个城市可能有几十个 Id。
//   applied_facets:
//     locationCountry: [<国家 Id>]
//     locations: [<地点 Id>, …]
// total 正好是 2000 又没写 applied_facets 时，读到的结果带一条 note（也写到 stderr），说明还有没读到的。
//
// 接一个租户之前先看它的 robots.txt 放不放行这个站（花旗 /2/、玛氏 /External/ 都被禁）：node bin/robots-check.mjs <职位站地址>。
import { json, plain, lead } from "./http.mjs";

export const WORKDAY_TOTAL_CAP = 2000;
// 公司配置里的 applied_facets → 请求里的 appliedFacets：每一项都是字符串数组，空的不带。
export function appliedFacets(c) {
  const out = {};
  for (const [key, values] of Object.entries(c.applied_facets || {})) {
    const list = [values].flat().filter((v) => v != null && v !== "").map(String);
    if (list.length) out[key] = list;
  }
  return out;
}
export const normalize = (c, data) =>
  data.jobPostings.map((j) =>
    lead(c, {
      role: j.title,
      location: j.locationsText || "",
      url: `${c.origin}/en-US/${c.site}${j.externalPath}`,
      posted_at: null,
      posted_relative: j.postedOn || null,
      jd_text: plain(j.jobDescription),
      source_job_id: j.externalPath,
    }),
  );
// 读到的结果上留的说明：读到多少、Workday 报的总数、要怎么补。
function capNote(c, out, total) {
  if (total !== WORKDAY_TOTAL_CAP || Object.keys(appliedFacets(c)).length) return out;
  out.note = `workday_total_capped: ${c.name || c.tenant} 读到 ${out.length} 个，Workday 报的总数是封顶值 ${total}，实际更多；大公司要在 companies.yaml 写 applied_facets 按地点筛`;
  process.stderr.write(`${out.note}\n`);
  return out;
}
export async function fetchJobs(c) {
  let out = [],
    offset = 0,
    total = 0;
  const facets = appliedFacets(c);
  for (let page = 0; page < 100; page++) {
    const d = await json(`${c.origin}/wday/cxs/${c.tenant}/${c.site}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: facets, limit: 20, offset, searchText: c.query || "" }),
    });
    // Workday 只在第一页给 total，后面几页的 total 是 0（2026-09-29 核对 Cadence：第二页 total 0、20 条）。
    // 以前拿每一页自己的 total 比，第二页就停：每个 Workday 站最多只读到 40 个。
    if (page === 0) total = Number(d.total) || 0;
    out.push(...normalize(c, d));
    if (out.length >= total) return capNote(c, out, total);
    // 翻的过程中有岗位下线，板子变短了：读到的照样算数。
    if (!d.jobPostings.length) return capNote(c, out, total);
    offset += d.jobPostings.length;
  }
  throw Error(`workday_pagination_limit: ${c.origin}/wday/cxs/${c.tenant}/${c.site}/jobs`);
}
// A Workday posting page is rendered by script, so curl gets an empty shell.
// The same posting is served as JSON at /wday/cxs/<tenant>/<site>/job/<path>,
// which is what the discovery adapter reads. Given a public posting URL such as
// https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Shanghai-China/X_JR1
// this returns that JSON URL, or null for anything that is not a Workday posting.
export function detailUrlFor(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; } // 兜底：写得不像网址就不认
  if (!/\.myworkday(?:jobs|site)\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([^/]+)\/job\/(.+)$/);
  if (!m) return null;
  const tenant = u.hostname.split('.')[0];
  return `${u.origin}/wday/cxs/${tenant}/${m[1]}/job/${m[2]}`;
}
export const detailText = (d) => plain(d?.jobPostingInfo?.jobDescription || '');
export async function detail(c, l) {
  const d = await json(`${c.origin}/wday/cxs/${c.tenant}/${c.site}${l.source_job_id}`);
  return { ...l, jd_text: plain(d.jobPostingInfo?.jobDescription), posted_at: d.jobPostingInfo?.startDate || null };
}
