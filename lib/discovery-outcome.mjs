// 找岗的收成按来源记，不用某一个子进程的退出结果抹掉其它来源已读到的东西。
import { browserSourceName } from './human-browser.mjs';
import { errorReason } from './say-error.mjs';
import { sourceState } from './discovery-source.mjs';
import { browserReceiptWhy } from './browser-source-receipt.mjs';

export const DISCOVERY_STAGES = new Set(['discover', 'discover-human', 'discover-human-browser']);
const BAD = new Set(['error', 'failed', 'degraded', 'blocked', 'partial', 'failing', 'broken']);
export function discoveryOutcome(results = []) {
  let read = 0, added = 0, partlyRead = 0;
  const failures = [], stages = [];
  for (const r of results.filter(r => DISCOVERY_STAGES.has(r.stage))) {
    const before = read;
    added += Number(r.added) || 0;
    const sources = r.sources || [];
    for (const s of sources) {
      if (['paused', 'done_today'].includes(s.status) || s.status === 'skipped' && !/no_session|session_expired/.test(s.reason || '')) continue;
      if (r.stage === 'discover') {
        const state = sourceState(s);
        if (['ok', 'unconfirmed', 'quiet'].includes(state.state)) read++;
        else if (['held', 'failing', 'broken'].includes(state.state) || s.error) failures.push(`${s.company || '官方招聘来源'}：${state.text}`);
        continue;
      }
      // 官网即使没有符合城市的岗位也已经读通；浏览器读过一页但被挡住不算读通这个来源。
      if (!s.error && !BAD.has(s.status) && (s.count != null || s.posts != null || s.status === 'checked')) read++;
      const raw = s.error || s.reason;
      if (s.error || BAD.has(s.status) || s.status === 'skipped') {
        if (Number(s.posts) > 0 || Number(s.detail_filled) > 0) partlyRead++;
        const name = browserSourceName(s.source || s.company || '招聘来源');
        const why = r.stage === 'discover-human-browser' ? browserReceiptWhy(s, s.source) : s.say || `${name}：${s.note || errorReason(raw || '原因没有记下来')}`;
        failures.push(why);
      }
    }
    if (!sources.length && BAD.has(r.status)) failures.push((r.errors || [r.error]).filter(Boolean).map(errorReason).join('；') || '找岗这一步中途停了，原因没有记下来');
    stages.push({ stage: r.stage, read: read - before, added: Number(r.added) || 0 });
  }
  const failed = [...new Set(failures)], status = failed.length ? read > 0 || added > 0 || partlyRead > 0 ? 'partial' : 'failed' : 'done';
  const labels = { discover: '官方招聘', 'discover-human': '真人帖接口', 'discover-human-browser': '浏览器' };
  const breakdown = stages.map(s => `${labels[s.stage]}读通 ${s.read} 个，新收 ${s.added} 条`).join('；');
  const text = `${status === 'partial' ? '部分完成：' : status === 'failed' ? '没完成：' : ''}读通 ${read} 个来源，新收 ${added} 条${stages.length > 1 ? `（${breakdown}）` : ''}${failed.length ? `；${failed.join('；')}` : ''}`;
  return { status, text, counts: { read, added, failed: failed.length }, failures: failed, stages };
}
