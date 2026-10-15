// 演示 / 沙盒模式：nothing leaves this machine and no outside program runs.
//
// On when RADAR_SANDBOX=1 (or true / yes / on), when the command line has --sandbox
// (`node bin/serve.mjs --sandbox`), or when the root holds the marker state/sandbox.json —
// bin/demo-seed.mjs writes it, so a demo root is always a sandbox (delete the file to leave the
// mode). Once on, a process stays on and hands the mode to every child it starts.
//
// One gate, installed the moment this module loads in a sandboxed process. lib/store.mjs imports
// it, so every CLI has the gate before its own code runs; node children also get it preloaded
// (NODE_OPTIONS --import) before any of theirs.
//   Programs  node runs (its children are sandboxed the same way), and so do the few local,
//             read-only tools in LOCAL_TOOLS. Anything else — lark-cli, ego-browser, ego, open,
//             osascript, codex, claude, the bin/host/*.sh executors, curl, gh … — is not started:
//             the caller sees a program that wrote "sandbox: skipped <what>" to stderr and exited 1.
//             No pid, nothing ran.
//   Network   fetch and http(s).request are refused, except inside publicRead(): the public
//             job-board reader (lib/ats/http.mjs) stays allowed on purpose, so discovery still finds
//             real postings. It only reads public pages: no account, no cookie of yours, no write.
//   CLIs      whose whole job is outside (EXTERNAL_CLIS: sending, applying, Feishu, the ego-browser
//             rounds, Jev and the match model) do nothing and answer {"status":"no_change","sandbox":"skipped"}.
// Models (RADAR_SANDBOX_MODELS=1, or --sandbox-models on the command line; 2026-09-30): text-model calls
//           may run, so tests and demos exercise the real model paths. Only inside modelCall() — lib/model.mjs
//           infer, lib/chat.mjs complete, lib/judge.mjs (Jev) and the free-quota relay (lib/free-model.mjs) — and
//           only these: a fetch to a text-model provider, `codex exec` with the text-only arguments and the
//           official OpenAI provider pinned (lib/text-cli.mjs pinnedTextCodex), and `claude -p` with the
//           text-only arguments (pinnedTextClaude). Everything else above stays refused: executors, the
//           browser / ego / computer use, Feishu, mail, submits, auto-repair, `open`. The calls spend the
//           quota of whoever runs it (their CODEX_HOME, their keys, the free-quota relay's points).
// Every refusal leaves one line "sandbox: skipped <what>" in state/events.ndjson (运行日志). The
// entry points a demo clicks through — open a page, a Feishu Base update, computer use, the send /
// apply kicks, System repair, the concierge sync, the Feishu listener, chat — ask sandboxed()
// themselves and answer with the receipt the flow expects, so a demo never shows a crash.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { event } from './events.mjs';
import { pinnedTextCodex, pinnedTextClaude } from './text-cli.mjs';

const cp = createRequire(import.meta.url)('node:child_process');
const SRC = fileURLToPath(new URL('../', import.meta.url));
export const MARKER = 'state/sandbox.json';
const TRUTHY = /^(1|true|yes|on)$/i;
let on = false, installed = false;

export function sandboxed() {
  if (on) return true;
  if (!TRUTHY.test(String(process.env.RADAR_SANDBOX || '').trim()) && !process.argv.includes('--sandbox')
    && !fs.existsSync(path.join(process.env.RADAR_ROOT || SRC, MARKER))) return false;
  on = true;
  process.env.RADAR_SANDBOX = '1';
  install();
  return true;
}

// 沙盒里开着模型：沙盒本身开着，并且 RADAR_SANDBOX_MODELS=1（或命令行有 --sandbox-models）。只看环境和命令行，
// 不看演示目录里的标记：调模型花的是跑的人自己的额度，每次都要明说。开了就交给子进程（环境变量）。
export function sandboxModels() {
  if (!sandboxed()) return false;
  if (!TRUTHY.test(String(process.env.RADAR_SANDBOX_MODELS || '').trim()) && !process.argv.includes('--sandbox-models')) return false;
  process.env.RADAR_SANDBOX_MODELS = '1';
  return true;
}

// One line per refusal. A timer that retries the same thing does not repeat it for 10 minutes.
const said = new Map();
export function sandboxSkip(what, { actor = 'system', lead_id = null } = {}) {
  const msg = `sandbox: skipped ${String(what).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  const key = `${actor}\n${msg}`, now = Date.now();
  if (!(said.get(key) > now - 600000)) {
    said.set(key, now);
    try { event(actor, 'sandbox', 'skip', msg, lead_id ? { lead_id } : {}); } catch {} // 兜底：记事件本身失败，挡下来这件事照样挡下来（不对外）
    if (process.stderr.isTTY) process.stderr.write(msg + '\n');
  }
  return msg;
}
// The same line, as the error a caller that expected the real thing gets.
export const sandboxError = (what, opts) => Object.assign(new Error(sandboxSkip(what, opts)), { code: 'ESANDBOX', sandbox: true });

// Explicit exceptions, for the block they wrap only:
//   publicRead  read-only public job-board fetches (lib/ats/http.mjs, and curl for its proxy route);
//   localOnly   local tools on a local file (resume text extraction: pdftotext, textutil, osascript + PDFKit);
//   modelCall   one text-model call (lib/model.mjs infer, lib/chat.mjs complete, lib/judge.mjs): with
//               sandboxModels() on, a fetch, a pinned text-only `codex exec` or `claude -p` run; with it off, nothing changes;
//   ownWorkbench the phone gateway asking this machine's own workbench (lib/phone/gateway.mjs): plain http to
//               127.0.0.1 / localhost / ::1 only — anything else inside it is refused like everywhere else.
const scope = new AsyncLocalStorage();
export const publicRead = fn => scope.run('public-read', fn);
export const localOnly = fn => scope.run('local', fn);
export const modelCall = fn => scope.run('model', fn);
export const ownWorkbench = fn => scope.run('loopback', fn);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function loopbackTarget(args) {
  const a = args[0], o = args.find(x => x && typeof x === 'object' && !(x instanceof URL) && typeof x !== 'function') || {};
  if (o.socketPath || o.agent || o.lookup || o.createConnection) return false; // 能把连接引到别处的选项一律不认
  let host = null;
  try { if (typeof a === 'string' || a instanceof URL) host = new URL(a).hostname; } catch { return false; } // 兜底：网址解析不了就不算本机地址，照样拦（宁可多拦）
  return LOOPBACK.has(String(o.hostname ?? o.host ?? host ?? '')); // 和 Node 一样：选项里的主机名优先于网址里的
}
const CODEX_NAMES = () => new Set(['codex', path.basename(String(process.env.RADAR_CODEX_BIN || 'codex'))]);
const CLAUDE_NAMES = () => new Set(['claude', path.basename(String(process.env.RADAR_CLAUDE_BIN || 'claude'))]);

// Local, read-only tools the product needs with the sandbox on.
const GIT_READS = new Set(['ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'status', 'diff', 'log', 'show', 'grep', 'check-ignore', 'config']);
const gitCommand = a => { for (let i = 0; i < a.length; i++) { if (a[i] === '-C' || a[i] === '-c') i++; else if (!a[i].startsWith('-')) return i; } return -1; };
const LOCAL_TOOLS = {
  launchctl: a => a[0] === 'list',               // which launchd jobs are loaded (the command center)
  pgrep: () => true, ps: () => true,             // is an executor still alive
  scutil: a => a[0] === '--get',                 // the machine's name (lib/run-host.mjs)
  git: a => { const i = gitCommand(a); return i >= 0 && GIT_READS.has(a[i]) && !(a[i] === 'config' && a.length - i > 2); }, // bin/publish-check.mjs
  tar: () => true,                               // export / import bundles stay on disk (lib/migrate.mjs)
};
function verdict(file, args) {
  const name = path.basename(String(file));
  if (file === process.execPath || name === 'node') return 'node';
  const s = scope.getStore();
  if (s === 'local') return 'local';
  if (s === 'public-read' && name === 'curl') return 'public-read';
  if (s === 'model' && sandboxModels()) {
    if (CODEX_NAMES().has(name) && pinnedTextCodex(args.map(String))) return 'model';
    if (CLAUDE_NAMES().has(name) && pinnedTextClaude(args.map(String))) return 'model';
  }
  // 本机 AI 的检测（lib/local-runtimes.mjs）：只问版本和登录状态，不调模型。
  const a = args.map(String);
  if ((CLAUDE_NAMES().has(name) && (a.join(' ') === '--version' || a.join(' ') === 'auth status')) || (CODEX_NAMES().has(name) && (a.join(' ') === '--version' || a.join(' ') === 'login status'))) return 'local';
  return LOCAL_TOOLS[name]?.(a) ? 'local' : null;
}
// "lark-cli base +record-upsert", "codex exec", "zsh bin/host/run-now.sh": the program and its first
// words, without flag values (profile names, scripts, prompts).
function describe(file, args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const a = String(args[i]);
    if (a.startsWith('-') || (i && String(args[i - 1]).startsWith('-'))) continue;
    words.push(a.length > 48 ? a.slice(0, 48) + '…' : a);
  }
  if (!words.length && args.length) words.push(...args.slice(0, 2).map(a => String(a).slice(0, 24)));
  return [path.basename(String(file)), ...words].join(' ');
}

// node children run sandboxed: the mode in their environment, this module preloaded.
const PRELOAD = `--import=${import.meta.url}`;
const withPreload = (opts = '') => String(opts).includes(PRELOAD) ? String(opts) : `${opts} ${PRELOAD}`.trim();
const envPairs = (pairs = []) => {
  const opts = (pairs.find(p => p.startsWith('NODE_OPTIONS=')) || 'NODE_OPTIONS=').slice(13);
  return [...pairs.filter(p => !/^(RADAR_SANDBOX|NODE_OPTIONS)=/.test(p)), 'RADAR_SANDBOX=1', `NODE_OPTIONS=${withPreload(opts)}`];
};
const nodeOptions = (options = {}) => { const env = { ...(options?.env || process.env), RADAR_SANDBOX: '1' }; env.NODE_OPTIONS = withPreload(env.NODE_OPTIONS); return { ...options, env }; };

// A refused child: what a program that printed the reason and exited 1 looks like — events, pipes,
// exit code — except that nothing was started (no pid; kill / ref / unref do nothing).
function notStarted(child, options, message) {
  const s = options.stdio, kinds = (typeof s === 'string' ? [s, s, s] : Array.isArray(s) ? [...s] : []);
  for (let i = 0; i < Math.max(3, kinds.length); i++) kinds[i] ??= i < 3 ? 'pipe' : 'ignore';
  child.spawnfile = options.file;
  child.spawnargs = options.args || [];
  child._handle = null;
  child.stdio = kinds.map(k => k === 'pipe' || k === 'overlapped' ? new PassThrough() : null);
  [child.stdin, child.stdout, child.stderr] = child.stdio;
  process.nextTick(() => {
    // The reason goes where the program's stderr would: the pipe, a log file, or ours.
    if (child.stderr) child.stderr.end(message + '\n');
    else if (typeof kinds[2] === 'number') { try { fs.writeSync(kinds[2], message + '\n'); } catch {} } // 兜底：写不进调用方给的日志文件也不影响拦下来；原因在返回里
    else if (kinds[2] === 'inherit') process.stderr.write(message + '\n');
    child.stdin?.resume(); // whatever the caller writes is dropped, never an error
    const outs = child.stdio.slice(1).filter(Boolean);
    for (const o of outs) if (o !== child.stderr) o.end();
    child.exitCode = 1;
    child.emit('exit', 1, null);
    let open = outs.length;
    const close = () => { if (--open <= 0) child.emit('close', 1, null); };
    if (!open) process.nextTick(() => child.emit('close', 1, null));
    for (const o of outs) { o.once('end', close); o.resume(); } // like Node, unread output is drained
  });
}
function refusedRequest(message) {
  const req = new PassThrough();
  Object.assign(req, { setHeader() {}, getHeader() {}, getHeaders: () => ({}), removeHeader() {}, hasHeader: () => false, flushHeaders() {}, setNoDelay() {}, setSocketKeepAlive() {}, setTimeout: () => req, abort: () => req.destroy() });
  req.resume();
  process.nextTick(() => req.emit('error', Object.assign(new Error(message), { code: 'ESANDBOX', sandbox: true })));
  return req;
}
function requestTarget(args) {
  const a = args[0], o = args.find(x => x && typeof x === 'object' && !(x instanceof URL) && typeof x !== 'function') || {};
  try { const u = typeof a === 'string' || a instanceof URL ? new URL(a) : null; if (u) return `${(o.method || 'GET').toUpperCase()} ${u.host}${u.pathname}`; } catch {} // 兜底：网址解析不了就只写「调用了」，照样拦
  return `${(o.method || 'GET').toUpperCase()} ${o.hostname || o.host || '?'}${o.path ? String(o.path).split('?')[0] : ''}`;
}

function install() {
  if (installed) return;
  installed = true;
  // Programs: every async child (spawn, execFile, exec, fork — also promisified copies taken earlier)
  // goes through ChildProcess.prototype.spawn; the sync ones are replaced one by one.
  const spawnReal = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function spawn(options) {
    const args = (options.args || []).slice(1), v = verdict(options.file, args);
    if (v === 'node') options.envPairs = envPairs(options.envPairs);
    if (v) return spawnReal.call(this, options);
    return notStarted(this, options, sandboxSkip(describe(options.file, args)));
  };
  const real = { spawnSync: cp.spawnSync, execFileSync: cp.execFileSync, execSync: cp.execSync };
  const split = (a, o) => Array.isArray(a) ? [a, o] : [[], a];
  const output = (options, message) => { const enc = options?.encoding && options.encoding !== 'buffer'; const out = t => enc ? t : Buffer.from(t); return [out(''), out(message + '\n')]; };
  const refuse = (what, options) => { const message = sandboxSkip(what), [stdout, stderr] = output(options, message); return Object.assign(new Error(`Command failed: ${what}\n${message}`), { status: 1, signal: null, pid: 0, output: [null, stdout, stderr], stdout, stderr, sandbox: true }); };
  cp.spawnSync = function spawnSync(file, a, o) {
    const [args, options] = split(a, o), v = verdict(file, args);
    if (v) return real.spawnSync.call(this, file, args, v === 'node' ? nodeOptions(options) : options);
    const { status, signal, pid, output: out, stdout, stderr } = refuse(describe(file, args), options);
    return { status, signal, pid, output: out, stdout, stderr };
  };
  cp.execFileSync = function execFileSync(file, a, o) {
    const [args, options] = split(a, o), v = verdict(file, args);
    if (v) return real.execFileSync.call(this, file, args, v === 'node' ? nodeOptions(options) : options);
    throw refuse(describe(file, args), options);
  };
  // A shell command line: nothing in the product needs one, so none runs in the sandbox.
  cp.execSync = function execSync(command, options) { throw refuse(describe('sh', String(command).trim().split(/\s+/)), options); };
  // Network: refused unless inside publicRead().
  const fetchReal = globalThis.fetch;
  globalThis.fetch = function fetch(input, init) {
    if (scope.getStore() === 'public-read' || (scope.getStore() === 'model' && sandboxModels())) return fetchReal(input, init);
    let target = String(input?.url ?? input);
    try { const u = new URL(target); target = u.host + u.pathname; } catch {} // 兜底：网址解析不了就用原样的写法
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    return Promise.reject(Object.assign(new TypeError(sandboxSkip(`fetch ${method} ${target}`)), { code: 'ESANDBOX', sandbox: true }));
  };
  for (const [mod, scheme] of [[http, 'http'], [https, 'https']]) for (const name of ['request', 'get']) {
    const fn = mod[name];
    mod[name] = function (...args) { return scope.getStore() === 'public-read' || (scope.getStore() === 'loopback' && scheme === 'http' && loopbackTarget(args)) ? fn.apply(this, args) : refusedRequest(sandboxSkip(`${scheme} ${requestTarget(args)}`)); };
  }
  // `import { execFileSync } from 'node:child_process'` (and https.request …) see the replacements too.
  syncBuiltinESMExports();
}

// CLIs whose whole job is outside this machine: with the sandbox on they stop before doing
// anything and answer the way a round with nothing to do does (bin/cycle.mjs, the ops panel and the
// workbench read it). The others run; their outside calls meet the gate above.
const EXTERNAL_CLIS = {
  'send-dm.mjs': ['postman', '在平台上发私信（浏览器）'],
  // RADAR_APPLY=dry：只读公开的申请表问题、走到终审就停，从不提交（lib/apply-dry.mjs），沙盒里照常跑。
  'auto-apply.mjs': ['postman', '执行已批准的投递（浏览器 / 电脑操作）', () => /^dry$/i.test(String(process.env.RADAR_APPLY || '').trim())],
  'computer-use.mjs': ['postman', '电脑操作（Codex）'],
  'operator.mjs': ['postman', '内置操作员（浏览器 + 模型）'],
  'find-referrers.mjs': ['postman', '找内推人（浏览器、Jev）'],
  'discover-human-browser.mjs': ['radar', '在已登录的平台上找真人帖（浏览器）'],
  // RADAR_JUDGE=offline：用离线规则判断（lib/judge-offline.mjs），不联网，沙盒里照常跑。
  // RADAR_SANDBOX_MODELS=1：判断照常调 Jev / 文字模型（sandboxModels）。
  'judge-leads.mjs': ['radar', 'Jev 判断（岗位发给 Jev 接口）', () => /^offline$/i.test(String(process.env.RADAR_JUDGE || '').trim()) || sandboxModels()],
  'calibrate-jev.mjs': ['radar', 'Jev 校准'],
  'match.mjs': ['radar', '匹配（调用模型）', () => sandboxModels()],
  'browser-tidy.mjs': ['heartbeat', '收拾浏览器'],
};
function externalCli() {
  let entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  try { entry = fs.realpathSync(entry); } catch {} // a demo root links bin/ to this checkout (bin/demo-seed.mjs) // 兜底：不是软链就用原路径
  if (path.dirname(entry) !== path.join(fs.realpathSync(SRC), 'bin')) return;
  const [actor, what, local] = EXTERNAL_CLIS[path.basename(entry)] || [];
  if (!what || local?.(process.argv)) return;
  const message = sandboxSkip(what, { actor });
  try { fs.writeSync(1, JSON.stringify({ status: 'no_change', sandbox: 'skipped', reason: message }) + '\n'); } catch {} // 兜底：标准输出关了也照样退出，不对外
  process.exit(0);
}
if (sandboxed()) externalCli();
