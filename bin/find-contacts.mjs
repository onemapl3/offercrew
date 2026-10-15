// Find an application mailbox for official postings that have none.
//
// Only seventeen of sixteen hundred official leads carry an email, so the
// email channel — the one the user wants to lead with — barely runs. This
// stage reads what the company itself publishes (the JD, the careers page,
// the contact page), lets code find every address on them, and asks Jev which
// one is for applicants. Nothing is guessed: no candidate, no email.
//
//   node bin/find-contacts.mjs --limit 20
import YAML from 'yaml';
import { lines, patchLines, patch, read, write, text, arg, log, today, hash, deadlineNear } from '../lib/store.mjs';
import { event } from '../lib/events.mjs';
import { request, plain } from '../lib/ats/http.mjs';
import { judgeAvailable, judgeMany } from '../lib/judge.mjs';
import { chooseApplicationEmail, emailCandidates } from '../lib/judgements.mjs';
import { applyChannel } from '../lib/apply-channel.mjs';
import { normalizeCompany } from '../lib/referrers.mjs';
import { discoveryAllows, sourceEnabled } from '../lib/discovery-policy.mjs';
import { budgetGate } from '../lib/spend.mjs';
import { passedLead } from '../lib/lead-state.mjs';

// 今天的花费上限到了（lib/spend.mjs）：不开新的查找，留到明天。
if (budgetGate('contacts')) { console.log(JSON.stringify(log('find-contacts', { status: 'no_change', reason: 'spend_cap' }))); process.exit(0); }

export const CONTACTS_PATH = 'state/company-contacts.json';
const TTL_DAYS = 30;
const limit = Math.max(1, Number(arg('--limit', 20)));
const contacts = read(CONTACTS_PATH, {});
const leads = lines('state/leads.ndjson');
const companies = [...YAML.parse(text('config/companies.yaml')), ...YAML.parse(text('config/companies.archive.yaml'))];
const now = Date.now();
// 旧版本缺判断连接时也曾写 checked_at；有候选但没有判断置信度的记录不能冒充查完了。
const fresh = (c) => c?.checked_at && !(!c.email && c.candidates?.length && c.confidence == null) && now - Date.parse(c.checked_at) < TTL_DAYS * 86400000;

// Companies worth a mailbox: a lead the judgement kept, no email yet, not a
// human post (those carry their own contact), not ruled out by the user.
const wanted = new Map();
for (const l of leads) {
  if (!sourceEnabled('official') || !discoveryAllows(l)) continue;
  if (l.superseded || l.legacy || passedLead(l) || !['recommend', 'verify'].includes(l.match?.verdict)) continue;
  if (l.email || applyChannel(l) === 'email' || /真人|内推|Boss/.test(l.source_type || '')) continue;
  const key = normalizeCompany(l.company);
  if (!key || fresh(contacts[key])) continue;
  if (!wanted.has(key)) wanted.set(key, { key, company: l.company, leads: [] });
  wanted.get(key).leads.push(l);
}
const targets = [...wanted.values()].slice(0, limit);

async function pageText(url) {
  if (!/^https?:\/\//.test(url || '')) return '';
  try { return plain(await (await request(url)).text()).slice(0, 20000); } catch { return ''; } // 兜底：这一页读不到就当没有正文，换下一页
}
const contactUrls = (careers) => {
  try {
    const u = new URL(careers);
    return [careers, `${u.origin}/contact`, `${u.origin}/contact-us`, `${u.origin}/about`, `${u.origin}/careers`, `${u.origin}/jobs`, `${u.origin}/join`, `${u.origin}/joinus`];
  } catch { return [careers]; }
};

let found = 0, checked = 0, updated = 0, deferred = 0;
const errors = [];
const results = await judgeMany(targets, async (t) => {
  // 到了周期给的收尾点：不再开新公司，它们没有 checked_at，下一轮照样排进来。
  if (deadlineNear(90000)) return { deferred: true };
  const c = companies.find((x) => x.name === t.company);
  const texts = [t.leads.map((l) => l.jd_text || '').join('\n\n')];
  const sources = ['jd'];
  const careers = c?.careers_url || t.leads.find((l) => l.url)?.url;
  // Only pages with an address are worth a model question; most have none.
  for (const url of [...new Set(contactUrls(careers))].slice(0, 5)) {
    const body = await pageText(url);
    if (body && emailCandidates(body).length) { texts.push(body); sources.push(url); }
    if (texts.length >= 4) break;
  }
  const candidates = emailCandidates(...texts);
  const dir = `runs/${today()}/contacts/${hash(t.key).slice(0, 16)}`;
  write(`${dir}/candidates.json`, { company: t.company, sources, candidates });
  if (!candidates.length) return { email: null, candidates, sources };
  // 没有模型时本次没有做完识别，不能写 30 天的“已查无邮箱”缓存。
  if (!judgeAvailable({ textOk: true })) throw Error('contact_model_unavailable');
  const pick = await chooseApplicationEmail({ company: t.company, texts, request_id: `contact-${hash(t.key).slice(0, 16)}` });
  return { ...pick, sources };
}, { concurrency: 3 });

// 查邮箱要几分钟：写回前重读联系方式表和线索，只改这一轮查到的（lib/store.mjs patch / patchLines）。
const checkedNow = {}, emailFor = new Map();
for (const [i, r] of results.entries()) {
  const t = targets[i];
  if (r.ok && r.value.deferred) { deferred++; continue; }
  checked++;
  if (!r.ok) { errors.push({ company: t.company, error: r.error }); continue; }
  checkedNow[t.key] = { company: t.company, checked_at: new Date(now).toISOString(), email: r.value.email || null, candidates: r.value.candidates || [], sources: r.value.sources || [], confidence: r.value.confidence ?? null };
  if (!r.value.email) continue;
  found++;
  for (const l of t.leads) emailFor.set(l.id, r.value.email);
}
patch(CONTACTS_PATH, {}, (c) => { Object.assign(c, checkedNow); });
if (emailFor.size) patchLines('state/leads.ndjson', (rows) => {
  for (const l of rows) {
    const email = emailFor.get(l.id);
    if (!email || l.email) continue;
    l.email = email; l.entry_type = '邮箱'; l.contact_source = 'company_page'; l.contact_found_at = new Date(now).toISOString();
    updated++;
  }
  if (!updated) return false;
});
event('reacher', 'contacts', found ? 'ok' : 'skip', `联系方式发现：查 ${checked} 家，找到邮箱 ${found} 家，更新线索 ${updated} 条`);
console.log(JSON.stringify(log('find-contacts', { status: updated ? 'changed' : 'no_change', checked, found, updated, pending: wanted.size - targets.length + errors.length + deferred, ...(deferred ? { deferred } : {}), errors: errors.slice(0, 5) })));
