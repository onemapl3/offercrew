import { uncertainDelivery } from './inbox-lifecycle.mjs';
import { postingClosed } from './lead-state.mjs';
import { pendingReview } from './owner-decision.mjs';
// 每一种对外动作的细节（线 H，契约 2.3）：lib/actions.mjs requestAction 按这里的 prepare / commit 走，worker 按这里的 verify 对账。
// 草稿、发送请求、回执在库里（第 2 步，lib/drafts.mjs、lib/send-requests.mjs、lib/receipts.mjs）：commit 只在拿锁的那一下写它们。
//
//   send_email、send_dm   input { draft_id } 或 { number }（已经给你看过、还没发的那一份）。指纹 = 草稿指纹（lib/gmail.mjs）。
//                         批准记成这条动作上的发送请求（lib/send-requests.mjs，lib/drafts.mjs bindDraft 的首联保护照旧）。
//                         input.resend：不确定发出没有、被拒收的那一封，你看过以后说「再发一次」（收件箱的信，lib/mail/asks.mjs）。
//                         以前「要复核」「失败」的同一份草稿再批准：同一条请求放回队列（以前只回「已处理过」，要改稿换 id 才能重发）。
//                         批准了就发，夜里也一样（负责人 10-06：静默时段只是不监听、不提醒，不限制发送）。
//   prefill               input { number } 或 { record_id }。拒投规则在 lib/apply-approve.mjs；指纹 = 批准时的计划指纹。
//                         门户要先登录：批准照记，动作压住等你登录（hold needs_login:<账号>），「我登好了」放开接着预填。
//   submit                终审（只在自动提交打开时）：input { record_id }，指纹 = 填好的那一版（plan_fingerprint）。
//   read_mail             读一遍邮箱：不用确认；同一时间只排一次。
import { lines, writeLines } from './store.mjs';
import { registerKind, registerGate, openFor, setPayload, settle } from './actions.mjs';

// 要用规格的那几样从这里引（lib/actions.mjs 是 core，不往上引这里）：引到它们，下面每一种动作和共用的闸就一定已经登记好了。
export { requestAction, reconcile, tick, specOf } from './actions.mjs';
import { draftFingerprint, bindDraft } from './drafts.mjs';
import { hostOf, familyOf } from './accounts.mjs';
import { platformActionsEnabled, platformActionReason, platformMessageBlock, PLATFORM_ACTIONS_GO } from './platform-actions.mjs';
import { factsBlocker } from './facts-gate.mjs';
import { MAIMAI_FRIEND_LIMIT, CHANNEL_LIMITS } from './message-limits.mjs';
import { applyFreeze } from './apply-freeze.mjs';
import { applicationPlan, loadFacts, planProblem } from './application-form.mjs';
import { planFingerprint, approvalFor, approvalOf } from './submission-policy.mjs';
import { applyUrl, applyChannel } from './apply-channel.mjs';
import { applyRefusal, approveLead, loginNeeded, offDirection, prefillFingerprint } from './apply-approve.mjs';
import { approvalBlocker } from './recommend-gate.mjs';
import { hash } from './store.mjs';
import { leadKey } from './journey.mjs';
import { autoSubmitEnabled } from './auto-apply.mjs';
import { leadCity } from './city.mjs';
import { attachmentFiles } from './mail/send.mjs';
import { leadWord, personOf, urlWord } from './plain-words.mjs';
import { archivedLead } from './lead-state.mjs';
import { loadAccount } from './mail/vault.mjs';

export const DM_CHANNELS = ['platform_dm', 'maimai_friend_request'];
export const sendKindOf = d => (DM_CHANNELS.includes(d?.channel) ? 'send_dm' : 'send_email');
// 入口只知道是哪一份草稿：按草稿的渠道定是发信还是发私信（requestAction('send', …)）。
export const sendKindFor = input => { const d = findDraft(input, lines('state/drafts.ndjson')); return d && !d.ambiguous ? sendKindOf(d) : 'send_email'; };
const LIVE = d => d && !['sent', 'cancelled'].includes(d.status);
const PLATFORM = [[/zhipin\.com$/, 'boss', 'BOSS 直聘'], [/maimai\.cn$/, 'maimai', '脉脉']];
export const platformOf = url => { const h = hostOf(url) || ''; const p = PLATFORM.find(([re]) => re.test(h)); return p ? { key: p[1], label: p[2] } : null; };

// 发之前同步就能看出来的两道闸（和下面 registerGate 的 platform、words 同一套规矩）：平台没打开、超了渠道字数。
// 收件箱出信、worker 发之前再核一遍、旧版的「发 N」转换都用它。返回 null 或 { gate, reason, platform?, limit?, chars? }。
export function sendBlock(d = {}) {
  const l = lines('state/leads.ndjson').find(x => d.record_id ? leadKey(x) === d.record_id : d.number != null && x.number === d.number);
  if (l && postingClosed(l) && !['followup', 'reply'].includes(d.purpose)) return { gate: 'posting_closed', reason: '岗位已关闭，这份首次联系不再发送' };
  const unsupported = platformMessageBlock(d);
  if (unsupported) return unsupported;
  const p = DM_CHANNELS.includes(d.channel) ? platformOf(d.to) : null;
  if (p && !platformActionsEnabled(p.key)) return { gate: 'platform', platform: p.label, reason: platformActionReason(p.key), fix: { label: '打开设置', href: PLATFORM_ACTIONS_GO } };
  const limit = CHANNEL_LIMITS[d.channel] || null, chars = [...String(d.body || '')].length;
  if (limit && chars > limit) return { gate: 'words', limit, chars, reason: `${CHANNEL_WORD[d.channel] || '这一段'}最多 ${limit} 字，这一份 ${chars} 字` };
  return null;
}
// 一份草稿的发送被闸挡下了（旧版的「发 N」、worker 发之前再核时）：记在草稿上（send_blocked），收件箱就有一封能操作的信
// （lib/ask-actions.mjs blockedSendAsks → lib/asks.mjs draftAsk：超字数给「AI 缩短 / 我来改 / 这条不发了」，平台关着给「打开设置 / 这条不发了」）。
// 草稿改过、发出、作废以后这一记号不再起作用（信按草稿现在的样子出）。
export async function markSendBlocked(draftId, block, { from = 'legacy', now = Date.now() } = {}) {
  if (!draftId || !block) return false;
  const drafts = lines('state/drafts.ndjson'), d = drafts.find(x => x.draft_id === draftId);
  if (!d || ['sent', 'cancelled'].includes(d.status)) return false;
  d.send_blocked = { gate: block.gate || null, reason: String(block.reason || '').slice(0, 200), from, at: new Date(now).toISOString() };
  writeLines('state/drafts.ndjson', drafts);
  return true;
}
const CHANNEL_WORD = { maimai_friend_request: '脉脉加好友附言', platform_dm: '平台私信', platform_application: '平台申请' };

// ── 发信、发私信 ─────────────────────────────────────────────────────────────
function findDraft(input, drafts) {
  if (input.draft_id) return drafts.find(d => d.draft_id === input.draft_id) || null;
  const n = Number(input.number);
  const c = drafts.filter(d => d.number === n && LIVE(d) && d.status === 'ready');
  return c.length === 1 ? c[0] : c.length > 1 ? { ambiguous: true } : null;
}
// 卡和账上的那一行：发给谁写人名和岗位（「发私信给 Jordan · #10 Fabrikam」），不写对方主页的原始链接（主会话实测 10-04 第 6 条）。
// 内推的写内推人；没有人名写岗位；什么都没有才说是哪儿的联系人。邮箱地址照写（不是链接）。
export function sendTitle(kind, d = {}, { leads = null, referrers = null } = {}) {
  const verb = kind === 'send_dm' ? '发私信给' : '发邮件给';
  const ls = leads || lines('state/leads.ndjson'), l = ls.find(x => d.record_id && leadKey(x) === d.record_id) || (d.number != null ? ls.find(x => !x.superseded && x.number === d.number) : null) || null;
  const ref = d.referrer_id ? (referrers || lines('state/referrers.ndjson')).find(r => r.id === d.referrer_id) : null;
  const who = personOf(ref) || personOf(l), tag = l ? leadWord(l, { person: false }) : String(d.company || '').trim();
  const to = /^https?:\/\//i.test(String(d.to || '')) ? '' : String(d.to || '').trim();
  return `${verb} ${[who, tag].filter(Boolean).join(' · ') || to || (d.to ? urlWord(d.to) : '')}`.trim();
}
function sendSpec(kind) {
  return {
    kind, member: 'quill', kindFor: sendKindFor,
    prepare(input) {
      const d = findDraft(input, lines('state/drafts.ndjson'));
      if (d?.ambiguous) return { blocked: true, reason: `#${input.number} 有不止一份待发的草稿，请在收件箱里点那一份` };
      if (!d) return { blocked: true, reason: '没有这份草稿' };
      if (sendKindOf(d) !== kind) return { blocked: true, reason: kind === 'send_dm' ? '这一份是邮件，不是私信' : '这一份是私信，不是邮件' };
      if (kind === 'send_dm' && uncertainDelivery(d)) return { blocked: true, reason: '上次发送结果还没核实，请先打开原对话核实', fix: { label: '核实发送结果', href: '#inbox' } };
      if (!LIVE(d)) return { blocked: true, reason: d.status === 'sent' ? '这一份已经发出去了' : '这一份已经不发了' };
      if (d.status !== 'ready') return { blocked: true, reason: '这一份还在改，改好了再批准' };
      const jobBlock = sendBlock(d);
      if (jobBlock?.gate === 'posting_closed') return { blocked: true, reason: jobBlock.reason };
      const unsupported = platformMessageBlock(d);
      if (unsupported) return { blocked: true, ...unsupported };
      // 附件在批准时就核对（J 旅程：以前附件不在磁盘上，回执照样说「在发了」，发的时候才停在要复核）。
      if (kind === 'send_email' && d.attachments?.length) {
        try { attachmentFiles(d); } catch (e) { return { blocked: true, reason: `${e.message}，这封没法发；重新附上以后再批准`, fix: { label: '看草稿', href: '#inbox' } }; }
      }
      const fp = draftFingerprint(d), p = platformOf(d.to);
      return {
        title: sendTitle(kind, d),
        target: `draft:${d.draft_id}`,
        payload: { draft_id: d.draft_id, record_id: d.record_id, channel: d.channel || 'email', number: d.number ?? null },
        preview: { kind: 'send', channel: d.channel || 'email', number: d.number ?? null, company: d.company || null, to: d.to, subject: d.subject || null, body: d.body, attachments: (d.attachments || []).map(a => ({ name: a.name, size: a.size })) },
        fingerprint: fp, idem: `send:${d.draft_id}:${fp}`,
        platform: p, words: d.channel === 'maimai_friend_request' ? [...String(d.body || '')].length : null,
      };
    },
    // 批准记成发送请求（拿锁的那一下）。你确认的指纹在这里再对一次：刚改过就不记。
    async commit(action, p, ctx) {
      const drafts = lines('state/drafts.ndjson'), requests = lines('state/send-requests.ndjson'), outbound = lines('state/outbound.ndjson');
      const d = drafts.find(x => x.draft_id === p.payload.draft_id);
      if (!d || draftFingerprint(d) !== p.fingerprint) throw Error('草稿刚改过，你看到的不是最新一版；请再看一眼');
      const blocked = sendBlock(d); if (blocked) throw Error(blocked.reason);
      // 你看到、批准的就是这一版：记成「给你看过」（发信的两步只发给你看过、指纹没变的）。
      d.notified_at ||= new Date(ctx.now).toISOString(); d.displayed_hash = p.fingerprint;
      d.action_id = action.id;
      const old = requests.findLast(r => r.draft_id === d.draft_id);
      let req;
      // 同一份草稿上次没发成（要复核、试满了、被拒收）或者你看过「已发送」以后说「再发一次」（不确定的那封，ctx.input.resend）：
      // 原来那条发送请求放回队列、挂到这一次的动作上（lib/send-requests.mjs 从旧动作上挪过来），重新试满 3 次；绑的指纹换成你这次确认的那一版。
      const again = ['needs_review', 'failed'].includes(old?.status) || (old?.status === 'uncertain' && ctx.input?.resend);
      if (old && again) {
        Object.assign(old, { status: 'queued', requeued_at: new Date(ctx.now).toISOString(), action_id: action.id, fingerprint: p.fingerprint });
        for (const k of ['reason', 'result', 'auto_retries', 'retry_reason', 'blocked', 'blocked_at', 'dispatched_at', 'tries', 'unreachable', 'failed_at', 'uncertain_at', 'recheck_at', 'needs_review_at',
          'last_error', 'last_reason', 'last_error_raw', 'last_try_at', 'held_at', 'held_reason', 'sending_at', 'upgraded_at', 'delivery_check', 'verification_context', 'requires_verification', 'retry_disabled']) delete old[k];
        req = old;
      } else if (old) {
        if (old.status === 'sent') return { settled: { state: 'done', summary: '这一份已经发出去了' } };
        if (old.status === 'cancelled') { Object.assign(old, { status: 'queued', action_id: action.id, fingerprint: p.fingerprint }); delete old.reason; delete old.delivery_check; delete old.verification_context; delete old.requires_verification; delete old.retry_disabled; req = old; }
        // 已经排着、发送中：接上这一条。还排着没发的，指纹换成你这次确认的那一版（旧批准再确认时草稿可能改过，lib/stale-approvals.mjs）。
        else req = Object.assign(old, { action_id: action.id }, old.status === 'queued' ? { fingerprint: p.fingerprint } : {});
      } else {
        const b = bindDraft(d, { source: 'dashboard', messageId: action.id, requests, outbound });
        if (b.duplicate) return { settled: { state: 'failed', reason: '这个渠道已经联系过了，首联不发第二次' } };
        req = { ...b, action_id: action.id };
        requests.push(req);
      }
      writeLines('state/drafts.ndjson', drafts);
      writeLines('state/send-requests.ndjson', requests);
      setPayload(action.id, { request_id: req.id });
      return { receipt: kind === 'send_dm' ? '私信在发了，发出后回读对话核对' : '邮件排上了，发出后核对「已发送」；没发出去会在任务里写原因' };
    },
    // 批准太久、你说不要了（lib/stale-approvals.mjs）：发送请求取消，草稿作废（和「N 不发」一样），以后不会再被谁发出去。
    async drop(action, { now = Date.now() } = {}) {
      const at = new Date(now).toISOString(), drafts = lines('state/drafts.ndjson'), requests = lines('state/send-requests.ndjson');
      const draftId = action.payload?.draft_id, reqId = action.payload?.request_id || action.payload?.id;
      for (const r of requests) if ((r.id === reqId || (draftId && r.draft_id === draftId)) && ['queued', 'approved'].includes(r.status)) Object.assign(r, { status: 'cancelled', reason: 'stale_declined', cancelled_at: at });
      const d = drafts.find(x => x.draft_id === draftId && ['ready', 'editing'].includes(x.status));
      if (d) { Object.assign(d, { status: 'cancelled', cancelled_at: at }); delete d.displayed_hash; }
      writeLines('state/send-requests.ndjson', requests);
      writeLines('state/drafts.ndjson', drafts);
      return kind === 'send_dm' ? '这条私信不发了，草稿作废了' : '这封邮件不发了，草稿作废了';
    },
    // 对账：发送请求那一行现在怎样。
    async verify(a, { now = Date.now() } = {}) {
      if (kind === 'send_dm') {
        const { reconcileDelivery } = await import('./send-dm.mjs');
        await reconcileDelivery(a.payload?.request_id, { now });
      }
      const r = lines('state/send-requests.ndjson').find(x => x.id === a.payload?.request_id);
      if (kind === 'send_dm' && ((r?.status === 'cancelled' && r.retry_disabled) || (r?.status === 'needs_review' && r.reason === 'verified_absent'))) {
        settle(a.id, r.status === 'cancelled' ? 'cancelled' : 'failed', {reason:r.result,now}); return 'unknown';
      }
      return r?.status === 'sent' ? 'done' : r?.status === 'queued' ? 'not_done' : 'unknown';
    },
  };
}

// ── 预填、提交 ────────────────────────────────────────────────────────────────
const findLead = (input, leads) => leads.find(l => !l.superseded && !archivedLead(l) && (input.record_id ? leadKey(l) === input.record_id : l.number === Number(input.number))) || null;
registerKind({
  kind: 'prefill', member: 'quill',
  prepare(input) {
    const fz = applyFreeze();
    if (fz) return { blocked: true, reason: `投递冻结中（${fz.reason}）` };
    const leads = lines('state/leads.ndjson'), l = findLead(input, leads);
    if (!l) return { blocked: true, reason: input.number != null ? `没有编号 ${input.number} 这个岗位` : '没有这个岗位' };
    const no = applyRefusal(l, { leads, outbound: lines('state/outbound.ndjson') });
    if (no) return { blocked: true, reason: no.text, ...(no.open ? { fix: { label: '打开申请页', href: no.open } } : {}) };
    const judgementStop = !input.resume && approvalBlocker(l, { ownerDecision: true });
    if (judgementStop) return { blocked: true, reason: judgementStop };
    let plan;
    try { plan = applicationPlan(l, loadFacts()); } catch (e) { return { blocked: true, reason: planProblem(e.message) }; }
    const fp = planFingerprint(plan), login = loginNeeded(l);
    // 不在方向里的：确认框多一句「确定要投吗？」，你确认的那一份（指纹）带着这一句；接着做的（resume）是早先批准过的，不再问。
    const off = input.resume ? null : offDirection(l), review = input.resume ? null : pendingReview(l);
    // 接着做（input.resume）：你早先的批准还在、按 approval_key 复核还对得上（入口、简历没变），就不再问一遍；对不上就请你重新确认。
    if (input.resume) {
      if (l.auto_apply?.status !== 'approved' || !approvalFor(plan, [approvalOf(l)])) return { blocked: true, reason: '批准已失效，请在收件箱重新确认这条投递' };
    }
    return {
      ...(input.resume ? { preapproved: true, approved_at: Date.parse(l.auto_apply?.approved_at || '') || null } : {}),
      title: `预填 #${l.number ?? ''} ${l.company || ''}`.trim(), target: `lead:${leadKey(l)}`,
      payload: { record_id: leadKey(l), number: l.number ?? null },
      preview: { kind: 'prefill', number: l.number ?? null, company: l.company, role: l.role, city: leadCity(l) || l.location || '', channel: applyChannel(l), url: applyUrl(l), auto_submit: autoSubmitEnabled(), ...(login ? { login: login.domain } : {}), ...(off ? { off_direction: off.text } : {}), ...(review ? { pending_review: review } : {}) },
      fingerprint: input.resume ? fp : prefillFingerprint(l, fp), plan_fingerprint: fp, idem: `prefill:${leadKey(l)}:${fp}`, platform: platformOf(applyUrl(l)),
    };
  },
  async commit(action, p, ctx) {
    const leads = lines('state/leads.ndjson'), l = leads.find(x => leadKey(x) === p.payload.record_id);
    if (!l) throw Error('这个岗位刚被归档或合并了');
    if (postingClosed(l)) throw Error('这个岗位已经关了，投不了');
    const plan = applicationPlan(l, loadFacts());
    if (p.preapproved) {
      if (l.auto_apply?.status !== 'approved' || !approvalFor(plan, [approvalOf(l)])) throw Error('批准已失效，请在收件箱重新确认这条投递');
      return { receipt: autoSubmitEnabled() ? '接着填表，填好停在终审给你看' : '接着预填，填好停在提交前给你' };
    }
    const judgementStop = approvalBlocker(l, { ownerDecision: true });
    if (judgementStop) throw Error(judgementStop);
    if (planFingerprint(plan) !== (p.plan_fingerprint || p.fingerprint)) throw Error('申请材料刚变了，你看到的不是最新一版；请再看一眼');
    if (prefillFingerprint(l, planFingerprint(plan)) !== p.fingerprint) throw Error('待核点或申请材料刚变了，请再看一眼再决定');
    const { login } = approveLead(l, { plan, source: 'dashboard', at: new Date(ctx.now).toISOString(), messageId: action.id });
    writeLines('state/leads.ndjson', leads);
    if (login) {
      const fam = familyOf(applyUrl(l)), acct = fam?.key || login.domain;
      return { held: { code: 'needs_login', key: acct, reason: `要先${login.code === 'register_by_owner' ? '注册 / ' : ''}登录 ${fam?.label || login.domain}`, what: { label: '登录', ask_id: `login:${acct}` } }, receipt: `批准记下了；要先登录 ${fam?.label || login.domain}，登好了接着预填` };
    }
    return { receipt: autoSubmitEnabled() ? '开始填表，填好停在终审给你看' : '开始预填，填好停在提交前给你' };
  },
  verify(a) {
    const l = lines('state/leads.ndjson').find(x => leadKey(x) === a.payload?.record_id);
    return ['prepared_for_user', 'awaiting_final_review', 'submitted'].includes(l?.auto_apply?.status) ? 'done' : l?.auto_apply?.status === 'approved' ? 'not_done' : 'unknown';
  },
  drop: (a, o) => withdrawLead(a, o, '这条不投了，批准撤回了'),
});
// 批准太久、你说不要了：线索上的批准撤回（withdrawn，没提交过），旧批准转预填（lib/legacy-hands.mjs）不会再把它捡起来。
async function withdrawLead(a, { now = Date.now() } = {}, receipt) {
  const leads = lines('state/leads.ndjson'), l = leads.find(x => leadKey(x) === a.payload?.record_id);
  if (l?.auto_apply && ['approved', 'needs_login', 'waiting_user', 'awaiting_batch_review'].includes(l.auto_apply.status)) {
    Object.assign(l.auto_apply, { status: 'withdrawn', previous_status: l.auto_apply.status, withdrawn_at: new Date(now).toISOString(), withdrawn_reason: 'stale_approval' });
    writeLines('state/leads.ndjson', leads);
  }
  return receipt;
}
// 终审确认过、还没提交的那一份（lead 记成 approved + final_approved_at）：批准太久时你再确认一次（input.reconfirm）。
const finalApproved = l => l?.auto_apply?.status === 'approved' && !!l.auto_apply.final_approved_at && l.auto_apply.final_plan_fingerprint === l.auto_apply.plan_fingerprint;
registerKind({
  kind: 'submit', member: 'quill',
  prepare(input) {
    if (!autoSubmitEnabled()) return { blocked: true, reason: '自动提交关着：系统不代你提交，请打开申请页检查后自己提交' };
    const leads = lines('state/leads.ndjson'), l = findLead(input, leads);
    if (!l || !(l.auto_apply?.status === 'awaiting_final_review' || (input.reconfirm && finalApproved(l)))) return { blocked: true, reason: '这条已经不在等终审了，请刷新' };
    if (postingClosed(l)) return { blocked: true, reason: '这个岗位已经关了，投不了' };
    const fp = l.auto_apply.plan_fingerprint, f = l.auto_apply.final_review || {};
    return { title: `提交 #${l.number ?? ''} ${l.company || ''}`.trim(), target: `lead:${leadKey(l)}`, payload: { record_id: leadKey(l), number: l.number ?? null },
      preview: { kind: 'form', number: l.number ?? null, company: l.company, fields: f.fields || [], screenshot: f.screenshot || null, url: f.url || applyUrl(l) }, fingerprint: fp, idem: `submit:${leadKey(l)}:${fp}`, platform: platformOf(applyUrl(l)) };
  },
  async commit(action, p, ctx) {
    const leads = lines('state/leads.ndjson'), l = leads.find(x => leadKey(x) === p.payload.record_id);
    if (!l || !(l.auto_apply?.status === 'awaiting_final_review' || (ctx.input?.reconfirm && finalApproved(l))) || l.auto_apply.plan_fingerprint !== p.fingerprint) throw Error('材料刚变了，你看到的不是最新一版；请刷新后再看');
    if (postingClosed(l)) throw Error('这个岗位已经关了，投不了');
    Object.assign(l.auto_apply, { status: 'approved', final_approved_at: new Date(ctx.now).toISOString(), final_plan_fingerprint: p.fingerprint, final_approved_by: ctx.origin });
    writeLines('state/leads.ndjson', leads);
    return { receipt: '已确认，正在提交，提交结果会回到这里' };
  },
  verify(a) {
    const l = lines('state/leads.ndjson').find(x => leadKey(x) === a.payload?.record_id);
    return l?.auto_apply?.status === 'submitted' ? 'done' : 'unknown';
  },
  drop: (a, o) => withdrawLead(a, o, '这条不提交了，批准撤回了'),
});

// ── 读信 ─────────────────────────────────────────────────────────────────────
registerKind({
  kind: 'read_mail', member: 'owl', confirm: false,
  prepare(input, ctx) {
    const address = loadAccount()?.address?.toLowerCase() || null;
    const open = openFor('read_mail', 'mailbox').find(a => (a.payload?.address || null) === address);
    return { title: '读一遍邮箱', target: 'mailbox', payload: { by: ctx.origin, address }, fingerprint: null, idem: open ? open.idem_key : `read_mail:${address || ''}:${ctx.now}`, dup_receipt: '正在读信' };
  },
});

registerKind(sendSpec('send_email'));
registerKind(sendSpec('send_dm'));

// ── 共用的闸 ─────────────────────────────────────────────────────────────────
// 红线：BOSS、脉脉默认关（设置里写明打开才算开）。
registerGate('platform', (kind, p) => {
  if (!['send_dm', 'prefill', 'submit'].includes(kind) || !p.platform) return null;
  return platformActionsEnabled(p.platform.key) ? null : { reason: platformActionReason(p.platform.key, kind), fix: { label: '打开设置', href: PLATFORM_ACTIONS_GO } };
});
// 资料门：资料读不了、找不到时不往外发、不填表。
registerGate('facts', kind => {
  if (kind === 'read_mail') return null;
  const b = factsBlocker();
  return b ? { reason: b.text, fix: { label: '补资料', href: '#settings/profile' } } : null;
});
// 平台字数：脉脉加好友附言最多 50 字，批准时就算。
registerGate('words', (kind, p) => (p.words != null && p.words > MAIMAI_FRIEND_LIMIT ? { reason: `脉脉加好友附言最多 ${MAIMAI_FRIEND_LIMIT} 字，这一份 ${p.words} 字；请缩短后再批准` } : null));
// 额度：对外动作本身不调模型，不占补给和花费上限（读信时分类用到的模型由 lib/mail/inbox.mjs 自己按额度跳过）。

export const KIND_NAMES = ['send_email', 'send_dm', 'prefill', 'submit', 'read_mail'];
