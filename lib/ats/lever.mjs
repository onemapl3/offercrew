import { json, plain, lead } from "./http.mjs";
export const normalize = (c, data) =>
  data.map((j) =>
    lead(c, {
      role: j.text,
      location: j.categories?.location || "",
      url: j.hostedUrl,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      jd_text: plain(
        [
          j.descriptionPlain || j.description,
          ...(j.lists || []).map((l) => l.text + " " + l.content),
          j.additionalPlain || j.additional,
        ].join(" "),
      ),
      source_job_id: j.id,
    }),
  );
export async function fetchJobs(c) {
  return normalize(c, await json(`https://api.lever.co/v0/postings/${c.board}?mode=json`));
}
