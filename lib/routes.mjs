// 页内链接一张表（rebuild7/one-source，10-10）：有哪些页、每一页认哪些参数、旧地址换成什么。
// 服务端拼的链接（成员页、任务卡、收件箱回执……）和页面（浏览器经 /routes.js 取同一个文件）都从这里生成；
// tests/routes.test.mjs 扫出所有页面和服务端代码里写死的 #页名，逐个确认落在这张表上。
// 纯函数，不读文件、不引 node 模块。
//
//   电脑    #command #team #tasks #inbox #materials #stream #settings #lead/<rid> #onboarding
//   面板    #chat…（旧对话页）、#talk?session=…（任务卡「在对话里答」）：打开右侧对话，不换主区
//   手机    #talk #tasks #wait #me（web/phone/logic.js route；电脑的 #inbox?ask= 也认）

// 主区的页：名字就是左栏、页头上的字。
export const PAGES = {
  command: '指挥台', team: '团队', tasks: '任务', inbox: '收件箱', materials: '材料', stream: '运行日志', settings: '设置', lead: '岗位', onboarding: '开始使用',
};
// 不是一页、由别处接手的地址：面板（对话）、登录框、引导入口（web/first-run.js setupTarget 定去哪）。
export const PANEL = new Set(['chat', 'talk']);
export const HANDLED = new Set(['login', 'setup']);
// 每一页认的参数（地址 ? 后面的）；表上没有的参数照留，但链接只用这些拼。
export const PARAMS = {
  command: ['tab', 'verdict', 'q', 'n', 'only', 'talk'],
  team: ['section'], tasks: ['owner', 'task', 'card', 'goal', 'lead', 'talk'], inbox: ['ask', 'tab', 'talk'],
  materials: ['doc', 'tab', 'v', 'key'], stream: ['flow', 'run', 'job', 'action', 'task', 'q'], settings: ['q', 'hl', 'jump'], lead: ['tab'], onboarding: [],
};
// 指挥台的标签（lib/hq.mjs TABS 的键）：链接里 tab= 只能是这几个。
export const COMMAND_TABS = ['new', 'verify', 'approve', 'moving', 'waiting', 'interview', 'ended', 'all'];

const enc = x => encodeURIComponent(String(x));
const qs = (o = {}) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '' && v !== false) p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };

// ── 拼链接 ───────────────────────────────────────────────────────────────────
export const href = {
  command: ({ tab = null, verdict = null, q = null, n = null } = {}) => `#command${qs({ tab: COMMAND_TABS.includes(tab) ? tab : null, verdict, q, n })}`,
  // 全部岗位（旧「岗位看板」并进来的那一张）：按结论筛（推荐 / 待核 / 排除 / 预筛掉 / 还没判断）。
  jobs: (verdict = null) => href.command({ tab: 'all', verdict }),
  lead: (rid, { tab = null } = {}) => rid ? `#lead/${enc(rid)}${qs({ tab: ['jd', 'mat', 'prog', 'co'].includes(tab) ? tab : null })}` : '#command',
  inbox: (ask = null) => ask ? `#inbox?ask=${enc(ask)}` : '#inbox',
  accounts: () => '#inbox?tab=accounts',
  team: (id = null, params = {}) => (id ? `#team/${enc(id)}` : '#team') + qs({ section: params.section }),
  tasks: ({ owner = null, task = null, card = null, goal = null, lead = null } = {}) => `#tasks${qs({ owner, task, card, goal, lead })}`,
  stream: ({ flow = null, run = null, job = null, action = null, task = null, q = null } = {}) => `#stream${qs({ flow, run, job, action, task, q })}`,
  materials: (sub = '', params = {}) => `#materials${sub ? `/${sub}` : ''}${qs(params)}`,
  settings: (sub = '', params = {}) => `#settings${sub ? `/${sub}` : ''}${qs(params)}`,
  memory: () => '#settings/advanced/memory',
  talk: ({ session = null, m = null } = {}) => `#talk${qs({ session, m })}`,
  onboarding: () => '#onboarding',
};
// 手机上的地址（web/phone/logic.js route / hashOf 认的样子）。
export const phoneHref = {
  wait: (ask = null) => ask ? `#wait/${enc(ask)}` : '#wait',
  talk: (session = null) => session ? `#talk/${session}` : '#talk',
  tasks: (task = null) => task ? `#tasks/${enc(task)}` : '#tasks',
  me: () => '#me',
};

// ── 旧地址 ───────────────────────────────────────────────────────────────────
// 旧页名 → 现在的地址（参数一起换）。岗位看板（board）并进指挥台的「全部」；记忆库在设置 · 高级里；#log 是运行日志。
const BOARD_VERDICT = { prefiltered: 'prefilter', exclude: 'exclude', recommend: 'recommend', verify: 'verify', none: 'none' };
const ALIAS = {
  board: (rest, p) => href.command({ tab: 'all', verdict: BOARD_VERDICT[p.get('verdict')] || null, q: p.get('q') || null }),
  memory: () => href.memory(),
  log: (rest, p) => href.stream({ run: p.get('run') || null, q: p.get('task') || p.get('q') || null }),
  overview: () => '#command',
  usage: () => '#settings/spend',
  resume: (rest, p) => `#materials${rest.length ? '/' + rest.join('/') : ''}${p.toString() ? '?' + p : ''}`,
  wait: rest => href.inbox(rest[0] ? safeDecode(rest[0]) : null),
};
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

// 一个地址落在哪：{ page, rest（/ 后面几段）, params, hash（规范写法；旧地址换成新的） }；认不出的页名 → null。
// 空地址算指挥台。面板地址 page 是 'chat' / 'talk'（panel: true），主区不换。
export function resolve(hash = '') {
  const raw = String(hash || '').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const [name = '', ...rest] = path.split('/');
  const p = new URLSearchParams(query);
  if (!name) return { page: 'command', rest: [], params: p, hash: '#command' };
  if (Object.hasOwn(ALIAS, name)) return resolve(ALIAS[name](rest, p));
  if (PANEL.has(name)) return { page: name, rest, params: p, hash: `#${raw}`, panel: true };
  if (HANDLED.has(name)) return { page: name, rest, params: p, hash: `#${raw}`, handled: true };
  if (!Object.hasOwn(PAGES, name)) return null;
  return { page: name, rest, params: p, hash: `#${raw}` };
}
// 这个地址点得通吗（测试、开发时查链接用）：页名认得；岗位页要带 rid；成员页的 id 由调用方查。
export function routable(hash) {
  const r = resolve(hash);
  if (!r) return false;
  if (r.page === 'lead' && !r.rest[0]) return false;
  if (r.page === 'command' && r.params.get('tab') && !COMMAND_TABS.includes(r.params.get('tab'))) return false;
  return true;
}

// 外部链接的读契约：旧网址字符串和 {url, label} 共用一处校验。
export function externalLink(value) {
  const link = typeof value === 'string' ? { url: value } : value;
  if (!link || typeof link.url !== 'string') return null;
  try {
    const url = new URL(link.url);
    return ['http:', 'https:'].includes(url.protocol) ? { url: link.url, label: typeof link.label === 'string' ? link.label : '打开' } : null;
  } catch { return null; } // 兜底：坏链接不变成窗口内的相对地址
}
