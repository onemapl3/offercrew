// 引擎里的 worker（线 H，契约 2.3）：从 actions 领走 → 做 → 核对对面真的变了 → 回执。由引擎自己起（lib/actions.mjs kickWorker
// → bin/worker.mjs），不经本机 AI；做事的那一段不占全局锁，只在读写数据的那一下拿（照内置邮箱三段式）。
//
//   send_email   lib/mail/send.mjs sendQueued：SMTP 发出，「已发送」里按 Message-ID 找到这一封才算发出；拿不准的记不确定。
//   send_dm      lib/send-dm.mjs main({ only })：专用 Chrome 打开对话，发之前先读对话，发之后正文要在对话里多出现一次。
//   prefill      lib/apply-run.mjs applyApproved({ only })：填好、读回，停在提交前（自动提交关着，默认）或终审。
//   submit       同上：终审确认过的那一版提交，截下回执。
//   read_mail    lib/mail/inbox.mjs runMailRead：读新信、配线索；对上岗位的起草回复。
//
// 回执看结果，不看「写进了文件」：发送请求那一行、线索上的投递状态、读信的计数。
import { lines } from './store.mjs';
import { claimAll, settle, hold, requeue } from './actions.mjs';
import { noteSwallowed } from './swallow.mjs';
import { hostOf, familyOf } from './accounts.mjs';
import { leadKey } from './journey.mjs';
import { MAIL_SETUP } from './capabilities.mjs';
import { autoApplyNeeds } from './needs.mjs';
import { leadApplyWords, missingLine } from './apply-words.mjs';
import { SEND_TRIES, RETRY_MS, sendWhy, gaveUpLine } from './mail/send-words.mjs';
import { mailOutcome } from './watcher-mail.mjs';
import { loadAccount } from './mail/vault.mjs';

const MAIL_WORDS = { needs_review: '要你复核', cancelled: '取消了' };
export { sendWhy };
// 一条发送请求的结局 → 动作的回执。
export function settleSend(a, r, { drafts = [] } = {}) {
  const dm = a.kind === 'send_dm';
  const d = drafts.find(x => x.draft_id === (r?.draft_id || a.payload?.draft_id)) || {};
  if (!r) return settle(a.id, 'failed', { reason: '找不到这一份的发送请求' });
  if (r.status === 'sent') return settle(a.id, 'done', { summary: dm ? '私信发出了，对话里看到了这段正文' : '邮件发出了，「已发送」里有这一封', receipt: { request_id: r.id, message_id: r.message_id || null, evidence: r.evidence || null }, links: { draft: `draft:${d.draft_id || r.draft_id}` } });
  if (r.status === 'uncertain' || r.status === 'sending' || (r.status === 'dispatched' && !dm)) return settle(a.id, 'uncertain', { reason: dm ? '点了发送，没确认对面收到；去对话里看一眼' : '发出去了没有还没核对上；去「已发送」里看一眼', what: { label: '看一眼', href: '#inbox' } });
  if (r.status === 'dispatched') return settle(a.id, 'uncertain', { reason: r.channel === 'maimai_friend_request' ? '脉脉加好友发到一半没确认；去脉脉上看一眼' : '点了发送，没确认对面收到', what: { label: '看一眼', href: '#inbox' } });
  if (r.status === 'failed' && r.unreachable) return settle(a.id, 'failed', { reason: gaveUpLine(r), what: { label: '看一眼', href: '#inbox' } });
  if (r.status === 'failed') return settle(a.id, 'failed', { reason: `对方服务器拒收了${r.reason ? `：${String(r.reason).slice(0, 80)}` : ''}` });
  if (r.status === 'needs_review') return settle(a.id, 'failed', { reason: r.result || (/^attachment/.test(r.reason || '') ? `附件${r.reason === 'attachment_changed' ? '和你批准时不一样了' : '找不到了'}，这封没发；重新附上以后再批准` : r.reason === 'draft_changed' || !r.reason ? '草稿和你批准的那一版对不上了，没发；改好后再批准' : `没发出去，${MAIL_WORDS.needs_review}`) });
  if (r.status === 'cancelled') return settle(a.id, 'cancelled', { reason: r.reason === 'lead_closed' ? '这条岗位你已经不推进了，没发' : '不发了' });
  if (r.status === 'queued' && r.blocked === 'needs_login') {
    const host = hostOf(d.to), fam = familyOf(d.to), key = fam?.key || host;
    return hold(a.id, { code: 'needs_login', key, reason: `要先登录 ${fam?.label || host}`, what: { label: '登录', ask_id: `login:${key}` } });
  }
  if (r.status === 'queued' && r.held_reason) return hold(a.id, { code: 'mail_send', key: '', reason: '邮箱只能收信，发信没通', what: { label: '接上邮箱', href: MAIL_SETUP } });
  // 这次没连上、还没试满：放回排队、到点再领（不是 30 秒一次地连），那件活记「排队中，几点再发」；原因一句人话。
  if (r.status === 'queued') return requeue(a.id, { reason: r.result || `没发出去（第 ${r.tries || 1}/${SEND_TRIES} 次）：${sendWhy(r)}`, max: SEND_TRIES, retry_at: new Date(Date.parse(r.last_try_at || '') + RETRY_MS || Date.now() + RETRY_MS).toISOString() });
  return settle(a.id, 'uncertain', { reason: `发送请求停在 ${r.status}`, what: { label: '看一眼', href: '#inbox' } });
}
const requestOf = (a, requests) => requests.find(r => r.id === a.payload?.request_id) || requests.find(r => r.action_id === a.id) || requests.find(r => r.draft_id === a.payload?.draft_id);

// 预填做完、停在提交前时那件活等的是什么：终审那封信（final:<rid>），或者「在页面上检查后提交」那封（prefilled:<rid>）。
// 读回来还有必填项空着：照实说几项、要你填（lib/apply-words.mjs missingLine），不说「预填好了」。
export function applyWaitOf(l) {
  const rid = leadKey(l);
  const info = autoApplyNeeds(l).find(n => n.kind === 'info');
  if (info) return { reason: info.question, what: { label: '补信息', ask_id: `need:lead:${rid}:info` } };
  const final = l?.auto_apply?.status === 'awaiting_final_review', gaps = final ? null : missingLine(l?.auto_apply?.prefill?.missing || []);
  return final ? { reason: '表填好了，停在「提交」前，等你终审', what: { label: '终审', ask_id: `final:${rid}` } }
    : gaps ? { reason: `认得出的项预填好了，${gaps.count} 项必填空着要你填（${gaps.list}），停在提交前`, what: { label: '补填', ask_id: `prefilled:${rid}` } }
    : { reason: '预填好了，停在提交前，等你在页面上检查后提交', what: { label: '提交', ask_id: `prefilled:${rid}` } };
}
// 一条线索的投递状态 → 动作的回执。
export function settleApply(a, l) {
  const st = l?.auto_apply?.status, n = l?.number != null ? `#${l.number} ` : '';
  if (!l) return settle(a.id, 'failed', { reason: '这个岗位不见了（归档或合并了）' });
  // 预填做完、停在提交前：动作做完了，那件活等你（终审，或者在页面上检查后自己提交），挂收件箱那封信。
  // 你提交、自己投了、不投了，线索的状态一变，那件活由 lib/leads.mjs settleApplyWait 落定（以前卡上的「等你」是 lib/tasks.mjs applyWait 从线索推的）。
  if (st === 'prepared_for_user') return settle(a.id, 'done', { summary: missingLine(l.auto_apply.prefill?.missing || []) ? `${n}认得出的项预填好了，还有必填项要你填` : `${n}预填好了，等你提交`, links: { lead: `lead:${leadKey(l)}` }, wait: applyWaitOf(l) });
  if (st === 'awaiting_final_review') return settle(a.id, 'done', { summary: `${n}填好了，等你终审`, links: { lead: `lead:${leadKey(l)}` }, wait: applyWaitOf(l) });
  if (st === 'submitted') return settle(a.id, 'done', { summary: `${n}已提交，回执截下来了`, links: { lead: `lead:${leadKey(l)}` } });
  if (st === 'needs_login') { const fam = familyOf(l.application_url || l.url), key = fam?.key || l.auto_apply.domain; return hold(a.id, { code: 'needs_login', key, reason: `要先登录 ${fam?.label || l.auto_apply.domain || '这个门户'}`, what: { label: '登录', ask_id: `login:${key}` } }); }
  // 等你那一步说人话（lib/apply-words.mjs）；原始的码留在线索的证据里（auto_apply.stop）。信在收件箱（lib/needs.mjs → lib/asks.mjs）。
  if (st === 'waiting_user') { const w = leadApplyWords(l.auto_apply); return hold(a.id, { code: 'needs_user', key: leadKey(l), reason: l.auto_apply.error ? w.line : '门户要你处理一步（验证码或实名）', what: { label: /^one_click_/.test(w.code || '') ? '打开申请页' : '处理', ask_id: `need:lead:${leadKey(l)}:${/^cover_letter/.test(w.code || '') ? 'letter' : /^unanswered/.test(w.code || '') ? 'info' : 'approve'}` } }); }
  if (['submitting', 'uncertain'].includes(st)) return settle(a.id, 'uncertain', { reason: '点了提交，没确认门户收到；去申请页看一眼', what: { label: '看一眼', href: '#inbox' } });
  if (st === 'failed') return settle(a.id, 'failed', { reason: leadApplyWords(l.auto_apply).line });
  return requeue(a.id, { reason: '这一轮没轮到，下次接着做' });
}

// 读信的结果 → 一句人话和计数（旅程 4：「1 封新回复」，没有新信是「没有新的」，也算做完）。
export function readSummary(r) {
  const n = Number(r?.read) || 0, replies = Number(r?.raised) || 0;
  return replies ? `${replies} 封新回复` : n ? `读了 ${n} 封，没有招聘方的回复` : '没有新的';
}

// 读信锁竞争只等待资源，不产生失败回执；有限等待，网络修复与需要本人重连分开。
export function settleRead(a, r, { now = Date.now(), address = a.payload?.address || loadAccount()?.address || null } = {}) {
  const o = mailOutcome(r);
  if (o?.read) return settle(a.id, 'done', { summary: r.status === 'baseline' ? o.text : readSummary(r), counts: { read: Number(r.read) || 0, replies: Number(r.raised) || 0, related: Number(r.recorded) || 0 }, now });
  if (o?.waiting_resource) {
    const waitMs = 12 * 3600000, interval = 5 * 60000;
    if (!Number.isFinite(Date.parse(a.created_at)) || now - Date.parse(a.created_at) >= waitMs) return settle(a.id, 'failed', { reason: '读信通道等待已到 12 小时上限，或缺少有效开始时间；本轮已停止，运行记录已保留', now });
    return requeue(a.id, { reason: o.text, resource_wait: true, retry_at: new Date(now + interval).toISOString(), now });
  }
  if (o?.go) return hold(a.id, { code: 'mail_read', key: String(address || '').toLowerCase(), reason: o.text, what: o.go }, { now });
  if (o?.retryable) return requeue(a.id, { reason: a.attempts >= 3 ? `${o.text}；连续 3 次连接失败，本轮已停止` : `${o.text}；系统将在 10 分钟后再试，最多 3 次`, retry_at: new Date(now + 10 * 60000).toISOString(), max: 3, now });
  return settle(a.id, 'failed', { reason: o?.text || '没读成：读信出错了', now });
}

export async function runWorker(kind, { now = Date.now() } = {}) {
  let claimed = claimAll(kind, { now });
  if (!claimed.length) return { kind, claimed: 0 };
  // 发之前再过一遍两道闸（平台没打开、超了渠道字数，lib/action-kinds.mjs sendBlock）：旧版迁进来、没经过 requestAction 的批准，
  // 或者批准以后你在设置里把平台关了。挡下的不发：动作记失败（原因照实），草稿上记一笔，收件箱出一封能改、能不发的信。
  if (kind === 'send_email' || kind === 'send_dm') {
    const K = await import('./action-kinds.mjs'), drafts = lines('state/drafts.ndjson'), go = [];
    for (const a of claimed) {
      const d = drafts.find(x => x.draft_id === a.payload?.draft_id), b = d ? K.sendBlock(d) : null;
      if (!b) { go.push(a); continue; }
      settle(a.id, 'failed', { reason: `没发：${b.reason}` });
      try { await K.markSendBlocked(d.draft_id, b, { from: 'worker', now }); } catch (e) { console.error(`[${kind}] 没记上草稿挡在哪（${a.id}）：${e.message}`); }
    }
    claimed = go;
    if (!claimed.length) return { kind, claimed: 0, blocked: true };
  }
  let result = null;
  try {
    if (kind === 'send_email') {
      const { sendQueued } = await import('./mail/send.mjs');
      // 只发领走的这几封：队列里别的（旧版留下的、批准太久压着的）不跟着发出去。
      const requests0 = lines('state/send-requests.ndjson');
      const r0 = await sendQueued({ only: claimed.map(a => requestOf(a, requests0)?.id).filter(Boolean) });
      const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson');
      // worker 的日志（runs/<日>/worker/send_email-*.log）：每一封的结局和原因，连不上时带上原文（错误码和第一行，授权码已去掉）。
      console.log(`[send_email] ${new Date().toISOString()} 领了 ${claimed.length} 封；发信结果：${JSON.stringify(r0 || {})}`);
      for (const a of claimed) {
        const q = requestOf(a, requests);
        console.log(`[send_email] 动作 ${a.id}：${q ? `${q.status}${q.tries ? `（第 ${q.tries}/${SEND_TRIES} 次）` : ''}${q.status === 'sent' ? '' : `；${sendWhy(q)}`}${q.last_error_raw ? `；原文：${q.last_error_raw}` : ''}` : '找不到发送请求'}`);
        settleSend(a, q, { drafts });
      }
    } else if (kind === 'send_dm') {
      const requests0 = lines('state/send-requests.ndjson');
      const only = claimed.map(a => requestOf(a, requests0)?.id).filter(Boolean);
      const { main } = await import('./send-dm.mjs');
      await main({ only });
      const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson');
      for (const a of claimed) settleSend(a, requestOf(a, requests), { drafts });
    } else if (kind === 'prefill' || kind === 'submit') {
      const { applyApproved } = await import('./apply-run.mjs');
      const r = await applyApproved({ only: claimed.map(a => a.payload?.record_id).filter(Boolean) });
      const leads = lines('state/leads.ndjson');
      for (const a of claimed) {
        if (r.reason?.startsWith?.('facts_')) { settle(a.id, 'failed', { reason: r.detail || '资料读不了' }); continue; }
        if (r.skipped === 'apply_freeze') { settle(a.id, 'failed', { reason: `投递冻结中（${r.reason}）` }); continue; }
        settleApply(a, leads.find(l => leadKey(l) === a.payload?.record_id));
      }
    } else if (kind === 'read_mail') {
      const address = loadAccount()?.address?.toLowerCase() || null;
      const own = [];
      for (const a of claimed) {
        if (a.payload?.address && a.payload.address !== address) hold(a.id, { code: 'mail_read', key: a.payload.address, reason: `这件任务属于 ${a.payload.address}，当前连接的邮箱已变更`, what: { label: '连接该邮箱', href: MAIL_SETUP } });
        else own.push(a);
      }
      claimed = own;
      if (!claimed.length) return { kind, claimed: 0, held: true };
      const { runMailRead } = await import('./mail/inbox.mjs');
      const r = result = await runMailRead({ expectedAddress: address });
      if (r.status === 'changed') try { const { draftReplies } = await import('./mail/draft.mjs'); r.drafts = (await draftReplies()).drafted; } catch (e) { noteSwallowed('workers.draft-replies', e, { member: 'tailor', doing: '给新回复起草回信', then: '读信照样算做完，下一轮再起草' }); }
      for (const a of claimed) settleRead(a, r, { address });
    } else throw Error(`没有这种 worker：${kind}`);
  } catch (e) {
    // 做到一半出错：还没回执的那几条照实记失败（发信类记不确定，交对账核对，不重发）。
    for (const a of claimed) try {
      if (['send_email', 'send_dm', 'submit'].includes(kind)) settle(a.id, 'uncertain', { reason: `做到一半出错：${String(e.message || e).slice(0, 100)}`, what: { label: '看一眼', href: '#inbox' } });
      else requeue(a.id, { reason: String(e.message || e).slice(0, 120) });
    } catch (e2) { noteSwallowed('workers.settle-after-error', e2, { member: 'quill', doing: `把动作 ${a.id} 记成没做完`, then: '对账时按进程不在了处理（发信类记不确定，不重发）' }); }
    throw e;
  }
  return { kind, claimed: claimed.length, ...(result ? { result } : {}) };
}
