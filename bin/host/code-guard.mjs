// 代码守卫（09-30，负责人 23:0x：「代码上线之后，不能让它自己改代码。它可以执行代码，但是它不能改代码。」）
// 执行器（Codex / Claude，不带沙箱）跑之前记下代码的样子，跑完再对一遍。代码被改了就：
//   - 把改动存进 runs/<日期>/code-guard/<这一轮>/blocked-code-edit.patch（新加的文件原样放在 new-files/，
//     被换成真文件的提示词链接放在 replaced-links/，清单在 files.json）；
//   - 把代码恢复成跑之前的样子；
//   - 记一条事件（status blocked，不算失败：不进告警，也不会再拉 System 来「修」它），
//     在 state/code-guard/blocked.ndjson 记一笔，收件箱据此出一封信（lib/code-guard.mjs）。
// 「代码」= 代码目录里的 bin/ lib/ web/ skills/ docs/ tests/、config/ 下的 *.md（提示词、说明书）、config/crew/rules-map.json
// 和 package.json。数据照写不管：state/ runs/ private/ candidate/，config/ 下的 json、yaml 设置，node_modules。
//   开发检出（git）：跑的这段时间里有人更新了代码（HEAD 变了，比如 git pull），和新 HEAD 一样的不算改动；
//     跑之前就有的本地改动不动，只把这一轮改的恢复成跑之前的样子。
//   桌面版：代码在 App 包里，数据目录链着它；数据目录里链着提示词的那几个链接被换成了真文件，也算改动：挪走、重新链上。
// 上一轮被强杀、没来得及核对（启动它的进程已经不在了）：下一轮记之前先替它核对。
// 只用 node 自带的模块：执行器要是把 lib/ 改坏了，守卫照样能跑。
// 守卫自己出错就停（兜底清单 E06）：snapshot 有文件存不下、写不了清单，退出码非 0，脚本就不拉起执行器；check 找不到这一轮的
// 快照、或者核对时出错，也退出非 0。两种都记一条 fail 事件（step code-guard）：指挥台的严重告警里看得到，不会悄悄过去。
// 用法（cwd = 数据目录；bin/host/run-now.sh、radar-cycle.sh、mail-poll.sh 调）：
//   node bin/host/code-guard.mjs snapshot <这一轮的名字> [--pid <启动它的进程>]
//   node bin/host/code-guard.mjs check <这一轮的名字>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const DATA = process.cwd();
const CODE = (() => { try { return path.dirname(fs.realpathSync(path.join(DATA, 'lib'))); } catch { return DATA; } })();
const GUARD = path.join(DATA, 'state', 'code-guard');
const DIRS = ['bin', 'lib', 'web', 'skills', 'docs', 'tests'];
export const inScope = rel => DIRS.some(d => rel.startsWith(`${d}/`)) || rel === 'package.json' || rel === 'config/crew/rules-map.json' || /^config\/(?:[^/]+\/)*[^/]+\.md$/.test(rel);
const linkScope = rel => /^config\/(?:[^/]+\/)*[^/]+\.md$/.test(rel) || rel === 'config/crew/rules-map.json';

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`, clock = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const safe = s => String(s || 'run').replace(/[^\w.-]/g, '_').slice(0, 80);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)); };
const sha = buf => crypto.createHash('sha1').update(buf).digest('hex');
const isGit = () => fs.existsSync(path.join(CODE, '.git'));
const gitHead = () => { if (!isGit()) return null; try { return execFileSync('git', ['-C', CODE, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// 代码文件：开发检出按 git（跟踪的 + 没被忽略的新文件），别的布局（桌面版的 App 包）逐个目录走。
function listFiles() {
  if (isGit()) {
    try {
      const out = execFileSync('git', ['-C', CODE, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...DIRS, 'config', 'package.json'], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
      return [...new Set(out.toString('utf8').split('\0').filter(Boolean))].filter(inScope);
    } catch {}
  }
  const out = [];
  const walk = rel => {
    let items = [];
    try { items = fs.readdirSync(path.join(CODE, rel), { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === 'node_modules' || it.name === '.git') continue;
      const r = `${rel}/${it.name}`;
      if (it.isDirectory()) walk(r); else out.push(r);
    }
  };
  for (const d of [...DIRS, 'config']) walk(d);
  if (fs.existsSync(path.join(CODE, 'package.json'))) out.push('package.json');
  return out.filter(inScope);
}
function hashFile(rel) {
  try { const p = path.join(CODE, rel), st = fs.statSync(p); if (!st.isFile()) return null; return { sha: sha(fs.readFileSync(p)), mode: st.mode & 0o777 }; } catch { return null; }
}
const hashAll = () => { const files = {}; for (const rel of listFiles()) { const h = hashFile(rel); if (h) files[rel] = h; } return files; };
// 数据目录里链着代码的提示词（桌面版）：记下链到哪，跑完看它还是不是链接。
function dataLinks() {
  if (CODE === DATA) return {};
  const out = {};
  const walk = rel => {
    let items = [];
    try { items = fs.readdirSync(path.join(DATA, rel), { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const r = `${rel}/${it.name}`;
      if (it.isSymbolicLink() && linkScope(r)) { try { out[r] = fs.readlinkSync(path.join(DATA, r)); } catch {} }
      else if (it.isDirectory()) walk(r);
    }
  };
  walk('config');
  return out;
}
const objectPath = h => path.join(GUARD, 'objects', h);
const manifestPath = run => path.join(GUARD, 'runs', `${safe(run)}.json`);
const alive = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function snapshot(run, pid) {
  // 上一轮被强杀、没来得及核对的，先替它核对（启动它的进程还在的是别的执行器正在跑，不动它）。
  let stale = [];
  try { stale = fs.readdirSync(path.join(GUARD, 'runs')).filter(n => n.endsWith('.json')); } catch {}
  for (const n of stale) { const m = readJson(path.join(GUARD, 'runs', n), null); if (m && m.run !== run && !alive(m.pid)) check(m.run); }
  const files = hashAll();
  // 按内容存一份（同样的内容只存一次）：改了的文件能原样放回去，不靠 git。
  fs.mkdirSync(path.join(GUARD, 'objects'), { recursive: true });
  // 存不下的文件：跑完改了就放不回去，守卫等于没开——整个 snapshot 算失败。
  const unsaved = [];
  for (const [rel, h] of Object.entries(files)) if (!fs.existsSync(objectPath(h.sha))) { try { fs.copyFileSync(path.join(CODE, rel), objectPath(h.sha)); } catch { unsaved.push(rel); } }
  if (unsaved.length) throw Error(`${unsaved.length} 个代码文件没能存下来（${unsaved.slice(0, 3).join('、')}）`);
  if (!Object.keys(files).length) throw Error(`在 ${CODE} 里一个代码文件都没找到`);
  writeJson(manifestPath(run), { run, pid, at: now.toISOString(), code: CODE, head: gitHead(), files, links: dataLinks() });
}

function udiff(label, from, to) {
  const r = spawnSync('diff', ['-u', '-L', `a/${label}`, '-L', `b/${label}`, from || '/dev/null', to || '/dev/null'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.stdout || (r.status === 0 ? '' : `Files a/${label} and b/${label} differ\n`);
}

function check(run) {
  const mp = manifestPath(run), snap = readJson(mp, null);
  if (!snap) return null;
  const files = hashAll(), git = isGit(), head = gitHead(), moved = !!(snap.head && head && head !== snap.head);
  // 开发检出里，往 HEAD 靠的都不算改代码：内容和 HEAD 一样（有人更新了代码，或者把就地改动清掉了），
  // 删掉的是 HEAD 里本来没有的文件（清掉多出来的文件）。null = HEAD 里没有这个文件。
  const blobs = new Map(), headBlob = rel => { if (!blobs.has(rel)) { const r = spawnSync('git', ['-C', CODE, 'show', `HEAD:${rel}`], { maxBuffer: 64 << 20 }); blobs.set(rel, r.status === 0 ? r.stdout : null); } return blobs.get(rel); };
  const atHead = rel => { const b = headBlob(rel); return b ? sha(b) : null; };
  const edits = [];
  for (const [rel, h] of Object.entries(files)) {
    const before = snap.files[rel];
    if (before && before.sha === h.sha) continue;
    if (git && atHead(rel) === h.sha) continue;
    edits.push({ rel, kind: before ? 'changed' : 'added', before: before || null });
  }
  for (const [rel, before] of Object.entries(snap.files)) if (!files[rel] && !(git && atHead(rel) === null)) edits.push({ rel, kind: 'deleted', before });
  const relinks = [];
  for (const [rel, target] of Object.entries(snap.links || {})) {
    let st = null; try { st = fs.lstatSync(path.join(DATA, rel)); } catch {}
    if (!st || !st.isSymbolicLink()) relinks.push({ rel, kind: 'relinked', target, real: !!st });
  }
  fs.rmSync(mp, { force: true });
  if (!edits.length && !relinks.length) return 0;

  const relDir = path.join('runs', day, 'code-guard', `${safe(run)}-${clock}`), dir = path.join(DATA, relDir);
  fs.mkdirSync(dir, { recursive: true });
  let patch = '';
  for (const e of edits) patch += udiff(e.rel, e.before ? objectPath(e.before.sha) : null, e.kind === 'deleted' ? null : path.join(CODE, e.rel));
  for (const r of relinks) patch += udiff(r.rel, path.join(CODE, r.rel), r.real ? path.join(DATA, r.rel) : null);
  fs.writeFileSync(path.join(dir, 'blocked-code-edit.patch'), patch);
  // 还原：改了的、删了的按跑之前存的内容放回去；新加的挪进存档；换成真文件的提示词挪进存档、重新链上。
  const failed = [];
  for (const e of edits) {
    const p = path.join(CODE, e.rel);
    try {
      if (e.kind === 'added') {
        const keep = path.join(dir, 'new-files', e.rel);
        fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.copyFileSync(p, keep); fs.rmSync(p, { force: true });
      } else {
        // HEAD 动过、新版里也有这个文件：放回新版的样子（更新带来的不能跟着退回去）；否则放回跑之前的样子。
        const fresh = moved ? headBlob(e.rel) : null, want = fresh ? sha(fresh) : e.before?.sha;
        if (!want) throw Error('nothing to restore from');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (fresh) fs.writeFileSync(p, fresh); else fs.copyFileSync(objectPath(e.before.sha), p);
        if (e.before) fs.chmodSync(p, e.before.mode);
        if (hashFile(e.rel)?.sha !== want) throw Error('content differs after restore');
      }
    } catch { failed.push(e.rel); }
  }
  for (const r of relinks) {
    const p = path.join(DATA, r.rel);
    try {
      if (r.real) { const keep = path.join(dir, 'replaced-links', r.rel); fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.renameSync(p, keep); }
      fs.symlinkSync(r.target, p);
    } catch { failed.push(r.rel); }
  }
  const list = [...edits, ...relinks].map(e => ({ rel: e.rel, kind: e.kind }));
  writeJson(path.join(dir, 'files.json'), { run, at: now.toISOString(), code: CODE, head_moved: moved, files: list, failed });
  const n = list.length, patchRel = path.join(relDir, 'blocked-code-edit.patch');
  const msg = failed.length ? `本机 AI 这一轮改了 ${n} 个代码文件，${failed.length} 个没能恢复（${failed.slice(0, 3).join('、')}）；改动存在 ${patchRel}` : `本机 AI 这一轮改了 ${n} 个代码文件，已经恢复原样；改动存在 ${patchRel}`;
  const id = `${safe(run)}-${day}${clock}`;
  fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
  fs.appendFileSync(path.join(DATA, 'state', 'events.ndjson'), JSON.stringify({ ts: now.toISOString(), run_id: process.env.RADAR_RUN_ID || run, actor: 'system', step: 'code-guard', status: 'blocked', msg, refs: [{ file: patchRel }] }) + '\n');
  fs.mkdirSync(GUARD, { recursive: true });
  fs.appendFileSync(path.join(GUARD, 'blocked.ndjson'), JSON.stringify({ id, run, at: now.toISOString(), files: list, failed, restored: !failed.length, patch: patchRel, dir: relDir }) + '\n');
  return n;
}

// 守卫自己出错：记一条 fail 事件（指挥台的严重告警），stderr 写原因，退出码非 0。
function failed(run, msg) {
  try {
    fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
    fs.appendFileSync(path.join(DATA, 'state', 'events.ndjson'), JSON.stringify({ ts: new Date().toISOString(), run_id: process.env.RADAR_RUN_ID || run, actor: 'system', step: 'code-guard', status: 'fail', msg, refs: [] }) + '\n');
  } catch {}
  console.error(msg);
}
const [mode, run, ...rest] = process.argv.slice(2);
const pidArg = rest.indexOf('--pid');
const pid = pidArg >= 0 ? Number(rest[pidArg + 1]) : process.ppid;
if (mode === 'snapshot' && run) {
  try { snapshot(run, pid); console.log('snapshot'); }
  catch (e) { failed(run, `代码守卫没能记下代码跑之前的样子（${e.message}），这一次没有拉起本机 AI`); process.exit(1); }
} else if (mode === 'check' && run) {
  let n;
  try { n = check(run); }
  catch (e) { failed(run, `代码守卫核对时出错（${e.message}），本机 AI 这一轮有没有改代码没查成`); process.exit(1); }
  if (n == null) { failed(run, '代码守卫找不到这一轮跑之前的快照，本机 AI 这一轮有没有改代码没法核对'); process.exit(3); }
  console.log(n ? `blocked ${n}` : 'clean');
} else { console.error('usage: code-guard.mjs snapshot|check <run> [--pid <pid>]'); process.exit(2); }
