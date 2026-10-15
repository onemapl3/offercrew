// 能力表（线 H，design/architecture-review/04-改造契约与分工.md 2.4）：这台机器、这种身份下，一件事谁来做。
//
// 只有这个模块读「运行方式」：RADAR_SCHEDULER、本机 AI 的开关（config/pipeline.json desktop_executor）、邮箱账号在不在
// （private/mail/account.json）、Chrome 在不在、文字模型从哪来。别的模块一律问 identity() / whoDoes()，不再各自判断
// desktopMode、executorGate、localAiOff、hostOpGate、engineHands、mailConnected……（以前 30 个文件 69 处，01 根 1）。
//
// 命令行版 10-04 冻结（负责人拍板）：新代码只有一种身份，**引擎是唯一的手**。
//   - RADAR_SCHEDULER=app 只说明定时由谁起（App 自己起，还是外面起），不再决定谁来做事；不带它跑的测试走同一条路。
//   - 对外动作（发信、发私信、预填、提交、读信）全部由引擎里的 worker 做，从不交给本机 AI（01 根 2）。
//   - 本机 AI 是可选工具；只有明确选用本机工具的任务才接它，普通任务与修复始终先用引擎。
//
// whoDoes(kind) → { worker: 'engine' | 'local_ai' | 'sandbox' | null, reason, fix: { label, href } | null }
//   sandbox：演示 / 沙盒模式下的对外动作，模拟完成（不发、不填、不读）。
//   worker 为 null 就是这台机器现在做不了：reason 说为什么，fix 说去哪接上。lib/actions.mjs requestAction 据此直接 blocked。
import fs from 'node:fs';
import path from 'node:path';
import { root as storeRoot } from './store.mjs';
import { sandboxed, sandboxModels } from './sandbox.mjs';
import { findChrome, CHROME_DOWNLOAD } from './chrome-path.mjs';
import { waitReason } from './wait-reason.mjs';
import { runtimeOf } from './local-runtimes.mjs';
import { LOCAL_AI_NAMES } from './local-ai-errors.mjs';

// 在 OfferCrew 里登录的 ChatGPT 账号（Mac 版的文字模型来源之一）：和 lib/codex-app.mjs ACCOUNT 同一个。本机 AI 用了它就用它的登录目录。
export const APP_ACCOUNT = 'openai@app';
export const SANDBOX_MODE = 'workspace-write';
export const HOST_SCRIPTS = ['bin/host/run-now.sh'];
export const HOOK_VARS = ['RADAR_EXECUTOR_SANDBOX', 'RADAR_EXECUTOR_NO_MAIL', 'RADAR_EXECUTOR_OWN_LOGIN'];
export const LOCAL_AI_SWITCH = '#settings/advanced?hl=hands';
export const LOCAL_AI_OFF = '本机 AI 没打开';
export const LOCAL_AI_UNSUPPORTED = '这一版还不支持受限运行';
export const MAIL_SETUP = '#settings/accounts/mail';
export const MAIL_WAITS = '查信要等邮箱接好';
export const MODEL_SETUP = '#settings/model';
export const MAIL_ACCOUNT = 'private/mail/account.json';

// 对外动作（契约 2.3）：只由引擎做，确认和闸门挂在 lib/actions.mjs requestAction 上。
export const OUTBOUND = ['send_email', 'send_dm', 'prefill', 'submit', 'read_mail'];
// 引擎加文字模型做的活；judge 有离线规则兜底，discover 不要模型。
export const MODEL_WORK = ['draft_letter', 'revise_draft', 'tailor_resume', 'company_research', 'interview_prep', 'find_referrers'];
// 这些种类允许显式选本机工具；默认仍由引擎处理。
export const LOCAL_AI_OK = ['user_task', 'system_repair'];
export const KINDS = [...OUTBOUND, ...MODEL_WORK, 'judge', 'discover', ...LOCAL_AI_OK];

const rootOf = r => r || storeRoot;
const json = (root, rel) => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; } }; // 兜底：文件不在或读坏了就当没有
const config = (root, name) => json(root, `config/${name}.json`) ?? json(root, `config/${name}.example.json`) ?? {};

// 宿主脚本认不认受限运行的两个变量：改了（修改时间或大小变了）才重读。
const seen = new Map();
const honours = f => {
  try {
    const st = fs.statSync(f), m = `${st.mtimeMs}:${st.size}`, c = seen.get(f);
    if (c?.m === m) return c.ok;
    const s = fs.readFileSync(f, 'utf8'), ok = HOOK_VARS.every(v => s.includes(v));
    seen.set(f, { m, ok });
    return ok;
  } catch { return false; } // 兜底：钩子文件读不出就当没装好
};

// 本机 AI：开关开没开、能不能跑、不能跑为什么；能跑时 env 是要交给宿主脚本的受限运行变量。
export function localAi({ root = null, env = process.env } = {}) {
  const R = rootOf(root);
  const on = config(R, 'pipeline').desktop_executor === true;
  const host = config(R, 'host'), kind = host.executor === 'claude' ? 'claude' : 'codex', chain = host.codex_models?.chain || [];
  const source = kind === 'codex' && chain.length && chain.every(s => s?.provider === APP_ACCOUNT) && config(R, 'providers').providers?.[APP_ACCOUNT] ? 'app_account' : 'local';
  if (!on) return { on: false, ready: false, why: LOCAL_AI_OFF, env: null, kind, source };
  if (!HOST_SCRIPTS.every(s => honours(path.join(R, s)))) return { on: true, ready: false, why: LOCAL_AI_UNSUPPORTED, env: null, kind, source };
  const base = { RADAR_EXECUTOR_SANDBOX: SANDBOX_MODE, RADAR_EXECUTOR_NO_MAIL: '1' };
  // 以前在 OfferCrew 里登录的 ChatGPT 账号（openai@app），本机 AI 全用它的：照旧用它的登录目录。
  if (source === 'app_account')
    return { on: true, ready: true, why: null, kind, source, env: { ...base, CODEX_HOME: path.join(R, 'private/accounts', APP_ACCOUNT) } };
  // R23（10-11 负责人）：直接用这台电脑上已经登录好的 Claude Code / Codex，权限照旧受限（只能改工作目录、发信不交给它）。
  const rt = runtimeOf(kind, { env });
  const why = !rt?.installed ? `这台电脑上没找到 ${LOCAL_AI_NAMES[kind]}` : rt.login === 'out' ? `${LOCAL_AI_NAMES[kind]} 还没登录` : rt.login !== 'in' ? `${LOCAL_AI_NAMES[kind]} 的登录状态还没查到` : null;
  return { on: true, ready: !why, why, kind, source, env: why ? null : { ...base, RADAR_EXECUTOR_OWN_LOGIN: '1' } };
}
// 本机 AI 现在是什么样，一句话（K43：System 和设置页读同一句，「允许了但还用不了」不说成「没打开」）。
export function localAiSentence(x = localAi()) {
  if (!x.on) return LOCAL_AI_OFF;
  return x.ready ? `本机 AI 开着，用的是${x.source === 'app_account' ? ' Codex（OfferCrew 内的账号）' : `这台电脑上的 ${LOCAL_AI_NAMES[x.kind] || 'Codex'}`}` : `本机 AI 已允许，但还用不了：${x.why}`;
}

export function mailState({ root = null } = {}) {
  const a = json(rootOf(root), MAIL_ACCOUNT);
  return { connected: !!a, send_ok: a ? a.send?.ok !== false : false, address: a?.address || null };
}

// 浏览器：只有专用 Chrome（RADAR_CHROME_PATH 可换成测试用的无头 Chromium；ego 浏览器那条路 10-04 删掉了）。
export function browserState({ env = process.env } = {}) {
  return findChrome({ env }) ? { engine: 'chrome', ready: true, why: null } : { engine: 'chrome', ready: false, why: '这台电脑上没找到 Google Chrome' };
}

// 文字模型从哪来：supply（OfferCrew 补给）、own（自己配的）、none。不调模型，只看配置和登录（lib/model.mjs textReady 同一条）。
let textProbe = null;
export function textSource() {
  if (sandboxed() && !sandboxModels()) return { source: 'none', why: '演示 / 沙盒模式不调用模型' };
  try {
    const M = textProbe?.model;
    if (!M) return { source: 'unknown', why: null }; // 还没加载（loadCapabilities）：不拦
    const r = M.textReady();
    if (!r.ok) return { source: 'none', why: r.note || '还没有配好文字模型' };
    return { source: M.firstProvider() === 'offercrew' ? 'supply' : 'own', why: null };
  } catch (e) { return { source: 'none', why: String(e.message || e).slice(0, 80) }; }
}
// 文字模型那一问由上面一层交进来（lib/text-probe.mjs loadTextProbe()：model、backends、text-conf 都在 domain，这里不往上引）；
// 测试可以塞假的。没交进来时 textSource 回 unknown，不拦。
export function loadCapabilities({ model = null } = {}) { textProbe = model ? { model } : null; }

// 这台机器、这种身份。
export function identity({ env = process.env, root = null } = {}) {
  return {
    app: env.RADAR_SCHEDULER === 'app', // 只决定定时由谁来起
    sandbox: sandboxed(),
    sandbox_models: sandboxed() && sandboxModels(),
    local_ai: localAi({ root, env }),
    mail: mailState({ root }),
    browser: browserState({ env, root }),
    text: textSource(),
  };
}

const can = (worker, reason = null) => ({ worker, reason, fix: null });
const cannot = (reason, fix = null) => ({ worker: null, reason, fix });
const MAIL_FIX = { label: '接上邮箱', href: MAIL_SETUP };
const MODEL_FIX = { label: '配好文字模型', href: MODEL_SETUP };
const CHROME_FIX = { label: '装上 Chrome', href: CHROME_DOWNLOAD };

export function whoDoes(kind, { ident = null, env = process.env, root = null, local = false } = {}) {
  if (!KINDS.includes(kind)) throw Error(`unknown_capability_kind:${kind}`);
  const I = ident || identity({ env, root });
  const textOk = I.text?.source !== 'none';
  if (OUTBOUND.includes(kind)) {
    // 演示 / 沙盒（主会话 10-04）：对外动作由 'sandbox' 执行者模拟完成——不碰外部世界，回执写明「演示」，那件活照常走到做完。
    if (I.sandbox) return can('sandbox', '演示 / 沙盒模式不对外动手，模拟完成');
    if (kind === 'send_email') return !I.mail.connected ? cannot('邮箱还没接上', MAIL_FIX) : !I.mail.send_ok ? cannot('邮箱只能收信，发信没通', MAIL_FIX) : can('engine');
    if (kind === 'read_mail') return I.mail.connected ? can('engine') : cannot('邮箱还没接上', MAIL_FIX);
    return I.browser.ready ? can('engine') : cannot(I.browser.why, CHROME_FIX);
  }
  if (kind === 'discover') return can('engine');
  if (kind === 'judge') return can('engine'); // 没有模型时按离线规则判断（lib/judge.mjs）
  if (MODEL_WORK.includes(kind)) return textOk ? can('engine') : cannot(I.text.why || '还没有配好文字模型', MODEL_FIX);
  // 打开可选工具不改变业务任务的执行者。显式选用本机工具才检查它；标准修复无需模型也能做。
  if (local) return I.local_ai.ready ? can('local_ai') : cannot(I.local_ai.why || LOCAL_AI_OFF, { label: '本机工具设置', href: LOCAL_AI_SWITCH });
  if (kind === 'system_repair') return can('engine');
  return textOk ? can('engine') : cannot(I.text.why || '还没有配好文字模型', MODEL_FIX);
}

// 拉起本机 AI 的那一道（只给 user_task、system_repair 用）：{ allowed, env, why, go }。
export function localAiGate(opts = {}) {
  const x = localAi(opts);
  return x.ready ? { allowed: true, env: x.env, why: null, go: null } : { allowed: false, env: null, why: x.why, go: LOCAL_AI_SWITCH };
}
// 排着的事卡上那一句：开关没开就等你打开；打开了却跑不了就写为什么。结构化的原因（码 + 一句，lib/wait-reason.mjs）：
// 本机 AI 只是可选的加速，等它不算挡路（不上指挥台顶上那一行，lib/blockers.mjs）。
export const localAiWait = gate => (gate.why === LOCAL_AI_OFF || !gate.why ? waitReason('local_ai_off') : waitReason('local_ai_unready', { why: gate.why }));
export const heldText = gate => localAiWait(gate).text;
// 定时由 App 自己起（RADAR_SCHEDULER=app）还是外面起。只用来决定起不起 App 的定时，不用来决定谁做事。
export const appSchedules = (env = process.env) => env.RADAR_SCHEDULER === 'app';
// 跑在 Mac App 壳里（同一个变量）：只给「怎么说、怎么显示、模型登录用哪一份」这类不涉及谁动手的判断用
// （专用 Chrome 的说法、App 自己的 ChatGPT 登录、定时表的样子）。谁来做事一律问 whoDoes。
export const appShell = (env = process.env) => env.RADAR_SCHEDULER === 'app';
export const localAiReady = opts => localAi(opts).ready;
export const SWITCH_GO = LOCAL_AI_SWITCH;
// 周期里本机 AI 能做、却因为没打开而跳过的那几件：各步写进自己输出的 local_ai_skipped，周期一轮只记一行。
export function localAiLine(results = []) {
  const items = [...new Set(results.flatMap(r => Array.isArray(r?.local_ai_skipped) ? r.local_ai_skipped : []))];
  return items.length ? `这一轮跳过了：${items.join('、')}（要本机 AI，开关关着）` : null;
}
// 读信由谁做（Watcher 那几处用）：'engine'（接了内置邮箱）、'sandbox'（演示）、null（邮箱没接，fix 去接上）。
export const mailReader = opts => whoDoes('read_mail', opts);
