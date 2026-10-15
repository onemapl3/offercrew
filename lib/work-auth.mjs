// 工作许可和「在哪能合法工作」（2026-09-29，方向通用化的一部分）。
//
// 以前整个系统默认候选人是中国大陆公民、没有海外工作许可：判断模型被告知「候选人是中国大陆公民」，远程岗位只看
// 「能不能在中国做」，申请表里「需要签证担保吗」一律答「不需要」。换成一个在纽约读完书、拿 F-1 OPT 的毕业生，
// 这几处全错——尤其是最后一条：美国的申请表问「现在或将来是否需要担保」，OPT 的人如实答案是「将来需要」，
// 答错是虚假陈述。
//
// 这里只看 candidate/facts.yaml 的 work_authorization：
//   china_mainland: citizen / permanent_resident / work_permit / needs_sponsorship
//   us: citizen / permanent_resident / f1_opt / f1_stem_opt / h1b / needs_sponsorship / none（旧的自由文字照样认）
// 老写法（中国公民、美国 none 或没写）得出的地区就是 ['cn']：判断的问题、预筛、申请表和以前逐字相同。
const str = (v) => (v == null ? '' : String(v).trim());

// 美国：把各种写法归成几档。宁可认不出也不认错：认不出的一律当「没有美国工作许可」（以前的默认，规则一条不变）。
// 页面上选的是这几个值；老 facts 里的自由文字只认明确的说法：
//   - 带「过期 / expired / 以前」的不算（作者本人写的是 F1_expired：以前在美国读过书，现在没有工作许可）；
//   - 说要担保的（「需要 H-1B 担保」「need sponsorship」）是 needs_sponsorship；
//   - 带否定、在办、将来的（「非美国公民」「no green card」「绿卡申请中」「需要 H-1B」「will need OPT」）一律不算有许可。
const US_VALUES = ['citizen', 'permanent_resident', 'f1_opt', 'f1_stem_opt', 'h1b', 'needs_sponsorship', 'authorized', 'none'];
const NOT_NOW = /非|不是|没有|无(?!锡)|(?:^|_)(?:no|not|non)(?:_|$)|non_?us|pending|申请中|排期|在办|waiting|will_?need|(?:^|_)need|需要|将来|未来|计划|after_?graduation|expected|future|ended|结束/;
export function usStatus(facts = {}) {
  const raw = str(facts?.work_authorization?.us), v = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (!v) return 'none';
  if (US_VALUES.includes(v)) return v;
  if (/expired|过期|失效|no_?longer|former|previous|以前|曾经/.test(v)) return 'none';
  if (/sponsor|担保/.test(v)) return 'needs_sponsorship';
  if (NOT_NOW.test(v)) return 'none';
  if (/(?:^|_)(?:u\.?s\.?|american)_citizen|美国公民/.test(v)) return 'citizen';
  if (/green_?card|绿卡|permanent_resident/.test(v)) return 'permanent_resident';
  if (/stem_?opt/.test(v)) return 'f1_stem_opt';
  if (/(?:^|_)opt(?:$|_)/.test(v)) return 'f1_opt';
  if (/(?:^|_)h_?1_?b(?:$|_)/.test(v)) return 'h1b';
  return 'none';
}
// 现在能不能在美国合法工作；将来要不要雇主担保（H-1B）。
export const usAuthorizedNow = (s) => ['citizen', 'permanent_resident', 'f1_opt', 'f1_stem_opt', 'h1b', 'authorized'].includes(s);
export const usNeedsSponsorshipLater = (s) => ['f1_opt', 'f1_stem_opt', 'h1b', 'needs_sponsorship'].includes(s);
export const usNeedsSponsorshipNow = (s) => ['needs_sponsorship', 'h1b'].includes(s); // H-1B 换雇主要新雇主递转签申请

const CN_OK = new Set(['citizen', 'permanent_resident', 'work_permit']);
// 资料里写了任何一项工作许可（中国大陆、美国、海外远程……）就算写了（开箱第 5 轮）。一项都没写：判断不假定你是哪国公民，
// 工作资格一律待核，岗位上给「补充工作许可」（lib/first-round.mjs verifyGaps）。workRegions 的默认（中国）只管预筛和城市，不当证据。
export const workAuthStated = (facts = {}) => Object.values(facts?.work_authorization || {}).some((v) => v != null && String(v).trim() !== '');
// 一条硬性要求说的是不是工作资格 / 身份（「中国大陆合法工作资格」「Must be authorized to work in the US」）。
export const WORK_AUTH_REQ = /工作资格|工作授权|工作许可|合法工作|就业资格|签证|国籍|公民|身份|户口|户籍|work (?:authori[sz]ation|permit)|authori[sz]ed to work|right to work|eligib\w* to work|citizen|visa|sponsor/i;
export const UNSTATED_REF = '资料里没填工作许可';
// 没填时资格结论的取值（主会话 10-03 B 方案）：照实写「没填，不假定」，它本身不算待核、不拦推荐；只有 JD 明确要求工作资格或身份的那一条
// 要求判待核（这时整个岗位待核，补的入口是「补充工作许可」）。
export const NOT_STATED = 'not_stated';
export const NOT_STATED_TEXT = '没填，不假定';
// JD 里这一句是不是在要求工作资格或身份：福利里的「提供户口」「可以办签证」「visa sponsorship available」不算；「不提供签证担保」算（REFUSES 见下）。
const BENEFIT = /提供|协助|帮助|帮忙|解决|可办|可以办|代办|办理|offer|provid|availab|(?:we|company) (?:can|will|do) sponsor|can sponsor|support/i;
export const asksWorkAuth = (quote) => { const q = String(quote ?? ''); return WORK_AUTH_REQ.test(q) && (REFUSES.test(q) || !BENEFIT.test(q)); };
// 能合法工作的地区，顺序就是主次：现居城市在美国就美国在前。
export function workRegions(facts = {}) {
  const cn = CN_OK.has(str(facts?.work_authorization?.china_mainland)), us = usAuthorizedNow(usStatus(facts));
  const livesInUs = isUsLocation(facts?.location?.current_city);
  const out = livesInUs ? [us && 'us', cn && 'cn'] : [cn && 'cn', us && 'us'];
  const regions = out.filter(Boolean);
  // 什么都没写：按以前的默认（中国）处理，不凭空改任何规则。
  return regions.length ? regions : ['cn'];
}
// 老画像：只能在中国工作。判断的问题、预筛、申请表都走以前的原文。
export const chinaOnly = (facts = {}) => { const r = workRegions(facts); return r.length === 1 && r[0] === 'cn'; };
export const homeRegion = (facts = {}) => workRegions(facts)[0];

// 一个地点在不在美国：国名、常见的大城市、「城市, 州缩写」。州缩写区分大小写（「Paris, or remote」里的 or 不是俄勒冈），
// 而且和国家代码撞车的缩写（DE 德国、IN 印度、IL 以色列、CA 加拿大……）只在城市是我们认得的美国城市、或者同时写了
// USA / United States 时才算；「Remote - join us」里的 us 也不算。
const SAFE_STATES = 'AK|CT|DC|FL|HI|IA|KS|MI|NH|NJ|NM|NV|NY|ND|OH|OK|OR|RI|TX|UT|VT|WA|WI|WV|WY';
const US_NAMES = /\b(?:United States|U\.S\.A\.?|U\.S\.|America)\b|\b(?:New York|NYC|Manhattan|Brooklyn|Jersey City|Hoboken|Newark|Princeton|Boston|Cambridge, MA|Chicago|San Francisco|San Jose|Palo Alto|Mountain View|Sunnyvale|Menlo Park|Santa Clara|Redwood City|Los Angeles|San Diego|Irvine|Seattle|Bellevue|Redmond|Austin|Dallas|Houston|Denver|Boulder|Atlanta|Miami|Philadelphia|Pittsburgh|Charlotte|Raleigh|Durham|Baltimore|Bethesda|Washington,? D\.?C\.?|Nashville|Minneapolis|Phoenix|Salt Lake City|Detroit|Stamford|Greenwich|Wilmington)\b|美国|纽约|波士顿|芝加哥|旧金山|西雅图|洛杉矶|硅谷/i;
const US_CODES = new RegExp(`\\b(?:USA|US)\\b|,\\s*(?:${SAFE_STATES})\\b`);
export const isUsLocation = (location) => { const s = str(location); return !!s && (US_NAMES.test(s) || US_CODES.test(s)); };
// 老调用方把它当正则用（.test）。
export const US_LOCATION = { test: isUsLocation };
// 远程只对某个地区开放、而那个地区不含你能工作的地方。
const REGION_WORDS = {
  us: /\bUS\b|United States|USA|North America|Americas/i,
  cn: /\bChina\b|中国|APAC|Asia/i,
};
const OTHER_REGIONS = /\bUK\b|United Kingdom|EMEA|Europe|\bEU\b|Canada|LATAM|Latin America|India|Australia|Japan|Singapore|Germany|France/i;
export function remoteOutsideRegions(location, regions) {
  const s = str(location);
  if (!/remote|远程/i.test(s)) return false;
  if (/worldwide|global|anywhere/i.test(s)) return false;
  const named = Object.entries(REGION_WORDS).filter(([, re]) => re.test(s)).map(([k]) => k);
  if (named.some((r) => regions.includes(r))) return false;
  return named.length > 0 || OTHER_REGIONS.test(s);
}

// ── 给判断模型的说法 ─────────────────────────────────────────────────────────
// 老画像的原句逐字保留（lib/judgements.mjs 以前写死的那几句）。
const LEGACY = {
  work_auth: 'The candidate, a Chinese mainland citizen without a current overseas work permit, is legally eligible for this job without visa sponsorship.',
  work_auth_criteria: { true: 'Job is in mainland China, or remote employing China-based people, or explicitly offers EOR/contractor employment', false: 'Job requires an existing right to work in another country or is remote only within a region excluding China' },
  remote: 'If the job is remote, is the candidate (based in mainland China) eligible?',
  remote_criteria: { met: 'Remote and explicitly open to China or worldwide', not_applicable: 'The job is not remote', unknown: 'Remote but region not stated', conflict: 'Remote restricted to a region excluding China' },
  remote_scope: { china_or_global: 'Explicitly employs people based in China, or worldwide/global remote', other_region_only: 'Remote only within a named region that excludes China (US-only, EU-only, EMEA, LATAM)', unclear: 'Remote but the eligible region is not stated', not_remote: 'The job is not remote' },
  location_remote: 'remote open to China',
};
const REGION_NAME = { cn: 'China', us: 'the United States' };
const US_STATUS_TEXT = {
  citizen: 'a U.S. citizen', permanent_resident: 'a U.S. permanent resident (green card holder)',
  f1_opt: 'an international graduate in the U.S. on F-1 OPT: authorized to work in the U.S. now, but will need employer visa sponsorship (H-1B) later',
  f1_stem_opt: 'an international graduate in the U.S. on F-1 STEM OPT: authorized to work in the U.S. now (up to three years), but will need employer visa sponsorship (H-1B) later',
  h1b: 'on an H-1B visa: a new employer must file a transfer petition (sponsorship)',
  needs_sponsorship: 'not authorized to work in the U.S. without employer visa sponsorship',
  authorized: 'authorized to work in the U.S.',
};
export function judgeWording(facts = {}) {
  // 一项都没填：别的照旧（地点、远程按中国看），工作资格不假定是中国公民（开箱第 5 轮）。
  if (!workAuthStated(facts)) return { ...LEGACY, work_auth: 'The candidate has not stated any work authorization or citizenship. Judge only from what the candidate states; if nothing is stated, it is unknown.' };
  if (chinaOnly(facts)) return LEGACY;
  const regions = workRegions(facts), us = usStatus(facts), cn = regions.includes('cn');
  const parts = [];
  if (regions.includes('us') || us !== 'none') parts.push(`is ${US_STATUS_TEXT[us] || 'not authorized to work in the U.S.'}`);
  if (cn) parts.push('can work in mainland China without a visa (Chinese citizen or resident)');
  const where = regions.map((r) => REGION_NAME[r]).join(' or ');
  const future = usNeedsSponsorshipLater(us);
  return {
    work_auth: `The candidate ${parts.join(', and ')}. Judge whether the candidate is legally eligible for this job as described (location and any visa or citizenship statement).`,
    work_auth_criteria: {
      true: `Job is in ${where}${future ? ' and does not rule out future visa sponsorship' : ''}, or remote employing people there, or explicitly offers the sponsorship the candidate needs`,
      false: `Job requires work rights the candidate lacks: another country, U.S. citizenship or security clearance${future ? ', or it states it will not sponsor a visa now or in the future' : us === 'needs_sponsorship' ? ', or it will not sponsor a visa' : ''}`,
    },
    remote: `If the job is remote, is the candidate (who can work in ${where}) eligible?`,
    remote_criteria: { met: `Remote and explicitly open to ${where} or worldwide`, not_applicable: 'The job is not remote', unknown: 'Remote but region not stated', conflict: `Remote restricted to a region excluding ${where}` },
    remote_scope: { china_or_global: `Explicitly employs people based in ${where}, or worldwide/global remote`, other_region_only: `Remote only within a named region that excludes ${where}`, unclear: 'Remote but the eligible region is not stated', not_remote: 'The job is not remote' },
    location_remote: `remote open to ${where}`,
  };
}

// ── JD 里关于签证担保的话（代码直接读，不靠模型） ────────────────────────────────
// 一句一句看，同一句里既说到担保、又说不给，才算：
//   none：不担保 / 要求无需担保即可工作；future：同一句里还说了「现在或将来」；offered：有一句说提供担保；
//   citizenship：要求美国公民身份，或必须持有安全许可（「不需要 clearance」「clearance 加分」不算）。
// 活动赞助、品牌合作（event / brand / partner sponsorship、赞助）不算签证担保；JD 里引用申请表的问题
// （「will you now or in the future require sponsorship?」）只是提到，也不算。
const MENTIONS = /sponsor|签证担保|工作签证|\bvisa\b/i;
const NOT_VISA = /(?:event|brand|partner|corporate|conference|team|athlete)s? sponsor|sponsorship (?:deals?|opportunit|packages?|sales)|赞助|冠名/i;
const REFUSES = /(?:unable|not able|will not|won't|cannot|can't|do(?:es)? not|are not|is not|no longer|not (?:be )?(?:able|eligible|possible|in a position))\b.{0,50}sponsor|without (?:the need for |requiring |needing )?(?:current or future |any |future |the )?(?:visa |employment |immigration |work )?sponsorship|\bno (?:visa |employment )?sponsorship|sponsorship (?:is |will )?not (?:be )?(?:available|provided|offered|considered)|不(?:提供|能提供|办理|支持)[^。；;]{0,12}(?:签证|担保)/i;
const OFFERS = /(?:we|will|can|is able to|are able to|does|do|may) (?:provide|offer|sponsor)\b|(?:visa )?sponsorship (?:is |will be )?(?:available|provided|offered)|提供(?:工作)?签证/i;
const FUTURE = /now or in the future|current or future|currently or in the future|future (?:visa |employment )?sponsorship|now or at any (?:point|time)|现在或(?:将来|未来)|将来/i;
const CITIZEN = /(?:must|required to|need to) (?:be|hold) (?:a )?US citizen|US citizenship (?:is )?(?:required|mandatory)|only US citizens|(?:must|required to|need to|ability to)(?: be able to)? (?:hold|obtain|maintain|have)(?: and (?:maintain|hold|keep))? (?:an? )?(?:active |current )?(?:secret|top secret|TS\/SCI|government|security)(?: security)? clearance|(?:active |current )?(?:security|secret|TS\/SCI) clearance (?:is )?(?:required|mandatory)/i;
const NOT_REQUIRED = /no (?:security )?clearance (?:is )?(?:required|needed)|not required|is a plus|preferred|nice to have|加分|优先/i;
export function sponsorshipTerms(text = '') {
  const out = { citizenship: false, future: false, none: false, offered: false };
  // 先把 U.S. / e.g. 这类缩写里的点去掉，再按句号切：不然「must be U.S. citizens」会被切成两半。
  const plain = String(text).replace(/\bU\.S\.A\.?/g, 'USA').replace(/\bU\.S\.?/g, 'US').replace(/\be\.g\./gi, 'eg').replace(/\bi\.e\./gi, 'ie');
  for (const sentence of plain.split(/(?<=[.!?;。！？；])\s+|\n+/)) {
    const t = sentence.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (CITIZEN.test(t) && !NOT_REQUIRED.test(t)) out.citizenship = true;
    if (!MENTIONS.test(t) || NOT_VISA.test(t) || /\?\s*$|？\s*$/.test(t)) continue;
    if (REFUSES.test(t)) { out.none = true; if (FUTURE.test(t)) out.future = true; }
    else if (OFFERS.test(t)) out.offered = true;
  }
  return out;
}
// 按你的身份，这份 JD 的签证说法算什么：conflict（肯定不行）/ gap（要你判断）/ null（没问题或没说）。
export function sponsorshipVerdict(text, facts = {}) {
  if (chinaOnly(facts)) return null;
  const t = sponsorshipTerms(text), us = usStatus(facts);
  if (t.citizenship && us !== 'citizen') return { level: 'conflict', note: '要求美国公民身份或安全许可' };
  if (t.offered && !t.none) return null;
  if (usNeedsSponsorshipNow(us) && t.none) return { level: 'conflict', note: '岗位不提供签证担保，你现在就需要担保' };
  if (usNeedsSponsorshipLater(us) && t.future) return { level: 'conflict', note: '岗位写明现在和将来都不担保签证，你以后需要 H-1B' };
  if (usNeedsSponsorshipLater(us) && t.none) return { level: 'gap', note: '岗位要求无需签证担保：你现在用 OPT 可以工作，但以后需要 H-1B，投之前先确认' };
  return null;
}

// ── 申请表里的工作许可和薪资 ────────────────────────────────────────────────────
// 老画像返回 null：调用方（lib/application-form.mjs）照旧写以前那几个固定值。
// 只回答岗位所在国家（美国 / 中国大陆）的问题；香港、别的国家、说不准的，返回 null，交给你答。
// requires_sponsorship 是「现在或将来要不要担保」，requires_sponsorship_now 是「现在要不要」；不知道的是 null。
const US_ANSWERS = {
  citizen: [true, false, false, 'U.S. citizen; no sponsorship needed.'],
  permanent_resident: [true, false, false, 'U.S. permanent resident; no sponsorship needed.'],
  f1_opt: [true, true, false, 'Authorized to work in the U.S. on F-1 OPT; will require H-1B sponsorship in the future.'],
  f1_stem_opt: [true, true, false, 'Authorized to work in the U.S. on F-1 STEM OPT; will require H-1B sponsorship in the future.'],
  h1b: [true, true, true, 'Currently on H-1B; requires transfer sponsorship.'],
  authorized: [true, null, null, 'Authorized to work in the U.S.'],
  needs_sponsorship: [false, true, true, 'Requires visa sponsorship to work in the U.S.'],
  none: [false, true, true, 'Not currently authorized to work in the U.S.; would require sponsorship.'],
};
// 大陆城市（申请表的英文城市名也用这张表，lib/application-form.mjs）。
export const MAINLAND_CITY_EN = {
  北京: 'Beijing', 上海: 'Shanghai', 广州: 'Guangzhou', 深圳: 'Shenzhen', 杭州: 'Hangzhou', 苏州: 'Suzhou', 南京: 'Nanjing', 成都: 'Chengdu',
  重庆: 'Chongqing', 武汉: 'Wuhan', 西安: "Xi'an", 天津: 'Tianjin', 合肥: 'Hefei', 长沙: 'Changsha', 郑州: 'Zhengzhou', 青岛: 'Qingdao',
  厦门: 'Xiamen', 宁波: 'Ningbo', 无锡: 'Wuxi', 济南: 'Jinan', 大连: 'Dalian', 沈阳: 'Shenyang', 福州: 'Fuzhou', 东莞: 'Dongguan',
  佛山: 'Foshan', 珠海: 'Zhuhai', 昆明: 'Kunming', 哈尔滨: 'Harbin', 长春: 'Changchun', 石家庄: 'Shijiazhuang', 南昌: 'Nanchang',
  贵阳: 'Guiyang', 南宁: 'Nanning', 太原: 'Taiyuan', 兰州: 'Lanzhou', 海口: 'Haikou', 常州: 'Changzhou', 温州: 'Wenzhou', 嘉兴: 'Jiaxing',
  绍兴: 'Shaoxing', 南通: 'Nantong', 徐州: 'Xuzhou', 烟台: 'Yantai', 惠州: 'Huizhou', 中山: 'Zhongshan',
};
// 岗位写的是大陆：国名、表里的城市（中文或英文），或 SmartRecruiters 那种结尾的国家代码「, cn」（10-10：「长沙 Changsha」「Xian, cn」认不出，签证一项成了「说不准」）。
const MAINLAND = new RegExp(['\\bChina\\b', '\\bPRC\\b', '中国(?!香港|澳门|台湾)', '大陆', ',\\s*cn\\s*$',
  ...Object.entries(MAINLAND_CITY_EN).flatMap(([zh, en]) => [zh, `\\b${en.replace(/'/g, "'?")}\\b`])].join('|'), 'i');
const ELSEWHERE = /香港|Hong Kong|澳门|Macau|台湾|Taiwan/i;
// 岗位在中国大陆这件事说得准吗（D9，10-05 #482：马来西亚公司、地点写「远程 — China」，表里「需要工作签证吗」答了 No）：
// 只写了大陆的地点、不是远程、没提别的国家或地区，才按「在中国工作」答签证 / 工作许可；说不准就不答，留给你填。
const REMOTE = /remote|远程|anywhere|worldwide|work from home|\bwfh\b|居家|在家办公/i;
const OTHER_PLACE = /Malaysia|马来西亚|Kuala Lumpur|吉隆坡|Singapore|新加坡|Japan|日本|Tokyo|Korea|韩国|Seoul|India|印度|Vietnam|越南|Indonesia|印尼|Thailand|泰国|Philippines|菲律宾|Australia|澳大利亚|United States|\bUSA\b|\bUS\b|美国|Canada|加拿大|United Kingdom|\bUK\b|英国|London|Germany|德国|France|法国|Netherlands|荷兰|Ireland|爱尔兰|Europe|欧洲|\bEU\b|APAC|EMEA|LATAM|Asia|亚洲|Global|全球|Dubai|迪拜|UAE/i;
export const postingInMainland = (location) => { const w = str(location); return !!w && MAINLAND.test(w) && !ELSEWHERE.test(w) && !REMOTE.test(w) && !OTHER_PLACE.test(w); };
export function formWorkAuthorization(lead = {}, facts = {}) {
  if (chinaOnly(facts)) return null;
  const regions = workRegions(facts), us = usStatus(facts), where = str(lead.location);
  if (ELSEWHERE.test(where)) return null;
  if (isUsLocation(where) || (/remote/i.test(where) && regions[0] === 'us' && !MAINLAND.test(where))) {
    const [authorized, future, now, note] = US_ANSWERS[us] || US_ANSWERS.none;
    return { country: 'us', authorized_in_posting_country: authorized, us, china_mainland: facts.work_authorization?.china_mainland || null, requires_sponsorship: future, requires_sponsorship_now: now, note };
  }
  if (!MAINLAND.test(where)) return null;
  // 大陆以外也可能（远程、还写了别的国家）：说不准，不按中国答（D9）。
  if (!postingInMainland(where)) return { country: null, authorized_in_posting_country: null, us, china_mainland: str(facts?.work_authorization?.china_mainland) || null, requires_sponsorship: null, requires_sponsorship_now: null, note: '岗位在哪个国家工作说不准，这一项留给你填' };
  const cn = str(facts?.work_authorization?.china_mainland);
  const citizen = cn === 'citizen' || cn === 'permanent_resident';
  // 外国人的中国工作许可跟着雇主走：换公司要新雇主重新办，所以「要不要担保」说不准，交给你答。
  return {
    country: 'cn', authorized_in_posting_country: citizen ? true : cn === 'work_permit' ? null : false,
    us, china_mainland: cn || null,
    requires_sponsorship: citizen ? false : cn === 'work_permit' ? null : true,
    requires_sponsorship_now: citizen ? false : cn === 'work_permit' ? null : true,
    note: cn === 'citizen' ? '中国大陆公民，在中国境内合法工作；不需要中国工作签证担保。' : cn === 'permanent_resident' ? '中国永久居留，在中国境内合法工作；不需要工作签证担保。' : cn === 'work_permit' ? '持中国工作许可（随雇主办理，换雇主需重新办理）。' : '需要中国工作签证担保。',
  };
}
// 期望薪资：美国的岗位读 compensation.expected_annual_usd（没有就不填），其它照旧人民币。
const firstNumber = (s) => Number(String(s ?? '').replace(/[,，]/g, '').match(/\d{4,}/)?.[0] || 0);
export function formSalary(lead = {}, facts = {}) {
  if (chinaOnly(facts)) return null;
  const c = facts.compensation || {};
  if (isUsLocation(lead.location) || (/remote/i.test(str(lead.location)) && homeRegion(facts) === 'us')) return { currency: 'USD', annual_from: firstNumber(c.expected_annual_usd) || firstNumber(c.floor_annual_usd) || 0, negotiable: true };
  return { currency: 'CNY', annual_from: firstNumber(c.expected_annual_cny) || firstNumber(c.floor_annual_cny), negotiable: true };
}
