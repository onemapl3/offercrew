// 指令写法的对外动作（「投 12 15」「投 全部」「发 32、46」「发 全部」）→ 一条条 requestAction（线 H，契约 2.5）。
// 指挥台、对话、手机、任务卡、收件箱里还在用这种写法的，都经 lib/command-center.mjs dispatchCommand 走到这里；
// 不再起 bin/queue-apply.mjs、bin/action.mjs 去把文字再解析一遍，也不再交给即时执行器。
// 返回和以前 dispatchCommand 一样的形状：没确认 → { needs_confirm, preview }（预览的样子不变：queue_apply 的 rows、send 的 drafts）；
// 确认了 → { receipt, applied: { queued, waiting_login, skipped }, open?, navigate? }。
import { openFor, release, kickWorker, isStaleHeld, retireDone, listActions } from './actions.mjs';
import { requestAction } from './action-kinds.mjs';
import { lines, writeLines } from './store.mjs';
import { applyProposal } from './reacher.mjs';
import { noteSwallowed } from './swallow.mjs';
import { autoApplyNeeds } from './needs.mjs';
import { setApply } from './lead-state.mjs';
import { clearTask } from './executor-heartbeat.mjs';

// 这条指令点到的编号。
export function commandTargets(cmd) {
  if (cmd.kind === 'queue_apply') {
    const nums = cmd.all ? applyProposal({ leads: lines('state/leads.ndjson') }).rows.map(r => r.number) : cmd.numbers || [];
    return nums.filter(n => n != null && !(cmd.exclude || []).includes(n));
  }
  if (cmd.kind === 'send_all') {
    const ds = lines('state/drafts.ndjson').filter(d => d.status === 'ready' && d.notified_at && d.number != null);
    return [...new Set(ds.map(d => d.number))].filter(n => !(cmd.exclude || []).includes(n));
  }
  return (cmd.numbers || String(cmd.input || '').match(/\d+/g) || []).map(Number);
}
// 预览的老样子（页面、手机的确认框按它画）：发信是 send 的 drafts，预填是 queue_apply 的 rows。
export const legacyPreview = (kind, p, n = null) => (kind === 'prefill' ? { kind: 'queue_apply', auto_submit: !!p?.auto_submit, rows: [applyRow(n, p || {})], missing: [] } : ['send', 'send_email', 'send_dm'].includes(kind) ? { kind: 'send', drafts: [sendRow(n, p || {})], missing: [] } : p);
const sendRow = (n, p) => ({ number: p.number ?? n, company: p.company || null, channel: p.channel, to: p.to, subject: p.subject || null, body: p.body, attachments: p.attachments || [] });
const applyRow = (n, p) => ({ number: p.number ?? n, company: p.company, role: p.role, city: p.city, channel: p.channel, url: p.url, in_proposal: true, ...(p.login ? { stop: `要先登录 ${p.login}，登好了会接着预填` } : {}), ...((p.off_direction || p.pending_review) ? { warn: [p.off_direction, p.pending_review && (p.pending_review.judgement_stopped ? `${p.pending_review.points.join('；')}。继续表示是否推进由你自己决定。` : `待核：${p.pending_review.points.join('；')}。继续表示这些待核点由你自己决定。`)].filter(Boolean).join('\n') } : {}) });

// job_id：任务卡自己那件活（一件活一张卡）。只点到一个编号时动作挂在它上面；点到好几个的各开各的。
// confirm：true（认这里上一次给你看的那一份），或者指纹字符串（你在信上看到的那一份，只点到一个编号时用）。
export async function outboundCommand(cmd, { confirm = false, origin = 'chat', now = Date.now(), job_id = null } = {}) {
  const apply = cmd.kind === 'queue_apply', kind = apply ? 'prefill' : 'send';
  const nums = commandTargets(cmd);
  if (!nums.length) return { ok: false, receipt: apply ? '这次没有可以投的编号' : '现在没有已经给你看过、等你确认的草稿' };
  const results = [];
  for (const n of nums) {
    let r;
    const said = typeof confirm === 'string' && nums.length === 1 ? confirm : confirm ? true : null;
    // 批量（好几个编号、「投 全部」）：按你现在的规则不在方向里的一律跳过，回执里照实说（单条的在确认框里问你一句）。
    if (apply && (nums.length > 1 || cmd.all)) { const { offDirection } = await import('./apply-approve.mjs'); const l = lines('state/leads.ndjson').find(x => !x.superseded && x.number === n); const off = l && offDirection(l); if (off) { results.push({ n, r: { blocked: true, off: true, reason: `${off.text.replace(/，确定要投吗？$/, '')}，批量里不投；要投就单独点这一条` } }); continue; } }
    try { r = await requestAction(kind, { number: n }, { origin, confirm: said, now, ...(job_id && nums.length === 1 ? { job_id } : {}) }); }
    catch (e) { r = { blocked: true, reason: String(e.message || e).slice(0, 160) }; }
    results.push({ n, r });
  }
  // 没确认，或者确认了却从没给你看过这一版（服务端换了进程、从没经这里给你看过预览）：回预览，等你看过再确认——
  // 不说成「刚变过」（J 10-04：收件箱确认预填，卡记「失败：7 刚变过」，其实 #7 什么都没变）。
  //   这几个都要再看一眼（没给你看过，或者真的变了）：整张回预览；真的变了的写清（changed）。只是其中几个的，分开说。
  const pending = confirm ? results.filter(x => x.r.needs_confirm) : [];
  if (!confirm || (pending.length && pending.length === results.filter(x => !x.r.blocked).length)) {
    const shown = results.filter(x => x.r.needs_confirm), stopped = results.filter(x => x.r.blocked);
    if (!shown.length) return { ok: false, receipt: stopped.map(x => `${x.n}：${x.r.reason}`).join('\n') || '没有要确认的', blocked: stopped.map(x => ({ number: x.n, reason: x.r.reason, fix: x.r.fix || null })) };
    const preview = apply
      ? { kind: 'queue_apply', auto_submit: !!shown[0].r.preview?.auto_submit, rows: [...shown.map(x => applyRow(x.n, x.r.preview)), ...stopped.map(x => ({ number: x.n, in_proposal: false, stop: x.r.reason }))], missing: [] }
      : { kind: 'send', drafts: shown.map(x => sendRow(x.n, x.r.preview)), missing: stopped.map(x => x.n), stops: stopped.map(x => ({ number: x.n, reason: x.r.reason })) };
    const changed = pending.filter(x => x.r.changed).map(x => x.n);
    return { ok: true, needs_confirm: true, preview, fingerprints: Object.fromEntries(shown.map(x => [x.n, x.r.fingerprint])), ...(changed.length ? { changed, receipt: `${changed.join('、')} 和你确认时不一样了，请再看一眼` } : {}) };
  }
  const queued = [], waiting = [], skipped = [], again = [], open = [];
  for (const { n, r } of results) {
    if (r.queued && r.held) { waiting.push({ number: n, next: r.receipt, ask: r.what?.ask_id || null }); if (r.open) open.push(...r.open); }
    else if (r.queued || r.done) queued.push({ number: n, receipt: r.receipt });
    else if (r.needs_confirm && r.changed) again.push(n);
    else if (r.needs_confirm) skipped.push(`${n}：要你先看一眼这一版再确认`);
    else skipped.push(`${n}：${r.reason}`);
  }
  const lines_ = [
    queued.length ? `${apply ? '开始预填' : '在发了'} ${queued.length} 个：${queued.map(q => q.number).join('、')}${queued.length === 1 && queued[0].receipt ? `（${queued[0].receipt}）` : ''}` : '',
    ...waiting.map(w => `${w.number}：${w.next}`),
    again.length ? `${again.join('、')} 刚变过，没${apply ? '投' : '发'}；请再看一眼` : '',
    ...(skipped.length ? [`没排上 ${skipped.length} 个：`, ...skipped.map(s => '· ' + s)] : []),
  ].filter(Boolean);
  // jobs：每个编号的动作挂在哪件活上（任务卡发「投 N」时，这条线索已经有一条开着的动作、挂在别的活上：卡改跟那一件，lib/tasks.mjs startCard）。
  const jobs = Object.fromEntries(results.filter(x => x.r.job_id && (x.r.queued || x.r.done)).map(x => [x.n, x.r.job_id]));
  return { ok: queued.length + waiting.length > 0 || !skipped.length, receipt: lines_.join('\n') || '没有排上的', applied: { queued: queued.map(q => q.number), waiting_login: waiting.map(w => w.number), skipped, changed: again }, jobs, ...(open.length ? { open } : {}),
    // 批准了却都卡在登录上：直接带你到收件箱里那个账号的登录信（10-01 开箱测试）。
    ...(!queued.length && waiting[0]?.ask ? { navigate: `#inbox?ask=${encodeURIComponent(waiting[0].ask)}` } : {}) };
}

// 预填停下来以后接着做（契约 2.5，02a「登好以后不接着预填」）：你补完申请表缺的项、登好门户、选定了简历版本……
//   这条线索上压着的预填 / 提交动作 → 放开（release），worker 接着领；
//   没有还开着的动作（上一次记了失败、或者是改造前的老批准）→ 按你早先的批准再排一条（requestAction resume：批准按 approval_key 复核，
//   对不上就不排，请你重新确认）。不再直接起 bin/auto-apply.mjs（lib/apply-kick.mjs 退役）。
// 返回 { continued, blocked: [原因…] }。
export async function continuePrefill(rids, { origin = 'system', now = Date.now(), kick = kickWorker, job_id = null } = {}) {
  let continued = 0;
  const blocked = [];
  for (const rid of new Set([].concat(rids).filter(Boolean))) {
    const open = ['prefill', 'submit'].flatMap(k => openFor(k, `lead:${rid}`));
    if (open.some(a => a.state === 'uncertain')) { blocked.push('上次提交结果还没核对上，先查看申请页，不重复预填或提交'); continue; }
    // 批准太久、压着等你再确认的（stale）：这里不放开，等你在收件箱那封「N 天前批准的」里确认。
    if (open.length && open.every(isStaleHeld)) { blocked.push('这是之前批准的，等你在收件箱里再确认一次'); continue; }
    if (open.length) {
      const held = open.filter(a => a.state === 'approved' && a.hold && !isStaleHeld(a)).map(a => a.id);
      if (held.length) release({ ids: held, now, kick });
      else for (const k of new Set(open.filter(a => a.state === 'approved').map(a => a.kind))) try { kick(k); } catch (e) { noteSwallowed('action-entry.kick', e, { member: 'quill', doing: `叫醒${k === 'prefill' ? '预填' : '提交'}的 worker`, then: '动作还排着，半分钟后的那一拍再叫' }); }
      continued++;
      continue;
    }
    let r;
    // 上次预填完成、任务在等补信息：那张旧回执不能代替这次继续。
    // 只重做预填，提交动作不动；保留同一件活和历史，批准仍在 prepare 里核验。
    const target = `lead:${rid}`, previous = listActions({ kind: 'prefill', limit: 5000 }).filter(a => a.target === target).at(-1);
    retireDone('prefill', target, { now });
    const l = lines('state/leads.ndjson').find(l => (l.record_id || l.id) === rid);
    if (l?.number != null) clearTask({ executor: 'auto-apply', task: l.number, now });
    try { r = await requestAction('prefill', { record_id: rid, resume: true }, { origin, now, kick, ...((job_id || previous?.job_id) ? { job_id: job_id || previous.job_id } : {}) }); }
    catch (e) { r = { blocked: true, reason: String(e.message || e).slice(0, 160) }; }
    if ((r.queued && !r.held) || (r.done && r.sandbox)) continued++;
    else {
      const reason = r.reason || r.receipt || '没排上';
      blocked.push(reason);
      // 答案已经保存；排不上时换成能恢复的真实阻碍，别让卡继续指旧问卷。
      if (!r.held && l?.auto_apply?.status === 'approved') {
        const rows = lines('state/leads.ndjson'), fresh = rows.find(x => (x.record_id || x.id) === rid);
        if (fresh) { const at = new Date(now).toISOString(); setApply(fresh, { ...fresh.auto_apply, status: /批准已失效/.test(reason) ? 'awaiting_batch_review' : 'failed', error: reason, at, stop: { step: '恢复预填队列', code: reason, at } }, { at, source: 'inbox', note: 'resume_blocked' }); writeLines('state/leads.ndjson', rows); }
      }
    }
  }
  return { continued, blocked };
}

export const goOn = (rids, { now = Date.now(), origin = 'inbox' } = {}) => continuePrefill(rids, { now, origin });
// 自动投递停在"表上有项不会填"：你答完之后重新排队。批准还有效就直接再跑（这一次从答案簿取答案，
// 填好照样停在终审给你看）；批准失效了就回到"材料变了，重新确认"。
export async function requeueApply(recordId, now = Date.now(), { kick = goOn } = {}) {
  let queued = false;
  {
    const rows = lines('state/leads.ndjson'), l = rows.find(x => (x.record_id || x.id) === recordId);
    if (!l?.auto_apply) throw Error('这条线索没有在投递');
    if (l.auto_apply.status !== 'waiting_user' && !autoApplyNeeds(l).some(n => n.kind === 'info')) return '这条投递已经不在等这些信息了';
    const valid = !!l.auto_apply.approved_at;
    const { error: _was, stop: _stop, ...kept } = l.auto_apply;
    setApply(l, { ...kept, status: valid ? 'approved' : 'awaiting_batch_review', answered_at: new Date(now).toISOString() }, { at: new Date(now).toISOString(), source: 'inbox', note: 'answered' });
    writeLines('state/leads.ndjson', rows);
    queued = valid;
  }
  // 接着做压着的那条预填动作（契约 2.5），不另起预填脚本、不经即时执行器。
  if (!queued) return '批准已失效，请在收件箱重新确认这条投递';
  const r = await kick([recordId], { now });
  return r?.blocked?.length && !r.continued ? r.blocked[0] : '已重新排队填表，填好会停在提交前给你终审';
}
