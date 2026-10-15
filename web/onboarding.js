// 「开始使用」的引导：一屏一个问题，大卡片、顶部进度、每一屏都能跳过（参考 BOSS直聘、拉勾、猎聘、LinkedIn 的新用户引导）。
// 七到八步：你是谁（身份、求职方向）→ 期望（城市、薪资、工作方式）→ 模型 → 简历 → 邮箱 → 渠道 →（连接手机）→ 开工。
// 公司包不再单独问：选好方向、点「下一步」时就把这个方向的公司包加进清单（只加还没有的，10-01 开箱测试 #12）。
// 走引导时占满整个窗口：左边导航、右边对话栏、「问」按钮都收起，⌘K 不打开对话（#10）。
// 「连接手机」只在能配手机、或者飞书已经配好时出现（web/phone.js phoneStepWanted），否则悄悄跳过。
// 第一次打开工作台自动进来（web/first-run.js）：出口是「跳过，先看看」；从「设置」点「重新走一遍引导」进来：出口是「回到设置」。
// 数据来自 GET /api/onboarding（lib/onboarding.mjs），写走 POST /api/onboarding/*（来源和 token 校验同别的 POST）。
// 只在你点「下一步」而且这一屏真的改了的时候才写；「跳过」什么都不写（Mac 版「模型」一步除外：跳过 = 默认的免费额度，skipTakesFree）。默认值来自资料里已有的和预设（lib/presets.mjs）。
// 状态放在这个模块里：工作台后台更新会重画「开始使用」页，引导停在原来那一屏，答了没保存的也还在。
// 简历这一步用导入简历的弹窗（web/setup.js 传进来）；模型这一步只看现在能用的，改模型去设置页。
import { loadFirstRun } from './first-run.js';
import { loadPhone, phoneStepWanted, phoneBody, bindPhone, stopPhonePoll } from './phone.js';
import { desktopBridge, loadDesktop, desktopControlsHtml, bindDesktop, codexSlotWanted, codexSlotHtml } from './desktop.js';
import { mailState, loadMail, mailConnectHtml, bindMailConnect, detectMail } from './mail-connect.js';
import { entriesHtml, entriesClick, addedNames } from './entries.js';

// ── 这次新加的界面文字（界面只做中文，以后做英文就换这一处） ─────────────────────────────────
const T = {
  steps: ['你是谁', '期望', '模型', '简历', '邮箱', '渠道', '开工'], phoneStep: '手机', eyebrow: '使用向导',
  brand: '开始使用', exit: { first: '跳过，先看看', rerun: '回到设置' }, later: '以后再说', back: '上一步', skip: '跳过', next: '下一步', saving: '正在保存…', stepOf: (i, n, name, sub = null) => `第 ${i} 步 / 共 ${n} 步 · ${name}${sub ? ` · ${sub.at}/${sub.of}` : ''}`,
  loading: '正在读取你的资料…',
  stage: { q: '你现在是……', sub: '',
    cards: { student: ['在校生', '还在读书，找实习或者校招'], new_grad: ['应届生', '刚毕业不久，找第一份全职'], experienced: ['职场人', '已经工作过，找下一份'] } },
  direction: { q: '想找什么方向的工作？', sub: '',
    tracks: name => `${name}里想做哪几类？`, none: '预设还在准备中：可以先跳过，之后在「设置 → 求职偏好」里选方向。' },
  cities: { q: '想在哪些城市工作？', sub: '', other: '其他城市', add: '加上', picked: '已选（按先后）：',
    // 键同 lib/profile.mjs 的 CHINA_AUTH / US_AUTH；每一行单选，两行都能选。
    auth: { q: '能在哪里合法工作？', cn: '中国大陆', us: '美国',
      choices: { cn: [['citizen', '公民'], ['permanent_resident', '永久居留'], ['work_permit', '工作许可']], us: [['citizen', '公民'], ['permanent_resident', '绿卡'], ['f1_opt', 'F-1 OPT'], ['f1_stem_opt', 'STEM OPT'], ['h1b', 'H-1B']] } } },
  salary: { q: '期望薪资是多少？', sub: '', label: '期望年薪', placeholder: '例如：25 万以上，可谈', quick: ['15 万以内', '15–25 万', '25–40 万', '40–60 万', '60 万以上', '面议'] },
  mode: { q: '接受哪种工作方式？', sub: '', cards: { remote_china: '可以远程', hybrid: '一周去几天公司', onsite: '每天去公司' } },
  resume: { q: '把简历交给你的求职团队', sub: '', import: '导入简历', continue: '继续确认简历草稿', materials: '继续加入材料', hints: '这个方向的简历要写上：' },
  model: { q: '谁来帮你读岗位、写信？', sub: '',
    none: '还没有能用的文字模型。',
    keep: name => name,
    choices: { free: ['OfferCrew 补给', '官方额度，要登录'], chatgpt: ['ChatGPT 账号', '用你的 ChatGPT 套餐，不另外花钱'], local: ['用本机 AI（Codex / Claude Code）', ''], key: ['自己的 API key', '选一家服务商、粘贴 key，按用量付钱'] },
    localFound: l => l.claude || l.codex ? `找到了：${[l.claude ? 'Claude Code' : '', l.codex ? 'Codex' : ''].filter(Boolean).join('、')}` : l.unlogged?.length ? '找到了，但还没登录' : '',
    freePrivacy: '选 OfferCrew 补给时，你的简历和岗位描述会经过 OfferCrew 的中转服务器，再交给模型服务商处理；中转只记用了多少补给，不保存内容。接了邮箱以后，判断邮件用到的发件人、标题和对方新写的那一段，也会这样经过中转。登录用的邮箱存在 OfferCrew 的中转上，只用来登录和记补给用量。想自己掌控，就用自己的 API key 或 ChatGPT 账号。',
    login: '登录', loginFirst: '登录以后才能用补给。',
    freeOn: 'OfferCrew 补给已经开着。', freeFailed: x => `OfferCrew 补给现在开不了（${x}），已经换成下一个选项。`, freeStarted: x => `OfferCrew 补给开好了${x ? `：${x}` : ''}。`,
    chatgptDone: 'ChatGPT 账号登好了，可以下一步。', localNote: '下一步时把文字模型换成这台电脑上的（Claude Code 在前）。',
    // Mac 版：点了才查（localAsk）。查到了每个给一个按钮；没装、没登录照实说。
    localChecking: '正在查这台电脑上的 Codex / Claude Code…', localNone: '这台电脑上没找到装好的 Codex 或 Claude Code。',
    localUnlogged: names => `找到了 ${names}，但还没登录。在终端里登录以后再查一次。`, localAgain: '再查一次',
    localUse: { claude: '用本机 Claude Code', codex: '用本机 Codex' }, localUsing: name => `文字模型现在用本机 ${name}。`,
    keysLead: '选一家服务商，照着步骤拿到 key，粘贴进来，保存以后马上试一次。',
    price: '价格：', signup: '注册', keyPage: '拿 key 的页面', keyLabel: 'API key', keyPh: '粘贴 key（只存在这台电脑上）', add: '保存并测试', adding: '正在保存、测试…',
    ok: (m, ms) => `可以用：${m}（${ms} 毫秒）`, fail: e => `保存了，但测试没通过：${e}` },
  resumeReparse: '用模型重新解析', resumeReparseWhy: '这份草稿当时没有模型，只按版式整理的；现在有模型了，可以重新解析一遍。',
  desktop: '这台 Mac 上：',
  phone: { q: '把手机也连上', sub: '有事要你拍板时，手机上也能收到。' },
  mail: { q: '用哪个邮箱收发求职邮件？', label: '邮箱', placeholder: 'you@example.com', bad: '邮箱地址不对，再看一下' },
  channels: { q: '去哪些地方帮你找岗位？', sub: '', recommended: '推荐', noPack: '这个方向的渠道包还没有：先按现在的设置。' },
  logins: { q: '现在登录这些网站', done: '登好了', open: '打开登录页' },
  done: { q: '你的求职团队已经就位', sub: '', go: '打开指挥台 →', list: '看检查清单', left: n => `还差 ${n} 步，做完才能用上全部功能：`, openLogin: '打开登录页', opened: '登录页在专用 Chrome 里打开了；登好以后系统会自己发现',
    prep: '有面试时，团队按这些帮你准备：', sources: list => `面经来源：${list.join('、')}`,
    companies: total => `${total} 家`,
    rows: { stage: '身份', direction: '方向', cities: '城市', auth: '工作许可', salary: '期望薪资', mode: '工作方式', resume: '简历', model: '模型', channels: '渠道', companies: '公司清单' }, skipped: '跳过了', none: '还没有', unset: '没填' },
};
// 模型在简历前面（2026-09-30 主人的意见）：先有模型，简历才能交给模型解析。
// logins：选完渠道紧接着「现在登录」（第 6b 轮负责人：引导里就让我登这些平台，可以跳过）；没勾要登录的渠道、命令行装的，这一页自动跳过（go）。
const BASE = [['stage', 0], ['direction', 0], ['cities', 1], ['salary', 1], ['mode', 1], ['model', 2], ['resume', 3], ['mail', 4], ['channels', 5], ['logins', 5], ['done', 6]];
// 要不要「连接手机」一步在开始时定一次（中途不增减，进度条不跳）：要的话插在「开工」前面。
// 有手机一步时它排在开工前面：编号跟着步骤表走，不写死（10-02 开箱第 2 轮 N04：加了「邮箱」以后这里还写着 5、6，
// 手机一屏标着「渠道」、开工一屏标着「手机」）。
export const screensFor = phone => (phone ? [...BASE.slice(0, -1), ['phone', T.steps.length - 1], ['done', T.steps.length]] : BASE);
export const stepsFor = phone => (phone ? [...T.steps.slice(0, -1), T.phoneStep, T.steps.at(-1)] : T.steps);

// ── 状态 ────────────────────────────────────────────────────────────────────
let h = null, deps = null;
// 「邮箱」一屏的连接框状态（web/mail-connect.js）。
const MAIL = mailState();
const G = { on: false, at: 0, view: null, a: {}, busy: false, err: '', finished: false, mode: 'first', screens: BASE, steps: T.steps, phone: null, desktop: null, codexSlot: false, keyPresets: [], keyResult: {}, free: null, freeMsg: '', local: null, localBusy: false };
const esc = x => h.esc(x);
// web/setup.js 在加载时交进来：带 token 的 POST、导入简历的弹窗。
export function configureGuide(d) { deps = d; }
// mode：first（第一次打开自动进来，或者跳过以后从指挥台卡片回来）、rerun（从设置点「重新走一遍引导」）。
export function startGuide({ mode = 'first', phone = null, desktop = null, codexSlot = false, keyPresets = [], free = null } = {}) {
  const wanted = phoneStepWanted(phone);
  Object.assign(G, { on: true, at: 0, view: null, a: {}, err: '', finished: false, busy: false, mode, phone, screens: screensFor(wanted), steps: stepsFor(wanted), desktop, codexSlot, keyPresets, keyResult: {}, free, freeMsg: '' });
}
export function stopGuide() { G.on = false; stopPhonePoll(); }
// 设置里「重新走一遍引导」：下次打开 #onboarding 从第一屏开始。
export function restartGuide() { stopGuide(); }
const screen = () => G.screens[G.at][0];

// 答案：先看你这次点过的，没点过的用资料里现在的（资料里没有的再看预设）。
const cur = k => (Object.hasOwn(G.a, k) ? G.a[k] : fromFacts(k));
function fromFacts(k) {
  const f = G.view?.facts || {};
  if (k === 'preset') return f.preset;
  if (k === 'tracks') return f.preset && f.preset === G.a.preset ? f.tracks : (G.a.preset ? [] : f.tracks);
  if (k === 'work_mode') return f.work_mode;
  // 渠道包写到的来源按包来（包里关着的要登录来源不默认勾），没写到的保留现在的设置。
  if (k === 'channels') { const c = G.view?.channels; return Object.fromEntries((c?.sources || []).map(s => [s.key, c.pack?.exists ? (s.in_pack ? s.recommended : s.enabled) : s.enabled])); }
  return f[k];
}
const presetOf = key => (G.view?.presets || []).find(p => p.key === key) || null;
// 能在哪里合法工作（城市那一屏，10-02 开箱第 2 轮 X3）：{ cn, us }，每一行单选，再点一下取消。
const authOf = a => ({ cn: a?.cn || '', us: a?.us || '' });
const authLabel = (r, v) => T.cities.auth.choices[r].find(([k]) => k === v)?.[1] || v;
const authText = a => ['cn', 'us'].filter(r => a?.[r]).map(r => `${T.cities.auth[r]}${authLabel(r, a[r])}`).join('、');
function authBox() {
  const a = authOf(cur('work_auth')), A = T.cities.auth;
  const row = r => `<div class="ob-auth-row"><span class="ob-auth-where">${esc(A[r])}</span><div class="ob-chips">${A.choices[r].map(([v, l]) => chip(`data-ob-auth="${r}:${v}"`, a[r] === v, l)).join('')}</div></div>`;
  return `<div class="ob-auth"><p class="ob-label">${esc(A.q)}</p>${row('cn')}${row('us')}</div>`;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ── 读 ──────────────────────────────────────────────────────────────────────
async function load() {
  const q = G.a.preset ? `?preset=${encodeURIComponent(G.a.preset)}${Object.hasOwn(G.a, 'tracks') ? `&tracks=${encodeURIComponent((G.a.tracks || []).join(','))}` : ''}` : '';
  const r = await fetch(`/api/onboarding${q}`), v = await r.json();
  if (!r.ok) throw Error(v.error || '读取失败');
  G.view = v;
}
export async function guidePage(helpers) {
  h = helpers;
  deps?.useHelpers?.(helpers); // 导入简历的弹窗（web/setup.js）用同一套工具
  if (!G.on) {
    // 刚进来：问一下走到哪了（顺便拿 token），手机那一步要不要，然后第一次自动打开的记一笔 started（刷新、重启都接着进引导）。
    const presets = fetch('/api/settings/providers/presets').then(r => (r.ok ? r.json() : {})).then(v => v.presets || []).catch(() => []);
    const [s, phone, desktop, codexSlot, keyPresets, free] = await Promise.all([loadFirstRun(), loadPhone().catch(() => null), loadDesktop().catch(() => null), codexSlotWanted(), presets, loadFree(), deps?.loadPending?.()]);
    deps?.setToken?.(s?.token);
    startGuide({ mode: s?.first_run || s?.status === 'skipped' ? 'first' : 'rerun', phone, desktop, codexSlot, keyPresets, free });
    if (s?.first_run && s.status !== 'started') post('/api/onboarding/state', { action: 'start' }).catch(() => {});
  }
  try { await load(); } catch (e) { return `<div class="ob"><p class="ob-err">${esc(e.message)}</p></div>`; }
  return render();
}

// ── 画 ──────────────────────────────────────────────────────────────────────
// 这一大步里有几页、现在是第几页（第 4 轮：前两步各有好几页，看不出还剩多少）。只有一页就是 null。
// 「现在登录」：没有要登录的站（没勾、命令行装的）就跳过这一页，往同一个方向走。
export function stepTo(screens, at, delta, logins) {
  let i = at;
  while (screens[i]?.[0] === 'logins' && !logins) i = Math.max(0, Math.min(screens.length - 1, i + (delta < 0 ? -1 : 1)));
  return i;
}
// 小步只数真会出现的页：没有要登录的站时「现在登录」那一页跳过，渠道就不写「1/2」。
const shownScreens = () => G.screens.filter(([k]) => k !== 'logins' || loginRows().length);
export function substep(screens, at) {
  const step = screens[at]?.[1], pages = screens.map(([, s], i) => [s, i]).filter(([s]) => s === step);
  return pages.length > 1 ? { at: pages.findIndex(([, i]) => i === at) + 1, of: pages.length } : null;
}
// 方向必填（负责人 10-10）：有预设可选的时候，没选方向这一屏不能跳过、不能下一步——没有方向就不推荐（lib/recommend-gate.mjs）。
// 预设还没装上（none）照旧能跳过，之后收件箱有一封「补充信息」。
const directionMissing = key => key === 'direction' && !!(G.view?.presets || []).length && !cur('preset') && !(Object.hasOwn(G.a, 'preset') ? null : G.view?.facts?.direction);
function render() {
  const [key, step] = G.screens[G.at];
  const progress = `<ol class="ob-progress" style="--n:${G.steps.length}">${G.steps.map((s, i) => `<li class="${i < step ? 'done' : i === step ? 'on' : ''}"><i></i><span>${esc(s)}</span></li>`).join('')}</ol>`;
  const body = BODY[key]();
  const last = key === 'done', mustPick = directionMissing(key);
  const nav = last ? '' : `<footer class="ob-nav">${G.at ? `<button type="button" class="secondary" data-ob-back>${esc(T.back)}</button>` : ''}<span class="grow"></span>${mustPick ? '' : `<button type="button" class="ob-skip" data-ob-skip>${esc(key === 'phone' || key === 'mail' ? T.later : T.skip)}</button>`}<button type="button" class="primary" data-ob-next ${G.busy || mustPick ? 'disabled' : ''}>${esc(G.busy ? T.saving : T.next)}</button></footer>`;
  return `<div class="ob" data-screen="${esc(key)}"><header class="ob-top"><div class="ob-brandline">${brandMark()}<div class="eyebrow">${esc(T.eyebrow)}</div></div>${last && G.mode !== 'rerun' ? '' : `<button type="button" class="ob-exit" data-ob-exit>${esc(T.exit[G.mode] || T.exit.first)}</button>`}</header>${progress}<section class="ob-card"><p class="ob-kicker">${esc(T.stepOf(step + 1, G.steps.length, G.steps[step], substep(shownScreens(), shownScreens().indexOf(G.screens[G.at]))))}</p>${body}<p class="ob-err" role="alert">${esc(G.err)}</p></section>${nav}</div>`;
}
// 引导占满窗口时左边导航收起了，把导航里的猫爪和名字借过来放在最上面（只是标志，不是链接；遮罩换个 id，
// 不和藏起来的那一份重名——引用落到 display:none 里的遮罩，猫爪就画不出来）。
function brandMark() {
  const b = document.querySelector('.sidebar .brand');
  if (!b) return '';
  return b.outerHTML.replace(/^<a class="brand"[^>]*>/, '<span class="brand ob-brand" aria-hidden="true">').replace(/<\/a>$/, '</span>').replace(/brand-paw/g, 'brand-paw-ob');
}
const card = (attr, on, title, sub = '', extra = '') => `<button type="button" class="ob-option${on ? ' on' : ''}" ${attr} aria-pressed="${on}"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}${extra}</button>`;
const chip = (attr, on, label) => `<button type="button" class="ob-chip${on ? ' on' : ''}" ${attr} aria-pressed="${on}">${esc(label)}</button>`;
const head = (q, sub) => `<h1 class="ob-q">${esc(q)}</h1>${sub ? `<p class="ob-sub">${esc(sub)}</p>` : ''}`;
// 「用 API key」：服务商预设（lib/provider-presets.mjs，GET /api/settings/providers/presets），每家点开看步骤、粘贴 key。
// 保存走 POST /api/settings/providers { action: 'preset_add' }（key 存在 private/providers/），然后用现成的测试调一次。
function keyPresetsHtml() {
  const M = T.model, list = G.keyPresets || [];
  if (!list.length) return '';
  const item = (p, i) => {
    const r = G.keyResult[p.key];
    return `<details class="ob-key" data-ob-key="${esc(p.key)}" ${G.a.keyOpen === p.key || (!G.a.keyOpen && i === 0) ? 'open' : ''}><summary><b>${esc(p.label)}</b><span class="muted small">${esc(p.model)}</span></summary><div class="ob-key-body"><p class="small">${esc(M.price)}${esc(p.price || '')}</p><ol class="ob-key-steps">${(p.steps || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol>${(p.notes || []).map(x => `<p class="ob-note small">${esc(x)}</p>`).join('')}<p class="ob-key-links">${p.signup ? `<a href="${esc(p.signup)}" target="_blank" rel="noopener noreferrer">${esc(M.signup)} ↗</a>` : ''}${p.key_page ? `<a href="${esc(p.key_page)}" target="_blank" rel="noopener noreferrer">${esc(M.keyPage)} ↗</a>` : ''}</p><form class="pf-inline" data-ob-key-form="${esc(p.key)}"><input name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(M.keyPh)}" aria-label="${esc(M.keyLabel)}"><button type="submit" class="primary" ${G.busy ? 'disabled' : ''}>${esc(M.add)}</button></form>${r ? `<p class="${r.ok ? 'ob-ok' : 'ob-err'}" role="status">${esc(r.text)}</p>` : ''}</div></details>`;
  };
  return `<p class="ob-note">${esc(M.keysLead)}</p><div class="ob-keys">${list.map(item).join('')}</div>`;
}
async function addKey(form) {
  const key = form.dataset.obKeyForm, api_key = form.api_key.value.trim(), M = T.model;
  if (!api_key) { form.api_key.focus(); return; }
  G.a.keyOpen = key; G.keyResult[key] = { ok: true, text: M.adding }; repaint();
  try {
    await post('/api/settings/providers', { action: 'preset_add', preset: key, api_key });
    const p = G.keyPresets.find(x => x.key === key);
    const t = await post('/api/settings/test', { backend: `${key}/${p.model}` });
    G.keyResult[key] = t.ok ? { ok: true, text: M.ok(t.model || p.model, t.ms) } : { ok: false, text: M.fail(t.error || '') };
    if (t.ok) await post('/api/onboarding/model', { use: 'key', backend: `${key}/${p.model}` }); // 测通了就用它
    await load();
  } catch (e) { G.keyResult[key] = { ok: false, text: e.message }; }
  repaint();
}
// 模型一步的四个选项，按这个顺序：免费额度（GET /api/model/free 说能用、或者已经开着才有；开不了就不列，免得默认选中一个用不了的）、ChatGPT 账号（GET /api/codex 不是 404 才有，
// 登录界面是桌面版那条线放进槽位的）、这台电脑上的 Claude Code / Codex（找到了才有）、自己的 API key（服务商预设）。
// 默认先选免费额度（桌面版也一样）；已经有能用的模型时，不点别的就保持现在的（下一步什么都不写）。
// Mac 版（服务端给 local_models: null）：「用本机 AI」这张卡一直在，点了才去查（G.local 是查到的）。
const localAsk = () => !!G.view && G.view.local_models === null;
function modelChoices() {
  const l = G.view?.local_models || {};
  return [G.free?.available || G.free?.enabled ? 'free' : null, localAsk() || l.claude || l.codex ? 'local' : null, G.codexSlot ? 'chatgpt' : null, (G.keyPresets || []).length ? 'key' : null].filter(Boolean);
}
// 走引导时占满窗口（#10）：⌘K / Ctrl+K、⌘\ 不打开对话栏。在捕获阶段拦下，面板自己的快捷键（web/panel.js）收不到。
if (typeof window !== 'undefined') window.addEventListener('keydown', e => {
  if (!G.on || !document.querySelector('#main[data-page="onboarding"]')) return;
  const k = String(e.key).toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (k === 'k' || k === '\\')) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
// 「模型」一步：方向键换到上一张 / 下一张，数字键直接选第几张（和点一下一样）；在输入框里打字不算。
// 挂在 window 上：点过一张以后卡片会重画，焦点可能落在 body 上，挂在引导那一块上就收不到了。
if (typeof window !== 'undefined') window.addEventListener('keydown', e => {
  const box = document.querySelector('.ob');
  if (!G.on || !box || screen() !== 'model' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || document.querySelector('dialog[open]')) return;
  const order = [...box.querySelectorAll('[data-ob-model]')].map(b => b.dataset.obModel), now = order.indexOf(activeChoice());
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  const k = step ? order[(Math.max(0, now) + step + order.length) % order.length] : /^[1-9]$/.test(e.key) ? order[Number(e.key) - 1] : null;
  if (!k) return;
  e.preventDefault();
  box.querySelector(`[data-ob-model="${k}"]`)?.click();
});
const focusModel = k => requestAnimationFrame(() => document.querySelector(`.ob [data-ob-model="${k}"]`)?.focus());
// web/codex-login.js（桌面版那条线）登录成功时发 offercrew:codex：把「ChatGPT 账号」标成选好了，重新读一遍模型状态。
if (typeof window !== 'undefined') window.addEventListener('offercrew:codex', e => {
  if (!e.detail?.logged_in) return;
  G.codexDone = true;
  // 只有你点了「ChatGPT 账号」再登录好，才切过去（开箱第 2 轮 X5：以前画这张卡时看到早就登好的——你自己的 ~/.codex——
  // 也当成你选了它，文字模型就悄悄换成了本机的 Codex）。
  if (G.on && G.view && screen() === 'model' && G.a.model === 'chatgpt') post('/api/onboarding/model', { use: 'chatgpt' }).catch(() => {}).then(load).then(repaint, repaint);
});
// 现在真在用的文字模型（设置检查的 models.current：offercrew/…、openai/default、claude_subscription/…、别的是自己加的 key）对应哪张卡。
export function cardOfModel(id, choices = []) {
  const p = String(id || '').split('/')[0];
  // ChatGPT 那张卡只认在 OfferCrew 里登录的账号（openai@app）；默认登录目录的 openai 是这台电脑上的 Codex（10-02 主会话，X5 的后续）。
  const k = !p ? null : p === 'offercrew' ? 'free' : /^openai@/.test(p) ? 'chatgpt' : p === 'openai' || p === 'claude_subscription' ? 'local' : 'key';
  return choices.includes(k) ? k : null;
}
// 亮着的那张就是真正会用的（09-30 新用户实测：亮着免费额度，读岗位用的却是本机的 Codex）：有能用的模型时是它，
// 还没有时是第一张（免费额度），下一步时按它接上。点开的那张（G.a.model）只决定下面显示哪块（登录、粘贴 key）。
// 10-02 负责人（开箱第 2 轮 X5）：Mac 版新装默认走免费额度，这台电脑上已经登录的 Codex / Claude Code 是可选项。以前「有能用的
// 就亮它」：新装时模型模板里的本机 Codex 用的是你自己的 ~/.codex，于是一上来亮的就是它。现在第一次走引导、你还没点过哪张时
// 亮免费额度；下一步时 saveModel 按它真的切过去，亮着的仍然就是会用的那张。
// 10-03 第 5 轮（负责人：「应该都能选才对」）：点过哪张，亮的就是哪张，「下一步」也照它做（saveModel）。以前点过以后这里只看
// 现在真在用的模型，还没有能用的模型时总是回第一张（补给）：框不跟着动，下一步也照样开补给。
export function litCard({ first = false, picked = null, choices = [], models = {} } = {}) {
  if (picked && choices.includes(picked)) return picked;
  if (first && !picked && choices.includes('free')) return 'free';
  return (models.status === 'ok' && cardOfModel(models.current, choices)) || choices[0] || null;
}
// 顶上那一行写的是现在真在用的模型。第一次走引导、亮着的那张（你还没点过时是免费额度）又不是现在用的：不写这一行——
// 下一步就按亮着的那张换过去（saveModel），这一行说的是马上要换掉的那个（10-02 开箱第 3 轮：亮着免费额度，顶上写「文字模型：ChatGPT 账号」，
// 那是这台电脑上原来就登录好的 Codex）。点过哪张就当场换好了，亮着的和这一行又是同一个。
// 还没有能用的模型、亮着的又是免费额度：下一步（Mac 版点跳过也一样，skipTakesFree）就把它接上，也不写「还没有能用的文字模型」；
// 免费额度没列出来（演示、开不了）时照常写。
export function modelNoteShown({ first = false, picked = null, choices = [], models = {} } = {}) {
  if (!first) return true;
  const lit = litCard({ first, picked, choices, models });
  return models.status === 'ok' ? lit === cardOfModel(models.current, choices) : lit !== 'free';
}
// 「跳过」照默认来，什么都不写。Mac 版「模型」一步的默认就是免费额度（10-02 主会话：Mac 版的模型表里不放这台电脑上的
// Claude Code / Codex，lib/data-root.mjs seedDesktopDefaults）：还没有能用的模型时，跳过也把免费额度接上；接不上（额度用完、
// 连不上）照样往下走，不换成本机的。命令行安装照旧：跳过什么都不写（模板里本机的就是默认）。
export const skipTakesFree = ({ desktop = null, models = {}, choices = [] } = {}) => !!desktop && models.status !== 'ok' && choices.includes('free');
async function skip() {
  if (G.busy || directionMissing(screen())) return;
  if (screen() === 'model' && G.free?.signed_in && skipTakesFree({ desktop: G.desktop, models: G.view?.models || {}, choices: modelChoices() })) {
    G.busy = true; repaint();
    try { await startFree(); } catch {}
    G.busy = false;
  }
  return go(1);
}
const activeChoice = () => litCard({ first: G.mode === 'first', picked: G.a.model || null, choices: modelChoices(), models: G.view?.models || {} });
const modelChoice = () => { const list = modelChoices(); return list.includes(G.a.model) ? G.a.model : activeChoice(); };
async function loadFree() {
  try { const r = await fetch('/api/model/free'); if (r.status === 404 || !r.ok) return null; return await r.json(); } catch { return null; }
}
// 下一步时：你点过选项，或者现在还没有能用的模型，才按选的做（免费额度开起来 / 换成本机的）；
// 免费额度开不了（演示、沙盒、额度停了）：只显示那句原因，照样往下走。
// 存的就是亮着的那张（你点的，没点过就是默认的补给）：
//   补给      现在用的不是它就开起来（新装时模板里的本机模型已经能用，也换过去）；
//   自己的 key、本机 AI、ChatGPT 账号  点卡片、保存 key、点「用 Codex」、登录好的时候已经换好了；还没接好就什么都不写——不悄悄换成补给。
export function modelSaveAction({ choice = null, models = {}, choices = [], localAsk = false } = {}) {
  if (choice === 'free') return models.status === 'ok' && cardOfModel(models.current, choices) === 'free' ? null : 'free';
  if (choice === 'local' && !localAsk && models.status !== 'ok') return 'local';
  return null;
}
async function saveModel() {
  const act = modelSaveAction({ choice: activeChoice(), models: G.view.models || {}, choices: modelChoices(), localAsk: localAsk() });
  if (act === 'free') await startFree();
  if (act === 'local') await post('/api/onboarding/model', { use: 'local' });
}
// 补给：领好令牌，并且让它当文字模型和对话默认（make_default），已经开着的也切过去。
async function startFree() {
  const f = G.free || {};
  if (f.demo || f.available === false || f.paused) return;
  // 10-03：补给跟着账户走，没登录先登录（左下角那个登录框，web/account.js）；登好了在 oc:account 里接着开。
  if (!f.signed_in) { window.dispatchEvent(new CustomEvent('oc:login')); throw new Error(T.model.loginFirst); }
  try { const r = await post('/api/model/free', { action: 'start', make_default: true }); G.freeMsg = T.model.freeStarted(r.remaining_label); G.free = { ...f, enabled: true, remaining_label: r.remaining_label ?? f.remaining_label }; }
  // 开不了（中转没开、连不上、名额满了）：不列这个选项，改选下一个，停在这一步说清楚。
  catch (e) { G.free = { ...f, available: false, reason: e.message }; G.a.model = modelChoices()[0]; throw new Error(T.model.freeFailed(e.message)); }
}
// 点哪张就当场换成哪张，顶上那行跟着变。自己的 key 要保存、测通了才切（addKey）；ChatGPT 账号没登录时先登录（登录好了在 offercrew:codex 里切）。
async function checkLocal() {
  G.localBusy = true; repaint();
  try { G.local = (await post('/api/onboarding/model', { use: 'local_check' })).local || {}; } finally { G.localBusy = false; }
}
async function useChoice(k) {
  if (k === 'free' && !G.free?.signed_in) return; // 没登录：下面那块放「登录」
  if (k === 'free') await startFree();
  // Mac 版点了只查、不换：查到了下面给按钮，你点哪个才换成哪个（data-ob-local）。
  else if (k === 'local' && localAsk()) { if (!G.local) await checkLocal(); return; }
  else if (k === 'local') await post('/api/onboarding/model', { use: 'local' });
  else if (k === 'chatgpt' && G.view?.local_models?.codex) await post('/api/onboarding/model', { use: 'chatgpt' });
  else return;
  await load();
}
// Mac 版「用本机 AI」点开以后：查到的每个一个按钮（正在用的那个写一句），没找到、没登录照实说，可以再查一次。
const LOCAL_NAME = { claude: 'Claude Code', codex: 'Codex' }, LOCAL_REF = { claude: 'claude_subscription', codex: 'openai' };
function localPanel(m) {
  const M = T.model, l = G.local;
  if (G.localBusy || !l) return `<p class="ob-note">${esc(M.localChecking)}</p>`;
  const found = ['claude', 'codex'].filter(k => l[k]), using = m.status === 'ok' ? found.find(k => String(m.current || '').split('/')[0] === LOCAL_REF[k]) : null;
  const again = `<button type="button" class="secondary" data-ob-local-check>${esc(M.localAgain)}</button>`;
  if (!found.length) return `<p class="ob-note">${esc(l.unlogged?.length ? M.localUnlogged(l.unlogged.map(k => LOCAL_NAME[k]).join('、')) : M.localNone)}</p><div class="ob-actions">${again}</div>`;
  return `${using ? `<p class="ob-ok">${esc(M.localUsing(LOCAL_NAME[using]))}</p>` : ''}<div class="ob-actions">${found.filter(k => k !== using).map(k => `<button type="button" class="primary" data-ob-local="${k}" ${G.busy ? 'disabled' : ''}>${esc(M.localUse[k])}</button>`).join('')}</div>`;
}
// 要登录的站（Mac 版，lib/unlock.mjs 的 login:* 那几行）：「现在登录」那一页和最后一页用。
const loginRows = () => (G.view?.unlock || []).filter(r => String(r.key).startsWith('login:') && r.url);
// 登录看守看到登好了（web/app.js 收到 SSE 的 login 事件转过来）：在引导里就重新读一遍，那一行打勾。
if (typeof window !== 'undefined') window.addEventListener('offercrew:login', () => { if (G.on && G.view) load().then(repaint, () => {}); });
// 简历草稿当时没有模型、只按版式整理（offline），现在有能用的模型了：给「用模型重新解析」（extractDraft force）。
const reparseWanted = () => { const p = deps?.pending?.(); return !!(p && p.status === 'extracted' && p.offline && G.view?.models?.status === 'ok'); };
const BODY = {
  stage: () => head(T.stage.q, T.stage.sub) + `<div class="ob-options three">${Object.entries(T.stage.cards).map(([k, [t, s]]) => card(`data-ob-stage="${k}"`, cur('stage') === k, t, s)).join('')}</div>`,
  direction: () => {
    const presets = G.view.presets || [];
    if (!presets.length) return head(T.direction.q, T.direction.none);
    const p = presetOf(cur('preset')), tracks = cur('tracks') || [];
    const sub = p?.tracks?.length ? `<div class="ob-tracks"><p class="ob-label">${esc(T.direction.tracks(p.name))}</p><div class="ob-chips">${p.tracks.map(t => chip(`data-ob-track="${esc(t.key)}"`, tracks.includes(t.key), t.name)).join('')}</div></div>` : '';
    return head(T.direction.q, T.direction.sub) + `<div class="ob-options grid">${presets.map(x => card(`data-ob-preset="${esc(x.key)}"`, x.key === p?.key, x.name, x.blurb)).join('')}</div>${sub}`;
  },
  cities: () => {
    const picked = cur('cities') || [], all = [...new Set([...(G.view.cities || []), ...picked])];
    return head(T.cities.q, T.cities.sub) + `<div class="ob-chips">${all.map(c => chip(`data-ob-city="${esc(c)}"`, picked.includes(c), c)).join('')}</div><form class="ob-add" data-ob-add><input name="city" maxlength="40" placeholder="${esc(T.cities.other)}" aria-label="${esc(T.cities.other)}"><button type="submit" class="secondary">${esc(T.cities.add)}</button></form>${picked.length ? `<p class="ob-picked">${esc(T.cities.picked)}${esc(picked.join(' → '))}</p>` : ''}` + authBox();
  },
  salary: () => head(T.salary.q, T.salary.sub) + `<label class="ob-field"><span>${esc(T.salary.label)}</span><input name="salary" maxlength="120" value="${esc(cur('salary') || '')}" placeholder="${esc(T.salary.placeholder)}"></label><div class="ob-chips">${T.salary.quick.map(q => chip(`data-ob-salary="${esc(q)}"`, cur('salary') === q, q)).join('')}</div>`,
  mode: () => { const picked = cur('work_mode') || []; return head(T.mode.q, T.mode.sub) + `<div class="ob-options three">${(G.view.work_modes || []).map(m => card(`data-ob-mode="${esc(m.key)}"`, picked.includes(m.key), m.name, T.mode.cards[m.key] || '', picked.includes(m.key) ? `<em>${picked.indexOf(m.key) + 1}</em>` : '')).join('')}</div>`; },
  resume: () => {
    const r = G.view.resume || {}, hints = G.view.hints?.resume || [], pending = deps?.pending?.();
    return head(T.resume.q, T.resume.sub) + `<div class="ob-status${r.status && r.status !== 'missing' ? ` st-${esc(r.status)}` : ''}"><b>${esc(r.summary || '')}</b></div>${hints.length ? `<div class="ob-hints"><p class="ob-label">${esc(T.resume.hints)}</p><ul>${hints.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}<div class="ob-actions"><button type="button" class="primary" data-ob-import>${esc(pending?.materials?.status === 'pending' ? T.resume.materials : pending ? T.resume.continue : T.resume.import)}</button>${reparseWanted() ? `<button type="button" class="secondary" data-ob-reparse>${esc(T.resumeReparse)}</button>` : ''}</div>${reparseWanted() ? `<p class="ob-note">${esc(T.resumeReparseWhy)}</p>` : ''}`;
  },
  model: () => {
    const m = G.view.models || {}, M = T.model, choice = modelChoice();
    const shown = modelNoteShown({ first: G.mode === 'first', picked: G.a.model || null, choices: modelChoices(), models: m });
    const status = !shown ? '' : m.status === 'ok' ? `<p class="ob-note">${esc(M.keep(m.summary || ''))}</p>` : m.status === 'missing' ? `<p class="ob-note">${esc(M.none)}</p>` : m.summary ? `<p class="ob-status st-warn"><b>${esc(m.summary)}</b></p>` : '';
    const sub = { ...Object.fromEntries(Object.entries(M.choices).map(([k, [, x]]) => [k, x])), local: localAsk() ? (G.local ? M.localFound(G.local) : '') : M.localFound(G.view.local_models || {}), ...(G.free?.remaining_label ? { free: G.free.remaining_label } : {}) };
    // 两个主选项：OfferCrew 补给（官方额度，要登录）、自己的 API key（10-03 负责人）；「用本机 AI」那张卡在后面（A 线：点了再查）；ChatGPT 账号是后面的小按钮。
    const active = activeChoice(), list = modelChoices(), main = list.filter(k => k === 'free' || k === 'key'), second = list.filter(k => k === 'local'), alt = list.filter(k => !main.includes(k) && !second.includes(k));
    const cards = main.map(k => card(`data-ob-model="${k}"`, active === k, M.choices[k][0], sub[k])).join('');
    const seconds = second.length ? `<div class="ob-options one ob-second">${second.map(k => card(`data-ob-model="${k}"`, active === k, M.choices[k][0], sub[k])).join('')}</div>` : '';
    const alts = alt.length ? `<div class="ob-alts">${alt.map(k => `<button type="button" class="ms-alt ${active === k || choice === k ? 'on' : ''}" data-ob-model="${k}" aria-pressed="${active === k}">${esc(M.choices[k][0])}</button>`).join('')}</div>` : '';
    const f = G.free || {};
    const panel = {
      free: () => `<p class="ob-note ob-privacy">${esc(M.freePrivacy)}</p>${!f.signed_in && !f.demo && f.available !== false ? `<div class="ob-actions"><button type="button" class="primary" data-ob-account-login>${esc(M.login)}</button></div>` : ''}${f.demo || f.available === false || f.paused ? (f.reason && f.reason !== m.summary ? `<p class="ob-status st-warn"><b>${esc(f.reason)}</b></p>` : '') : f.enabled ? `<p class="ob-ok">${esc(M.freeOn)}</p>` : ''}${G.freeMsg ? `<p class="ob-ok">${esc(G.freeMsg)}</p>` : ''}`,
      chatgpt: () => `${G.codexDone ? `<p class="ob-ok">${esc(M.chatgptDone)}</p>` : ''}${codexSlotHtml()}`,
      local: () => (localAsk() ? localPanel(m) : `<p class="ob-note">${esc(M.localNote)}</p>`),
      key: () => keyPresetsHtml(),
    }[choice]?.() || '';
    return head(M.q, M.sub) + status + `<div class="ob-options ${main.length === 1 ? 'one' : 'two'}">${cards}</div>${seconds}${alts}<div class="ob-model-panel">${panel}</div>`;
  },
  channels: () => {
    const c = G.view.channels || { sources: [] }, on = cur('channels') || {};
    const pack = c.pack && !c.pack.exists ? `<p class="ob-note">${esc(T.channels.noPack)}</p>` : '';
    return head(T.channels.q, T.channels.sub) + pack + `<div class="ob-switches">${c.sources.map(s => `<label class="ob-switch"><input type="checkbox" data-ob-channel="${esc(s.key)}" ${on[s.key] ? 'checked' : ''}><span class="ob-switch-body"><b>${esc(s.name)}</b>${s.recommended ? `<em>${esc(T.channels.recommended)}</em>` : ''}${s.note ? `<small>${esc(s.note)}</small>` : ''}</span></label>`).join('')}</div>` + entriesHtml(c.entries, esc);
  },
  // 收发求职邮件用的邮箱（资料里的 identity.mailbox；没写过就是简历上的邮箱），下面接着连上它（web/mail-connect.js：授权码 → 测试 → 保存）。
  // 不连也能往下走（「以后再说」）；连上的邮箱改地址要先断开。
  mail: () => head(T.mail.q, '') + (MAIL.view?.connected || MAIL.view?.status ? '' : `<label class="ob-field"><span>${esc(T.mail.label)}</span><input name="mailbox" type="email" autocomplete="email" maxlength="120" value="${esc(cur('mailbox') || '')}" placeholder="${esc(T.mail.placeholder)}"></label>`) + mailConnectHtml(MAIL, esc),
  phone: () => head(T.phone.q, T.phone.sub) + phoneBody(G.phone || {}, { esc, fmt: h.fmt, where: 'guide' }),
  // 现在登录：每个站一行。点了在专用 Chrome 里打开登录页，登好以后这一行自己打勾（不用回来点「我登好了」）；整页可以跳过，没登的进「还差几步」。
  logins: () => head(T.logins.q, '') + `<div class="ob-hints"><ul class="ob-left-list ob-logins">${loginRows().map(r => `<li${r.done ? ' class="is-done"' : ''}><span><b>${esc(r.label)}</b><small>${esc(r.done ? T.logins.done : r.why || '')}</small></span>${r.done ? '<em class="ob-ok" aria-label="登好了">✓</em>' : `<button type="button" class="secondary mini" data-ob-login="${esc(r.url)}" data-ob-account="${esc(r.account || '')}">${esc(T.logins.open)}</button>`}</li>`).join('')}</ul></div>`,
  done: () => {
    const f = G.view.facts || {}, R = T.done.rows, p = presetOf(f.preset), none = T.done.none, unset = T.done.unset;
    const on = (G.view.channels?.sources || []).filter(s => s.enabled).map(s => s.name);
    const rows = [
      // 你要填的几项空着写「没填」（第 4 轮 F03：工作许可空着写成「还没有」，读起来像没有资格）。
      [R.stage, T.stage.cards[f.stage]?.[0] || unset],
      [R.direction, p ? `${p.name}${f.tracks?.length ? `（${f.tracks.map(t => p.tracks.find(x => x.key === t)?.name || t).join('、')}）` : ''}` : unset],
      [R.cities, (f.cities || []).join('、') || unset], [R.auth, authText(f.work_auth) || unset], [R.salary, f.salary || unset],
      [R.mode, (f.work_mode || []).map(k => G.view.work_modes.find(m => m.key === k)?.name || k).join(' → ') || unset],
      [R.resume, G.view.resume?.summary || none], [R.model, G.view.models?.summary || none],
      [R.channels, [...on, ...addedNames(G.view.channels?.entries)].join('、') || none], [R.companies, T.done.companies(G.view.companies?.total || 0)],
    ];
    const prep = G.view.hints?.interview || [], src = G.view.hints?.interview_sources || [];
    const prepHtml = prep.length ? `<div class="ob-hints"><p class="ob-label">${esc(T.done.prep)}</p><ul>${prep.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${src.length ? `<p class="ob-note">${esc(T.done.sources(src))}</p>` : ''}</div>` : '';
    const desk = G.desktop ? `<div class="ob-hints"><p class="ob-label">${esc(T.desktop)}</p>${desktopControlsHtml(G.desktop, esc)}</div>` : '';
    // 还差几步（Mac 版，第 6b 轮：邮箱、要登录的站藏得深，没人教就找不到）：必须做、还没做的，每件一行一个按钮，就在这一页动手。
    // 登录：在专用 Chrome 里打开登录页（登录看守随后自己看，登好了收件箱那封清单信上这一行就打勾）；邮箱：回到引导里接邮箱那一步。
    const left = (G.view.unlock || []).filter(r => r.required && !r.done && (r.url || (r.key === 'mail' && G.screens.some(([k]) => k === 'mail'))));
    const leftHtml = left.length ? `<div class="ob-hints ob-left"><p class="ob-label">${esc(T.done.left(left.length))}</p><ul class="ob-left-list">${left.map(r => `<li><span><b>${esc(r.label)}</b>${r.why ? `<small>${esc(r.why)}</small>` : ''}</span>${r.url ? `<button type="button" class="secondary mini" data-ob-login="${esc(r.url)}" data-ob-account="${esc(r.account || '')}">${esc(T.done.openLogin)}</button>` : `<button type="button" class="secondary mini" data-ob-goto="mail">${esc(r.label)}</button>`}</li>`).join('')}</ul></div>` : '';
    return `<div class="ob-hero" aria-hidden="true">✓</div>` + head(T.done.q, T.done.sub) + `<dl class="ob-summary">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${leftHtml}${desk}${prepHtml}<div class="ob-actions"><a class="primary" href="#command" data-ob-command>${esc(T.done.go)}</a><a class="secondary" href="#settings/setup" data-ob-leave>${esc(T.done.list)}</a></div>`;
  },
};

// ── 交互 ────────────────────────────────────────────────────────────────────
function repaint() {
  const box = document.querySelector('.ob');
  if (!box) return;
  box.outerHTML = render();
  bindGuide();
}
// 第一次走完引导：马上开始第一轮找岗位（和指挥台「找新岗位」、团队页 Radar「立即跑一轮」同一个 op），不等下一轮定时任务。
// 发起就行，不等它跑完；空的指挥台上会显示「正在找第一批岗位」。跑不了（比如要模型、现在没有）也不挡住引导。
// Radar 扫完 Judge 接着判断（op round-first，lib/command-center.mjs）：只扫不判的话，第一批岗位要等下一轮定时周期才出现（09-30 新用户实测）。
export const FIRST_ROUND = { member: 'scout', op: 'round-first' };
function startFirstRound() { G.firstRound = 'started'; post('/api/team/run', FIRST_ROUND).catch(() => { G.firstRound = 'failed'; }); }
async function post(path, body) { return deps.send(path, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
// 这一屏要写什么：只在和资料里现在的不一样时写（跳过的屏不会走到这里）。
async function saveScreen(key) {
  const f = G.view.facts || {};
  const answers = async values => { const r = await post('/api/onboarding/answers', { base: f.sig, values }); if (r.sig) f.sig = r.sig; return r; };
  if (key === 'stage' && cur('stage') && cur('stage') !== f.stage) await answers({ stage: cur('stage') });
  if (key === 'direction' && cur('preset') && (cur('preset') !== f.preset || !same(cur('tracks') || [], f.tracks || []))) await answers({ preset: cur('preset'), tracks: cur('tracks') || [] });
  // 这个方向的公司包直接加进清单（只加还没有的、可以重复点）；没有公司包的方向不加，也不拦你往下走。
  if (key === 'direction' && cur('preset')) { try { await post('/api/onboarding/companies', { preset: cur('preset'), action: 'add' }); } catch (e) { console.warn('[onboarding] company pack', e.message); } }
  if (key === 'mail') {
    const v = String(cur('mailbox') || '').trim();
    if (v && v !== (f.mailbox || '')) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw Error(T.mail.bad); await answers({ mailbox: v }); }
  }
  if (key === 'cities' && !same(cur('cities') || [], f.cities || [])) await answers({ cities: cur('cities') || [] });
  if (key === 'cities' && !same(authOf(cur('work_auth')), authOf(f.work_auth))) await answers({ work_auth: authOf(cur('work_auth')) });
  if (key === 'salary' && (cur('salary') || '') !== (f.salary || '')) await answers({ salary: cur('salary') || '' });
  if (key === 'mode' && !same(cur('work_mode') || [], f.work_mode || [])) await answers({ work_mode: cur('work_mode') || [] });
  if (key === 'model') await saveModel();
  if (key === 'channels') {
    const now = Object.fromEntries((G.view.channels?.sources || []).map(s => [s.key, s.enabled])), want = cur('channels') || {};
    const enabled = Object.fromEntries(Object.entries(want).filter(([k, v]) => now[k] !== v));
    if (Object.keys(enabled).length) await post('/api/onboarding/channels', { enabled });
  }
}
async function go(delta, { save = false } = {}) {
  if (delta > 0 && directionMissing(screen())) return;
  if (G.busy) return;
  G.err = '';
  if (save) {
    G.busy = true; repaint();
    try { await saveScreen(screen()); } catch (e) { G.busy = false; G.err = e.message; repaint(); return; }
    G.busy = false;
  }
  G.at = Math.max(0, Math.min(G.screens.length - 1, G.at + delta));
  // 选过方向，渠道包和公司包跟着换：重新读一遍（资料里刚写的也一起读回来）。
  try { await load(); } catch (e) { G.err = e.message; }
  G.at = stepTo(G.screens, G.at, delta, loginRows().length > 0);
  if (screen() === 'mail') { try { await loadMail(MAIL); if (!MAIL.view.connected && !MAIL.view.status) await detectMail(MAIL, cur('mailbox'), post); } catch (e) { G.err = e.message; } }
  if (screen() === 'done' && !G.finished) { try { await post('/api/onboarding/finish', {}); G.finished = true; } catch (e) { G.err = e.message; } if (G.finished && G.mode === 'first') startFirstRound(); }
  repaint();
  document.querySelector('.ob')?.scrollIntoView({ block: 'start' });
}
// 出口：第一次进来的是「跳过，先看看」（记下 skipped，去指挥台，那里留一张小卡片）；从设置进来的回设置。
async function exit(t) {
  t.disabled = true;
  if (G.mode === 'first') { try { await post('/api/onboarding/state', { action: 'skip' }); } catch (e) { h.toast(e.message); } }
  stopGuide();
  location.hash = G.mode === 'first' ? '#command' : '#settings/prefs';
}
const toggle = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
export function bindGuide() {
  const box = document.querySelector('.ob');
  if (!box) return;
  box.addEventListener('click', async e => {
    const t = e.target.closest('button, a');
    if (!t || !box.contains(t)) return;
    const d = t.dataset;
    if ('obExit' in d) return exit(t);
    if ('obLeave' in d) { stopGuide(); return; } // 链接照常跳过去
    if ('obBack' in d) return go(-1);
    if ('obSkip' in d) return skip();
    if ('obAccountLogin' in d) { window.dispatchEvent(new CustomEvent('oc:login')); return; }
    if ('obNext' in d) return go(1, { save: true });
    if (d.obStage) { G.a.stage = d.obStage; return repaint(); }
    if (d.obModel) { const k = d.obModel; G.a.model = k; G.err = ''; repaint(); focusModel(k); return useChoice(k).then(() => { repaint(); focusModel(k); }, x => { G.err = x.message; repaint(); focusModel(k); }); }
    if ('obLocalCheck' in d) { G.err = ''; return checkLocal().then(repaint, x => { G.err = x.message; repaint(); }); }
    if (d.obLocal) { G.err = ''; G.busy = true; repaint(); return post('/api/onboarding/model', { use: 'local', pick: d.obLocal }).then(load).then(() => { G.busy = false; repaint(); }, x => { G.busy = false; G.err = x.message; repaint(); }); }
    // 最后一页「还差几步」：打开登录页（专用 Chrome，登录看守随后自己看），或者回到接邮箱那一步。
    if (d.obLogin) { t.disabled = true; post('/api/open-url', { url: d.obLogin, account: d.obAccount || null }).then(r => h.toast(r?.receipt || T.done.opened), x => h.toast(x.message)).finally(() => { t.disabled = false; }); return; }
    if (d.obGoto) { const i = G.screens.findIndex(([k]) => k === d.obGoto); if (i >= 0) { G.at = i; G.err = ''; repaint(); } return; }
    if ('obReparse' in d) { deps.reparse().then(() => load()).then(repaint, x => h.toast(x.message)); return; }
    if (d.obPreset) { if (G.a.preset !== d.obPreset) { G.a.preset = d.obPreset; G.a.tracks = presetOf(d.obPreset)?.key === G.view.facts?.preset ? G.view.facts.tracks : []; } return repaint(); }
    if (d.obTrack) { G.a.tracks = toggle(cur('tracks') || [], d.obTrack); return repaint(); }
    if (d.obCity) { G.a.cities = toggle(cur('cities') || [], d.obCity); return repaint(); }
    if (d.obAuth) { const [r, v] = d.obAuth.split(':'), a = authOf(cur('work_auth')); a[r] = a[r] === v ? '' : v; G.a.work_auth = a; return repaint(); }
    if (d.obSalary) { G.a.salary = d.obSalary; return repaint(); }
    if (d.obMode) { G.a.work_mode = toggle(cur('work_mode') || [], d.obMode); return repaint(); }
    if ('obImport' in d) { deps.openImport().catch(x => h.toast(x.message)); return; }
    if ('obCommand' in d) { stopGuide(); } // 链接照常跳到指挥台
    // 搜好的入口：加上 / 撤掉当场就存（不等「下一步」），存完重读再画；链接照常在新窗口打开。
    if (entriesClick(t, { toast: h.toast, save: body => post('/api/onboarding/entries', body).then(load).then(repaint, x => { G.err = x.message; repaint(); }) })) return;
  });
  if (screen() === 'done' && G.desktop) bindDesktop(box, { toast: h.toast });
  box.querySelectorAll('[data-ob-key-form]').forEach(f => f.addEventListener('submit', e => { e.preventDefault(); addKey(f); }));
  box.querySelectorAll('details[data-ob-key]').forEach(d => d.addEventListener('toggle', () => { if (d.open) G.a.keyOpen = d.dataset.obKey; }));
  if (screen() === 'mail') {
    bindMailConnect(box, MAIL, { post, address: () => String(cur('mailbox') || '').trim(), repaint });
    // 地址填完（离开输入框）再认是哪家的邮箱。
    box.querySelector('[name="mailbox"]')?.addEventListener('change', e => detectMail(MAIL, e.target.value, post).then(changed => { if (changed) repaint(); }));
  }
  if (screen() === 'phone') bindPhone(box, { view: G.phone, post: body => post('/api/phone', body), repaint: v => { G.phone = v; repaint(); }, toast: h.toast });
  box.addEventListener('change', e => { const k = e.target.dataset?.obChannel; if (k) G.a.channels = { ...(cur('channels') || {}), [k]: e.target.checked }; });
  box.addEventListener('input', e => { if (e.target.name === 'salary') G.a.salary = e.target.value; if (e.target.name === 'mailbox') G.a.mailbox = e.target.value; });
  box.querySelector('[data-ob-add]')?.addEventListener('submit', e => {
    e.preventDefault();
    const v = e.target.city.value.replace(/\s+/g, ' ').trim();
    if (v) { const list = cur('cities') || []; if (!list.includes(v)) G.a.cities = [...list, v]; }
    repaint();
    document.querySelector('.ob [name="city"]')?.focus();
  });
}

// 登录好了（web/account.js 发 oc:account）：停在「模型」这一步就重读补给，接着把试用开起来、当文字模型。
if (typeof window !== 'undefined') window.addEventListener('oc:account', async () => {
  if (!G.on || screen() !== 'model') return;
  G.free = await loadFree();
  if (!G.free?.signed_in) return repaint();
  G.err = '';
  try { await startFree(); await load(); } catch (e) { G.err = e.message; }
  repaint();
});
