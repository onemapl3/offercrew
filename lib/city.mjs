// Which of the city buckets a posting's location falls in, and which cities the
// user wants to work in — the one place in the system that knows.
//
// 目标城市 > 远程 > 其他 is the standing order of the whole system. The target
// cities and their order come from candidate/facts.yaml `location.target_cities`;
// `location.relocation_cities` are the cities the user would move to for a good
// job: never a reason to hold a submission back, but they get no bucket of their
// own (lists, quotas and the Base file them under 其他) — even when they are also
// listed in target_cities.
//
// 例：target_cities [杭州, 上海, 苏州]，relocation_cities [苏州, 南京] → 分组 杭州 > 上海 > 远程 > 其他，
// 可搬迁 苏州 / 南京。一个城市同时写在两处时算可搬迁、不单独成组；要让它单独成组，把它从
// relocation_cities 里拿掉。没有 facts（或没写 target_cities）就没有城市分组：只有 远程 / 其他。
//
// The matcher, the apply channel and the preference table all share this
// definition without importing each other: this module imports only
// lib/facts.mjs, which imports nothing of ours.
import { currentFacts } from './facts.mjs';

export const REMOTE = '远程';
export const OTHER = '其他';
// English spellings a posting may use ("Hangzhou, China"). A city missing here
// is recognised by its Chinese name only.
export const CITY_EN = { 杭州: 'Hangzhou', 上海: 'Shanghai', 苏州: 'Suzhou', 北京: 'Beijing', 深圳: 'Shenzhen', 广州: 'Guangzhou', 成都: 'Chengdu', 南京: 'Nanjing', 合肥: 'Hefei', 武汉: 'Wuhan', 西安: "Xi'an", 重庆: 'Chongqing', 天津: 'Tianjin', 厦门: 'Xiamen', 青岛: 'Qingdao', 大连: 'Dalian', 长沙: 'Changsha', 珠海: 'Zhuhai', 无锡: 'Wuxi', 宁波: 'Ningbo', 香港: 'Hong Kong', 新加坡: 'Singapore' };
// 资料、简历核对和渠道入口共用城市标识：认识的别名显示中文；不猜陌生地名。
const CITY_ALIASES = new Map(Object.entries(CITY_EN).flatMap(([zh, en]) => [[zh, zh], [zh + '市', zh], [en.toLowerCase(), zh]]));
for (const alias of ['hongkong', 'hong kong sar', '香港特别行政区']) CITY_ALIASES.set(alias, '香港');
export function cityName(raw) {
  const s = String(raw ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const key = s.toLowerCase();
  return CITY_ALIASES.get(key) || CITY_ALIASES.get(key.replace(/,\s*(?:china|中国|prc)$/, '')) || s;
}
export function cityNames(value) {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : Object.hasOwn(CITY_EN, cityName(value)) ? [value] : String(value).split(/[\n,，、;；]+/);
  return [...new Set(list.map(cityName).filter(Boolean))];
}
export const cityEn = (name) => CITY_EN[name] || null;
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The Chinese name, or the English one as a whole word: /杭州|\bhangzhou\b/i.
export const citySource = (name) => (CITY_EN[name] ? `${escape(name)}|\\b${escape(CITY_EN[name].toLowerCase())}\\b` : escape(name));
export const cityPattern = (name) => new RegExp(citySource(name), 'i');
const REMOTE_RE = /远程|在家办公|\bremote\b|\bwork from home\b|\bworldwide\b|\banywhere\b/i;
// 列表中已有的双语地点/余杭别名归并；这张表不参与求职城市优先级或投递守门。
const LOCATION_CITY_RULES = [...Object.keys(CITY_EN).map(name => [name, cityPattern(name)]), ['杭州', /余杭|\byuhang\b/i], ['旧金山', /旧金山|\bsan francisco\b/i], ['伦敦', /伦敦|\blondon\b/i]];
const NOT_REMOTE = /(?:不支持|不接受|不考虑|非|不可|无法)\s*远程|\b(?:no|not|non)[\s-]+remote\b|\bremote\s*[:：]\s*(?:no|false)\b/i;
const HYBRID = /混合|\bhybrid\b/i;
const ONSITE = /\bon[\s-]?site\b|到岗|坐班|现场办公/i;
const FULL_REMOTE = /全远程|完全远程|\b(?:fully|100%)\s*remote\b/i;

// 仅远程筛选不把混合/到岗算进去；优先使用招聘页的工作方式，缺省才读地点和已保存的判断。
export function remoteWork(l = {}) {
  const mode = String(l.work_mode || ''), location = String(l.location || '');
  if (NOT_REMOTE.test(mode) || ONSITE.test(mode) || HYBRID.test(mode)) return false;
  if (REMOTE_RE.test(mode)) return true;
  if (NOT_REMOTE.test(location) || ONSITE.test(location)) return false;
  if (HYBRID.test(location) && !FULL_REMOTE.test(location)) return false;
  if (!REMOTE_RE.test(location) && l.judgement?.posting?.city !== 'remote') return false;
  return !NOT_REMOTE.test(String(l.original_body || l.jd_text || ''));
}

// 列表筛选按岗位写出的全部地点取并集，不用求职偏好的单一优先城市分组。
export function locationCities(l = {}) {
  const location = String(l.location || '').normalize('NFKC').replace(/[’‘]/g, "'").replace(/[（(][^）)]*(?:邻近|靠近|周边|距离)[^）)]*[）)]/g, '').replace(/(?:不支持|不接受|不考虑|非|不可|无法)\s*远程|\b(?:no|not)\s+remote\b/gi, '');
  const names = new Set(), remote = remoteWork(l);
  for (const part of location.split(/[\/|;；、\n]+/)) {
    const found = LOCATION_CITY_RULES.filter(([, re]) => re.test(part)).map(([name]) => name);
    found.forEach(name => names.add(name));
    if (REMOTE_RE.test(part)) { if (remote) names.add(REMOTE); continue; }
    if (found.length) continue;
    const place = part.split(/[,，]/)[0].replace(/[（(].*?[）)]/g, '').trim().replace(/市$/, '');
    if (place && !/^(?:China|PRC|CN|中国|全国|国内|境内|Asia|Europe|APAC|EMEA|RemoteOK|城市未写|未知|待确认)$/i.test(place) && !/省$|待确认|未写|未注明|未标注|未提供/.test(place) && /^[\p{L}][\p{L}\s.'’-]{1,39}$/u.test(place)) names.add(cityName(place));
  }
  if (remote) names.add(REMOTE);
  return names.size ? [...names] : ['城市未写'];
}

const names = cityNames;
// The whole city configuration derived from one facts object. Pure; tests call it directly.
export function cityConfigFrom(facts = {}) {
  const loc = facts?.location || {};
  const relocation = names(loc.relocation_cities).filter((c) => c !== REMOTE && c !== OTHER);
  const ranked = names(loc.target_cities).filter((c) => c !== REMOTE && c !== OTHER && !relocation.includes(c));
  return Object.freeze({
    ranked: Object.freeze(ranked),
    relocation: Object.freeze(relocation),
    targets: Object.freeze([...ranked, REMOTE]),
    buckets: Object.freeze([...ranked, REMOTE, OTHER]),
    rankedRules: ranked.map((c) => [c, cityPattern(c)]),
    rules: [...ranked.map((c) => [c, cityPattern(c)]), [REMOTE, REMOTE_RE]],
    relocationRules: relocation.map((c) => [c, cityPattern(c)]),
  });
}
// Old names, kept as live bindings for any importer; the functions below are the API.
export let TARGET_CITIES = [REMOTE];
export let RELOCATION_CITIES = [];
let built = { facts: null, config: null };
export function cityConfig() {
  const facts = currentFacts();
  if (built.facts !== facts) {
    built = { facts, config: cityConfigFrom(facts) };
    TARGET_CITIES = built.config.targets;
    RELOCATION_CITIES = built.config.relocation;
  }
  return built.config;
}
cityConfig();

// 杭州, 上海 — the cities with a bucket of their own, in the user's order.
export const rankedCities = () => cityConfig().ranked;
// The first of them (the city everything breaks ties toward), or null.
export const primaryCity = () => cityConfig().ranked[0] ?? null;
// 杭州, 上海, 远程 — where the user wants a submission.
export const targetCities = () => cityConfig().targets;
// 杭州, 上海, 远程, 其他 — every bucket, in order.
export const cityBuckets = () => cityConfig().buckets;
// 苏州, 南京, 合肥.
export const relocationCities = () => cityConfig().relocation;
// 1-based rank of a bucket among the targets (杭州 1, 上海 2, 远程 3); 0 when it has none.
export const bucketRank = (city) => cityConfig().targets.indexOf(city) + 1;
// 0 for the first ranked city, 1 for the second …; -1 for 远程, 其他 and anything else.
export const rankedIndex = (city) => cityConfig().ranked.indexOf(city);
// Every city the user named: ranked, then relocation.
export const configuredCities = () => [...cityConfig().ranked, ...cityConfig().relocation];
// The ranked city whose name (Chinese, or English as a whole word) appears in the
// text first by rank, or null — `筛选 杭州`, "多推杭州的".
export const namedRankedCity = (text) => cityConfig().rankedRules.find(([, re]) => re.test(String(text ?? '')))?.[0] ?? null;

export function leadCity(l = {}) {
  const where = [l.location, l.work_mode].filter(Boolean).join(' ');
  for (const [name, re] of cityConfig().rules) if (re.test(where)) return name;
  return OTHER;
}
export function relocationCity(l = {}) {
  const where = [l.location, l.work_mode].filter(Boolean).join(' ');
  for (const [name, re] of cityConfig().relocationRules) if (re.test(where)) return name;
  return null;
}
// Cities the user actually wants a submission in. Everything else is a real
// decision (relocation, commute, family), never something to auto-submit.
export const acceptableCity = (l = {}) => targetCities().includes(leadCity(l)) || !!relocationCity(l);
