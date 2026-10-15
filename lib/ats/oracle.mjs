// Oracle Cloud HCM 的招聘站（Candidate Experience），地址形如 <租户>.fa.<机房>.oraclecloud.com。
// 摩根大通全球的岗位都在 jpmc.fa.oraclecloud.com 的 CX_1001 站点上，包括给应届生的 Analyst / Associate
// Program 和暑期实习。页面是脚本渲染的，数据来自同一个租户上的两个公开接口：列表
// recruitingCEJobRequisitions 和详情 recruitingCEJobRequisitionDetails，不登录、不带 cookie 就能读
// （2026-09-29 核对，docs/channels.md）。
//
// 大租户动辄几千个岗位（摩根大通当天 7480 个），所以不翻全站，而是用页面自己的筛选（facet）只取要的那一块，
// 比如「美国」+「Program Analysts & Associate」只有 161 个。facet 的编号就是页面筛选栏里那些选项的 Id，
// 接口在 facetsList 里也会列出来（locationsFacet、titlesFacet、categoriesFacet……）。关键词搜索是按相关度的
// 模糊搜索（搜 summer analyst 会带出不相干的岗位），能用 facet 就少用 queries。
//
// companies.yaml:
//   - name: JPMorgan Chase
//     ats_type: oracle
//     origin: https://jpmc.fa.oraclecloud.com
//     site_number: CX_1001                # 页面源码里的 siteNumber=CX_…，不是网址里的站点名
//     facets:
//       locations: ["300000000289738"]   # United States
//       titles: [PAA]                     # Program Analysts & Associate
//     careers_url: https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs
import { json, plain, lead } from './http.mjs';
import { describe } from './describe.mjs';

const REST = '/hcmRestApi/resources/latest';
// companies.yaml 里的写法 → finder 里的参数名。
const FACETS = {
  locations: 'selectedLocationsFacet', titles: 'selectedTitlesFacet', categories: 'selectedCategoriesFacet',
  posting_dates: 'selectedPostingDatesFacet', organizations: 'selectedOrganizationsFacet', workplace_types: 'selectedWorkplaceTypesFacet',
};
// finder 的参数之间用逗号、同一个 facet 的几个值之间用分号，值本身再带这两个符号（或引号）就会把查询拆坏。
const clean = (v) => String(v ?? '').replace(/[,;"]/g, ' ').replace(/\s+/g, ' ').trim();
const value = (v) => encodeURIComponent(clean(v));

// 页面自己发的就是这个形状：findReqs;siteNumber=CX_1001,selectedLocationsFacet=…,keyword=%22…%22,limit=25,offset=0,…
export function finder(c, { keyword = '', offset = 0, limit = 25 } = {}) {
  const parts = [`siteNumber=${value(c.site_number)}`];
  for (const [key, name] of Object.entries(FACETS)) {
    const values = [c.facets?.[key]].flat().map(clean).filter(Boolean);
    if (values.length) parts.push(`${name}=${encodeURIComponent(values.join(';'))}`);
  }
  if (clean(keyword)) parts.push(`keyword=${encodeURIComponent(`"${clean(keyword)}"`)}`);
  // 按城市半径搜（locationId 是地点 facet 里城市那一级的 Id），和 facet 可以一起用。
  if (c.location_id) parts.push(`locationId=${value(c.location_id)}`, `radius=${Number(c.radius) || 25}`, 'radiusUnit=MI');
  parts.push(`limit=${limit}`, `offset=${offset}`, 'sortBy=POSTING_DATES_DESC');
  return `findReqs;${parts.join(',')}`;
}
export const listUrl = (c, opts) =>
  `${c.origin}${REST}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder(c, opts)}`;
export const jobUrl = (c, id) => `${c.origin}/hcmUI/CandidateExperience/${c.language || 'en'}/sites/${c.site_number}/job/${id}`;
// 日期只取年月日：PostingEndDate 是「2026-10-15」，详情里的 ExternalPostedEndDate 带时区时间。
const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

export const normalize = (c, data) =>
  (data?.items?.[0]?.requisitionList || []).filter((r) => r.Id && r.Title).map((r) => {
    const deadline = day(r.PostingEndDate);
    return lead(c, {
      role: String(r.Title).trim(),
      location: [...new Set([r.PrimaryLocation, ...(r.secondaryLocations || []).map((s) => s.Name)].filter(Boolean))].join(' / '),
      url: jobUrl(c, r.Id),
      posted_at: day(r.PostedDate),
      ...(deadline ? { apply_deadline: deadline } : {}),
      // 列表只有一两句简介，全文在详情接口里：留空让 bin/match.mjs、bin/judge-leads.mjs 匹配前调 detail，
      // 不让一句简介冒充完整 JD。
      jd_text: '',
      summary: [plain(r.ShortDescriptionStr), r.JobFamily && `类别：${r.JobFamily}`].filter(Boolean).join('；'),
      source_job_id: String(r.Id),
      ...(r.WorkplaceType ? { work_mode: r.WorkplaceType } : {}),
    });
  });

// 站点编号是页面源码里的 siteNumber=CX_…（CX_1、CX_1001、CX_3002）。写成网址里的站点名（LateralHiring）或别的
// 不存在的编号，接口不报错，而是返回整个租户所有站点的岗位（社招、校招、不公开的混在一起），所以不像编号就直接报错。
export const SITE_NUMBER = /^CX_[A-Za-z0-9]+$/;
export function checkSiteNumber(c) {
  if (!c.origin || !c.site_number) throw Error('oracle_site_missing');
  if (!SITE_NUMBER.test(String(c.site_number).trim()))
    throw Error(`oracle_site_number_invalid: ${c.site_number} 不是站点编号。要写站点页面源码里的 siteNumber=CX_…（网址里的站点名不算），写错时接口会返回整个租户的岗位`);
}

export async function fetchJobs(c) {
  checkSiteNumber(c);
  const size = Math.min(Number(c.page_size) || 25, 100), byId = new Map();
  for (const keyword of c.queries?.length ? c.queries : ['']) {
    let offset = 0;
    // 每个关键词最多翻 max_pages 页（默认 20 页、500 个）：facet 没配好时宁可少读，也不把整个租户翻一遍。
    for (let index = 0; index < (c.max_pages || 20); index++) {
      const url = listUrl(c, { keyword, offset, limit: size });
      const search = (await json(url))?.items?.[0];
      if (!Array.isArray(search?.requisitionList)) throw Error(`oracle_unexpected_response: ${url}`);
      for (const l of normalize(c, { items: [search] })) if (!byId.has(l.source_job_id)) byId.set(l.source_job_id, l);
      offset += search.requisitionList.length;
      if (!search.requisitionList.length || offset >= (Number(search.TotalJobsCount) || 0)) break;
    }
  }
  return [...byId.values()];
}

// 详情：描述、职责、要求三块（摩根大通把三样都写在 ExternalDescriptionStr 里），要求放最后；
// 薪资这类附加栏目（requisitionFlexFields，如 Base Pay/Salary）附在末尾。
export async function detail(c, l) {
  checkSiteNumber(c);
  const url = `${c.origin}${REST}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=${encodeURIComponent(`"${clean(l.source_job_id)}"`)},siteNumber=${value(c.site_number)}`;
  const d = (await json(url))?.items?.[0];
  const text = [d?.ExternalDescriptionStr, d?.ExternalResponsibilitiesStr, d?.ExternalQualificationsStr].map(describe).filter(Boolean);
  if (!text.length) throw Error(`oracle_full_jd_missing: ${url}`);
  const extra = (d.requisitionFlexFields || []).filter((f) => f?.Prompt && f?.Value).map((f) => `${plain(f.Prompt)}: ${plain(f.Value)}`);
  const deadline = day(d.ExternalPostedEndDate);
  return { jd_text: [...text, extra.join('\n')].filter(Boolean).join('\n\n'), ...(deadline ? { apply_deadline: deadline } : {}) };
}
