// 本机配置的读写和找程序（原在 lib/installer/configure.mjs、detect.mjs；命令行安装器 10-04 删掉后，App 还在用的这几样挪到这里）。
//   readJson(dir, rel, fallback) / writeJson(dir, rel, data, { mode }) / current(dir, name)（本机文件，否则模板）
//   writeModels(dir, { refs, vision })   writeExecutor(dir, 'claude' | 'codex' | 'none')   which(bin, env)
import fs from 'node:fs';
import path from 'node:path';

export const readJson = (dir, rel, fallback = null) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return fallback; } };
export function writeJson(dir, rel, data, { mode } = {}) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  if (mode) fs.chmodSync(p, mode);
  return rel;
}
// 本机文件，否则模板。
export const current = (dir, name) => readJson(dir, `config/${name}.json`) ?? readJson(dir, `config/${name}.example.json`, {});

const LABEL = { 'claude_subscription/sonnet': 'Claude · Claude Code 登录 · sonnet', 'openai/default': 'GPT · Codex 登录 · 默认模型' };
const spec = (ref) => { const i = ref.indexOf('/'); return { provider: ref.slice(0, i), model: ref.slice(i + 1) }; };
export function writeModels(dir, { refs, vision = null }) {
  const model = current(dir, 'model'), chat = current(dir, 'chat');
  model.text = { ...(model.text || {}), driver: 'backends', backends: refs.map((r) => ({ ...spec(r), ...(r === 'openai/default' ? { effort: 'medium' } : {}) })) };
  if (vision) model.vision = { ...(model.vision || {}), driver: 'backends', backends: [vision].map((r) => ({ ...spec(r), ...(r === 'openai/default' ? { effort: 'medium' } : {}) })) };
  chat.default = refs[0];
  chat.backends = refs.map((r) => ({ id: r, ...spec(r), ...(r === 'openai/default' ? { effort: 'medium' } : {}), label: LABEL[r] || `${r} · API` }));
  return [writeJson(dir, 'config/model.json', model), writeJson(dir, 'config/chat.json', chat)];
}

// ── 执行器 ──
// claude / codex 写进 config/host.json；none =「以后再说」：执行器先暂停（state/agent-pause.json）。
export function writeExecutor(dir, executor, { now = Date.now() } = {}) {
  const host = current(dir, 'host');
  const files = [];
  if (executor === 'claude') Object.assign(host, { executor: 'claude', claude_provider: 'claude_subscription', models: Array.isArray(host.models) && host.models.length ? host.models : ['sonnet'] });
  if (executor === 'codex') host.executor = 'codex';
  files.push(writeJson(dir, 'config/host.json', host));
  const pauses = readJson(dir, 'state/agent-pause.json', {}) || {};
  if (executor === 'none') pauses.executor = { at: new Date(now).toISOString(), by: 'installer' };
  else if (pauses.executor?.by === 'installer') delete pauses.executor;
  if (executor === 'none' || fs.existsSync(path.join(dir, 'state/agent-pause.json'))) files.push(writeJson(dir, 'state/agent-pause.json', pauses));
  return files;
}

export function which(bin, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {} // 兜底：这里没有或不能执行就看下一个
  }
  return null;
}
