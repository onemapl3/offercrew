// 两种判断驱动共用的全局存量复查队列和回执。App 到期检查会启动正常 Judge；不改变用户决定或推荐放行。
import { leadState } from './lead-state.mjs';
import { policyReviewNeeded } from './matcher.mjs';
import { read, write, lines } from './store.mjs';
import { appSchedule, nextSchedule } from './app-schedule.mjs';
import { TZ, localTime, daysLaterAt } from './tz.mjs';
import { errorReason } from './say-error.mjs';
import { JUDGEMENT_VERSION } from './judgements.mjs';

export const REVIEW = 'state/judge-policy-review.json';
const rid = l => l.record_id || l.id;
// 只保存复查判据，不能为了回执把全库懒加载的 JD 都读出来。
export const reviewSnapshot = rows => rows.filter(policyReviewNeeded).map(l => ({ id:l.id, record_id:l.record_id, state:leadState(l), detail_filled_at:l.detail_filled_at, matched_at:l.matched_at, judged_at:l.judged_at, match:{version:l.match?.version}, judgement:{version:l.judgement?.version,at:l.judgement?.at} }));
export function reviewBudgetHold(hold, now = Date.now()) {
  if (!hold) return {};
  if (hold.by === 'free') return { blocked: '模型补给暂时不可用，恢复模型后才继续' };
  if (hold.by === 'invalid') return { blocked: '花费上限配置有误，修正后才继续' };
  return { blocked: '今天花费上限到了，旧判断留到明天', notBefore: daysLaterAt(1, '00:00:00', now) };
}
// remaining 同时是全局复查队列。App 启动/每拍从真实线索补齐；单条判断不能清空别人的条目。
const nextReview = now => nextSchedule(appSchedule().find(j => j.name === 'cycle'), { now, tz: TZ });
// 同一分钟的起点会得到同一个下一档。只在本次更新内复用，避免大队列逐条扫描到明天，
// 也不把跨分钟、未来重试或下一次运行的计划缓存成旧时间。
const reviewTimes = () => {
  const times = new Map();
  return at => { const minute = Math.floor(at / 60000); if (!times.has(minute)) times.set(minute, nextReview(at)); return times.get(minute); };
};
export function syncPolicyReviewQueue(rows = lines('state/leads.ndjson'), { now = Date.now(), paused = false } = {}) {
  const prior = read(REVIEW, {}) || {}, old = new Map((prior.remaining || []).map(e => [e.rid, e]));
  const scheduledAt = reviewTimes();
  const remaining = rows.filter(policyReviewNeeded).map(l => {
    const prev = old.get(rid(l)), stopped = !!l.match_error_final, retry = Date.parse(l.match_retry_at || '') || 0;
    const scheduled = stopped || paused || (Number.isFinite(Date.parse(prev?.next_at)) && Number.isFinite(Date.parse(prev?.not_before)));
    if (scheduled && prev && !!prev.stopped === stopped && !!prev.paused === paused && (!retry || Date.parse(prev.not_before || '') >= retry)) return prev;
    const after = Math.max(now, retry);
    return { rid: rid(l), queued_at: prev?.queued_at || new Date(now).toISOString(),
      reason: stopped ? `核对多次未过，已停止自动重试：${errorReason(l.match_error_final)}` : paused ? 'Judge 已暂停，恢复后才继续' : retry > now ? '等待失败重试时间' : '已加入旧判断重判队列',
      next_at: stopped || paused ? null : scheduledAt(after), stopped, paused, not_before: new Date(after).toISOString() };
  });
  if (JSON.stringify(prior.remaining) !== JSON.stringify(remaining)) {
    const report = { ...prior, synced_at: new Date(now).toISOString(), remaining, summary: `旧判断重判队列剩余 ${remaining.length} 条` };
    write(REVIEW, report); return report;
  }
  return prior;
}
// 到期先预留下一档，避免进程启动失败后每 30 秒反复拉起；成功运行的回执随后写入真实结果。
export function deferPolicyReviewQueue(reason, { now = Date.now(), records = null } = {}) {
  const report = read(REVIEW, {}) || {};
  const chosen = new Set(records || (report.remaining || []).filter(e => !e.stopped && !e.paused && Date.parse(e.next_at) <= now).map(e => e.rid));
  const nextAt = chosen.size ? nextReview(now) : null;
  report.remaining = (report.remaining || []).map(e => chosen.has(e.rid) ? { ...e, reason, next_at: nextAt } : e);
  write(REVIEW, report);
  return [...chosen];
}
export function policyReviewLabel(l) {
  if (l.match_error_final) return '重判已停止';
  const entry = read(REVIEW, null)?.remaining?.find(e => e.rid === rid(l));
  return entry && !entry.stopped ? entry.paused ? '重判等恢复' : '排着重判' : '等待加入重判队列';
}
export function recordPolicyReview({ before, after, selected = [], reasons = new Map(), blocked = null, notBefore = 0, now = Date.now() }) {
  const wanted = before.filter(policyReviewNeeded), current = new Map(after.map(l => [rid(l), l]));
  const picked = new Set(selected.map(rid)), remaining = [], scheduled = reviewTimes();
  const wantedIds = new Set(wanted.map(rid)), existing = new Map((read(REVIEW, {})?.remaining || []).map(e => [e.rid, e]));
  // after 是完整线索集合；before 可能只是 --record / --rejudge-filled 的本次范围。
  for (const l of after.filter(policyReviewNeeded)) {
    const entry = existing.get(rid(l));
    if (!wantedIds.has(rid(l)) && entry && !!entry.stopped === !!l.match_error_final) { remaining.push(entry); continue; }
    const reason = reasons.get(rid(l)) || (l.match_error_final ? `核对多次未过，已停止自动重试：${errorReason(l.match_error_final)}` : l.match_error ? `这条没判成：${errorReason(l.match_error)}` : blocked || (!wantedIds.has(rid(l)) ? '本轮只处理其他记录，这条仍在重判队列' : !picked.has(rid(l)) ? '本轮数量上限到了，旧判断继续排队' : '本轮时间预算已用完，旧判断继续排队'));
    const retryAfter = Math.max(now, notBefore, Date.parse(l.match_retry_at || '') || 0);
    const next_at = l.match_error_final ? null : scheduled(retryAfter);
    remaining.push({ rid: rid(l), reason, next_at, stopped:!!l.match_error_final, not_before: new Date(retryAfter).toISOString() });
  }
  const reviewed = wanted.filter(l => { const c = current.get(rid(l)); return c && !policyReviewNeeded(c) && (c.judgement?.version || c.match?.version) === JUDGEMENT_VERSION; }).length;
  const summary = `旧判断重判 ${reviewed} 条，剩余 ${remaining.length} 条${remaining.length ? `；${[...new Set(remaining.map(r => r.reason))].join('；')}；下一轮计划 ${localTime(remaining.find(r => r.next_at)?.next_at) || '自动重试已停止'}` : ''}`;
  const report = { at: new Date(now).toISOString(), reviewed, remaining, summary };
  write(REVIEW, report);
  return report;
}
export function policyReviewNotice(l) {
  if (!policyReviewNeeded(l)) return null;
  const recorded = read(REVIEW, null)?.remaining?.find(r => r.rid === rid(l));
  const entry = recorded?.stopped && !l.match_error_final ? null : recorded;
  const reason = l.match_error_final ? `核对多次未过，已停止自动重试：${errorReason(l.match_error_final)}` : entry?.reason || '旧判断待复查';
  const next = entry?.next_at;
  const when = l.match_error_final ? '自动重试已停止' : !entry ? '尚未登记到重判队列；App 后台检查会自动登记' : entry.paused ? 'Judge 暂停，恢复后才继续' : !next ? '等待安排下一轮' : Date.parse(next) <= Date.now() ? `计划 ${localTime(next)} 已到，等待空闲后启动 Judge` : `下一轮计划 ${localTime(next)}`;
  return `按新规矩重判：${reason}；${when}（App 后台运行时执行）；下方是旧判断`;
}
