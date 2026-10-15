// 贴来的一个 Lever / Ashby / Greenhouse 岗位链接：从它们公开的岗位接口读出这一个岗位的地点、远程与否和 JD 原文
// （09-30 #11：网页标题里没有地点，Ashby 的网页不跑 JS 读不到正文，收进来的所在地一律是「未标注」）。
// 字段和定时扫描同一套（lib/ats/lever.mjs、ashby.mjs、greenhouse.mjs 的 normalize）。认不出的链接返回 null，
// 接口里没有这一条也返回 null，调用方照旧用网页上读到的。只读公开接口，不带账号、不写东西。
import { json } from './http.mjs';
import * as lever from './lever.mjs';
import * as ashby from './ashby.mjs';
import * as greenhouse from './greenhouse.mjs';

//   Lever        jobs.lever.co/<站>/<岗位 id>[/apply]（欧洲站 jobs.eu.lever.co）
//   Ashby        jobs.ashbyhq.com/<公司>/<岗位 id>[/application]
//   Greenhouse   boards.greenhouse.io/<公司>/jobs/<岗位 id>、job-boards.greenhouse.io/…（欧洲站 .eu.）
export function postingRef(url) {
  let u;
  try { u = new URL(url); } catch { return null; } // 兜底：写得不像网址就不认
  const host = u.hostname.toLowerCase(), [board, a, b] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!board || !a) return null;
  const lv = /^jobs\.(eu\.)?lever\.co$/.exec(host);
  if (lv) return { ats: 'lever', board, id: a, api: `https://api.${lv[1] || ''}lever.co/v0/postings/${encodeURIComponent(board)}/${encodeURIComponent(a)}?mode=json` };
  if (host === 'jobs.ashbyhq.com') return { ats: 'ashby', board, id: a, api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}` };
  if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(host) && a === 'jobs' && /^\d+$/.test(b || '')) return { ats: 'greenhouse', board, id: b, api: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${b}` };
  return null;
}

// { role, location, jd_text, work_mode? }；fetchJson 在测试里换成假的。
export async function atsPosting(url, { fetchJson = json } = {}) {
  const ref = postingRef(url);
  if (!ref) return null;
  const c = { name: '', ats_type: ref.ats, board: ref.board };
  let row = null;
  if (ref.ats === 'lever') { const j = await fetchJson(ref.api); if (j?.id === ref.id) [row] = lever.normalize(c, [j]); }
  if (ref.ats === 'ashby') { const j = ((await fetchJson(ref.api))?.jobs || []).find(x => x.id === ref.id); if (j) [row] = ashby.normalize(c, { jobs: [j] }); }
  if (ref.ats === 'greenhouse') { const j = await fetchJson(ref.api); if (String(j?.id) === ref.id) [row] = greenhouse.normalize(c, { jobs: [j] }); }
  if (!row) return null;
  return { role: row.role || '', location: String(row.location || '').trim(), jd_text: row.jd_text || '', ...(row.work_mode ? { work_mode: row.work_mode } : {}) };
}
