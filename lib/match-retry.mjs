import { read } from "./store.mjs";
import { modelErrorKind } from './say-error.mjs';
// Failure bookkeeping for bin/match.mjs.
//
// Two kinds of failure reach a lead. Transport failures (timeouts, dead codex
// process, HTTP transport) say nothing about the lead, so they retry forever
// on a short delay and never count as an attempt. Validation failures
// (invalid_requirement_citation, invalid_match_schema, missing_resume_ref,
// full_jd_missing, ...) mean the model produced output the validator refused.
// Those get a bounded number of attempts and then land in a visible terminal
// state, `match_error_final`, instead of being silently skipped forever.
// ENOENT / EACCES（CLI 没装或不能执行）、claude_code_exit、凭据 / 令牌缺失同样是本机环境的问题，与线索无关。
export const TRANSPORT_ERROR = /timeout|aborted|fetch failed|public_http_transport|public_http_proxy_failed|curl:|codex_exit|claude_code_exit|ENOENT|EACCES|credentials_missing|token_missing/i;
const MODEL_SERVICE_KINDS = new Set(['key', 'quota', 'missing', 'no_model', 'model_access', 'free_login', 'free_access', 'upstream', 'region', 'network']);
const ACCOUNT_FAULT = /credit balance|purchase credits|out of credits|insufficient[_ ](?:quota|credits?|balance|funds)|(?:quota|credits?)[_ ](?:exceeded|exhausted)|billing[_ ]hard[_ ]limit|rate[_ -]?limit|authentication_error|invalid[_ ]?(?:api[_ ]?)?(?:key|token)|incorrect.api.key/i;
export const isTransportError = (message) => {
  const text = String(message || '');
  if (TRANSPORT_ERROR.test(text)) return true;
  // HTTP 400 can mean invalid request/schema or exhausted credit. Only known
  // account/service faults are retryable without spending a lead's attempts;
  // invalid output, refusals and other bad requests keep the bounded policy.
  if (/(?:model_http|openai_api|claude_api)_(?:401|402|403|404|408|409|429|5\d\d)\b/i.test(text)) return true;
  if (/(?:model_http|openai_api|claude_api)_400\b/i.test(text) && !ACCOUNT_FAULT.test(text)) return false;
  return /free_|model_http_|openai_api_|claude_api_|\bstream_(?:failed|cut|ended)\b/i.test(text)
    && MODEL_SERVICE_KINDS.has(modelErrorKind(text).kind);
};
export const TRANSPORT_RETRY_MS = 15 * 60000;
export const VALIDATION_RETRY_MS = 30 * 60000;
export const FAILURE_FIELDS = ["match_error", "match_retry_at", "match_attempts", "match_error_final", "match_error_final_at", "match_service_recovery"];
export const maxMatchAttempts = () => Math.max(1, Number(read("config/pipeline.json", {}).match_max_attempts) || 3);

// A lead may be handed to the model again unless it reached the terminal state
// or its retry time lies in the future. A missing or unparsable retry time
// never blocks: that was the bug that buried validation failures forever.
export function matchEligible(l, now = Date.now()) {
  if (l.match_error_final) return false;
  if (!l.match_error) return true;
  const at = Date.parse(l.match_retry_at || "");
  return !Number.isFinite(at) || at <= now;
}

// Legacy rows written before attempts were counted: give them one recorded
// attempt so the cap still applies, and make them due immediately.
export function backfillFailure(l, now = Date.now()) {
  // Old releases counted service/account faults as rejected output and could
  // stop a lead forever. Reopen only an unambiguous service terminal state,
  // retaining the cause and snapshot. Its attempt count may mix real invalid
  // outputs with service failures, so do not guess how many to subtract.
  if (l.match_error_final && isTransportError(l.match_error_final)
    && (!l.match_error || l.match_error === l.match_error_final)) {
    l.match_service_recovery = { at: new Date(now).toISOString(), error: l.match_error_final,
      previous_final_at: l.match_error_final_at || null, previous_attempts: l.match_attempts ?? null };
    l.match_error = l.match_error_final;
    delete l.match_error_final;
    delete l.match_error_final_at;
    if (l.match_attempts === undefined) l.match_attempts = 0;
    if (!Number.isFinite(Date.parse(l.match_retry_at || ''))) l.match_retry_at = new Date(now).toISOString();
    return true;
  }
  if (!l.match_error || l.match_error_final || l.match_attempts !== undefined) return false;
  l.match_attempts = isTransportError(l.match_error) ? 0 : 1;
  if (!Number.isFinite(Date.parse(l.match_retry_at || ""))) l.match_retry_at = new Date(now).toISOString();
  return true;
}

export function recordMatchFailure(l, message, { now = Date.now(), maxAttempts = maxMatchAttempts() } = {}) {
  l.match_error = message;
  delete l.match_error_final;
  delete l.match_error_final_at;
  if (isTransportError(message)) {
    l.match_retry_at = new Date(now + TRANSPORT_RETRY_MS).toISOString();
    return "retry";
  }
  l.match_attempts = (l.match_attempts || 0) + 1;
  if (l.match_attempts < maxAttempts) {
    l.match_retry_at = new Date(now + VALIDATION_RETRY_MS).toISOString();
    return "retry";
  }
  delete l.match_retry_at;
  l.match_error_final = message;
  l.match_error_final_at = new Date(now).toISOString();
  return "final";
}

export function clearMatchFailure(l) {
  for (const k of ["match_error", "match_retry_at", "match_error_final", "match_error_final_at"]) delete l[k];
}
