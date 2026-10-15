import { json, plain, lead } from "./http.mjs";
export const normalize = (c, d) =>
  d.content.map((j) =>
    lead(c, {
      role: j.name,
      location: [j.location?.city, j.location?.country].filter(Boolean).join(", "),
      url: j.ref || `https://jobs.smartrecruiters.com/${c.board}/${j.id}`,
      posted_at: j.releasedDate || null,
      jd_text: plain(
        Object.values(j.jobAd?.sections || {})
          .map((s) => s.text)
          .join(" "),
      ),
      source_job_id: j.id,
    }),
  );
export async function fetchJobs(c) {
  let out = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const d = await json(`https://api.smartrecruiters.com/v1/companies/${c.board}/postings?limit=100&offset=${offset}`);
    out.push(...normalize(c, d));
    if (out.length >= d.totalFound) return out;
    if (!d.content.length) throw Error("smartrecruiters_pagination_stalled");
  }
  throw Error("smartrecruiters_pagination_limit");
}
export async function detail(c, l) {
  const d = await json(`https://api.smartrecruiters.com/v1/companies/${c.board}/postings/${l.source_job_id}`);
  return {
    ...l,
    url: d.applyUrl || `https://jobs.smartrecruiters.com/${c.board}/${l.source_job_id}`,
    jd_text: plain(
      Object.values(d.jobAd?.sections || {})
        .map((s) => s.text)
        .join(" "),
    ),
  };
}
