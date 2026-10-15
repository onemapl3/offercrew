// 概览：你是谁、「还差 N 项」（原来的检查清单缩成一张卡）、几张摘要卡。窄屏换成「还差 N 项」+ 分类列表。
import { icon, esc, dot, cardsHtml } from './ui.js';
import { faceHtml } from '../crew-faces.js';

// 清单的每一项在新设置里住哪（点了跳过去，那一行闪一下）。
export const STEP_GO = {
  direction: '#settings/prefs?hl=direction', resume: '#materials', profile: '#settings/profile', targets: '#settings/prefs?hl=cities',
  sources: '#settings/prefs?hl=channels', accounts: '#settings/accounts', notify: '#settings/notify', models: '#settings/model',
  spend: '#settings/spend', computer: '#settings/advanced?hl=browser', schedule: '#settings/advanced?hl=schedule', policy: '#settings/send',
};
const TONE = { ok: 'ok', warn: 'warn', missing: 'miss' };
// 摘要一句太长就截在第一个分隔处。
const short = s => String(s || '').split(/[（(：]/)[0].split(' · ')[0].slice(0, 28);
// 没好的那一项说缺什么：清单给了 todo 就用它（lib/setup.mjs），没给再截摘要的第一段。
// 摘要按「 · 」分段，换行先换在段与段之间（10-02：「查信要等邮箱接好」被拆在两行）。一段比一行还长时照常在段里折。
const segs = t => `<span class="st-segs">${String(t ?? '').split(' · ').map((x, i, a) => `<span>${esc(x)}${i < a.length - 1 ? ' ·' : ''}</span>`).join(' ')}</span>`;
const stepRow = s => ({ id: 'ck-' + s.key, label: s.title, value: `${dot(TONE[s.status] || 'miss')}${esc(s.status === 'ok' ? '好了' : s.todo || short(s.summary))}`, go: s.go || STEP_GO[s.key] || '#settings' });

export function progressCard(D, remember) {
  const steps = D.setup?.steps || [];
  if (!steps.length) return '';
  const todo = steps.filter(s => s.status !== 'ok'), done = steps.length - todo.length;
  const rows = todo.length
    ? [...todo.map(stepRow), ...(done ? [{ id: 'ck-rest', label: `其余 ${done} 项`, value: `${dot('ok')}都好了`, go: '#settings/overview/checklist' }] : [])]
    : [{ id: 'ck-all', label: `${steps.length} 项都好了`, value: dot('ok'), go: '#settings/overview/checklist' }];
  remember('overview', rows);
  // 「还差 N 项」和进度条不写了（负责人 10-02：不占注意力）；没好的那几行本身就说了缺什么。
  return cardsHtml([{ html: '', rows }], 'overview');
}
function who(D) {
  const id = D.cc.profile?.identity || {}, name = [id.name_zh, id.name_en].filter(Boolean).join(' / ') || '你';
  return `<div class="st-card st-who">${faceHtml({ icon: 'user' }, { size: 52 })}<div><b>${esc(name)}</b><span>${esc(D.catsById?.prefs?.summary(D) || '')}</span></div></div>`;
}
const GLANCE = ['model', 'spend', 'crew', 'notify', 'send', 'prefs'];
export default {
  id: 'overview', title: '概览', icon: 'home',
  summary: () => '',
  cards: () => [],
  page(D, { remember, visible }) {
    D.catsById = Object.fromEntries(visible.map(c => [c.id, c]));
    const prog = progressCard(D, remember);
    const cards = GLANCE.map(k => D.catsById[k]).filter(Boolean).map(c => `<a class="st-sum" href="#settings/${c.id}"><span class="t">${icon(c.icon)}${esc(c.title)}</span><span class="x">${c.glance ? c.glance(D) : esc(c.summary(D))}</span></a>`).join('');
    const list = visible.filter(c => c.id !== 'overview').map(c => `<a class="st-cat" href="#settings/${c.id}"><span class="ic">${icon(c.icon)}</span><span class="tx"><b>${esc(c.title)}</b><span>${esc(c.summary(D))}</span></span>${icon('chev', 'st-end')}</a>`).join('');
    return `<div class="st-wide">${who(D)}${prog}<div class="st-grid">${cards}</div></div><div class="st-narrow">${prog}<div class="st-card st-list">${list}</div></div>`;
  },
  subs: {
    checklist: {
      title: D => `${D.setup?.done ?? 0} / ${D.setup?.total ?? 0} 项好了`,
      cards: D => [{ rows: (D.setup?.steps || []).map(s => ({ ...stepRow(s), value: `${dot(TONE[s.status] || 'miss')}${segs(s.summary)}` })) }],
    },
  },
};
