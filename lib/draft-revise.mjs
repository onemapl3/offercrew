// 「改 N …」由引擎做（线 H，能力表 revise_draft：Writer 加文字模型）。以前本机 AI 关着时没人改：内置邮箱起草的邮件等下一轮周期，
// 别的（私信、脉脉加好友附言、以前留下的邮件草稿）排一条交给本机 AI 的 revise_material，就停在那里（01 根 2）。
//   markForRevise(d, text)  调用方持锁：那一份记成 editing、带上你的话；旧的发送确认作废（要你重新看过才能发）。
//   reviseNow()             马上改：邮件走 lib/mail/draft.mjs reviseDrafts（Writer 在上一版的基础上重写、逐句核对出处）；
//                           私信、脉脉附言按你的话改措辞，不加新的事实，脉脉附言不超过 50 字。改好的一份替掉旧的，等你看。
// 试满 3 次没改成：原来那一版回到「等你看」，那件活记失败、写原因。
import crypto from 'node:crypto';
import { lines, writeLines } from './store.mjs';
import { event } from './events.mjs';
import { crewName } from './crew.mjs';
import { MAIMAI_FRIEND_LIMIT } from './message-limits.mjs';

const DM = new Set(['platform_dm', 'maimai_friend_request']);
const iso = t => new Date(t).toISOString();
export const revisable = d => !!d && ['ready', 'editing'].includes(d.status) && (DM.has(d.channel) || ((d.channel || 'email') === 'email' && !!d.record_id));

export function markForRevise(d, text, { now = Date.now() } = {}) {
  if (!revisable(d)) return false;
  Object.assign(d, { status: 'editing', revise_request: { text: String(text).slice(0, 600), at: iso(now) } });
  delete d.displayed_hash; delete d.notified_at; delete d.revise_tries;
  return true;
}

const SCHEMA = { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string' } } };
const dmPrompt = (d, limit) => `你是求职者的助手 ${crewName('tailor')}。下面是一段准备发给招聘方的${d.channel === 'maimai_friend_request' ? '脉脉加好友附言' : '平台私信'}，求职者要你按他的话改。
规矩：只按他的话改措辞和顺序；不加原文里没有的经历、数字、公司名或承诺；保持礼貌、简短${limit ? `；全文不超过 ${limit} 个字` : ''}。
只返回 JSON：{"body": "改好的全文"}。

原文：
${d.body || ''}

他的话：
${d.revise_request?.text || ''}`;

async function reviseDms({ model = null, budget = 3, now = () => Date.now() } = {}) {
  const todo = lines('state/drafts.ndjson').filter(d => DM.has(d.channel) && d.status === 'editing' && d.revise_request).slice(0, budget);
  if (!todo.length) return { revised: 0, failed: [] };
  const infer = model || (await import('./model.mjs')).infer;
  const marks = new Map(), added = [], failed = [];
  for (const d of todo) {
    const limit = d.channel === 'maimai_friend_request' ? MAIMAI_FRIEND_LIMIT : null;
    let body = '';
    try { body = String((await infer(dmPrompt(d, limit), `revise-${crypto.createHash('sha1').update(`${d.draft_id}:${d.revise_request.at}`).digest('hex').slice(0, 20)}`, SCHEMA, { role: 'tailor', step: 'revise', what: `改 #${d.number ?? ''} 的私信`, lead_id: d.record_id || null }))?.body || '').trim(); } catch (e) { body = ''; failed.push({ draft_id: d.draft_id, reason: String(e.message || e).slice(0, 100) }); }
    const bad = !body ? '模型没改成' : limit && [...body].length > limit ? `改出来 ${[...body].length} 字，超过脉脉附言的 ${limit} 字` : null;
    if (bad) {
      const tries = (Number(d.revise_tries) || 0) + 1;
      marks.set(d.draft_id, tries >= 3 ? { status: 'ready', revise_failed_at: iso(now()), revise_request: undefined, revise_tries: tries, revise_error: bad } : { revise_tries: tries });
      if (!failed.some(f => f.draft_id === d.draft_id)) failed.push({ draft_id: d.draft_id, reason: bad });
      if (tries >= 3) event('tailor', 'draft', 'fail', `${crewName('tailor')}：#${d.number ?? '—'} 的私信没按你的话改成（${bad}），原来那一版还在`, { lead_id: d.record_id });
      continue;
    }
    const t = now(), next = { ...d, draft_id: `rev-${crypto.createHash('sha1').update(`${d.draft_id}:${t}`).digest('hex').slice(0, 20)}`, body, status: 'ready', revised_from: d.draft_id, created_at: iso(t) };
    for (const k of ['revise_request', 'revise_tries', 'displayed_hash', 'notified_at', 'displayed_on', 'edited_at', 'revise_error']) delete next[k];
    added.push(next);
    marks.set(d.draft_id, { status: 'cancelled', reason: 'revised', cancelled_at: iso(t) });
    event('tailor', 'draft', 'waiting_user', `${crewName('tailor')}：#${d.number ?? '—'} 的私信按你的话改好了，等你看`, { lead_id: d.record_id });
  }
  if (marks.size) {
    const drafts = lines('state/drafts.ndjson'), applied = new Set();
    // 改的这段时间里你作废了它（不再是 editing）：什么都不动，新的一份也不加。
    for (const x of drafts) if (marks.has(x.draft_id) && x.status === 'editing') { applied.add(x.draft_id); for (const [k, v] of Object.entries(marks.get(x.draft_id))) { if (v === undefined) delete x[k]; else x[k] = v; } }
    for (const n of added) if (applied.has(n.revised_from)) drafts.push(n);
    writeLines('state/drafts.ndjson', drafts);
  }
  return { revised: added.length, failed };
}

// 马上改。→ { revised, failed: [{ draft_id, reason }] }
export async function reviseNow({ model = null, now = () => Date.now() } = {}) {
  let mail = { revised: 0 };
  try { mail = await (await import('./mail/draft.mjs')).reviseDrafts({ now }); } catch (e) { mail = { revised: 0, error: String(e.message || e).slice(0, 120) }; }
  const dm = await reviseDms({ model, now });
  return { revised: (mail.revised || 0) + dm.revised, failed: [...dm.failed, ...(mail.error ? [{ reason: mail.error }] : [])] };
}
