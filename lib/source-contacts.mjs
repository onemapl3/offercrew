// Radar 的联系人沿用已有名单；手动管理不推断身份，也不生成草稿或发送授权。
import { loadReferrers, upsertReferrer, setReferrerStatus, normalizeCompany } from './referrers.mjs';
import { event } from './events.mjs';

const fail = (status, message) => Object.assign(Error(message), { status });
const text = x => String(x ?? '').trim();
const address = value => {
  const v = text(value);
  if (/^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/.test(v) && v.length <= 254) return { email: v.toLowerCase(), contact_url: null };
  let u; try { u = new URL(v); } catch { throw fail(400, '填写联系人主页链接或邮箱'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || v.length > 2000) throw fail(400, '填写 http 开头的联系人主页链接或邮箱');
  u.hash = ''; return { email: null, contact_url: u.href.replace(/\/$/, '') };
};
const contactKey = r => text(r.contact_url || r.email).replace(/\/$/, '').toLowerCase();
const STATUS = { found: '已收录', drafted: '已有草稿', contacted: '已联系', sent: '已联系', replied: '已回复', skipped: '已跳过' };
const ROLE = { headhunter: '猎头', hr: 'HR', recruiter: '招聘人员', referral_post: '内推人', alumni: '校友', former_colleague: '前同事', team_member: '团队成员' };
export const contactRole = r => r.author_title || ROLE[r.relationship] || '';
export function sourceContacts() {
  return loadReferrers().filter(r => r.status !== 'retired').map(r => ({
    id: r.id, name: r.author || '联系人', company: r.company || '', contact: r.contact_url || r.email || '',
    url: /^https?:\/\//i.test(r.contact_url || '') ? r.contact_url : null,
    email: r.email || '', role: contactRole(r), source: r.source === 'manual' ? '手动添加' : r.source || '',
    post_url: r.post_url || null, contact_line: r.contact_line || '',
    status: STATUS[r.status] || '已收录', manual: r.source === 'manual',
  }));
}
export function addSourceContact(body = {}) {
  const name = text(body.name), company = text(body.company), contact = address(body.contact);
  if (!name || name.length > 80) throw fail(400, '联系人姓名要 1–80 个字');
  if (!company || company.length > 80 || !normalizeCompany(company)) throw fail(400, '公司名要 1–80 个字');
  const existing = loadReferrers().find(r => normalizeCompany(r.company) === normalizeCompany(company) && contactKey(r) === contactKey(contact));
  if (existing && existing.status !== 'retired') throw fail(409, '这位联系人已在名单中');
  const row = upsertReferrer({ ...(existing || {}), company, author: name, ...contact, source: existing?.source || 'manual',
    relationship: existing?.relationship || 'contact', status: existing?.retired_from_status || 'found' });
  event('user', 'sources', 'ok', `联系人：${existing ? '恢复' : '添加'}了 ${name}（${company}）`);
  return { ok: true, id: row.id, receipt: existing ? '已恢复这位联系人' : '已添加联系人' };
}
export function removeSourceContact(body = {}) {
  const r = loadReferrers().find(r => r.id === text(body.id));
  if (!r) throw fail(404, '没有这位联系人');
  if (r.status !== 'retired') {
    setReferrerStatus(r.id, 'retired', { retired_from_status: r.status, retired_at: new Date().toISOString(), retired_by: 'user' });
    event('user', 'sources', 'ok', `联系人：移出了 ${r.author || '联系人'}（${r.company || ''}）`);
  }
  return { ok: true, receipt: '已移出联系人名单，已有草稿和联系记录保留' };
}
