// 「材料变了」到底变了什么（实测 10-04 第 10 条：16 封信都只写「申请入口或简历变了」）。
// 批准记的是：这个岗位、这个申请入口、这种语言的投递简历（lib/submission-policy.mjs approvalKeys）；从 10-04 起还记着当时那一版简历的名字
// （auto_apply.approved_resume，lib/apply-approve.mjs）。这里拿批准记下的和现在的计划逐项比，说出是哪一样：
//   url     申请入口地址变了（从哪儿换到哪儿）
//   slot    投递简历换了语言（中文版 ↔ 英文版）
//   resume  投递用的简历换了（知道两边的名字就说从哪版换成哪版）
//   old     2026-09-23 以前的批准，记的是整份填表答案和简历文件的指纹，现在对不上，说不出是哪一项（照实说旧版没记下）
//   10-04 以前、有钥匙没记入口和简历的：拿线索上出现过的入口、两种语言、资料里的简历文件试出当时的钥匙，再说是哪一样变了
//   never   还没批准过
// 只读，不写任何东西。
import { hash } from './store.mjs';
import { canonicalUrl } from './dedupe.mjs';
import { approvalKeys, planFingerprint } from './submission-policy.mjs';
import { currentFacts, resumeFiles } from './facts.mjs';

const SLOT_WORD = { chinese_pdf: '中文版', english_pdf: '英文版' };
const same = (a, b) => (canonicalUrl(a) || a) === (canonicalUrl(b) || b);
export function approvalChange(lead = {}, plan = null) {
  const a = lead.auto_apply || {};
  if (!a.approved_at) return [{ what: 'never' }];
  if (!plan) return [];
  if (!a.approval_key) return a.approved_plan_fingerprint === planFingerprint(plan) ? [] : [{ what: 'old' }];
  if (approvalKeys(plan).includes(a.approval_key)) return [];
  // 10-04 以前的批准没记 approved_url / approved_resume：拿这条线索上出现过的入口、两种语言、简历文件一个个试，
  // 试出当时那把钥匙是怎么算出来的，就知道是哪一样变了（钥匙 = 岗位 + 入口 + 简历那一栏或文件名，lib/submission-policy.mjs）。
  if (!a.approved_url && !a.approved_resume) { const found = decodeKey(lead, plan, a.approval_key); if (found) return found; }
  const out = [], was = a.approved_url || null, slot = plan.resume?.slot || null;
  const other = Object.keys(SLOT_WORD).find(s => s !== slot) || null;
  const hit = (o = {}) => approvalKeys(plan, o).includes(a.approval_key);
  // 批准时的入口（记在 approved_url）和现在的不一样，而且按当时的入口算得出那把钥匙：入口换了。
  const urlMoved = !!was && !same(was, plan.url);
  if (urlMoved) out.push({ what: 'url', from: was, to: plan.url });
  // 换成另一种语言的那一栏算得出钥匙：投递简历换了语言。
  if (other && (hit({ slot: other }) || (was && hit({ url: was, slot: other })))) out.push({ what: 'slot', from: other, to: slot });
  const from = a.approved_resume?.label || null, to = plan.resume?.label || null;
  // 入口、语言都解释不了：这一栏指着的文件换了。两边的版本名都知道、又不一样，也说一句。
  const explained = (urlMoved && hit({ url: was })) || out.some(c => c.what === 'slot');
  if (!explained || (from && to && from !== to)) out.push({ what: 'resume', from, to });
  return out;
}
// 线索上出现过的入口地址（顶层和投递记录里像网址的字段）、简历两种语言的栏、资料里的简历文件：试出批准时的钥匙。
const URL_RE = /^https?:\/\//i;
function urlsOf(lead = {}, plan = {}) {
  const out = new Set([plan.url]);
  for (const o of [lead, lead.auto_apply || {}]) for (const v of Object.values(o)) if (typeof v === 'string' && URL_RE.test(v)) out.add(v);
  return [...out].filter(Boolean).flatMap(u => [canonicalUrl(u) || u, u]).filter((u, i, all) => all.indexOf(u) === i);
}
const base = f => String(f || '').split('/').pop() || null;
function decodeKey(lead, plan, key) {
  let files = [];
  try { files = Object.values(resumeFiles(currentFacts())).map(base); } catch { files = []; /* 兜底：资料读不了就只试计划里的文件 */ }
  files = [...new Set([base(plan.fields?.resume_path), base(plan.resume_routed), ...files].filter(Boolean))];
  const slots = Object.keys(SLOT_WORD), rid = plan.record_id;
  for (const url of urlsOf(lead, plan)) {
    for (const s of slots) if (hash({ record_id: rid, url, resume_slot: s }) === key) return describe(plan, { url, slot: s });
    for (const f of files) if (hash({ record_id: rid, url, resume: f }) === key) return describe(plan, { url, file: f });
  }
  return null;
}
function describe(plan, { url, slot = null, file = null }) {
  const out = [];
  if (!same(url, plan.url)) out.push({ what: 'url', from: url, to: plan.url });
  if (slot && slot !== plan.resume?.slot) out.push({ what: 'slot', from: slot, to: plan.resume?.slot || null });
  if (file && file !== base(plan.fields?.resume_path) && file !== base(plan.resume_routed)) out.push({ what: 'resume', from: file, to: plan.resume?.label || base(plan.fields?.resume_path) });
  return out.length ? out : null;
}
const hostPath = u => { try { const x = new URL(u); const p = x.pathname.replace(/\/$/, ''); return `${x.hostname.replace(/^www\./, '')}${p.length > 24 ? p.slice(0, 23) + '…' : p}`; } catch { return String(u || '').slice(0, 40); } };
// 一项变化 → 一句人话。
export function changeLine(c = {}) {
  if (c.what === 'url') return `申请入口地址变了：${hostPath(c.from)} → ${hostPath(c.to)}`;
  if (c.what === 'slot') return `投递简历从${SLOT_WORD[c.from] || '另一种语言'}换成了${SLOT_WORD[c.to] || '另一种语言'}`;
  if (c.what === 'resume') return c.from && c.to ? `投递简历从「${c.from}」换成了「${c.to}」` : `投递用的简历文件换了${c.to ? `，现在是「${c.to}」` : ''}`;
  if (c.what === 'old') return '旧版没记下当时用的是哪份材料';
  if (c.what === 'never') return '还没批准过';
  if (c.what === 'plan') return c.text || '现在的材料还没准备好';
  return '申请入口或简历变了';
}
export const changeWords = (changes = []) => changes.length ? changes.map(changeLine).join('；') : '申请入口或简历变了';
export const changeSig = (changes = []) => hash(changes.map(c => [c.what, c.from || null, c.to || null, c.text || null])).slice(0, 12);
