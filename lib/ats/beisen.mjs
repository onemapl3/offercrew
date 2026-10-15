// Beisen (北森) recruiting portals, `<tenant>.zhiye.com`. Every tenant serves
// the same public JSON search its own job list page calls; the list already
// carries 职责 (Duty) and 要求 (Require), so no detail round trip is needed.
// A tenant is its origin plus the PortalId printed in the list page's HTML.
//
// 社招、校招、实习是同一个接口，只差 Category（1 社招、2 校招、3 实习），门户上的路径也跟着分：
// /social、/campus、/intern。读哪几类按候选人的阶段来（lib/ats/recruit.mjs）：券商、基金的校招和实习
// 几乎都在北森上（中金、中信建投、国信、银河、华夏基金……，docs/channels.md），只读社招的话应届生什么都看不到。
//
// companies.yaml entry:
//   - name: Rokid
//     ats_type: beisen
//     origin: https://rokid.zhiye.com
//     portal_id: dc50a715-1872-432c-99d4-e3126f1f0c7f   # BSGlobal.PortalId
//     careers_url: https://rokid.zhiye.com/social/jobs
//     loc_ids: ["3301", "3100"]                          # optional
//     recruit_types: [campus, intern]                    # optional：不写按阶段读
//     unlisted_city: keep                                # optional：没写城市的岗位也留下（地点记「未标注」）
//     classification_one: ["3"] / keywords: [财务] / exclude_titles: [咖啡师]   # optional：大租户的筛选，见 fetchJobs 上面
import { json, plain, lead } from './http.mjs';
import { CN_USER_AGENT, cnText, cityGate, citiesOf } from './cn.mjs';
import { recruitTypesOf, internOrCampus } from './recruit.mjs';
import { deadlineField, pastDeadline } from '../deadline.mjs';

const CATEGORY = { social: '1', campus: '2', intern: '3' };
const TYPE_OF = { 1: 'social', 2: 'campus', 3: 'intern' };

const FIELDS = ['Category', 'Kind', 'LocId', 'PostDate', 'Org', 'Degree', 'YearsOfWorking', 'ClassificationOne', 'Salary', 'HeadCount'];
const headers = (c, type = 'social') => ({
  'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'xmlhttprequest', langType: 'zh_CN',
  'User-Agent': CN_USER_AGENT, Referer: `${c.origin}/${type}/jobs`,
});

// 每一行自己带着 CategoryId，所以链接和 recruit_type 看行本身；老的录制数据没有这一栏时按调用方给的类别（默认社招）。
export const normalize = (c, data, type = 'social') =>
  // Status 2 is a closed posting.
  (data.Data || []).filter((j) => j.Id && j.JobAdName && j.Status !== 2).map((j) => {
    const kind = TYPE_OF[j.CategoryId] || type, deadline = deadlineField(j.EndTime);
    return lead(c, {
      role: String(j.JobAdName).trim(),
      location: (j.LocNames || []).join(' / '),
      url: `${c.origin}/${kind}/detail?jobAdId=${j.Id}`,
      // 有的所把实习也放在校招类别里（大华、大信）：校招类别里标题写着实习的，记成实习（lib/ats/recruit.mjs）。
      recruit_type: kind === 'campus' ? internOrCampus(j.JobAdName) : kind,
      ...(deadline ? { apply_deadline: deadline } : {}),
      posted_at: Number(j.PostDateInt) > 0 ? new Date(Number(j.PostDateInt)).toISOString() : null,
      jd_text: cnText(
        plain(j.Duty),
        plain(j.Require),
        [j.Degree && `学历要求：${j.Degree}`, j.YearsOfWorking && `经验要求：${j.YearsOfWorking}`, j.Org && `部门：${j.Org}`].filter(Boolean).join('；'),
      ),
      source_job_id: String(j.Id),
    });
  });

// 老写法 `category: 2` 只读那一类，和以前一样；否则按 recruit_types / 候选人阶段读（lib/ats/recruit.mjs）。
const typesOf = (c) => (c.category && !c.recruit_types ? [TYPE_OF[c.category] || 'social'] : recruitTypesOf(c));

// 大租户要筛（星巴克社招一万八千多个，前几百条几乎全是门店咖啡师），三种写法，没写的公司照旧整类翻完：
//   classification_one: ["3"]   北森接口的 ClassificationOne（门户筛选栏第一组，星巴克 3 = 职能支持，2026-10-02 核对：
//                                18462 → 47）。编号看官网分类链接里的 ?1=[{"id":"3",…}]。
//   keywords: [财务, 审计]       北森接口的 KeyWords（模糊匹配），每个词各翻一遍，重复的只留一条。
//   exclude_titles: [咖啡师]     接口筛不掉的，按标题在本地去掉（不分大小写的子串）。
export const excludedTitle = (c, role) => [c.exclude_titles].flat().filter(Boolean).some((w) => String(role).toLowerCase().includes(String(w).toLowerCase()));

// Tenants are a few dozen to a few hundred postings, so the whole list of each
// kind is paged (keyword search would miss a "Java开发工程师" that names no
// keyword) and the target cities are also checked on this side.
// now 只给测试用：「今天」是哪天。
export async function fetchJobs(c, { now = new Date() } = {}) {
  if (!c.origin || !c.portal_id) throw Error('beisen_tenant_missing');
  const size = c.page_size || 30, cities = citiesOf(c), byId = new Map();
  const keywords = [c.keywords].flat().filter(Boolean).map(String);
  // 校招类别里的实习按标题归成实习后，只留你这个阶段要读的那几类（和 moka 一样）；老写法 category 读到什么留什么。
  const wanted = c.category && !c.recruit_types ? null : new Set(recruitTypesOf(c));
  const classes = [c.classification_one].flat().filter((x) => x != null && x !== '').map(String);
  for (const type of typesOf(c)) for (const keyword of keywords.length ? keywords : ['']) {
    for (let index = 0; index < (c.max_pages || 12); index++) {
      const url = `${c.origin}/api/Jobad/GetJobAdPageList`;
      const data = await json(url, {
        method: 'POST', headers: headers(c, type),
        body: JSON.stringify({
          PageIndex: index, PageSize: size, KeyWords: keyword, SpecialType: 0, PortalId: c.portal_id, DisplayFields: FIELDS,
          // Category 1 = 社招, 2 = 校招, 3 = 实习. LocId takes area codes such as
          // 3301 (杭州, districts included); large tenants set it to page less.
          Category: [CATEGORY[type]], ...(c.loc_ids?.length ? { LocId: c.loc_ids.map(String) } : {}),
          ...(classes.length ? { ClassificationOne: classes } : {}),
        }),
      });
      if (data.Code !== 200) throw Error(`beisen_search_failed_${data.Code}: ${data.Message || ''} ${url}`);
      const leads = normalize(c, data, type);
      for (const found of leads) {
        // 截止日已过的校招、实习岗位不要（lib/deadline.mjs）。
        const l = (!wanted || wanted.has(found.recruit_type)) && !pastDeadline(found, now) && !excludedTitle(c, found.role) && cityGate(c, found, cities);
        if (l && !byId.has(l.source_job_id)) byId.set(l.source_job_id, l);
      }
      if (!leads.length || (index + 1) * size >= (data.Count ?? 0)) break;
    }
  }
  return [...byId.values()];
}
