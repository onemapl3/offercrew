// 本机 AI 的三个事实分别给出：开关、启动条件、实际任务。读取页面只查版本和登录，不执行任务、不调用模型。
import { read, file } from './store.mjs';
import { localAi, localAiSentence, APP_ACCOUNT } from './capabilities.mjs';
export const LOCAL_AI_INDEPENDENT = '业务和浏览器由 OfferCrew 引擎配合选定的文字模型处理；本机 AI 用于明确交代的本机文件、命令或单独启用的额外排查，关闭不影响正常业务。';
export { localCliPath, cliPath } from './local-runtimes.mjs';
import { detectRuntimes } from './local-runtimes.mjs';
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }; // 兜底：进程不存在就是未在运行。
// 旧 App 账号也是单独的登录目录：状态和“试一次”必须与 gate 交给 run-now 的 CODEX_HOME 一致。
export function localAiRuntimeEnv(kind, { env = process.env, gate = localAi({ env }) } = {}) {
  return kind === 'codex' && gate.source === 'app_account' ? { ...env, CODEX_HOME: gate.env?.CODEX_HOME || file(`private/accounts/${APP_ACCOUNT}`) } : env;
}
export function localAiStatus({ env = process.env, gate = localAi({ env }) } = {}) {
  const host = read('config/host.json', {}), run = read('state/run-now.json', {}), checks = read('state/local-ai-checks.json', {}), attempts = read('state/local-ai-attempts.json', {});
  const selected = gate.kind || (host.executor === 'claude' ? 'claude' : 'codex');
  // 装了没有、版本、登录、身份：lib/local-runtimes.mjs 自动检测（R23）；最近一次检查 / 任务的结果接在后面。
  const runtimes = detectRuntimes({ env: localAiRuntimeEnv('codex', { env, gate }) }).map(rt => {
    const source = rt.kind === selected ? gate.source || 'local' : 'local';
    const check = (checks[rt.kind]?.login_source || 'local') === source ? checks[rt.kind] : null, attempt = attempts[rt.kind];
    const last = [check, attempt].filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
    const failed = rt.usable && last && !last.ok;
    const account = source === 'app_account' ? '（OfferCrew 内的账号）' : '';
    return { ...rt, name: `${rt.name}${account}`, source, selected: rt.kind === selected, last, attempt, state: failed ? `${rt.state} · 上次没跑通` : rt.state, remedy: rt.remedy || (failed ? last.remedy || last.reason : null) };
  });
  const current = runtimes.find(r => r.selected), running = run.running === true && alive(run.pid);
  const launch = !gate.on ? '未打开' : !current.installed ? '找不到命令' : current.login === 'out' ? '没登录' : !gate.ready ? '配置未就绪' : current.attempt?.ok === false ? '上次启动 / 执行失败' : current.attempt?.ok ? '上次任务启动成功' : '尚未检查启动';
  return { on: gate.on, why: gate.on ? gate.why || (current.attempt?.ok === false ? current.attempt.reason : null) : null, configured: gate.ready, source: gate.source || 'local', config_reason: gate.on && !gate.ready ? gate.why : null, selected, launch, running, execution: running ? '正在运行' : run.running ? '上次进程已结束，等待对账' : run.pending ? '任务排队中' : '当前空闲', runtimes, sentence: localAiSentence(gate), independent: LOCAL_AI_INDEPENDENT };
}

// 对话和设置共用的状态读数：不让语言模型把旧 host/provider 配置解释成当前本机 AI。
export function localAiSummary(status = localAiStatus()) {
  const current = status.runtimes.find(r => r.selected);
  return `${status.sentence}。\n当前选择：${current.name}；${current.state}。\n启动条件：${status.configured ? '已就绪' : status.on ? status.config_reason || status.launch : '开关未打开'}；${status.launch}。\n运行状态：${status.execution}。${status.why ? `\n最近问题：${status.why}。${current.remedy ? `\n${current.remedy}` : ''}` : ''}`;
}
export function localAiContext(status = localAiStatus()) {
  const { on, configured, source, selected, launch, running, execution, sentence, independent } = status;
  return { on, configured, source, selected, launch, running, execution, sentence, independent,
    runtimes: status.runtimes.map(({ kind, name, version, login, identity_label, selected, state, remedy }) => ({ kind, name, version, login, identity_label, selected, state, remedy })) };
}
