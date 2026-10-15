// 推荐闸的写入那一半（lib/recommend-gate.mjs 是规则，这里落到线索上）。能重复跑：没变的不写。
// 谁叫：判断跑完（bin/match.mjs）、工作台的一分钟循环（bin/serve.mjs inbox-recheck）、改了推荐线 / 每天上限以后（POST /api/settings）。
//   1. 推荐线：还没定的线索按现在的线重算一遍结论（gateMatch），只改 verdict / below_line，不调模型。
//   2. 展示：默认把已判断合格的推荐全部放出（recommended_at）；只有用户设置了每天上限才记 rec_queue 留到第二天。
import { lines, writeLines } from './store.mjs';
import { numberVisibleLead } from './lead-numbering.mjs';
import { event } from './events.mjs';
import { currentFacts } from './facts.mjs';
import { decidedLead, endedLead } from './lead-state.mjs';
import { requirementScore } from './matcher.mjs';
import { gateMatch, gateSettings, planRelease, releaseLine, unapprovedReview } from './recommend-gate.mjs';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function sweepRecommendations({ now = Date.now(), settings = gateSettings(), facts = currentFacts(), log = true } = {}) {
  const rows = lines('state/leads.ndjson');
  let regated = 0, changed = false;
  for (const l of rows) {
    if (!l.match || l.superseded || l.legacy || (decidedLead(l) && !unapprovedReview(l)) || endedLead(l)) continue;
    const m = gateMatch(l.match, { line: settings.min_score, facts });
    if (m !== l.match && (m.verdict !== l.match.verdict || !same(m.below_line, l.match.below_line))) { l.match = m; regated++; changed = true; }
  }
  const p = planRelease(rows, { now, settings, facts }), at = new Date(now).toISOString();
  for (const l of p.release) { l.recommended_at = at; delete l.rec_queue; numberVisibleLead(l, rows, { at, facts }); changed = true; }
  const held = new Set();
  for (const { l, reason } of p.hold) {
    held.add(l);
    if (l.rec_queue?.reason === reason) continue;
    l.rec_queue = { at, reason, score: requirementScore(l.match, facts) };
    changed = true;
  }
  // 已放过、因缺方向暂时收回的：方向补好后恢复原先的放出记录，不占第二份名额。
  for (const l of rows) if (p.direction && l.recommended_at && l.rec_queue?.reason === 'no_direction') { delete l.rec_queue; changed = true; }
  for (const l of rows) if (l.rec_queue && !held.has(l)) { delete l.rec_queue; changed = true; }
  for (const l of rows) if (l.match?.verdict === 'recommend' && numberVisibleLead(l, rows, { at, facts })) changed = true;
  if (changed) writeLines('state/leads.ndjson', rows);
  const newlyHeld = p.hold.filter(h => h.l.rec_queue?.at === at).length;
  if (log && (p.release.length || newlyHeld)) event('lens', 'recommend', 'ok', releaseLine(p), { refs: [] });
  if (log && regated) event('lens', 'recommend', 'ok', `按推荐线（匹配度 ${settings.min_score}）重新核了 ${regated} 条的结论`, { refs: [] });
  return { regated, released: p.release.map(l => l.number ?? null), held: p.hold.length, direction: p.direction };
}
