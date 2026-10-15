// NetEase careers (hr.163.com). The public queryPage endpoint returns the full
// description and requirement, so no detail round trip is needed.
import { json, plain, lead } from "./http.mjs";
import { CN_USER_AGENT, cnText, searchCities } from "./cn.mjs";

export const normalize = (c, data) =>
  (data.data?.list || []).map((j) =>
    lead(c, {
      role: j.name,
      location: (j.workPlaceNameList || []).join(" / "),
      // lang=zh：网易招聘按浏览器语言切中英文站，英文站的详情页会跳回首页（10-05 #316，lib/landing.mjs）。
      // 去重按规范写法认（lib/dedupe.mjs 去掉 hr.163.com 的 lang），以前存的不带 lang 的同一个岗位不会另起一条。
      url: `${c.origin}/job-detail.html?id=${j.id}&lang=zh`,
      posted_at: Number(j.updateTime) ? new Date(Number(j.updateTime)).toISOString() : null,
      jd_text: cnText(
        plain(j.description),
        plain(j.requirement),
        [j.reqEducationName && `学历要求：${j.reqEducationName}`, j.reqWorkYearsName && `经验要求：${j.reqWorkYearsName}`, j.productName && `团队：${j.productName}`]
          .filter(Boolean)
          .join("；"),
      ),
      source_job_id: String(j.id),
    }),
  );

export const fetchJobs = (c) =>
  searchCities(c, async (company, keyword, index, size) => {
    const data = await json(`${company.origin}/api/hr163/position/queryPage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CN_USER_AGENT, Referer: "https://hr.163.com/job-list.html" },
      body: JSON.stringify({ currentPage: index + 1, pageSize: size, keyword, postWorkTypeList: [], workplaceList: [] }),
    });
    if (data.code !== 200) throw Error(`netease_search_failed_${data.code}`);
    return { leads: normalize(company, data), total: data.data?.total ?? 0 };
  });
