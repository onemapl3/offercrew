// 团队成员：一位一行（脸 · 名字 · 分工 · 实际用的模型）；点进去是这位成员自己的设置：
// 对话和文字用哪个型号（跟随默认还是单独设置，web/model-settings.js 的同一个选择组件），Lens 的判断、Patch 的自动修复也在各自那一页。
import { esc, fileLine } from './ui.js';
import { faceHtml } from '../crew-faces.js';
import { modelWords } from '../labels.js';

const agent = (D, key) => (D.cc.settings?.agents || []).find(a => a.role === key) || {};
const MS = () => globalThis.OfferCrewModelSimple;
// 目录读到了就用实际生效的型号（web/model-settings.js），没读到用设置里的旧字段。
const catRole = key => MS()?.role?.(key) || null;
const uses = (D, key) => {
  const r = catRole(key);
  if (r) {
    const c = r.effective_chat, t = r.effective_text?.[0], w = m => (m ? `${m.provider_label} · ${modelWords(m.model)}` : '没有可用型号');
    const own = !r.inherits_chat || !r.inherits_text ? '单独设置' : r.steps?.length ? '跟随默认 · 部分步骤单独设置' : '跟随默认';
    return `${own} · ${c && t && c.ref !== t.ref ? `对话 ${w(c)}，文字 ${w(t)}` : w(c || t)}`;
  }
  const a = agent(D, key);
  if (a.fallback_chat || a.text_issue) return [a.fallback_chat ? '对话已改用全局默认' : a.chat ? modelWords(a.chat) : '对话跟随默认', a.text_issue ? '文字清单有不可用项' : ''].filter(Boolean).join(' · ');
  return a.chat || a.text ? [a.chat, a.text].filter(Boolean).map(modelWords).filter((x, i, l) => l.indexOf(x) === i).join(' · ') : '跟随默认';
};
const custom = (D, key) => { const r = catRole(key); return r ? !r.inherits_chat || !r.inherits_text || r.steps?.length : !!(agent(D, key).chat || agent(D, key).text); };
// Lens 的判断平时由它的文字模型完成；单独的判断接口（Jev）只在配了的时候用，收进折叠里。
const EXTRA = {
  lens: D => `<h3 class="st-h">判断</h3><div class="st-card st-pad">${D.kit.form('judge')}</div><details class="st-card st-pad"><summary>单独的判断接口（可选）</summary><p class="st-muted small">不设置时，判断用上面 Lens 的文字模型。</p>${D.kit.stack(['jev'])}</details>${fileLine('config/judge.json')}`,
  patch: D => `<h3 class="st-h">自动修复</h3><div class="st-card st-pad">${D.kit.form('host', ['system_auto_repair.enabled', 'system_auto_repair.per_hour', 'system_auto_repair.cooldown_hours'])}</div>${fileLine('config/host.json')}`,
};
const modelBox = key => MS()?.roleHtml?.(key) || `<div class="ms ms-solo" data-ms-role-box="${esc(key)}"><p class="muted">正在读取…</p></div>`;
export default {
  id: 'crew', title: '团队成员', icon: 'users',
  summary: D => { const n = D.team.filter(m => custom(D, m.key)).length; return `${D.team.length} 位 · ${n ? `${n} 位单独设置了模型` : '都用默认模型'}`; },
  glance: D => `<span class="st-faces">${D.team.map(m => faceHtml(m.face, { size: 26 })).join('')}</span><br>${D.team.filter(m => m.running).length ? `${D.team.filter(m => m.running).length} 位在做事` : `${D.team.length} 位都在岗`}`,
  cards: D => [{ rows: D.team.map(m => ({ id: m.key, label: `${faceHtml(m.face, { size: 26 })}<span>${esc(m.name)}</span>`, value: `${esc(m.group || '')} · ${esc(uses(D, m.key))}`, sub: m.key, words: `${m.title || ''} ${m.duty || ''}`, html: true })) }],
  subs: new Proxy({}, {
    get: (_, key) => (typeof key !== 'string' ? undefined : {
      title: D => D.team.find(m => m.key === key)?.name || key,
      render: D => { const m = D.team.find(x => x.key === key); if (!m) return '<p class="st-muted">没有这位成员。</p>'; return `<div class="st-who st-card">${faceHtml(m.face, { size: 44 })}<div><b>${esc(m.name)}</b><span>${esc(m.duty || m.group || '')}</span></div></div><h3 class="st-h">用的模型</h3>${modelBox(key)}${EXTRA[key]?.(D) || ''}${fileLine('config/roles.json')}`; },
    }),
  }),
  index: D => [
    { id: 'x-judge', label: '判断', value: '', words: 'Jev 阈值 并发 判断模型', sub: 'lens' },
    { id: 'x-repair', label: '自动修复', value: '', words: '修复 每小时', sub: 'patch' },
  ],
};
