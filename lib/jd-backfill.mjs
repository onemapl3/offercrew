// 补全已有岗位的原帖正文：不另建线索，不改候选人资料或投递账。
import { execFile } from './spawn.mjs';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { lines, write, read, root, today } from './store.mjs';
import { update } from './leads.mjs';
import { endedLead } from './lead-state.mjs';
import { canonicalUrl } from './dedupe.mjs';
import { event } from './events.mjs';
import { makeCard, saveCards, addStep } from './cards.mjs';
import * as J from './jobs.mjs';
import { request, plain, json, challenged } from './ats/http.mjs';
import { detailUrlFor, detailText } from './ats/workday.mjs';
import { runBrowserScript } from './browser-run.mjs';

const execute = promisify(execFile), inFlight = new Set();
export const MAX_JD_CHARS = 18000;
const key = l => l.record_id || l.id;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const find = rid => lines('state/leads.ndjson').find(l => key(l) === rid || l.id === rid);
const sameUrl = (a, b) => !!canonicalUrl(a) && canonicalUrl(a) === canonicalUrl(b);
const accessPage = (url, title, text) => /\/(?:login|signin|checkpoint|authwall|uas)(?:\/|\?|$)/i.test(String(url))
  || /^(?:sign in|log in|just a moment|checking your browser|登录|安全验证|访问验证)/i.test(String(title).trim())
  || /(?:verify you are human|unusual traffic|checking your browser|完成安全验证|访问过于频繁|请完成验证)/i.test(String(text).slice(0, 1000));

export function fullJdText(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (text.replace(/\s/g, '').length < 200) throw fail('岗位描述还不完整，请提供原帖中的职责和任职要求');
  if (text.length > MAX_JD_CHARS) throw fail('正文过长，请仅保留原帖的完整职位描述');
  if (accessPage('', '', text) || /^(?:sign in|log in|welcome back|请先登录|登录后查看)/i.test(text)) throw fail('读到的是登录或验证页面，岗位描述尚未补全');
  return text;
}

// 与原 backfill-jd 共用公开接口；需要登录的平台从专用浏览器读。
export async function readPosting(url) {
  const host = new URL(url).hostname, wd = detailUrlFor(url);
  if (wd) return { text: fullJdText(detailText(await json(wd))), method: 'workday_json', url };
  const issue = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (issue) {
    const { stdout } = await execute('gh', ['api', `repos/${issue[1]}/${issue[2]}/issues/${issue[3]}`, '--jq', '.title + "\\n\\n" + .body'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return { text: fullJdText(stdout), method: 'gh', url };
  }
  if (!/(^|\.)(linkedin\.com|maimai\.cn|zhipin\.com)$/.test(host)) {
    try {
      let landed = url;
      const response = await request(url, { beforeRequest: async next => { landed = next; } }), html = await response.text();
      if (challenged(response.status, response.headers, html)) throw fail('原帖有安全验证，岗位描述尚未补全');
      const title = plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
      const text = plain(html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html);
      if (accessPage(landed, title, text)) throw fail('原帖要求登录或安全验证，请在原帖查看后粘贴完整职位描述');
      return { text: fullJdText(text), method: 'http', url: landed, title };
    } catch (e) {
      if (/challenge|验证|HTTP 4\d\d/i.test(e.message)) throw e;
      // 动态页面、空壳或网络读取失败，再读用户的专用浏览器。
    }
  }
  const page = await runBrowserScript(`
const task = await taskSpace("OfferCrew · 补全岗位描述");
const page = task.page("p1");
await page.goto(${JSON.stringify(url)});
await page.waitForLoadState("networkidle").catch(() => {}); // 兜底：原帖可能持续联网；随后仍校验最终 URL、登录验证页和完整正文，等待失败不代表补全成功。
await page.waitForTimeout(1500);
radarResult(await page.evaluate(() => ({ url: location.href, title: document.title, text: (document.querySelector("article") || document.querySelector("main") || document.body).innerText })));`, { cwd: root, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  if (!sameUrl(url, page.url) || accessPage(page.url, page.title, page.text)) throw fail('原帖未读到正文，可能需要登录或验证；可在原帖查看后粘贴完整职位描述');
  return { ...page, text: fullJdText(page.text), method: 'browser' };
}

export async function backfillJd(body = {}, { fetchPosting = readPosting, judge = null } = {}) {
  const rid = String(body.record_id || ''), action = String(body.action || 'read');
  const requestId = String(body.request_id || '');
  if (!['read', 'save'].includes(action)) throw fail('未知的正文补全方式');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw fail('缺少本次正文补全的请求编号');
  const before = find(rid);
  if (!before) throw fail('没有这条岗位', 404);
  // jd_text 由存储层懒读取：必须在网络 await 前拿到本次开始时的内容。
  const previousText = String(before.jd_text || ''), previousHash = sha(previousText);
  if (before.superseded || endedLead(before) || before.paused) throw fail('这条岗位已收起或暂停，不能补全后自动重判');
  const sourceUrl = String(before.url || before.source_url || '');
  if (!canonicalUrl(sourceUrl)) throw fail('这条岗位没有可核实的原帖链接');
  if (!sameUrl(body.source_url, sourceUrl)) throw fail('原帖链接已变化，请重新打开这条岗位', 409);
  const stable = key(before), ref = `jd-backfill:${stable}:${requestId}`, receiptPath = `runs/${today()}/jd-backfill/${sha(ref).slice(0, 24)}.json`;
  const saved = read(receiptPath, null), inputHash = sha(JSON.stringify([action, sourceUrl, action === 'save' ? String(body.text || '') : null]));
  if (saved) {
    if (saved.input_hash !== inputHash) throw fail('同一请求编号的正文不同，请重新提交', 409);
    if (saved.error) throw fail(saved.error, saved.status || 400);
    if (saved.result) return { ...saved.result, repeated: true };
  }
  if (inFlight.has(stable)) throw fail('这条岗位正在补全，请等这次完成', 409);
  inFlight.add(stable);
  let job, card;
  const at = new Date().toISOString();
  try {
    job = J.create({ kind: 'backfill-jd', member: 'scout', title: `补全 ${before.number == null ? '' : '#' + before.number + ' '}岗位描述`, target: `lead:${stable}`, origin: 'card', ref });
    card = makeCard({ kind: 'ask', title: job.title, leads: [before], owner: 'scout', how: 'op', status: 'running', links: { ledger_id: job.id } });
    saveCards([card]); J.drive(job.id, 'running', { pid: process.pid });
    const posting = action === 'save' ? { text: fullJdText(body.text), url: sourceUrl, method: 'owner_paste' } : await fetchPosting(sourceUrl);
    if (accessPage(posting.url, posting.title, posting.text)) throw fail('读到的是登录或验证页面，岗位描述尚未补全');
    const text = fullJdText(posting.text);
    if (!sameUrl(posting.url, sourceUrl)) throw fail('读到的页面不是这条岗位的原帖，未修改岗位描述');
    const contentHash = sha(text), changed = previousText.trim() !== text;
    const proof = { record_id: stable, source_url: sourceUrl, at, method: posting.method, title: posting.title || null, text, sha256: contentHash, previous_text: previousText, previous_match: before.match || null, input_hash: inputHash, task_id: card.id, job_id: job.id };
    write(receiptPath, proof);
    update(stable, l => {
      if (l.superseded || endedLead(l) || l.paused) throw fail('这条岗位刚被收起或暂停，未修改岗位描述', 409);
      if (!sameUrl(l.url || l.source_url, sourceUrl) || sha(l.jd_text || '') !== previousHash) throw fail('岗位正文刚被更新，请刷新后再补全', 409);
      l.jd_text = text;
      l.jd_source = { url: sourceUrl, at, method: posting.method, sha256: contentHash, evidence: receiptPath, request_id: requestId, task_id: card.id };
      delete l.jd_backfill_error;
      if (changed) {
        for (const k of ['match', 'judgement', 'prefilter_reason', 'matched_at', 'rejudged_at', 'needs_jd']) delete l[k];
        if ([l.match_error, l.match_error_final].includes('full_jd_missing')) {
          l.match_content_recovery = { at, previous_error: 'full_jd_missing', previous_attempts: l.match_attempts ?? null };
          for (const k of ['match_error', 'match_retry_at', 'match_error_final', 'match_error_final_at', 'match_attempts']) delete l[k];
        }
      }
    });
    let judged = null;
    if (changed && judge) {
      try { judged = await judge(stable); }
      catch (e) { judged = { error: String(e.message).slice(0, 200) }; }
    }
    const receipt = !changed ? '岗位正文与现有内容相同，没有重复判断' : judged?.error ? `岗位正文已补全；重新判断未启动：${judged.error}` : judged?.pending ? '岗位正文已补全，重新判断已排队' : judged?.started ? '岗位正文已补全，已开始重新判断' : '岗位正文已补全';
    const result = { ok: true, changed, record_id: stable, number: before.number ?? null, chars: text.length, evidence: receiptPath, task_id: card.id, job_id: job.id, judge: judged, receipt };
    write(receiptPath, { ...proof, result });
    event('scout', 'backfill-jd', 'ok', receipt, { lead_id: stable, task_id: card.id, job_id: job.id, refs: [{ file: receiptPath }] });
    J.drive(job.id, 'done', { result: { summary: receipt, links: { lead: `lead:${stable}`, evidence: receiptPath } } });
    card.status = 'done'; card.result = receipt; card.done_at = new Date().toISOString(); addStep(card, receipt, { evidence: [{ file: receiptPath }] }); saveCards([card]);
    return result;
  } catch (e) {
    const error = String(e.message).slice(0, 300);
    update(stable, l => { l.jd_backfill_error = { at: new Date().toISOString(), error, task_id: card?.id }; });
    write(receiptPath, { input_hash: inputHash, record_id: stable, source_url: sourceUrl, at, error, status: e.status || 400, task_id: card?.id, job_id: job?.id });
    event('scout', 'backfill-jd', 'fail', `岗位描述未补全：${error}`, { lead_id: stable, task_id: card?.id, job_id: job?.id, refs: [{ file: receiptPath }] });
    if (job) J.drive(job.id, 'failed', { reason: error });
    if (card) { card.status = 'stuck'; card.detail = error; addStep(card, error); saveCards([card]); }
    throw fail(error, e.status || 400);
  } finally { inFlight.delete(stable); }
}
