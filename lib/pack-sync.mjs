// App 升级以后，新版自带的公司包里有变化的条目合进你的公司清单（config/companies.yaml）。2026-10-03。
//
// 只看清单里带 preset: 的条目（引导「加入公司包」拷进来的，lib/onboarding.mjs applyCompanyPack），按预设对新版的包：
//   - 包里新加的公司：加进清单，同样标 preset:。判重和加包同一个口径（同名，或同一个招聘系统的同一块板：keyName / boardKey）；
//   - 带标记、你没改过的：包里改了地址、编号这些，跟着改（扫描写回的健康字段不算，见 MACHINE）；
//   - 你改过的：一个字段都不动；
//   - 包里去掉的：不自动删，收件箱里问你（packSyncAsks / answerPackSync）；
//   - 没带 preset: 的（你自己加的）一律不碰；你从清单里删掉的那家，以后也不再加回来。
//
// 「改没改过」看指纹：state/pack-sync.json 里记着每条上次同步进来时的样子（去掉 preset 和扫描写回的字段，键排好序取 sha256）。
// 清单里的现值对不上就算改过。这个版本之前加的包没有指纹：和新版包里一样的补记指纹、以后跟着同步；不一样的算改过，不动。
// 宁可少同步，不改掉你的东西。
//
// 什么时候跑：工作台每次启动、开始监听以后跑一次（bin/serve.mjs，syncPacksOnStart）。不联网、不调模型，只读代码目录里的包、
// 改本机两份文件。每次都跑而不是只在版本号变了时跑：重装、换代码目录、版本号没改的修补包都照样对上，没变化时什么都不写。
// 只在本机已经有 config/companies.yaml、而且里面有带标记的条目时才动；还没走引导的、只有示例清单的不动。
// 写清单拿状态写锁（lib/lock.mjs，和扫描回写、招聘源编辑同一把），在文件现在的文本上改（YAML 文档，注释和别的字段都留着），
// 用 lib/store.mjs 的 write（先写临时文件再改名）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { file, read, write } from './store.mjs';
import { event } from './events.mjs';
import { PRESETS, presetList } from './presets.mjs';
import { HEALTH_FIELDS } from './discovery-source.mjs';

const COMPANIES = 'config/companies.yaml';
const STATE = 'state/pack-sync.json';
const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const str = v => (v == null ? '' : String(v).trim());

// 判重：同名（忽略大小写、空格和标点），或同一个招聘系统的同一块板。引导加包也用这两个（lib/onboarding.mjs）。
export const keyName = s => str(s).normalize('NFKC').toLowerCase().replace(/[\s·.,，()（）-]+/g, '');
export const boardKey = c => (c?.ats_type && c?.board ? `${str(c.ats_type).toLowerCase()}:${str(c.board).toLowerCase()}` : null);
const same = (a, b) => (!!keyName(a?.name) && keyName(a.name) === keyName(b?.name)) || (!!boardKey(a) && boardKey(a) === boardKey(b));

// 不是你写的字段：扫描、核验招聘页时写回清单的（bin/discover.mjs、bin/verify-sources.mjs），和 preset 标记本身。
// 不算进指纹，跟着包改的时候也不碰。
const MACHINE = new Set(['preset', ...HEALTH_FIELDS, 'careers_http_status', 'careers_checked_at', 'careers_error']);
const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
const content = c => Object.fromEntries(Object.entries(c || {}).filter(([k, v]) => !MACHINE.has(k) && v !== undefined));
export const fingerprint = c => crypto.createHash('sha256').update(JSON.stringify(stable(content(c)))).digest('hex');
const eq = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

const COPY = {
  sync: parts => `公司包更新：${parts.join('；')}`,
  part: (name, { added, changed, pending }) => [added ? `${name} +${added} 家` : '', changed ? `跟着包改了 ${changed} 家` : '', pending ? `${pending} 家包里已去掉，等你决定` : ''].filter(Boolean).join('，'),
  parse: msg => `公司包这次没同步：config/companies.yaml 解析失败（${msg}）`,
  failed: msg => `公司包这次没同步：${msg}`,
  busy: '公司包这次没同步：另一个进程在写清单，下次启动再对',
  askTitle: name => `「${name}」公司包去掉了几家`,
  askQuestion: (name, names) => `包里已经去掉 ${names.length} 家：${names.join('、')}。要从你的清单里删掉吗？`,
  removed: n => `从清单里删掉了 ${n} 家`,
  kept: n => `留着这 ${n} 家，不再问`,
  answered: (name, receipt) => `公司包「${name}」：${receipt}`,
  stale: '这几家已经变了，请刷新',
};
const presetName = key => presetList('zh').find(p => p.key === key)?.label || key;

// 新版自带的包：读代码目录里的那一份（不读数据目录里可能留着的旧拷贝）。
function loadPack(preset, code) {
  const rel = PRESETS[preset]?.company_pack;
  if (!rel) return null;
  const src = path.join(code, rel);
  if (!fs.existsSync(src)) return null;
  const raw = YAML.parse(fs.readFileSync(src, 'utf8'));
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.companies) ? raw.companies : [];
  const out = new Map();
  for (const c of items) if (c && typeof c === 'object' && keyName(c.name) && !out.has(keyName(c.name))) out.set(keyName(c.name), c);
  return { rel, entries: out };
}

function loadState() {
  let s = null;
  try { s = read(STATE, null); } catch { s = null; } // 兜底：读坏了就当没同步过，下面整份重新同步
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  if (!s.presets || typeof s.presets !== 'object' || Array.isArray(s.presets)) s.presets = {};
  return s;
}
const codeVersion = code => { try { return JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')).version || null; } catch { return null; } }; // 兜底：读不出版本号就当不知道

// 本机的清单：没有就是 null（还没走引导，不动；示例清单也不动）。解析失败抛出，调用方记日志。
function localDoc() {
  if (!fs.existsSync(file(COMPANIES))) return null;
  const doc = YAML.parseDocument(fs.readFileSync(file(COMPANIES), 'utf8'));
  if (doc.errors.length) throw Object.assign(Error(doc.errors[0].message.split('\n')[0]), { code: 'parse' });
  if (!YAML.isSeq(doc.contents)) throw Object.assign(Error('不是一张公司列表'), { code: 'parse' });
  return doc;
}
const maps = doc => doc.contents.items.filter(YAML.isMap);

// 这个版本之前、没有同步记录时：从运行日志里找你在招聘源页删过的公司（lib/sources.mjs removeSource 记的「招聘源：删了 X」），
// 这些不当成包里新加的再加回来。
function deletedBefore() {
  const out = new Set();
  let text = '';
  try { const f = file('state/events.ndjson'); if (fs.statSync(f).size < 64 * 1024 * 1024) text = fs.readFileSync(f, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('招聘源：删了')) continue;
    try { const m = /^招聘源：删了 (.+)$/.exec(JSON.parse(line).msg || ''); if (m) out.add(keyName(m[1])); } catch {} // 兜底：一行坏了跳过这一行
  }
  return out;
}

// 引导加包时记一笔（lib/onboarding.mjs applyCompanyPack）：加进来的记指纹，包里因为清单里已经有而没加的记「见过」。
// 这是这个预设新的起点：以后包里新加的才算新的，你删掉的不会被加回来。
export function recordPackAdd(preset, entries = [], added = []) {
  const s = loadState(), addedKeys = new Set(added.map(keyName)), out = {};
  for (const c of entries) {
    const k = keyName(c?.name);
    if (!k || out[k]) continue;
    const { preset: _drop, ...rest } = c;
    out[k] = addedKeys.has(k) ? { name: str(c.name), fp: fingerprint(rest) } : { name: str(c.name), seen: true };
  }
  s.presets[preset] = { pack: PRESETS[preset]?.company_pack || null, entries: out, pending: [] };
  write(STATE, s);
}

// 对一个预设。nodes 是清单里现在的每一条（会往 seq 里加）；st 是这个预设上次的记录（没有就是老用户）。
function syncPreset(doc, preset, pack, st, legacyDeleted) {
  const seq = doc.contents, entries = {}, added = [], changed = [], pending = [];
  const prev = st?.entries || {};
  const used = new Set();
  const nodes = () => maps(doc);
  const pick = c => {
    const free = nodes().filter(n => !used.has(n));
    return free.find(n => n.get('preset') === preset && same(n.toJSON(), c)) || free.find(n => same(n.toJSON(), c)) || null;
  };
  for (const [k, c] of pack.entries) {
    const { preset: _drop, ...want } = c, name = str(c.name), old = prev[k];
    const m = pick(c);
    if (!m) {
      // 清单里没有：上次见过（你删了），或老用户在招聘源页删过的，不加回来；别的就是包里新加的。
      if (old || (!st && legacyDeleted().has(k))) { entries[k] = { name, dropped: true }; continue; }
      const node = doc.createNode({ ...want, preset });
      seq.items.push(node); used.add(node);
      entries[k] = { name, fp: fingerprint(want) };
      added.push(name);
      continue;
    }
    used.add(m);
    if (m.get('preset') !== preset) { entries[k] = { name, mine: true }; continue; } // 你自己加的（或别的预设的），不碰
    const cur = fingerprint(m.toJSON()), fp = fingerprint(want);
    if (cur === fp) { entries[k] = { name, fp }; continue; }
    // 上次的指纹：这一家的；包里给它改了名（同一块板）时，用旧名字那一条的。
    const was = old?.fp || (st ? Object.entries(prev).find(([kk, o]) => !pack.entries.has(kk) && o?.fp === cur)?.[1]?.fp : null);
    if (was && was === cur) {
      // 上次同步进来以后你没动过：照新版的包改（扫描写回的字段、preset 标记留着）。
      const now = content(want), have = content(m.toJSON());
      for (const key of Object.keys(have)) if (!(key in now)) m.delete(key);
      for (const [key, v] of Object.entries(now)) if (!eq(have[key], v)) m.set(key, doc.createNode(v));
      entries[k] = { name, fp };
      changed.push(name);
      continue;
    }
    entries[k] = { name, edited: true }; // 你改过，或老用户的和新包不一样：不动
  }
  // 包里去掉的：上次记着指纹、清单里还是那个样子的，等你决定；你说过留着的不再问；改过的、已经删了的不再跟。
  for (const [k, old] of Object.entries(prev)) {
    if (pack.entries.has(k) || !old?.fp) continue;
    const m = maps(doc).find(n => !used.has(n) && n.get('preset') === preset && keyName(n.get('name')) === k);
    if (!m || fingerprint(m.toJSON()) !== old.fp) continue;
    used.add(m);
    entries[k] = old.kept ? { name: old.name, fp: old.fp, kept: true } : { name: old.name, fp: old.fp };
    if (!old.kept) pending.push({ key: k, name: old.name });
  }
  return { state: { pack: pack.rel, entries, pending }, added, changed, pending };
}

// 对一遍，不拿锁（调用方拿）。返回 { status: 'skipped' | 'unchanged' | 'synced', presets }；清单解析失败抛出（err.code = 'parse'）。
export function syncPacks({ code = codeRoot, now = Date.now() } = {}) {
  const doc = localDoc();
  if (!doc) return { status: 'skipped', reason: 'no_local_list' };
  const marked = [...new Set(maps(doc).map(n => n.get('preset')).filter(p => typeof p === 'string' && PRESETS[p]?.company_pack))];
  if (!marked.length) return { status: 'skipped', reason: 'no_preset_entries' };
  const s = loadState(), before = doc.toString(), oldState = JSON.stringify(s.presets);
  let legacy = null;
  const legacyDeleted = () => (legacy ||= deletedBefore());
  const result = {};
  for (const preset of marked) {
    const pack = loadPack(preset, code);
    if (!pack) continue;
    const st = s.presets[preset];
    const r = syncPreset(doc, preset, pack, st && typeof st === 'object' && st.entries ? st : null, legacyDeleted);
    const fresh = r.pending.filter(p => !(st?.pending || []).some(q => q.key === p.key));
    s.presets[preset] = r.state;
    result[preset] = { added: r.added, changed: r.changed, pending: r.pending.map(p => p.name), new_pending: fresh.length };
  }
  const listChanged = doc.toString() !== before, stateChanged = JSON.stringify(s.presets) !== oldState;
  if (listChanged) write(COMPANIES, doc.toString());
  if (listChanged || stateChanged || !s.version) write(STATE, { ...s, version: 1, synced_at: new Date(now).toISOString(), code_version: codeVersion(code) });
  const parts = Object.entries(result).map(([p, r]) => COPY.part(presetName(p), { added: r.added.length, changed: r.changed.length, pending: r.new_pending })).filter(Boolean);
  if (parts.length) event('system', 'pack-sync', 'ok', COPY.sync(parts));
  return { status: listChanged || stateChanged ? 'synced' : 'unchanged', presets: result };
}

// 工作台启动时对一遍。什么错都只记运行日志，不抛出，不挡启动。不拿全局锁（第 2 步·锁退役）：写设置文件经 lib/store.mjs，
// 别的进程同时改了同一个文件会合并，不会互相盖掉。
export async function syncPacksOnStart({ code = codeRoot } = {}) {
  try {
    return syncPacks({ code });
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.code === 'parse') event('system', 'pack-sync', 'fail', COPY.parse(msg.slice(0, 120)));
    else if (msg.includes('another_radar_writer_running')) event('system', 'pack-sync', 'skip', COPY.busy);
    else event('system', 'pack-sync', 'fail', COPY.failed(msg.slice(0, 160)));
    return { status: 'failed', error: msg };
  }
}

// ── 收件箱：包里去掉的，问你删不删 ─────────────────────────────────────────
const askId = (preset, pending) => `packsync:${preset}:${crypto.createHash('sha256').update(pending.map(p => p.key).sort().join('\n')).digest('hex').slice(0, 12)}`;
export function packSyncAsks() {
  const s = loadState();
  return Object.entries(s.presets).filter(([, st]) => Array.isArray(st?.pending) && st.pending.length).map(([preset, st]) => {
    const name = presetName(preset), keys = st.pending.map(p => p.key);
    return {
      from: 'scout', id: askId(preset, st.pending), type: 'info', tag: '公司包',
      title: COPY.askTitle(name), question: COPY.askQuestion(name, st.pending.map(p => p.name)),
      context: ['公司清单'], facts: [],
      options: [
        { key: '1', label: '删掉', steps: [{ type: 'pack_sync', action: 'remove', preset, keys }], danger: true },
        { key: '2', label: '留着', steps: [{ type: 'pack_sync', action: 'keep', preset, keys }], primary: true },
      ],
      other: null,
    };
  });
}

// 「删掉」只删这几条里还带着这个标记、和上次同步时一个样的；「留着」记下，不再问。
export async function answerPackSync({ action, preset, keys = [] } = {}, { timeout = 60000 } = {}) {
  if (!['remove', 'keep'].includes(action) || !PRESETS[preset]) throw Error('没有这个选项');
  const s = loadState(), st = s.presets[preset];
  const asked = new Set(keys.map(String));
  const hit = (st?.pending || []).filter(p => asked.has(p.key));
  if (!hit.length) throw Error(COPY.stale);
  let n = 0;
  if (action === 'remove') {
    const doc = localDoc();
    if (!doc) throw Error(COPY.stale);
    for (const p of hit) {
      const old = st.entries[p.key];
      const m = maps(doc).find(x => x.get('preset') === preset && keyName(x.get('name')) === p.key);
      if (m && old?.fp && fingerprint(m.toJSON()) === old.fp) { doc.contents.items = doc.contents.items.filter(x => x !== m); n++; }
      delete st.entries[p.key];
    }
    if (n) write(COMPANIES, doc.toString());
  } else {
    for (const p of hit) { st.entries[p.key] = { ...st.entries[p.key], kept: true }; n++; }
  }
  st.pending = st.pending.filter(p => !asked.has(p.key));
  write(STATE, s);
  const receipt = action === 'remove' ? COPY.removed(n) : COPY.kept(n);
  event('user', 'pack-sync', 'ok', COPY.answered(presetName(preset), receipt));
  return receipt;
}
