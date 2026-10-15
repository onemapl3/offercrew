// Alibaba-family talent sites: talent.alibaba.com (阿里巴巴集团), careers.aliyun.com
// (阿里云), talent.antgroup.com (蚂蚁集团) and the other business units built
// on the same recruiting frontend. Each serves one public search that its own
// position list calls, guarded only by an anonymous CSRF token: a plain GET of
// the site sets the token cookie, and the search echoes it as a query
// parameter. The list already carries 职责 (description) and 要求 (requirement),
// so no detail round trip is needed.
//
// The search channel is `group_official_site` on every host; the host picks the
// business units. talent.alibaba.com is a superset of the BU sites (阿里云, 淘天,
// 千问, 钉钉, 阿里国际, 菜鸟, 高德 ...), so it is configured once: a BU site on
// top of it would file the same posting twice under two company names.
//
// Since the 2026-09 reorganisation talent.alibaba.com itself is only a hub: its
// search API still answers, but every /off-campus/* page redirects to the hub's
// home page. Detail pages live on the BU sites; talent-holding.alibaba.com (the
// holding's site) opens every BU's posting, so `detail_origin` points links there
// (verified 2026-09-28 for 阿里云、阿里国际、千问办公、数据技术及产品部 postings).
//
// companies.yaml entries:
//   - name: 阿里巴巴集团
//     ats_type: alitalent
//     origin: https://talent.alibaba.com
//     detail_origin: https://talent-holding.alibaba.com
//     regions: "330100,310100"
//     sub_categories: "136,409,702,410,704,408"
//     queries: [""]
//   - name: 蚂蚁集团
//     ats_type: alitalent
//     origin: https://talent.antgroup.com
//     api_origin: https://hrcareersweb.antgroup.com
//     search_path: /api/social/position/search
//     position_path: /off-campus-position
//     csrf: false
//     campus_search_path: /api/campus/position/search   # 校招站（下面有说明）
//     campus_position_path: /campus-position
//
// 校招和实习在另一个搜索里：蚂蚁的是 /api/campus/position/search，channel 换成 campus_group_official_site
// （2026-09-29 核对：当天 410 个岗位）。每个岗位带 batchType：graduate 是校招，trainee 是实习。读哪几类按
// 候选人的阶段来（lib/ats/recruit.mjs）；只有写了 campus_search_path 的公司才读校招——阿里巴巴主站的校招接口
// 要先拿匿名 cookie，没法在不带 cookie 的前提下核对，所以还没配。
import { request, json, plain, lead } from './http.mjs';
import { CN_USER_AGENT, cnText, searchCities } from './cn.mjs';
import { recruitTypesOf } from './recruit.mjs';

const DEGREE = { bachelor: '本科', master: '硕士', doctor: '博士', college: '大专' };
const time = (v) => {
  const t = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};

// kind：social 是社招搜索的结果，campus 是校招搜索的结果（校招、实习都在里面，按 batchType 分）。
const kindOf = (p) => (p.batchType === 'trainee' || /实习/.test(`${p.batchTypeDesc || ''} ${p.batchName || ''}`) ? 'intern' : 'campus');
export const normalize = (c, data, kind = 'social') =>
  (Array.isArray(data.content) ? data.content : data.content?.datas || []).filter((p) => p.id && p.name).map((p) =>
    lead(c, {
      role: String(p.name).trim(),
      location: (p.workLocations || []).join(' / '),
      url: `${c.detail_origin || c.origin}${kind === 'campus' ? c.campus_position_path || '/campus-position' : c.position_path || '/off-campus/position-detail'}?positionId=${p.id}`,
      recruit_type: kind === 'campus' ? kindOf(p) : 'social',
      posted_at: time(p.publishTime),
      jd_text: cnText(
        plain(p.description),
        plain(p.requirement),
        [
          Number.isFinite(p.experience?.from) && p.experience.from > 0 && `经验要求：${p.experience.from}年以上`,
          DEGREE[p.degree] && `学历要求：${DEGREE[p.degree]}及以上`,
          (p.categoryName || p.categories?.join?.('、')) && `类别：${p.categoryName || p.categories.join('、')}`,
        ].filter(Boolean).join('；'),
      ),
      source_job_id: String(p.id),
    }),
  );

// One anonymous session per run. careers.aliyun.com issues the cookie on the
// 302 from "/", so the jar follows the redirect chain. Ant's API takes no
// token at all (its frontend invents a ctoken client-side), so `csrf: false`.
async function session(c) {
  const jar = new Map();
  if (c.csrf === false) return { jar, query: '' };
  const r = await request(`${c.origin}/`, { jar, headers: { 'User-Agent': CN_USER_AGENT } });
  await r.body?.cancel();
  if (!jar.get('XSRF-TOKEN')) throw Error('alitalent_token_missing');
  return { jar, query: `?_csrf=${encodeURIComponent(jar.get('XSRF-TOKEN'))}` };
}

// Server-side filters keep paging short: `regions` (330100 = 杭州, 310100 =
// 上海, comma-joined) and `sub_categories` (technical leaf codes). With
// `queries: [""]` the filtered list is paged whole, which avoids missing a
// posting whose text names no search keyword.
export async function fetchJobs(c) {
  const wanted = recruitTypesOf(c);
  const campus = wanted.some((t) => t !== 'social') && c.campus_search_path;
  if (!wanted.includes('social') && !campus) return [];
  const { jar, query } = await session(c);
  const search = (kind) => searchCities({ page_size: 50, ...c }, async (company, keyword, index, size) => {
    const url = `${c.api_origin || c.origin}${kind === 'campus' ? c.campus_search_path : c.search_path || '/position/search'}${query}`;
    const data = await json(url, {
      jar, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CN_USER_AGENT, Origin: c.origin, Referer: `${c.origin}${kind === 'campus' ? c.campus_list_path || '/campus' : c.list_path || '/off-campus/position-list'}` },
      body: JSON.stringify({
        channel: kind === 'campus' ? c.campus_channel || 'campus_group_official_site' : 'group_official_site',
        language: 'zh', key: keyword, pageIndex: index + 1, pageSize: size, regions: c.regions || '', categories: '',
        subCategories: kind === 'campus' ? c.campus_sub_categories || '' : c.sub_categories || '',
      }),
    });
    if (!data.success) throw Error(`alitalent_search_failed_${data.errorCode}: ${data.errorMsg || ''} ${url}`);
    return { leads: normalize(company, data, kind), total: data.totalCount ?? data.content?.totalCount ?? 0 };
  });
  return [
    ...(wanted.includes('social') ? await search('social') : []),
    ...(campus ? (await search('campus')).filter((l) => wanted.includes(l.recruit_type)) : []),
  ];
}

// 2026-10-13 实测：控股招聘站用这一精确详情接口；关闭岗位仍有 title，但 content 为 null。
// 只认已核实的主机/路径/渠道。其他 BU 的空 content 可能是渠道不对，不能据此关闭。
export async function checkPosting(l) {
  const u = new URL(l.url);
  if (u.hostname !== 'talent-holding.alibaba.com' || u.pathname !== '/off-campus/position-detail') return null;
  const id = u.searchParams.get('positionId');
  if (!id || (l.source_job_id && String(l.source_job_id) !== id)) return { verdict: 'unclear', reason: 'posting_id_mismatch' };
  const { jar, query } = await session({ origin: u.origin });
  const endpoint = `${u.origin}/position/detail`;
  const data = await json(endpoint + query, { jar, method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': CN_USER_AGENT, Origin: u.origin, Referer: l.url }, body: JSON.stringify({ channel: 'kgjt_group_official_site', language: 'zh', id }) });
  const evidence = { url: endpoint, posting_id: id, success: data?.success, ...(data?.content === null ? { content: null } : {}) };
  if (data?.success === true && data.content === null) return { verdict: 'gone', reason: 'official_detail_missing', evidence };
  if (data?.success === true && String(data.content?.id) === id && data.content?.name) return { verdict: 'job', reason: 'official_detail', evidence };
  return { verdict: 'unclear', reason: 'official_detail_unrecognized', evidence };
}
