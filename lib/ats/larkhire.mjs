// Feishu/Lark hiring portal (atsx-throne). One public POST search endpoint is
// shared by every tenant, so a company only has to declare its origin and the
// path prefix its portal uses for position pages.
// Confirmed tenants: jobs.bytedance.com, poizon.jobs.feishu.cn, sensetime.jobs.feishu.cn.
//
// 同一个租户的校招站（蔚来 nio.jobs.feishu.cn/campus）走同一个搜索接口，只差两个参数：请求头 website-path
// 写站点的 path（页面配置里的 "campus"），body 的 portal_type 写 1（社招门户是 2）。按公司配：
//   website_path: campus
//   portal_type: 1
//   position_path: /campus/position
// 没写的照旧读社招门户（"/" 和 2）。配了这两项的公司，每条岗位按接口的 recruit_type（社招 / 校招，正式 / 实习）
// 和标题记成 social、campus 或 intern。
import { json, plain, lead } from "./http.mjs";
import { CN_USER_AGENT, cnText, searchCities } from "./cn.mjs";
import { internOrCampus } from "./recruit.mjs";

const portalConfigured = (c) => c.website_path != null || c.portal_type != null;
// recruit_type 是两级：上一级「社招 / 校招」，下一级「正式 / 实习」。
export const recruitTypeOf = (j) => {
  const t = j.recruit_type || {}, top = t.parent || t;
  if (/社招|experienced/i.test(`${top.name || ""} ${top.en_name || ""}`)) return "social";
  return internOrCampus(`${t.name || ""} ${t.en_name || ""}`, j.title);
};

const cityNames = (j) =>
  (j.city_list?.length ? j.city_list : [j.city_info])
    .filter(Boolean)
    .map((city) => [city.name, city.en_name].filter(Boolean).join(" "))
    .join(" / ");

export const normalize = (c, data) =>
  (data.data?.job_post_list || data.job_post_list || []).map((j) =>
    lead(c, {
      role: j.title,
      location: cityNames(j),
      url: `${c.origin}${c.position_path}/${j.id}/detail`,
      posted_at: Number(j.publish_time) ? new Date(Number(j.publish_time)).toISOString() : null,
      jd_text: cnText(plain(j.description), plain(j.requirement), plain(j.job_post_info?.address)),
      source_job_id: String(j.id),
      ...(portalConfigured(c) ? { recruit_type: recruitTypeOf(j) } : {}),
    }),
  );

export const fetchJobs = (c) =>
  searchCities(c, async (company, keyword, index, size) => {
    const data = await json(`${company.origin}/api/v1/search/job/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CN_USER_AGENT,
        // The portal resolves the tenant site from Host plus this header; any
        // other value answers "site not exist".
        "website-path": String(company.website_path ?? "/"),
        "portal-channel": "office",
        "portal-platform": "pc",
      },
      body: JSON.stringify({
        keyword,
        limit: size,
        offset: index * size,
        job_category_id_list: [],
        tag_id_list: [],
        // Filtering server side keeps paging honest: without it the target
        // cities can sit past the page budget on a large tenant.
        location_code_list: company.location_codes || [],
        subject_id_list: [],
        recruitment_id_list: [],
        portal_type: Number(company.portal_type ?? 2),
        job_function_id_list: [],
        storefront_id_list: [],
        portal_entrance: 1,
      }),
    });
    if (data.code !== 0) throw Error(`larkhire_search_failed_${data.code}: ${data.message || ""}`);
    return { leads: normalize(company, data), total: data.data?.count ?? 0 };
  });
