import { PLATFORM_ACTIONS, platformActionsEnabled } from './platform-actions.mjs';
// 「开始使用」的引导（2026-09-29）：新用户一屏一个问题走一遍——你是谁、求职方向、期望（城市 / 薪资 / 工作方式）、
// 简历、模型、渠道（真人渠道 + 公司包）、连接手机、团队开工。页面在 web/onboarding.js；第一次打开工作台时自动进来
// （什么时候算「还没做完」见 lib/onboarding-state.mjs）。老用户（已经有 candidate/facts.yaml）不会被拉进来；
// 同一套答案在「设置 → 求职方向与偏好」里逐项改（web/prefs.js），那里也有「重新走一遍引导」。
//
// 答案都是结构化的值，保存和之后的筛选、排序、搜索词都不调用模型：身份写 availability.current_status，
// 方向 / 子方向写 preferences.directions / tracks（键名来自 lib/directions.mjs），城市、薪资、工作方式各写一项，
// 渠道只改 enabled，公司包只加带 preset 标记的公司。tests/onboarding-no-model.test.mjs 钉住这一点。
//
// 预设（lib/presets.mjs，协调者写）给默认值：方向、子方向、公司包、渠道包、简历提示、预算档、面试准备……
// 只用它的 presetList / presetFacts / presetHints，这里不另写一份。
// 每一步都能跳过，跳过不写任何东西。写的地方都是现成的：
//   - 个人资料走 lib/profile.mjs 的同一条路径（白名单、备份、保留注释、base 版本校验）；
//   - 真人渠道写 config/human-source-policy.json，只改每个来源的 enabled，理由等别的字段原样留着；
//   - 公司包加进 config/companies.yaml：只加还没有的公司（同名，或同一个招聘系统的同一块板），每条标 preset: <预设>；
//     去掉预设时只删带这个标记的，你自己加的公司一条不动。改文件走 YAML 文档，注释和别的字段都留着。
import fs from 'node:fs';
import YAML from 'yaml';
import { root, file, read, write, configSource } from './store.mjs';
import { event } from './events.mjs';
import { DISCOVERY_SOURCES, sourceEnabled } from './discovery-policy.mjs';
import { currentFacts, saveProfile, WORK_MODES, CHINA_AUTH, US_AUTH } from './profile.mjs';
import { setupView } from './setup.mjs';
import { unlockItems } from './unlock.mjs';
import { presetList, presetFacts, presetHints, BUDGET_TIERS, STAGES } from './presets.mjs';
import { sourceStats } from './source-stats.mjs';
import { cachedLines } from './state-cache.mjs';
import { DIRECTIONS, directionLabel } from './directions.mjs';
import { onboardingState, markOnboarding } from './onboarding-state.mjs';
import { updateSettings } from './settings.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRuntimes } from './local-runtimes.mjs';
import { cliLogin, modelLabel } from './model-truth.mjs';
import { writeModels } from './local-config.mjs';
import { loadProviders, markLocalPicked, desktopApp } from './backends.mjs';
import { APP_ACCOUNT } from './capabilities.mjs';
import { mailboxOf } from './facts.mjs';
import { keyName, boardKey, recordPackAdd } from './pack-sync.mjs'; // 判重和升级后的公司包同步共用一套口径
import { entriesView } from './entry-sources.mjs';
import { noteSwallowed } from './swallow.mjs';
import { isClaudeKey, applyClaudeDefaults } from './claude-defaults.mjs';

const fail = (status, message) => Object.assign(Error(message), { status });
// 渠道包、公司包是跟代码一起发的模板：数据目录里有（Mac 版、演示目录都把它们链进来）就读那一份，没有就读代码目录里的
// （10-01 验收 #45：只建了个空数据目录时，选了「工程师」，公司清单还是 0 家，渠道那一步说「这个方向的渠道包还没有」）。
const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shipped = rel => (fs.existsSync(file(rel)) ? file(rel) : path.join(codeRoot, rel));
const str = v => (v == null ? '' : String(v).trim());
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(/[\n,，、;；]+/)).map(str).filter(Boolean);

// ── 这次新加的文字（做中英文切换时换这里） ──────────────────────────────────────
const COPY = {
  // 要登录的来源：说实际用的浏览器（装了 ego 才说 ego）。不灰掉，照样能开（负责人 10-01：和 ego 解耦，内置浏览器登录那条线在做）。
  // 能直接勾（第 5 轮负责人：写「要先登录」读起来像不登录就不能选）；登录放在引导走完以后那封「还差几步」的信里（lib/unlock.mjs）。
  // 不随这台电脑装没装 ego 变（第 1 轮 #46：Mac 版和 ego 脱钩）：Mac 版说专用 Chrome，命令行版只说浏览器。
  browser: () => (desktopApp() ? '稍后在专用 Chrome 里登录' : '稍后在浏览器里登录'),
  event: {
    who: (n) => `开始使用 · 引导：保存「你是谁 / 求职方向」${n} 项`,
    channels: (on) => `开始使用 · 引导：真人渠道开着 ${on.join('、') || '无'}`,
    add: (preset, n) => `开始使用 · 引导：公司包「${preset}」加进 config/companies.yaml ${n} 家`,
    remove: (preset, n) => `开始使用 · 引导：去掉公司包「${preset}」的 ${n} 家`,
  },
};
// 真人渠道里要登录好的浏览器才能扫的（和 config/human-source-policy.example.json 的说法一致）。
const BROWSER_SOURCES = new Set(['boss', 'maimai', 'linkedin', 'xiaohongshu']);
// 城市的常用选项（也能自己输入别的）。
export const COMMON_CITIES = ['北京', '上海', '深圳', '杭州', '广州', '成都', '南京', '苏州', '武汉', '西安', '香港', '新加坡', '远程'];

// ── 预设：页面要的样子（名字、简介、子方向都是 presetList 从 lib/directions.mjs 取的） ──────────────────
export function presets(lang = 'zh') {
  return presetList(lang).map(p => ({ key: p.key, name: p.label, blurb: p.blurb, directions: [p.direction], tracks: p.tracks.map(t => ({ key: t.key, name: t.label })), stage_default: p.stage_default, budget: p.budget_tier ? { key: p.budget_tier, name: BUDGET_TIERS[p.budget_tier]?.[lang] || BUDGET_TIERS[p.budget_tier]?.zh || p.budget_tier } : null, company_pack: p.company_pack || null, channel_pack: p.channel_pack || null }));
}
const presetBy = (list, key) => (typeof key === 'string' ? list.find(p => p.key === key) : null) || null;
// 设置里「方向」的选项：注册表里全部方向（有预设的在前，顺序同预设），每个带自己的子方向。
export function directionOptions(lang = 'zh') {
  const withPreset = [...new Set(presetList(lang).map(p => p.direction))];
  const keys = [...withPreset, ...Object.keys(DIRECTIONS).filter(k => !withPreset.includes(k))];
  return keys.map(key => ({ key, name: directionLabel(key, lang), tracks: Object.entries(DIRECTIONS[key].tracks || {}).map(([k, t]) => ({ key: k, name: t[lang] || t.zh || k })) }));
}
const knownDirection = k => typeof k === 'string' && Object.hasOwn(DIRECTIONS, k);

// ── 读：页面一次拿齐 ─────────────────────────────────────────────────────────
const stageOf = status => { const s = str(status).toLowerCase(); return /在读|在校|student/.test(s) ? 'student' : /应届|new.?grad|fresh graduate/.test(s) ? 'new_grad' : /在职|离职|职场|employed|working|professional/.test(s) ? 'experienced' : null; };
// 资料里现在的方向对得上哪个预设：主方向一样的第一个（写了子方向的，子方向都在这个预设里）。
function presetOfFacts(presets, f) {
  const dirs = list(f?.preferences?.directions ?? f?.preferences?.direction), tracks = list(f?.preferences?.tracks);
  if (!dirs.length) return null;
  return presets.find(p => p.directions[0] === dirs[0] && tracks.every(t => p.tracks.some(x => x.key === t)))?.key || null;
}
// preset / tracks：页面上刚点选、还没保存的，渠道包、公司包、简历提示按它们给；没传就按资料里现在的。
export async function onboardingView({ preset = null, tracks = null } = {}) {
  const all = presets(), dirs = list(currentFacts().data?.preferences?.directions ?? currentFacts().data?.preferences?.direction);
  const { data, sig, exists, error } = currentFacts();
  const setup = setupView({ runtime: {} }), step = k => setup.steps.find(s => s.key === k) || null;
  const saved = presetOfFacts(all, data), chosen = presetBy(all, preset)?.key || saved;
  const p = presetBy(all, chosen);
  // 简历提示、面试准备按子方向给：页面传来的（只认这个预设里有的），没传就用资料里现在的。
  const picked = (tracks != null ? list(tracks) : chosen === saved ? list(data?.preferences?.tracks) : []).filter(t => p?.tracks.some(x => x.key === t));
  return {
    presets: all, stages: Object.entries(STAGES).map(([key, x]) => ({ key, name: x.zh })), cities: COMMON_CITIES,
    work_modes: Object.entries(WORK_MODES).map(([key, name]) => ({ key, name })),
    facts: {
      exists, sig, error,
      stage: stageOf(data?.availability?.current_status),
      preset: saved,
      directions: list(data?.preferences?.directions ?? data?.preferences?.direction),
      tracks: list(data?.preferences?.tracks),
      // 主方向（认得出的键；没写就是 null，按工程师处理）和「也看」的方向：设置页的方向一栏用
      direction: knownDirection(dirs[0]) ? dirs[0] : null, also: dirs.slice(1).filter(knownDirection),
      cities: list(data?.location?.target_cities),
      salary: str(data?.compensation?.expected_annual_cny),
      work_mode: list(data?.location?.work_mode_preference).filter(k => Object.hasOwn(WORK_MODES, k)),
      // 收发求职邮件用的邮箱：identity.mailbox，没写就是简历上的 identity.email（lib/facts.mjs mailboxOf）。
      mailbox: mailboxOf(data || {}),
      // 能在哪里合法工作（引导城市那一屏问，10-02 开箱第 2 轮 X3）：键同 lib/profile.mjs 的 CHINA_AUTH / US_AUTH，没写是空串。
      work_auth: { cn: str(data?.work_authorization?.china_mainland), us: str(data?.work_authorization?.us) },
    },
    resume: step('resume'), models: step('models'),
    chosen: chosen || null,
    hints: p ? presetHints(p.key, picked) : null,
    // 搜好的入口按页面上刚选的方向、细分来填（还没保存的也算），城市用资料里的。
    channels: channelsView(p, p ? { ...data, preferences: { ...(data?.preferences || {}), directions: p.directions, tracks: picked } } : data),
    companies: companiesView(p),
    directions: directionOptions(),
    // Mac 版不先去探测这台电脑上的 Codex / Claude Code：null 是「点了『用本机 AI』才查」（POST /api/onboarding/model { use: 'local_check' }）。
    local_models: localView(),
    // 引导最后一页的「还差几步」（Mac 版）：和收件箱那封信、设置的检查清单同一份（lib/unlock.mjs）。
    unlock: desktopApp() ? unlockItems() : null,
    completed: onboardingState().completed,
  };
}

// ── 你是谁 / 求职方向 / 期望：写个人资料 ──────────────────────────────────────
// values 里只放你这一屏答了的；没答的不写。base 是读取时 facts.yaml 的版本（别处改过就 409）。
export async function saveAnswers({ base = null, values = {} } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail(400, '格式不对');
  const set = {};
  if (values.stage != null) {
    if (typeof values.stage !== 'string' || !Object.hasOwn(STAGES, values.stage)) throw fail(400, '身份只能是在校生、应届生或职场人');
    // 资料里已经是同一类（例如「已离职」也是职场人）就不改写你的原话；写的话和 presetFacts 一样写「在校生 / 应届生 / 职场人」。
    const cur = currentFacts().data?.availability?.current_status;
    if (stageOf(cur) !== values.stage) set['availability.current_status'] = STAGES[values.stage].zh;
  }
  if (values.preset != null) {
    const p = presetBy(presets(), values.preset);
    if (!p) throw fail(400, '没有这个预设');
    const tracks = list(values.tracks);
    const bad = tracks.filter(t => !p.tracks.some(x => x.key === t));
    if (bad.length) throw fail(400, `「${p.name}」里没有这些子方向：${bad.join('、')}`);
    const facts = presetFacts(p.key, { tracks });
    set['preferences.directions'] = facts['preferences.directions'];
    set['preferences.tracks'] = facts['preferences.tracks'];
  }
  // 设置页：方向可以是注册表里任何一个（金融、咨询这些还没有预设）；子方向只收这个方向里有的；
  // 「也看」的方向原样留在后面（设置页不改它们，改在检查清单「你的方向」的弹窗里）。
  if (values.direction != null && values.preset == null) {
    if (!knownDirection(values.direction)) throw fail(400, '没有这个方向');
    const tracks = list(values.tracks), known = Object.keys(DIRECTIONS[values.direction].tracks || {});
    const bad = tracks.filter(t => !known.includes(t));
    if (bad.length) throw fail(400, `「${directionLabel(values.direction)}」里没有这些子方向：${bad.join('、')}`);
    const cur = currentFacts().data?.preferences || {};
    const also = list(cur.directions ?? cur.direction).slice(1).filter(k => knownDirection(k) && k !== values.direction);
    set['preferences.directions'] = [values.direction, ...also];
    set['preferences.tracks'] = [...new Set(tracks)];
  }
  if (values.cities != null) set['location.target_cities'] = list(values.cities);
  if (values.salary != null) set['compensation.expected_annual_cny'] = str(values.salary);
  if (values.work_mode != null) set['location.work_mode_preference'] = list(values.work_mode);
  if (values.mailbox != null) set['identity.mailbox'] = str(values.mailbox);
  // 工作许可：{ cn, us }，只收 lib/profile.mjs 里的那几个键（空串是清掉）。以前引导不问，资料里没有 work_authorization，
  // 判断就认不出能不能在当地工作，首轮全判「待核」（10-02 开箱第 2 轮 X3）。
  if (values.work_auth != null) {
    const w = values.work_auth;
    if (typeof w !== 'object' || Array.isArray(w)) throw fail(400, '工作许可的格式不对');
    for (const [k, field, opts] of [['cn', 'work_authorization.china_mainland', CHINA_AUTH], ['us', 'work_authorization.us', US_AUTH]]) {
      if (w[k] === undefined) continue;
      const v = str(w[k]);
      if (!Object.hasOwn(opts, v)) throw fail(400, '没有这个工作许可选项');
      set[field] = v;
    }
  }
  if (!Object.keys(set).length) return { status: 'unchanged', changes: [], sig: currentFacts().sig };
  const r = saveProfile({ base, set }, { source: '开始使用 · 引导' });
  return r;
}

// ── 真人渠道：config/human-source-policy.json 的 enabled ────────────────────────
// 渠道包（config/channel-packs/<预设>.example.json，另一位同事在做）：推荐开哪些来源。认两种写法：来源键的列表，
// 或 { 来源: { enabled } }（也可以包在 sources 里）。文件不在就是 null（页面说「还没有」）。
function channelPack(p) {
  if (!p?.channel_pack) return null;
  const src = shipped(p.channel_pack);
  if (!fs.existsSync(src)) return { path: p.channel_pack, exists: false, on: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { return { path: p.channel_pack, exists: true, error: `读不出：${String(e.message).slice(0, 80)}`, on: [] }; }
  const body = raw && !Array.isArray(raw) && raw.sources ? raw.sources : raw;
  const on = Array.isArray(body) ? body.map(str) : Object.entries(body || {}).filter(([, v]) => v === true || (v && typeof v === 'object' && v.enabled !== false)).map(([k]) => k);
  // 包里写到的来源（开或关）：它们的初始勾选听包的——要登录的来源包里写着关，新用户就不该默认勾上。
  const listed = Array.isArray(body) ? body.map(str) : Object.keys(body || {});
  return { path: p.channel_pack, exists: true, on: on.filter(k => Object.hasOwn(DISCOVERY_SOURCES, k)), listed: listed.filter(k => Object.hasOwn(DISCOVERY_SOURCES, k)) };
}
// 同一个网站在扫描开关和搜好的入口里都有的（10-03 入口去重）：扫描源键 → 入口键。
//   - BOSS：同一个东西（这个站的职位搜索），只列一处。扫描开着就留开关（看得到在扫、关得掉），入口不列；
//     扫描关着就留入口，开关不列。开关存 config/human-source-policy.json，入口存 config/channel-entries.json，
//     挪到哪一处都不改另一边：「加为来源」不会打开浏览器扫描，打开扫描也不会加成入口。
//   - LinkedIn：开关是登录后扫招聘帖，入口是不用登录的职位搜索，是两件事，两处都留；开关改叫渠道包里的「LinkedIn 帖子」，
//     和「LinkedIn 职位搜索」分得开。
const SAME_SITE = { boss: 'boss', linkedin: 'linkedin_jobs' };
const ONE_PLACE = new Set(['boss']);
// entries：搜好的入口（lib/entry-sources.mjs，存在别的文件里，不是扫描源）；这个方向没有入口时是 null。
export function channelsView(p = null, facts = currentFacts().data || {}) {
  const policy = read('config/human-source-policy.json', {}) || {};
  const pack = channelPack(p);
  let entries = null;
  try { entries = entriesView(p?.key || null, facts || {}); } catch (e) { noteSwallowed('onboarding.entries', e, { member: 'scout', doing: '读这个方向搜好的入口', then: '这一步先不列入口' }); entries = null; }
  const listed = new Set((entries?.items || []).map(e => e.key));
  const label = (key, name) => SAME_SITE[key] && listed.has(SAME_SITE[key]) && !ONE_PLACE.has(key) ? `${name} 帖子` : name;
  // 每个来源推荐得准不准（lib/source-stats.mjs）：设置 · 求职偏好 · 岗位来源那一页列出来，长期不准的写「排后」。来源照旧开着；引导里不显示。
  let stats = {};
  try { stats = sourceStats(cachedLines('state/leads.ndjson')); } catch (e) { noteSwallowed('onboarding.source-stats', e, { member: 'lens', doing: '数每个来源推荐得准不准', then: '来源旁边先不写数' }); }
  let sources = Object.entries(DISCOVERY_SOURCES).map(([key, name]) => ({ key, name: label(key, name), enabled: sourceEnabled(key, policy), browser: BROWSER_SOURCES.has(key), note: BROWSER_SOURCES.has(key) ? COPY.browser() : null, recommended: !!pack?.on.includes(key), in_pack: !!pack?.listed?.includes(key), stats: stats[key] || null }));
  const both = [...ONE_PLACE].filter(k => listed.has(SAME_SITE[k]));
  if (both.length) {
    const scanning = new Set(both.filter(k => sourceEnabled(k, policy)));
    sources = sources.filter(s => !both.includes(s.key) || scanning.has(s.key));
    const items = entries.items.filter(e => !both.some(k => SAME_SITE[k] === e.key && scanning.has(k)));
    entries = items.length ? { items, added: items.filter(e => e.added).length } : null;
  }
  return { entries, sources, pack, actions: Object.entries(PLATFORM_ACTIONS).map(([key, p]) => ({ key, name: p.label, enabled: platformActionsEnabled(key, policy), scan_enabled: sourceEnabled(key, policy) })) };
}
// enabled = { 来源: true/false }：只认已知的来源，只改 enabled。
// 真人帖来源：除了公司官网都是。没写在 config/human-source-policy.json 里的算开着——扫描时就是这么算的
// （lib/discovery-policy.mjs sourceEnabled）。以前只数文件里写着的几项：模板里写着的四项都是关的，V2EX、HN 这些
// 「没写所以开着」的就没算上，于是事件写「真人渠道开着 无」、每天扫描也没打开（10-02 开箱第 2 轮 N01）。
export const humanSourcesOn = (policy = read('config/human-source-policy.json', {}) || {}) => Object.keys(DISCOVERY_SOURCES).filter(k => k !== 'official' && sourceEnabled(k, policy));
// 开着的真人帖来源要真的去扫：每天抓真人帖（config/pipeline.json human_discovery_daily）模板里是关的（10-01 开箱测试 #13）。
// 有一个开着就打开；本机的 pipeline.json 里写过这个开关（你在设置里开过、关过）就不动。只看本机文件：read 会退到模板。
function ensureDailyScan(policy) {
  if (!humanSourcesOn(policy).length) return false;
  let daily; try { daily = JSON.parse(fs.readFileSync(file('config/pipeline.json'), 'utf8'))?.human_discovery_daily; } catch {} // 兜底：没设就用默认的每日数量
  if (daily != null) return false;
  updateSettings('pipeline', { human_discovery_daily: true });
  return true;
}
export function saveChannels({ enabled = {} } = {}) {
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) throw fail(400, '格式不对');
  const unknown = Object.keys(enabled).filter(k => !Object.hasOwn(DISCOVERY_SOURCES, k));
  if (unknown.length) throw fail(400, `没有这些渠道：${unknown.join('、')}`);
  const policy = structuredClone(read('config/human-source-policy.json', {}) || {});
  const changes = [];
  for (const [k, v] of Object.entries(enabled)) {
    const on = v === true;
    if (sourceEnabled(k, policy) === on && policy[k]) continue;
    policy[k] = { ...(policy[k] || {}), enabled: on };
    changes.push({ key: k, enabled: on });
  }
  ensureDailyScan(policy);
  if (!changes.length) return { status: 'unchanged', changes };
  write('config/human-source-policy.json', policy);
  event('user', 'setup', 'ok', COPY.event.channels(humanSourcesOn(policy).map(k => DISCOVERY_SOURCES[k])));
  return { status: 'saved', changes };
}

// ── 公司包：加进 / 移出 config/companies.yaml ───────────────────────────────────
const COMPANIES = 'config/companies.yaml';
function packEntries(p) {
  if (!p?.company_pack) return null;
  const src = shipped(p.company_pack);
  if (!fs.existsSync(src)) return { path: p.company_pack, exists: false, entries: [] };
  let raw;
  try { raw = YAML.parse(fs.readFileSync(src, 'utf8')); } catch (e) { return { path: p.company_pack, exists: true, error: `读不出：${String(e.message).slice(0, 80)}`, entries: [] }; }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.companies) ? raw.companies : [];
  return { path: p.company_pack, exists: true, entries: items.filter(c => c && typeof c === 'object' && str(c.name)) };
}
// 现在在读的清单：本机的 config/companies.yaml；还没有时是示例（加包时从示例开始，不让正在扫的公司消失）。
const LOCAL_HEADER = ' 你的公司清单（本机文件，不进仓库）。由「开始使用」的引导从示例清单建出。\n 带 preset: 的是公司包加进来的：去掉那个公司包时只删带这个标记的；你自己加的公司不会被动。';
function companiesDoc() {
  const rel = configSource(COMPANIES);
  const text = rel ? fs.readFileSync(file(rel), 'utf8') : '[]\n';
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw fail(400, `config/companies.yaml 解析失败（${doc.errors[0].message.split('\n')[0]}），请先手动修好`);
  if (doc.contents == null) doc.contents = doc.createNode([]);
  if (!YAML.isSeq(doc.contents)) throw fail(400, 'config/companies.yaml 不是一张公司列表，请先手动修好');
  // 从示例建出本机文件：示例开头「这是模板」的说明（挂在文档、列表或第一家公司前面）换成本机文件自己的说明。
  if (rel !== COMPANIES) { doc.commentBefore = LOCAL_HEADER; doc.contents.commentBefore = null; if (doc.contents.items[0]) doc.contents.items[0].commentBefore = null; }
  return { doc, local: rel === COMPANIES };
}
const itemJS = n => (YAML.isMap(n) ? n.toJSON() : null);
export function companiesView(p = null) {
  let items = [];
  try { items = companiesDoc().doc.contents.items.map(itemJS).filter(Boolean); } catch (e) { noteSwallowed('onboarding.companies', e, { member: 'scout', doing: '读公司清单', then: '这一步先当一家都没有' }); items = []; }
  const byPreset = {};
  for (const c of items) if (c.preset) byPreset[c.preset] = (byPreset[c.preset] || 0) + 1;
  const pack = packEntries(p);
  const have = new Set(items.map(c => keyName(c.name))), boards = new Set(items.map(boardKey).filter(Boolean));
  return {
    total: items.length, mine: items.filter(c => !c.preset).length, by_preset: byPreset,
    pack: pack && { path: pack.path, exists: pack.exists, error: pack.error || null, count: pack.entries.length, missing: pack.entries.filter(c => !have.has(keyName(c.name)) && !(boardKey(c) && boards.has(boardKey(c)))).length, added: p ? byPreset[p.key] || 0 : 0 },
  };
}
export async function applyCompanyPack({ preset, action = 'add' } = {}) {
  const p = presetBy(presets(), preset);
  if (!p) throw fail(400, '没有这个预设');
  if (!['add', 'remove'].includes(action)) throw fail(400, '只能加入或去掉');
  const { doc } = companiesDoc(), seq = doc.contents;
  if (action === 'remove') {
    const before = seq.items.length;
    seq.items = seq.items.filter(n => !(YAML.isMap(n) && n.get('preset') === p.key));
    const removed = before - seq.items.length;
    if (!removed) return { status: 'unchanged', removed: 0 };
    write(COMPANIES, doc.toString());
    event('user', 'setup', 'ok', COPY.event.remove(p.name, removed));
    return { status: 'saved', removed };
  }
  const pack = packEntries(p);
  if (!pack?.exists) throw fail(404, `「${p.name}」的公司包还没有`);
  if (pack.error) throw fail(400, `公司包 ${pack.path} ${pack.error}`);
  const items = seq.items.map(itemJS).filter(Boolean);
  const have = new Set(items.map(c => keyName(c.name))), boards = new Set(items.map(boardKey).filter(Boolean));
  const added = [], skipped = [];
  for (const c of pack.entries) {
    if (have.has(keyName(c.name)) || (boardKey(c) && boards.has(boardKey(c)))) { skipped.push(str(c.name)); continue; }
    const { preset: _drop, ...rest } = c;
    seq.items.push(doc.createNode({ ...rest, preset: p.key }));
    have.add(keyName(c.name)); if (boardKey(c)) boards.add(boardKey(c));
    added.push(str(c.name));
  }
  if (!added.length) return { status: 'unchanged', added, skipped };
  write(COMPANIES, doc.toString());
  recordPackAdd(p.key, pack.entries, added); // 记下加进来时的样子：升级后包里改了，没改过的跟着改（lib/pack-sync.mjs）
  event('user', 'setup', 'ok', COPY.event.add(p.name, added.length));
  return { status: 'saved', added, skipped };
}

// ── 模型一步的「这台电脑上的 Claude Code / Codex」：只看文件在不在，不跑命令、不调模型 ─────────────────
// Claude Code：PATH 里有 claude（或 RADAR_CLAUDE_BIN）；Codex：PATH 里有 codex，而且 CODEX_HOME 里有登录文件（只看在不在，不读）。
export function localModels(env = process.env) {
  // R23：和设置 → 高级同一份检测（lib/local-runtimes.mjs：版本、登录、身份）；登录状态没查到（超时）不拦。
  const runtimes = detectRuntimes({ env: { ...env, CODEX_HOME: env.CODEX_HOME || path.join(os.homedir(), '.codex') } });
  const ok = k => { const r = runtimes.find(x => x.kind === k); return !!r?.installed && r.login !== 'out'; };
  const claude = ok('claude'), codex = ok('codex');
  const unlogged = runtimes.filter(r => r.installed && r.login === 'out').map(r => r.kind);
  return { claude, codex, ...(unlogged.length ? { unlogged } : {}), runtimes: runtimes.map(({ kind, name, installed, version, login, identity_label, usable, state, remedy }) => ({ kind, name, installed, version, login, identity_label, usable, state, remedy })) };
}
// 引导和设置页的本机 AI 状态：自动检测（R23，10-11 负责人「就像 Paseo 一样，可以直接检测到」；以前 Mac 版点了才查）。
export const localView = (env = process.env) => localModels(env);
// 在 OfferCrew 里登录过 ChatGPT（App 自己的账号 openai@app）：目录里有这个账号，用它的登录目录问一次登录状态（不读里面的文件）。
function appCodexLoggedIn(env = process.env) {
  const p = loadProviders()[APP_ACCOUNT];
  if (!p?.codex_home || !fs.existsSync(file(p.codex_home))) return false;
  return cliLogin('codex', { exe: env.RADAR_CODEX_BIN, env: { ...env, CODEX_HOME: file(p.codex_home) } }) !== 'out';
}
// 选了它：文字模型的清单换成这台电脑上的（Claude 在前），写法见 lib/local-config.mjs writeModels。
// pick：只用其中一个（claude / codex，Mac 版查到以后你点的那个）；不给就是找到的都用。
export function useLocalModel(env = process.env, pick = null) {
  const l = localModels(env), want = k => !pick || pick === k;
  const refs = [...(l.claude && want('claude') ? ['claude_subscription/sonnet'] : []), ...(l.codex && want('codex') ? ['openai/default'] : [])];
  if (!refs.length) throw fail(409, pick === 'codex' ? '这台电脑上没找到已登录的 Codex' : pick === 'claude' ? '这台电脑上没找到已登录的 Claude Code' : '这台电脑上没找到 Claude Code 或已登录的 Codex');
  writeModels(root, { refs, vision: refs[0] });
  // 你亲手选的本机运行时：之后补给用完时，它才算你配过的后备（lib/backends.mjs dropUnpickedLocal）。
  markLocalPicked(refs);
  // 事件写给人看：模型说名字（modelLabel），不写「供应商/模型」——运行日志会把那种写法当内部 id 删掉，只剩「文字模型用」（10-02 开箱第 2 轮 N09）。
  event('user', 'setup', 'ok', `开始使用 · 引导：文字模型用这台电脑上的 ${refs.map(r => modelLabel(r)).join('、')}`);
  return { status: 'saved', refs };
}
// 引导里点了哪张就真的切过去（09-30 新用户实测：点了「ChatGPT 账号」「自己的 API key」，读岗位用的还是原来的模型）。
// use：local 这台电脑上的 Claude Code / Codex；chatgpt 已登录的 Codex（ChatGPT 账号）；key 刚加好、测过的那家（backend 写「供应商/模型」）。
// OfferCrew 补给不走这里：POST /api/model/free { action: 'start', make_default: true }。
// local_check：只查这台电脑上的装没装、登没登录，什么都不写（Mac 版点了「用本机 AI」时）。
export function useModel({ use, backend = null, pick = null } = {}, env = process.env) {
  if (use === 'local_check') return { status: 'checked', local: localModels(env) };
  if (use === 'local') return useLocalModel(env, ['claude', 'codex'].includes(pick) ? pick : null);
  let refs;
  if (use === 'chatgpt') {
    // 「ChatGPT 账号」只认在 OfferCrew 里登录的那个（lib/codex-app.mjs 的 openai@app，App 自己的登录目录）；这台电脑上原来就有的
    // Codex（~/.codex）是「这台电脑上的 Codex」（use: 'local'），不算在这里（10-02 主会话，开箱第 2 轮 X5 的后续）。
    if (!appCodexLoggedIn(env)) throw fail(409, '还没在 OfferCrew 里登录 ChatGPT 账号');
    refs = [`${APP_ACCOUNT}/default`];
  } else if (use === 'key') {
    const [provider, ...rest] = String(backend || '').split('/'), model = rest.join('/'), p = loadProviders()[provider];
    if (!p || !['openai_http', 'anthropic_http'].includes(p.kind) || !model || !(p.models || []).includes(model)) throw fail(400, '先把 key 保存好、测通了再选它');
    refs = [`${provider}/${model}`];
  } else throw fail(400, '只能是 local / chatgpt / key');
  writeModels(root, { refs, vision: refs[0] });
  event('user', 'setup', 'ok', `开始使用 · 引导：文字模型用 ${modelLabel(refs[0])}`);
  // 你自己的 Anthropic key：再按成员分 Haiku / Sonnet（lib/claude-defaults.mjs）。返回一个 Promise（POST /api/onboarding/model 会等它）。
  const p = loadProviders()[refs[0].split('/')[0]];
  if (use === 'key' && isClaudeKey(p)) return applyClaudeDefaults(p.key).then(() => ({ status: 'saved', refs, claude_defaults: true }));
  return { status: 'saved', refs };
}

// ── 走完了（记号和规则在 lib/onboarding-state.mjs） ────────────────────────────────
// 走完时顺手把这个方向默认的花费档位（预设的 budget_tier）写进 config/pipeline.json 的 spend_tier：
// 文件里已经有 spend_tier（你在「设置 → 花费」或检查清单里选过）就不动；方向没有预设（金融、咨询这些）也不写。
// 同一条写入路径（lib/settings.mjs 的 pipeline 白名单），不调模型。
export function applyPresetTier() {
  const p = presetBy(presets(), presetOfFacts(presets(), currentFacts().data));
  const tier = p?.budget?.key || null, cur = read('config/pipeline.json', {})?.spend_tier ?? null;
  if (!tier) return { status: 'no_preset', tier: cur };
  if (cur != null) return { status: 'kept', tier: cur };
  updateSettings('pipeline', { spend_tier: tier });
  return { status: 'saved', tier };
}
export function finishOnboarding({ now = Date.now() } = {}) {
  const r = markOnboarding('finish', { now });
  // 每天扫描在写花费档之前定：写花费档会照模板建出本机的 pipeline.json（模板里每天扫描是关的），那之后就当你定过了。
  // 渠道一步没改任何开关时页面不发请求（web/onboarding.js），saveChannels 就不会跑，所以这里一定要再看一次。
  try { ensureDailyScan(read('config/human-source-policy.json', {}) || {}); } catch (e) { noteSwallowed('onboarding.dailyScan', e, { member: 'scout', doing: '按你选的渠道定每天扫描', then: '每天扫描照模板（关着），可以在设置里打开' }); }
  let spend;
  try { spend = applyPresetTier(); } catch (e) { spend = { status: 'error', error: String(e.message).slice(0, 160) }; }
  return { ...r, completed_at: r.state.completed, spend };
}
