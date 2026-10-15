// Tencent careers (careers.tencent.com). The public Query endpoint returns the
// responsibility block only; the per-post endpoint adds the requirement block,
// so `detail` fills in whatever the list left short.
//
// 校招和实习不在 careers.tencent.com，在校招站 join.qq.com：它的搜索接口 /api/v1/position/searchPosition
// 和详情接口 /api/v1/jobDetails/getJobDetailsByPostId 都是公开的（2026-09-29 用标明身份的请求头核对过，
// 当天 994 个岗位，财经线培训生也在里面）。岗位属于某个「项目」：应届毕业生、青云计划是校招，
// 应届实习是实习。读哪几类按候选人的阶段来（lib/ats/recruit.mjs）；软件方向照旧只读社招。
import { json, plain, lead } from "./http.mjs";
import { CN_USER_AGENT, cnText, searchCities } from "./cn.mjs";
import { recruitTypesOf } from "./recruit.mjs";

const headers = { "User-Agent": CN_USER_AGENT, Referer: "https://careers.tencent.com/search.html" };
// "2026年09月08日" is the only timestamp the portal publishes.
const publishedAt = (s) => {
  const m = String(s || "").match(/(\d{4})年(\d{2})月(\d{2})日/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const secureUrl = (u, postId) =>
  u ? u.replace(/^http:/, "https:") : `https://careers.tencent.com/jobdesc.html?postId=${postId}`;

export const describe = (p) =>
  cnText(plain(p.Responsibility), plain(p.Requirement), plain(p.ImportantItem), p.RequireWorkYearsName ? plain(`经验要求：${p.RequireWorkYearsName}`) : "");

export const normalize = (c, data) =>
  (data.Data?.Posts || []).map((p) =>
    lead(c, {
      role: p.RecruitPostName,
      location: [p.CountryName, p.LocationName].filter(Boolean).join(" "),
      url: secureUrl(p.PostURL, p.PostId),
      recruit_type: "social",
      posted_at: publishedAt(p.LastUpdateTime),
      jd_text: describe(p),
      source_job_id: String(p.PostId),
    }),
  );

const social = (c) =>
  searchCities(c, async (company, keyword, index, size) => {
    const query = new URLSearchParams({
      timestamp: String(Date.now()),
      keyword,
      pageIndex: String(index + 1),
      pageSize: String(size),
      language: "zh-cn",
      area: "cn",
    });
    const data = await json(`${company.origin}/tencentcareer/api/post/Query?${query}`, { headers });
    if (data.Code !== 200) throw Error(`tencent_search_failed_${data.Code}`);
    return { leads: normalize(company, data), total: data.Data?.Count ?? 0 };
  });

const campusOrigin = (c) => c.campus_origin || "https://join.qq.com";
export const campusUrl = (c, postId) => `${campusOrigin(c)}/post_detail.html?postid=${postId}`;
export const normalizeCampus = (c, data) =>
  (data?.data?.positionList || []).filter((p) => p.postId && p.positionTitle).map((p) =>
    lead(c, {
      role: String(p.positionTitle).trim(),
      location: String(p.workCities || "").trim().split(/\s+/).filter(Boolean).join(" / "),
      url: campusUrl(c, p.postId),
      recruit_type: /实习/.test(`${p.projectName || ""} ${p.recruitLabelName || ""}`) ? "intern" : "campus",
      posted_at: null,
      // 列表只有标题、项目和城市：职责和要求在详情接口里，匹配前由 detail 取。
      jd_text: "",
      summary: [p.projectName && `项目：${p.projectName}`, p.bgs && `事业群：${String(p.bgs).trim()}`].filter(Boolean).join("；"),
      source_job_id: String(p.postId),
    }),
  );
const campus = (c) =>
  searchCities(c, async (company, keyword, index, size) => {
    const url = `${campusOrigin(company)}/api/v1/position/searchPosition?timestamp=${Date.now()}`;
    const data = await json(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: `${campusOrigin(company)}/post.html` },
      body: JSON.stringify({
        projectIdList: [], projectMappingIdList: [], keyword, bgList: [], workCountryType: 0,
        workCityList: [], recruitCityList: [], positionFidList: [], pageIndex: index + 1, pageSize: size,
      }),
    });
    if (data?.status !== 0) throw Error(`tencent_campus_search_failed_${data?.status}: ${url}`);
    return { leads: normalizeCampus(company, data), total: data.data?.count ?? 0 };
  });

export async function fetchJobs(c) {
  const wanted = recruitTypesOf(c), out = [];
  if (wanted.includes("social")) out.push(...(await social(c)));
  if (wanted.some((t) => t !== "social")) out.push(...(await campus(c)).filter((l) => wanted.includes(l.recruit_type)));
  return out;
}

export async function detail(c, l) {
  if (l.recruit_type === "campus" || l.recruit_type === "intern") {
    const url = `${campusOrigin(c)}/api/v1/jobDetails/getJobDetailsByPostId?postId=${encodeURIComponent(l.source_job_id)}`;
    const data = await json(url, { headers: { Referer: campusUrl(c, l.source_job_id) } });
    const d = data?.data || {};
    if (data?.status !== 0 || !(d.desc || d.request)) throw Error(`tencent_campus_detail_failed_${data?.status}: ${url}`);
    return { ...l, jd_text: cnText(plain(d.desc), plain(d.request), d.tidName ? `类别：${d.tidName}` : "") };
  }
  const data = await json(
    `${c.origin}/tencentcareer/api/post/ByPostId?postId=${encodeURIComponent(l.source_job_id)}&language=zh-cn`,
    { headers },
  );
  if (data.Code !== 200) throw Error(`tencent_detail_failed_${data.Code}`);
  const p = data.Data || {};
  return { ...l, jd_text: describe(p) || l.jd_text, posted_at: publishedAt(p.LastUpdateTime) || l.posted_at };
}
