// Browser text must be captured visibly by the host, never headless social scraping.
export async function fetchJobs(c) {
  throw Error(`needs_browser_extraction: ${c.careers_url}`);
}
export function fromExtraction(c, rows) {
  return rows
    .filter((r) => r.company === c.name && r.role && r.url && r.jd_text && r.browser_evidence)
    .map((r) => ({ ...r, ats_type: "generic", source: "official_careers" }));
}
