import { eventReason, eventStatus, sourceName, disabledSource, leadErrorsNote } from '../lib/event-reasons.mjs';
// 原始记录留作展开项；默认先说结果和失败来源，避免让用户读 JSON 找结论。
const secret = /^(?:.*[_-])?(?:token|password|secret|api[_-]?key|authorization|cookie)$/i;
export function evidenceSafe(value) {
  if (Array.isArray(value)) return value.map(evidenceSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secret.test(k) ? '（已隐藏）' : evidenceSafe(v)]));
  if (typeof value === 'string') return value.replace(/\b(token|api[_-]?key|password|secret|authorization|cookie)\s*[:=]\s*(?:"[^"]+"|[^\s,;]+)/gi, '$1: （已隐藏）').replace(/Bearer\s+[\w.=-]+/gi, 'Bearer （已隐藏）').replace(/sk-[\w-]{16,}/g, '（已隐藏）');
  return value;
}
export function evidenceSummary(value, { leads = [] } = {}) {
  const v = evidenceSafe(value), lines = [], byId = new Map(leads.flatMap(l => [l.id, l.record_id].filter(Boolean).map(id => [id, l])));
  const visit = (x, name = '', depth = 0, modelReply = false) => {
    if (!x || depth > 5 || lines.length > 30) return;
    if (Array.isArray(x)) { for (const entry of x) visit(entry, name, depth + 1, modelReply); return; }
    if (typeof x !== 'object') return;
    const lead = byId.get(x.record_id || x.lead_id || x.id), number = x.number ?? lead?.number, company = x.company || lead?.company;
    const failedLead = name === 'lead_errors';
    const source = failedLead ? ['未判成的岗位', number != null ? `#${number}` : '', company].filter(Boolean).join(' · ') : sourceName(x.source) || x.company || sourceName(x.name || name);
    const reason = [x.error, x.reason, x.message].filter(s => typeof s === 'string' && s.trim()).map(s => eventReason(s, { hideUnknown: true })).join('；');
    const why = eventReason(reason), modelCall = typeof x.model === 'string' && !!(x.driver || x.request_id);
    if (reason || x.status) lines.push([modelCall ? '调用状态' : source || '本轮结果', [failedLead ? '未判成' : disabledSource(x) ? '跳过' : modelCall && x.status === 'completed' ? '模型已返回' : eventStatus(x.status), why].filter(Boolean).join('：')]);
    if (modelCall) {
      lines.push(['请求模型', x.model], ['响应型号', typeof x.reported_model === 'string' && x.reported_model || '这份记录没有保存响应型号']);
      if (Number.isFinite(x.duration_ms)) lines.push(['耗时', `${(x.duration_ms / 1000).toFixed(1)} 秒`]);
      if (x.at) lines.push(['记录时间', String(x.at)]);
    }
    const verdict = { recommend: '推荐', verify: '待核实', exclude: '不推荐' }[x.verdict];
    if (verdict) lines.push([modelReply ? '回复中的建议' : '记录中的判断', verdict]);
    if (Array.isArray(x.reasons) && x.reasons.some(v => typeof v === 'string')) lines.push(['依据', x.reasons.filter(v => typeof v === 'string').map(v => eventReason(v)).join('；')]);
    if (typeof x.biggest_gap === 'string' && x.biggest_gap.trim()) lines.push(['主要缺口', x.biggest_gap]);
    if (Array.isArray(x.must_haves)) lines.push(['要求引用', `${x.must_haves.filter(r => typeof r?.jd_quote === 'string' && r.jd_quote.trim()).length} / ${x.must_haves.length} 条附有原文；是否采用以岗位当前判断为准`]);
    if (typeof x.summary === 'string' && x.summary.trim()) lines.push(['摘要', x.summary]);
    for (const [key, label] of Object.entries({ added: '新增岗位', candidates: '候选岗位', eligible: '合格岗位', posts: '帖子', sent: '已发出', submitted: '已提交', failed: '失败项', calls: '模型请求', judged: '模型已判断', prefiltered: '规则初筛', offline: '规则判断', retained: '沿用已有判断', pending: '待判断', match_failed_final: '判断已停止重试', recommended: '当时推荐', verify: '当时待核实', exclude: '当时不推荐', round_recommend: '本轮推荐', round_verify: '本轮待核实', round_exclude: '本轮不推荐' })) if (typeof x[key] === 'number') lines.push([label, String(x[key])]);
    if (typeof x.review_summary === 'string') lines.push(['本轮进度', eventReason(x.review_summary)]);
    if (Array.isArray(x.lead_errors) && x.lead_errors.length) lines.push(['未判成的部分', leadErrorsNote(x.lead_errors)]);
    else if (typeof x.lead_errors_note === 'string') lines.push(['未判成的部分', eventReason(x.lead_errors_note)]);
    for (const key of ['sources', 'results', 'result', 'data', 'errors', 'lead_errors', 'counts']) {
      const child = x[key];
      if (child && typeof child === 'object') visit(child, key === 'lead_errors' ? key : source || (key === 'result' ? '' : key), depth + 1, modelCall && key === 'result');
    }
  };
  visit(v);
  return [...new Map(lines.map(l => [JSON.stringify(l), l])).values()];
}

// Do not offer links the evidence gate will always reject. Candidate backups
// remain in the audit record; they are not public evidence downloads.
export function visibleEvidenceRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('runs/') || ref.includes('\\') || ref.split('/').some(p => p.startsWith('.') || p.toLowerCase() === 'private')) return false;
  const ext = /\.([^/.]+)$/.exec(ref)?.[1]?.toLowerCase();
  return !ext || ['md', 'json', 'png', 'html', 'jpg', 'jpeg', 'webp', 'pdf', 'txt', 'log'].includes(ext);
}
