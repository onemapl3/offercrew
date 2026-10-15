// 来源结果的说法共用一张表；页面摘要、事件正文和历史证据用同一解释。
export const EVENT_REASON = {
  full_jd_missing: '岗位描述未读到全文，暂时无法判断', invalid_requirement_citation: '判断引用的岗位要求不在原文中，这次判断未采用',
  disabled_by_configuration: '你已停用这个来源，这次跳过', captcha: '网站要求人工验证，已停下', captcha_required: '网站要求人工验证，已停下',
  site_check: '网站要求人工验证，已停下', not_signed_in: '要先登录这个网站', login_required: '要先登录这个网站', session_expired: '网站登录已过期',
  user_control: '你正在操作页面，自动读取已停下', no_change: '没有新结果', done_today: '今天已读取', no_session: '还没有这个网站的登录记录',
};
export function sourceName(s) {
  const t = String(s || '');
  return ({ boss: 'BOSS', maimai: '脉脉', linkedin: 'LinkedIn', github: 'GitHub', v2ex: 'V2EX', official: '公司官网', official_ats: '官方招聘页', lead_errors: '未判成的岗位', xhs: '小红书', sources: '来源', errors: '错误', results: '结果', data: '记录' })[t.toLowerCase()] || (/[\/\\]|\.(?:json|log|mjs|ndjson)$|^[a-z]+(?:_[a-z]+)+$/.test(t) ? '来源' : t);
}

export const EVENT_STATUS = { ok: '完成', checked: '已检查', changed: '有新结果', no_change: '没有新结果', done_today: '今天已读取', detail_filled: '详情已补齐', detail_fetch_failed: '详情没读到', partial: '部分没完成', degraded: '部分没完成', failed: '失败', fail: '失败', blocked: '受阻', paused: '暂停', skipped: '跳过', skip: '跳过', success: '成功' };
export const eventStatus = status => EVENT_STATUS[status] || (/^[a-z][a-z_]*$/.test(String(status || '')) ? '结果未说明' : String(status || ''));
export function eventReason(text, { hideUnknown = false } = {}) {
  const parts = String(text || '').trim().split(/[；;]/).map(part => {
    const s = part.trim(), m = /^([a-z_]+)(?:\s*[:：]\s*(.*))?$/.exec(s);
    if (m && EVENT_REASON[m[1]]) {
      const detail = m[2] && !/^[\w.-]+\.[a-z]{2,}(?::\d+)?$/i.test(m[2]) ? m[2] : '';
      return [EVENT_REASON[m[1]], detail].filter(Boolean).join('；');
    }
    return s.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b|\bcaptcha\b/g, w => EVENT_REASON[w] || (w.endsWith('_full_jd_missing') ? EVENT_REASON.full_jd_missing : hideUnknown ? '具体原因见原始记录' : w));
  }).flatMap(s => s.split('；')).filter(Boolean);
  return [...new Set(parts)].join('；');
}
export const disabledSource = s => s?.reason === 'disabled_by_configuration' && ['paused', 'skip', 'skipped'].includes(s.status);
export function sourceEventStatus(sources, fallback, otherFailure = false) {
  if (otherFailure || !Array.isArray(sources) || !sources.length) return fallback;
  if (sources.every(disabledSource)) return 'skip';
  if (sources.every(s => disabledSource(s) || ['ok', 'checked', 'changed', 'no_change', 'done_today', 'success'].includes(s.status)) && fallback === 'fail') return 'ok';
  return fallback;
}

// 按每条失败的实际原因计数。旧回执的笼统概要也从明细重算，不修改原始证据。
export function leadErrorsNote(errors) {
  if (!Array.isArray(errors) || !errors.length) return '';
  const counts = new Map();
  for (const row of errors) {
    const error = typeof row === 'string' ? row : row?.error || row?.reason || '';
    const reason = /full_jd_missing/.test(error) ? '岗位描述没抓到全文' : /invalid_requirement_citation/.test(error) ? '要求引用核对没过' : eventReason(error, { hideUnknown: true }) || '原因未记录';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return `${errors.length} 条没判成（${[...counts].map(([reason, count]) => `${count} 条${reason}`).join('；')}），记在那几条上，下次再试`;
}
