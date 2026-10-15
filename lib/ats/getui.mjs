// Public social-recruiting API used by job.getui.com's own position list.
import { json, lead } from './http.mjs';
import { inTargetCity, citiesOf } from './cn.mjs';
const api = async (c, path, body) => {
  const result = await json(`${c.origin}/data/recruit/social/2021/job/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (result.errNo !== 0) throw Error(`getui_${result.errNo}`);
  return result.data;
};
export const normalize = (c, data) => (data.list || []).filter(j => j.id && j.name && inTargetCity(j.city, citiesOf(c))).map(j => lead(c, {
  role: j.name, location: j.city, url: `${c.origin}/society/position/${j.id}`,
  source_job_id: String(j.id), posted_at: null,
  // The list exposes duties only. Do not let a long duties blob masquerade as
  // a full JD: matching must fetch the detail with its qualifications first.
  jd_text: '', summary: j.content || '',
}));
export async function fetchJobs(c) {
  const jobs = new Map(), pageSize = 100;
  for (let pageNum = 1; pageNum <= (c.max_pages || 2); pageNum++) {
    const data = await api(c, 'list', { pageNum, pageSize });
    for (const j of normalize(c, data)) jobs.set(j.source_job_id, j);
    if (!data.list?.length || pageNum * pageSize >= data.total) break;
  }
  return [...jobs.values()];
}
export async function detail(c, l) {
  const data = await api(c, 'detail', { id: Number(l.source_job_id) });
  if (!data?.content || !data?.require) throw Error('getui_full_jd_missing');
  return { jd_text: `${data.content}\n\n${data.require}` };
}
