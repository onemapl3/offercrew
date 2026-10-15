// 专用 Chrome 上的投递驱动（原 lib/ego-apply.mjs；脚本写法见 lib/browser-compat.mjs）。一批投递占一个任务空间；
// 填好的页留给你，别的页复用。
import fs from 'node:fs';
import path from 'node:path';
import { root } from './store.mjs';
import { runBrowserScript } from './browser-run.mjs';
import { EXTRACT, READBACK, CHALLENGE, BUTTONS, REQUIRED_EMPTY, PICK_OPTION, SHOT_READY, fillEntry, openApplicationForm } from './apply-page-scripts.mjs';

// 页面里跑的三段脚本（读控件 EXTRACT、读回 READBACK、验证码 CHALLENGE）在 lib/apply-page-scripts.mjs，内置驱动也用。
const browserCall = script => runBrowserScript(script, { cwd: root, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });

// 记进 state/application-pages.json 和预填记录的 browser 是 'chrome'，「打开申请页」和收件箱的说法照它写。
export function chromeApplyDriver({ space = null, call = browserCall } = {}) {
let spaceId = space, currentPage = 'p1', initialized = false;
const pages = new Map(), kept = new Set();
const where = 'chrome';
return {
  name: where,
  inspect: async ({ plan, dir }) => {
    if (!initialized) {
      const name = JSON.stringify('auto-apply ' + plan.company + ' #' + plan.number);
      const created = await call(`let task;
${spaceId == null ? `task = await taskSpace(${name});` : `try { task = await taskSpace(${JSON.stringify(spaceId)}); } catch (e) { if (!String(e.message).startsWith('task_space_not_found:')) throw e; task = await taskSpace(${name}); }`}
if (task.ownership !== 'agent') task = await takeOverTaskSpace(task.spaceId);
radarResult({ space: task.spaceId });`);
      spaceId = created.space;
      initialized = true;
    }
    if (kept.has(currentPage)) {
      const created = await call(`const task = await taskSpace(${JSON.stringify(spaceId)}); const page = await task.newPage(); radarResult({ page: page.label });`);
      currentPage = created.page;
    }
    pages.set(plan.record_id, currentPage);
    const script = `
const task = await taskSpace(${JSON.stringify(spaceId)});
const page = task.page(${JSON.stringify(currentPage)});
const fs = await import('node:fs');
const registryPath = ${JSON.stringify(path.join(root, 'state/application-pages.json'))};
let registry = {}; try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch {} /* 兜底：登记表读不出来就当没有保留的页面：只是不复用旧页、重新打开申请页 */
registry[${JSON.stringify(plan.record_id)}] = { browser:${JSON.stringify(where)}, spaceId:task.spaceId, page:page.label, targetId:page.targetId || null, at:new Date().toISOString() };
fs.writeFileSync(registryPath, JSON.stringify(registry,null,2));
await page.goto(${JSON.stringify(plan.url)});
await page.waitForLoadState("networkidle").catch(() => {}); /* 兜底：网络一直不静下来也照样往下读页面；能不能填按页面上读到的判断 */
await (${openApplicationForm})(page);
const controls = await page.evaluate(${EXTRACT});
const text = await page.evaluate("document.body.innerText.slice(0, 4000)");
const challenge = await page.evaluate(${CHALLENGE}).catch(() => null); /* 兜底：验证页检测读不出来就当没有；后面填表照样核对，填不上就停下交给你 */
const buttons = await page.evaluate(${BUTTONS}).catch(() => []); // 兜底：读不到按钮就只看正文
radarResult({ space: task.spaceId, page: page.label, url: await page.url(), controls, text, challenge, buttons });`;
    return call(script);
  },
  // 终审前的预填：和 apply 同样填写，但不点提交；确认提交按钮在，整页截图，读回每个控件现在的值。
  // 任务空间留着不关，你在收件箱点「去页面上看」时切过去就是这一页。
  prefill: async ({ plan, dir, entries, space }) => {
    const shot = path.join(root, dir, 'prefilled.png');
    const script = `
const task = await taskSpace(${JSON.stringify(space)});
const page = task.page(${JSON.stringify(pages.get(plan.record_id) || currentPage)});
let failed = null;
const fillEntry = ${fillEntry};
for (const e of ${JSON.stringify(entries)}) {
  try { await fillEntry(page, e, ${JSON.stringify(plan.resume_absolute_path)}, ${JSON.stringify(PICK_OPTION)}); }
  catch (error) { failed = "fill_failed:" + e.key + ":" + String(error.message).slice(0, 160); break; }
}
let target = null;
if (!failed) for (const sel of ["loc=role:button[name*=\\"Submit\\"]", "text=提交", "text=Submit application", "text=Submit"]) {
  if (await page.waitForSelector(sel, { state: "visible", timeout: 2500 }).then(() => true).catch(() => false)) { target = sel; break; } /* 兜底：这个选择器等不到就试下一个；都没有就按 submit_button_missing 失败 */
}
if (failed || !target) radarResult({ prefilled: false, error: failed || "submit_button_missing", url: await page.url() });
else {
  const readback = await page.evaluate(${JSON.stringify(`(${READBACK})(${JSON.stringify(entries.map(e => ({ key: e.key, selector: e.selector, action: e.action, option_selector: e.option_selector || null })))})`)}).catch(() => []); /* 兜底：读不回就当一项都没核对上：信上只列核对上的项，不当成填好了 */
  const missing = await page.evaluate(${JSON.stringify(`(${REQUIRED_EMPTY})()`)}).catch(() => null); /* 兜底：必填空着的读不出来就是不知道（null），不当成都填了 */
  // 整页截图前回到顶上，等一会儿让页面停稳（09-30 #14：截图的上半截重复了一遍）。
  await page.evaluate(${JSON.stringify(`(${SHOT_READY})()`)}).catch(() => null); /* 兜底：回到页顶只是让截图好看，没做成照样截 */
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: ${JSON.stringify(shot)}, fullPage: true }).catch(() => {}); /* 兜底：截图没截成只是少一份证据，填了什么照读回的判断 */
  radarResult({ prefilled: true, url: await page.url(), readback, missing, screenshot: ${JSON.stringify(dir + '/prefilled.png')} });
}`;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const result = await call(script);
    if (result?.prefilled) kept.add(pages.get(plan.record_id) || currentPage);
    return result;
  },
  apply: async ({ plan, dir, entries, space }) => {
    const shot = path.join(root, dir, 'submitted.png');
    // `presubmit: true` is this script's promise that the submit button was
    // never pressed (a field could not be filled, or the page has no submit
    // button — a multi-step portal such as Workday's first page). Anything that
    // fails after the click stays an uncertain submission for reconciliation.
    const script = `
const task = await taskSpace(${JSON.stringify(space)});
const page = task.page(${JSON.stringify(pages.get(plan.record_id) || currentPage)});
let failed = null;
const fillEntry = ${fillEntry};
for (const e of ${JSON.stringify(entries)}) {
  try { await fillEntry(page, e, ${JSON.stringify(plan.resume_absolute_path)}, ${JSON.stringify(PICK_OPTION)}); }
  catch (error) { failed = "fill_failed:" + e.key + ":" + String(error.message).slice(0, 160); break; }
}
let target = null;
if (!failed) for (const sel of ["loc=role:button[name*=\\"Submit\\"]", "text=提交", "text=Submit application", "text=Submit"]) {
  if (await page.waitForSelector(sel, { state: "visible", timeout: 2500 }).then(() => true).catch(() => false)) { target = sel; break; } /* 兜底：这个选择器等不到就试下一个；都没有就按 submit_button_missing 失败，不提交 */
}
if (failed || !target) radarResult({ submitted: false, presubmit: true, error: failed || "submit_button_missing", url: await page.url() });
else {
  await page.click(target);
  await page.waitForLoadState("networkidle").catch(() => {}); /* 兜底：提交以后网络不静下来也照样读页面；交没交上只按确认页文字判断（lib/auto-apply.mjs confirmsSubmission），不当成交上了 */
  await page.waitForTimeout(3000);
  await page.screenshot({ path: ${JSON.stringify(shot)}, fullPage: true });
  const confirmation = await page.evaluate("document.body.innerText.slice(0, 4000)");
  radarResult({ submitted: true, confirmation, url: await page.url(), screenshot: ${JSON.stringify(dir + '/submitted.png')} });
}`;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    return call(script);
  },
  // 停下来的那一刻（失败、等你、交给你）：那一页整页截图、现在的地址，存进证据目录（lib/auto-apply.mjs stopAt）。不点、不填。
  snap: async ({ plan, dir, space }) => {
    const sid = space ?? spaceId;
    if (sid == null) return null;
    const shot = path.join(root, dir, 'stopped.png');
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const script = `
const task = await taskSpace(${JSON.stringify(sid)});
const page = task.page(${JSON.stringify(pages.get(plan.record_id) || currentPage)});
// 兜底：回到顶上没成也照样截，截不到就不写截图（下一行）
await page.evaluate(${JSON.stringify(`(${SHOT_READY})()`)}).catch(() => null);
// 兜底：截图失败记成没有截图，不当成有
const ok = await page.screenshot({ path: ${JSON.stringify(shot)}, fullPage: true }).then(() => true).catch(() => false);
radarResult({ url: await page.url(), screenshot: ok ? ${JSON.stringify(dir + '/stopped.png')} : null });`;
    return call(script);
  },
  finishLead: ({ plan, status }) => {
    const page = pages.get(plan.record_id);
    if (!page) return;
    if (['prepared_for_user', 'awaiting_final_review', 'needs_login', 'waiting_user', 'uncertain'].includes(status)) kept.add(page);
    else kept.delete(page);
  },
  close: async () => {
    if (spaceId == null) return;
    const script = kept.size ? `
const task = await taskSpace(${JSON.stringify(spaceId)});
const keep = ${JSON.stringify([...kept])};
for (const page of await task.pages()) if (!keep.includes(page.label) && page.openedBy === 'agent') await page.close();
await task.handOff();
radarResult({ handed_off: true, space: task.spaceId, keep });` : `
const task = await taskSpace(${JSON.stringify(spaceId)});
await task.finish({ keep: [] });
radarResult({ finished: true });`;
    const result = await call(script);
    spaceId = null;
    initialized = false;
    return result;
  },
};
}
