// 「设置」里新加的几块（2026-09-30）：求职方向与偏好、检查清单、花费、手机、（桌面）、高级邮箱接入。
// 左侧导航不再有「开始使用」「高级邮箱接入」：引导做完以后，这些都在设置里改。
//
// 求职方向与偏好：你在引导里选过的，按结构化字段摆出来，点一下就存（POST /api/onboarding/answers、/channels、/companies，
// lib/onboarding.mjs → lib/profile.mjs saveProfile），不调模型、不重新推理。每次保存带上读取时的版本（sig），
// 一次只发一个保存，排着队发；存完这一块自己重画（输入框有焦点时工作台不重绘页面，不能指望 h.refresh()）。
// 2026-09-30 设置页按分类拆开（web/settings/）：这里只剩「求职偏好」里那几项的编辑器，
// 分类页上一行一项，点进子页才出现这里的标签和开关（prefsSubHtml([key])）。
import { restartGuide } from './onboarding.js';
import { entriesHtml, entriesClick } from './entries.js';

// ── 界面文字（界面只做中文，以后做英文就换这一处） ──────────────────────────────────
const T = {
  title: '求职方向与偏好',
  lead: '',
  rows: { stage: '身份', direction: '方向', tracks: '子方向', cities: '城市', salary: '期望薪资', mode: '工作方式', channels: '渠道', companies: '公司包' },
  stages: { student: '在校生', new_grad: '应届生', experienced: '职场人' },
  noDirection: '还没选，推荐暂不放',
  tracksHint: '', noTracks: '这个方向没有子方向。',
  also: list => `也看：${list}（在检查清单「你的方向」里改）`,
  addCity: '加上', otherCity: '其他城市', salaryPh: '例如：25 万以上，可谈', saveSalary: '保存',
  modeHint: '',
  noPack: '这个方向还没有公司包。', packLine: (count, missing, added) => `公司包里 ${count} 家，你的清单里还没有 ${missing} 家${added ? `；已经加进来 ${added} 家` : ''}。`,
  packAdd: n => `一键加入（${n} 家）`, packRemove: n => `去掉这个包加的 ${n} 家`, mine: (total, mine) => `你的清单现在 ${total} 家（你自己加的 ${mine} 家）。`,
  rerun: '重新走一遍引导', saving: '正在保存…', saved: '已保存', unchanged: '没有改动',
  noFacts: '还没有个人资料：先走一遍引导，或者在「材料」里导入简历。',
  phone: '手机', mail: '高级邮箱接入',
  mailLead: '',
  mailGo: '打开高级邮箱接入 →',
};

// ── 求职方向与偏好 ────────────────────────────────────────────────────────────
let h = null;
const P = { view: null, err: '', busy: false, chain: Promise.resolve(), only: null };
const esc = x => h.esc(x);
async function loadPrefs() {
  const r = await fetch('/api/onboarding'), v = await r.json();
  if (!r.ok) throw Error(v.error || '读取失败');
  P.view = v;
}
const chip = (attr, on, label, extra = '') => `<button type="button" class="ob-chip${on ? ' on' : ''}" ${attr} aria-pressed="${on}">${esc(label)}${extra}</button>`;
const row = (key, label, body, hint = '') => P.only && !P.only.includes(key) ? '' : `<div class="pf-row${P.only ? ' bare' : ''}" data-pf-row="${key}">${P.only ? '' : `<div class="pf-label">${esc(label)}</div>`}<div class="pf-body">${body}${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}</div></div>`;
function prefsBody() {
  const v = P.view, f = v.facts || {}, R = T.rows;
  // BOSS 的扫描关着时，旧来源视图只留入口链接；渠道页仍要列出扫描与外发两个独立开关。
  const platforms = v.channels?.actions || [], scanSources = [...platforms.map(p => ({ key: p.key, name: p.name, enabled: p.scan_enabled })), ...(v.channels?.sources || []).filter(s => !platforms.some(p => p.key === s.key))];
  const dir = (v.directions || []).find(d => d.key === f.direction) || null;
  const nameOf = k => (v.directions || []).find(d => d.key === k)?.name || k;
  const also = (f.also || []).map(nameOf).join('、');
  const picked = f.cities || [], cities = [...new Set([...(v.cities || []), ...picked])], modes = f.work_mode || [];
  const c = v.companies || {}, pk = c.pack;
  const rows = [
    row('stage', R.stage, `<div class="ob-chips">${(v.stages || []).map(s => chip(`data-pf-stage="${esc(s.key)}"`, f.stage === s.key, T.stages[s.key] || s.name)).join('')}</div>`),
    row('direction', R.direction, `<select class="pf-select" data-pf-direction aria-label="${esc(R.direction)}">${f.direction ? '' : `<option value="" selected>${esc(T.noDirection)}</option>`}${(v.directions || []).map(d => `<option value="${esc(d.key)}" ${d.key === f.direction ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`, also ? T.also(also) : ''),
    row('tracks', R.tracks, dir?.tracks?.length ? `<div class="ob-chips">${dir.tracks.map(t => chip(`data-pf-track="${esc(t.key)}"`, (f.tracks || []).includes(t.key), t.name)).join('')}</div>` : `<p class="muted small">${esc(T.noTracks)}</p>`, dir?.tracks?.length ? T.tracksHint : ''),
    row('cities', R.cities, `<div class="ob-chips">${cities.map(x => chip(`data-pf-city="${esc(x)}"`, picked.includes(x), x, picked.includes(x) ? `<em>${picked.indexOf(x) + 1}</em>` : '')).join('')}</div><form class="pf-inline" data-pf-add><input name="city" maxlength="40" placeholder="${esc(T.otherCity)}" aria-label="${esc(T.otherCity)}"><button type="submit" class="secondary">${esc(T.addCity)}</button></form>`),
    row('salary', R.salary, `<form class="pf-inline" data-pf-salary><input name="salary" maxlength="120" value="${esc(f.salary || '')}" placeholder="${esc(T.salaryPh)}" aria-label="${esc(R.salary)}"><button type="submit" class="secondary">${esc(T.saveSalary)}</button></form>`),
    row('mode', R.mode, `<div class="ob-chips">${(v.work_modes || []).map(m => chip(`data-pf-mode="${esc(m.key)}"`, modes.includes(m.key), m.name, modes.includes(m.key) ? `<em>${modes.indexOf(m.key) + 1}</em>` : '')).join('')}</div>`, T.modeHint),
    row('channels', R.channels, `<div class="ob-switches">${scanSources.map(s => `<label class="ob-switch"><input type="checkbox" data-pf-channel="${esc(s.key)}" ${s.enabled ? 'checked' : ''}><span class="ob-switch-body"><b>${esc(['boss', 'maimai'].includes(s.key) ? `扫描 ${s.name} 找岗位` : s.name)}</b>${s.note ? `<small>${esc(s.note)}</small>` : ''}</span></label>`).join('')}</div>${entriesHtml(v.channels?.entries, esc)}<div class="ob-switches">${(v.channels?.actions || []).map(s => `<label class="ob-switch"><input type="checkbox" data-pf-actions="${esc(s.key)}" ${s.enabled ? 'checked' : ''}><span class="ob-switch-body"><b>${s.key === 'maimai' ? '在脉脉上发送好友申请' : `在${esc(s.name)}上发私信 / 预填 / 提交`}</b><small>${s.key === 'maimai' ? '每次发送好友申请仍须批准；私信自动发送与消息同步暂不可用。' : '默认关闭；打开后每次发送仍须批准，预填停在提交前，提交由你确认。'}</small></span></label>`).join('')}</div>`),
    row('companies', R.companies, `<p class="muted small">${esc(T.mine(c.total || 0, c.mine || 0))}</p>${pk?.exists ? `<p class="small">${esc(T.packLine(pk.count, pk.missing, pk.added))}</p><div class="pf-actions">${pk.missing ? `<button type="button" class="secondary" data-pf-pack="add">${esc(T.packAdd(pk.missing))}</button>` : ''}${pk.added ? `<button type="button" class="secondary" data-pf-pack="remove">${esc(T.packRemove(pk.added))}</button>` : ''}</div>` : `<p class="muted small">${esc(T.noPack)}</p>`}`),
  ];
  const status = P.busy ? `<span class="pf-status">${esc(T.saving)}</span>` : '';
  return `${T.lead ? `<p class="muted pf-lead">${esc(T.lead)}</p>` : ''}${f.exists ? '' : `<p class="pf-note">${esc(T.noFacts)}</p>`}<div class="pf-rows">${rows.join('')}</div><p class="pf-err" role="alert">${esc(P.err)}</p>${status}`;
}
function prefsSection() {
  const body = P.view ? prefsBody() : `<p class="pf-err">${esc(P.err || '读取失败')}</p>`;
  return `<section class="panel pf" id="settings-prefs"><div class="panel-heading"><h2>${esc(T.title)}</h2><button type="button" class="secondary mini pf-rerun" data-pf-rerun>${esc(T.rerun)}</button></div><div class="pf-wrap">${body}</div></section>`;
}
function repaintPrefs() {
  const box = document.querySelector('#settings-prefs .pf-wrap');
  if (box) box.innerHTML = P.view ? prefsBody() : `<p class="pf-err">${esc(P.err)}</p>`;
}
// 排着队存：每一次都用上一次存完读回来的版本（sig），不会拿旧版本去撞 409。
function save(path, body, { answers = false } = {}) {
  P.busy = true; P.err = ''; repaintPrefs();
  P.chain = P.chain.then(async () => {
    try {
      const r = await h.post(path, answers ? { base: P.view?.facts?.sig ?? null, values: body } : body);
      h.toast(r?.status === 'unchanged' ? T.unchanged : T.saved);
    } catch (e) { P.err = e.message; }
    try { await loadPrefs(); } catch (e) { P.err = P.err || e.message; }
    P.busy = false; repaintPrefs();
  });
  return P.chain;
}
const toggle = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
function bindPrefs() {
  const sec = document.querySelector('#settings-prefs');
  if (!sec) return;
  sec.onclick = (e => {
    const t = e.target.closest('button');
    if (!t || !sec.contains(t) || t.type === 'submit') return;
    const d = t.dataset, f = P.view?.facts || {};
    if ('pfRerun' in d) { restartGuide(); location.hash = '#onboarding'; return; }
    if (!P.view) return;
    if (entriesClick(t, { toast: h.toast, save: body => save('/api/onboarding/entries', body) })) return;
    if (d.pfStage) return save('/api/onboarding/answers', { stage: d.pfStage }, { answers: true });
    if (d.pfTrack) return save('/api/onboarding/answers', { direction: f.direction || 'software', tracks: toggle(f.tracks || [], d.pfTrack) }, { answers: true });
    if (d.pfCity) return save('/api/onboarding/answers', { cities: toggle(f.cities || [], d.pfCity) }, { answers: true });
    if (d.pfMode) return save('/api/onboarding/answers', { work_mode: toggle(f.work_mode || [], d.pfMode) }, { answers: true });
    if (d.pfPack) return save('/api/onboarding/companies', { preset: P.view.chosen, action: d.pfPack });
  });
  sec.onchange = (e => {
    const t = e.target, f = P.view?.facts || {};
    if ('pfDirection' in t.dataset && t.value) {
      // 换了方向：子方向只留新方向里有的（一般就清空了）
      const known = (P.view.directions || []).find(d => d.key === t.value)?.tracks.map(x => x.key) || [];
      return save('/api/onboarding/answers', { direction: t.value, tracks: (f.tracks || []).filter(k => known.includes(k)) }, { answers: true });
    }
    if (t.dataset.pfActions) return save('/api/settings', { name: 'platform_actions', patch: { [t.dataset.pfActions + '.actions_enabled']: t.checked } });
    if (t.dataset.pfChannel) return save('/api/onboarding/channels', { enabled: { [t.dataset.pfChannel]: t.checked } });
  });
  sec.onsubmit = (e => {
    e.preventDefault();
    const form = e.target, f = P.view?.facts || {};
    if ('pfAdd' in form.dataset) { const v = form.city.value.replace(/\s+/g, ' ').trim(); if (v && !(f.cities || []).includes(v)) save('/api/onboarding/answers', { cities: [...(f.cities || []), v] }, { answers: true }); form.city.value = ''; }
    if ('pfSalary' in form.dataset) { const v = form.salary.value.trim(); save('/api/onboarding/answers', { salary: v }, { answers: true }); form.salary.blur(); }
  });
}

// ── 给 web/settings/prefs.js ───────────────────────────────────────────────────
export async function loadPrefsView(helpers) {
  h = helpers;
  try { await loadPrefs(); P.err = ''; } catch (e) { P.view = null; P.err = e.message; }
  return P.view;
}
export const prefsView = () => P.view;
// 子页：只画这几项（不带左边的名字，子页标题就是它）。
export function prefsSubHtml(keys) {
  P.only = keys;
  const body = P.view ? prefsBody() : `<p class="pf-err">${esc(P.err || '读取失败')}</p>`;
  return `<section class="pf pf-sub" id="settings-prefs"><div class="pf-wrap">${body}</div></section>`;
}
export function bindPrefsSub() { bindPrefs(); }
export function rerunGuide() { restartGuide(); location.hash = '#onboarding'; }
