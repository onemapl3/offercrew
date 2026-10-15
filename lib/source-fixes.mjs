// 随新版带来的招聘源改正（10-05）：核对过、知道怎么改的几家，升级以后自动改进你的公司清单（config/companies.yaml），
// 不用你自己去「改」。和公司包同步（lib/pack-sync.mjs）一个思路，只是对象是清单里任何一条（不只带 preset: 的）：
//   - 每一条改正写着「改之前是什么样」（when）：清单里这一家现在还是那个样子才改；你改过的一个字都不动；
//   - 改的时候把扫描写回的健康字段一起清掉：下一轮扫描当新加的读一次（lib/discovery-source.mjs selectSources）；
//   - 每条改正只做一次（state/source-fixes.json 记着），你以后再改回去也不会被改第二次；
//   - 运行日志记一行「招聘源：……」。
// 什么时候跑：工作台启动、开始监听以后（bin/serve.mjs），和每次扫描官方源之前（bin/discover.mjs）。不联网。
// 只动本机已经有的 config/companies.yaml；还没有（只有示例清单）就不动。在文件现在的文本上改（YAML 文档，注释和别的字段都留着）。
import fs from 'node:fs';
import YAML from 'yaml';
import { file, read, write } from './store.mjs';
import { event } from './events.mjs';
import { HEALTH_FIELDS } from './discovery-source.mjs';

const COMPANIES = 'config/companies.yaml';
const STATE = 'state/source-fixes.json';
const CLEAR = [...HEALTH_FIELDS, 'careers_http_status', 'careers_checked_at', 'careers_error'];
const keyName = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s·.,，()（）-]+/g, '');

export const SOURCE_FIXES = [
  // 极氪：careers.zeekrlife.com 停了，社招在吉利集团的 Moka 站（824 个岗位）。站上「极氪科技集团」这个部门 37 个（10-05 核对：
  // 杭州 14 个）。以前没有按部门读的办法，怕把集团的岗位记在极氪名下，一直没启用；现在 Moka 适配器能只读这个部门。
  {
    id: '2026-10-05-zeekr-moka-department', name: '极氪',
    when: { ats_type: 'publiccareers', careers_url: 'https://app.mokahr.com/social-recruitment/geely/102003' },
    set: { ats_type: 'moka', org_id: 'geely', site_id: 102003, site_path: 'social-recruitment', department: '极氪科技集团' },
    text: '极氪 改读吉利 Moka 社招站里「极氪科技集团」这个部门的岗位',
  },
  // Zilliz：旧的 Greenhouse 板没了，现在在 Lever（jobs.lever.co/zilliz，10-05 读到 12 个，都在海外）。清单里已经是 Lever，
  // 招聘页还写着官网，上次核对的「Greenhouse 404」也还挂着：换成 Lever 的招聘板，下一轮重新读。
  {
    id: '2026-10-05-zilliz-lever', name: 'Zilliz',
    when: { ats_type: 'lever', board: 'zilliz', careers_url: 'https://zilliz.com/careers' },
    set: { careers_url: 'https://jobs.lever.co/zilliz' },
    text: 'Zilliz 的招聘页换成 Lever 上的招聘板',
  },
];

const same = (a, b) => String(a ?? '') === String(b ?? '');

// 对一遍。返回 { status: 'skipped' | 'unchanged' | 'fixed', fixed: [名字], skipped: [名字] }。
export function applySourceFixes({ fixes = SOURCE_FIXES, now = Date.now() } = {}) {
  if (!fs.existsSync(file(COMPANIES))) return { status: 'skipped', reason: 'no_local_list', fixed: [], skipped: [] };
  const doc = YAML.parseDocument(fs.readFileSync(file(COMPANIES), 'utf8'));
  if (doc.errors.length || !YAML.isSeq(doc.contents)) return { status: 'skipped', reason: 'unreadable_list', fixed: [], skipped: [] };
  let st = null;
  try { st = read(STATE, null); } catch { st = null; } // 兜底：记录读坏了就当一条都没做过；改正本身看「现在是不是那个样子」，不会改错
  if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
  const done = st.applied && typeof st.applied === 'object' ? { ...st.applied } : {};
  const fixed = [], skipped = [];
  for (const fx of fixes) {
    if (done[fx.id]) continue;
    const node = doc.contents.items.find(n => YAML.isMap(n) && keyName(n.get('name')) === keyName(fx.name));
    if (!node) continue; // 清单里没有这一家：以后加了再看
    const at = new Date(now).toISOString();
    if (!Object.entries(fx.when).every(([k, v]) => same(node.get(k), v))) { done[fx.id] = { at, skipped: 'changed' }; skipped.push(fx.name); continue; }
    for (const [k, v] of Object.entries(fx.set)) node.set(k, v);
    for (const k of CLEAR) node.delete(k);
    done[fx.id] = { at, name: String(node.get('name')) };
    fixed.push(fx.name);
  }
  if (fixed.length) write(COMPANIES, doc.toString());
  if (fixed.length || skipped.length) write(STATE, { ...st, applied: done });
  for (const fx of fixes.filter(f => fixed.includes(f.name))) event('system', 'sources', 'ok', `招聘源：${fx.text}，重新读一次`);
  return { status: fixed.length ? 'fixed' : 'unchanged', fixed, skipped };
}

// 启动时、扫描前对一遍：什么错都只记运行日志，不抛出，不挡启动和扫描。
export function applySourceFixesSafely(opts) {
  try { return applySourceFixes(opts); } catch (e) {
    try { event('system', 'sources', 'fail', `招聘源改正这次没做：${String(e?.message || e).slice(0, 160)}`); } catch {} // 兜底：记日志失败也不挡
    return { status: 'failed', error: String(e?.message || e) };
  }
}
