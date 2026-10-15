// 整套配置搬到另一台机器：导出一个 tar.gz，在新机器导入。
//
// 包里有什么由两个开关决定：
//   基础       config/、candidate/、私有凭据（private/*.auth.json、private/claude-config/settings.json）、
//              ~/.codex/config.toml（供应商定义，含中转的 bearer）、记忆库、偏好表、学到的规则
//   --with-state   再加 state/ 里的业务状态（线索、草稿、外发回执、反馈……；不含备份、缓存、日志）
//   --with-logins  再加登录态：~/.codex/auth.json 与 private/accounts/**（Claude 官方订阅的登录态在钥匙串里，
//                  带不走，新机器上要重新 `claude auth login`）
// 导入时逐个文件备份旧的到 state/backups/migration-<时间>/，再覆盖；--take-over 把 run_host 改成新机器的
// 主机名（旧机器要 launchctl bootout，否则两台同时跑）。
// 软链（桌面版数据目录里 lib/data-root.mjs linkEngine 挂进来的引擎和模板）一律不跟：*.example.* 模板随代码走，
// 导出、导入都跳过；导出不打包路径上有软链的文件；导入时目标或备份路径上有软链就整包停下、一个文件都不写，
// 否则 copyFileSync 会顺着软链写进代码目录（Mac 版是签名的 App 包，开发机是仓库）。唯一的例外：目标正是
// linkEngine 链进来的共享文件（如 config/schedule.json），就像 store.write 那样改名把这条软链换成用户的真文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from './spawn.mjs';
import { fileURLToPath } from 'node:url';
import { file, read, write, root } from './store.mjs';
import { codexHome } from './backends.mjs';
import { event } from './events.mjs';
import { TZ } from './tz.mjs';
import { BRAND } from './brand.mjs';
import { sharedFiles } from './data-root.mjs';

const iso = x => new Date(x).toISOString();
const stamp = () => iso(Date.now()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const walk = (dir, filter = () => true, base = dir) => { const out = []; if (!fs.existsSync(dir)) return out; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) out.push(...walk(p, filter, base)); else if (filter(path.relative(base, p), p)) out.push(p); } return out; };
const STATE_SKIP = /^(backups|judge-cache|sample|chat|ops\.json|.*\.(out|err|log|lock)$)/;
const TEMPLATE = /\.example\.[A-Za-z0-9]+$/;
const isTemplate = rel => TEMPLATE.test(path.basename(rel));
// 从 base 往下逐级 lstat 到 abs：哪一级是软链就返回那一级，都不是（或后面几级还不存在）返回 null。
function linkOnPath(base, abs) {
  let cur = base;
  for (const part of path.relative(base, abs).split(path.sep)) {
    cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch { return null; } // 兜底：不在就是没有
    if (st.isSymbolicLink()) return cur;
  }
  return null;
}
// 代码根目录：和 bin/data-root.mjs 挂引擎时用的同一个（Node 加载模块时已经解开软链，所以是真正的代码目录）。
const CODE = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
// dest 是不是 linkEngine 链进来的那条：realpath 落在代码根目录里、正好是同一个相对路径、而且在 sharedFiles 名单上。
function sharedLink(dest, rel, code) {
  try { const c = fs.realpathSync(code); return path.relative(c, fs.realpathSync(dest)) === rel && sharedFiles(code).includes(rel); } catch { return false; } // 兜底：路径解析不了就不算共享的那一份
}
const inside = (base, abs) => { const r = path.relative(base, abs); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

// 组包清单：{ kind: 'repo'|'home', rel, abs }。repo 的 rel 相对仓库根；home 的 rel 相对用户目录。
export function bundleItems({ withState = false, withLogins = false } = {}) {
  const items = [];
  const addRepo = (abs) => { if (isTemplate(abs) || linkOnPath(root, abs)) return; if (fs.existsSync(abs) && fs.statSync(abs).isFile()) items.push({ kind: 'repo', rel: path.relative(root, abs), abs }); };
  for (const p of walk(file('config'))) addRepo(p);
  for (const p of walk(file('candidate'))) addRepo(p);
  for (const p of walk(file('private'), rel => /\.auth\.json$/.test(rel))) addRepo(p);
  addRepo(file('private/claude-config/settings.json'));
  for (const p of walk(file('state/memory'))) addRepo(p);
  for (const rel of ['state/preferences.json', 'state/learned-prefilters.json', 'state/company-contacts.json', 'state/discovery-sources.json']) addRepo(file(rel));
  if (withState) for (const p of walk(file('state'), rel => !STATE_SKIP.test(rel))) if (!items.some(i => i.abs === p)) addRepo(p);
  if (withLogins) { for (const p of walk(file('private/accounts'))) addRepo(p); }
  const home = codexHome();
  const addHome = (abs) => { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) items.push({ kind: 'home', rel: path.relative(os.homedir(), abs), abs }); };
  addHome(path.join(home, 'config.toml'));
  if (withLogins) addHome(path.join(home, 'auth.json'));
  return items;
}
export function migrationReadme({ withState, withLogins, host }) {
  return `# ${BRAND} 迁移包

来自 ${host}，${iso(Date.now())}。包含：配置、个人事实、私有凭据（网关 token、TypeSafe）、Codex 供应商定义${withState ? '、全部业务状态' : ''}${withLogins ? '、Codex 登录态与多账号目录' : ''}。**里面有密钥，别放到公开的地方。**

## 新机器上的步骤

1. 装 Node 22+、Codex CLI（\`npm i -g @openai/codex\`）、Claude Code；把仓库拉到任意目录（下面用 \`$RADAR\` 指代），\`npm install\`。
2. 导入：\`node bin/migrate.mjs --import <本包路径> --take-over\`（先加 \`--dry-run\` 看会写哪些文件）。\`--take-over\` 会把 config/host.json 的 run_host 改成新机器主机名。
3. 登录态：Codex 官方订阅 \`codex login\`（带了 --with-logins 则已含 ~/.codex/auth.json）；Claude 官方订阅必须重新 \`claude auth login\`（钥匙串里的登录态带不走）；多账号目录各自 \`CODEX_HOME=<目录> codex login\` / \`CLAUDE_CONFIG_DIR=<目录> claude auth login\`。
4. 打开 http://localhost:4321 ，在「模型与参数」看「现在谁在用什么」全部变绿，逐个「测」一遍底座。
`;
}
// log：记一行「导出迁移包」。工作台的下载（GET /api/migrate/export）不记、也不落进数据目录（读请求不写，契约第五节）。
export function exportBundle({ out = null, withState = false, withLogins = false, now = Date.now(), log = true } = {}) {
  const items = bundleItems({ withState, withLogins });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now).replaceAll('-', '');
  const dest = out ? path.resolve(out) : file(`runs/${day}/migrate/radar-bundle-${stamp()}${withState ? '-state' : ''}${withLogins ? '-logins' : ''}.tgz`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-bundle-'));
  const manifest = { created_at: iso(now), host: os.hostname(), node: process.version, with_state: withState, with_logins: withLogins, run_host: read('config/host.json', {}).run_host || null, items: [] };
  for (const it of items) {
    const target = path.join(staging, it.kind, it.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(it.abs, target);
    manifest.items.push({ kind: it.kind, rel: it.rel, bytes: fs.statSync(it.abs).size, sha256: sha(it.abs) });
  }
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(staging, 'MIGRATION.md'), migrationReadme({ withState, withLogins, host: os.hostname() }));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('tar', ['-czf', dest, '-C', staging, '.']);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.chmodSync(dest, 0o600);
  if (log) event('user', 'migrate', 'ok', `导出迁移包 ${path.relative(root, dest)}（${manifest.items.length} 个文件${withState ? '，含状态' : ''}${withLogins ? '，含登录态' : ''}）`);
  return { path: dest, rel: path.relative(root, dest), bytes: fs.statSync(dest).size, items: manifest.items.length, manifest };
}
export function inspectBundle(archive) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-import-'));
  execFileSync('tar', ['-xzf', path.resolve(archive), '-C', tmp]);
  const manifest = read(path.join(tmp, 'manifest.json'), null) ?? JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
  return { dir: tmp, manifest };
}
// 先复制到同目录的新临时文件，再改名过去：改名替换的是路径本身，即使这一刻它变成了软链也不会写穿。
function placeFile(src, dest) {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
  fs.renameSync(tmp, dest);
}
export function importBundle({ archive, dryRun = false, takeOver = false, overwriteCodexConfig = false, code = CODE, now = Date.now() } = {}) {
  if (!archive || !fs.existsSync(archive)) throw Error('找不到迁移包');
  const { dir, manifest } = inspectBundle(archive);
  const backupDir = `state/backups/migration-${stamp()}`;
  const actions = [];
  const writes = [];
  try {
    // 先整包过一遍、算出要写哪些，路径上有软链就停下：一个文件都不写。
    for (const it of manifest.items || []) {
      if (isTemplate(it.rel)) { actions.push({ rel: it.rel, kind: it.kind, action: 'template_skipped' }); continue; }
      const src = path.join(dir, it.kind, it.rel);
      if (!fs.existsSync(src) || fs.lstatSync(src).isSymbolicLink()) { actions.push({ rel: it.rel, kind: it.kind, action: 'missing_in_bundle' }); continue; }
      const dest = it.kind === 'home' ? path.join(os.homedir(), it.rel) : file(it.rel);
      if (it.kind === 'home' ? !/^(config\.toml|auth\.json)$/.test(path.basename(it.rel)) : !inside(root, dest)) throw Error(`迁移包里的 ${it.rel} 不是能导入的位置；没有导入任何文件`);
      let st = null; try { st = fs.lstatSync(dest); } catch {} // 兜底：不在就是没有，下面照常建
      // 链回代码里共享文件的那条软链：内容一样就留着软链（以后升级照样跟着代码走），不一样就改名换成真文件。
      // 不备份：被换掉的只是一条软链，原内容就在代码目录里；删掉导入的这份，下次启动 linkEngine 会重新链回去。
      const shared = it.kind === 'repo' && st?.isSymbolicLink() && sharedLink(dest, it.rel, code) && !linkOnPath(root, path.dirname(dest));
      const link = shared ? null : st?.isSymbolicLink() ? dest : it.kind === 'home' ? null : linkOnPath(root, dest);
      const exists = !!st && !st.isSymbolicLink();
      const same = (exists || shared) && sha(dest) === it.sha256;
      if (same) { actions.push({ rel: it.rel, kind: it.kind, action: 'same' }); continue; }
      if (it.kind === 'home' && /config\.toml$/.test(it.rel) && (exists || link) && !overwriteCodexConfig) { actions.push({ rel: it.rel, kind: it.kind, action: 'kept_existing', note: '已有 ~/.codex/config.toml，未覆盖；要覆盖加 --overwrite-codex-config' }); continue; }
      if (link) throw Error(`${link} 是一个软链，导入会顺着它写到别处；没有导入任何文件`);
      const backup = exists ? file(path.join(backupDir, it.kind, it.rel)) : null;
      const blink = backup && linkOnPath(root, backup);
      if (blink) throw Error(`备份位置 ${blink} 是一个软链；没有导入任何文件`);
      actions.push({ rel: it.rel, kind: it.kind, action: shared ? 'replace_link' : exists ? 'replace' : 'create' });
      writes.push({ it, src, dest, backup });
    }
    if (!dryRun) for (const { it, src, dest, backup } of writes) {
      if (backup) { fs.mkdirSync(path.dirname(backup), { recursive: true }); placeFile(dest, backup); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      placeFile(src, dest);
      if (/auth\.json$|\.auth\.json$|config\.toml$/.test(it.rel)) fs.chmodSync(dest, 0o600);
    }
    let run_host = null;
    if (takeOver) { run_host = os.hostname().split('.')[0]; actions.push({ rel: 'config/host.json', kind: 'repo', action: 'run_host', note: `run_host → ${run_host}` }); if (!dryRun) { const h = read('config/host.json', {}); h.run_host = run_host; write('config/host.json', h); } }
    if (!dryRun) event('user', 'migrate', 'ok', `导入迁移包 ${path.basename(archive)}：${actions.filter(a => ['replace', 'replace_link', 'create'].includes(a.action)).length} 个文件${takeOver ? '，run_host 改为 ' + run_host : ''}`, { refs: [] });
    return { dry_run: dryRun, from: manifest.host, created_at: manifest.created_at, with_state: !!manifest.with_state, with_logins: !!manifest.with_logins, backup_dir: dryRun ? null : backupDir, actions, run_host, next: ['登录：codex login / claude auth login（多账号各自带目录）', '打开工作台「模型与参数」逐个「测」底座'] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
