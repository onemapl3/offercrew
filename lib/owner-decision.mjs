// 待核是已判断后的不确定性。主人主动选推进时，保留他看到的待核点；这不是发送或提交授权。
import { currentFacts } from './facts.mjs';
import { gateMatch, judgementStopped } from './recommend-gate.mjs';
import { decisionPoints } from './first-round.mjs';
import { hash } from './store.mjs';
import { errorReason } from './say-error.mjs';
import { redact } from './error-evidence.mjs';
export function pendingReview(l, facts = currentFacts()) {
  if (judgementStopped(l)) {
    const points = [`判断未完成：${errorReason(redact(l.match_error_final))}`];
    return { verdict: null, version: null, judgement_stopped: true, points,
      fingerprint: hash(['judge-stopped', l.id, l.role, l.jd_text, l.match_error_final, l.match_error_final_at, l.match_attempts, points]) };
  }
  const match = gateMatch(l?.match, { facts });
  if (match?.verdict !== 'verify') return null;
  const points = decisionPoints({ ...l, match }, facts).map(p => p.text);
  const version = l.judgement?.version || match.version || null;
  return { verdict: 'verify', version, points, fingerprint: hash([version, match, points]) };
}
export function ownerDecision(l, { at, source, messageId = null }, facts = currentFacts()) {
  const review = pendingReview(l, facts);
  return review ? { ...review, at, source, message_id: messageId, note: review.judgement_stopped ? '判断未完成，负责人看过原因后决定推进' : '负责人看过待核点，自己定的' } : null;
}
