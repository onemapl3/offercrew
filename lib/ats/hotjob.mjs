// 大易（HotJob / wecruit）新版招聘门户。门户地址是 `<域名>/SU<24 位编号>/pb/index.html`，域名可能是公共的
// wecruit.hotjob.cn、公司自己的 `<公司>.hotjob.cn`，也可能挂在公司域名上（德勤社招 ehjobs.deloitte.com.cn）。
// 门户页面是空壳，岗位来自两个公开接口（不要登录、没有签名，地址里的 t 只是前端防缓存的时间戳，2026-10-02 核对）：
//   列表 POST /wecruit/positionInfo/listPosition/SU…        表单 isFrompb=true&recruitType=…&currentPage=…
//   详情 POST /wecruit/positionInfo/listPositionDetail/SU…  表单 postId=…，给职责 workContent 和要求 serviceCondition
// 列表没有职位描述：jd_text 留空，匹配前由 bin/match.mjs、bin/judge-leads.mjs 调 detail 补全（和 moka、oracle 一样）。
//
// 社招、校招、实习是同一个接口，只差 recruitType（2 社招、1 校招、12 实习）。读哪几类按候选人的阶段来
// （lib/ats/recruit.mjs），recruit_types 可以按公司覆盖。校招和实习给了截止日（endDate）的记 apply_deadline，
// 已经过了的读的时候就去掉（lib/deadline.mjs）；没有截止的岗位接口写 3000-01-01，当没写。
//
// 每页几条由服务器定，不听请求里的 pageSize：同样传 15，返回过 1、10、15 条（09-29 广发证券一页只给 1 条，社招
// 297 条要翻 297 次）。所以按返回的 pageSize / totalPage 翻页，并且最多翻 max_pages 页；大租户用 work_place_codes
// 让服务器先按城市筛（华夏银行校招 856 条，只看北京是 52 条）。
//
// 大易老版（WinTalent，网址形如 /wt/<公司代码>/web/…，列表接口 /wt/<代码>/web/json/position/list）翻页要页面每次
// 下发的临时令牌 operational，不支持：认出来就报 hotjob_legacy_unsupported，不去模仿令牌。
//
// companies.yaml entry:
//   - name: 华夏银行
//     ats_type: hotjob
//     origin: https://hxb.hotjob.cn                  # 门户所在的域名
//     portal_id: SU645b0d18bef57c0907e9fbc8          # 门户地址里 /SU…/pb/ 那一段
//     careers_url: https://hxb.hotjob.cn/SU645b0d18bef57c0907e9fbc8/pb/index.html
//     campus_origin / campus_portal_id               # optional：校招和实习在另一个门户（德勤）
//     recruit_types: [campus, intern]                # optional：不写按阶段读
//     work_place_codes: ['0/4/7/9']                  # optional：服务器按城市筛（门户上选好城市后地址里的 workPlaceCode）
//     unlisted_city: keep                            # optional：没写城市、写「全部地区」的岗位也留下，地点记「未标注」
//     exclude_titles: [柜员] / max_pages: 30         # optional：每类最多翻几页，默认 30
//   portal_id 不写时：careers_url 里有 /SU…/ 就用它；只写了 <公司>.hotjob.cn 这样的域名，按门户壳的做法问
//   /wecruit/common/getSLD 换出真正的门户地址。portal_id、campus_portal_id 都可以写成列表（一家好几个门户）。
import { json, plain, lead } from './http.mjs';
import { CN_USER_AGENT, cnText, cityGate, citiesOf } from './cn.mjs';
import { recruitTypesOf, internOrCampus } from './recruit.mjs';
import { deadlineField, pastDeadline } from '../deadline.mjs';

const RECRUIT_TYPE = { social: '2', campus: '1', intern: '12' };
const TYPE_OF = { 2: 'social', 1: 'campus', 12: 'intern' };
// 门户详情页地址里的 postType（门户前端自己的对照：1 campus、2 society、12 intern、13 overseas）。
const POST_TYPE = { social: 'society', campus: 'campus', intern: 'intern' };
const SU = /\/(SU[0-9a-f]{16,32})(?=\/|$)/i;
export const LEGACY = /\/wt\/[^/]+\/(?:web|mobile)\b/i;

const list = (v) => [v].flat().filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim());
const suite = (id) => { const s = String(id).trim(); return /^SU/i.test(s) ? `SU${s.slice(2)}` : `SU${s}`; };
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } }; // 兜底：解析不了就没有来源
const legacyError = (where) =>
  Error(`hotjob_legacy_unsupported: ${where} 是大易老版门户，翻页要页面每次下发的临时令牌，读不了。打开它看会不会跳到 /SU…/pb/ 开头的新版门户，是的话把新版地址写进 careers_url 或 portal_id`);

const headers = (origin, id, type = 'social') => ({
  'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': CN_USER_AGENT, Referer: `${origin}/${id}/pb/${type === 'campus' ? 'school' : type === 'intern' ? 'interns' : 'social'}.html`,
});
const api = (origin, path, id) => `${origin}/wecruit/positionInfo/${path}/${id}?iSaJAx=isAjax&request_locale=zh_CN&t=${Date.now()}`;

// 公司自己的二级域名（hxb.hotjob.cn、bosera.hotjob.cn）只给一个空壳，壳里的脚本拿域名问 getSLD 换门户地址。
// 同一轮里问过的记住，不重复问。
const sld = new Map();
export async function lookupPortal(origin) {
  if (sld.has(origin)) return sld.get(origin);
  const host = new URL(origin).host;
  const data = await json(`${origin}/wecruit/common/getSLD`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CN_USER_AGENT, Referer: `${origin}/` },
    body: new URLSearchParams({ sld: host }).toString(),
  });
  const link = data?.data?.linkData?.wtLink || data?.data?.linkData?.link || '';
  if (String(data?.state) !== '200' || !link) throw Error(`hotjob_portal_not_found: ${host} ${data?.data?.msg || data?.msg || '大易没有这个企业'}`);
  if (LEGACY.test(link) || !SU.test(link)) throw legacyError(link);
  const found = { origin: originOf(link) || origin, id: suite(link.match(SU)[1]) };
  sld.set(origin, found);
  return found;
}

// 这家公司的门户：{ social: [{origin, id}], campus: [{origin, id}] }，校招门户同时读校招和实习。
export async function portalsOf(c) {
  const urls = [c.careers_url, c.origin].filter(Boolean).map(String);
  const own = (ids, origin) => list(ids).map((id) => ({ origin: String(origin).replace(/\/+$/, ''), id: suite(id) }));
  let social;
  if (list(c.portal_id).length) {
    const origin = c.origin ? originOf(c.origin) : urls.map(originOf).find(Boolean);
    if (!origin) throw Error('hotjob_origin_missing');
    social = own(c.portal_id, origin);
  } else {
    const withId = urls.find((u) => SU.test(u));
    if (withId) social = [{ origin: originOf(withId), id: suite(withId.match(SU)[1]) }];
    else if (urls.some((u) => LEGACY.test(u))) throw legacyError(urls.find((u) => LEGACY.test(u)));
    else if (c.origin) social = [await lookupPortal(originOf(c.origin))];
    else throw Error('hotjob_portal_missing');
  }
  const campusIds = list(c.campus_portal_id);
  const campus = campusIds.length ? own(campusIds, originOf(c.campus_origin || '') || social[0].origin) : social;
  return { social, campus };
}

// 「北京市、上海市」→「北京市 / 上海市」；「全部地区」「不限」等于没写城市，交给 unlisted_city（lib/ats/cn.mjs）。
const ANYWHERE = /^(?:全部地区|全部|不限|全国|不限地区|全国各地)$/;
export const placeOf = (s) => {
  const parts = String(s || '').split(/[、，,;；]/).map((x) => x.trim()).filter(Boolean);
  return parts.every((p) => ANYWHERE.test(p)) ? '' : parts.join(' / ');
};
// 「2026-09-29 17:26:44」是北京时间。
const postedAt = (s) => {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  return m ? new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+08:00`).toISOString() : null;
};
export const excludedTitle = (c, role) => list(c.exclude_titles).some((w) => String(role).toLowerCase().includes(w.toLowerCase()));

// 一页列表 → 线索。kind 是读的那一类；行自己带 recruitType 时以行为准。
export const normalize = (c, data, kind = 'social', portal = {}) =>
  (data?.data?.pageForm?.pageData || []).filter((p) => p.postId && p.postName).map((p) => {
    const board = TYPE_OF[p.recruitType] || kind, id = p.currentSuiteKey ? suite(p.currentSuiteKey) : portal.id;
    const deadline = deadlineField(p.endDate), where = String(p.workPlaceStr || '').trim();
    return lead(c, {
      role: String(p.postName).trim(),
      location: placeOf(where),
      url: `${portal.origin}/${id}/pb/posDetail.html?postId=${encodeURIComponent(p.postId)}&postType=${POST_TYPE[board]}`,
      // 有的门户把实习也放在校招里：校招里标题写着实习的记成实习（lib/ats/recruit.mjs）。
      recruit_type: board === 'campus' ? internOrCampus(p.postName, p.projectName) : board,
      ...(deadline ? { apply_deadline: deadline } : {}),
      posted_at: postedAt(p.publishDate),
      // 列表只有标题、地点和几项条件：职责和要求在详情接口里，匹配前由 detail 取。
      jd_text: '',
      summary: [
        p.projectName && `项目：${p.projectName}`, p.company && p.company !== c.name && `单位：${p.company}`, p.department && `部门：${p.department}`,
        p.postTypeName && `类别：${p.postTypeName}`, p.educationStr && `学历：${p.educationStr}`, p.workYears && `经验：${p.workYears}`,
        p.recruitNumStr && `人数：${p.recruitNumStr}`, where && !placeOf(where) && `地点：${where}`,
      ].filter(Boolean).join('；'),
      source_job_id: String(p.postId),
    });
  });

// 一类岗位在一个门户上翻完（或翻到 max_pages）。每页条数和总页数都按服务器的返回算。
async function readBoard(c, portal, type, workPlace, take) {
  const cap = Math.max(1, Number(c.max_pages) || 30), seen = new Set();
  for (let page = 1; page <= cap; page++) {
    const url = api(portal.origin, 'listPosition', portal.id);
    const form = { isFrompb: 'true', recruitType: RECRUIT_TYPE[type], pageSize: String(c.page_size || 15), currentPage: String(page), ...(workPlace ? { workPlaceCode: workPlace } : {}) };
    const data = await json(url, { method: 'POST', headers: headers(portal.origin, portal.id, type), body: new URLSearchParams(form).toString() });
    if (String(data?.state) !== '200') throw Error(`hotjob_list_failed_${data?.state ?? 'unknown'}: ${data?.msg || ''} ${url}`);
    const pf = data.data?.pageForm || {}, rows = pf.pageData || [];
    const fresh = rows.filter((r) => r.postId && !seen.has(r.postId));
    for (const r of fresh) seen.add(r.postId);
    take(normalize(c, { data: { pageForm: { pageData: fresh } } }, type, portal));
    const total = Number(pf.dataCount ?? data.data?.positonNum ?? 0), size = Number(pf.pageSize) || rows.length;
    const pages = Number(pf.totalPage) || (size ? Math.ceil(total / size) : 0);
    // 服务器不认 currentPage、一直回同一页时，没有新行就停。
    if (!fresh.length || page >= pages || seen.size >= total) break;
  }
}

// now 只给测试用：「今天」是哪天。
export async function fetchJobs(c, { now = new Date() } = {}) {
  const portals = await portalsOf(c), cities = citiesOf(c), wanted = recruitTypesOf(c), byId = new Map();
  const places = list(c.work_place_codes);
  const keep = (found) => {
    for (const one of found) {
      const l = wanted.includes(one.recruit_type) && !pastDeadline(one, now) && !excludedTitle(c, one.role) && cityGate(c, one, cities);
      if (l && !byId.has(l.source_job_id)) byId.set(l.source_job_id, l);
    }
  };
  for (const type of wanted) for (const portal of type === 'social' ? portals.social : portals.campus)
    for (const place of places.length ? places : [null]) await readBoard(c, portal, type, place, keep);
  return [...byId.values()];
}

// 列表没有职位描述：用公开的详情接口补全。门户和编号都从线索自己的地址里读，不依赖配置有没有改过。
export async function detail(c, l) {
  const u = new URL(l.url), id = u.pathname.match(SU)?.[1], postId = u.searchParams.get('postId') || l.source_job_id;
  if (!id || !postId) throw Error(`hotjob_detail_unknown_post: ${l.url}`);
  const url = api(u.origin, 'listPositionDetail', suite(id));
  const data = await json(url, { method: 'POST', headers: { ...headers(u.origin, suite(id)), Referer: l.url }, body: new URLSearchParams({ postId }).toString() });
  const d = data?.data || {};
  if (String(data?.state) !== '200' || !(d.workContent || d.serviceCondition)) throw Error(`hotjob_detail_failed_${data?.state ?? 'unknown'}: ${url}`);
  const deadline = deadlineField(d.endDate);
  return {
    ...l,
    jd_text: cnText(
      plain(d.workContent), plain(d.serviceCondition),
      [d.education && `学历要求：${d.education}`, d.workYears && `经验要求：${d.workYears}`, (d.orgName || d.company) && `单位：${d.orgName || d.company}`].filter(Boolean).join('；'),
    ),
    ...(deadline ? { apply_deadline: deadline } : {}),
  };
}
