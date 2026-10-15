// 没有登录过的浏览器可用（或设置里选了内置，config/pipeline.json auto_apply_driver: "builtin"）时的自动投递驱动。
// 只给无账号的官方表单用（Ashby / Greenhouse / Lever / Workable）：要登录的门户交还给你（accepts=false →
// lib/auto-apply.mjs 的 ego_required），因为它每次开一个全新的、没有任何登录的浏览器。
// 和 ego 驱动一样：同样的页面脚本（lib/apply-page-scripts.mjs）、同样的填法、同样的提交按钮认法；先填好停在终审
// （截图 + 读回），你确认那一版之后下一轮才点提交。
import fs from 'node:fs';
import path from 'node:path';
import { root } from './store.mjs';
import { applyChannel } from './apply-channel.mjs';
import { EXTRACT, READBACK, CHALLENGE, BUTTONS, REQUIRED_EMPTY, PICK_OPTION, SHOT_READY, fillEntry, openApplicationForm } from './apply-page-scripts.mjs';
import { noteSwallowed } from './swallow.mjs';

const SUBMIT = ['button:has-text("Submit")', 'input[type="submit"]', 'text=提交', 'text=Submit application', 'text=Submit'];

// args：额外的浏览器启动参数（测试里给 --no-proxy-server，只连本地假页面，不走系统代理）。
export function playwrightApplyDriver({ headless = true, channel = 'auto', args = [] } = {}) {
  let browser = null, context = null;
  const pages = new Map();
  const open = async () => {
    if (context) return context;
    const { chromium } = await import('playwright-core');
    let last = null;
    for (const ch of channel === 'auto' ? ['chrome', null] : [channel === 'chromium' ? null : channel]) {
      try { browser = await chromium.launch({ headless, ...(ch ? { channel: ch } : {}), ...(args.length ? { args } : {}) }); break; } catch (e) { last = e; }
    }
    if (!browser) throw Error(`builtin_browser_missing: ${String(last?.message || last).split('\n')[0]}`);
    context = await browser.newContext({ acceptDownloads: false });
    return context;
  };
  const fillAll = async (page, entries, plan) => {
    for (const e of entries) {
      try {
        await fillEntry(page, e, plan.resume_absolute_path, PICK_OPTION);
      } catch (error) { return 'fill_failed:' + e.key + ':' + String(error.message).slice(0, 160); }
    }
    return null;
  };
  const submitTarget = async page => {
    for (const sel of SUBMIT) if (await page.waitForSelector(sel, { state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) return sel; // 兜底：这个选择器等不到就试下一个
    return null;
  };
  // 整页截图前回到顶上（SHOT_READY），等两帧让吸顶栏归位，否则截图里会重复一段（09-30 #14）。
  const shot = async (page, dir, name) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    await page.evaluate(`(${SHOT_READY})()`).catch(() => {}); // 兜底：回不到顶上也照样截，最多截图里重复一段
    await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {}); // 兜底：等不到两帧也照样截
    await page.screenshot({ path: path.join(root, dir, name), fullPage: true }).catch(e => noteSwallowed('apply.screenshot', e, { member: 'quill', doing: `截申请页的图（${name}）`, then: '这一步没有截图' }));
    return `${dir}/${name}`;
  };
  return {
    name: 'builtin',
    accepts: lead => applyChannel(lead) === 'ats_form',
    inspect: async ({ plan }) => {
      const page = await (await open()).newPage(), space = pages.size + 1;
      pages.set(space, page);
      await page.goto(plan.url);
      await page.waitForLoadState('networkidle').catch(() => {}); // 兜底：页面一直有网络请求也接着往下走，超时不算错
      await openApplicationForm(page);
      const controls = await page.evaluate(`(${EXTRACT})()`);
      const text = await page.evaluate('document.body.innerText.slice(0, 4000)');
      const challenge = await page.evaluate(`(${CHALLENGE})()`).catch(e => { noteSwallowed('apply.challenge', e, { member: 'quill', doing: '看申请页上有没有验证（验证码、安全检查）', then: '当没有，接着读表单' }); return null; });
      const buttons = await page.evaluate(`(${BUTTONS})()`).catch(() => []); // 兜底：读不到按钮就只看正文
      return { space, url: page.url(), controls, text, challenge, buttons };
    },
    prefill: async ({ plan, dir, entries, space }) => {
      const page = pages.get(space);
      const failed = await fillAll(page, entries, plan), target = failed ? null : await submitTarget(page);
      if (failed || !target) return { prefilled: false, error: failed || 'submit_button_missing', url: page.url() };
      const readback = await page.evaluate(`(${READBACK})(${JSON.stringify(entries.map(e => ({ key: e.key, selector: e.selector, action: e.action, option_selector: e.option_selector || null })))})`).catch(e => { noteSwallowed('apply.readback', e, { member: 'quill', doing: '填完以后从页面读回填进去的值', then: '这次没有回读核对' }); return []; });
      const missing = await page.evaluate(`(${REQUIRED_EMPTY})()`).catch(e => { noteSwallowed('apply.requiredEmpty', e, { member: 'quill', doing: '看还有没有空着的必填项', then: '这次没查' }); return null; });
      return { prefilled: true, url: page.url(), readback, missing, screenshot: await shot(page, dir, 'prefilled.png') };
    },
    // `presubmit: true` is the promise that submit was never pressed (as in the ego driver).
    apply: async ({ plan, dir, entries, space }) => {
      const page = pages.get(space);
      const failed = await fillAll(page, entries, plan), target = failed ? null : await submitTarget(page);
      if (failed || !target) return { submitted: false, presubmit: true, error: failed || 'submit_button_missing', url: page.url() };
      await page.click(target);
      await page.waitForLoadState('networkidle').catch(() => {}); // 兜底：页面一直有网络请求也接着截图，超时不算错
      await page.waitForTimeout(1500);
      const screenshot = await shot(page, dir, 'submitted.png');
      return { submitted: true, confirmation: await page.evaluate('document.body.innerText.slice(0, 4000)'), url: page.url(), screenshot };
    },
    // 停下来的那一刻：整页截图和现在的地址（lib/auto-apply.mjs stopAt）。inspect 半路出错时没有 space，截最后开的那一页。
    snap: async ({ dir, space }) => {
      const page = pages.get(space) || [...pages.values()].at(-1);
      if (!page || page.isClosed()) return null;
      const out = path.join(root, dir, 'stopped.png');
      fs.rmSync(out, { force: true }); // 同一天上一次停下的那张不算这一次的
      const screenshot = await shot(page, dir, 'stopped.png');
      return { url: page.url(), screenshot: fs.existsSync(out) ? screenshot : null };
    },
    close: async () => { await browser?.close().catch(() => {}); browser = context = null; pages.clear(); }, // 兜底：浏览器已经关了
  };
}
