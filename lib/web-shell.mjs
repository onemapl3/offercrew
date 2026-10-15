// 工作台页面外壳里只属于这台机器、这个人的两样东西：本地时区（web/*.js 按它显示时间，
// lib/tz.mjs）和侧栏的名字（candidate/facts.yaml identity）。web/index.html 里只放中性的
// 占位，bin/serve.mjs 发页面时填进去；没有 facts 时侧栏写「我的工作台」。
// 演示 / 沙盒模式（lib/sandbox.mjs）开着时常驻一枚小标：每一页、滚到哪里都看得到，截图和录屏里也在。
import { TZ } from './tz.mjs';
import { currentFacts } from './facts.mjs';
import { sandboxed, sandboxModels } from './sandbox.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const ownerName = (facts = currentFacts()) => String(facts?.identity?.name_en || facts?.identity?.name_zh || '').trim();

// 放在侧栏品牌下面：宽屏的侧栏是固定的，滚到哪儿都看得见；窄屏的侧栏在页面顶上，小标变成一行。
const SANDBOX_TITLE = 'RADAR_SANDBOX：不发邮件和私信、不投递、不打开浏览器、不调用模型和本机 AI；每一件没做的事在运行日志里记一行 sandbox: skipped';
const SANDBOX_BADGE = `<div class="sandbox-badge" role="status" title="${SANDBOX_TITLE}"><b><span class="dot warn"></span>演示 / 沙盒模式</b><small>不会发出任何东西</small></div>`;
// RADAR_SANDBOX_MODELS=1：文字模型真的会调（花跑的人自己的额度），别的照旧不发出去。
const MODELS_TITLE = 'RADAR_SANDBOX + RADAR_SANDBOX_MODELS：文字模型照常调用（花你自己的额度，用量账照常记）；不发邮件和私信、不投递、不打开浏览器、不启动本机 AI；每一件没做的事在运行日志里记一行 sandbox: skipped';
const MODELS_BADGE = `<div class="sandbox-badge" role="status" title="${MODELS_TITLE}"><b><span class="dot warn"></span>演示 / 沙盒模式 · 模型已开</b><small>只调模型，别的不发出去</small></div>`;
const SANDBOX_STYLE = '<style>.sandbox-badge{margin:24px 0 -18px;padding:9px 12px;border:1px solid #ecd6a8;border-radius:8px;background:#fdf6e6;color:#8a6424;font-size:12px;line-height:1.6}.sandbox-badge b{display:block;font-weight:650}.sandbox-badge small{display:block;font-size:11px;color:#9a7431;padding-left:13px}@media(max-width:700px){.sandbox-badge{margin:12px 0 0;padding:5px 10px;font-size:11px}.sandbox-badge b,.sandbox-badge small{display:inline;padding:0}.sandbox-badge small::before{content:"："}}</style>';
// 录屏时可以不显示小标（沙盒本身照旧）：环境变量 RADAR_SANDBOX_BADGE=off，或打开页面时带 ?rec=1（bin/serve.mjs 传进来）。
export const sandboxBadgeWanted = (env = process.env) => String(env.RADAR_SANDBOX_BADGE || '').toLowerCase() !== 'off';
export function renderShell(html, { tz = TZ, name = ownerName(), sandbox = sandboxed(), models = sandbox && sandboxModels(), badge = sandboxBadgeWanted() } = {}) {
  const label = name || '我的工作台', initial = name ? [...name][0].toUpperCase() : '·';
  const out = html
    .replace(/(<meta name="radar-tz" content=")[^"]*"/, `$1${esc(tz)}"`)
    .replace(/(<span class="avatar">)[^<]*(<\/span><div>)[^<]*(<small>)/, (m, a, b, c) => `${a}${esc(initial)}${b}${esc(label)}${c}`);
  return sandbox && badge ? out.replace('</head>', `${SANDBOX_STYLE}</head>`).replace('<div class="workspace-label">', `${models ? MODELS_BADGE : SANDBOX_BADGE}<div class="workspace-label">`) : out;
}
