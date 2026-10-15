// 展示编号属于放行/用户操作，不属于存储或字段迁移。已有编号绝不因隐藏而自动改动。
import { shelved } from './shelf.mjs';
import { heldRec } from './recommend-gate.mjs';
import { decidedLead } from './lead-state.mjs';
export const hiddenForNumber = (l = {}, facts) => !!(l.superseded || l.legacy || shelved(l) || heldRec(l, facts));
export function numberVisibleLead(l, rows, { at = new Date().toISOString(), facts, requested = false } = {}) {
  if (!l || Number(l.number) > 0 || l.superseded || l.legacy) return false;
  // 用户明确交代找来的岗位也是可追踪结果。编号不代表推荐、批准或投递。
  if (!requested && (hiddenForNumber(l, facts) || (!l.match && !decidedLead(l) && !l.auto_apply?.approved_at))) return false;
  l.number = Math.max(0, ...rows.map(x => Number(x.number) || 0)) + 1;
  l.numbered_at = at;
  return true;
}
