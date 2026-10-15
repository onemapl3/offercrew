// 「打开申请页」：在专用 Chrome 里打开这条线索的岗位页，看落在哪，照实说（lib/landing.mjs）。
// 收件箱的信（lib/ask-actions.mjs open 步骤）、「打开申请页」切不回之前那一页时（lib/application-page.mjs reopen）都走这里。
// 回执：是这个岗位 → 「已在专用 Chrome 里打开这个岗位的页面」；跳到首页 / 下线 / 别的网站 → 说是哪种，不说「已打开」，
// 有这家公司的职位列表就多给一个按钮（open）；认不出 → 说打开了链接、没认出这个岗位。结果记进 state/landing.json。
import { openForUser, inLoginBrowser } from './browser-run.mjs';
import { landingUrl, judgeLanding, landingWords, landingFailed, fallbackLinks, rememberLanding } from './landing.mjs';
import { companyConf } from './company-research.mjs';
import { companyKey } from './company-brief.mjs';
import { noteSwallowed } from './swallow.mjs';
import { rememberPostingCheck } from './posting-check.mjs';

export async function openJobPage(lead, url, { after = '', open = openForUser, now = Date.now(), account = null } = {}) {
  const fixed = landingUrl(url);
  const r = await open(fixed, { inspect: true, ...(account ? { account } : {}) });
  const where = inLoginBrowser();
  if (r?.sandbox) return { ok: true, verdict: 'sandbox', receipt: `已${where}打开这个岗位的页面${after ? `；${after}` : ''}`, open: [] };
  if (r?.navError) {
    const why = /HTTP_RESPONSE_CODE/.test(r.navError) ? '这个地址返回了错误状态' : String(r.navError).split('\n')[0].slice(0, 80);
    return { ok: true, verdict: 'error', receipt: `页面打开时网站返回了错误（${why}），页面已经交给你，可以在里面刷新`, open: [] };
  }
  const j = judgeLanding({ requested: fixed, page: r?.landed || null, lead });
  const rid = lead?.record_id || lead?.id || null;
  try { rememberLanding(rid, { verdict: j.verdict, url, opened: fixed, landed: j.landed, title: String(r?.landed?.title || '').slice(0, 120) }, now); }
  catch (e) { noteSwallowed('open-job-page.remember', e, { member: 'quill', doing: '记下申请页落在哪', then: '收件箱那封信不会说上次落在哪' }); }
  if (j.verdict === 'gone') rememberPostingCheck(rid, { ...j, url, reason: 'posting_page_closed', evidence: { url: j.landed, title: String(r?.landed?.title || '').slice(0, 120), text: String(r?.landed?.text || '').slice(0, 1000) } }, { now, source: 'open-job-page' });
  const failed = landingFailed(j);
  let conf = null;
  if (failed) { try { conf = companyConf(companyKey(lead?.company)); } catch { conf = null; } } // 兜底：公司清单读不出就不给职位列表
  return { ok: true, verdict: j.verdict, landed: j.landed, inspected: !!r?.landed, receipt: landingWords(j, { url: fixed, lead, after: failed ? '' : after, where }), open: failed ? fallbackLinks(fixed, lead, conf) : [] };
}
