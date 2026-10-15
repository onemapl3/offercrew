// 桌面版：代码在 App 包里（只读），数据在 ~/Library/Application Support/OfferCrew。
// 不改五十多处相对路径 bin/…，而是在数据目录里把引擎「挂上」：纯代码的目录整个链接回代码目录，
// 随代码走的规则、提示词和 *.example.* 模板逐个文件链接；个人配置、candidate 里的个人资料、
// state、runs、private 是数据目录自己的真文件。store.write() 先写临时文件再改名，改名会替换掉
// 链接本身，不会写穿到代码里。每次启动都重挂一遍：App 挪了位置或升级后，旧链接自动改指。
import fs from 'node:fs';
import path from 'node:path';

export const ENGINE_ENTRIES = ['bin', 'lib', 'web', 'skills', 'docs', 'node_modules', 'package.json'];
// 随代码走的文件 = config/ 和 candidate/ 下所有 *.example.* 模板（含子目录）
// + 这张名单里不是模板的共享规则和提示词。模板按规则自动收，别的分支加模板不用改这里；加了新的非模板
// 共享文件，tests/data-root.test.mjs 会提醒把它写进名单。开发检出里的个人文件（config/host.json、
// candidate/facts.yaml……）都不是模板、也不在名单上，所以不会被链进数据目录。
export const SHARED_NAMED = [
  'candidate/README.md', 'config/accounts.json', 'config/judge.json',
  'config/match-schema.json', 'config/publish-check.json', 'config/quality-rules.json',
  'config/run-now-prompt.md', 'config/schedule.json',
  'config/system-fix-playbook.md', 'config/tracker-fields.json',
  // 六位成员的岗位说明书和对账表（lib/crew.mjs 读代码树里的这一份；链进数据目录是给看设置、翻文件的人）
  ...['shared', 'scout', 'lens', 'tailor', 'quill', 'owl', 'patch'].map(f => `config/crew/${f}.md`), 'config/crew/rules-map.json',
];
const TEMPLATE = /\.example\.[A-Za-z0-9]+$/;
function templates(code, dir) {
  let out = [];
  let items = [];
  try { items = fs.readdirSync(path.join(code, dir), { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const rel = `${dir}/${it.name}`;
    if (it.isDirectory()) out = out.concat(templates(code, rel));
    else if (TEMPLATE.test(it.name)) out.push(rel);
  }
  return out;
}
export const sharedFiles = (code) => [...SHARED_NAMED.filter(f => fs.existsSync(path.join(code, f))), ...templates(code, 'config'), ...templates(code, 'candidate')].sort();

const fail = (code, message) => Object.assign(Error(message), { code });

// 一项：没有就建链接；是指向别处的链接就改指；是真文件就保留（用户自己的）；是真目录就拒绝。
function place(target, link, rel, out) {
  let st = null;
  try { st = fs.lstatSync(link); } catch {} // 兜底：不在就是没有，下一行建链接
  if (!st) { fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(target, link); out.linked.push(rel); return; }
  if (st.isSymbolicLink()) {
    if (fs.readlinkSync(link) === target) return;
    fs.unlinkSync(link); fs.symlinkSync(target, link); out.relinked.push(rel); return;
  }
  if (st.isDirectory()) throw fail('data_root_is_checkout', `数据目录里的 ${rel} 是一个真目录，这里像是一份代码检出，不能当数据目录用：${link}`);
  out.kept.push(rel);
}

export function linkEngine({ code, data }) {
  const c = fs.realpathSync(code);
  fs.mkdirSync(data, { recursive: true });
  const d = fs.realpathSync(data);
  if (c === d) throw fail('same_root', `数据目录不能就是代码目录：${d}`);
  // 先整体检查再动手：发现是代码检出就一件都不改。
  for (const e of ENGINE_ENTRIES) { try { const st = fs.lstatSync(path.join(d, e)); if (st.isDirectory() && !st.isSymbolicLink()) throw fail('data_root_is_checkout', `数据目录里的 ${e} 是一个真目录，这里像是一份代码检出，不能当数据目录用：${path.join(d, e)}`); } catch (err) { if (err.code === 'data_root_is_checkout') throw err; } }
  const out = { linked: [], kept: [], relinked: [] };
  for (const e of ENGINE_ENTRIES) place(path.join(code, e), path.join(d, e), e, out);
  for (const f of sharedFiles(code)) place(path.join(code, f), path.join(d, f), f, out);
  return out;
}

// Mac 版的默认模型（10-02 主会话）：文字模型、看图模型、对话底座的清单里不放这台电脑上的 Claude Code、Codex——它们只有你在
// 引导或设置里明确选了才进来（lib/onboarding.mjs useLocalModel、设置 → 模型）。默认就是免费额度：引导「模型」一步点下一步
// 或跳过时接上（web/onboarding.js skipTakesFree）；接不上（额度用完、连不上）就是没有模型，不悄悄换成本机的。以前数据目录
// 照模板 config/model.example.json、config/chat.example.json 读，新装一上来就排着本机的两个，免费额度开了也把它们留作后备
// （免费额度被拒时，对话、判断就悄悄换成这台电脑自己登录的 Codex）。命令行安装不经过这里，照旧读模板（装的人是开发者）。
// 只在数据目录里还没有这份文件时写：你保存过的不动。
export const DESKTOP_DEFAULTS = {
  'config/model.json': t => ({ ...t, text: { ...(t.text || {}), driver: 'backends', backends: [] }, vision: { ...(t.vision || {}), driver: 'backends', backends: [] } }),
  'config/chat.json': t => ({ ...t, default: null, backends: [], models: [] }),
};
export function seedDesktopDefaults({ code, data }) {
  const seeded = [];
  for (const [rel, make] of Object.entries(DESKTOP_DEFAULTS)) {
    const dest = path.join(data, rel);
    let st = null;
    try { st = fs.lstatSync(dest); } catch {} // 兜底：不在就是没有，下面建默认的
    if (st) continue;
    let t = {};
    try { t = JSON.parse(fs.readFileSync(path.join(code, rel.replace(/\.json$/, '.example.json')), 'utf8')) || {}; } catch {} // 兜底：模板读不出就从空的建默认设置
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(make(t), null, 2) + '\n');
    seeded.push(rel);
  }
  return seeded;
}

// 数据目录是哪个版本的 App 写的（主会话 10-03：拦住所有降级的路）。旧 App 打开新版写过的数据，新版做过的迁移它不一定读得懂：
// 这时不挂引擎、不写任何东西，由外壳说清楚「请打开新版」。核心与预发布版本的排序和 desktop/lib/versions.mjs 一致。
// 文件读坏了（几乎不会：先写临时文件再改名）当作没记过，重新记——不因为一个记版本的小文件把人挡在外面。
export const DATA_VERSION_FILE = 'state/app-version.json';
const vparts = v => String(v ?? '').trim().split(/[-+]/)[0].split('.').map(n => Number.parseInt(n, 10) || 0);
const prerelease = v => {
  const s = String(v ?? '').trim().split('+')[0], i = s.indexOf('-');
  return i < 0 ? null : s.slice(i + 1).split('.');
};
export function compareVersions(a, b) {
  const x = vparts(a), y = vparts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  const p = prerelease(a), q = prerelease(b);
  if (!p || !q) return p ? -1 : q ? 1 : 0;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn !== qn) return pn ? -1 : 1;
    if (pn) {
      const d = BigInt(p[i]) - BigInt(q[i]);
      if (d) return d > 0n ? 1 : -1;
    } else return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}
export function storedDataVersion(data) {
  try { const v = JSON.parse(fs.readFileSync(path.join(data, DATA_VERSION_FILE), 'utf8'))?.version; return typeof v === 'string' && /^\d+(\.\d+)*/.test(v) ? v : null; }
  catch { return null; } // 兜底：读坏了当作没记过、重新记（上面的注释）：不因为一个记版本的小文件把人挡在外面
}
// { ok, stored }：stored 比 version 新就是 ok: false。
export function dataVersionCheck({ data, version }) {
  const stored = storedDataVersion(data);
  return { ok: !stored || compareVersions(stored, version) <= 0, stored };
}
// 记下这次的版本（只往新里记）：先写临时文件再改名。
export function recordDataVersion({ data, version, now = new Date() }) {
  const stored = storedDataVersion(data);
  if (stored && compareVersions(stored, version) > 0) return false;
  const p = path.join(data, DATA_VERSION_FILE), tmp = `${p}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version, at: now.toISOString() }) + '\n');
  fs.renameSync(tmp, p);
  return true;
}
