// Bounded session recovery: browser navigation/observation only, never submission.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { file, read, write, today } from './store.mjs';
import { event } from './events.mjs';
import { lock } from './lock.mjs';
import { runCodexComputerTask } from './codex-computer.mjs';
import { approvalFor } from './submission-policy.mjs';
import { excludedCompany } from './discovery-policy.mjs';
import { runBuiltinComputerTask } from './operator/agent.mjs';
import { runCuaComputerTask } from './operator/cua.mjs';
import { computerUseSettings, operatorModelLabel } from './operator/config.mjs';
import { sandboxed, sandboxSkip } from './sandbox.mjs';

export const computerUseConfig = () => read('config/pipeline.json', {}).computer_use || {};
const matches = (host, list = []) => list.some(d => host === String(d).toLowerCase() || host.endsWith('.' + String(d).toLowerCase()));
export function computerUseGate({ url, host, config, sessions }) {
  if (config.enabled !== true) return 'disabled';
  let u;
  try { u = new URL(url); } catch { return 'invalid_url'; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || [...u.searchParams.keys()].some(k => !/^(id|pid|jobId|positionId|postId|job_id|position_id)$/i.test(k)) || u.hash || /(?:logout|signout|submit|callback|token|verify)/i.test(u.pathname)) return 'unsafe_url';
  if (host !== u.hostname) return 'host_mismatch';
  if (matches(host, sessions.never_auto)) return 'never_auto';
  if (matches(host, config.never_hosts)) return 'never_host';
  if (!matches(host, config.allow_hosts)) return 'host_not_allowed';
  return null;
}

// 旧驱动接口保留给明确的本机工具调用；业务浏览器始终由内置操作员执行。
// 历史 drivers.default/per_host 不再把预填转交给 Codex，也不改写用户保存的配置。
export const COMPUTER_DRIVERS = { codex: runCodexComputerTask, builtin: runBuiltinComputerTask, cua: runCuaComputerTask };
// 操作员用哪个浏览器，给人看的名字：旧配置里的 "ego" 和 host 都是专用 Chrome（10-04 ego 删了）。
const backendWord = b => (['ego', 'host'].includes(b) ? '专用 Chrome' : b || 'playwright');
const driverStep = approved => `内置操作员（${backendWord(computerUseSettings().operator.backend)} · ${operatorModelLabel(computerUseSettings().operator) || '跟随所选文字模型'}）：${approved ? '预填已批准的材料，停在最终提交前' : '导航并检查登录态，不填任何东西'}`;
export const computerUseDriverLabel = () => '引擎浏览器';

export async function runComputerUse({ url, host, lead, plan, timeout_ms = 240000 } = {}, { execute = null, drivers = COMPUTER_DRIVERS, now = Date.now() } = {}) {
  const config = computerUseConfig();
  // Disabled is a true no-op: no subprocess, evidence, events or locks.
  if (config.enabled !== true) return { ok: false, reached: 'error', evidence: null, message: 'disabled' };
  try { host ||= new URL(url).hostname; } catch {} // 兜底：地址解析不了就不记主机
  const id = randomUUID(), evidence = `runs/${today()}/computer-use/${id}.json`;
  const steps = [], screenshots = [];
  let release, submitted = false, toolCalls = 0, browser = 'chrome', driver = null;
  const finish = (reached, message) => {
    const result = { ok: ['logged_in', 'prefilled'].includes(reached), reached, evidence, message, browser, submitted, tool_calls: toolCalls, ...(driver ? { driver } : {}) };
    write(evidence, { ...result, at: new Date(now).toISOString(), host: /^[a-z0-9.-]+$/.test(host || '') ? host : null, steps, screenshots, submitted });
    event('postman', 'computer-use', result.ok ? 'ok' : 'waiting_user', message, { refs: [{ file: evidence }], ...(lead?.record_id ? { lead_id: lead.record_id } : {}) });
    return result;
  };
  try {
    if (lead && excludedCompany(lead)) return finish('error', 'company_excluded_by_user');
    const reason = computerUseGate({ url, host, config, sessions: read('config/portal-sessions.json', {}) });
    if (reason) return finish('error', reason);
    if (process.env.RADAR_EXTERNAL_POLICY === 'base-and-cards') return finish('error', 'external_policy');
    // 演示 / 沙盒模式：不拉起任何驱动（Codex、内置操作员、cua），像驱动不可用一样交回，不留证据文件（lib/sandbox.mjs）。
    if (sandboxed()) { sandboxSkip(`引擎浏览器：${host}`, { actor: 'postman', lead_id: lead?.record_id || null }); return { ok: false, reached: 'unavailable', evidence: null, message: 'sandbox', browser, submitted: false, tool_calls: 0 }; }
    release = lock('computeruse');
    const historyPath = 'private/computer-use-attempts.json';
    const history = read(historyPath, []).filter(at => at > now - 3600000);
    const max = Number(config.max_per_hour ?? 2);
    if (!Number.isInteger(max) || max < 1 || history.length >= max) return finish('error', 'rate_limited');
    write(historyPath, [...history, now]); // reserve before starting; crashes count
    fs.mkdirSync(path.dirname(file(evidence)), { recursive: true });
    const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 120000, 240000));
    const approved = plan && approvalFor(plan);
    const task = { url, host, mode: approved ? 'prefill' : 'session', ...(approved ? { fields: plan.fields, resume_path: plan.resume_absolute_path } : {}) };
    // 测试仍可替换执行函数；实际业务只有引擎这一条路径，文字模型由操作员沿用团队选择。
    const run = execute || drivers.builtin;
    driver = 'builtin';
    if (typeof run !== 'function') return finish('unavailable', 'no_computer_use_driver');
    steps.push(driverStep(approved));
    const result = await run(task, { timeout });
    if (!result) return finish('unavailable', 'no_computer_use_driver');
    browser = result.browser || 'chrome';
    if (typeof result.screenshot === 'string' && result.screenshot) { const rel = path.relative(file(''), result.screenshot); screenshots.push(rel.startsWith('..') || path.isAbsolute(rel) ? result.screenshot : rel); }
    submitted = result.submitted; toolCalls = result.tool_calls || 0;
    steps.push(...(result.steps || []).slice(0, 12).map(s => String(s).slice(0, 180)));
    if (result.submitted !== false) return finish('error', 'submission_boundary_violated_reconcile_required');
    if (['login_wall', 'captcha', 'needs_user', 'unavailable', 'error'].includes(result.reached)) return finish(result.reached, `${driver}_${result.reached}`);
    let finalHost; try { finalHost = new URL(result.final_url).hostname; } catch {} // 兜底：最后的地址解析不了就不核对主机
    if (finalHost !== host || !result.authenticated || !result.application || !result.tool_calls) return finish('error', 'session_not_proven');
    if (result.reached === 'prefilled' && !approved) return finish('error', 'prefill_without_approval');
    const sessions = read('config/portal-sessions.json', { domains: {} });
    if (computerUseGate({ url, host, config: computerUseConfig(), sessions })) return finish('error', 'policy_changed');
    sessions.domains ||= {};
    // A Chrome (or operator-browser) session is never advertised as an ego-browser login.
    sessions.domains[host] = { ...sessions.domains[host], cua_logged_in: true, cua_verified_at: new Date(now).toISOString(), cua_browser: browser, cua_driver: driver };
    write('config/portal-sessions.json', sessions);
    // 内置操作员在专用 Chrome 里留给你的那一页：记下来，「打开申请页」能切回去（lib/application-page.mjs）。
    if (result.held?.spaceId != null && lead?.record_id) {
      const pages = read('state/application-pages.json', {});
      pages[lead.record_id] = { ...result.held, at: new Date(now).toISOString() };
      write('state/application-pages.json', pages);
    }
    return finish(result.reached, result.reached === 'prefilled' ? `${browser === 'chrome' ? 'chrome' : 'operator'}_prefilled_user_must_review_and_submit` : `${browser === 'chrome' ? 'chrome' : 'operator'}_session_ready_no_submission`);
  } catch (error) {
    // Never persist raw subprocess output; it may contain local configuration.
    return finish('error', error?.killed ? 'timeout' : 'computer_use_failed');
  } finally { release?.(); }
}
