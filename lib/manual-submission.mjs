// 本人提交的本地记录可以纠正；外部提交凭据保留，不把真实提交当成误记。
import { lines, writeLines, read, write, hash } from './store.mjs';
import { applyEvent, setApply, leadState, appliedLead } from './lead-state.mjs';
import { applyUrl, applyChannel } from './apply-channel.mjs';
import { delivered } from './delivery.mjs';

const key = l => l.record_id || l.id;
export const ownerReceipt = o => o.status !== 'corrected' && (o.manual === true || o.submitted_by === 'user') && !o.external_id && !o.verified_at && !o.readback;
export function canCorrectSubmission(l, outbound = lines('state/outbound.ndjson')) {
  const mine = outbound.filter(o => o.record_id === key(l));
  return leadState(l) === 'applied' && l.auto_apply?.submitted_by === 'user' && !mine.some(o => !ownerReceipt(o) && o.status !== 'corrected' && delivered(o, l));
}
export function recordOwnerSubmission(l, { now = Date.now(), source = 'inbox' } = {}) {
  const outbound = lines('state/outbound.ndjson'), rid = key(l), at = new Date(now).toISOString(), url = applyUrl(l) || null;
  if (appliedLead(l) || outbound.some(o => o.record_id === rid && ownerReceipt(o))) return `#${l.number} 已记为投递过`;
  const previous = { state: leadState(l), auto_apply: structuredClone(l.auto_apply || {}) };
  setApply(l, { ...(l.auto_apply || {}), status: 'submitted', submitted_by: 'user', at, owner_record: { at, previous }, confirmation: '你确认已在页面上亲自提交' }, { at, source, note: 'submitted_by_user' });
  outbound.push({ id: hash(['manual_submit', rid, url, at]).slice(0, 32), record_id: rid, number: l.number, channel: applyChannel(l) === 'ats_form' ? 'ats_form' : 'portal', status: 'submitted', manual: true, submitted_by: 'user', source, at, url, confirmation: '你确认已在页面上亲自提交' });
  writeLines('state/outbound.ndjson', outbound);
  return `#${l.number} ${l.company} 已记为你亲自投递；误记时可在详情里撤回这条记录`;
}
export function correctOwnerSubmission(rid, { now = Date.now() } = {}) {
  const rows = lines('state/leads.ndjson'), l = rows.find(x => key(x) === rid);
  if (!l) throw Error('这个岗位不在了');
  const outbound = lines('state/outbound.ndjson');
  if (!canCorrectSubmission(l, outbound)) throw Error('只有本人确认的本地投递记录可以撤回；有实际提交凭据或后续进展时不能回退');
  const at = new Date(now).toISOString();
  for (const o of outbound.filter(o => o.record_id === rid && ownerReceipt(o))) Object.assign(o, { status: 'corrected', corrected_at: at, correction: '本人说明先前已提交是误记' });
  // 旧记录没有快照也能恢复到预填后的接手步骤；不重新授权或启动任何对外动作。
  const old = l.auto_apply, saved = old.owner_record?.previous?.auto_apply || old;
  const { submitted_by, submitted_at, confirmation, owner_record, ...kept } = saved;
  l.auto_apply = { ...kept, status: 'prepared_for_user', at, corrected_at: at };
  applyEvent(l, 'owner_submission_corrected', { note: '撤回误记的本人提交' }, { at, source: 'inbox', strict: true });
  writeLines('state/outbound.ndjson', outbound);
  writeLines('state/leads.ndjson', rows);
  const pages = read('state/application-pages.json', {});
  pages[rid] = { ...(pages[rid] || {}), gone: true, why: '撤回了误记的提交，原预填页需要重新确认', at };
  write('state/application-pages.json', pages);
  return `#${l.number} ${l.company} 已撤回误记的提交，可以重新预填`;
}
