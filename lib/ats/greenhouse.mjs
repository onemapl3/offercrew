import { json, plain, lead } from "./http.mjs";
export const normalize = (c, data) =>
  data.jobs.map((j) =>
    lead(c, {
      role: j.title,
      location: j.location?.name || "",
      url: j.absolute_url,
      posted_at: j.first_published || null,
      updated_at: j.updated_at || null,
      jd_text: plain(j.content),
      source_job_id: String(j.id),
    }),
  );
export async function fetchJobs(c) {
  return normalize(c, await json(`https://boards-api.greenhouse.io/v1/boards/${c.board}/jobs?content=true`));
}
