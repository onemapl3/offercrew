// 求职偏好：找什么样的工作。一行一项，点进子页才是标签和开关（编辑器和保存逻辑在 web/prefs.js，不变）。
import { esc, ordered, fileLine, salaryText, pill } from './ui.js';
import { prefsSubHtml, bindPrefsSub, rerunGuide } from '../prefs.js';
import { openEditor } from '../setup.js';
import { valueLabel } from '../labels.js';
import { addedNames } from '../entries.js';

const STAGE = { student: '在校生', new_grad: '应届生', experienced: '职场人' };
const pipe = (D, k) => D.cc.settings?.files?.pipeline?.values?.[k];
const view = D => D.onb || {};
const facts = D => view(D).facts || {};
const dirOf = D => (view(D).directions || []).find(d => d.key === facts(D).direction) || null;
const nameOf = (D, k) => (view(D).directions || []).find(d => d.key === k)?.name || k;
const trackNames = D => (facts(D).tracks || []).map(k => dirOf(D)?.tracks?.find(t => t.key === k)?.name || k);
const modeNames = D => (facts(D).work_mode || []).map(k => (view(D).work_modes || []).find(m => m.key === k)?.name || k);
const list = (xs, none = '还没选') => (xs.length ? xs.map(esc).join('、') : `<span class="st-muted">${none}</span>`);
const arr = v => (v == null || v === '' ? [] : [v].flat());
// 岗位来源：每个来源推荐过几个、你留下几个、不要几个（lib/source-stats.mjs）。长期不准的推荐时排后，不关。
const tally = s => s.stats?.recommended ? `推荐 ${s.stats.recommended} · 你留下 ${s.stats.kept} · 不要 ${s.stats.dropped}` : '还没推荐过';
const sourcesValue = ch => { const n = ch.filter(s => s.stats?.recommended).length, low = ch.filter(s => s.stats?.low).length; return n ? `${n} 个来源推荐过${low ? ` · 排后 ${low} 个` : ''}` : '<span class="st-muted">还没推荐过</span>'; };
const sourcesHtml = ch => {
  const rows = [...ch].sort((a, b) => (b.stats?.recommended || 0) - (a.stats?.recommended || 0));
  const line = s => `<div class="st-row static${s.stats?.low ? ' warn' : ''}"><span class="st-l"><span>${esc(s.name)}${s.enabled ? '' : '<span class="st-muted"> · 关着</span>'}</span></span><span class="st-v">${esc(tally(s))}${s.stats?.low ? ` · ${pill('排后', 'warn')}` : ''}</span></div>`;
  return `<div class="st-card">${rows.map(line).join('')}</div>${rows.some(s => s.stats?.low) ? '<p class="st-note">排后：定下来的里面你留下的不到四分之一，这个来源的推荐放得晚一些。</p>' : ''}`;
};
const edit = key => ({ render: () => prefsSubHtml([key]), bind: () => bindPrefsSub() });

export default {
  id: 'prefs', title: '求职偏好', icon: 'target',
  summary: D => [dirOf(D)?.name || '还没选方向', trackNames(D).slice(0, 2).join('、'), (facts(D).cities || []).join('、')].filter(Boolean).join(' · ') || '还没选方向',
  glance: D => `${esc((facts(D).cities || []).join('、') || '城市还没选')}${facts(D).salary ? ` · ${esc(salaryText(facts(D).salary))}` : ''}<br>你的清单 ${esc(view(D).companies?.total ?? 0)} 家公司`,
  cards(D) {
    const f = facts(D), ch = view(D).channels?.sources || [], c = view(D).companies || {}, pk = c.pack || {};
    const on = ch.filter(s => s.enabled).map(s => s.name), off = ch.filter(s => !s.enabled).map(s => s.name);
    const picks = addedNames(view(D).channels?.entries); // 加成来源的搜好的入口
    const P = D.cc.preferences, manual = Object.keys(P?.manual || {}).length;
    const excl = (pipe(D, 'discovery.excluded_companies') || []).length, hard = arr(D.kit.factValue('preferences.hard_exclusions'));
    const also = (f.also || []).map(k => nameOf(D, k));
    return [
      { title: '方向', rows: [
        { id: 'stage', label: '身份', value: esc(STAGE[f.stage] || '还没选'), sub: 'stage' },
        { id: 'direction', label: '方向', value: esc(dirOf(D)?.name || '还没选'), sub: 'direction', warn: !f.direction },
        ...(dirOf(D)?.tracks?.length ? [{ id: 'tracks', label: '子方向', value: trackNames(D).length ? ordered(trackNames(D)) : '<span class="st-muted">都看</span>', sub: 'tracks' }] : []),
        { id: 'also', label: '也看', value: list(also, '没有'), action: () => openEditor('direction', D.h), words: '方向' },
      ] },
      { title: '地点与方式', rows: [
        { id: 'cities', label: '城市', value: f.cities?.length ? ordered(f.cities) : list([]), sub: 'cities', warn: !f.cities?.length },
        { id: 'mode', label: '工作方式', value: modeNames(D).length ? ordered(modeNames(D)) : list([]), sub: 'mode', words: '远程 坐班 混合' },
        { id: 'focus', label: '只看这些城市和远程', value: '', toggle: { on: pipe(D, 'discovery.focus_only') === true, set: on => D.h.post('/api/settings', { name: 'pipeline', patch: { 'discovery.focus_only': on } }) } },
      ] },
      { title: '薪资', rows: [{ id: 'salary', label: '期望薪资', value: esc(f.salary ? salaryText(f.salary) : '还没填'), sub: 'salary', words: '钱 年薪 工资' }] },
      { title: '去哪儿找', rows: [
        { id: 'channels', label: '渠道', value: `${on.length ? `${esc(on.join('、'))} 开着` : '只看官网'}${picks.length ? ` · 入口 ${esc(picks.join('、'))}` : ''}${off.length ? `<span class="st-muted"> · 关着 ${off.length} 个</span>` : ''}`, sub: 'channels', words: '来源 脉脉 LinkedIn BOSS 真人帖 入口 猎聘 智联 前程无忧' },
        { id: 'sources', label: '岗位来源', value: sourcesValue(ch), sub: 'sources', words: '来源 推荐 准不准 留下 排后 统计' },
        { id: 'companies', label: '公司', value: `你的清单 ${esc(c.total ?? 0)} 家${pk.exists && pk.missing ? ` · 包里还有 ${esc(pk.missing)} 家没加` : ''}`, sub: 'companies', words: '公司包' },
        { id: 'exclude', label: '排除', value: [excl ? `${excl} 家公司` : '', hard.map(valueLabel).map(esc).join('、')].filter(Boolean).join(' · ') || '<span class="st-muted">没有</span>', sub: 'exclude', words: '黑名单 不要' },
      ] },
      { title: '推荐', rows: [{ id: 'recommend', label: '推荐线 · 数量 · 公司', value: `匹配度 ${esc(pipe(D, 'recommend.min_score') ?? 60)} · ${pipe(D, 'recommend.daily_limit') == null ? '数量不限' : `每天最多 ${esc(pipe(D, 'recommend.daily_limit'))} 个`} · 摘要同公司 ${pipe(D, 'recommend.per_company') === null ? '不限' : `${esc(pipe(D, 'recommend.per_company') ?? 3)} 个`}`, sub: 'recommend', words: '分数线 匹配度 限量 每天 推荐数量 不限 公司 推送' }] },
      { title: '学到的偏好', rows: [{ id: 'learned', label: '加权 / 降权', value: P ? `加权 ${P.positive?.length || 0} · 降权 ${P.negative?.length || 0}${manual ? ` · 手改 ${manual}` : ''}` : '<span class="st-muted">还没有</span>', sub: 'learned', words: '偏好学习 权重' }] },
      { rows: [{ id: 'rerun', label: '重新走一遍引导', value: '', action: () => rerunGuide() }] },
    ];
  },
  subs: {
    stage: { title: '身份', ...edit('stage') },
    direction: { title: '方向', render: D => prefsSubHtml(['direction']) + (D.kit.factValue('preferences.role_families') ? D.kit.facts(['preferences.role_families']) : ''), bind: () => bindPrefsSub() },
    tracks: { title: '子方向', ...edit('tracks') },
    cities: { title: '城市', ...edit('cities') },
    mode: { title: '工作方式', ...edit('mode') },
    salary: { title: '期望薪资', ...edit('salary') },
    channels: { title: '渠道', ...edit('channels') },
    companies: { title: '公司', render: D => prefsSubHtml(['companies']) + D.kit.facts(['preferences.company_priority']), bind: () => bindPrefsSub() },
    exclude: { title: '排除', render: D => D.kit.form('pipeline', ['discovery.excluded_companies']) + D.kit.facts(['preferences.hard_exclusions', 'preferences.soft_exclusions']) + fileLine('config/pipeline.json · candidate/facts.yaml') },
    sources: { title: '岗位来源', render: D => sourcesHtml(view(D).channels?.sources || []) },
    recommend: { title: '推荐', render: D => `<div class="st-card st-pad">${D.kit.form('pipeline', ['recommend.min_score', 'recommend.daily_limit', 'recommend.per_company'])}</div><p class="st-note">默认显示全部已判断合格的推荐。每天上限只控制展示数量，不节省模型花费；模型预算在<a href="#settings/spend">花费</a>里设置。同公司上限只控制重点摘要与每批手机推送，全部岗位里仍可查看、搜索所有合适岗位。</p>${fileLine('config/pipeline.json')}` },
    learned: { title: '学到的偏好', render: D => D.kit.learned() },
  },
  index: D => [
    { id: 'x-hard', label: '硬排除', value: esc(arr(D.kit.factValue('preferences.hard_exclusions')).map(valueLabel).join('、')), sub: 'exclude' },
    { id: 'x-soft', label: '软排除', value: esc(arr(D.kit.factValue('preferences.soft_exclusions')).map(valueLabel).join('、')), sub: 'exclude' },
    { id: 'x-priority', label: '公司偏好顺序', value: '', sub: 'companies' },
  ],
};
