import { tenureClauses, tenureQuoteText } from './experience-requirements.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { postReason } from './post-signals.mjs';
import { hash } from './store.mjs';
import { selectCityQuota } from "./city-quota.mjs";
// A city sprint (config/pipeline.json `city_sprint`) narrows recommendation and
// submission to one city; it is a prefilter reason so stale rows retire too.
import { sprintAllows, SPRINT_PREFILTER_REASON } from "./city-sprint.mjs";
import { decidedLead, saidLead, endedLead, postingClosed } from "./lead-state.mjs";
// The preference table is a leaf module (store + city rules only), so ranking
// and prefiltering can consult what the user taught the system without a cycle.
import { preferenceScore, learnedPrefilterReason } from "./preferences.mjs";
// Pool-quality rules (degree bar, company type, posting quality, company age)
// the user can edit in config/quality-rules.json. Also a leaf module.
import { qualityReason, QUALITY_REASONS } from "./quality.mjs";
import { PREFILTER_WORD } from './prefilter-words.mjs';
// When Jev has read the posting (lib/judgements.mjs), the grade, family and
// specialty gates below are decided from that reading instead of the title
// regexes. Leads judged before the rebuild, and tests, still take the regex path.
import { postingPrefilterReason, PERSONAL_TERMS, isHuman, JUDGEMENT_VERSION } from "./judgements.mjs";
import { screening, levelText, DEFAULT_YEARS, tenureFit, TENURE_WORD, experienceYears, techTenure, domainTenure, worseTenure, keepDomainConflict } from "./screening.mjs";
// The target and relocation cities (candidate/facts.yaml) live in lib/city.mjs.
import { cityConfig, cityEn, citySource } from "./city.mjs";
// 求职方向（lib/directions.mjs）和能合法工作的地区（lib/work-auth.mjs）：主方向不是软件、或不只能在中国工作的人
// 走下面的通用分支；作者本人（软件、只在中国）走的每一行都和以前一样。
import { titleFamilies, trackFamilyGroups, INTERN_WORDS, internshipWeight, isGeneral, DIRECTIONS, levelYears, tradeLevelYears, cohortMismatch } from "./directions.mjs";
import { workRegions, remoteOutsideRegions, US_LOCATION, chinaOnly, sponsorshipVerdict, workAuthStated, WORK_AUTH_REQ, UNSTATED_REF, NOT_STATED, asksWorkAuth } from "./work-auth.mjs";
import { hardGateGaps } from "./certifications.mjs";
import { currentFacts } from "./facts.mjs";
import { softSkill, anyOfSatisfied, techsIn, hasSkill, domainRe, supportedEvidence } from "./tech-words.mjs";
const locationAliases={北京:'Beijing',上海:'Shanghai',杭州:'Hangzhou',苏州:'Suzhou',深圳:'Shenzhen',成都:'Chengdu',南京:'Nanjing',合肥:'Hefei'};
function namedLocationRequirement(req,location){
  const m=String(req).match(/^(?:能够|可)?(?:在)?(北京|上海|杭州|苏州|深圳|成都|南京|合肥)(?:现场)?工作$/);
  return !!m&&(location.includes(m[1])||new RegExp(`\\b${locationAliases[m[1]]}\\b`,'i').test(location));
}
export function normalizeMatchEvidence(result,lead,facts=currentFacts()){
  if(!Array.isArray(result.must_haves))return result;
  const evidence=[lead.jd_text,lead.role,lead.location].filter(Boolean).join('\n');
  // Tenure can be digits or Chinese/English number words before 年/years.
  // Calendar years such as 成立于2023年 are not tenure and must not keep an
  // empty "no minimum stated" item alive as a fake requirement.
  const numericTenure=!!String(lead.jd_text||'').match(YEAR_SPAN);
  return {...result,must_haves:result.must_haves
    // An explicit statement that no minimum was specified is not a
    // qualification, whatever `critical` flag the model attached to it. It is
    // dropped only when the JD really states no tenure, so no mandatory
    // requirement is waived; the JD-must-be-quoted rule stays intact.
    .filter(r=>{
      if(r.jd_quote||numericTenure||!/工作年限|最低.*年限|年限(?:门槛|要求)/.test(r.req))return true;
      const explicitNoMinimum=/JD\s*未|未设|未规定|未要求|未明确|无明确|无最低|不限/.test(r.req);
      const optionalNoMinimum=r.critical===false&&(/未|无/.test(r.req)||/^JD未规定最低年限/.test(r.resume_ref||''));
      return !(explicitNoMinimum||optionalNoMinimum);
    })
    .map(r=>{
      const quote=String(r.jd_quote||'').trim();
      if(!quote)return r;
      if(evidence.includes(quote))return {...r,jd_quote:quote};
      // Recover the literal source span when only spaces/newlines/NBSP differ.
      // Escape all content so model output cannot introduce a regex pattern.
      const pattern=quote.split(/\s+/).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
      const literal=evidence.match(new RegExp(pattern))?.[0];
      return literal?{...r,jd_quote:literal}:r;
    })
    // The prompt labels the location as `Location:<value>`; models sometimes
    // echo the label, with a full-width colon or a space. Only the value counts.
    .map(r=>lead.location&&/^Location[:：]/.test(r.jd_quote||'')&&r.jd_quote.replace(/^Location[:：]\s*/,'').trim()===lead.location?{...r,jd_quote:lead.location}:r)
    .map(r=>locationAliases[r.jd_quote]&&/地点|现场工作/.test(r.req)&&new RegExp(`\\b${locationAliases[r.jd_quote]}\\b`,'i').test(lead.location||'')?{...r,jd_quote:lead.location}:r)
    .map(r=>!r.jd_quote&&lead.location&&(/工作地点|地点可接受|工作资格|工作授权|合法工作资格/.test(r.req)||namedLocationRequirement(r.req,lead.location))?{...r,jd_quote:lead.location}:r)
    // 第 3 轮（主会话 10-02，判断里不涉及松紧的那部分；lib/tech-words.mjs）：模型常把软素质也标成关键、把「A、B、C 之一」
    // 而你会其中一个的标成说不清，于是一条软素质、一条「之一」就把岗位压成待核（第 3 轮首轮 15 个判出推荐 0）。这里定死：
    // 软素质（沟通、团队、抗压、责任心、学习能力……，语言要求不算）一律非关键；「之一」里有你资料技能里的那一项，算满足。
    .map(r=>r.critical!==false&&softSkill(r.req)?{...r,critical:false}:r)
    .map(r=>{if(r.status!=='unknown')return r;const hit=anyOfSatisfied(r.req,facts);return hit?{...r,status:'met',resume_ref:`资料里的技能有 ${hit}`}:r;})
    // 模型常在证据前面留个「unknown;」（开箱第 5 轮）：前缀去掉，只剩 unknown 的照旧当「没有证据」。
    .map(r=>typeof r.resume_ref==='string'&&/^\s*unknown\s*[;；:：,，、]\s*\S/i.test(r.resume_ref)?{...r,resume_ref:r.resume_ref.replace(/^\s*unknown\s*[;；:：,，、]\s*/i,'')}:r)};
}
export function validateMatch(result, lead) {
  // 旧模型输出里的 confirm 不是授权，按当前逐项重建；不能把旧软能力问题带回来。
  const { confirm: oldConfirm, seniority_gap: oldTenure, ...fresh } = result;
  result = fresh;
  if (
    !Array.isArray(result.must_haves) ||
    !result.must_haves.length ||
    !Array.isArray(result.reasons) ||
    result.reasons.length !== 2 ||
    typeof result.biggest_gap !== "string" ||
    !result.eligibility ||
    !["location", "work_auth", "remote_china"].every((k) => typeof result.eligibility?.[k] === "string")
  )
    throw Error("invalid_match_schema");
  if (lead.company_claim && /公司(?:主体|名称|名)(?:缺失|未披露)|缺少(?:可核验的)?公司名称/.test([...result.reasons, result.biggest_gap].join('；'))) throw Error("invalid_requirement_citation");
  const claimedYears = [...[...result.reasons, result.biggest_gap].join('；').matchAll(/JD\s*要求\s*(\d{1,2})\s*年以上/g)].map(m => Number(m[1]));
  if (claimedYears.some(n => n > requiredYears(lead))) throw Error('invalid_requirement_citation');
  for (const r of result.must_haves) {
    if (
      !["met", "transferable", "unknown", "conflict"].includes(r.status) ||
      !r.req ||
      !r.jd_quote ||
      ![lead.jd_text, lead.role, lead.location].filter(Boolean).join("\n").includes(r.jd_quote)
    )
      throw Error("invalid_requirement_citation");
    if (statedYears(r.req) && !statedYears(r.jd_quote)) throw Error("invalid_requirement_citation");
    if (["met", "transferable"].includes(r.status) && !r.resume_ref) throw Error("missing_resume_ref");
  }
  const deterministic = lead.role && lead.location ? prefilter(lead) : null;
  const facts = currentFacts(), general = isGeneral(facts);
  // 判断规则 2（软件方向第 3 轮负责人 10-02，通用路径 10-03 起）：写了年限的那几条，状态按资料里的年限定，不按模型说的（softwareTenure / generalTenure）。
  const tenure = general ? generalTenure(result.must_haves.map(supportedEvidence), lead, facts) : softwareTenure(result.must_haves.map(supportedEvidence), lead, facts);
  // 模型提供逐项证据，规则决定最终状态；摘要也必须来自这份最终结果。
  // K37：不能只在年限等某些状态翻转时重写，否则推荐和分数已重算、正文仍说强排除。
  result = { ...result, must_haves: result.must_haves.map(supportedEvidence) };
  if (tenure) result = { ...result, must_haves: tenure.items };
  // 工作许可一项都没填（开箱第 5 轮，B 方案）：不假定你是哪国公民。资格结论写「没填，不假定」，不拦推荐；JD 明确要求工作资格的那一条
  // 待核，这时整个岗位待核（不走「只差一项、推荐并请你确认」），岗位上给「补充工作许可」。填了的人一字不变。
  const stated = workAuthStated(facts);
  if (!stated) result = unstatedWorkAuth(result);
  // 国籍不能证明一个地点未明岗位的工作许可。模型自己也说地点待核、原文又没有
  // 授权条件时，把「已满足」留在待核；明确的岗位授权条件照原证据判断。
  else if (result.eligibility.location === 'unknown' && !String(lead.location || '').trim()
    && result.eligibility.work_auth === 'met' && !asksWorkAuth(lead.jd_text))
    result = { ...result, eligibility: { ...result.eligibility, work_auth: 'unknown' } };
  // 通用路径：年龄、性别、婚育要求不参与判断（不算冲突、不算待核）。软件方向一条不变。
  const judged = general ? result.must_haves.filter((r) => !PERSONAL_TERMS.test(String(r.req || ""))) : result.must_haves;
  const eligibilityOpen = Object.values(result.eligibility).some((v) => !v || /unknown|待核|未知/i.test(v));
  const conflict =
    (deterministic && deterministic !== "china_remote_unverified") ||
    judged.some((r) => r.status === "conflict" && !r.tenure_preference && !softSkill(r.req)) || Object.values(result.eligibility).some((v) => v === "conflict") || tenure?.fit?.kind === "far";
  // 年限那几条另算（上面已经按年限定了）：差 1–2 年的是待核，差 1 年以内的不拦推荐。
  const unknownCritical = judged.filter((r) => r.status === "unknown" && r.critical !== false && !r.tenure_gap);
  const authAsked = judged.some((r) => r.work_auth_unstated);
  const criticalUnknown = deterministic === "china_remote_unverified" || unknownCritical.length > 0 || eligibilityOpen || tenure?.fit?.kind === "between" || authAsked;
  let verdict = conflict ? "exclude" : criticalUnknown ? "verify" : "recommend";
  // 所有方向（判断规则 1；通用路径 10-03 起）：只差一项关键要求看不出来，别的都清楚（资格、远程、年限）：推荐，岗位上注明这一项请你确认。
  const confirm = verdict === "verify" && unknownCritical.length === 1 && !authAsked && !eligibilityOpen && deterministic !== "china_remote_unverified" && tenure?.fit?.kind !== "between" ? unknownCritical[0] : null;
  if (confirm) verdict = "recommend";
  // 通用路径：真人帖只因年限差 2 年及以上，最多待核（和 Jev 那条路 lib/judgements.mjs judgeMatch 一样，一条要求不排除真人帖）。
  if (general && verdict === "exclude" && tenure?.fit?.kind === "far" && isHuman(lead) && !(deterministic && deterministic !== "china_remote_unverified") && !judged.some((r) => r.status === "conflict" && !r.tenure_gap) && !Object.values(result.eligibility).some((v) => v === "conflict")) verdict = "verify";
  {
    const fit = tenure?.fit, note = fit ? `${TENURE_WORD[fit.kind]}：JD 要求 ${fit.need} 年以上经验，候选人约 ${fit.have} 年${internshipNote()}` : null;
    const ask = confirm ? `${CONFIRM_TEXT}：${String(confirm.req).slice(0, 60)}` : null;
    const notes = [note, ask].filter(Boolean);
    result = { ...result, ...prose(judged, result.eligibility, { confirm, tenureNoted: !!note, rule: deterministic }) };
    result = { ...result, ...(fit ? { seniority_gap: note } : {}), ...(confirm ? { confirm: { req: confirm.req, jd_quote: confirm.jd_quote, text: ask } } : {}), ...(notes.length ? { biggest_gap: result.biggest_gap ? `${notes.join("；")}；${result.biggest_gap}` : notes.join("；") } : {}) };
  }
  // 不只能在中国工作、或主方向不是软件的人（lib/work-auth.mjs、lib/certifications.mjs）：签证担保和证书按规则再看一遍，
  // 和 Jev 那条路（lib/judgements.mjs judgeMatch）同一个口径。作者本人（软件、只在中国）不走这里。
  if (general || !chinaOnly(facts)) {
    const jd = String(lead.jd_text || "");
    // 证书、名单固定的机构背景（四大、红圈所）、法律方向的执业年限，和判断层同一套规则（lib/certifications.mjs hardGateGaps）。
    const visa = stated ? sponsorshipVerdict(jd, facts) : null, cert = isGeneral(facts) ? hardGateGaps(jd, facts).text : null;
    if (visa || cert) {
      // 年限上面已经按判断规则 2 写进 seniority_gap、biggest_gap 了，不因为有签证 / 证书缺口就丢了。
      const notes = [visa && `签证：${visa.note}`, cert].filter(Boolean).join("；");
      return { ...result, verdict: visa?.level === "conflict" ? "exclude" : verdict === "recommend" ? "verify" : verdict, biggest_gap: `${notes}；${result.biggest_gap}`, ...(visa ? { visa, eligibility: { ...result.eligibility, work_auth: visa.level === "conflict" ? "conflict" : result.eligibility.work_auth } } : {}) };
    }
  }
  // 年限上面按规则 2 定好了（两个方向都是）。
  return { ...result, verdict };
}
const OK_STATUS = new Set(["met", "transferable"]);
// 工作许可没填（B 方案）：JD 明确要求工作资格或身份的那一条是待核（证据写明没填，work_auth_unstated）；模型按提示也列了一条「工作资格」、
// 引的却是地点或福利（JD 没要求）的，不算一条要求，去掉。资格结论写 not_stated（「没填，不假定」）。两条路（这里、lib/judgements.mjs judgeMatch）同一条。
export function unstatedWorkAuth(result) {
  const must_haves = (result.must_haves || []).flatMap((r) => !WORK_AUTH_REQ.test(String(r.req || "")) ? [r] : asksWorkAuth(r.jd_quote) ? [{ ...r, status: "unknown", critical: true, resume_ref: UNSTATED_REF, work_auth_unstated: true }] : []);
  return { ...result, must_haves, eligibility: { ...result.eligibility, work_auth: NOT_STATED } };
}
// 按逐项写的理由和主要缺口（和 Jev 那条路 lib/judgements.mjs judgeMatch 同一个写法）：几条有证据、第一条有证据的是什么；
// 缺口写第一条不符合、再第一条关键待核（已经写成「请你确认」、年限缺口已经写在前面的不重复），再资格。都没有：空，前面的说明就是缺口。
function prose(items, eligibility = {}, { confirm = null, tenureNoted = false, rule = null } = {}) {
  const ok = items.filter((r) => OK_STATUS.has(r.status)), cited = ok.find((r) => r.resume_ref && r.resume_ref !== "unknown");
  const open = [...items.filter((r) => r.status === "conflict" && !r.tenure_preference && !softSkill(r.req)), ...items.filter((r) => r.status === "unknown" && r.critical !== false)]
    .filter((r) => r !== confirm && !(tenureNoted && r.tenure_gap));
  const eligibilityGap = [['work_auth', '工作资格'], ['location', '工作地点'], ['remote_china', '远程工作资格']]
    .filter(([k]) => !['met', NOT_STATED, 'not_applicable', undefined].includes(eligibility[k]));
  const authConflict = eligibilityGap.find(([k]) => eligibility[k] === 'conflict');
  const pending = items.find(r => r.status === 'unknown' && r.critical === false && !r.tenure_preference && !softSkill(r.req));
  const gap = rule ? PREFILTER_WORD[rule] || '岗位不符合当前筛选范围'
    : authConflict ? `不符合：${authConflict[1]}`
    : open[0]?.status === 'conflict' ? `不符合：${String(open[0].req).slice(0, 60)}`
    : eligibilityGap.length ? `${eligibilityGap[0][1]}待核`
    : open[0] ? `待核：${String(open[0].req).slice(0, 60)}`
    : pending ? `待核（非关键）：${String(pending.req).slice(0, 60)}` : '';
  const second = cited ? `「${String(cited.req).slice(0, 30)}」← ${String(cited.resume_ref).slice(0, 60)}` : open[0] ? `${open[0].status === "conflict" ? "不符合" : "待核"}：${String(open[0].req).slice(0, 60)}` : "逐项见下";
  return { reasons: [`硬性要求 ${ok.length}/${items.length} 条有证据`, second], biggest_gap: gap || (confirm || tenureNoted ? "" : "暂无明确缺口") };
}
// 推荐里带的那一句（判断规则 1）：只差这一项看不出来，岗位上写明，你确认。
export const CONFIRM_TEXT = '这一项简历里看不出来，请你确认';
// 匹配度（D4，负责人 10-02「这个就做呗，反正先上线」）：每条硬性要求满足算 1、可迁移 0.6、看不出来 0.3、冲突 0，关键要求算两倍，
// 折成 0–100。两条路（Jev、文字模型）存下来的 must_haves 都能算，所以读的时候算，不改存下来的判断；通用方向不参与判断的个人条件
// （年龄、性别、婚育）不算。一条要求都没有：null。行上「推荐」旁边、岗位页「判断」旁边显示它，推荐按它排（web/hq.js）。
export const REQ_POINTS = { met: 1, transferable: 0.6, unknown: 0.3, conflict: 0 };
export function requirementScore(match, facts = currentFacts()) {
  const general = isGeneral(facts);
  const items = (Array.isArray(match?.must_haves) ? match.must_haves : []).filter((r) => r && (!general || !PERSONAL_TERMS.test(String(r.req || ""))));
  let got = 0, max = 0;
  for (const r of items) { const w = r.critical === false ? 1 : 2; got += w * (REQ_POINTS[r.status] ?? REQ_POINTS.unknown); max += w; }
  return max ? Math.round((got / max) * 100) : null;
}
// 通用路径（2026-10-03 负责人的判断规则 1、2 推广到所有方向）：同一套（softwareTenure、tenureFit）。法律方向 JD 写了执业年限的
// 按执业证日期算（lib/certifications.mjs hardGateGaps 的 practice，和 Jev 那条路一样），这里不再按工作年限另算。
const generalTenure = (items, lead, facts) => (hardGateGaps(String(lead.jd_text || ""), facts).practice ? null : softwareTenure(items, lead, facts));
// 软件方向的年限（判断规则 2）：每条写了年限的要求按资料里的年限定状态——够了「符合」，差 1 年以内「可迁移」（不拦推荐），
// 差 1–2 年「待核」，差 2 年及以上「不符合」。要求里点了名、而你资料技能里没有的技术（「3 年以上 Java 经验」而你不会 Java）
// 照模型说的：那一条差的是技术，不只是年限。整份 JD 的最低年限（requiredYears）也一起比：模型没单列的年限要求也算数。
// 年限那一句点了技术、你资料技能里也有的（「3 年以上 Golang 开发经验」，开箱第 4 轮 F07）：总年限和这门技术的年限分开看
// （lib/screening.mjs techTenure）。技能表里列了 Go，不拿全部年限顶成「3 年 Go」；写到 Go 的经历不够年数，这一条是待核，
// 只差这一项时按判断规则 1 推荐、注明请你确认。这一句要求本身也说明总年限至少这么多，整份 JD 的最低年限照样跟着比。
function softwareTenure(items, lead, facts) {
  const S = screening(), have = S.years, ref = `资料里约 ${have} 年${internshipNote(S)}`;
  let need = requiredYears(lead, { general: S.general });
  const out = items.map((r) => {
    const text = tenureQuoteText(r.jd_quote, lead), n = statedYears(text, { general: S.general });
    if (!n) return statedYears(r.jd_quote, { general: S.general }) ? { ...r, critical: false, tenure_preference: true } : r;
    const opts = { years: have, hasYears: (c) => statedYears(c, { general: S.general }) > 0 }, techOnly = techTenure(text, n, facts, opts);
    if (!techOnly && techsIn(r.req).some((t) => !hasSkill(facts, t))) return r;
    // 年限那一句点了领域（「2 年以上游戏服务端开发经验」，开箱第 5 轮）：只算写到这个领域的经历（lib/screening.mjs domainTenure）。
    const tech = keepDomainConflict(worseTenure(techOnly, domainTenure(text, n, facts, opts)), r.status);
    need = Math.max(need, n);
    if (tech) {
      // 模型的证据只在它和这一条的算法都说「符合」时留着；领域那一条另要求证据里提到这个领域（不然就是拿总年限顶的）。
      const keep = tech.status === "met" && r.status === "met" && r.resume_ref && r.resume_ref !== "unknown" && (!tech.domains || tech.domains.some((d) => domainRe(d)?.test(String(r.resume_ref))));
      return { ...r, status: tech.status, resume_ref: keep ? r.resume_ref : tech.status === "conflict" || tech.tenure_gap ? ref : tech.ref, ...(tech.tenure_gap ? { tenure_gap: tech.tenure_gap } : {}), ...(tech.techs ? { tech_years: { techs: tech.techs, need: tech.need, have: tech.have } } : { domain_years: { domains: tech.domains, need: tech.need, have: tech.have } }) };
    }
    const fit = tenureFit(n, have);
    if (!fit) return { ...r, status: "met", resume_ref: r.status === "met" && r.resume_ref && r.resume_ref !== "unknown" ? r.resume_ref : ref };
    return { ...r, status: fit.kind === "close" ? "transferable" : fit.kind === "far" ? "conflict" : "unknown", resume_ref: ref, tenure_gap: fit.gap };
  });
  return { items: out, fit: tenureFit(need, have) };
}
export function rank(leads, options = {}) {
  return selectCityQuota(leads
    .filter((l) => l.match?.verdict === "recommend" && !excludedCompany(l) && sprintAllows(l))
    .sort((a, b) => (b.match.score || 0) - (a.match.score || 0) || byPriority(a, b)), options);
}
// The base priority the user set, plus whatever his own decisions have taught
// the system (lib/preferences.mjs). The preference overlay is capped below the
// distance between two cities, so the city order (杭州 > 上海 > 远程 for the
// owner) is never reordered by it.
export function priority(l) {
  return basePriority(l) + preferenceScore(l);
}
export function basePriority(l) {
  const S = screening();
  if (S.general) return (/真人/.test(l.source_type || "") ? 1000 : 0) + (l.wide_source ? 0 : 250) + cityTier(l.location) + generalRoleBoost(String(l.role || ""), S) - (/senior|principal|director|vice president|\bvp\b|manager|资深|高级|总监/i.test(l.role) ? 10 : 0);
  // 工程师选了子方向：第一个子方向 +45、其它子方向 +30、别的软件研发岗 +20（和以前 AI +45、后端 +20 同一个量级）。
  if (S.engineering) {
    const role = String(l.role || ""), T = DIRECTIONS.software.tracks, i = S.tracks.findIndex((t) => T[t].title.test(role));
    return (/真人/.test(l.source_type || "") ? 1000 : 0) + (l.wide_source ? 0 : 250) + cityTier(l.location) +
      (i === 0 ? 45 : i > 0 ? 30 : /backend|back.end|platform|software engineer|软件|开发|工程师|developer/i.test(role) ? 20 : 0) -
      (/senior|staff|principal|director|manager/i.test(role) ? 10 : 0);
  }
  return (
    (/真人/.test(l.source_type || "") ? 1000 : 0) + (l.wide_source ? 0 : 250) +
    // A city preference tier is 5 points, below the existing 10-point
    // location gaps: the first target city gains 5 (120 -> 125), a posting
    // only in the second loses 5 (100 -> 95). This affects priority, never
    // verdict. Multi-city postings get the tier of their best city once.
    // The target cities rank above everything and above each other
    // (lib/city.mjs, from candidate/facts.yaml), then the cities the candidate
    // would relocate to, then the rest of China, then remote.
    cityTier(l.location) +
    (/agent|applied.ai|LLM|AI.application|AI.应用|智能体/i.test(l.role)
      ? 45
      : /backend|back.end|platform|software engineer|软件|数据平台|工具链|全栈|后端/i.test(l.role)
        ? 20
        : 0) -
    (/senior|staff|principal|director|manager/i.test(l.role) ? 10 : 0)
  );
}
// 通用路径的岗位加分：你写的第一个细分（金融的「投行」）+45，其它细分 +30，方向以内的其它类别 +20；
// 应届 / 在读的人，标题写明面向应届（Analyst Program、校招、管培生）的再 +15。和软件方向的 AI / 后端加分同一个量级。
const ENTRY_SIGNAL = /analyst program|graduate (?:program|scheme)|new grad|campus|early careers?|entry[- ]level|rotational|应届|校招|校园招聘|管培|管理培训生|20\d\d\s*届/i;
function generalRoleBoost(role, S) {
  // 细分可以对应几个类别（金融的「资管」= 资管 + 券商研究）：按细分算第几个。
  const fams = titleFamilies(role), groups = trackFamilyGroups(currentFacts());
  const i = groups.findIndex((g) => g.some((f) => fams.includes(f)));
  const family = i === 0 ? 45 : i > 0 ? 30 : fams.some((f) => S.families.includes(f)) ? 20 : 0;
  return family + (['new_grad', 'student'].includes(S.stage) && ENTRY_SIGNAL.test(role) ? 15 : 0);
}
// Target city i scores CITY_TIERS[i] (125, 95 — the owner's 杭州 and 上海);
// any further target city one point less each, never down to the relocation
// tier. Relocation cities 90, the rest of China 80, remote 10.
const CITY_TIERS = [125, 95];
const rankedTier = (i) => CITY_TIERS[i] ?? Math.max(91, CITY_TIERS[1] - (i - 1));
function cityTier(location) {
  const c = cityConfig();
  const i = c.rankedRules.findIndex(([, re]) => re.test(location));
  if (i >= 0) return rankedTier(i);
  if (c.relocationRules.some(([, re]) => re.test(location))) return 90;
  if (/\b(?:China|Beijing|Shenzhen|Chengdu)\b|中国/i.test(location)) return 80;
  // 能在美国工作的人：美国的其它城市和中国的其它城市同一档（只能在中国工作的人不走这一行）。
  if (candidateRegions().includes('us') && US_LOCATION.test(location || '')) return 80;
  if (/remote|worldwide|global|远程/i.test(location)) return 10;
  return 0;
}
// Equal scores break toward the first target city (杭州 for the owner), so a
// posting there is matched ahead of an otherwise identical posting elsewhere.
const inFirstCity = (l) => !!cityConfig().rankedRules[0]?.[1].test(l.location || '');
export const byPriority = (a, b) => priority(b) - priority(a) || Number(inFirstCity(b)) - Number(inFirstCity(a));
// 首轮先判最有希望的（第 3 轮，主会话 10-02）：首轮只判 15 个（op round-first，bin/match.mjs --fit-first），原来按来源、城市、
// 标题排，真人帖一律 +1000，不看岗位要的技术和你会的对不对得上——第 3 轮首轮判的 15 个里有「海外 B2B 市场开发助理」，
// 还有一串要 Java、C++ 的岗位，推荐 0。现在首轮在原来的分上再加「对得上」的分：岗位标题和 JD 里提到你资料技能里的技术，
// 一项 +15（最多三项）；标题点名的技术你一个都不会，-20。真人帖的 +1000 只给对得上的（至少提到一项你会的）。
// 之后的每一轮照旧（byPriority）：这里只管第一印象。
export function fitScore(l, facts = currentFacts()) {
  const title = String(l.role || ''), have = techsIn(`${title}\n${l.jd_text || ''}`).filter(t => hasSkill(facts, t)).length, inTitle = techsIn(title);
  return Math.min(3, have) * 15 - (inTitle.length && !inTitle.some(t => hasSkill(facts, t)) ? 20 : 0);
}
export function byFirstRound(facts = currentFacts()) {
  const memo = new Map();
  const score = l => { if (!memo.has(l)) { const fit = fitScore(l, facts); memo.set(l, priority(l) + fit - (/真人/.test(l.source_type || '') && fit <= 0 ? 1000 : 0)); } return memo.get(l); };
  return (a, b) => score(b) - score(a) || Number(inFirstCity(b)) - Number(inFirstCity(a));
}
export function pendingLead(l) {
  return !l.legacy && !l.superseded && l.status !== 'superseded' && !l.match && !decidedLead(l) && !l.feedback_at && !parkedForJd(l);
}

// 可见的旧判断要校正规则，即使用户已经推进过；用户结束的记录只保留历史。
// 无版本号、无编号的存量判断也必须复查；正常 Judge 执行，不补造历史版本。
export function policyReviewNeeded(l) {
  const version = l.judgement?.version || l.match?.version;
  const judgedAt = Math.max(Date.parse(l.judgement?.at || '') || 0, Date.parse(l.matched_at || '') || 0, Date.parse(l.judged_at || '') || 0);
  const contentChanged = (Date.parse(l.detail_filled_at || '') || 0) > judgedAt;
  return !!((l.record_id || l.id) && l.match && (version !== JUDGEMENT_VERSION || contentChanged) && !l.legacy && !l.superseded && l.status !== 'superseded' && !endedLead(l));
}
// A lead with nothing to read (bin/judge-leads.mjs `needs_jd`) waits for its
// text to change — a detail fetch, a backfill, a forwarded JD — instead of being
// selected and skipped by every judge and match run. The key covers exactly
// what a reading depends on.
export const contentKey = (l) => hash([String(l.role || ''), String(l.jd_text || '')]).slice(0, 16);
export const parkedForJd = (l) => !!l.needs_jd && !l.match && l.needs_jd.key === contentKey(l);
export function hasFullDescription(l) {
  // A verified Maimai detail can be a complete short opening. Missing facts
  // remain unknown to Judge; the post does not need invented filler to reach 100.
  const verifiedPost = l.source === '脉脉' && l.detail_evidence && /真人/.test(l.source_type || '');
  return typeof l.jd_text === 'string' && l.jd_text.trim().length >= (verifiedPost ? 20 : /真人/.test(l.source_type || '') ? 100 : 200);
}
// A JD is one blob of duties, then qualifications, then (for some boards) an
// address. Only the qualification clauses are a gate: a duty that mentions
// fine-tuning describes the team, while a qualification that demands training
// experience describes the hire. Clauses marked 优先/加分/preferred are wishes,
// not gates, and everything after a 加分项 heading inherits that mark.
const OPTIONAL_CLAUSE = /优先|加分|preferred|nice.to.have|a plus|bonus/i;
const OPTIONAL_SECTION = /加分项|优先条件|以下.{0,10}优先/;
export function requirementClauses(l, { whole = false } = {}) {
  const paragraphs = String(l.jd_text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^中国大陆|邮编：/.test(p));
  // With no blank line there is no way to tell duties from qualifications, so
  // the whole text is scanned and the caller demands more evidence instead.
  const separated = paragraphs.length > 1;
  const body = whole ? paragraphs.join('\n') : separated ? paragraphs.slice(1).join('\n') : paragraphs.join('\n');
  let optional = false;
  const clauses = (body + '\n' + String(l.role || ''))
    .split(/[；;。\n]|(?=\s\d+[、.）)])/)
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => {
      if (OPTIONAL_SECTION.test(c)) optional = true;
      return !optional && !OPTIONAL_CLAUSE.test(c);
    });
  return { clauses, separated };
}
// Roles whose core is training or studying models rather than building
// products on top of them. The candidate ships AI applications, agents and
// backends; model training, RL/RLHF/DPO/SFT, pre-training and multimodal
// research are a different job family (candidate/facts.yaml preferences).
const TRAINING_REQUIREMENT = [
  /模型训练/, /模型.{0,4}训练/, /预训练/, /后训练/, /pre-?training/i, /post-?training/i, /训练框架/, /分布式训练/,
  /\bRLHF\b/i, /\bDPO\b/, /\bGRPO\b/, /\bPPO\b/, /\bSFT\b/i, /指令微调/, /偏好对齐/, /奖励建模/, /reward model/i,
  /强化学习/, /reinforcement learning/i, /agentic\s*RL/i, /数据合成/, /算法研究/, /多模态研究/, /多模态对齐/, /跨模态/,
  /模型压缩/, /训练范式/,
  // Self-evolving agents are asked for either as an interest or as a track
  // record; only the track record is a gate.
  /(自进化|self-?evolv|harness evolv)[^；;。\n]{0,40}(经验|实践|落地)/i,
];
// An algorithm or research title is the role's centre of gravity unless it also
// names the application-engineering work the candidate actually does.
const RESEARCH_TITLE = /算法工程师|算法专家|算法研究|算法科学家|策略工程师|算法和策略|研究员|research scientist|research engineer|machine learning engineer|模型训练|预训练|训练框架|强化学习|多模态研究/i;
const TARGET_FAMILIES = ['ai_application', 'backend_platform', 'fullstack'];
const APPLICATION_TITLE = /应用开发|应用研发|后端开发|全栈|平台研发|基础设施|运行环境/;
export function outsideTargetSpecialty(l, { title = true } = {}) {
  const role = String(l.role || '');
  if (title && RESEARCH_TITLE.test(role) && !APPLICATION_TITLE.test(role)) return 'title';
  const { clauses, separated } = requirementClauses(l);
  const hits = clauses.filter((c) => TRAINING_REQUIREMENT.some((p) => p.test(c)));
  return hits.length >= (separated ? 1 : 2) ? hits[0].slice(0, 80) : null;
}
// Tenure the resume can prove now comes from candidate/facts.yaml (lib/screening.mjs:
// experience_summary.years, else the dated work entries, else this default).
export const CANDIDATE_YEARS = DEFAULT_YEARS;
const EN_YEAR_ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const EN_YEAR_TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_YEAR_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const CN_YEAR_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const YEAR_NUMBER = `(?:\\d{1,2}|[一二两三四五六七八九]?十[一二三四五六七八九]?|[零一二两三四五六七八九]|(?:${EN_YEAR_TENS.join('|')})(?:[ -](?:${EN_YEAR_ONES.join('|')}))?|zero|${[...EN_YEAR_ONES, ...EN_YEAR_TEENS].join('|')})`;
// Read a whole range once: matching its upper end separately would invent a
// higher minimum. Keep original offsets so experienceYears checks source text,
// not a rewritten quote; number words never change the literal citation.
const YEAR_SPAN = new RegExp(`(?<![A-Za-z\\d.一二两三四五六七八九十百千〇零])(?:(between)\\s+)?(${YEAR_NUMBER})\\s*\\+?\\s*(?:([‐‑‒–—~～至到-]|to\\b|and\\b)\\s*(${YEAR_NUMBER})\\s*\\+?\\s*)?(?:年|years?\\b|yrs?\\b)`, 'gi');
const UPPER_YEAR_PREFIX = /(?:不超(?:过)?|最多|上限|至多|不足|少于|小于|未满|不满)\s*[:：]?\s*$|\b(?:up to|at most|less than|under|within|no more than|maximum(?: of)?)\s+$/i;
function yearNumber(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.includes('十')) { const [tens, ones] = raw.split('十'); return (CN_YEAR_DIGITS[tens] || 1) * 10 + (CN_YEAR_DIGITS[ones] || 0); }
  if (Object.hasOwn(CN_YEAR_DIGITS, raw)) return CN_YEAR_DIGITS[raw];
  const [first, second] = raw.toLowerCase().split(/[ -]/);
  if (EN_YEAR_TENS.includes(first)) return (EN_YEAR_TENS.indexOf(first) + 2) * 10 + EN_YEAR_ONES.indexOf(second) + 1;
  return [...EN_YEAR_ONES, ...EN_YEAR_TEENS].indexOf(first) + 1;
}
// A senior grade in the title is the posting's level, and the level is decided
// before any matching call: `prefilter` retires those roles outright. What is
// left for this gate is a JD that states a minimum tenure the resume cannot
// reach, whatever grade the title advertises.
// 一段文字里写明的最低年限（「N 年以上」「至少 N 年」「N-M 年」「N+ years」）；没写就是 0。
// 两条路径都只认跟经验连在一起的（lib/screening.mjs experienceYears），排除公司成立年数。
// 也认不带「以上」的写法（「从业5年」「经验要求：2年」「3 years of experience」「2‑5年」「1 to 5 years」，区间按下限），
// 也要跟经验连着；区间的上限、「以内」不算。
export function statedYears(text, { general = false } = {}) {
  const source = String(text ?? ''); let years = 0;
  for (const m of source.matchAll(YEAR_SPAN)) {
    const n = yearNumber(m[2]), before = source.slice(Math.max(0, m.index - 30), m.index), after = source.slice(m.index + m[0].length);
    if ((m[3]?.toLowerCase() === 'and' && !m[1]) || (m[4] && yearNumber(m[4]) < n)) continue;
    if (UPPER_YEAR_PREFIX.test(before) || /^(?:以内|以下|内)|^\s+or\s+(?:less|fewer)\b/i.test(after)) continue;
    if (experienceYears(source, m.index, m[0].length)) years = Math.max(years, n);
  }
  return years;
}
// JD 任职要求里写明的最低年限（优先 / 加分的那几句不算）。
export const requiredYears = (l, { general = false } = {}) => Math.max(0, ...tenureClauses(l).map((c) => statedYears(c, { general })));
export function seniorityRequirement(l) {
  const years = requiredYears(l), S = screening(), have = S.years;
  return years > have
    ? `年限缺口：JD 要求 ${years} 年以上经验，候选人约 ${have} 年${internshipNote(S)}`
    : null;
}

// 年限后面那句括注：软件方向「（含实习）」照旧；通用路径按方向说实习怎么算的。
export const internshipNote = (S = screening()) => {
  if (!S.general) return '（含实习）';
  const w = internshipWeight(currentFacts());
  return w === 1 ? '（含实习）' : w === 0 ? '全职经验（实习不算全职年限）' : '经验（实习按一半算）';
};
// 业务拓展类的标题：市场开发、商务拓展、渠道 / 客户开发、招商（判断规则 3）。「业务开发」不算：常是写业务代码的工程师。
const BUSINESS_DEVELOPMENT = /市场开发|商务开发|商务拓展|渠道开发|客户开发|大客户开发|招商|business development|\bBD\b/i;
export function prefilter(l) {
  if (postingClosed(l)) return 'posting_closed';
  if (excludedCompany(l)) return 'company_excluded_by_user';
  // 求职者自己的帖子（not_a_job_post）、LinkedIn 公司主页发的帖子（human_not_direct_hiring）：不是线索（lib/post-signals.mjs）。
  const post = postReason(l);
  if (post) return post;
  const role = String(l.role || '');
  // What the user taught the system by passing on the same kind of posting three
  // times with a reason (state/learned-prefilters.json). It runs first so a rule
  // the user can read and switch off is also the first thing that retires a lead.
  const learned = learnedPrefilterReason(l);
  if (learned) return learned;
  // A degree bar below 本科, an outsourcing/staffing company, a low-quality
  // posting or a company younger than the user's floor. Read from
  // config/quality-rules.json, so the user can loosen any of them.
  const quality = qualityReason(l);
  if (quality) return quality;
  // Role families and grades follow the candidate (lib/screening.mjs): with the default profile — about
  // two and a half years, software engineering only — every rule below is the one written here before.
  const S = screening();
  // 校招届别对不上（第 3 轮负责人 10-02，判断规则 4）：软件方向在这里挡，Jev 和文字模型两条路都先过预筛。认届别和通用路径
  // （lib/judgements.mjs judgeMatch）是同一个（lib/directions.mjs cohortMismatch）：只对在读、应届生；看不出届别的照常判断。
  if (!S.general && cohortMismatch(`${role}\n${l.jd_text || ''}`, currentFacts(), { years: S.years })) return 'cohort_mismatch';
  if (l.judgement?.posting) {
    const judged = postingPrefilterReason(l.posting_closed === false ? { ...l.judgement.posting, still_open: true } : l.judgement.posting, l);
    if (judged) return judged;
    // A confident reading that found nothing to retire settles the title
    // gates; only the location rules still apply. An unsure reading (grade or
    // family below the confidence floor) falls through to the regexes.
    if (l.judgement.posting.grade_confident !== false && l.judgement.posting.family_confident !== false) return locationPrefilter(l);
  }
  if(role==='软件工程岗位（原帖待核）')return 'human_role_not_explicit';
  if(/职位分享|招聘汇总|岗位汇总/i.test(role))return 'human_not_direct_hiring';
  if (S.general) return generalPrefilter(l, role, S);
  if (!S.allow.has('qa') && /\b(?:QA|SDET)\b|quality assurance|test(?:ing)?(?: development| automation)? engineer|测试/i.test(role)) return 'excluded_role';
  if (!S.allow.has('product') && /\b(?:BA|PM)\b|business analyst|project manag|product manag|业务分析|商业分析|项目管理|产品经理/i.test(role)) return 'excluded_role';
  // Any senior grade in the title is out of range at about two and a half
  // years: a posting advertised as Senior, Staff, Lead, Architect or 资深/高级/
  // 专家 is filled at that grade even when a junior grade shares the title, and
  // applying to one spends a real application slot for nothing.
  if (S.seniorTitle.test(levelText(role, S))) return 'seniority_out_of_range';
  // 工程师选了子方向：标题里写着大厂职级（「P7」「2-2」），这一级通常要的年限比你多出 3 年以上，入库前就挡掉（lib/directions.mjs LEVELS）。
  if (S.engineering) { const need = levelYears(role, l.company); if (need != null && need > S.years + 3) return 'seniority_out_of_range'; }
  // Examine requirement clauses, consuming an entire range so 3–8 is not
  // mistaken for an eight-year minimum. Preferred tenure never becomes a gate.
  if (jdYearsOverCap(l, role, S)) return 'seniority_out_of_range';
  const industrial = !S.allow.has('hardware') && !S.allow.has('research');
  if (industrial && /automotive|manufactur|robot|supply.chain|quality|process (?:development |technology |design )?engineer|production technology engineer|industrial engineer|\bBMS\b|embedded|firmware|\b(?:ADAS|ECU|HIL|PLC|BPS|ESH|IE)\b|I4\.0|机械|硬件|汽车|制造|机器人|供应链|质量|工艺|产线|智驾|泊车|标定|雷达信号|电控|电机|电驱|底盘|嵌入式|感知算法|计算机视觉|视觉硬件/i.test(role)) return 'outside_target_specialty';
  if (industrial && /electronics?|semiconductor|mechatronics|powertrain|transmission|brake|axle|inverter|thermal|assembly|packaging|purchasing|commissioning|component.*(?:design|engineer)|electromagnet|analog layout|PCB|MEMS|\b(?:HW|SiC|NVH|EMC|FCM|MFQ|MFE|PUQ|PQA)\b|industrialisation|vehicle|autonomous driv|functional safety|system safety|radar|computer vision|motion planning|油缸|模具|变频器|液压|开关工程|制动|设备|精密测量|电液|主动安全|传感|座舱|电路|减速机|厂务|产能|供应商|半导体|包装|物流|生产|加热器|驾驶|压缩机|车载|焊接|安全气囊|消防|行车|安卓|建图|被动安全|马达|热管理|失效分析|壁挂炉|视觉算法|驱动系统/i.test(role)) return 'non_software_role';
  // When Jev read the posting and leaned to an application family without
  // clearing the confidence floor ("大模型算法工程师（Agent方向）": 0.69
  // ai_application), the word 算法 in the title does not overrule that reading;
  // training requirements in the qualifications still do.
  const leansApplication = (S.engineering ? S.trackFamilies : TARGET_FAMILIES).includes(l.judgement?.posting?.job_family);
  if (!S.allow.has('research') && outsideTargetSpecialty(l, { title: !leansApplication })) return 'outside_target_specialty';
  // Same for a title that is a direction rather than a job name ("大模型研究平台方向"):
  // Jev's lean to an application family decides, not the missing word 工程师.
  if (!leansApplication && !S.allow.has('product') && !S.allow.has('non_engineering') && !/engineer|developer|scientist|research|技术|研发|开发|工程|架构/i.test(l.role)) return "non_target_role";
  // 完全不在方向里的岗位直接排除（第 3 轮负责人 10-02，判断规则 3）：「市场开发」「商务拓展」的「开发」不是写代码——第 3 轮首轮判的
  // 「海外B2B市场开发助理」就是这样过了上面那一条。标题里没有工程师、研发这类词的才算；原因和通用路径同一个（outside_target_specialty）。
  if (!S.allow.has('non_engineering') && BUSINESS_DEVELOPMENT.test(role) && !/engineer|developer|工程师|研发|程序|架构/i.test(role)) return "outside_target_specialty";
  if (!S.allow.has('mobile') && /\bandroid\b|\bios\b|\bmobile\b|flutter|react.native/i.test(l.role)) return "outside_target_specialty";
  if ((!S.allow.has('non_engineering') && /sales|recruit|销售/i.test(l.role)) || (!S.allow.has('intern') && /intern\b|internship|实习/i.test(l.role)) || (!S.allow.has('frontend') && /frontend|front.end|纯前端|前端工程师兼设计师/i.test(l.role)) || (!S.allow.has('quant') && /quant|trading/i.test(l.role))) return "excluded_role";
  if ((!S.allow.has('hardware') && /mechanical|hardware|ASIC|acoustic|battery|机械|硬件|锂电|声学|质量工程师|电驱|逆变器/i.test(l.role)) || (!S.allow.has('non_engineering') && /procurement|logistics|采购|财务/i.test(l.role)))
    return "non_software_role";
  return locationPrefilter(l);
}
// Examine requirement clauses, consuming an entire range so 3–8 is not mistaken
// for an eight-year minimum. Preferred tenure never becomes a gate.
function jdYearsOverCap(l, role, S) {
  const experience = String(l.jd_text || '').split(/[\n。；;.]/).concat(role);
  return experience.some(line => {
    const patterns=[/(\d+)\s*(?:[-–至到]\s*\d+)?\s*(?:年以上|年及以上|年或以上|年(?:的)?(?:相关)?(?:工作|开发|研发|工程)经验)/g,/(\d+)\s*(?:[-–]|to)?\s*(?:\d+)?\s*\+?\s*years?['’]?\s+(?:of\s+)?(?:[a-z/-]+\s+){0,5}experience/gi];
    return patterns.some(pattern=>[...line.matchAll(pattern)].some(m=>Number(m[1])>=S.jdYearsCap&&(!S.general||experienceYears(line,m.index,m[0].length))&&!/preferred|nice.to.have|优先|加分|not required|不要求/i.test(line.slice(Math.max(0,m.index-30),m.index+m[0].length+30))));
  });
}
// 通用路径（金融、咨询、市场……）只看标题就能定的几条：级别（这些行业的说法）、JD 写死的年限、实习岗（在读或你说要实习才推）、
// 明显是别的方向的岗位（标题只落在方向以外的类别：软件工程、硬件、设计、人力……；拿提成的销售算你不做的岗位）。
// 标题认不出类别的不在这里判，留给读 JD 的判断。
function generalPrefilter(l, role, S) {
  if (S.seniorTitle.test(levelText(role, S))) return 'seniority_out_of_range';
  if (jdYearsOverCap(l, role, S)) return 'seniority_out_of_range';
  // 金融、会计、律所的职级（lib/directions.mjs TRADE_LEVELS，仅供参考）：这一级通常要的年限比你多出 3 年以上，入库前挡掉；差得少的留给判断写成年限缺口。
  const need = tradeLevelYears(role, currentFacts());
  if (need != null && need > S.years + 3) return 'seniority_out_of_range';
  if (!S.internships && INTERN_WORDS.test(role) && !/实习律师/.test(role)) return 'excluded_role';
  const fams = titleFamilies(role);
  // 拿提成的销售（保险代理、电话销售、理财 / 课程 / 置业顾问）算你不做的岗位：标题同时像别的类别也一样，选了销售方向也一样。
  if (fams.includes('commission_sales') && !S.families.includes('commission_sales') && !S.adjacent.includes('commission_sales')) return 'excluded_role';
  if (fams.length && !fams.some((f) => S.families.includes(f) || S.adjacent.includes(f))) return fams.includes('sales_bd') ? 'excluded_role' : 'outside_target_specialty';
  return locationPrefilter(l);
}
// The location gates: pure string rules on the location field, shared by the
// regex path and the judged path. A remote posting open only to the US/Europe
// passes if it names China, a target city (in English) or the whole world; a
// posting passes the China check if it names China, one of the cities below, or
// any city the user configured (lib/city.mjs) — for the owner the configured
// cities are already on the list, so the rule is the one written here before.
const CHINA_CITIES = ['杭州', '上海', '苏州', '北京', '深圳', '成都', '南京', '合肥'];
let locationMemo = { config: null, rules: null };
function locationRules() {
  const c = cityConfig();
  if (locationMemo.config === c) return locationMemo.rules;
  const rankedEn = c.ranked.map(cityEn).filter(Boolean);
  const named = [...new Set([...CHINA_CITIES, ...c.ranked, ...c.relocation])];
  const rules = {
    remoteOk: new RegExp(`\\b(?:China|${[...rankedEn, 'worldwide', 'global'].join('|')})\\b`, 'i'),
    chinaNamed: new RegExp(`\\bChina\\b|中国|${named.map(citySource).join('|')}`, 'i'),
  };
  locationMemo = { config: c, rules };
  return rules;
}
// 你能合法工作的地区（lib/work-auth.mjs）；同一份 facts 只算一次。
let regionMemo = { facts: null, regions: ['cn'] };
function candidateRegions() {
  const facts = currentFacts();
  if (regionMemo.facts !== facts) regionMemo = { facts, regions: workRegions(facts) };
  return regionMemo.regions;
}
// 不只能在中国工作的人（例如在美国、拿 OPT 的毕业生）：远程岗位只要对你能工作的地区开放就行；有城市的岗位在你的目标 /
// 可搬迁城市，或在你能工作的国家里，都交给判断去看（和下面中国那一套同一个意思：只挡明显去不了的）。
function regionLocationPrefilter(l, regions) {
  const loc = String(l.location || '');
  if (remoteOutsideRegions(loc, regions)) return 'remote_region_conflict';
  const c = cityConfig();
  if ([...c.rankedRules, ...c.relocationRules].some(([, re]) => re.test(loc))) return null;
  if (regions.includes('us') && US_LOCATION.test(loc)) return null;
  if (regions.includes('cn') && locationRules().chinaNamed.test(loc)) return null;
  // 没写地点、「3 Locations」、只写了远程：说不清的交给判断。
  if (!loc.trim() || loc === '未标注' || /^\d+\s+locations?$/i.test(loc) || /remote|worldwide|global|anywhere|远程/i.test(loc)) return null;
  return 'outside_target_location';
}
function locationPrefilter(l) {
  const regions = candidateRegions();
  if (!(regions.length === 1 && regions[0] === 'cn')) return regionLocationPrefilter(l, regions);
  // A city sprint (config/pipeline.json `city_sprint`) no longer prefilters:
  // postings elsewhere are matched as usual and only held from the default
  // views and new outreach (lib/city-sprint.mjs sprintHold).
  const { chinaNamed, remoteOk } = locationRules();
  if (
    /remote|远程/i.test(l.location) &&
    /\bUS\b|United States|USA|Canada|UK|United Kingdom|EMEA|Europe/i.test(l.location) &&
    !remoteOk.test(l.location) &&
    !(/真人/.test(l.source_type || '') && /\bAPAC\b|Asia.Pacific/i.test(l.location))
  )
    return "remote_region_conflict";
  if (!chinaNamed.test(l.location)) {
    if (!String(l.location || '').trim() && l.needs_city_check) return null;
    // A named Maimai opening with no stated city, or a link the user forwarded
    // whose page gave no city, reaches matching as unknown: the judgement names
    // 工作地点待核 as the gap instead of retiring the lead.
    if (l.source === '脉脉' && l.source_type === '真人招聘帖' && !l.anonymous && l.needs_city_check === true && l.location === '未标注') return null;
    if (l.source_type === '用户转发' && (!String(l.location || '').trim() || l.location === '未标注')) return null;
    // A company whose board lists postings without a city (companies.yaml `unlisted_city: keep`, lib/ats/cn.mjs
    // cityGate) sends them as 未标注 with needs_city_check; boards without the switch still drop them before here.
    if (l.source === 'official_ats' && l.needs_city_check === true && l.location === '未标注') return null;
    // 远程 is how a Chinese post says remote; it used to fall through to
    // outside_target_location, which retired every remote 脉脉 opening.
    if (/remote|worldwide|global|远程/i.test(l.location)) return /真人/.test(l.source_type||"") ? null : "china_remote_unverified";
    return "outside_target_location";
  }
  return null;
}

// Hard scope rules that must hold regardless of what the model concluded earlier.
// `prefilter` normally runs before the model is called, so a lead judged under an
// older rule set keeps its verdict forever. Callers that surface `verify` leads to
// the user re-test them here, so tightening `prefilter` also retires stale rows.
export const STALE_PREFILTER_REASONS = ['company_excluded_by_user','seniority_out_of_range', 'cohort_mismatch', 'outside_target_specialty', 'excluded_role', 'non_software_role', 'posting_closed', 'human_not_direct_hiring', 'not_a_job_post', SPRINT_PREFILTER_REASON, ...QUALITY_REASONS];
export const outOfScopeNow = (l) =>
  !saidLead(l) && !l.legacy && !!l.role && !!l.location && STALE_PREFILTER_REASONS.includes(prefilter(l));
