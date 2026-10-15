// 本人点「检查」才调用一次本机 CLI；只问 OK，关闭工具/MCP/钩子，不交办任务、不切文字模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from './spawn.mjs';
import { read, write } from './store.mjs';
import { sandboxed } from './sandbox.mjs';
import { cliPath, localCliPath, localAiRuntimeEnv } from './local-ai-status.mjs';
import { localAiFailure } from './local-ai-errors.mjs';
import { CLAUDE_TEXT_ARGS, codexTextArgs, codexHomeOf } from './text-cli.mjs';
const exec = promisify(execFile), active = new Map();
const fail = (status, message) => Object.assign(Error(message), { status });
export function checkLocalCli(kind, opts = {}) {
  if (!['claude', 'codex'].includes(kind)) throw fail(400, '只能检查 Claude Code 或 Codex');
  if (sandboxed()) throw fail(409, '演示 / 沙盒模式不调用本机 AI');
  if (active.has(kind)) return active.get(kind);
  const p = check(kind, opts).finally(() => active.delete(kind)); active.set(kind, p); return p;
}
async function check(kind, { env = process.env } = {}) {
  const runtimeEnv = localAiRuntimeEnv(kind, { env }), login_source = runtimeEnv === env ? 'local' : 'app_account';
  env = runtimeEnv;
  const executable = cliPath(kind, env);
  let result;
  if (!executable) result = { ok: false, ...localAiFailure(kind, { code: 'ENOENT' }) };
  else {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'offercrew-cli-check-')), childEnv = { ...env, PATH: localCliPath(env) }; delete childEnv.CLAUDECODE;
    try {
      // 禁用设置里的工具/钩子时，仍显式带上 CLI 用户配置的模型凭据与地址，否则会把 key 故障误测成订阅正常。
      if (kind === 'claude') {
        const settings = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
        let conf = {};
        try { conf = JSON.parse(fs.readFileSync(settings, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw fail(400, 'Claude Code 的本机配置读不了，请检查 settings.json'); }
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL']) if (typeof conf.env?.[key] === 'string') childEnv[key] = conf.env[key];
      }
      const args = kind === 'claude' ? ['-p', 'Reply with only OK.', '--max-turns', '1', '--output-format', 'json', ...CLAUDE_TEXT_ARGS]
        : ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...codexTextArgs(codexHomeOf({}, childEnv)), 'Reply with only OK.'];
      const r = await exec(executable, args, { env: childEnv, cwd, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      let data = null; if (kind === 'claude') { try { data = JSON.parse(r.stdout); } catch {} } // 兜底：旧版 CLI 只返回正文，退出码仍是运行结果。
      const reply = String(data?.result ?? r.stdout ?? '').trim();
      result = !reply ? { ok: false, layer: 'response', reason: '本机命令退出了，但没有返回模型回复', remedy: '检查 CLI 的服务配置和运行日志，然后重新检查。' } : data?.is_error ? { ok: false, ...localAiFailure(kind, { code: 1, text: data.result || '' }) } : { ok: true, reason: '本机命令已连通模型服务' };
    } catch (e) {
      result = { ok: false, ...(e.status === 400 ? { layer: 'configuration', reason: e.message, remedy: '修正 CLI 配置后重新检查。' } : localAiFailure(kind, { code: e.killed ? 'ETIMEDOUT' : e.code, text: `${e.stderr || ''}\n${e.stdout || ''}\n${e.message || ''}`, signal: e.signal })) };
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
  result = { kind, at: new Date().toISOString(), source: 'check', scope: 'local_cli', login_source, ...result };
  write('state/local-ai-checks.json', { ...read('state/local-ai-checks.json', {}), [kind]: result });
  return result;
}
