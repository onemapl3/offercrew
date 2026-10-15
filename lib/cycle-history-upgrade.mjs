// 旧周期按本轮留存证据重算来源收成。启动时运行，不在 GET 里修数据，也不再执行任何来源。
import fs from 'node:fs';
import { file, read, write } from './store.mjs';
import * as J from './jobs.mjs';
import { readCards, saveCards } from './cards.mjs';
import { discoveryOutcome, DISCOVERY_STAGES } from './discovery-outcome.mjs';
import { browserReceiptWhy } from './browser-source-receipt.mjs';
import { stageOutcome } from './tasks.mjs';
import { lastJson } from './watcher-mail.mjs';
import { tailOf } from './ops.mjs';
import { dayOf } from './tz.mjs';

const MIGRATION = 'radar-cycle-outcome-v1';
const BAD = new Set(['error', 'failed', 'degraded', 'blocked', 'needs_host_connector']);
const kinds = ['cycle', 'round-scout', 'round-radar', 'round-first', 'cycle-full', 'cycle-light'];
const stamp = t => Date.parse(t || '') || 0;
const doneBefore = (j, key) => J.events(j.id).some(e => e.event === 'correct_history' && e.data?.migration === key);
const manual = c => c && (c.manual || c.manual_status || c.status === 'cancelled');

function receiptAt(ref) {
  if (!/^runs\/\d{8}\/(?:ops\/[a-z0-9-]+\.log|cycle-\d+\.json)$/.test(ref || '')) return null;
  try {
    const data = lastJson(tailOf(file(ref), 4 * 1024 * 1024));
    return Array.isArray(data?.results) ? { ref, data } : null;
  } catch (e) { if (e.code !== 'ENOENT') console.warn(`[cycle upgrade] 无法读取 ${ref}: ${e.message}`); return null; }
}

function evidenceOf(job, card, children) {
  // 卡和账上精确关联的操作 ID 优先；不依赖只保留最近 20 笔的 ops.json。
  const op = card?.links?.op_id || /^op:([^#]+)$/.exec(job.ref || '')?.[1] || /^cycle:ops-(.+)$/.exec(job.ref || '')?.[1]
    || children.map(j => /^cycle:ops-(.+):[^:]+:j_[a-z0-9]+$/.exec(j.ref || '')?.[1]).find(Boolean);
  const start = stamp(job.started_at || job.created_at), end = stamp(job.finished_at);
  if (op && /^[a-z0-9-]+-\d{13}$/.test(op)) {
    const ref = `runs/${dayOf(Number(op.match(/\d{13}$/)[0])).replaceAll('-', '')}/ops/${op}.log`;
    return receiptAt(ref); // 精确日志缺失，不把附近其它周期当成它。
  }
  if (!start || !end) return null;
  // 定时周期没有卡或操作日志。cycle-<结束毫秒>.json 的 elapsed_ms 必须同时吻合起止时间，且唯一。
  const matches = [];
  for (const day of new Set([dayOf(start), dayOf(end)])) {
    const dir = `runs/${day.replaceAll('-', '')}`;
    let names;
    try { names = fs.readdirSync(file(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; continue; }
    for (const name of names) {
      const m = /^cycle-(\d+)\.json$/.exec(name);
      if (!m || Math.abs(Number(m[1]) - end) > 2000) continue;
      const r = receiptAt(`${dir}/${name}`), elapsed = r?.data?.elapsed_ms;
      if (Number.isFinite(elapsed) && elapsed >= 0 && Math.abs(Number(m[1]) - elapsed - start) <= 2000) matches.push(r);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function upgradeCycleHistory({ now = Date.now() } = {}) {
  const cards = new Map(readCards().map(c => [c.id, c]));
  let upgraded = 0, missing = 0;
  for (const job of J.list({ kind: kinds, state: ['failed', 'done'], limit: 5000 })) {
    const backup = `state/upgrades/${MIGRATION}/${job.id}.json`;
    const previous = read(backup, null), done = doneBefore(job, MIGRATION);
    if (read(`${backup}.done`, null) || job.state === 'done' && !done) continue;
    // 迁移中断以后用户可能已重试或改过这件活；旧备份不再代表现在这一轮，不能盖回去。
    if (previous && ['attempt', 'started_at', 'finished_at', 'updated_at', 'ref'].some(k => previous.job[k] !== job[k])) continue;
    const card = cards.get(/^card:([^#]+)$/.exec(job.ref || '')?.[1]);
    if (manual(card)) continue;
    const children = J.list({ parent: job.id, limit: 5000 });
    const evidence = previous ? { ref: previous.evidence, data: { results: previous.results } } : evidenceOf(job, card, children);
    if (!evidence) { missing++; continue; }
    const results = evidence.data.results.map(r => r.stage !== 'discover-human-browser' ? r : { ...r, sources: (r.sources || []).map(s => s.error || BAD.has(s.status) ? { ...s, say: browserReceiptWhy(s, s.source) } : s) });
    const scan = discoveryOutcome(results);
    if (!scan.counts.failed) continue; // 没有来源失败的证据，不凭一次退出错误翻成成功。
    const other = results.filter(r => !DISCOVERY_STAGES.has(r.stage) && BAD.has(r.status));
    const unknown = children.filter(j => j.state === 'failed' && !results.some(r => r.stage === j.kind));
    const partial = scan.status === 'partial' && !other.length && !unknown.length;
    const summary = [partial ? scan.text : scan.text.replace(/^部分完成：/, ''), ...other.map(r => `${stageOutcome(r).label}：${stageOutcome(r).reason || '没有完成'}`), ...unknown.map(j => `${j.title || j.kind}：${j.reason || '原因没有记下来'}`)].join('；');
    const outcome = { state: partial ? 'done' : 'failed', result: { summary, counts: { ...scan.counts, ...(partial ? { partial: true } : {}) }, links: [{ label: '这一轮原始回执', href: evidence.ref }] }, reason: partial ? null : summary };
    if (!previous) write(backup, { job, card: card || null, children, evidence: evidence.ref, results: evidence.data.results });
    const fixed = done ? job : J.correctHistoricalResult(job, { ...outcome, migration: MIGRATION, evidence: backup, now });
    if (!fixed) continue;
    // 卡只是账的投影；更新同一卡的旧文案，保留时间，不制造“刚刚运行”的步骤。
    if (card && card.history_upgrade?.migration !== MIGRATION) saveCards([{ ...card, status: partial ? 'done' : 'stuck', result: summary, detail: partial ? '' : summary, history_upgrade: { migration: MIGRATION, evidence: backup } }]);
    for (const child of children) {
      if (!DISCOVERY_STAGES.has(child.kind) || !['failed', 'done'].includes(child.state)) continue;
      const childDone = doneBefore(child, MIGRATION);
      if (child.state === 'done' && !childDone) continue;
      const row = results.find(r => r.stage === child.kind);
      const childCard = cards.get(/^card:([^#]+)$/.exec(child.ref || '')?.[1]);
      if (!row || manual(childCard)) continue;
      const o = stageOutcome(row);
      const corrected = childDone ? child : J.correctHistoricalResult(child, { state: o.state, result: o.state === 'done' ? { summary: o.summary, counts: o.counts } : null, reason: o.reason, migration: MIGRATION, evidence: backup, now });
      if (corrected && childCard && childCard.history_upgrade?.migration !== MIGRATION) saveCards([{ ...childCard, status: o.state === 'done' ? 'done' : 'stuck', result: o.summary || null, detail: o.reason || '', history_upgrade: { migration: MIGRATION, evidence: backup } }]);
    }
    write(`${backup}.done`, { at: new Date(now).toISOString() });
    upgraded++;
  }
  return { upgraded, missing };
}
