// 投递冻结（2026-09-22，用户：简历还没更新，先不要真的投）。
// 开关在 config/pipeline.json `apply_freeze`。冻结时：bin/auto-apply.mjs 不提交任何表单，
// 「投 N」不排队而是记进 state/apply-freeze-wishlist.json，工作台顶部挂红标。
// 发现、匹配、筛选决策（要投 / 要联系 / pass）、草稿撰写都照常。
import { read, write } from './store.mjs';
export function applyFreeze(conf = read('config/pipeline.json', {})) {
  const f = conf?.apply_freeze;
  return f && f.enabled !== false ? { ...f, reason: f.reason || '投递已冻结' } : null;
}
// 冻结期间用户点名要投的编号，解冻后拿来排队。
export function rememberApplyWish(numbers = [], { source = 'dashboard', now = new Date() } = {}) {
  const w = read('state/apply-freeze-wishlist.json', { numbers: [], history: [] });
  const add = numbers.map(Number).filter(Number.isInteger);
  w.numbers = [...new Set([...(w.numbers || []), ...add])];
  w.history = [...(w.history || []).slice(-200), { at: now.toISOString(), source, numbers: add }];
  write('state/apply-freeze-wishlist.json', w);
  return w;
}
