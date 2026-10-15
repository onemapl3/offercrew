// 一个口径（rebuild7/one-source，10-10）：页面、手机、对话上报的数只在这里算一次，大家读同一份。
// 算的地方是 lib/hq.mjs hqView（指挥台那张表和收件箱那张单子都在那里），这里只把它们数成一份「账」（tallyOf），
// 再给对话、成员页说成人话（tallyLines）。页面不自己数：拿 /api/hq 的 tally、/api/inbox 的 total。
//
//   等你      收件箱里等你的那几件（lib/hq.mjs deskInbox：挡路的、要你拍板的、等你批准的草稿和投递、要不要跟进）。
//             侧栏角标、收件箱「全部」、指挥台「你」、手机「等你」都是这个数；按成员分（memberOf），各位加起来等于总数。
//   新线索    指挥台「新线索」标签里的行（等你筛的推荐 + 刚找到还没判的）；
//   待核      指挥台「待核」标签里的行（等你筛、判成待核的）；
//   推荐      这两个标签里 Judge 判成推荐的行（就是你现在能拍板的推荐）；
//   结论      全部岗位按 Judge 的结论分（推荐 / 待核 / 排除 / 预筛掉 / 还没判断），「全部」标签里按它筛。
//   标签      指挥台每个标签几行（lib/hq.mjs TABS），表上的数就是它。
import { VERDICT_KEYS, verdictWord } from './vocab.mjs';

export function tallyOf({ desk = { asks: [], tabs: [] }, asks = {}, waiting = {}, tabs = {}, rows = [], library = [], shelved = [] } = {}) {
  const verdicts = Object.fromEntries(VERDICT_KEYS.map(k => [k, 0]));
  for (const r of [...rows, ...library]) if (Object.hasOwn(verdicts, r.vkey)) verdicts[r.vkey]++;
  const fresh = rows.filter(r => r.tab === 'new' || r.tab === 'verify');
  return {
    waiting: {
      total: desk.asks.length,
      by_member: Object.fromEntries(Object.entries(waiting).map(([k, w]) => [k, w.count])),
      by_tab: (desk.tabs || []).map(t => ({ key: t.key, label: t.label, count: t.count })),
    },
    leads: {
      new: tabs.new || 0, verify: tabs.verify || 0, recommend: fresh.filter(r => r.verdict === 'recommend').length,
      tabs, verdicts, total: rows.length + library.length, moving: rows.filter(r => !r.ending).length,
      // 收起来的（lib/shelf.mjs）：不算在上面任何一个数里，单报一句。
      shelved: { not_job: shelved.filter(r => r.shelf === 'not_job').length, off: shelved.filter(r => r.shelf === 'off').length },
    },
  };
}

const shelfLine = (s = {}) => (s.not_job || s.off) ? `；另外收起了 ${[s.not_job ? `不是岗位 ${s.not_job}` : '', s.off ? `不对口 ${s.off}` : ''].filter(Boolean).join('、')} 条，不算在内` : '';
// 说成几句人话（对话里「现在怎么样」、给模型的上下文）：数照抄这份账，不让模型自己数。
export function tallyLines(t) {
  if (!t) return [];
  const L = t.leads || {}, W = t.waiting || {}, v = L.verdicts || {};
  return [
    `等你处理 ${W.total ?? 0} 件（收件箱）${(W.by_tab || []).length ? `：${W.by_tab.map(x => `${x.label} ${x.count}`).join('、')}` : ''}`,
    `指挥台：新线索 ${L.new ?? 0}（其中推荐 ${L.recommend ?? 0}）、待核 ${L.verify ?? 0}、待批准 ${L.tabs?.approve ?? 0}、进行中 ${L.tabs?.moving ?? 0}、等回复 ${L.tabs?.waiting ?? 0}、面试/Offer ${L.tabs?.interview ?? 0}`,
    `全部岗位 ${L.total ?? 0} 条：${VERDICT_KEYS.filter(k => v[k]).map(k => `${verdictWord(k)} ${v[k]}`).join('、') || '还没有'}${shelfLine(L.shelved)}`,
  ];
}
