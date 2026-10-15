// 个人资料：填表、回答招聘方问题时用的关于你的事实（candidate/facts.yaml）。
// 目标城市、工作方式、期望薪资在「求职偏好」；每天反馈时间在「通知与手机」。简历文件在「材料」页。
import { esc, pill, fileLine, salaryText } from './ui.js';
import { openEditor } from '../setup.js';

const GROUPS = {
  contact: ['联系方式', ['identity.email', 'identity.phone_cn', 'identity.linkedin', 'identity.github']],
  where: ['所在地', ['location.current_city', 'location.relocation_ok', 'location.onsite_5days_acceptable', 'location.travel_ok']],
  avail: ['到岗', ['availability.current_status', 'availability.notice_period_days', 'availability.earliest_start', 'availability.notice_can_shorten']],
  pay: ['薪酬', ['compensation.floor_annual_cny', 'compensation.current_annual_cny', 'compensation.expected_annual_usd_remote', 'compensation.equity_preference']],
  answers: ['常用回答', ['standard_answers.why_leaving', 'standard_answers.management_experience', 'standard_answers.biggest_strength']],
};
const L = () => globalThis.OfferCrewLabels?.valueLabel || (x => String(x ?? ''));
const filled = v => !(v == null || v === '' || (Array.isArray(v) && !v.length));
const show = v => (Array.isArray(v) ? v.map(x => L()(x)).join('、') : L()(v));
// 摘要里的数字带上它是什么（10-01：「在职 · 30」「280,000 · 不透露」看不出 30 是通知期、28 万是底线）。
const NAMED = {
  'availability.notice_period_days': v => /^\d+$/.test(String(v)) ? `通知期 ${v} 天` : `通知期 ${show(v)}`,
  'compensation.floor_annual_cny': v => `底线 ${salaryText(show(v))}`,
  'compensation.current_annual_cny': v => `现在 ${salaryText(show(v))}`,
  'compensation.expected_annual_usd_remote': v => `远程 ${salaryText(show(v))}`,
  'standard_answers.management_experience': v => v === false || /^(否|no|false)$/i.test(String(v)) ? '没带过团队' : v === true || /^(是|yes|true)$/i.test(String(v)) ? '带过团队' : show(v),
};
const shown = (p, v) => (NAMED[p] ? NAMED[p](v) : show(v));
function groupValue(D, key) {
  const [, paths] = GROUPS[key], vals = paths.map(p => D.kit.factValue(p)), miss = vals.filter(v => !filled(v)).length;
  const first = paths.map((p, i) => [p, vals[i]]).filter(([, v]) => filled(v)).slice(0, 2).map(([p, v]) => esc(String(shown(p, v))));
  return `${first.join(' · ') || '<span class="st-muted">未填</span>'}${miss && miss < paths.length ? ' ' + pill(`还缺 ${miss} 项`, 'warn') : ''}`;
}

export default {
  id: 'profile', title: '个人资料', icon: 'user',
  summary: D => { const id = D.cc.profile?.identity || {}, todo = D.cc.profile?.todos?.length || 0; return [id.name_zh || id.name_en || '还没有资料', todo ? `还缺 ${todo} 项` : ''].filter(Boolean).join(' · '); },
  cards(D) {
    const P = D.cc.profile || {}, id = P.identity || {}, cw = P.current_work;
    return [
      { rows: [
        { id: 'name', label: '姓名', value: esc([id.name_zh, id.name_en].filter(Boolean).join(' / ') || '未填'), action: () => openEditor('profile', D.h) },
        ...Object.entries(GROUPS).slice(0, 1).map(([k, [label]]) => ({ id: k, label, value: groupValue(D, k), sub: k, words: '邮箱 手机 电话 GitHub LinkedIn' })),
        { id: 'work', label: '现职', value: cw ? esc(`${cw.company} · ${cw.title}`) : '<span class="st-muted">未填</span>', action: () => openEditor('profile', D.h), words: '公司 职位 工作' },
        ...Object.entries(GROUPS).slice(1).map(([k, [label]]) => ({ id: k, label, value: groupValue(D, k), sub: k, words: { where: '城市 搬迁 出差', avail: '通知期 入职 离职', pay: '年薪 工资 期权 底线', answers: '离职原因 优势 管理' }[k] })),
      ] },
      { rows: [{ id: 'resume', label: '材料', value: P.materials?.docs ? `简历 ${P.materials.docs} 份，${P.materials.versions} 个版本` : '<span class="st-muted">还没有简历</span>', go: '#materials', words: '简历 版本 PDF 经历 项目' }] },
    ];
  },
  subs: Object.fromEntries(Object.entries(GROUPS).map(([k, [title, paths]]) => [k, { title, render: D => `<div class="st-card st-pad">${D.kit.facts(paths)}</div>${fileLine('candidate/facts.yaml')}` }])),
  index: D => Object.entries(GROUPS).flatMap(([k, [, paths]]) => paths.map(p => ({ id: 'f-' + p, label: D.kit.factLabel(p), value: esc(String(shown(p, D.kit.factValue(p))) || ''), sub: k }))),
};
