import { agentPaused } from './agents.mjs';
import { uncertainDelivery } from './inbox-lifecycle.mjs';
// 发私信（命令行入口是 bin/send-dm.mjs；worker 在进程里直接调 main({ only })，lib/workers.mjs）。
import { MAIMAI_FRIEND_LIMIT } from './message-limits.mjs';
import { applyEvent, closedByUser, leadState } from './lead-state.mjs';
// Sends platform messages the user has explicitly approved.
//
// Same discipline as email: only a queued send-request whose draft still matches
// the text that was shown, one send per record per channel, and an actual
// on-page receipt before anything is recorded as sent. A message that cannot be
// confirmed is read back first; only proven absence can authorize a retry.
import { runBrowserScript } from './browser-run.mjs';
import { lines, writeLines, write, log, hash, today, root } from './store.mjs';
import { draftFingerprint } from './drafts.mjs';
import { companyPage } from './post-signals.mjs';
import { familySession, hostOf } from './accounts.mjs';
import { read } from './store.mjs';
import { THREAD_HELPERS, READ_BUTTONS, READ_PANE, READ_COMPOSER } from './platform-dm-thread.mjs';
import { platformMessageBlock } from './platform-actions.mjs';

// 平台没登录时不去碰页面：请求留在队列里、标 needs_login，收件箱把它并进这个平台的「要你登录」；
// 你登录后（收件箱「我登好了」）再发。发送途中撞上登录页也一样放回队列——那时还没输入任何文字。
// LinkedIn's security check (/checkpoint/…) stops a send the same way a login page does.
const LOGIN_WALL = /\/web\/user|passport|\/platform\/login|\/login|signin|sign-in|authwall|uas\/login|linkedin\.com\/checkpoint\//i;
export const hitLoginWall = (result) => !!result && !result.delivered && LOGIN_WALL.test(String(result.url || ''));
function markLoggedOut(host, at) {
  const sessions = read('config/portal-sessions.json', { domains: {} });
  sessions.domains = sessions.domains || {};
  const key = Object.keys(sessions.domains).find((d) => hostOf(d) === host) || host;
  sessions.domains[key] = { ...(sessions.domains[key] || {}), logged_in: false, verified_at: at, last_probe: '发送私信时遇到登录页', verified_by: 'send-dm' };
  write('config/portal-sessions.json', sessions);
}

const call = (script, { existingOnly = false } = {}) => runBrowserScript(script, { cwd: root, timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...(existingOnly ? { env: { ...process.env, RADAR_BROWSER_EXISTING_ONLY: '1' } } : {}) });

// The page script types the reviewed text and reads the thread back. It never
// composes anything: the body is passed in whole.
//
// Boss直聘 (zhipin.com) job pages open the conversation with 「立即沟通」 (first
// contact; the platform sends its own greeting) or 「继续沟通」 (existing thread),
// never a 「打招呼」 button. The chat input is a contenteditable box, so the body
// is inserted through the keyboard and read back before 「发送」. Screenshots of
// zhipin pages hang CDP (Page.captureScreenshot) and kill the browser script's process, so the
// receipt there is the thread text plus a DOM snapshot, not a PNG.
// Evidence: the probe's runs/<date>/platform-dm/<number>/probe/state.json
//
// 「立即沟通」 is itself a send: it opens a new BOSS conversation and the platform
// greets the recruiter in your name at once. This script is only ever run by main()
// below for a send-request you approved (status queued, fingerprint equal to the
// text you were shown), so the click is covered by that approval. A reply or a
// follow-up belongs in an existing thread and never clicks it.
//
// New or existing conversation is read from the opened conversation (older
// messages, the other side's messages, more than the one greeting), not from the
// label that was clicked (09-30 #430: the send stopped on 「继续沟通」 and nobody
// could tell afterwards what the page had shown). Before typing, the thread is read
// for the approved body: already there means it went out before and is not sent
// again. After 「发送」 the body must appear in the thread (outside the message
// box) one more time than before, or the result is not_in_thread.
// lib/platform-dm-thread.mjs holds the readers and the rules.
async function deliver(draft, dir, who = '', { inspect = false, context = null, verify = false } = {}) {
  const shot = `${root}/${dir}/sent.png`;
  const zhipin = /zhipin\.com/.test(draft.to);
  const threaded = ['reply', 'followup'].includes(draft.purpose);
  const openers = inspect || verify ? (zhipin ? ['text="继续沟通"'] : ['loc=role:button[name*="Message"]']) : ['text="继续沟通"', ...(zhipin && threaded ? [] : ['text="立即沟通"']), 'loc=role:button[name*="打招呼"]', 'loc=role:button[name*="Message"]'];
  const script = `
${THREAD_HELPERS}
const task = await taskSpace(${JSON.stringify('dm ' + draft.draft_id)}, {hidden:${inspect}});
const page = task.page("p1");
const body = ${JSON.stringify(draft.body)};
const who = ${JSON.stringify(who)};
const zhipin = ${zhipin};
const probe = probeOf(body);
const inspecting = ${inspect};
const verifying = ${inspect || verify};
const priorContext = ${JSON.stringify(context)};
const steps = [];
try {
const pageText = async () => page.evaluate("/*radar:text*/document.body.innerText.slice(0, 4000)");
const readPane = async () => page.evaluate(${JSON.stringify(READ_PANE.replace("/*radar:target*/''", JSON.stringify(draft.to)))}).catch(() => ({ dom: [], text: '' }));
const readComposer = async () => page.evaluate(${JSON.stringify(READ_COMPOSER)}).catch(() => ''); /* 兜底：读不到输入框里的字就当空：发之前比对、发之后回读才定发没发出，空串不会被当成发出 */
const clickFirst = async (selectors) => {
  for (const sel of selectors) {
    const ok = await page.click(sel, { timeout: 2500 }).then(() => true).catch(() => false); /* 兜底：这个选择器点不到就试下一个；都点不到 clickFirst 回 null，走「没打开对话」那条失败路 */
    if (ok) return sel;
  }
  return null;
};
const findInput = async () => {
  for (const sel of ['loc=css:#chat-input', 'loc=css:div.chat-input[contenteditable="true"]', 'loc=css:div[contenteditable="true"]', 'loc=css:textarea.chat-input', 'loc=role:textbox']) {
    const ok = await page.waitForSelector(sel, { state: 'visible', timeout: 2000 }).then(() => true).catch(() => false); /* 兜底：等不到这个输入框就试下一个；都没有 findInput 回 null，不打字、不发 */
    if (ok) return sel;
  }
  return null;
};
await page.goto(${JSON.stringify(draft.to)});
await page.waitForLoadState("domcontentloaded").catch(() => {}); /* 兜底：页面可能已经加载完了；后面按页面上读到的内容判断，不靠这一步 */
await page.waitForTimeout(3000);
const buttons = zhipin ? await page.evaluate(${JSON.stringify(READ_BUTTONS)}).catch(() => null) : null; /* 兜底：按钮读不出来就当不知道（null），只进证据，不影响判断新旧对话 */
const clickedAt = Date.now();
const opened = await clickFirst(${JSON.stringify(openers)});
await page.waitForTimeout(3000);
steps.push({ step: 'open', opened, buttons, url: await page.url(), text: (await pageText()).slice(0, 600) });
let input = await findInput();
if (!input && zhipin && !verifying) {
  // The job page did not open an inline chat: go to the BOSS conversation list and pick the thread by name.
  // Only for BOSS: a LinkedIn (or any other) draft must never be typed into a BOSS chat (09-30: the fallback went there for every platform).
  // 「继续沟通」 here is the button of the dialog BOSS shows after 「立即沟通」.
  const jumped = await clickFirst(['text="继续沟通"', 'text="去聊天"', 'text="去聊天页"', 'text="去沟通"']);
  await page.waitForTimeout(2500);
  if (!/\\/web\\/geek\\/chat/.test(await page.url())) {
    await page.goto("https://www.zhipin.com/web/geek/chat");
    await page.waitForLoadState("domcontentloaded").catch(() => {}); /* 兜底：同上：页面可能已经加载完了，后面按读到的对话判断 */
    await page.waitForTimeout(4000);
  }
  const picked = who ? await clickFirst(['text=' + who + ' >> nth=0']) : null;
  await page.waitForTimeout(2500);
  steps.push({ step: 'chat-list', jumped, picked, url: await page.url(), text: (await pageText()).slice(0, 600) });
  input = await findInput();
}
const base = { clicked_at: new Date(clickedAt).toISOString(), opened, buttons };
if (!input) {
  radarResult({ ...base, delivered: false, error: 'chat_input_not_found', steps, thread: await pageText(), url: await page.url() });
} else {
  const before = await readPane();
  const urlKey = u => String(u || '').replace(/[?#].*$/, '').replace(/\\/$/, '');
  const sameThread = zhipin ? opened === 'text="继续沟通"' : (before.peer_urls || []).some(u => urlKey(u) === urlKey(${JSON.stringify(draft.to)}));
  const evidence = sameThread ? deliveryEvidence(before, body, priorContext) : 'unknown';
  const beforeContext = deliveryContext(before);
  const verdict = zhipin ? classifyThread({ dom: before.dom, text: before.text, clickedAt, now: Date.now() }) : null;
  steps.push({ step: 'thread', verdict });
  const seenBefore = countProbe(before.text, probe) - countProbe(await readComposer(), probe);
  Object.assign(base, { verification_context: beforeContext, thread_state: verdict ? verdict.state : null, greeting: verdict ? verdict.greeting : null, conversation_url: await page.url() });
  if (verifying && (inspecting || evidence !== 'absent')) {
    radarResult({ ...base, delivered: evidence === 'found', already_in_thread: evidence === 'found', verification: evidence,
      error: evidence === 'found' ? null : 'delivery_unconfirmed', steps, thread: String(before.text).slice(0, 4000), url: await page.url() });
  } else if (!verifying && seenBefore > 0) {
    // The approved body is already in this conversation: it went out on an earlier attempt. Never send it twice.
    radarResult({ ...base, delivered: true, already_in_thread: true, readback: { before: seenBefore }, steps, thread: String(before.text).slice(0, 4000), url: await page.url() });
  } else {
    await page.click(input, { timeout: 3000 });
    await page.keyboard.insertText(body);
    await page.waitForTimeout(800);
    const typed = await page.evaluate("/*radar:typed*/(() => { const el = document.activeElement; return (el && (el.value ?? el.innerText) || '').trim(); })()");
    if (!typed.startsWith(body.slice(0, 12))) {
      radarResult({ ...base, delivered: false, error: 'input_mismatch', typed: typed.slice(0, 200), steps, thread: await pageText(), url: await page.url() });
    } else {
      const sent = await clickFirst(['loc=css:.btn-send', 'text="发送"', 'loc=role:button[name*="发送"]', 'loc=role:button[name*="Send"]']);
      if (!sent) await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      steps.push({ step: 'send', sent: sent || 'Enter' });
      let snapshot = null;
      if (zhipin) snapshot = await page.snapshot().catch(() => null); /* 兜底：截不到页面快照只是少一份证据，发没发出照回读的对话判断 */
      else await page.screenshot({ path: ${JSON.stringify(shot)}, fullPage: false }).catch(() => {}); /* 兜底：截图没截成只是少一份证据，发没发出照回读的对话判断 */
      // Read the whole page (a long thread put the message past a 4000-character cut), minus what is still in the message box.
      const after = await readPane();
      const left = countProbe(await readComposer(), probe);
      const seenAfter = countProbe(after.text, probe) - left;
      const delivered = verifying ? deliveryEvidence(after, body) === 'found' : seenAfter > seenBefore;
      let final = verdict;
      if (zhipin && verdict.state === 'unknown') final = classifyThread({ dom: after.dom, text: after.text, clickedAt, now: Date.now(), exclude: probe });
      radarResult({ ...base, thread_state: final ? final.state : null, greeting: final ? final.greeting : null, delivered, ...(delivered ? {} : { error: 'not_in_thread' }), readback: { before: seenBefore, after: seenAfter, left_in_box: left }, thread: String(after.text).slice(0, 4000), url: await page.url(), steps, snapshot: snapshot ? String(snapshot).slice(0, 6000) : null });
    }
  }
}
} finally { if (inspecting) await task.finish({keep:[]}); }`;
  return call(script, { existingOnly: inspect });
}

// Maimai's friend request is a separate assisted-browser channel. The script
// checks the profile and existing relationship before opening the dialog, never
// touches the SMS option, and returns only the visible receipt needed by the
// state writer below.
export async function deliverMaimaiFriend(draft, dir) {
  if ([...String(draft.body || "")].length > MAIMAI_FRIEND_LIMIT) throw Error("maimai_note_too_long");
  const shot = `${root}/${dir}/sent.png`;
  const script = `
const task = await taskSpace(${JSON.stringify('maimai friend ' + draft.draft_id)});
const page = task.page("p1");
await page.goto(${JSON.stringify(draft.to)});
await page.waitForLoadState("networkidle").catch(() => {}); /* 兜底：网络一直不静下来也照样往下读页面；后面按页面文字判断能不能加好友 */
await page.waitForTimeout(4000);
const initial = await page.evaluate("({text: document.body.innerText, url: location.href})");
if (/加载失败|403/.test(initial.text)) {
  radarResult({ error: "profile_unavailable", thread: initial.text.slice(0, 2000), url: initial.url });
} else if (/已申请|等待验证|已是好友|已经是好友|已发送好友申请/.test(initial.text)) {
  radarResult({ error: "already_requested", thread: initial.text.slice(0, 2000), url: initial.url });
} else {
  const clicked = await page.click('div.btn:has-text("加好友")').then(() => true).catch(() => false); /* 兜底：点不到「加好友」就是没打开，下面按 dialog_not_opened 失败记下 */
  const opened = clicked && await page.waitForURL(/\\/user_conf\\/add_friend_tag_list(?:[?#]|$)/, { timeout: 8000 }).then(() => true).catch(() => false); /* 兜底：等不到加好友的对话框就是没打开，下面按 dialog_not_opened 失败记下 */
  const dialogUrl = await page.url();
  if (!opened || !/\\/user_conf\\/add_friend_tag_list/.test(dialogUrl)) {
    radarResult({ error: "dialog_not_opened", thread: (await page.evaluate("document.body.innerText.slice(0, 2000)")), url: dialogUrl });
  } else {
    const textarea = "loc=css:textarea[placeholder*=\\"加好友的原因\\"]";
    await page.fill(textarea, "");
    await page.fill(textarea, ${JSON.stringify(draft.body)});
    const value = await page.evaluate("[...document.querySelectorAll('textarea')].find(el => (el.getAttribute('placeholder') || '').includes('加好友的原因'))?.value || ''");
    if (value !== ${JSON.stringify(draft.body)}) throw new Error("textarea_mismatch");
    const smsSelected = await page.evaluate("(() => { const el = [...document.querySelectorAll('input[type=checkbox], [role=checkbox], [role=switch]')].find(el => ([...(el.labels || [])].map(label => label.innerText).join(' ') + (el.getAttribute('aria-label') || '') + (el.parentElement?.innerText || el.innerText || '')).includes('同时通过短信发送')); return el ? !!(el.checked || el.getAttribute('aria-checked') === 'true') : false; })()");
    if (smsSelected) throw new Error("sms_option_selected");
    await page.click('text="发送"');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: ${JSON.stringify(shot)}, fullPage: false });
    const text = await page.evaluate("document.body.innerText");
    const thread = text.slice(0, 2000);
    const url = await page.url();
    radarResult({ delivered: !/\\/user_conf\\/add_friend_tag_list/.test(url) || /已发送|等待|已申请/.test(text), thread, url });
  }
}`;
  const result = await call(script);
  if (result?.error || !result?.delivered) {
    throw Object.assign(new Error(result?.error || 'delivery_unconfirmed'), { receipt: result });
  }
  return result;
}

// 批准了却没发出去：自动再派给下一轮，最多 2 次。
export const MAX_AUTO_RETRIES = 2;
const UNSENT = {
  not_in_thread: '点了发送，但对话里没看到这段正文',
  input_mismatch: '输入框里的字和批准的正文对不上，没有点发送',
  chat_input_not_found: '打开对话后找不到输入框，正文没有发出',
};
function unsentReason(code) {
  const key = String(code || '').split(':')[0];
  return { code: key || 'delivery_unconfirmed', text: UNSENT[key] || `发送过程出错（${String(code || '').slice(0, 60)}），没有确认发出` };
}
function retryOrReview(r, why, errors, verified = false) {
  if (!verified && !['input_mismatch', 'chat_input_not_found'].includes(why.code)) {
    Object.assign(r, { status: 'uncertain', reason: why.code, uncertain_at: new Date().toISOString(), result: `${why.text}；正在自动核对原对话，核实前不会再发` });
    errors.push(`dm_unconfirmed:${r.draft_id}:${why.code}`); return;
  }
  if (r.retry_disabled) {
    Object.assign(r,{status:'cancelled',reason:'owner_control',result:'没有发出；你已经接管或结束这项任务，不再重发'}); return;
  }
  if (verified) delete r.last_error;
  const done = r.auto_retries || 0;
  if (done < MAX_AUTO_RETRIES) {
    Object.assign(r, { status: 'queued', auto_retries: done + 1, retry_reason: verified ? 'verified_absent' : why.code, retried_at: new Date().toISOString(),
      result: `${why.text}；下一轮自动再发（第 ${done + 1} 次重发，最多 ${MAX_AUTO_RETRIES} 次），发之前先读对话，正文已经在就不再发` });
    delete r.reason; delete r.last_error;
    delete r.dispatched_at;
    errors.push(`dm_retry:${r.draft_id}:${why.code}`);
  } else {
    Object.assign(r, { status: 'needs_review', reason: verified ? 'verified_absent' : why.code, checked_at: new Date().toISOString(),
      result: `自动重发 ${MAX_AUTO_RETRIES} 次后仍没发出去：${why.text}。请到对话里看一眼，再决定要不要重发` });
    errors.push(`${why.code}:${r.draft_id}`);
  }
}

// Where the conversation is: BOSS's chat page has no per-thread URL, so the id is the recruiter and the job.
function conversationOf(d, who, result) {
  return { id: hash(['zhipin', who, d.to]).slice(0, 16), with: who || null, job_url: d.to, url: result?.conversation_url || result?.url || null };
}
// The greeting BOSS sent in your name when 「立即沟通」 opened the conversation. It is not the draft:
// draft_id stays empty, so it never counts as this draft sent.
function recordGreeting(outbound, { r, d, channel, dir, who, result }) {
  if (outbound.some((o) => o.record_id === r.record_id && o.channel === channel && o.kind === 'platform_greeting')) return;
  const text = String(result.greeting?.text || '');
  outbound.push({ id: hash([channel, r.record_id, 'platform_greeting']).slice(0, 32), record_id: r.record_id, number: d.number, channel, platform: d.platform,
    kind: 'platform_greeting', auto: true, draft_id: null, for_draft: d.draft_id, to: d.to, subject: 'BOSS 平台自动招呼语', body_preview: text.slice(0, 200),
    at: result.clicked_at || new Date().toISOString(), shown_time: result.greeting?.time || null, conversation: conversationOf(d, who, result), readback: 'thread', evidence: dir });
}

// 三段（和内置邮箱 lib/mail/send.mjs 一样，02a 第四节第 1 条）：拿锁挑出要发的、记成发送中 → 不占锁开浏览器发、回读 → 拿锁写回。
// 开浏览器最长 3 分钟，这段时间工作台、收件箱、别的成员照常读写，不再被一把全局锁挡住。
// only：只发这几条发送请求（lib/workers.mjs 从 actions 领走的那几条）；不给就发队列里所有已批准的（周期里那一步）。
// 发送中（dispatched）对账：进程中断先自动读原对话；证明没发出才可重试，读不清再请用户核实。
export const STALE_DISPATCH_MS = 10 * 60000;
const channels = new Set(['platform_dm', 'maimai_friend_request']);
function pick({ only, now }) {
  const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), outbound = lines('state/outbound.ndjson'), leads = lines('state/leads.ndjson');
  const errors = [], go = [];
  for (const r of requests.filter((r) => r.status === 'dispatched' && channels.has(r.channel) && (!only || only.includes(r.id)))) {
    if (Date.parse(r.dispatched_at || 0) > now - STALE_DISPATCH_MS && !only) continue;
    Object.assign(r, { status: 'uncertain', reason: 'dispatch_unconfirmed', uncertain_at: new Date(now).toISOString(), result: '发送中断了，结果尚未核实；请先查看原对话，确认前不会再发' }); errors.push('dm_unconfirmed:' + r.draft_id);
  }
  for (const r of requests.filter((r) => r.status === 'queued' && channels.has(r.channel) && (!only || only.includes(r.id)))) {
    if (r.retry_disabled) { Object.assign(r,{status:'cancelled',reason:'owner_control'}); continue; }
    const channel = r.channel;
    const d = drafts.find((x) => x.draft_id === r.draft_id);
    if (d && uncertainDelivery(d, requests)) { Object.assign(r, { status: 'uncertain', reason: r.retry_reason || r.reason || 'delivery_unconfirmed' }); continue; }
    // 平台替你发的招呼语（kind: platform_greeting，draft_id 为空）不算任何一份草稿发过（09-30 #430）。
    const prior = outbound.filter((o) => o.record_id === r.record_id && o.channel === channel && o.kind !== 'platform_greeting');
    // 首联：这个渠道联系过就不再发第二次。回复 / 跟进只有这一份草稿自己有回执才算发过。
    const threaded = ['reply', 'followup'].includes(r.purpose);
    if ((!threaded && prior.length) || prior.some((o) => o.draft_id === r.draft_id)) { r.status = 'sent'; continue; }
    // 批准之后你 pass 或归档了这条线索：不再发。
    if (closedByUser(leads.find((l) => (l.record_id || l.id) === r.record_id))) { Object.assign(r, { status: 'cancelled', reason: 'lead_closed', cancelled_at: new Date(now).toISOString() }); continue; }
    if (!d || d.channel !== channel || d.record_id !== r.record_id || d.status !== 'ready' || draftFingerprint(d) !== r.fingerprint || !d.notified_at || d.displayed_hash !== r.fingerprint) {
      r.status = 'needs_review'; errors.push('draft_changed:' + r.draft_id); continue;
    }
    const unsupported = platformMessageBlock(d);
    if (unsupported) {
      Object.assign(r, { status: 'needs_review', reason: unsupported.gate, result: `${unsupported.reason}；请打开脉脉聊天手动处理。` });
      errors.push(`${unsupported.gate}:${r.draft_id}`); continue;
    }
    // 老的草稿可能超过平台字数：不截断、不发，改了要重新批准。
    if (channel === 'maimai_friend_request' && [...String(d.body || '')].length > MAIMAI_FRIEND_LIMIT) {
      Object.assign(r, { status: 'needs_review', reason: 'maimai_note_too_long', result: `脉脉加好友附言最多 ${MAIMAI_FRIEND_LIMIT} 字；请缩短草稿，重新展示并批准后发送。` });
      errors.push('maimai_note_too_long:' + r.draft_id); continue;
    }
    // LinkedIn 公司主页不是人：页面开了「Message」也只进页面的收件箱，不知道谁看。不发，草稿收回（lib/post-signals.mjs companyPage）。
    if (channel === 'platform_dm' && companyPage(d.to)) {
      Object.assign(r, { status: 'cancelled', reason: 'company_page', cancelled_at: new Date(now).toISOString(), result: '收件人是 LinkedIn 公司主页，不是招人的那个人，没有发' });
      Object.assign(d, { status: 'cancelled', cancelled_at: new Date(now).toISOString(), cancelled_reason: 'company_page' });
      delete d.displayed_hash;
      errors.push('company_page:' + r.draft_id); continue;
    }
    const host = hostOf(d.to), session = familySession(host, read('config/portal-sessions.json', { domains: {} }));
    if (session && session.logged_in === false) {
      if (r.blocked !== 'needs_login') Object.assign(r, { blocked: 'needs_login', blocked_at: new Date(now).toISOString() });
      errors.push('needs_login:' + r.draft_id + ':' + host); continue;
    }
    delete r.blocked; delete r.blocked_at; delete r.delivery_check;
    Object.assign(r, { status: 'dispatched', dispatched_at: new Date(now).toISOString(), dispatched_pid: process.pid });
    const lead = leads.find((l) => l.record_id === r.record_id || l.id === r.record_id);
    go.push({ r: { ...r }, d: { ...d }, author: lead?.author || '', host });
  }
  writeLines('state/send-requests.ndjson', requests);
  if (errors.some((e) => e.startsWith('company_page:'))) writeLines('state/drafts.ndjson', drafts);
  return { go, errors };
}
// 写回：重读四个文件，按这一条的结果改（发浏览器的那几分钟里别人可能改过它们）。
function writeBack(p, outcome) {
  const requests = lines('state/send-requests.ndjson'), drafts = lines('state/drafts.ndjson'), outbound = lines('state/outbound.ndjson'), leads = lines('state/leads.ndjson');
  const r = requests.find((x) => x.id === p.r.id), d = drafts.find((x) => x.draft_id === p.d.draft_id);
  if (!r) return null;
  const out = outcome({ r, d: d || p.d, drafts, outbound, leads });
  writeLines('state/send-requests.ndjson', requests);
  writeLines('state/drafts.ndjson', drafts);
  writeLines('state/outbound.ndjson', outbound);
  writeLines('state/leads.ndjson', leads);
  return out;
}

// 对账只读，不发送。一次核对仍 unknown 就交给本人，不因后台 tick、重启或超时再打开原页面。
// 动作引擎和旧队列共用；确证没发出的新尝试仍由 worker 的发送闸决定能不能重试。
const CHECK_INTERVAL = 10 * 60000;
export async function reconcileDelivery(id, { now = Date.now() } = {}) {
  const requests = lines('state/send-requests.ndjson'), r = requests.find(x => x.id === id);
  const d = lines('state/drafts.ndjson').find(x => x.draft_id === r?.draft_id);
  if (!r || !d || r.channel !== 'platform_dm' || (uncertainDelivery(d, requests)?.id !== r.id && r.status !== 'dispatched')) return r;
  if (requests.findLast(x => x.draft_id === d.draft_id)?.id !== r.id) return r;
  if (r.delivery_check?.outcome === 'unknown') return r;
  // 没有原版正文/批准的旧记录不能拿改后的草稿去“证明”上次没发。
  if (['sent','cancelled'].includes(d.status) || agentPaused('quill')) return r;
  const unsupported = platformMessageBlock(d);
  if (unsupported) {
    // 只为确有发送尝试的历史请求提供人工核实，不补造发送回执，也不重试。
    r.status = 'uncertain';
    r.delivery_check = { at: new Date(now).toISOString(), outcome: 'unknown', reason: unsupported.reason };
    r.result = `${unsupported.reason}；上次发送结果仍需你打开原对话核实。`;
    writeLines('state/send-requests.ndjson', requests); return r;
  }
  if (draftFingerprint(d) !== r.fingerprint) {
    r.delivery_check = { at:new Date(now).toISOString(), outcome:'unknown', reason:'批准时的正文版本无法核对' };
    r.result='批准时的正文版本无法核对，不能拿现在的草稿判定上次没发出；请查看原对话';
    writeLines('state/send-requests.ndjson',requests); return r;
  }
  if (r.delivery_check && now - Date.parse(r.delivery_check.at) < CHECK_INTERVAL) return r;
  const attempt = r.dispatched_at, fingerprint = r.fingerprint;
  const at = new Date(now).toISOString();
  r.status = 'uncertain'; r.delivery_check = { at, outcome: 'checking' };
  writeLines('state/send-requests.ndjson', requests);
  const who = lines('state/leads.ndjson').find(l => (l.record_id || l.id) === r.record_id)?.author || '';
  const dir = `runs/${today()}/platform-dm/verify-${hash([r.id, at]).slice(0, 16)}`;
  let result, error;
  try {
    result = await deliver(d, dir, who, { inspect: true, context: r.verification_context });
    write(`${dir}/thread.json`, result);
  } catch (e) { error = String(e.message || e).slice(0, 160); }
  writeBack({ r, d }, ({ r: current, d: draft, outbound, leads }) => {
    // 浏览器读取期间用户可能核实、取消、改稿；迟到的核对不能覆盖新决定。
    if (current.status !== 'uncertain' || current.dispatched_at !== attempt || current.fingerprint !== fingerprint || draftFingerprint(draft) !== fingerprint) return;
    const outcome = result?.verification || 'unknown';
    current.delivery_check = { at, outcome, evidence: dir, ...(error ? { error } : {}) };
    if (outcome === 'found') {
      if (!outbound.some(o => o.draft_id === d.draft_id && o.kind !== 'platform_greeting')) outbound.push({
        id: hash([r.channel, r.record_id, d.draft_id]).slice(0,32), record_id:r.record_id, number:d.number, channel:r.channel,
        draft_id:d.draft_id, to:d.to, subject:d.subject, body_preview:String(d.body || '').slice(0,200), at, evidence:dir,
        readback:'already_in_thread', conversation:conversationOf(d,who,result),
      });
      current.status='sent'; delete current.result; delete current.retry_reason;
      draft.status='sent'; draft.sent_at=at;
      const lead=leads.find(l=>(l.record_id || l.id)===r.record_id);
      if (lead && !closedByUser(lead) && !lead.replied_at && !lead.interview_at && !['offer','rejected','archived'].includes(leadState(lead))) applyEvent(lead,'sent',{}, {at,source:'send-dm-verification'});
    } else if (outcome === 'absent') {
      current.requires_verification = true;
      retryOrReview(current, {code:'verified_absent',text:'已读到原对话最新消息，核实这段正文没有发出'}, [], true);
    } else {
      current.result='自动核对没能确认原对话里的发送结果；请打开原对话核实，确认前不会再发';
    }
  });
  return lines('state/send-requests.ndjson').find(x => x.id === id);
}
async function reconcilePending({ only, now }) {
  const found = [];
  for (const r of lines('state/send-requests.ndjson')) {
    if ((!only || only.includes(r.id)) && ['uncertain','queued','failed','needs_review'].includes(r.status)) {
      const checked = await reconcileDelivery(r.id, { now });
      if (checked?.status === 'sent') found.push(checked);
    }
  }
  return found;
}

export async function main({ only = null, now = () => Date.now() } = {}) {
  const errors = [], sent = [];
  for (const r of await reconcilePending({ only, now: now() })) {
    sent.push({record_id:r.record_id, draft_id:r.draft_id, already_in_thread:true, evidence:r.delivery_check?.evidence});
    for (let i=errors.length-1;i>=0;i--) if (errors[i].includes(':' + r.draft_id)) errors.splice(i,1);
  }
  // 1. 拿锁挑出要发的（只在读写数据的那一下拿）。
  let picked;
  picked = pick({ only, now: now() });
  errors.push(...picked.errors);
  for (const p of picked.go) {
    const { d, host } = p, channel = p.r.channel;
    const dir = `runs/${today()}/${channel === 'maimai_friend_request' ? 'maimai-friend' : 'platform-dm'}/${d.number || String(p.r.record_id).slice(-6)}`;
    // 2. 不占锁：开浏览器发、回读对话。
    let result = null, failure = null;
    try {
      write(`${dir}/approved.json`, { request: p.r, draft: d });
      try { result = channel === 'maimai_friend_request' ? await deliverMaimaiFriend(d, dir) : await deliver(d, dir, p.author, { verify: !!p.r.requires_verification, context: p.r.verification_context }); }
      catch (e) { if (hitLoginWall(e.receipt)) result = e.receipt; else throw e; }
      write(`${dir}/thread.json`, result);
    } catch (e) { failure = e; if (e.receipt) write(`${dir}/thread.json`, e.receipt); }
    // 3. 写回。
    writeBack(p, ({ r, d, outbound, leads }) => {
      delete r.dispatched_pid;
      if (result?.verification_context) r.verification_context = result.verification_context;
      if (!failure && hitLoginWall(result)) {
        const at = new Date().toISOString();
        Object.assign(r, { status: 'queued', blocked: 'needs_login', blocked_at: at });
        delete r.dispatched_at;
        markLoggedOut(host, at);
        errors.push('login_wall:' + r.draft_id + ':' + host);
        return;
      }
      const boss = /zhipin\.com/.test(String(d.to || ''));
      const lead = leads.find((l) => l.record_id === r.record_id || l.id === r.record_id);
      if (!failure && boss && result?.thread_state === 'new' && result.greeting) recordGreeting(outbound, { r, d, channel, dir, who: lead?.author || '', result });
      if (!failure && result?.error === 'chat_input_not_found' && !boss) {
        r.status = 'needs_review'; r.reason = 'no_message_box';
        d.status = 'paused';
        d.pause_reason = `${d.platform || '这个平台'}上打不开和对方的消息框（多半是还没建立联系，或者要付费私信），这条没有发出；请你在页面上自己发，或者换一个联系方式`;
        errors.push('no_message_box:' + r.draft_id);
        return;
      }
      if (!failure && result?.delivered) {
        const at = new Date().toISOString();
        outbound.push({ id: hash([channel, r.record_id, d.draft_id]).slice(0, 32), record_id: r.record_id, number: d.number, channel, platform: d.platform, draft_id: d.draft_id, to: d.to, subject: d.subject || String(d.body || '').split(/\r?\n/)[0].slice(0, 60), body_preview: String(d.body || '').slice(0, 200), at, evidence: dir, ...(channel === 'platform_dm' ? { readback: result.already_in_thread ? 'already_in_thread' : 'found_in_thread' } : {}), ...(boss ? { thread: result.thread_state || 'unknown', conversation: conversationOf(d, lead?.author || '', result) } : {}) });
        d.status = 'sent'; d.sent_at = at;
        r.status = 'sent'; delete r.result; delete r.retry_reason;
        if (lead && !lead.replied_at && !lead.interview_at && !['offer', 'rejected', 'archived'].includes(leadState(lead))) applyEvent(lead, 'sent', {}, { at, source: 'send-dm' });
        sent.push({ record_id: r.record_id, number: d.number, platform: d.platform, channel, evidence: dir, ...(result.already_in_thread ? { already_in_thread: true } : {}) });
        return;
      }
      const e = failure || Object.assign(Error(result?.error || 'delivery_unconfirmed'), { receipt: result });
      // 确定没点发送的输入问题可重试；未知结果先落账，再走下面的只读核对。
      if (channel === 'platform_dm') retryOrReview(r, unsentReason(p.r.requires_verification ? 'delivery_unconfirmed' : (e.receipt?.error || e.message)), errors);
      // 脉脉发到一半没确认：留在发送中，对账时记成要复核（回读不了，不重发）。
      else errors.push('dm_unconfirmed:' + r.draft_id + ':' + String(e.message).slice(0, 120));
    });
  }
  for (const r of await reconcilePending({ only, now: now() })) {
    sent.push({record_id:r.record_id, draft_id:r.draft_id, already_in_thread:true, evidence:r.delivery_check?.evidence});
    for (let i=errors.length-1;i>=0;i--) if (errors[i].includes(':' + r.draft_id)) errors.splice(i,1);
  }
  console.log(JSON.stringify(log('send-dm', { status: errors.length ? 'degraded' : sent.length ? 'sent' : 'no_change', sent: sent.length, errors, details: sent })));
  return { sent, errors };
}

