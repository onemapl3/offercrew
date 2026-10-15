// 「用 ChatGPT 账号登录」（方案附录 H，GET/POST /api/codex）：App 自己装一份官方 codex，用它自己的登录目录登录。
//
// 安装只在用户点了之后做：从 OpenAI 的 GitHub 发布页下载固定版本，先核对大小和 SHA-256（写死在 CODEX_PIN 里），
// 解开后再核对代码签名是 OpenAI 的开发者团队（2DC432GLL2），都对才放到 <数据目录>/tools/codex/<版本>/codex，
// 并链到 tools/bin/codex（lib/tool-path.mjs 让引擎和宿主脚本优先用它）。不装到系统里。
// 登录用官方的 `codex login`，登录目录是账号 openai@app 的目录（lib/backends.mjs addAccount）：浏览器里登录，
// 我们只看 `codex login status` 的退出码，从不读、复制、返回登录目录里的文件。登录成功后把它设成默认的文字模型和执行器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn as nodeSpawn } from './spawn.mjs';
import { file, root } from './store.mjs';
import { sandboxed } from './sandbox.mjs';
import { loadProviders, addAccount } from './backends.mjs';
import { current, writeJson, writeModels, writeExecutor } from './local-config.mjs';

export const CODEX_PIN = {
  version: '0.159.0',
  url: 'https://github.com/openai/codex/releases/download/rust-v0.159.0/codex-aarch64-apple-darwin.tar.gz',
  size: 95459324,
  sha256: '976ffe03c2d064ebeb5a900f523c4d4a369f299b5193e2232cfc05a642739d33',
  inner: 'codex-aarch64-apple-darwin',
  team: '2DC432GLL2',
};
export const ACCOUNT = 'openai@app';
const accountHome = () => file(`private/accounts/${ACCOUNT}`);
const appBinary = (pin = CODEX_PIN) => file(`tools/codex/${pin.version}/codex`);
const linkPath = () => file('tools/bin/codex');

const run = (bin, args, { env, timeout = 15000 } = {}) => new Promise((resolve) => {
  execFile(bin, args, { env: env || process.env, timeout, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const onPath = (bin) => String(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, bin)).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return !p.startsWith(file('tools/')); } catch { return false; } }) || null; // 兜底：这个目录里没有或不能执行就看下一个

// 进行中的安装或登录（一个工作台进程里同时只有一件）。
const job = { busy: null, progress: null, login_url: null, error: null, child: null, abort: null };
const done = (error = null) => Object.assign(job, { busy: null, progress: null, login_url: null, child: null, abort: null, error });

export async function codexStatus({ exec = run, which = onPath, pin = CODEX_PIN } = {}) {
  if (sandboxed()) return { available: false, reason: '演示 / 沙盒模式：不装也不登录 Codex', installed: false, version: null, source: null, logged_in: null, busy: null, progress: null, login_url: null, error: null };
  const app = fs.existsSync(appBinary(pin)) ? appBinary(pin) : null, sys = app ? null : which('codex');
  const bin = app || sys;
  let version = app ? pin.version : null, logged_in = null;
  if (bin) {
    if (!version) version = ((await exec(bin, ['--version'])).stdout.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
    const home = accountHome();
    // 只认 App 自己的登录目录（10-02 主会话，开箱第 2 轮 X5 的后续）：这台电脑上原来就登录好的 Codex（~/.codex）是「这台电脑上的
    // Codex」那张卡（lib/onboarding.mjs localModels），不算在这里——以前也算，「ChatGPT 账号」那张卡就把你自己的账号当成了 App 的。
    logged_in = fs.existsSync(home) ? (await exec(bin, ['login', 'status'], { env: { ...process.env, CODEX_HOME: home } })).code === 0 : false;
  }
  return { available: true, reason: null, installed: !!bin, version, source: app ? 'app' : sys ? 'system' : null, logged_in, busy: job.busy, progress: job.progress, login_url: job.login_url, error: job.error };
}

// 签名核对：codesign 验证通过，而且团队是 OpenAI 的。
export async function verifyOpenAISignature(bin, { exec = run, team = CODEX_PIN.team } = {}) {
  if ((await exec('/usr/bin/codesign', ['--verify', '--strict', bin])).code !== 0) return false;
  const info = await exec('/usr/bin/codesign', ['-dv', bin]);
  return new RegExp(`TeamIdentifier=${team}\\b`).test(info.stdout + info.stderr);
}

export function startInstall({ fetch: doFetch = globalThis.fetch, pin = CODEX_PIN, verify = verifyOpenAISignature, exec = run } = {}) {
  if (sandboxed()) throw Object.assign(Error('演示 / 沙盒模式：不装也不登录 Codex'), { status: 409 });
  if (job.busy) throw Object.assign(Error(`正在${job.busy === 'installing' ? '安装' : '登录'}，请稍等`), { status: 409 });
  const ac = new AbortController();
  Object.assign(job, { busy: 'installing', progress: 0, error: null, abort: ac });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offercrew-codex-'));
  (async () => {
    const r = await doFetch(pin.url, { signal: ac.signal });
    if (!r.ok) throw Error(`下载失败（HTTP ${r.status}）`);
    const hash = crypto.createHash('sha256'), out = fs.createWriteStream(path.join(tmp, 'codex.tgz'));
    let got = 0;
    for await (const chunk of r.body) { hash.update(chunk); got += chunk.length; out.write(chunk); job.progress = Math.min(0.99, got / pin.size); }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (got !== pin.size || hash.digest('hex') !== pin.sha256) throw Error('下载的文件和官方发布的校验值对不上，已丢弃');
    if ((await exec('/usr/bin/tar', ['-xzf', path.join(tmp, 'codex.tgz'), '-C', tmp, pin.inner], { timeout: 120000 })).code !== 0) throw Error('解压失败');
    const extracted = path.join(tmp, pin.inner);
    if (!(await verify(extracted, { exec, team: pin.team }))) throw Error('程序的签名不是 OpenAI 的，已丢弃');
    const dest = appBinary(pin);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(extracted, dest);
    fs.chmodSync(dest, 0o755);
    fs.mkdirSync(path.dirname(linkPath()), { recursive: true });
    fs.rmSync(linkPath(), { force: true });
    fs.symlinkSync(dest, linkPath());
  })().then(() => done(), (e) => done(ac.signal.aborted ? '已取消' : String(e.message || e))).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { started: 'install' };
}

// 登录成功：账号 openai@app 设成默认的文字模型（原来的留在后面兜底）和执行器。
export function useAppAccount() {
  if (!loadProviders()[ACCOUNT]) addAccount({ base: 'openai', name: 'app', label: 'ChatGPT 账号（OfferCrew 里登录）' });
  const ref = `${ACCOUNT}/default`;
  const old = (current(root, 'model').text?.backends || []).map((b) => `${b.provider}/${b.model}`).filter((r) => r !== ref);
  writeModels(root, { refs: [ref, ...old] });
  writeExecutor(root, 'codex');
  const host = current(root, 'host');
  host.codex_models = { ...(host.codex_models || {}), chain: [{ provider: ACCOUNT, model: 'default', effort: 'medium' }], fallback: { provider: ACCOUNT, model: 'default' } };
  writeJson(root, 'config/host.json', host);
}

export async function startLogin({ spawn = nodeSpawn, which = onPath, pin = CODEX_PIN, timeoutMs = 600000 } = {}) {
  if (sandboxed()) throw Object.assign(Error('演示 / 沙盒模式：不装也不登录 Codex'), { status: 409 });
  if (job.busy) throw Object.assign(Error(`正在${job.busy === 'installing' ? '安装' : '登录'}，请稍等`), { status: 409 });
  const bin = fs.existsSync(appBinary(pin)) ? appBinary(pin) : which('codex');
  if (!bin) throw Object.assign(Error('还没装 Codex，先点「安装」'), { status: 409 });
  if (!loadProviders()[ACCOUNT]) addAccount({ base: 'openai', name: 'app', label: 'ChatGPT 账号（OfferCrew 里登录）' });
  const child = spawn(bin, ['login'], { env: { ...process.env, CODEX_HOME: accountHome() }, stdio: ['ignore', 'pipe', 'pipe'] });
  Object.assign(job, { busy: 'logging_in', progress: null, login_url: null, error: null, child });
  let text = '';
  const watch = (c) => { text = (text + c).slice(-4000); const m = text.match(/https:\/\/auth\.openai\.com\/\S+/); if (m && !job.login_url) job.login_url = m[0]; };
  child.stdout?.on('data', watch); child.stderr?.on('data', watch);
  const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeoutMs); // 兜底：进程已经退了就不用再停
  timer.unref?.();
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0) { try { useAppAccount(); done(); } catch (e) { done(`登录成功了，但没能设成默认模型：${e.message}`); } return; }
    if (job.error === '已取消') return done('已取消');
    done(/1455|address already in use/i.test(text) ? '登录用的 1455 端口被别的程序占着，关掉它（常见是另一个 codex login）再试' : '没有登录成功，可以再试一次');
  });
  return { started: 'login' };
}

export async function logout({ exec = run, which = onPath, pin = CODEX_PIN } = {}) {
  const bin = fs.existsSync(appBinary(pin)) ? appBinary(pin) : which('codex');
  if (!bin || !fs.existsSync(accountHome())) return { ok: true };
  const r = await exec(bin, ['logout'], { env: { ...process.env, CODEX_HOME: accountHome() } });
  return { ok: r.code === 0 };
}

export function cancel() {
  if (job.abort) job.abort.abort();
  if (job.child) { job.error = '已取消'; try { job.child.kill('SIGTERM'); } catch {} } // 兜底：进程已经退了就不用再停
  return { ok: true };
}

export async function codexAction(action, deps = {}) {
  if (action === 'install') return startInstall(deps);
  if (action === 'login') return startLogin(deps);
  if (action === 'logout') return logout(deps);
  if (action === 'cancel') return cancel();
  throw Object.assign(Error('未知的操作'), { status: 400 });
}
// 测试用：清掉进行中的状态。
export const _resetJob = () => done();
