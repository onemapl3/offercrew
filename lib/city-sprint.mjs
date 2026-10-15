// 城市筛选保留旧 API 名，但当前规则只来自求职设置（candidate/facts.yaml）。
// 2026-09-21 的 pipeline.city_sprint 是历史，不能再盖住后来改过的城市 / 远程偏好。
// 已联系、回复和面试中的线程仍由调用方保留；这里只判断新的推进范围。
import { currentFacts } from './facts.mjs';
import { leadCity, relocationCity, cityNames, cityPattern } from './city.mjs';

// `RADAR_CITY_SPRINT=off` lets a maintenance run see the whole pool; the test
// runner (NODE_TEST_CONTEXT) ignores the live switch unless a test sets `on`,
// because tests/matcher.test.mjs reads the real config and feeds it Shanghai.
//
// `sprintAllows` asks this once per lead (thousands per list rebuild), so the
// facts 缓存按文件版本更新，派生规则也只按事实对象构建一次。
function fromConfig(conf) {
  const s = conf?.city_sprint;
  if (!s || s.enabled === false) return null;
  const only = (Array.isArray(s.only) ? s.only : [s.only]).filter(Boolean);
  return only.length ? Object.freeze({ ...s, only: Object.freeze(only) }) : null;
}
// 当前设置只有 candidate/facts.yaml 这一份。旧 city_sprint 留作历史，不能覆盖后来选的城市 / 工作方式。
function fromPreferences(facts) {
  const loc = facts?.location || {}, cities = cityNames(loc.target_cities).filter(c => !['远程', '其他'].includes(c));
  const configuredModes = Array.isArray(loc.work_mode_preference) ? loc.work_mode_preference : [];
  if (!cities.length && !configuredModes.length) return null;
  const modes = configuredModes.length ? configuredModes : ['remote_china', 'hybrid', 'onsite'];
  const local = modes.includes('hybrid') || modes.includes('onsite');
  return Object.freeze({ enabled: true, source: 'preferences', cities: Object.freeze(cities), work_modes: Object.freeze([...modes]), only: Object.freeze([...(local ? cities : []), ...(modes.includes('remote_china') ? ['远程'] : [])]) });
}
let live = { facts: null, rule: null };
export function cityPreferenceRule(facts) {
  if (facts !== undefined) return fromPreferences(facts);
  const current = currentFacts();
  if (live.facts !== current) live = { facts: current, rule: fromPreferences(current) };
  return live.rule;
}
export function citySprint(conf) {
  const env = process.env.RADAR_CITY_SPRINT;
  if (conf === undefined && (env === 'off' || (process.env.NODE_TEST_CONTEXT && env !== 'on'))) return null;
  if (conf !== undefined) return fromConfig(conf); // 离线旧规则的显式解析；当前应用的调用方不传旧 pipeline。
  return cityPreferenceRule();
}
// A posting that names no city — empty, 未标注, 待核（…未写明城市）, or only a
// country — is not held: a forwarded link or a city-less 脉脉 post may well be
// in the sprint city, and the user decides (2026-09-23). A city Jev read from the posting
// (lib/judgements.mjs posting.city) makes it known again.
const NO_CITY = /未标注|未注明|未写明?|未知|不详|待核|待定|待确认|不限|全国|多地|其他|其它|中国|\bchina\b|\bprc\b|\bcn\b|\bn\/?a\b|\bunknown\b|\btbd\b/gi;
export function cityUnknown(l = {}) {
  if (leadCity(l) !== '其他' || relocationCity(l)) return false;
  const judged = l.judgement?.posting?.city;
  if (judged && !['multiple', 'not_stated'].includes(judged)) return false;
  const named = String(l.location || '').replace(/[（(][^）)]*[）)]/g, (m) => (/[待未]|确认|写明/.test(m) ? ' ' : m)).replace(NO_CITY, ' ');
  return !/[\p{L}\p{N}]/u.test(named);
}
// A sprint city may be a target city (leadCity: 杭州/上海/远程) or a relocation
// city such as 苏州 (relocationCity), which leadCity files under 其他.
export function sprintAllows(l = {}, sprint = citySprint()) {
  if (!sprint) return true;
  const where = [l.location, l.work_mode].filter(Boolean).join(' ');
  const hybrid = /混合办公|\bhybrid\b/i.test(where);
  const onsite = /坐班|现场办公|线下办公|\bon[- ]?site\b/i.test(where);
  const remote = !hybrid && (/远程|在家办公|居家办公|\bremote\b|\bworldwide\b|\banywhere\b|\bwork from home\b|\bwfh\b/i.test(where) || l.judgement?.posting?.city === 'remote') && !/不支持远程|非远程|no remote|not[_ ]remote/i.test(where);
  if (sprint.source === 'preferences') {
    if (remote) return sprint.only.includes('远程');
    if (hybrid && !sprint.work_modes.includes('hybrid')) return false;
    if (!hybrid && onsite && !sprint.work_modes.includes('onsite')) return false;
    if (!hybrid && !sprint.work_modes.some(m => m === 'onsite' || m === 'hybrid')) return cityUnknown(l);
    return !sprint.cities.length || cityUnknown(l) || sprint.cities.some(c => cityPattern(c).test(where) || l.judgement?.posting?.city === c);
  }
  return cityUnknown(l) || sprint.only.includes(leadCity(l)) || sprint.only.includes(relocationCity(l)) || (sprint.only.includes('远程') && remote);
}
// 2026-09-21: a sprint no longer excludes anything. Postings elsewhere are still
// discovered, matched and judged; they are only *held* — kept out of the default
// lead list (Radar shows them under Backlog), top picks, the job list and any new
// outreach. 当前 hold 从求职设置实时派生，改城市后不用迁移岗位。
export const sprintHold = (l = {}, sprint = citySprint()) => !sprintAllows(l, sprint);
// Why a posting is on hold, in words for cards and state files.
export const sprintHoldReason = (l = {}, sprint = citySprint()) =>
  sprintAllows(l, sprint) ? null : sprint.source === 'preferences' ? `当前求职偏好为${sprint.only.join(' / ') || '不限城市'}，这份岗位暂不推进` : `${sprint.only.join('/')}冲刺期，${leadCity(l)}岗位在 Backlog（照常匹配，暂停新外发）`;
// Legacy prefilter reason written before 2026-09-21; bin/sprint-rehold.mjs clears it.
export const SPRINT_PREFILTER_REASON = 'outside_sprint_city';
