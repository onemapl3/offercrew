// 摘要名额只控制重点卡片与手机推送，不改变收录、判断或全量岗位的可见性。
import { read } from './store.mjs';
import { companyKey } from './city-quota.mjs';

export const SUMMARY_MAX = 8;
export const summarySettings = (pipeline = read('config/pipeline.json', {}) || {}) => {
  const value = pipeline.recommend?.per_company;
  return { per_company: value === null || value === '' ? null : Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 30 ? Number(value) : 3 };
};
export function summaryPicks(rows, { perCompany = summarySettings().per_company, max = SUMMARY_MAX, lead = x => x } = {}) {
  const counts = new Map();
  return rows.filter(r => {
    const l = lead(r), key = companyKey(l), n = counts.get(key) || 0;
    if (perCompany != null && n >= perCompany) return false;
    counts.set(key, n + 1); return true;
  }).slice(0, max);
}
export const recommendationAsks = asks => (asks || []).filter(a => a.id && a.type === 'triage' && a.verdict === 'recommend' && a.recommendation_ready === true && a.lead?.record_id && Number.isFinite(Date.parse(a.recommendation_at)));
// 批次仍走现有 #wait/<focus>，只含当前推荐信的 ID，不新造岗位状态或外发授权。
const PREFIX = 'recommendations:';
export const recommendationFocus = ids => PREFIX + JSON.stringify([...new Set(ids)].slice(0, SUMMARY_MAX));
export function focusedRecommendations(focus) {
  if (!String(focus || '').startsWith(PREFIX)) return null;
  try {
    const ids = JSON.parse(focus.slice(PREFIX.length));
    return Array.isArray(ids) && ids.length <= SUMMARY_MAX && ids.every(id => typeof id === 'string' && id.length <= 180) ? ids : [];
  } catch { return []; } // 兜底：通知链接中的批次不是有效 JSON 时不选择岗位，仍保留全量收件箱入口。
}
