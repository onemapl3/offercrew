import { controlled } from './task-control.mjs';
// 任务卡和账的旧数据升级（第 2 步 2X，实测-1004 F 节第 5 条）：工作台启动时跑一次（lib/apply-retry.mjs settleLegacyApplyCards 末尾），
// 可以重复跑，跑过的不会再改。只改卡（state/tasks.ndjson 只追加，旧版本留在文件里）和卡的那件活（jobs，事件流里看得到），不删任何东西。
//
//   1. 投递停在提交前、账上那件却记成做完（0.1.6 以前的预填动作做完就是 done，「等你」是读的时候从线索推的）：那件活另起一轮，记 waiting_you，
//      挂终审 / 预填好了那封信（和 lib/workers.mjs settleApply 现在记的一样）。你答了由 lib/leads.mjs settleApplyWait 落定。
//   2. 旧的发送卡（批准前账上没有它的活，状态从回执、发送请求推）：回执里建卡以后发出过的记做完，别的记「等你批准」（批准了动作那件挂上来）。
//   3. 同一岗位开着两张以上的投递卡：留一张（挂着动作的、最新的），别的并进去（merged_into），开着的那件活取消。
//   4. 例行卡：同一位成员同一步，后面的一轮已经有卡了，前面那张没跑成的不再开着（后来又跑过了）。
//   5. 别的重复卡（同一种活、同一个标题、同一个对象，一起开着或者前后 10 分钟内建的，bin/health-check.mjs 的同一条规则）：留最新的一张，别的并进去。
// → { reopened, sends, merged, routines }。
import * as J from './jobs.mjs';
import { lines } from './store.mjs';
import { readCards, saveCards, addStep } from './cards.mjs';
import { jobOfCard, driven } from './task-ledger.mjs';
import { leadKey } from './journey.mjs';
import { applyWaitOf } from './workers.mjs';
import { delivered } from './delivery.mjs';

const T = x => Date.parse(x || '') || 0;
const iso = t => new Date(t).toISOString();
const OPEN_JOB = new Set(['queued', 'running', 'waiting_you', 'failed']);
const WAITING = new Set(['prepared_for_user', 'awaiting_final_review']);
const ridOf = c => c?.leads?.[0]?.rid || c?.leads?.[0]?.record_id || null;

// 那件活收掉：开着的取消；做完了的另起一轮再取消（转移表里 done 走不到 cancelled，旧的那件留作历史）。
function cancelJob(c, reason, now) {
  const j = jobOfCard(c);
  if (!j || j.state === 'cancelled') return;
  const live = OPEN_JOB.has(j.state) ? j : J.again(j.id, { now });
  if (live) J.drive(live.id, 'cancelled', { reason, now });
}

export function upgradeCards({ now = Date.now() } = {}) {
  const out = { reopened: 0, sends: 0, merged: 0, routines: 0 };
  const save = new Map(), put = c => save.set(c.id, c);
  let cards = readCards().filter(c => !controlled(c));
  const leads = lines('state/leads.ndjson').filter(l => !l.superseded), byRid = new Map(leads.map(l => [leadKey(l), l]));

  // 1. 停在提交前、账上记成做完的投递卡。
  for (const c of cards) {
    if (c.kind !== 'apply' || c.legacy || c.merged_into || c.status === 'cancelled') continue;
    const j = jobOfCard(c), l = byRid.get(ridOf(c));
    if (!j || j.state !== 'done' || !l || !WAITING.has(l.auto_apply?.status) || l.state === 'applied') continue;
    const w = applyWaitOf(l), again = J.again(j.id, { now });
    if (!again) continue;
    J.drive(again.id, 'waiting_you', { reason: w.reason, what: w.what, now });
    const x = { ...c, links: { ...c.links, ask_id: w.what.ask_id }, status: 'needs_you', detail: w.reason, result: null, done_at: null };
    if (w.what.ask_id.startsWith('final:')) x.wait = 'final';
    addStep(x, w.reason, { who: c.owner, at: now });
    put(x); out.reopened++;
  }

  // 2. 旧的发送卡：批准前账上没有它的活、或者那件活没挂动作，状态以前从回执推。
  let receipts = null;
  for (const c of cards) {
    if (c.kind !== 'send' || !c.links?.send_at || c.legacy || c.merged_into || ['done', 'cancelled', 'needs_you'].includes(c.status)) continue;
    const j = jobOfCard(c);
    if (j && driven(c, j)) continue;
    const rid = ridOf(c), l = byRid.get(rid) || {};
    receipts ??= lines('state/outbound.ndjson');
    const sent = receipts.filter(o => (!rid || o.record_id === rid) && T(o.sent_at || o.at) >= T(c.created_at) - 1000 && !/^(ats_form|portal)/.test(o.channel || '') && delivered(o, l)).at(-1);
    const n = l.number != null ? `#${l.number} ` : '';
    const x = { ...c, links: { ...c.links } };
    if (sent) Object.assign(x, { status: 'done', result: `${n}发出了`, detail: '', done_at: sent.sent_at || sent.at || iso(now) });
    else Object.assign(x, { status: 'needs_you', detail: '草稿等你批准', result: null });
    addStep(x, sent ? `${n}发出了` : '草稿等你批准，批准后按原样发出', { who: c.owner, at: now });
    put(x); out.sends++;
  }
  if (save.size) { saveCards([...save.values()]); save.clear(); cards = readCards().filter(c => !controlled(c)); }

  // 3. 同一岗位开着的投递卡并成一张。
  const applyBy = new Map();
  for (const c of cards) if (c.kind === 'apply' && !c.legacy && !c.merged_into && c.status !== 'cancelled' && ridOf(c)) applyBy.set(ridOf(c), [...(applyBy.get(ridOf(c)) || []), c]);
  for (const list of applyBy.values()) {
    if (list.length < 2) continue;
    const acted = c => J.actionsOf(jobOfCard(c)?.id).length ? 1 : 0;
    const keep = [...list].sort((a, b) => acted(b) - acted(a) || T(b.created_at) - T(a.created_at))[0];
    for (const c of list) if (c !== keep) merge(c, keep);
  }

  // 4. 例行卡：后面一轮已经有卡了，前面那张没跑成的收掉。
  const routineBy = new Map();
  for (const c of cards) if (c.routine && !c.merged_into && c.links?.stage) routineBy.set(`${c.links.stage}|${c.owner}`, [...(routineBy.get(`${c.links.stage}|${c.owner}`) || []), c]);
  for (const list of routineBy.values()) {
    const sorted = [...list].sort((a, b) => T(a.created_at) - T(b.created_at));
    for (const c of sorted.slice(0, -1)) if (!['done', 'cancelled'].includes(c.status) && !save.has(c.id)) {
      const x = { ...c, status: 'cancelled', result: c.detail || c.result || null, detail: '' };
      addStep(x, '后来又跑过了，这一轮的不再算', { who: c.owner, at: now });
      cancelJob(x, '后来又跑过了', now); put(x); out.routines++;
    }
  }

  // 5. 别的重复卡（bin/health-check.mjs 同一条规则）：留最新的一张。
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const groups = new Map();
  for (const c0 of cards) {
    const c = save.get(c0.id) || c0;
    if (c.legacy || c.merged_into || c.status === 'cancelled' || c.kind === 'goal') continue;
    const l = c.leads?.[0], target = l?.rid || (l?.number != null ? `#${l.number}` : '') || c.url || '';
    const k = `${c.kind}|${norm(c.title)}|${target}`;
    groups.set(k, [...(groups.get(k) || []), c]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const open = list.filter(c => !['done', 'cancelled'].includes(c.status));
    const times = list.map(c => T(c.created_at)).sort((a, b) => a - b);
    if (!(open.length >= 2 || times.some((t, i) => i && t - times[i - 1] <= 10 * 60000))) continue;
    const keep = [...list].sort((a, b) => T(b.created_at) - T(a.created_at))[0];
    for (const c of list) if (c !== keep) merge(c, keep);
  }

  // 并进去：这张不再单独出现（列表、体检都跳过 merged_into），开着的那件活取消；做完的那件照旧留着。
  function merge(c, keep) {
    const x = { ...(save.get(c.id) || c), merged_into: keep.id };
    if (!['done', 'cancelled'].includes(x.status)) { Object.assign(x, { status: 'cancelled', detail: '' }); cancelJob(x, '和另一张卡是同一件事，并过去了', now); }
    addStep(x, '和另一张卡是同一件事，并过去了', { who: x.owner, at: now });
    put(x); out.merged++;
  }

  if (save.size) saveCards([...save.values()]);
  return out;
}
