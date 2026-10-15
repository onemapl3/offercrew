// 官网发现、打开申请页、预填前的同一份岗位有效性。复用 posting_closed 和已有的预筛/投递关闭路径，
// 不改“已投递/已回复”等生命周期，不把搜索缺席、网络失败、验证页当成关闭。
import { lines } from './store.mjs';
import { update } from './leads.mjs';
import { applyEvent, setApply, postingClosed, endedLead } from './lead-state.mjs';
import { canonicalCompany } from './lead-fields.mjs';
import { postingKey, canonicalUrl } from './dedupe.mjs';
import { judgeLanding, landingUrl } from './landing.mjs';
import { request, plain, challenged } from './ats/http.mjs';
import { politely } from './ats/politeness.mjs';
import { event } from './events.mjs';

const DAY = 24 * 3600000;
const key = l => postingKey(l) || canonicalUrl(l.url);
const rid = l => l.record_id || l.id;
const OPEN_APPLY = new Set(['approved', 'queued', 'pending', 'awaiting_batch_review', 'needs_login', 'failed', 'paused', 'awaiting_final_review', 'waiting_user', 'prepared_for_user']);

export function applyPostingCheck(l, check, { now = Date.now(), source = 'posting-check' } = {}) {
  const at = new Date(now).toISOString();
  if (!['job', 'gone', 'unclear'].includes(check?.verdict) || Date.parse(l.posting_check?.at) > now) return l;
  if (check.url && ![l.url, l.application_url, l.application_packet?.application_url].filter(Boolean).some(url => canonicalUrl(url) === canonicalUrl(check.url))) return l;
  const wasClosed = postingClosed(l);
  l.posting_check = { ...check, at };
  if (check.verdict === 'unclear') return l;
  l.posting_closed = check.verdict === 'gone';
  if (l.posting_closed) {
    l.prefilter_reason = 'posting_closed';
    // 只收起尚未发出的申请。已提交/提交结果未明的留原样，后续来信也照常入库。
    if (OPEN_APPLY.has(l.auto_apply?.status)) setApply(l, { ...l.auto_apply, status: 'closed', previous_status: l.auto_apply.status, closed_reason: 'posting_closed', closed_at: at }, { at, source, note: 'posting_closed' });
  } else if (l.prefilter_reason === 'posting_closed') delete l.prefilter_reason;
  if (wasClosed !== l.posting_closed) applyEvent(l, 'note', { note: l.posting_closed ? '官网确认岗位已关闭，停止新投递；历史记录保留' : '官网重新读到这个岗位' }, { at, source, strict: true });
  return l;
}

export function rememberPostingCheck(id, check, opts = {}) {
  if (!id) return null;
  let changed = false;
  let saved;
  try { saved = update(id, l => { const before = postingClosed(l); applyPostingCheck(l, check, opts); changed = before !== postingClosed(l); }); }
  catch (e) { if (e.code === 'lead_missing') return null; throw e; }
  if (changed) event('scout', 'discover', 'ok', `#${saved.number ?? '—'} ${saved.company || ''}：${postingClosed(saved) ? '岗位已关闭，已收起新投递' : '官网重新读到岗位'}`, { lead_id: id });
  return saved;
}

// 只读公开页面；登录站已有 HTTP 层的 assisted_browser_only 门。动态空壳不是仍开放的证据。
export async function probePosting(l, c = {}) {
  try {
    if (/^[a-z][a-z0-9-]*$/.test(l.ats_type || c.ats_type || '')) {
      const adapter = await import(`./ats/${l.ats_type || c.ats_type}.mjs`);
      const checked = await adapter.checkPosting?.(l, c);
      if (checked) return { ...checked, url: l.url };
    }
    const url = landingUrl(l.url), r = await request(url), html = await r.text();
    if (challenged(r.status, r.headers, html)) return { verdict: 'unclear', reason: 'bot_challenge', url: l.url };
    const title = plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
    const text = plain(body.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ''));
    const result = judgeLanding({ requested: url, lead: l, page: { url: r.url || url, title, text, status: r.status } });
    return result.verdict === 'gone' ? { ...result, url: l.url, reason: 'posting_page_closed', evidence: { url: r.url || url, title, text: text.slice(0, 1000) } } : { verdict: 'unclear', reason: result.verdict, url: l.url };
  } catch (e) {
    return { verdict: 'unclear', reason: String(e.message || e).replace(/([?&](?:_csrf|token)=)[^&\s]+/ig, '$1[redacted]').slice(0, 300), url: l.url };
  }
}

// discover 的成功新读数顺手刷新已收岗位；旧缓存/没读通的源不作新证据。
// 没出现在列表只排一次精确详情读取（列表会有城市、关键词和分页限制）。每天最多一次，最久没核的先读。
export async function refreshOfficialPostings(outcomes, { leads = lines('state/leads.ndjson'), now = Date.now(), limit = 20, budgetMs = 90000, stop = () => false, probe = probePosting, save = rememberPostingCheck } = {}) {
  const sourceKey = (ats, company) => `${ats}:${canonicalCompany(company)}`;
  const fresh = new Map(outcomes.filter(o => !o.error && !o.reused && Array.isArray(o.jobs)).map(o => [sourceKey(o.c.ats_type, o.c.name), { c: o.c, seen: new Set(o.jobs.map(key).filter(Boolean)) }]));
  const candidates = [], result = { seen: 0, checked: 0, closed: 0, unknown: 0, deferred: 0 };
  for (const l of leads) {
    if (l.source !== 'official_ats' || l.superseded || !l.url) continue;
    const o = fresh.get(sourceKey(l.ats_type, l.company));
    if (!o) continue;
    if (o.seen.has(key(l))) {
      save(rid(l), { verdict: 'job', reason: 'official_list', url: l.url }, { now, source: 'discover' }); result.seen++; continue;
    }
    if (postingClosed(l) || endedLead(l) || l.match?.verdict === 'exclude' || (l.prefilter_reason && l.prefilter_reason !== 'china_remote_unverified')) continue;
    if (now - (Date.parse(l.posting_check?.at) || 0) < DAY) continue;
    candidates.push({ l, c: o.c });
  }
  const priority = l => OPEN_APPLY.has(l.auto_apply?.status) ? 0 : l.match?.verdict === 'recommend' ? 1 : l.match?.verdict === 'verify' ? 2 : 3;
  candidates.sort((a, b) => (Date.parse(a.l.posting_check?.at) || 0) - (Date.parse(b.l.posting_check?.at) || 0) || priority(a.l) - priority(b.l) || (Date.parse(a.l.discovered_at) || 0) - (Date.parse(b.l.discovered_at) || 0));
  const started = Date.now();
  for (const { l, c } of candidates) {
    if (result.checked >= limit || stop() || Date.now() - started >= budgetMs) break;
    const check = await politely(() => probe(l, c), { robots: true });
    save(rid(l), { ...check, url: l.url }, { now, source: 'discover' });
    result.checked++; if (check.verdict === 'gone') result.closed++; else if (check.verdict === 'unclear') result.unknown++;
  }
  result.deferred = candidates.length - result.checked;
  return result;
}
