// Moka (app.mokahr.com) career sites. Every tenant's site calls the same public
// JSON API, keyed by the orgId and siteId in its URL. Responses come back
// AES-128-CBC encrypted with the key sent alongside (`necromancer`) and the IV
// the site's own page ships (init-data `aesIv`), so decrypting is exactly what
// the site's frontend does. The list carries no description: `detail` fills it
// in before matching (bin/judge-leads.mjs and bin/match.mjs call it).
//
// 一家公司在 Moka 上常有两个站：社招站和校招站（app.mokahr.com/campus-recruitment/<org>/<站点号>），
// 站点号不同，接口里的 site 也不同（social / campus）。校招站里正式校招和实习混在一起，按岗位的
// commitment（全职 / 实习）和标题分开。读哪几类按候选人的阶段来（lib/ats/recruit.mjs）；基金公司的校招
// 常在 Moka 上（嘉实基金、创金合信、中投……，docs/channels.md）。
//
// companies.yaml entry:
//   - name: 涂鸦智能
//     ats_type: moka
//     org_id: tuya
//     site_id: 3236
//     site_path: apply            # "social-recruitment" for v2 sites
//     careers_url: https://app.mokahr.com/apply/tuya/3236
//     campus_site_id: 4xxxx       # optional：校招站的站点号
//     unlisted_city: keep         # optional：没写城市的岗位也留下（地点记「未标注」），见 lib/ats/cn.mjs
//   只有校招站的公司：site_id 写校招站、site_path: campus-recruitment。
//   好几个校招站（毕马威）：campus_site_id: [76195, 78342]，site_id 同理。
//   org_id 写网址里那一段就行：接口要的是另一个（雀巢 nestlegcr → nestlezgc）时，适配器从页面 init-data 取。
//   department: 极氪科技集团     # optional：集团共用一个站时只读这个部门的岗位（社招站）。部门名照站上「部门」筛选里写的，
//                                #   连同它下面的各级部门；站上找不到这个部门就报错（moka_department_missing），不读整个集团。
//   2026-10-05 极氪：吉利集团的社招站 geely/102003 有 824 个岗位，「极氪科技集团」这个部门 37 个。接口的 departmentId
//   带上这个部门和它下面各级部门的编号，回来的正好是这 37 个；每条再按岗位自己的部门核一遍。
import crypto from 'node:crypto';
import { json, request, plain, lead } from './http.mjs';
import { CN_USER_AGENT, cnText, cityGate, citiesOf } from './cn.mjs';
import { recruitTypesOf, internOrCampus } from './recruit.mjs';

const API = 'https://app.mokahr.com/api/outer/ats-apply/website';
// Identical on every tenant seen (v1 and v2 sites, 2026-09-23); a tenant whose
// page ships another value sets `aes_iv`.
const AES_IV = 'de7c21ed8d6f50fe';
export function decrypt(body, iv = AES_IV) {
  if (!body?.necromancer) return body;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(body.necromancer, 'utf8'), Buffer.from(iv, 'utf8'));
    return JSON.parse(d.update(String(body.data), 'base64', 'utf8') + d.final('utf8'));
  } catch (e) { throw Error(`moka_decrypt_failed: ${e.message}`); }
}
// kind 是站的种类：social（社招站）或 campus（校招站，校招和实习都在里面）。
// 一家公司可以有好几个同种的站（毕马威有 3 个校招站）：site_id / campus_site_id 都可以写成列表，几个站一起读。
const list = (v) => [v].flat().filter((x) => x != null && x !== '');
export const siteListOf = (c) => {
  const campusOnly = c.site_path === 'campus-recruitment';
  return { social: campusOnly ? [] : list(c.site_id), campus: list(c.campus_site_id).length ? list(c.campus_site_id) : campusOnly ? list(c.site_id) : [] };
};
// 每种站的第一个（老调用方只认一个站）。
export const sitesOf = (c) => {
  const sites = siteListOf(c);
  return { social: sites.social[0] ?? null, campus: sites.campus[0] ?? null };
};
const siteUrl = (c, kind = 'social', site = sitesOf(c)[kind]) =>
  kind === 'campus' ? `https://app.mokahr.com/campus-recruitment/${c.org_id}/${site}` : `https://app.mokahr.com/${c.site_path || 'apply'}/${c.org_id}/${site}`;

// 接口要的 orgId 不一定是网址里那一段：雀巢的网址是 nestlegcr，接口只认页面 init-data 里的 org.id（nestlezgc），
// 用网址那一段会得到 code 102「参数错误。orgId」。碰到这个错就打开这个站的页面（Moka 先 302 发匿名 cookie 再跳回，
// 带上 cookie 罐跟过去），取 init-data 里的 org.id 重试一次；同一轮里记住，不再重开页面。配置本来就对的公司不多发请求。
const realOrg = new Map();
export function initData(html) {
  const raw = String(html || '').match(/<input[^>]*\bid="init-data"[^>]*\bvalue="([^"]*)"/)?.[1] ?? String(html || '').match(/<input[^>]*\bvalue="([^"]*)"[^>]*\bid="init-data"/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); } catch { return null; } // 兜底：页面里的数据写坏了就是 null，调用方按没读到处理
}
const orgError = (body) => body?.code === 102 || /orgId/i.test(String(body?.msg || ''));
async function post(c, path, orgId, site, payload, kind) {
  return decrypt(await json(`${API}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': CN_USER_AGENT, Origin: 'https://app.mokahr.com', Referer: siteUrl(c, kind, site) },
    body: JSON.stringify({ orgId, siteId: Number(site), ...payload }),
  }), c.aes_iv || AES_IV);
}
async function call(c, path, payload, kind = 'social', site = sitesOf(c)[kind]) {
  let body = await post(c, path, realOrg.get(c.org_id) || c.org_id, site, payload, kind);
  if (body?.code !== 0 && orgError(body) && !realOrg.has(c.org_id)) {
    const page = initData(await (await request(siteUrl(c, kind, site), { jar: new Map(), headers: { 'User-Agent': CN_USER_AGENT } })).text());
    const org = page?.org?.id;
    if (org && org !== c.org_id) {
      realOrg.set(c.org_id, org);
      body = await post(c, path, org, site, payload, kind);
    }
  }
  if (body?.code !== 0) throw Error(`moka_${path}_failed_${body?.code}: ${body?.msg || ''}`);
  return body.data;
}

// Locations name a district ("西湖区") under a province; the prefecture comes
// from the first four digits of cityId, which the city filters need.
const PREFECTURE = { 3301: '杭州', 3100: '上海', 3101: '上海', 1100: '北京', 1101: '北京', 4403: '深圳', 4401: '广州', 5101: '成都', 3201: '南京', 3205: '苏州', 3401: '合肥', 4201: '武汉' };
const place = (x) => {
  const city = PREFECTURE[String(x.cityId || '').slice(0, 4)];
  return [city || x.provinceName, x.cityName && !(city && x.cityName.startsWith(city)) ? x.cityName : null].filter(Boolean).join('·');
};

export const normalize = (c, data, kind = 'social', site = sitesOf(c)[kind]) =>
  // Lists also return closed and paused postings; only open ones take applications.
  (data?.jobs || []).filter((j) => j.id && j.title && (!j.status || j.status === 'open')).map((j) =>
    lead(c, {
      role: String(j.title).trim(),
      location: [...new Set((j.locations || []).map(place).filter(Boolean))].join(' / '),
      // lib/dedupe.mjs drops the URL fragment the site routes on, so the job id
      // also rides in the query (the site ignores it) to keep URLs distinct.
      url: `${siteUrl(c, kind, site)}?job=${j.id}#/job/${j.id}`,
      recruit_type: kind === 'campus' ? internOrCampus(j.commitment, j.title) : 'social',
      posted_at: j.publishedAt ? `${j.publishedAt}+08:00` : null,
      jd_text: '',
      summary: [j.zhineng?.name && `职能：${j.zhineng.name}`, j.commitment].filter(Boolean).join('；'),
      source_job_id: String(j.id),
    }),
  );

// 站上的部门树（init-data 的 departmentsStructure）里名字对得上的那个部门：{ id, ids }，ids 是它和下面各级部门的编号。
const deptName = (x) => String(x ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export function findDepartment(init, name) {
  const want = deptName(name);
  const hit = (init?.departmentsStructure || []).find((d) => deptName(d.label ?? d.name) === want);
  if (!hit) return null;
  return { id: hit.id, name: hit.label ?? hit.name, ids: [...new Set([hit.id, ...(hit.ids || [])])] };
}
async function department(c) {
  const kind = siteListOf(c).social.length ? 'social' : 'campus';
  const page = initData(await (await request(siteUrl(c, kind), { jar: new Map(), headers: { 'User-Agent': CN_USER_AGENT } })).text());
  const dept = findDepartment(page, c.department);
  if (!dept) throw Error(`moka_department_missing: ${c.department}`);
  if (page?.org?.id && page.org.id !== c.org_id) realOrg.set(c.org_id, page.org.id);
  return dept;
}
const inDepartment = (dept, j) => !dept || dept.ids.includes(j.deptId) || dept.ids.includes(j.department?.id);

export async function fetchJobs(c) {
  const sites = siteListOf(c);
  if (!c.org_id || (!sites.social.length && !sites.campus.length)) throw Error('moka_tenant_missing');
  const dept = c.department ? await department(c) : null;
  const size = c.page_size || 30, cities = citiesOf(c), byId = new Map();
  const wanted = recruitTypesOf(c);
  // 要读的类别落在哪种站：社招在社招站，校招和实习都在校招站（一个站只读一遍）。没配那种站就跳过；
  // 同种的几个站挨个读，同一个岗位挂在两个站上时按 source_job_id 只留先读到的那条。
  const kinds = [...new Set(wanted.map((t) => (t === 'social' ? 'social' : 'campus')))].filter((k) => sites[k].length);
  for (const kind of kinds) for (const site of sites[kind]) {
    for (let index = 0; index < (c.max_pages || 10); index++) {
      const data = await call(c, 'jobs', { site: kind, limit: size, offset: index * size, needStat: true, ...(dept ? { departmentId: dept.ids } : {}) }, kind, site);
      const leads = normalize(c, { ...data, jobs: (data?.jobs || []).filter((j) => inDepartment(dept, j)) }, kind, site);
      for (const found of leads) {
        const l = wanted.includes(found.recruit_type) && cityGate(c, found, cities);
        if (l && !byId.has(l.source_job_id)) byId.set(l.source_job_id, l);
      }
      if (!data?.jobs?.length || (index + 1) * size >= (data.jobStats?.total ?? 0)) break;
    }
  }
  return [...byId.values()];
}

// The description is one HTML block with 职责 and 要求 headings; blocks become
// lines and a blank line opens the requirement section, which is how
// lib/matcher.mjs tells duties from qualifications.
export function describe(html) {
  const lines = String(html || '').replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, '\n').split('\n').map(plain).filter(Boolean);
  return lines.map((line, i) => (i && /^[【\[]?(?:任职要求|岗位要求|任职资格|职位要求|基本要求|我们希望你|我们期待|要求)/.test(line) ? `\n${line}` : line)).join('\n');
}
// 站点号从岗位自己的链接里取（…/campus-recruitment/<org>/<站点号>?job=…），几个校招站的岗位各问各的站。
export const siteOfUrl = (url) => String(url || '').match(/app\.mokahr\.com\/[^/?#]+\/[^/?#]+\/(\d+)/)?.[1] || null;
export async function detail(c, l) {
  // 校招、实习的岗位在校招站上，详情也要问那个站。
  const kind = l.recruit_type && l.recruit_type !== 'social' ? 'campus' : 'social';
  const data = await call(c, 'job', { jobId: l.source_job_id }, kind, siteOfUrl(l.url) || sitesOf(c)[kind]);
  if (!data?.jobDescription) throw Error('moka_full_jd_missing');
  return { jd_text: cnText(describe(data.jobDescription), data.departments?.[0]?.name ? `部门：${data.departments[0].name}` : '') };
}
