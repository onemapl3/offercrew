// 电脑操作的配置（config/computer-use.json，2026-09-28）：每个站点交给哪种驱动、内置操作员用什么浏览器和模型。
//
// 驱动：codex = Codex 桌面版的电脑操作（现有，操作你的 Chrome）；builtin = 内置操作员（lib/operator，
// 任何 HTTP 模型 + 自己的浏览器，停在提交前）；cua = trycua 的 cua-driver（目前只检测，见 cua.mjs）。
// per_host 优先于 default；一个站点可以写一串，前一个报 unavailable（没装、没配模型）才换下一个。
// 本机文件不存在时读模板 config/computer-use.example.json（lib/store.mjs），模板和缺省值一样：所有站点都走 codex。哪些站点允许电脑操作，仍由
// config/pipeline.json 的 computer_use（enabled / allow_hosts / never_hosts）决定，这里不放宽任何范围。
import { read } from '../store.mjs';
import { appShell } from '../capabilities.mjs';

export const COMPUTER_USE_CONFIG = 'config/computer-use.json';
export const DRIVER_NAMES = ['codex', 'builtin', 'cua'];
export const DRIVER_LABELS = { codex: 'Codex 电脑操作（Chrome）', builtin: '内置操作员', cua: 'Cua Driver' };
export const OPERATOR_DEFAULTS = { backend: 'playwright', channel: 'auto', headless: false, profile_dir: 'private/operator-profile', provider: null, model: null, vision: false, max_steps: 25, recipes: true, stop_before: null };

const driverList = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
export function computerUseSettings(raw = read(COMPUTER_USE_CONFIG, null) || {}) {
  const perHost = Object.fromEntries(Object.entries(raw.drivers?.per_host || {}).map(([h, v]) => [String(h).toLowerCase(), driverList(v)]).filter(([, v]) => v.length));
  const def = driverList(raw.drivers?.default);
  // 操作员用哪个浏览器：没写时，App 里在专用 Chrome 里操作（同一份登录状态）；不在 App 壳里（测试、开发）照旧自己开一个。
  const backend = raw.operator?.backend || (appShell() ? 'host' : OPERATOR_DEFAULTS.backend);
  return { drivers: { default: def.length ? def : ['codex'], per_host: perHost }, operator: { ...OPERATOR_DEFAULTS, ...(raw.operator || {}), backend }, cua: { binary: 'cua-driver', ...(raw.cua || {}) } };
}
// 最具体的站点规则优先（apply.careers.microsoft.com 胜过 microsoft.com）。
export function driversFor(host, settings = computerUseSettings()) {
  const h = String(host || '').toLowerCase();
  const key = Object.keys(settings.drivers.per_host).filter(d => h === d || h.endsWith('.' + d)).sort((a, b) => b.length - a.length)[0];
  return key ? settings.drivers.per_host[key] : settings.drivers.default;
}
// operator.model 可以是「供应商/模型」、provider + model 分开写，或者直接的 { kind, base_url, model }。
export function operatorModelRef(op = computerUseSettings().operator) {
  if (!op?.model) return { inherit: 'text', role: 'quill', vision: false };
  if (typeof op.model === 'object') return { vision: !!op.vision, ...op.model };
  const ref = op.provider && !String(op.model).includes('/') ? `${op.provider}/${op.model}` : String(op.model);
  return { ref, vision: !!op.vision };
}
export const operatorModelLabel = op => { const m = operatorModelRef(op); return m.inherit ? 'Quill 的文字模型（读取网页文字）' : m.ref || `${m.model || '?'} · ${m.base_url || ''}`; };
