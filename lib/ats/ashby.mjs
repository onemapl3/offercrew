import { json, plain, lead } from "./http.mjs";
export const normalize = (c, data) =>
  [...new Map((data.jobs || []).filter(j => j.isListed !== false).map(j => [j.id || j.jobUrl, j])).values()].map((j) =>
    lead(c, {
      role: j.title,
      location: [(j.workplaceType === 'Remote' || j.isRemote ? '远程' : null), j.location, ...(j.secondaryLocations || []).map((x) => x.location)].filter(Boolean).join(" / "),
      url: j.jobUrl,
      posted_at: j.publishedAt || null,
      jd_text: plain(j.descriptionPlain || j.descriptionHtml),
      source_job_id: j.id,
      // 远程岗位的 location 常常只写国家（"China"）：远程与否在这两个字段里，城市规则（lib/city.mjs）读 work_mode。
      work_mode: j.workplaceType || (j.isRemote ? 'Remote' : undefined),
    }),
  );
export async function fetchJobs(c) {
  return normalize(c, await json(`https://api.ashbyhq.com/posting-api/job-board/${c.board}?includeCompensation=true`));
}
