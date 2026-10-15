// Turn one job link the user sent into a lead, judged and ready for a card.
//
// The user pastes a posting into Feishu; this is the deterministic half of
// what happens next. The page is fetched (plain HTTP first, the signed-in dedicated Chrome
// browser when the site wants a login), the text is kept as untrusted data,
// Jev reads the title and the posting, the lead is merged like any other, and
// judge-leads gives it a verdict. Nothing here applies or sends.
//
//   node bin/add-lead.mjs --url <url> [--company 微软] [--role "Software Engineer"] [--location 上海] [--source forwarded] [--message runs/inbox/<id>/message.json]
import { execFileSync } from '../lib/spawn.mjs';
import { lines, writeLines, read, write, arg, log, today, hash, root } from '../lib/store.mjs';
import { event } from '../lib/events.mjs';
import { BRAND } from '../lib/brand.mjs';
import { request, plain } from '../lib/ats/http.mjs';
import { atsTitleParts } from '../lib/ats/title-parts.mjs';
import { atsPosting } from '../lib/ats/posting.mjs';
import { runBrowserScript } from '../lib/browser-run.mjs';
import { mergeLeads } from '../lib/dedupe.mjs';
import { judge, choice, pick, judgeAvailable } from '../lib/judge.mjs';
import { postingLines, cityCandidates } from '../lib/judgements.mjs';

const url = arg('--url', '');
if (!/^https?:\/\//.test(url)) throw Error('url_required');
const source = arg('--source', 'forwarded');
// 你贴链接时一起给的 HR 邮箱：记成这个岗位的联系方式（applyChannel 看到 email 就走邮件），只收你给的，不从网页上猜。
const ownerEmail = String(arg('--email', '') || '').trim();
if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw Error('email_invalid');
const messagePath = arg('--message', null);
const dir = `runs/${today()}/add-lead/${hash(url).slice(0, 16)}`;

async function pageText(u) {
  try { const html = await (await request(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text(); const t = plain(html); if (t.length > 400 && !/请先登录|sign in to|log in to/i.test(t.slice(0, 600))) return { text: t, via: 'http', title: plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') }; } catch {} // 兜底：直接请求读不到正文就用下面的浏览器读
  const r = await runBrowserScript(`
const task = await taskSpace(${JSON.stringify(BRAND + ' add-lead')});
const page = task.page("p1");
await page.goto(${JSON.stringify(u)});
await page.waitForLoadState("networkidle").catch(() => {}); // 兜底：页面一直有网络请求也接着读，超时不算错
await page.waitForTimeout(3500);
radarResult({ url: await page.url(), title: await page.title(), text: await page.evaluate("document.body.innerText") });`, { cwd: root, timeout: 150000, maxBuffer: 16 * 1024 * 1024 });
  return { text: String(r.text || '').replace(/[ \t]+\n/g, '\n').trim(), via: 'browser', title: r.title || '', final_url: r.url };
}

const page = await pageText(url);
write(`${dir}/page.json`, { url, ...page, fetched_at: new Date().toISOString() });
if (page.text.length < 200) throw Error('page_text_too_short');
// Lever / Ashby / Greenhouse：地点、远程与否和 JD 原文从它们公开的岗位接口读（09-30 #11：网页标题里没有地点，
// Ashby 的网页不跑 JS 读不到正文，所在地一律「未标注」）。读不到就照旧用网页上的。
const posting = await atsPosting(url).catch(() => null); // 兜底：不是认识的招聘系统就是 null，下面按网页读
if (posting) write(`${dir}/posting.json`, { url, ...posting, fetched_at: new Date().toISOString() });

// Title and company: candidates from the page, the choice from Jev.
const host = new URL(url).hostname.replace(/^www\./, '');
const HOST_COMPANY = { 'apply.careers.microsoft.com': 'Microsoft', 'careers.microsoft.com': 'Microsoft', 'jobs.bytedance.com': '字节跳动', 'hr.163.com': '网易', 'careers.tencent.com': '腾讯' };
// Ashby / Lever / Greenhouse 的网页标题直接拆得出职位和公司（lib/ats/title-parts.mjs）；拆不开再让 Jev 挑。
const parts = atsTitleParts(page.title, host);
let company = arg('--company', '') || HOST_COMPANY[host] || parts.company || '';
let role = arg('--role', '') || parts.role || posting?.role || '';
if (judgeAvailable() && (!role || !company)) {
  const heads = [...new Set([page.title, ...postingLines(page.text.slice(0, 4000), 40).map((l) => l.text)].filter((t) => t && t.length >= 4 && t.length <= 120))].slice(0, 40);
  const q = {};
  if (!role) q.role_line = choice('Which candidate is the job title of the posting on this page (not the company name, not a section heading, not a cookie notice)?', { ...Object.fromEntries(heads.map((h, i) => [`h${i}`, h])), none: 'None of them is the job title' });
  if (!company) q.company_line = choice('Which candidate names the hiring company (the employer, not a job board)?', { ...Object.fromEntries(heads.map((h, i) => [`h${i}`, h])), none: 'The company is not named' });
  const r = await judge(`add-lead-${hash(url).slice(0, 16)}`, { url, host, candidates: heads }, q);
  const idx = (k) => { const p = pick(r.answers[k], 0.5); return p && p !== 'none' ? heads[Number(p.slice(1))] : null; };
  role = role || idx('role_line') || page.title.split(/[|｜\-–—]/)[0].trim() || '岗位待核';
  company = company || idx('company_line') || host;
}
role = role || page.title.split(/[|｜\-–—]/)[0].trim() || '岗位待核';
company = company || host;
// The posting's own location from the job board's API (above); else the city,
// when the title or the role names exactly one. Otherwise it is
// unknown, not elsewhere: the lead is judged with 工作地点待核 as the gap
// (lib/matcher.mjs locationPrefilter), never retired as outside_target_location.
const cities = cityCandidates(page.title, role);
const location = arg('--location', '') || posting?.location || (cities.length === 1 ? cities[0] : '未标注');

const incoming = [{
  company, role, location, ...(location === '未标注' ? { needs_city_check: true } : {}), url, source: 'forwarded', source_type: '用户转发', ats_type: null,
  jd_text: (posting?.jd_text?.length >= 200 ? posting.jd_text : page.text).slice(0, 40000), ...(posting?.work_mode ? { work_mode: posting.work_mode } : {}), posted_at: null, source_job_id: `forwarded:${hash(url).slice(0, 16)}`,
  evidence: `${dir}/page.json`, forwarded: { source, message: messagePath, at: new Date().toISOString() },
  ...(ownerEmail ? { email: ownerEmail, email_source: 'owner' } : {}),
}];
const merged = mergeLeads(lines('state/leads.ndjson'), incoming);
writeLines('state/leads.ndjson', merged.leads);
const stored = merged.leads.find((l) => l.url === url || l.source_url === url);
// 这个岗位以前就在库里：合并不一定带上新邮箱，你刚给的这一个为准。
if (ownerEmail && stored && stored.email !== ownerEmail) { stored.email = ownerEmail; stored.email_source = 'owner'; writeLines('state/leads.ndjson', merged.leads); }
event('radar', 'add-lead', 'ok', `用户转发线索已入库：${company} · ${role}`, { refs: [{ file: `${dir}/page.json` }] });


// Judge it now, so the card that answers the user carries a verdict.
let judged = null;
try {
  const out = execFileSync(process.execPath, ['bin/judge-leads.mjs', '--company', company, '--rejudge'], { cwd: root, encoding: 'utf8', timeout: 300000 });
  judged = JSON.parse(out.split('\n').filter(Boolean).pop());
} catch (e) { judged = { error: String(e.message).slice(0, 200) }; }
const fresh = lines('state/leads.ndjson').find((l) => l.id === stored?.id) || stored;
console.log(JSON.stringify(log('add-lead', { status: merged.added ? 'changed' : 'no_change', added: merged.added, updated: merged.updated, id: fresh?.id, number: fresh?.number ?? null, company, role, via: page.via, verdict: fresh?.match?.verdict || null, prefilter: fresh?.prefilter_reason || null, judged })));
// 记账（第 2 步 2X）：操作台起的这一次（RADAR_JOB_ID，任务卡那件活）在这里记做完和收成了哪一条，卡和接力只照账
// （lib/tasks.mjs intakeOutcome 读 result.links.lead），不再从线索里推。记账出错只打一行，收录本身已经做完。
if (process.env.RADAR_JOB_ID && fresh) {
  try {
    const [J, { intakeResult }] = await Promise.all([import('../lib/jobs.mjs'), import('../lib/task-ledger.mjs')]);
    J.drive(process.env.RADAR_JOB_ID, 'done', { result: { summary: intakeResult(fresh), links: { lead: `lead:${fresh.record_id || fresh.id}` } } });
  } catch (e) { console.error(`[jobs] 收录记账出错：${e.message}`); }
}
