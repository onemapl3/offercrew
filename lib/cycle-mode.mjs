// 定时的这一轮跑完整周期还是轻量周期（bin/scheduled.mjs），合盖睡过的那一档补跑时带不带判断（lib/cycle-catchup.mjs）：同一张表。
// config/pipeline.json discovery_hours：这几个钟点的那一轮是完整周期（发现、判断、匹配……），其余是轻量周期；
// wide_discovery_hours 的那一轮还扫宽源。
//
// 10-02 开箱第 3 轮 D：定时只排在 09:05、13:05、18:05，都是完整档。电脑睡过了其中一档，醒来补的那一轮以前按醒来的钟点定模式
// （10:20 醒来就是轻量），或者由工作台补一轮轻量周期（09-29 负责人：醒来补一轮轻量的）——两条路都不判断，那一档该判的就丢了，
// 还没判的岗位要多等半天。现在补的仍是轻量周期，但错过的是完整档时带上判断和匹配（bin/cycle.mjs --judge）。
export const fullHour = (hour, pipeline = {}) => (pipeline.discovery_hours || [9, 13, 18]).includes(hour);
export const wideHour = (hour, pipeline = {}) => (pipeline.wide_discovery_hours || [9]).includes(hour);
// 'YYYYMMDD-HHMM'（补跑标记 state/cycle-catchup.json 的 slot、App 定时给的 RADAR_SLOT）里的钟点；认不出就是 null。
export const slotHour = slot => { const m = String(slot ?? '').match(/^\d{8}-(\d{2})\d{2}$/); return m ? Number(m[1]) : null; };
export const missedFullSlot = (slot, pipeline = {}) => { const h = slotHour(slot); return h !== null && fullHour(h, pipeline); };

// bin/scheduled.mjs 交给 bin/cycle.mjs 的参数。hour：现在的钟点；slot：这一轮是为哪一档跑的（App 定时给 RADAR_SLOT；launchd 不给）。
//   现在就在完整档的钟点里（准点，或者晚了但没出这个钟点）：--mode full，宽档再加 --wide，和以前一样；
//   晚了、已经出了那个钟点（睡过 09:05，10:20 醒来）：轻量周期加 --judge；
//   其余：轻量周期。
//   10-10：stale（lib/discover-fresh.mjs discoverDue，上一次读通的找岗位早于最近一档完整周期）的轻量周期再加 --discover。
export function scheduledArgs({ hour, slot = null, pipeline = {}, stale = false } = {}) {
  if (fullHour(hour, pipeline)) return ['--mode', 'full', ...(wideHour(hour, pipeline) ? ['--wide'] : [])];
  return ['--mode', 'light', ...(missedFullSlot(slot, pipeline) || stale ? ['--judge'] : []), ...(stale ? ['--discover'] : [])];
}
// 整轮预算按哪一档算（lib/cycle-budget.mjs cycleBudget）：带判断的轻量周期按完整周期的预算，判断和匹配才有时间。
export const budgetMode = (mode, judge = false) => (judge ? 'full' : mode);
