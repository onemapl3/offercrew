import { canonicalCompany, companyVariants } from './lead-fields.mjs';
import { companyAliasGroups } from './company-aliases.mjs';
import { read } from './store.mjs';
import { sprintAllows, cityPreferenceRule } from './city-sprint.mjs';
import { remoteScope } from './prompt.mjs';
import { familySession } from './accounts.mjs';
export const DISCOVERY_SOURCES = { maimai: '脉脉', linkedin: 'LinkedIn', boss: 'BOSS 直聘', xiaohongshu: '小红书', official: '公司官网', v2ex: 'V2EX', ruanyf: '阮一峰招聘帖', eleduck: '电鸭', hn: 'HN', 'ai-MoonshotAI': 'Moonshot GitHub', 'ai-langgenius': 'Dify GitHub', linuxdo: 'Linux.do' };
// 绑定了才开的来源（负责人 10-02：「LinkedIn 如果它没有绑定的话，就自动是关着」）：
//   - 没绑定——登录检查（lib/login-probe.mjs；过渡期用 ego 的，就是 ego 里的检查）没认定你登好了——自动扫描、找内推人都不碰它，
//     不报「被挡住」、不来信催，渠道里也不算失败；
//   - 绑定以后按开关：你关掉（enabled: false）就一直关着。
// 绑定看 config/portal-sessions.json：这个账号记着已登录，而且是登录检查认定的（last_probe 有内容，或者是自动检测记下的）；
// 只点了「我登好了」、检查没能核对的不算。私信不受这一条管：每一条都要你批准。
export const BOUND_SOURCES = { linkedin: 'linkedin.com' };
export function sourceBound(name, sessions = read('config/portal-sessions.json', { domains: {} })) {
  const domain = BOUND_SOURCES[name];
  if (!domain || sessions?.bound === true) return true;
  const s = familySession(domain, sessions || {});
  return s?.logged_in === true && (!!s.last_probe || s.verified_by === 'login_watch');
}
// 以前的模板写着 enabled: false 和「装好并登录 ego 之后改成 true」：照着模板抄来的那一行不是你关的，按绑定来。
const OLD_STOCK = /^要在装好并登录 ego 浏览器（ego-browser 命令）之后才能扫/;
export const DEFAULT_OFF = new Set(['boss', 'maimai']);
const userOff = p => p?.enabled === false && !OLD_STOCK.test(String(p.reason || ''));
// 这个来源现在开不开、为什么关着：{ on, why }，why = 'off'（开关关着）| 'not_signed_in'（绑定了才开、还没绑定）。
export function sourceState(name, policy = read('config/human-source-policy.json', {}), sessions) {
  const p = policy?.[name];
  if (BOUND_SOURCES[name]) {
    if (userOff(p)) return { on: false, why: 'off' };
    return sourceBound(name, sessions) ? { on: true, why: null } : { on: false, why: 'not_signed_in' };
  }
  // BOSS、脉脉默认关（红线；兜底清单复核 10-03）：策略文件里没写、写坏了，都当关着，只有写明 enabled: true 才开。
  if (DEFAULT_OFF.has(name)) return p?.enabled === true ? { on: true, why: null } : { on: false, why: 'off' };
  return p?.enabled === false ? { on: false, why: 'off' } : { on: true, why: null };
}
// 开关（设置、引导里显示的就是它）：没写的算开着，BOSS、脉脉除外（没写算关着）。以前的模板抄来的 LinkedIn「装好 ego 再改成 true」不算你关的。
export const sourceEnabled = (name, policy = read('config/human-source-policy.json', {})) => sourceState(name, policy, { bound: true }).why !== 'off';
// 自动去扫、去搜它（扫描、找内推人、交给本机 AI 的来源清单）：开关开着，而且绑定了才开的来源已经绑定。
export const sourceActive = (name, policy = read('config/human-source-policy.json', {}), sessions) => sourceState(name, policy, sessions).on;
// 同一家公司的其它名字：排除名单里写了组里任何一个，整组都算排除。只看公司名（company / 招聘者头衔里的雇主），
// 从不看来源或 ATS——飞书招聘是很多公司用的招聘系统，来源里的「飞书」不能排除任何人。
// 英文名按整词比（Lark 不能排除 Clark）；中文名去掉城市前缀和「科技有限公司 / 集团」这类后缀后整名相等
// （「北京飞书科技有限公司」算，「飞书深诺」不算）。
export const COMPANY_ALIASES = [['字节跳动', '字节', 'ByteDance', 'Byte Dance', '字節跳動', '字節', 'TikTok', '抖音', '抖音集团', '火山引擎', '飞书', 'Lark']];
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const coreName = s => norm(s).replace(/^(北京|上海|杭州|深圳|广州|成都|南京|武汉|西安|苏州|天津|重庆)市?/, '').replace(/\([^)]*\)$/, '').replace(/(信息技术|网络技术|科技|技术|网络)?(股份)?(有限)?(责任)?(公司|集团)$/, '').trim();
// 每份排除名单算一次要比的别名（视图里每条线索都要问一遍，不能每次重建正则）。
const aliasCache = new Map();
function aliasTests(names) {
  const groups = [...companyAliasGroups(), ...COMPANY_ALIASES], key = JSON.stringify([names, groups]);
  let tests = aliasCache.get(key);
  if (!tests) {
    const listed = new Set(names.flatMap(companyVariants).map(norm));
    const aliases = [...new Set([...names.flatMap(companyVariants), ...groups.filter(g => g.some(a => companyVariants(a).some(x => listed.has(norm(x))))).flat().flatMap(companyVariants)].map(norm))];
    tests = aliases.map(a => {
      if (!/^[\x00-\x7f]+$/.test(a)) { const core = coreName(a); return text => { const c = coreName(text); return c === core || c === a; }; }
      const re = new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')}([^a-z0-9]|$)`);
      return text => re.test(text);
    });
    aliasCache.set(key, tests);
    if (aliasCache.size > 20) aliasCache.delete(aliasCache.keys().next().value);
  }
  return tests;
}
export function excludedCompany(lead, config = read('config/pipeline.json', {})) {
  const company = String(lead.company || lead.name || '').toLowerCase();
  // A person's post often has no company yet (待核（作者）), while an in-house
  // recruiter's title names the employer ("字节跳动高级招聘HR"). A former
  // employer (前… / ex-…) is not the one hiring.
  const title = String(lead.author_title || '').trim();
  const employer = (!company || /^待核/.test(company)) && !/^(?:前|ex[-\s]|former\b)/i.test(title) ? title.toLowerCase() : '';
  const names = config.discovery?.excluded_companies || [];
  if (company && names.some(name => norm(canonicalCompany(name)) === norm(canonicalCompany(company)))) return true;
  if (names.some(name => { const n = String(name).toLowerCase(); return !!n && (company.includes(n) || (!!employer && employer.includes(n))); })) return true;
  const tests = aliasTests(names);
  if (!tests.length) return false;
  const c = norm(company), e = employer ? norm(employer) : '';
  return tests.some(t => t(c) || (!!e && t(e)));
}
export function discoveryAllows(lead, config = read('config/pipeline.json', {})) {
  return !excludedCompany(lead, config) && (config.discovery?.focus_only !== true || sprintAllows(lead, cityPreferenceRule()));
}
export function discoveryInstructions() {
  const config = read('config/pipeline.json', {}), sources = Object.entries(DISCOVERY_SOURCES).filter(([key]) => sourceActive(key)).map(([, label]) => label);
  const policy = cityPreferenceRule(), remote = !policy || policy.only.includes('远程');
  return `扫描源以 config/human-source-policy.json 为准，只扫描已启用来源：${sources.join('、')}。关闭的来源不得用浏览器或其他入口绕过。按当前求职设置优先 ${policy?.only?.join('、') || '目标城市'}；${remote ? `远程须核实${remoteScope()}` : '当前未选择远程工作'}。排除公司：${config.discovery?.excluded_companies?.join('、') || '沿用质量规则'}。保留现有公司质量、岗位方向与去重规则。先核验原帖日期、完整 JD、招聘人、地点和申请入口，不发送消息或提交申请。`;
}
