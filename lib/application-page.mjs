import fs from 'node:fs';
import path from 'node:path';
import { file, lines, read, write } from './store.mjs';
import { applyUrl } from './apply-channel.mjs';
import { executeClosedInput, runBrowserScript, browserEngine, openForUser } from './browser-run.mjs';
import { activateHost, liveHost, readState, alive, onHostStarted } from './browser-host.mjs';
import { getJson } from './cdp.mjs';
import { event } from './events.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';
import { openJobPage } from './open-job-page.mjs';

// Focus only the workspace/tab belonging to this application. Never navigate or
// create a replacement: doing so would discard unsaved application fields.
// browser：页面在专用 Chrome 里（旧记录里的 'ego' 已经切不过去）。找不到的那几种（reason）由 showApplicationPage 退一步处理，回执不给人看。
export function applicationPageScript({ number, company, saved = null, expectedHost = null, browser = 'chrome' }) {
  const W = browser === 'chrome' ? { space: '投递窗口', where: '专用 Chrome 里之前填好的那一页' } : { space: '投递页', where: '之前填好的那一页' };
  return `
const saved = ${JSON.stringify(saved)};
const expectedHost = ${JSON.stringify(expectedHost)};
const expected = ${JSON.stringify(`auto-apply ${company} #${number}`)};
const marker = ${JSON.stringify(`#${number}`)};
const spaces = await listTaskSpaces();
const matches = saved?.spaceId != null ? spaces.filter(s => s.id === saved.spaceId) : spaces.filter(s => s.name === expected || (String(s.name).includes(marker) && !/\\d/.test(String(s.name).split(marker)[1]?.[0] || '')));
if (!matches.length) { radarResult({ok:false, reason:'closed', receipt:'没有找到这条投递保留的${W.space}，可能尚未创建或已经关闭；没有重开链接。'}); }
else if (matches.length !== 1) { radarResult({ok:false, reason:'ambiguous', receipt:'存在多个同编号的${W.space}，无法确定哪个是当前投递页；没有切换或重开页面。'}); }
else {
  let task = await taskSpace(matches[0].id);
  if (task.ownership && task.ownership !== 'agent') task = await takeOverTaskSpace(task.spaceId);
  try {
    const tabs = await task.tabs();
    const tab = saved?.targetId ? tabs.find(t => t.targetId === saved.targetId) : saved?.page ? tabs.find(t => t.label === saved.page) : tabs.find(t => t.active) || (tabs.length === 1 ? tabs[0] : tabs.find(t => t.label === 'p1'));
    if (!tab) radarResult({ok:false, reason:'closed', receipt:'原投递标签页已经关闭；工作区仍在，没有重开链接。'});
    else if (expectedHost && (() => { try { return new URL(tab.url).hostname !== expectedHost; } catch { return true; } })()) radarResult({ok:false, reason:'reused', receipt:'原工作区的标签页已切到其他网站，没有切换页面或重新打开链接。'}); // 兜底：地址解析不了就当已经切到别的网站，不去动它
    else {
      await tab.page.cdp('Page.bringToFront');
      radarResult({ok:true, spaceId:task.spaceId, page:tab.label || null, targetId:tab.targetId, receipt:'已切到${W.where}，保留当前页面和填写内容。'});
    }
  } finally { await task.handOff(); }
}`;
}

export function legacyApplicationPage(lead) {
  const ref = lead.auto_apply?.evidence;
  if (typeof ref !== 'string' || !ref.startsWith('runs/') || !/\.(txt|md)$/.test(ref)) return null;
  let fd;
  try {
    const target = fs.realpathSync(file(ref)), root = fs.realpathSync(file('runs')) + path.sep;
    if (!target.startsWith(root)) return null;
    fd = fs.openSync(target, 'r'); const buffer = Buffer.alloc(2048);
    const header = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n')[0];
    const match = header.match(/^\[(p\d+) [^\n]+?\| space "[^"]+"\((\d+)\)/);
    return match ? {browser:'ego',spaceId:Number(match[2]),page:match[1]} : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); } // 兜底：日志不在或读不出就没有可复用的工作区
}

// 「打开申请页」（收件箱、任务卡、对话）：之前填好的那一页还在就切过去；不在了（关了、找不到、是旧版在 ego 里留的而现在用专用 Chrome）
// 就在浏览器里直接打开申请地址，说一句，记下这一页没了（收件箱那封信多一个「重新预填」，lib/asks.mjs）。线 R 10-04（#482）。
// 回执里不说「没交上去」（这一步只是打开页面），也不露「工作区」这类内部说法。
export const REOPENED = '之前填好的那一页已经关了，重新打开了申请页；要的话可以让系统重新预填';
export const SWITCHED = '已切到之前填好的那一页';
// 这条投递保留的那一页没了（打开申请页时发现的）：收件箱照它给「重新预填」。重新预填以后页面记录换新，这一条就没了。
export const pageGone = rid => !!read('state/application-pages.json', {})[rid]?.gone;
// 预填好的那一页为什么没了（一句话，放在括号里用）：旧版在 ego 里填的（ego 停用了）、系统自带的浏览器（填完就关）、
// 专用 Chrome 里那一页后来关了（打开申请页时发现的）。那一页还在、沙盒演示，是 null。收件箱那封信、投递卡的步骤用同一句（负责人 10-05 #482）。
export function lostPage(l) {
  const rid = l?.record_id || l?.id, b = l?.auto_apply?.prefill?.browser || null;
  if (b === 'dry') return null;
  if (b === 'ego') return '旧版用的浏览器停用了';
  if (b && b !== 'chrome') return '系统自带的浏览器填完就关了';
  const gone = rid ? read('state/application-pages.json', {})[rid] : null;
  return gone?.gone ? gone.why || (b ? '专用 Chrome 里那一页关了' : '那一页关了') : null;
}

// ── 预填好的那一页还在不在（负责人 10-05 O3）──────────────────────────────────────────────
// 以前要你点一下「打开申请页」才发现那一页没了；App 重启、专用 Chrome 重开以后一直写「能填的已经预填好了」。
// 现在工作台启动时、专用 Chrome 重开时（lib/browser-host.mjs ensureHost）各核对一遍：停在提交前（预填好 / 等终审）、页面在专用 Chrome
// 里的那几条，按下面的顺序认：
//   专用 Chrome 没在跑（进程都不在）                 → 那一页没了（专用 Chrome 关过了）；
//   专用 Chrome 是预填以后才起来的（started_at 更晚）→ 那一页没了（专用 Chrome 重开过）；
//   登记的那几个标签页一个都不在了                  → 那一页没了（专用 Chrome 里那一页关了）；
//   别的（连不上、没登记标签页）                    → 不下结论，照旧。
// 没了的记进 state/application-pages.json（gone + why），收件箱那封信就改口、给「重新预填」（lib/asks.mjs prefilledAsk），
// 等你的那件活换成同一句，运行日志记一行。只读本机的 Chrome 状态和标签页列表，不打开、不切换任何页面。
const KEPT = new Set(['prepared_for_user', 'awaiting_final_review']);
const keptAt = a => Date.parse((a.status === 'awaiting_final_review' ? a.final_review?.at : a.prefill?.at) || a.at || '') || 0;
const keptSpace = a => (a.status === 'awaiting_final_review' ? a.final_review?.space : a.prefill?.space) ?? null;
const inChrome = a => a.status === 'awaiting_final_review' ? !a.final_review?.dry : (a.prefill?.browser || 'chrome') === 'chrome';
async function pageTargets(st) {
  const list = await getJson(st.port, '/json/list', { timeout: 3000 });
  return new Set((Array.isArray(list) ? list : []).filter(t => t.type === 'page').map(t => t.id));
}
// 专用 Chrome 重开时核对一遍（工作台启动时 bin/serve.mjs 也核对一遍）。
onHostStarted(() => checkKeptPages({ from: 'chrome_restart' }));
export async function checkKeptPages({ now = Date.now(), host = liveHost, state = readState, targets = pageTargets, isAlive = alive, leads = null, from = 'startup' } = {}) {
  if (sandboxed()) return { checked: 0, gone: [] };
  const ls = (leads || lines('state/leads.ndjson')).filter(l => !l.superseded && KEPT.has(l.auto_apply?.status) && inChrome(l.auto_apply));
  const pages = read('state/application-pages.json', {});
  const todo = ls.filter(l => !pages[l.record_id || l.id]?.gone);
  if (!todo.length) return { checked: 0, gone: [] };
  let st = null, live = null;
  try { st = await host(); } catch (e) { console.error(`[application-page] 核对预填页时连专用 Chrome 出错，这次不下结论：${String(e.message || e).slice(0, 120)}`); return { checked: 0, gone: [] }; }
  if (st) { try { live = await targets(st); } catch (e) { console.error(`[application-page] 读专用 Chrome 的标签页没成，只按启动时间核对：${String(e.message || e).slice(0, 120)}`); } }
  else { const s0 = state(); if (s0?.pid && isAlive(s0.pid)) return { checked: 0, gone: [] }; } // 进程还在、只是这一下没连上：不下结论
  const spaces = read('state/browser-spaces.json', {}).spaces || {}, started = Date.parse(st?.started_at || '') || 0, gone = [];
  for (const l of todo) {
    const rid = l.record_id || l.id, a = l.auto_apply, saved = pages[rid] || {};
    const space = saved.spaceId ?? keptSpace(a);
    const ids = [saved.targetId, ...Object.values(spaces[String(space)]?.pages || {})].filter(Boolean);
    const why = !st ? '专用 Chrome 关过了' : started && keptAt(a) && started > keptAt(a) ? '专用 Chrome 重开过' : live && ids.length && !ids.some(id => live.has(id)) ? '专用 Chrome 里那一页关了' : null;
    if (!why) continue;
    pages[rid] = { ...saved, gone: true, why, browser: 'chrome', url: a.prefill?.url || a.final_review?.url || a.url || applyUrl(l) || null, checked_from: from, at: new Date(now).toISOString() };
    gone.push({ rid, number: l.number ?? null, company: l.company || '', why });
  }
  if (!gone.length) return { checked: todo.length, gone };
  write('state/application-pages.json', pages);
  const J = await import('./jobs.mjs');
  for (const g of gone) {
    const text = `#${g.number ?? ''} ${g.company} 预填好的那一页没了（${g.why}），收件箱里可以重新预填`.trim();
    try { event('quill', 'apply-page', 'skip', text, { text, lead_id: g.rid }); } catch (e) { console.error(`[application-page] 运行日志没记上：${e.message}`); }
    // 等你的那件活（预填做完、停在提交前）换成同一句：卡上、任务页不再写「预填好了」。
    try {
      const j = J.latest({ target: `lead:${g.rid}`, kind: ['prefill', 'submit'], state: 'waiting_you' });
      if (j) J.drive(j.id, 'waiting_you', { reason: `之前预填好的那一页没了（${g.why}），可以重新预填`, what: { label: '重新预填', ask_id: `prefilled:${g.rid}` }, now });
    } catch (e) { console.error(`[application-page] #${g.number ?? ''} 那件活的说法没换（收件箱已改口）：${e.message}`); }
  }
  return { checked: todo.length, gone };
}
async function remember(rid, entry) {
  { const pages = read('state/application-pages.json', {}); pages[rid] = { ...entry, at: new Date().toISOString() }; write('state/application-pages.json', pages); }
}
export async function showApplicationPage(id, { run = runBrowserScript, activate = executeClosedInput, raise = activateHost, open = openForUser, engine = browserEngine() } = {}) {
  const lead = lines('state/leads.ndjson').find(l => (l.record_id || l.id) === id || String(l.number) === String(id));
  if (!lead) throw Error('线索不存在');
  const rid = lead.record_id || lead.id, url = applyUrl(lead) || lead.auto_apply?.url || null;
  // 退一步：在浏览器里直接打开申请地址（openForUser：App 里是专用 Chrome），记下那一页没了。
  const reopen = async () => {
    if (!url) throw Error('这条投递没有申请页地址，打不开');
    if (sandboxed()) { sandboxSkip(`打开 #${lead.number ?? ''} ${lead.company || ''} 的申请页`, { actor: 'user', lead_id: rid }); return { ok: true, sandbox: true, reopened: true, receipt: REOPENED }; }
    // 打开以后看落在哪（lib/open-job-page.mjs）：跳到首页、下线了、认不出，就照实说，不说「重新打开了申请页」。
    const j = await openJobPage(lead, url, { open: (u, o) => open(u, { ...o, engine }) });
    await remember(rid, { gone: true, browser: engine, url });
    const plain = j.verdict === 'job' || j.verdict === 'sandbox' || (j.verdict === 'unclear' && !j.inspected);
    return { ok: true, reopened: true, verdict: j.verdict, ...(j.open?.length ? { open: j.open } : {}), receipt: j.verdict === 'error' ? `${REOPENED}（网站这次返回了错误，可以在页面里刷新）` : plain ? REOPENED : `之前填好的那一页已经关了。${j.receipt}` };
  };
  // 本机 AI、内置操作员留的页（2026-09-28 以前）：现在找不回那个窗口，直接打开申请页。
  if (['chrome', 'operator', 'ego-operator'].includes(lead.computer_use?.browser)) return reopen();
  const saved = read('state/application-pages.json', {})[rid] || lead.auto_apply?.browser_page || legacyApplicationPage(lead);
  if (saved?.gone) return reopen();
  // 页面在哪个浏览器：只认专用 Chrome；旧版在 ego 里留的页切不过去，直接打开申请页。
  const browser = !saved?.browser || saved.browser === 'chrome' ? 'chrome' : null;
  if (!browser) return reopen();
  // 演示 / 沙盒模式：不碰浏览器，照常回"已切到"（lib/sandbox.mjs）。
  if (sandboxed()) { sandboxSkip(`切到 #${lead.number ?? ''} ${lead.company || ''} 保留的投递页（专用 Chrome）`, { actor: 'user', lead_id: rid }); return { ok: true, sandbox: true, receipt: SWITCHED }; }
  let expectedHost; try { expectedHost = new URL(applyUrl(lead)).hostname; } catch {} // 兜底：申请地址解析不了就不核对主机
  let result = null;
  try { result = await run(applicationPageScript({ number: lead.number, company: lead.company, saved, expectedHost, browser }), { timeout: 20000, maxBuffer: 2 * 1024 * 1024, engine: browser }); }
  catch (e) { console.error(`[application-page] 切到 #${lead.number ?? ''} 保留的那一页没成，改成直接打开申请页：${String(e.message || e).slice(0, 160)}`); }
  if (!result?.ok) return reopen();
  await remember(rid, { browser, spaceId: result.spaceId, page: result.page, targetId: result.targetId });
  await raise();
  return { ...result, receipt: SWITCHED };
}
