// 解析规则修好后，先重验已经付费得到的原输出，不让同一条技术错误继续花钱重判。
import fs from 'node:fs';
import { file, hash } from './paths.mjs';
import { currentFacts } from './facts.mjs';
import { write } from './store.mjs';
import { matchInput } from './match-input.mjs';
import { validateMatch, normalizeMatchEvidence, pendingLead } from './matcher.mjs';
import { missingFacts, fillGaps } from './first-round.mjs';
import { gateMatch } from './recommend-gate.mjs';
import { JUDGEMENT_VERSION } from './judgements.mjs';
import { lastUpdatedAt } from './leads.mjs';
import { TZ } from './tz.mjs';

// 新模型输出与恢复输出走同一份完整规则；缓存不提供任何豁免。
export function validatedMatchOutput(raw, lead, { preferencesVersion = null } = {}) {
  const facts = currentFacts(), missing = missingFacts(facts);
  const judged = gateMatch({ ...validateMatch(normalizeMatchEvidence(raw, lead), lead), req_checked: true }, { facts });
  const fill = fillGaps(judged, facts, lead);
  return { ...judged, version: JUDGEMENT_VERSION, judged_by: 'text_model', preferences_version: preferencesVersion,
    ...(missing.length ? { missing_facts: missing } : {}), ...(fill.length ? { fill } : {}) };
}
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
// input 必须是 infer 前生成的那份。先写原输出，再写绑定；任一步失败都不能把新身份配到旧输出。
export function saveMatchOutput(source, raw, input) {
  const bytes = JSON.stringify(raw, null, 2) + '\n';
  const binding = JSON.stringify({ input: input.identity, output_sha256: hash(bytes) }, null, 2) + '\n';
  // 原子替换完整文件，不对旧输入身份或输出做三方字段合并。
  write(source, bytes);
  if (fs.readFileSync(file(source), 'utf8') !== bytes) throw Error('match_output_changed_before_binding');
  write(`${source}.input.json`, binding);
}
export function cachedCitationMatch(lead, { updatedAt = null, preferencesVersion = null, now = Date.now() } = {}) {
  if (lead.match?.verdict || !pendingLead(lead) || lead.prefilter_reason || lead.match_error_final !== 'invalid_requirement_citation'
    || (lead.match_error && lead.match_error !== lead.match_error_final) || !/^[a-zA-Z0-9_-]+$/.test(lead.id || '')) return null;
  const failed = Date.parse(lead.match_error_final_at || '');
  if (!Number.isFinite(failed)) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(failed)).replaceAll('-', '');
  const source = `runs/${day}/matches/${lead.id}.json`, p = file(source);
  try {
    const saved = mtime(p), changed = Date.parse(updatedAt || lastUpdatedAt(lead.record_id || lead.id) || '');
    // 时间只帮助定位同次失败，不能证明 JD/个人资料未变（JD 可独立存储）。
    if (!saved || saved > failed || failed - saved > 5000 || !Number.isFinite(changed) || changed < saved || changed > failed + 5000) return null;
    const bytes = fs.readFileSync(p, 'utf8'), binding = JSON.parse(fs.readFileSync(`${p}.input.json`, 'utf8'));
    const captured = Date.parse(binding.input?.captured_at || '');
    if (binding.input?.version !== 1 || !Number.isFinite(captured) || captured > saved || binding.output_sha256 !== hash(bytes)) return null;
    const current = matchInput(lead, { now: captured });
    if (hash(current.identity) !== hash(binding.input) || (preferencesVersion != null && preferencesVersion !== current.preferencesVersion)) return null;
    const match = validatedMatchOutput(JSON.parse(bytes), lead, { preferencesVersion: current.preferencesVersion });
    return { ...match, recovered_from: { source, sha256: hash(bytes), error: lead.match_error_final, failed_at: lead.match_error_final_at,
      input_sha256: hash(binding.input), input: binding.input, attempts: lead.match_attempts ?? null, validated_at: new Date(now).toISOString() } };
  } catch { return null; } // 兜底：原文件缺失/损坏或同一 validator 仍拒绝，保留原失败，不伪造判断、不加模型调用。
}
