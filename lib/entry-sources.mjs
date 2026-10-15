// 搜好的入口加成你自己的来源（2026-10-03，design/non-tech/实现/搜好的入口界面.md）。
// 引导「渠道」一步和「设置 → 求职偏好 → 渠道」列出按你的方向、细分、城市填好的链接（lib/channel-entries.mjs channelEntries），
// 点一下加成你的来源，再点一下撤掉。
//
// 加过的记在本机的 config/channel-entries.json（不进仓库）：{ <来源键>: { name, preset, added_at } }。
// 为什么不写进现成的两个文件：
//   - config/human-source-policy.json 是「扫描源」：执行器照它扫开着的来源（lib/discovery-policy.mjs「扫描源以它为准」），
//     而且 boss 这个键在那里就是浏览器扫描的开关——入口写进去，就成了让系统去搜猎聘、BOSS；
//   - config/watch-sites.json 是本机 AI 定期用浏览器打开、读出岗位的页面。
// 这些平台要登录、条款不许程序读，红线是「只给入口，不自动抓、不打招呼、不替你登录」，所以入口单独存，系统不读它去扫。
// 只记键，链接每次按你现在的资料现算：改了城市、细分，加过的入口跟着变。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, write, file } from './store.mjs';
import { event } from './events.mjs';
import { PRESETS } from './presets.mjs';
import { DISCOVERY_SOURCES } from './discovery-policy.mjs';
import { channelEntries } from './channel-entries.mjs';
import { noteSwallowed } from './swallow.mjs';

export const ENTRIES_FILE = 'config/channel-entries.json';
const fail = (status, message) => Object.assign(Error(message), { status });
// 渠道包是跟代码一起发的模板：数据目录里有就读那一份，没有就读代码目录里的（同 lib/onboarding.mjs 的 shipped）。
const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadPack(preset) {
  const rel = PRESETS[preset]?.channel_pack;
  if (!rel) return null;
  const src = fs.existsSync(file(rel)) ? file(rel) : path.join(codeRoot, rel);
  try { return JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') noteSwallowed('entry-sources.pack', e, { member: 'scout', doing: `读渠道包 ${rel}`, then: '这个方向先不列入口' }); return null; }
}
// 文件写坏了：页面照样画（当成没加过），保存时报错，不把它盖掉。
function added({ strict = false } = {}) {
  let v;
  try { v = read(ENTRIES_FILE, {}); } catch (e) { if (strict) throw fail(400, `${ENTRIES_FILE} 读不出，请先手动修好`); return {}; }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
const entriesOf = (preset, facts) => { const pack = loadPack(preset); try { return pack ? channelEntries(pack, facts) : []; } catch (e) { noteSwallowed('entry-sources.entries', e, { member: 'scout', doing: '按你的资料算这个方向的入口', then: '先不列入口' }); return []; } };
// 有搜好的入口的方向：渠道包里有不是扫描源的入口（猎聘、智联……）。软件、产品、数据、设计、运营的包里只有 BOSS 一个，
// 它在渠道开关里已经有一行，这几个方向什么都不变。
const hasEntries = list => list.some(e => !Object.hasOwn(DISCOVERY_SOURCES, e.key));

// preset：现在的预设键（没有就是 null）；facts：拿来填链接的资料（方向、细分、目标城市）。
// 返回 null = 这个方向没有入口、你也没加过，页面什么都不画。
export function entriesView(preset, facts = {}) {
  const mine = added();
  let items = entriesOf(preset, facts);
  if (!hasEntries(items)) items = [];
  items = items.map(e => ({ ...e, preset, added: Object.hasOwn(mine, e.key) }));
  // 加过、但现在的方向里没有的（换过方向）：照样列出来，能撤掉；链接按当时那个方向的包现算。
  for (const [key, rec] of Object.entries(mine)) {
    if (items.some(e => e.key === key)) continue;
    const e = entriesOf(rec?.preset, facts).find(x => x.key === key);
    items.push(e ? { ...e, preset: rec.preset, added: true } : { key, name: String(rec?.name || key), preset: rec?.preset || null, enabled: true, requires_login: false, needs_international: false, keywords_in_url: true, keywords: [], why: '', links: [], added: true });
  }
  if (!items.length) return null;
  return { items, added: items.filter(e => e.added).length };
}

// action：add（加成来源）| remove（撤掉）。只认渠道包里写着的入口；只写 config/channel-entries.json。
export function saveEntry({ preset = null, key, action = 'add' } = {}) {
  if (typeof key !== 'string' || !key) throw fail(400, '没有这个入口');
  if (!['add', 'remove'].includes(action)) throw fail(400, '只能加上或撤掉');
  const mine = { ...added({ strict: true }) };
  if (action === 'remove') {
    if (!Object.hasOwn(mine, key)) return { status: 'unchanged' };
    const name = mine[key]?.name || key;
    delete mine[key];
    write(ENTRIES_FILE, mine);
    event('user', 'setup', 'ok', `搜好的入口：撤掉「${name}」`);
    return { status: 'saved', key, added: false };
  }
  if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) throw fail(400, '没有这个预设');
  const list = entriesOf(preset, {}), e = hasEntries(list) && list.find(x => x.key === key);
  if (!e) throw fail(400, '没有这个入口');
  if (mine[key]?.preset === preset) return { status: 'unchanged' };
  mine[key] = { name: e.name, preset, added_at: new Date().toISOString() };
  write(ENTRIES_FILE, mine);
  event('user', 'setup', 'ok', `搜好的入口：加上「${e.name}」`);
  return { status: 'saved', key, added: true };
}
