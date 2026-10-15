// Microsoft careers (apply.careers.microsoft.com, an Eightfold "pcsx" portal).
//
// The portal's search API refuses direct calls from this machine, but answers
// a fetch made from inside the portal page in the user's signed-in ego
// browser. So this adapter is browser-driven like the ByteDance one: open the
// portal once, call `/api/pcsx/search` and `/api/pcsx/position_details` from
// the page for each configured search, and keep the job description the API
// returns. Nothing is clicked, nothing is submitted; applying stays a portal
// channel that needs the user's Microsoft account (config/portal-sessions.json).
//
// companies.yaml entry:
//   - name: Microsoft
//     ats_type: microsoft
//     origin: https://apply.careers.microsoft.com
//     searches: [{ query: software engineer, location: suzhou }]
//     max_per_search: 50
import { runBrowserScript } from '../browser-run.mjs';
import { root } from '../store.mjs';
import { BRAND } from '../brand.mjs';
import { plain, lead } from './http.mjs';
import { inTargetCity, citiesOf } from './cn.mjs';

const call = (script, timeout = 240000) => runBrowserScript(script, { cwd: root, timeout, maxBuffer: 32 * 1024 * 1024 });
const ORIGIN = 'https://apply.careers.microsoft.com';

export const normalize = (c, positions = []) =>
  positions
    .filter((p) => p && p.id && p.name)
    .map((p) => {
      const location = [...new Set((Array.isArray(p.locations) ? p.locations : [p.location]).filter(Boolean).map((x) => String(x).trim()))].join(' / ');
      const posted = Number(p.postedTs || p.creationTs);
      const origin = c.origin || ORIGIN;
      return lead(c, {
        role: String(p.name).trim(),
        location,
        url: `${origin}/careers?pid=${p.id}`,
        application_url: `${origin}/careers/apply?pid=${p.id}`,
        posted_at: Number.isFinite(posted) && posted > 0 ? new Date(posted * 1000).toISOString() : null,
        jd_text: plain(p.jobDescription || p.job_description || ''),
        summary: p.department ? `部门：${p.department}` : '',
        source_job_id: String(p.displayJobId || p.id),
        portal_pid: String(p.id),
      });
    });

export async function fetchJobs(c) {
  const origin = c.origin || ORIGIN;
  const searches = c.searches?.length ? c.searches : [{ query: 'software engineer', location: 'suzhou' }];
  const max = Math.min(100, Number(c.max_per_search) || 50);
  // One fetch per page.evaluate: the browser caps an evaluation at 15 s, so
  // the loops live in the outer script and each call does a single request.
  const script = `
const task = await taskSpace(${JSON.stringify(BRAND + ' microsoft')});
const page = task.page("p1");
await page.goto(${JSON.stringify(origin + '/careers')});
await page.waitForLoadState("networkidle").catch(() => {}); // 兜底：页面一直有网络请求也接着读，超时不算错
await page.waitForTimeout(3000);
const get = (path) => page.evaluate(async (p) => { const r = await fetch(p, { credentials: 'include', headers: { accept: 'application/json' } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t.slice(0, 200) }; }, path); // 兜底：回的不是 JSON 就是 null，调用方按没读到处理
const searches = ${JSON.stringify(searches)};
const max = ${max};
const out = [];
for (const s of searches) {
  const positions = [];
  let status = 0, error = null;
  for (let start = 0; start < max; start += 10) {
    const q = new URLSearchParams({ domain: 'microsoft.com', query: s.query || '', location: s.location || '', start: String(start), sort_by: 'match', filter_distance: String(s.distance_km || 160), filter_include_remote: '1' });
    const r = await get('/api/pcsx/search?' + q.toString());
    status = r.status;
    if (!r.json) { error = r.text; break; }
    const batch = r.json.data ? (r.json.data.positions || []) : [];
    positions.push(...batch);
    if (batch.length < 10) break;
  }
  for (const p of positions.slice(0, max)) {
    const d = await get('/api/pcsx/position_details?position_id=' + p.id + '&domain=microsoft.com&hl=en');
    if (d.json && d.json.data) Object.assign(p, { jobDescription: d.json.data.jobDescription, postedTs: d.json.data.postedTs || p.postedTs, displayJobId: d.json.data.displayJobId || p.displayJobId, locations: d.json.data.locations || p.locations });
  }
  out.push({ search: s, status, error, positions: positions.slice(0, max) });
}
radarResult({ url: await page.url(), title: await page.title(), results: out });`;
  const page = await call(script);
  if (/\/login|\/signin|sign-?in/i.test(String(page.url || ''))) throw Error('session_expired:apply.careers.microsoft.com');
  const byId = new Map();
  for (const r of page.results || []) {
    if (r.status !== 200) throw Error(`microsoft_search_${r.status}: ${r.error || ''}`);
    for (const l of normalize(c, r.positions)) if (inTargetCity(l.location, citiesOf(c)) && !byId.has(l.source_job_id)) byId.set(l.source_job_id, l);
  }
  return [...byId.values()];
}
