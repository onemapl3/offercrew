import { heldAsk, controlled } from './task-control.mjs';
import { localToolNeed, taskText } from './task-tools.mjs';
// 旧版交给本机 AI 的活（state/host-jobs.ndjson）在新版里的去处（线 H，能力表收口；J 旅程：工作台一起来就报「没人接的活：
// prepare_application_packet / apply」）。新版本机 AI 只接 user_task（你交代的事，user_request）和 system_repair（system_fix），
// 而且要你在设置里打开、能跑（lib/capabilities.mjs whoDoes）。别的旧种类：
//   投递那几种（kind 带 apply / application）：线索上的批准还在、对得上 → 转成引擎的预填动作（lib/action-entry.mjs continuePrefill）；
//   改造前批准、还没填的投递（线索上 approved、账上没有动作）：一样转成预填动作；
//   其余（还有批准对不上的投递）：那条宿主任务记成 dropped，那件活记成已取消，原因「旧版交给本机 AI 的活，新版由引擎做」。
// 不让它们一启动就被看门判成「失败」。能重复跑：处理过的已经不是开着的状态。工作台启动时跑一次（bin/serve.mjs）。
import { lines, writeLines } from './store.mjs';
import * as J from './jobs.mjs';
import { whoDoes } from './capabilities.mjs';
import { continuePrefill } from './action-entry.mjs';
import { noteSwallowed } from './swallow.mjs';

export const RETIRED = '旧版交给本机 AI 的活，新版由引擎做';
const OPEN = new Set(['pending', 'working', 'waiting_user', 'blocked']);
const LOCAL_KIND = { user_request: 'user_task', system_fix: 'system_repair' };
const APPLY = /apply|application/;
const keep = j => LOCAL_KIND[j.kind] && (j.local_tool === true || localToolNeed(j.details || '')) && whoDoes(LOCAL_KIND[j.kind], { local: true }).worker === 'local_ai';

export async function retireLegacyHostJobs({ now = Date.now(), cont = continuePrefill } = {}) {
  const at = new Date(now).toISOString(), retired = [], apply = new Map();
  const rows = lines('state/host-jobs.ndjson'), last = new Map();
  rows.forEach((r, i) => { if (r?.id) last.set(r.id, i); });
  let changed = false;
  for (const i of last.values()) {
    const j = rows[i];
    if (!OPEN.has(j.status) || keep(j)) continue;
    // 本机 AI 关着时的「你交代的事」由引擎接（lib/task-do.mjs migrateHanded）：这里不动。
    if (LOCAL_KIND[j.kind]) continue;
    rows[i] = { ...j, status: 'dropped', previous_status: j.status, dropped_at: at, dropped_by: 'engine', result: RETIRED, updated_at: at };
    changed = true;
    retired.push(j.id);
    if (APPLY.test(j.kind || '') && j.record_id) apply.set(j.id, j.record_id);
  }
  if (changed) writeLines('state/host-jobs.ndjson', rows);
  // 改造前批准、还没填的投递（线索上 approved，账上从没有过预填 / 提交动作）：周期里不再起预填脚本，转成引擎的预填动作。
  //   账上有过的（做完、失败、你取消了、你说不要了）不再转：以前只看开着的，取消过的重启后又会被转出来做一遍。
  //   批准超过 24 小时的转过去也不做，等你在收件箱再确认（lib/actions.mjs holdStale，批准时间照线索上的 approved_at）。
  try {
    const { everFor } = await import('./actions.mjs');
    for (const l of lines('state/leads.ndjson')) {
      const rid = l.record_id || l.id;
      if (l.superseded || l.auto_apply?.status !== 'approved' || !rid) continue;
      if (!everFor(['prefill', 'submit'], `lead:${rid}`)) apply.set(`lead:${rid}`, rid);
    }
  } catch (e) { noteSwallowed('legacy-hands.approved-leads', e, { member: 'quill', doing: '找改造前批准、还没填的投递', then: '这一次不转，下次启动再看' }); }
  let moved = 0;
  if (apply.size) { try { moved = (await cont([...new Set(apply.values())], { origin: 'system', now })).continued || 0; } catch (e) { noteSwallowed('legacy-hands.to-prefill', e, { member: 'quill', doing: `把旧版批准的 ${apply.size} 条投递转成预填`, then: '批准还在线索上，下次启动再转' }); } }
  for (const id of retired) {
    try {
      const j = J.byRef(`hostjob:${id}`);
      if (j && !J.TERMINAL.has(j.state)) J.drive(j.id, 'cancelled', { reason: apply.has(id) ? `${RETIRED}（转成了预填动作）` : RETIRED, now });
    } catch (e) { noteSwallowed('legacy-hands.retire-job', e, { member: 'patch', doing: '把旧版交给本机 AI 的那件活记成已取消', then: '看门会按没人接把它收掉' }); }
  }
  return { retired: retired.length, prefill: moved };
}

// ── 等本机 AI 的旧活和旧卡（L2，0.1.6 负责人）──────────────────────────────────────
// 改造前「交给本机 AI」时代留下的：账上 waiting_you、原因说本机 AI 没开（或者原因码是本机 AI 那几种）的活，还有即时执行器
// 队列（state/run-now.json）里早没人做的那几条。App 里引擎是唯一的手，本机 AI 只是可选的加速：不该有东西因为它没开就卡着。
// 工作台启动时跑一次（bin/serve.mjs，在 retireLegacyHostJobs 后面），能重复跑（处理过的已经不是这几种等）：
//   引擎做的（照 lib/capabilities.mjs whoDoes：不是 user_task / system_repair 的）：记已取消，原因码 legacy_local_ai
//      「旧版排给本机 AI 的，新版改由引擎做，下一轮照常接着做」。周期、成员那一轮下一档照常跑，不在启动时另起一轮。
//   你交代的事、修复（user_task / system_repair）：
//      本机 AI 现在能跑：不动，任务同步时照老路交给它（lib/task-do.mjs settleDo）；
//      要在这台电脑上操作的那一步（卡上记着 computer_need，或者旧卡就是 wait: local_ai）：原因改成 needs_local_ai，进收件箱一封信；
//      别的（文字能做的）：卡放回排队，引擎自己做，卡上记一步「旧版排给本机 AI 的，新版改由引擎做，已重新排」。
//   公司调研、面试资料的卡（引擎加文字模型做的）：一样放回排队，不取消。
//   即时执行器队列：挂的交办任务都已经结束的那几条去掉（剩下的、本机 AI 又跑不了的，收件箱里一封信，见 localAiAsks）。
import { read, write } from './store.mjs';
import { localAiGate, LOCAL_AI_OK, KINDS as CAP_KINDS, SWITCH_GO } from './capabilities.mjs';
import { waitReason, LOCAL_AI_CODES } from './wait-reason.mjs';
import { localAiAskId } from './task-ledger.mjs';
import { crewName } from './crew.mjs';
import { sandboxed } from './sandbox.mjs';
import { event } from './events.mjs';

// 引擎自己用文字模型做的卡（lib/task-do.mjs DO_KINDS）：旧版排给本机 AI 的，放回排队由引擎做，不取消。
const ENGINE_CARDS = new Set(['ask', 'repair', 'research', 'interview']);
export const REQUEUED = '旧版排给本机 AI 的，新版改由引擎做，已重新排';
const LOCAL_TEXT = /本机\s*AI/;
// 账上那件活是哪一种能力（lib/capabilities.mjs KINDS）：能力名本身、卡和旧任务的种类、再按成员（那位的一轮主要做什么）。
const CAP_OF_KIND = { ask: 'user_task', user_request: 'user_task', repair: 'system_repair', system_fix: 'system_repair', mail: 'read_mail', inbox: 'read_mail', research: 'company_research', company_brief: 'company_research', interview: 'interview_prep', judge: 'judge', apply: 'prefill', send: 'send_email', contacts: 'find_referrers', tailor: 'tailor_resume' };
const CAP_OF_MEMBER = { scout: 'discover', lens: 'judge', tailor: 'tailor_resume', quill: 'find_referrers', owl: 'read_mail' };
export const capOf = job => (CAP_KINDS.includes(job?.kind) ? job.kind : CAP_OF_KIND[job?.kind] || CAP_OF_MEMBER[job?.member] || null);
// 这件活在等本机 AI 吗：原因码是那几种，或者旧版写进原因、按钮里的「本机 AI」。
export const waitsOnLocalAi = j => j?.state === 'waiting_you' && (LOCAL_AI_CODES.has(j.reason_code) || (!j.reason_code && (LOCAL_TEXT.test(j.reason || '') || LOCAL_TEXT.test(j.what?.label || '') || j.what?.href === SWITCH_GO)));
const OPEN_HOST = new Set(['pending', 'working']);
const lastOf = rows => { const m = new Map(); for (const r of rows) if (r?.id) m.set(r.id, r); return m; };
// 队列里还有人在等的那几条：挂的任务里有没结束的；没挂任务的（旧版自由指令）也算。
export const liveReasons = (rn = {}, hostJobs = lines('state/host-jobs.ndjson')) => {
  const last = lastOf(hostJobs);
  return (rn.reasons || []).filter(r => !r?.job_ids?.length || r.job_ids.some(id => OPEN_HOST.has(last.get(id)?.status)));
};

// 旧卡仍指着宿主任务时，单改 queued 会被下一轮状态同步盖回去。转交须同时收掉旧关联；在跑的或终态不重放。
function detachLocalWait(card, now) {
  const id = card.links?.job_id;
  if (!id) return card;
  const rows = lines('state/host-jobs.ndjson'), job = rows.findLast(j => j.id === id), run = read('state/run-now.json', {});
  if ((run.running && run.job_ids?.includes(id)) || (job && !['pending', 'blocked', 'waiting_user'].includes(job.status))) return null;
  const links = { ...card.links, old_job_id: id }; delete links.job_id; delete links.do_at;
  if (job) {
    Object.assign(job, { previous_status: job.status, status: 'dropped', dropped_by: 'engine', dropped_at: new Date(now).toISOString(), moved_to_card: card.id, migration_reason: REQUEUED });
    writeLines('state/host-jobs.ndjson', rows);
  }
  return { ...card, links, requirement: card.requirement || job?.details || null,
    ...(job?.result && !card.answer ? { answer: { text: job.result, basis: ['此前排查'], at: new Date(now).toISOString(), by: card.owner || 'patch' } } : {}),
    ...(job?.kind === 'system_fix' ? { repair_target: job.target || { label: job.details } } : {}),
  };
}

export async function settleLocalAiWaits({ now = Date.now(), gate = null, who = whoDoes, cards = null } = {}) {
  const counts = { cancelled: 0, requeued: 0, letters: 0, run_now: 0 };
  const T = await import('./cards.mjs'), all = cards || T.readCards(), byRef = new Map(all.map(c => [`card:${c.id}`, c]));
  const hosts = lastOf(lines('state/host-jobs.ndjson'));
  const g = gate || localAiGate();
  const save = [];
  for (const j of J.list({ state: 'waiting_you', limit: 2000 }).filter(waitsOnLocalAi)) {
    const cap = capOf(j), card = byRef.get(j.ref) || null;
    if (card && controlled(card)) continue;
    const host = hosts.get(card?.links?.job_id || String(j.ref || '').replace(/^hostjob:/, ''));
    const native = host?.local_tool === true ? '使用已选的本机工具' : localToolNeed(`${card ? taskText(card) : j.title || j.reason || ''}；${host?.details || ''}`);
    if (native && j.reason_code === 'needs_local_ai') continue;
    try {
      if ((!cap || !LOCAL_AI_OK.includes(cap)) && !(card && ENGINE_CARDS.has(card.kind))) {
        // 引擎做的：这件不用等了。卡（不由账带着走的那几种）跟着记已取消，免得存卡时又把它推回「等你」。
        const w = waitReason('legacy_local_ai');
        J.drive(j.id, 'cancelled', { reason: w, now });
        if (card && !['done', 'cancelled'].includes(card.status)) { const c = { ...card, status: 'cancelled', detail: w.text, updated_at: new Date(now).toISOString() }; delete c.wait; delete c.wait_code; save.push(c); }
        counts.cancelled++;
        continue;
      }
      if (native && LOCAL_AI_OK.includes(cap) && who(cap, { local: true }).worker === 'local_ai') continue; // 本机 AI 能跑：任务同步时照老路交给它
      const need = native;
      if (need) {
        // 只有本机 AI 能做的那一步：收件箱里一封信。卡上的原因、账上的原因码都换成 needs_local_ai。
        const w = waitReason('needs_local_ai', { need: need || null, why: g.why || '本机 AI 没打开' });
        if (card) save.push({ ...card, wait: 'local_ai', wait_code: w.code, computer_need: need || card.computer_need, detail: w.text, updated_at: new Date(now).toISOString() });
        else J.drive(j.id, 'waiting_you', { reason: w, what: { label: `这一步要${need || '在这台电脑上操作'}，等你定怎么办`.slice(0, 40), ask_id: localAiAskId(j.ref || j.id) }, now });
        counts.letters++;
        continue;
      }
      // 文字能做的：卡放回排队，引擎自己做（lib/task-do.mjs）。
      const original = card ? detachLocalWait(card, now) : T.makeCard({ kind: 'ask', title: j.title, owner: j.member || 'patch', from: { by: 'you', via: 'legacy' }, now });
      if (!original) continue;
      const c = { ...original, kind: original.kind === 'repair' ? 'ask' : original.kind, status: 'queued', auto: true, manual: false, detail: '', updated_at: new Date(now).toISOString() };
      delete c.wait; delete c.wait_code; delete c.computer_need;
      if (!card) J.drive(j.id, 'cancelled', { reason: REQUEUED, now });
      T.addStep(c, REQUEUED, { who: c.owner || 'patch', at: now });
      save.push(c);
      counts.requeued++;
    } catch (e) { console.error(`[legacy-hands] ${j.id} 收不掉：${e.message}`); }
  }
  // 旧卡上还挂着「等本机 AI」、账上却没有那件（还没记过账）的：一样改成带码的原因（存卡时记进账）。
  for (const c of all) {
    if (controlled(c) || c.status !== 'needs_you' || c.wait !== 'local_ai' || save.some(x => x.id === c.id)) continue;
    if (byRef.has(`card:${c.id}`) && J.byRef(`card:${c.id}`)) continue; // 有账的上面已经处理过（或者本机 AI 能跑）
    const host = hosts.get(c.links?.job_id), need = host?.local_tool === true ? '使用已选的本机工具' : localToolNeed(`${taskText(c)}；${host?.details || ''}`);
    if (!need && ENGINE_CARDS.has(c.kind)) { const original = detachLocalWait(c, now); if (!original) continue; const x = { ...original, kind: c.kind === 'repair' ? 'ask' : c.kind, status: 'queued', auto: true, manual: false, detail: '' }; delete x.wait; delete x.wait_code; delete x.computer_need; save.push(x); counts.requeued++; continue; }
    const w = waitReason('needs_local_ai', { need, why: g.why || '本机 AI 没打开' });
    save.push({ ...c, wait_code: w.code, computer_need: need, detail: w.text });
    counts.letters++;
  }
  if (save.length) T.saveCards(save);
  // 即时执行器队列：挂的任务都结束了的那几条去掉。在跑的时候不动（它自己收尾）。
  const rn = read('state/run-now.json', null);
  if (rn && !rn.running && (rn.reasons || []).length) {
    const keep = liveReasons(rn).filter(r => {
      if (r.job_ids?.length || localToolNeed(r.reason || '')) return true;
      const c = T.makeCard({ kind: 'ask', title: String(r.reason || '继续交办任务').replace(/^\[[^\]]+\]\s*/, ''), owner: 'patch', from: { by: 'you', via: 'legacy' }, auto: true, now });
      c.requirement = r.reason; T.saveCards([c]); counts.requeued++; return false;
    });
    if (keep.length !== rn.reasons.length) { counts.run_now = rn.reasons.length - keep.length; write('state/run-now.json', { ...rn, reasons: keep, pending: !!keep.length && !!rn.pending, held: keep.length ? rn.held : null }); }
  }
  return counts;
}

// ── 旧版的「发 N」（实测 10-04 F 节第 4 条）────────────────────────────────────────
// 命令行时代你回的「发 498」被当成了本机 AI 的活（即时执行器队列 state/run-now.json、交办任务、卡），升级后收件箱里是一封
// 「要动电脑：『发 498』要本机 AI 做，引擎做不了」。发东西正是引擎的事：启动时把这类旧活转成引擎的发送动作——
//   和别的入口一样走 requestAction：按你当时看到的那一版（草稿的 displayed_hash）确认，批准时间照当时的（不知道就空着）；
//   超过 24 小时的记下但不发，收件箱里一封「批准很久了」等你再确认（lib/stale-approvals.mjs）；被闸挡下的（超字数、平台关着）
//   记在草稿上（send_blocked），收件箱里出一封能改、能不发的信；草稿后来改过的不记批准，
//   草稿那封信照常在收件箱里等你看。找不到这份草稿（发过了、作废了、编号对不上）的照实记一笔。
//   然后那封「要动电脑」的信收掉：队列里这几条去掉，挂的交办任务记 dropped，账上那件活记已取消。能重复跑。
export const SEND_TEXT = /^\s*(?:\[[^\]]*\]\s*)?发\s*(\d+(?:\s*[,，、]\s*\d+)*)\s*[。！!]?\s*$/;
export const sendNumbers = text => { const m = SEND_TEXT.exec(String(text || '')); return m ? [...new Set(m[1].split(/\s*[,，、]\s*/).map(Number))] : null; };
export const MOVED_TO_ENGINE = '旧版把「发」当成了本机 AI 的活，新版改由引擎发送';
export async function convertLegacySends({ now = Date.now(), request = null } = {}) {
  const ask = request || (await import('./action-kinds.mjs')).requestAction;
  const out = { converted: 0, held: 0, changed: 0, missing: 0 };
  const T = Date.parse;
  // 每一句转成了什么，记在库里 meta legacy_sends（只追加，最多 200 条）：真实数据上找不到某一封时，查这里就知道它去哪了。
  const { getMeta, setMeta } = await import('./db.mjs');
  const note = (n, where, x) => { try { setMeta('legacy_sends', [...(getMeta('legacy_sends') || []), { number: n, where, at: new Date(now).toISOString(), ...x }].slice(-200)); } catch (e) { console.error(`[legacy-hands] 没记下「发 ${n}」转成了什么：${e.message}`); } };
  // 一句「发 N」→ 每个编号一次 requestAction。返回这一句处理完了没有（找不到草稿也算处理完：照实记，不再挂着）。
  const sendOf = async (numbers, at, where) => {
    const drafts = lines('state/drafts.ndjson');
    for (const n of numbers) {
      const c = drafts.filter(d => d.number === n && d.notified_at && !['sent', 'cancelled'].includes(d.status));
      if (c.length !== 1) {
        const all = drafts.filter(d => d.number === n), why = c.length ? 'ambiguous' : !all.length ? 'no_draft' : all.every(d => d.status === 'sent') ? 'already_sent' : all.every(d => d.status === 'cancelled') ? 'cancelled' : 'not_shown';
        out.missing++; note(n, where, { outcome: why });
        event('quill', 'send-authorization', 'skip', `旧版留下的「发 ${n}」：${{ ambiguous: '有不止一份待发的草稿，请在收件箱里点那一份', no_draft: '没有编号是它的草稿', already_sent: '这份草稿已经发出去了', cancelled: '这份草稿已经作废了', not_shown: '那份草稿还没给你看过，不能按它批准' }[why]}`);
        continue;
      }
      const d = c[0];
      const r = await ask('send', { draft_id: d.draft_id }, { origin: 'chat', confirm: d.displayed_hash || null, legacy: true, approved_at: Number.isFinite(T(at || '')) ? T(at) : null, now });
      if (r.held) out.held++;
      else if (r.needs_confirm || r.blocked) out.changed++;
      out.converted++;
      // 被闸挡下（超字数、平台关着）：记在草稿上，收件箱出一封能操作的信，不只是一条事件（实测 10-05 #498：53 字的脉脉附言，收件箱里什么都没有）。
      if (r.blocked) { try { const K = await import('./action-kinds.mjs'); await K.markSendBlocked(d.draft_id, K.sendBlock(d) || { gate: r.gate || null, reason: r.reason }, { from: 'legacy', now }); } catch (e) { console.error(`[legacy-hands] 「发 ${n}」没记上挡在哪：${e.message}`); } }
      note(n, where, { draft_id: d.draft_id, outcome: r.held ? 'held_stale' : r.needs_confirm ? 'draft_changed' : r.blocked ? 'blocked' : r.done ? 'already_done' : 'queued', ...(r.reason ? { reason: String(r.reason).slice(0, 120) } : {}), ...(r.action_id ? { action_id: r.action_id } : {}) });
      event('quill', 'send-authorization', 'ok', `旧版留下的「发 ${n}」${where}：${r.held ? '转成了发送，批准太久了，收件箱里等你再确认' : r.needs_confirm ? '草稿后来改过，没记批准，收件箱里那份草稿等你看' : r.blocked ? `转成了发送，没过：${r.reason}` : r.done ? '已经发过了' : '转成了发送'}`);
    }
  };
  // 即时执行器队列里的那几句。
  let picked = [];
  {
    const rn = read('state/run-now.json', null);
    picked = (rn?.reasons || []).filter(r => sendNumbers(r?.reason));
    if (picked.length) {
      write('state/run-now.json', { ...rn, reasons: rn.reasons.filter(r => !picked.includes(r)), ...(rn.reasons.length === picked.length ? { pending: false, held: null } : {}) });
      const ids = new Set(picked.flatMap(r => r.job_ids || []));
      if (ids.size) {
        const rows = lines('state/host-jobs.ndjson'), last = lastOf(rows), at = new Date(now).toISOString();
        for (const id of ids) { const j = last.get(id); if (j && OPEN_HOST.has(j.status)) rows.push({ ...j, status: 'dropped', previous_status: j.status, dropped_at: at, dropped_by: 'engine', result: MOVED_TO_ENGINE, updated_at: at }); }
        writeLines('state/host-jobs.ndjson', rows);
      }
    }
  }
  for (const r of picked) {
    await sendOf(sendNumbers(r.reason), r.at || r.queued_at || null, '（即时执行器队列）');
    for (const id of r.job_ids || []) { const j = J.byRef(`hostjob:${id}`); if (j && !J.TERMINAL.has(j.state)) try { J.drive(j.id, 'cancelled', { reason: MOVED_TO_ENGINE, now }); } catch (e) { console.error(`[legacy-hands] ${j.id} 收不掉：${e.message}`); } }
  }
  // 账上还开着、标题就是「发 N」的旧活（你交代的事、等本机 AI 的卡）：同样转，那件活记已取消。
  for (const j of J.list({ active: true, limit: 2000 }).filter(x => sendNumbers(x.title) && capOf(x) !== 'send_email' && !['send_email', 'send_dm'].includes(x.kind))) {
    await sendOf(sendNumbers(j.title), j.created_at, '（旧任务）');
    try {
      J.drive(j.id, 'cancelled', { reason: MOVED_TO_ENGINE, now });
      // 卡（不由账带着走的那几种）跟着记已取消，免得存卡时又把它推回「等你」（和 settleLocalAiWaits 一样）。
      if (String(j.ref || '').startsWith('card:')) {
        const T = await import('./cards.mjs'), card = T.readCards().find(c => `card:${c.id}` === j.ref);
        if (card && !['done', 'cancelled'].includes(card.status)) { const c = { ...card, status: 'cancelled', detail: MOVED_TO_ENGINE, updated_at: new Date(now).toISOString() }; delete c.wait; delete c.wait_code; T.saveCards([c]); }
      }
    } catch (e) { console.error(`[legacy-hands] ${j.id} 收不掉：${e.message}`); }
  }
  return out;
}

// f1962c4 那一版转「发 N」时，被闸挡下的只记了一条事件（「旧版留下的「发 498」…：转成了发送，没过：…」），草稿上没有记号，
// 收件箱里看不到。启动时按事件补上记号（草稿还在、还没发、没作废、编号只对得上一份的）。能重复跑：记过的不再记。
const BLOCKED_EVENT = /^旧版留下的「发 (\d+)」[^：]*：转成了发送，没过：(.+)$/;
export async function recoverBlockedLegacySends({ now = Date.now(), events = null } = {}) {
  const rows = events || lines('state/events.ndjson').filter(e => e?.step === 'send-authorization');
  const hit = new Map();
  for (const e of rows) { const m = BLOCKED_EVENT.exec(String(e.msg || '')); if (m) hit.set(Number(m[1]), m[2]); }
  if (!hit.size) return { marked: 0 };
  const K = await import('./action-kinds.mjs');
  let marked = 0;
  for (const [n, reason] of hit) {
    const c = lines('state/drafts.ndjson').filter(d => d.number === n && !['sent', 'cancelled'].includes(d.status));
    if (c.length !== 1 || c[0].send_blocked) continue;
    if (await K.markSendBlocked(c[0].draft_id, K.sendBlock(c[0]) || { gate: null, reason }, { from: 'legacy', now })) marked++;
  }
  return { marked };
}

// ── 收件箱：只有本机 AI 能做的那一步 ─────────────────────────────────────────────
// 一件一封：哪件事、哪一步、为什么引擎做不了；你选：自己做、打开本机 AI、这一步不做了。
// 即时执行器队列里还有人等、本机 AI 又跑不了的（旧版自由指令、飞书里交代的）：合成一封，同样三个选择。
const cutT = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ENGINE_CANT = '本机文件和命令操作需要你自己完成，或使用可选的本机工具；浏览器与正常业务由引擎处理';
const needOf = (j, card) => card?.computer_need || /这一步要([^，,；;]+)，只有本机 AI/.exec(j.reason || '')?.[1] || null;
export function localAiAsks({ gate = null, sandbox = null, cards = null, runNow = null } = {}) {
  const out = [];
  const hosts = lastOf(lines('state/host-jobs.ndjson'));
  let byRef = null;
  for (const j of J.list({ state: 'waiting_you', limit: 500 }).filter(x => x.reason_code === 'needs_local_ai')) {
    byRef ??= new Map((cards || readCardsSync()).map(c => [`card:${c.id}`, c]));
    const card = byRef.get(j.ref) || null, need = needOf(j, card), ref = j.ref || j.id, member = j.member || card?.owner || 'patch';
    const host = hosts.get(card?.links?.job_id || String(j.ref || '').replace(/^hostjob:/, ''));
    if (card?.superseded || (card && heldAsk(card)) || (host?.local_tool !== true && !localToolNeed(`${card ? taskText(card) : j.title || j.reason || ''}；${host?.details || ''}`))) continue;
    out.push({
      from: member, id: localAiAskId(ref), type: 'info', job_ref: ref,
      title: `${cutT(j.title, 30)}：要动电脑的一步`,
      question: `「${cutT(j.title, 60)}」里，${need ? `「${need}」这一步` : '有一步'}要在这台电脑上操作，引擎做不了（${ENGINE_CANT}）。这件里别的部分照常。`,
      context: [`${crewName(member)} · 你交代的事`],
      options: [
        { key: '1', label: '我自己来', steps: [{ type: 'localai', action: 'self', ref }], primary: true },
        { key: '2', label: '打开本机 AI', steps: [{ type: 'navigate', to: SWITCH_GO }] },
        { key: '3', label: '这一步不做了', steps: [{ type: 'localai', action: 'drop', ref }] },
      ],
      other: null,
    });
  }
  const sb = sandbox ?? sandboxed();
  const g = gate || (sb ? null : localAiGate());
  if (!sb && g && !g.allowed) {
    const rn = runNow || read('state/run-now.json', {}) || {}, live = liveReasons(rn).filter(r => localToolNeed(r.reason || '') || r.job_ids?.some(id => hosts.get(id)?.local_tool === true));
    if (live.length) {
      const said = live.map(r => cutT(String(r.reason || '').replace(/^\[[^\]]+\]\s*/, ''), 40)).filter(Boolean);
      out.push({
        from: 'patch', id: 'localai:run-now', type: 'info',
        title: `你交代的 ${live.length} 件事要动电脑`,
        question: `${said.slice(0, 3).map(x => `「${x}」`).join('、')}${live.length > 3 ? ` 等 ${live.length} 件` : ''}要本机 AI 在这台电脑上做，引擎做不了（${ENGINE_CANT}）。${g.why || '本机 AI 没打开'}。`,
        context: [`${crewName('patch')} · 即时执行`],
        options: [
          { key: '1', label: '这些我自己做', steps: [{ type: 'localai', action: 'self', ref: 'run-now' }], primary: true },
          { key: '2', label: '打开本机 AI', steps: [{ type: 'navigate', to: SWITCH_GO }] },
          { key: '3', label: '这些不做了', steps: [{ type: 'localai', action: 'drop', ref: 'run-now' }] },
        ],
        other: null,
      });
    }
  }
  return out;
}
// 收件箱同步读卡（lib/tasks.mjs 引的模块多，这里只读文件）：同一个 id 以最后一行为准。
function readCardsSync() { return [...lastOf(lines('state/tasks.ndjson')).values()]; }

// 你在信上选了：self 你自己做（记做完了，结果写你来做）；drop 这一步不做了（记已取消）。卡跟着改（存卡时记进账）。
export async function answerLocalAi({ action, ref }, { now = Date.now() } = {}) {
  if (!['self', 'drop'].includes(action)) throw Object.assign(Error('不认得这个选择'), { status: 400 });
  if (ref === 'run-now') {
    let n = 0;
    {
      const rn = read('state/run-now.json', {}) || {}, live = new Set(liveReasons(rn)), ids = new Set([...live].flatMap(r => r.job_ids || []));
      n = live.size;
      write('state/run-now.json', { ...rn, reasons: (rn.reasons || []).filter(r => !live.has(r)), pending: false, held: null });
      if (ids.size) {
        const rows = lines('state/host-jobs.ndjson'), last = lastOf(rows), at = new Date(now).toISOString();
        for (const id of ids) { const j = last.get(id); if (j && OPEN_HOST.has(j.status)) rows.push({ ...j, status: 'dropped', previous_status: j.status, dropped_at: at, dropped_by: 'you', result: action === 'self' ? '你说自己来做' : '你说不做了', updated_at: at }); }
        writeLines('state/host-jobs.ndjson', rows);
      }
    }
    return action === 'self' ? `好，这 ${n} 件你来做` : `好，这 ${n} 件不做了`;
  }
  const j = J.byRef(ref) || J.get(ref);
  if (!j || j.state !== 'waiting_you') return '这件已经不在等了';
  const T = await import('./cards.mjs'), card = String(ref).startsWith('card:') ? T.readCards().find(c => `card:${c.id}` === ref) : null;
  const need = needOf(j, card), w = waitReason(action === 'self' ? 'by_you' : 'dropped_by_you', { need });
  if (card) {
    const { controlCard } = await import('./card-ops.mjs');
    controlCard(card.id, { action: action === 'self' ? 'self' : 'cancelled', now });
  } else if (action === 'self') J.drive(j.id, 'waiting_you', { reason: w, what: { label: '这一步由你自己来，完成后再标完成' }, now });
  else J.drive(j.id, 'cancelled', { reason: w, now });
  return action === 'self' ? '好，这一步你来做' : '好，这一步不做了';
}
