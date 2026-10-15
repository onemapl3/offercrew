// 可重复的升级：留底、收旧提醒；不替用户批准、投递或启动新任务。
import { lines, writeLines } from './store.mjs';
import { readCards, saveCards, addStep, TERMINAL } from './cards.mjs';
import { controlled } from './task-control.mjs';
import { uncertainDelivery } from './inbox-lifecycle.mjs';
import * as J from './jobs.mjs';
import { getAction, settle } from './actions.mjs';
// R16 合入的时间；此后的新电脑请求不按旧流程退休。
const RADAR_CUTOVER = Date.parse('2026-10-11T04:49:37+08:00');
export const OLD_FAILURE_MS = 72 * 3600000;
export function upgradeInbox({ now = Date.now() } = {}) {
  const at = new Date(now).toISOString(), leads = lines('state/leads.ndjson'), retired = [];
  for (const l of leads) {
    const a = l.auto_apply, time = Date.parse(a?.at || '');
    if (a?.status !== 'failed' || !Number.isFinite(time) || now - time < OLD_FAILURE_MS || a.inbox_retired?.attempt_at === a.at) continue;
    // 后来又明确批准过的仍是新请求，不能拿旧失败把它收掉。
    if (Date.parse(a.approved_at || '') > time || Date.parse(a.answered_at || '') > time) continue;
    a.inbox_retired = { at, attempt_at:a.at, reason:'这次失败已超过三天，保留记录；重新预填由你在岗位页发起' };
    retired.push(l.record_id || l.id);
  }
  if (retired.length) writeLines('state/leads.ndjson', leads);
  const cards = [];
  for (const c of readCards()) {
    if (!(Date.parse(c.created_at || '') < RADAR_CUTOVER) || TERMINAL.has(c.status) || controlled(c) || c.superseded || c.wait !== 'local_ai' || c.kind !== 'ask' || c.leads?.length) continue;
    const text = [c.title, c.requirement, c.computer_need].filter(Boolean).join(' ');
    // 只退休“读取公司招聘页/岗位列表”的旧电脑卡；申请、登录等人工步骤仍保留。
    if (!/(?:招聘页|careers|岗位列表)/i.test(text) || !/(?:读取|查看|打开|核实|找.*岗位)/.test(text) || /填表|提交|登录|验证码/.test(text)) continue;
    c.superseded = { at, by:'company-search', previous_status:c.status, reason:'公司招聘页改由 Radar 读取；旧的电脑操作提醒已收起，可在对话里让 Radar 重新找岗位' };
    c.status='cancelled'; c.auto=false; c.manual=true; c.result=c.superseded.reason;
    addStep(c,c.result,{who:'patch',at:now}); cards.push(c);
    const j=J.byRef(`card:${c.id}`); if(j && !J.TERMINAL.has(j.state)) J.drive(j.id,'cancelled',{reason:c.result,now});
  }
  if(cards.length) saveCards(cards);
  const requests=lines('state/send-requests.ndjson'), drafts=lines('state/drafts.ndjson'); let uncertain=0;
  for(const r of requests) {
    const d=drafts.find(x=>x.draft_id===r.draft_id);
    if(!d || uncertainDelivery(d, requests)?.id !== r.id) continue;
    if (r.status !== 'uncertain') {
      r.previous_status=r.status; r.status='uncertain'; r.uncertain_at ||= at;
      r.result=r.channel==='platform_dm' ? '上次发送没有核实到结果；会先自动读原对话，核实前不会再发' : '上次加好友结果没有核实到；目前无法自动核对这类申请，请在平台核实，确认前不会再发'; uncertain++;
    }
    // 旧版 requested / failed 动作也要进入引擎对账，不能只改投递记录而永远不读原对话。
    const action = getAction(r.action_id);
    if (action && ['requested','approved','failed'].includes(action.state)) settle(action.id,'uncertain',{now,reason:r.result});
  }
  if(uncertain) writeLines('state/send-requests.ndjson',requests);
  return {retired:retired.length,cards:cards.length,uncertain};
}
