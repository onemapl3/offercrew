// 模型设置沿用现有配置/API：浏览接入来源 → 供应商 → 模型，明确保存才改变默认。
// 成员从已接入的目录直接选择模型；来源、Key 和 Runtime 管理不进入成员选择器。
// 诊断/备用顺序按需展开，未就绪和测试失败仍就地显示；列出不等于测试通过。
import { codexSlotWanted, codexSlotHtml } from './desktop.js';
import { modelWords } from './labels.js';

const T = {
  using: '已选择', test: '测试', change: '更换', close: '收起',
  freePrivacy: '选 OfferCrew 补给时，你的简历和岗位描述会经过 OfferCrew 的中转服务器，再交给模型服务商处理；中转只记用了多少补给，不保存内容。接了邮箱以后，判断邮件用到的发件人、标题和对方新写的那一段，也会这样经过中转。登录用的邮箱存在 OfferCrew 的中转上，只用来登录和记补给用量。想自己掌控，就用自己的 API key 或 ChatGPT 账号。',
  freeCost: '补给额度按所用模型的价格折算扣除，不等于实际处理的 token 数；自己的 API key 另行计费，不扣这里的补给。',
  freeUse: '把 OfferCrew 补给设为默认', freeStarting: '正在开通…', freeDone: x => `OfferCrew 补给开好了${x ? `：${x}` : ''}。`,
  freeInstall: id => `安装编号 ${id}`, login: '登录', logout: '退出登录', loginSub: '官方额度，要登录',
  betaFull: '内测名额已满', freeLabel: '剩', paidLabel: '兑换的', pt: 'token', code: '兑换码', redeem: '兑换', redeeming: '正在兑换…', buy: '买补给',
  chatgptNote: '在 OfferCrew 的 Mac 版里用 ChatGPT 账号登录，就用你 ChatGPT 套餐的额度，不另外花钱。',
  keysLead: 'Key 保存在这台电脑上，模型费用由服务商收取。',
  price: '价格：', signup: '注册', keyPage: '创建 key', paste: '粘贴 API key', save: '保存 Key',
  cliNote: '本机 CLI 没有统一的型号目录：这里列的是已配置的型号，别的型号手填后测试。',
};
const KIND = { claude_code: 'Claude Code · 本机', codex_exec: 'Codex · 本机', anthropic_http: 'Anthropic 兼容 API', openai_http: 'OpenAI 兼容 API' };
const LOCAL = new Set(['claude_code', 'codex_exec']);
const tokText = n => { const x = Math.max(0, Math.floor(Number(n) || 0)), cut = (v, d) => String(Math.floor(v * 10 ** d + 1e-9) / 10 ** d); return x >= 1e8 ? `${cut(x / 1e8, 2)} 亿` : x >= 1e4 ? `${cut(x / 1e4, x >= 1e6 ? 0 : 1)} 万` : String(x); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = at => { const d = new Date(at); return Number.isNaN(+d) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const sec = ms => (ms ? `${(ms / 1000).toFixed(1)} 秒` : '');
const S = { source: null, providers: {}, models: {}, roleChoices: {}, searches: {}, details: {}, src: null, free: null, codex: false, presets: [], cat: null, catErr: '', loading: null, pick: null, channel: 'both', add: null, keyOpen: null, msg: {}, busy: false, tests: {}, messages: {}, configVersion: 0, browseVersion: 0, html: '' };
let h = null, tokenOf = () => '';

async function getJson(url) { try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; } }
// 目录要拿到失败原因（「读不到」得说为什么）。
async function getCatalog() {
  try { const r = await fetch('/api/model/catalog'), d = await r.json().catch(() => ({})); if (!r.ok) throw Error(d.error || `HTTP ${r.status}`); return { cat: d, err: '' }; }
  catch (e) { return { cat: null, err: e.message || '连不上本地服务' }; }
}
// 回 { ok, body }：HTTP 200 里的 ok:false 由调用处判断。
async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Radar-Token': tokenOf() }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.ok !== false, body: d };
  } catch (e) { return { ok: false, body: { error: e.message || '连不上本地服务' } }; }
}
const why = (r, fallback) => r.body?.reason || r.body?.error || fallback;
function load() {
  S.loading ||= (async () => {
    const version = S.configVersion;
    const [src, free, codex, presets, c] = await Promise.all([getJson('/api/model/source'), getJson('/api/model/free'), codexSlotWanted(), getJson('/api/settings/providers/presets'), getCatalog()]);
    if (version !== S.configVersion) return; // 保存开始前读的旧配置不能覆盖新选择。
    Object.assign(S, { src, free, codex, presets: presets?.presets || [], catErr: c.err });
    if (c.cat) S.cat = c.cat;
  })().finally(() => { S.loading = null; });
  return S.loading;
}
const note = key => { const m = S.msg[key]; return m ? `<p class="ms-msg ${m.ok ? 'ob-ok' : 'ob-err'}" role="status">${esc(m.text)}</p>` : ''; };
const dis = () => (S.busy ? 'disabled' : '');
const btn = (attrs, label, cls = 'secondary mini', disabled = S.busy) => `<button type="button" class="${cls}" ${attrs} ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
const browseBtn = (attrs, label) => btn(attrs, label, 'secondary mini', false);
const testing = ref => !!S.tests[ref]?.pending;
const verification = m => {
  const local = S.tests[m?.ref]?.verification, saved = m?.verification;
  return local && (!saved || Date.parse(local.at) >= Date.parse(saved.at || 0)) ? local : saved;
};
const testButton = (ref, key) => btn(`data-ms-test="${esc(ref)}" data-ms-key="${esc(key)}"`, testing(ref) ? '正在测试…' : T.test, 'secondary mini', S.busy || testing(ref));

// ── 一个型号：供应商 · 型号名（认得的给人话，原名也写上），状态标签 ──────────────────────
function modelName(m, { id = false } = {}) {
  if (!m) return '<span class="muted">没有</span>';
  const w = modelWords(m.model);
  return `<span class="ms-mn"><b>${esc(m.provider_label || m.provider)}</b><span>·</span><b>${esc(w)}</b>${id && w !== m.model ? `<code>${esc(m.model)}</code>` : ''}</span>`;
}
function tags(m, { untested = true } = {}) {
  if (!m) return '';
  const v = verification(m), out = [];
  if (m.missing) out.push('<span class="ms-tag bad">供应商不在目录里</span>');
  else if (!m.ready) out.push('<span class="ms-tag warn">当前未就绪</span>');
  if (m.provider_ready === false) out.push('<span class="ms-tag warn">服务商暂未就绪</span>');
  out.push(v?.ok ? `<span class="ms-tag ok" title="${esc(when(v.at))}">测试通过${v.at ? ` · ${esc(when(v.at))}` : ''}</span>` : v ? `<span class="ms-tag bad" title="${esc(v.error || '')}">测试失败${v.at ? ` · ${esc(when(v.at))}` : ''}</span>` : untested ? '<span class="ms-tag">未测试</span>' : '');
  return `<span class="ms-tags">${out.join('')}</span>`;
}
// 测试结果里实际回答的型号和所选不同、或失败原因：写在型号下面。
function verifyLine(m) {
  const v = verification(m);
  if (!v) return '';
  if (!v.ok) return v.error ? `<small class="ms-bad">${esc(v.error)}</small>` : '';
  if (!v.actual_model) return '<small class="muted">服务商未报告实际型号</small>';
  return v.actual_model !== m.model ? `<small class="ms-warn">测试时实际回答的型号：${esc(v.actual_model)}</small>` : '';
}
const same = (a, b) => !!a && !!b && a.ref === b.ref;
const roleOf = key => S.cat?.roles?.find(r => r.key === key);
const custom = () => (S.cat?.roles || []).filter(r => !r.inherits_chat || !r.inherits_text || r.steps?.length);

// ── 默认模型卡 ──────────────────────────────────────────────────────────────
function lastLine() {
  const lr = S.cat?.last_response;
  if (!lr) return '';
  const r = roleOf(lr.member);
  const pv = (S.cat.providers || []).find(p => p.key === lr.provider);
  const name = `${pv?.label || lr.provider} · ${lr.model}`;
  const parts = [`<span class="ms-k"${lr.model_reported !== true ? ' title="服务商未报告实际型号"' : ''}>${lr.model_reported === true ? '最近一次实际回答' : '最近一次调用'}</span><span>${esc(name)}</span><small>${esc([r?.label || lr.member, lr.step, when(lr.at)].filter(Boolean).join(' · '))}</small>`];
  const fb = lr.fallback_from ? (typeof lr.fallback_from === 'string' ? lr.fallback_from : lr.fallback_from.backend || lr.fallback_from.ref || JSON.stringify(lr.fallback_from)) : '';
  if (fb) parts.push(`<small class="ms-warn">${esc(label(fb))} 未连通，已使用备用模型。</small>`);
  return `<div class="ms-last">${parts.join('')}</div>`;
}
const sourceOf = p => p?.key === 'offercrew' ? 'free' : LOCAL.has(p?.kind) ? 'runtime' : 'key';
const defaultModel = () => S.cat?.default?.text?.[0] || S.cat?.default?.chat;
const isDefault = m => same(m, defaultModel()) && same(m, S.cat?.default?.chat);
const providerOf = key => S.cat?.providers?.find(p => p.key === key);
const canUse = m => !!m && !m.missing && m.ready !== false && m.provider_ready !== false;
const modelOf = ref => (S.cat?.providers || []).flatMap(p => p.models || []).find(m => m.ref === ref);
const fold = (key, title, content, extra = '') => `<details class="ms-details ${extra}" data-ms-detail="${esc(key)}" ${S.details[key] ? 'open' : ''}><summary>${esc(title)}</summary><div class="ms-detail-body">${content}</div></details>`;

function defaultCard() {
  const d = S.cat?.default || {}, chain = d.text || [], first = defaultModel(), eff = d.effective_text;
  const chatDiff = d.chat && !same(d.chat, first);
  const notice = first && (!eff ? '<p class="ms-bad">默认和备用模型都未就绪。</p>' : !same(eff, first) ? `<p class="ms-warn">默认模型未就绪，备用为 ${esc(eff.provider_label)} · ${esc(modelWords(eff.model))}。</p>` : '');
  const detail = `${chatDiff ? `<div class="ms-kv"><span class="ms-k">对话模型</span>${modelName(d.chat, { id: true })}</div>` : ''}${chain.length > 1 ? `<div class="ms-kv"><span class="ms-k">调用顺序</span><ol class="ms-chain">${chain.map(m => `<li>${modelName(m, { id: true })}${tags(m, { untested: false })}</li>`).join('')}</ol></div>` : ''}${lastLine(d)}`;
  return `<section class="ms-def" aria-label="当前默认模型"><div class="ms-def-head"><div class="ms-def-main"><span class="ms-eyebrow">当前默认${chatDiff ? ' · 文字' : ''}</span><div class="ms-def-name">${first ? modelName(first) : '<b>还没有默认模型</b>'}</div>${first ? tags(first) + (S.msg.default ? '' : verifyLine(first)) : ''}</div>${first ? `<div class="ms-acts">${testButton(first.ref, 'default')}</div>` : ''}</div>${notice || ''}${note('default')}${detail ? fold('diagnostics', S.cat?.last_response?.fallback_from ? '最近一次使用了备用模型 · 调用详情' : '调用详情', detail, S.cat?.last_response?.fallback_from ? 'warn' : '') : ''}</section>`;
}

// 浏览来源/供应商/型号只写页面状态；只有提交明确的模型选择才调用保存 API。
function browseSource() {
  const p = providerOf(defaultModel()?.provider);
  return S.source || (p ? sourceOf(p) : S.free?.available || S.free?.enabled ? 'free' : 'key');
}
function browseProvider(source = browseSource()) {
  const ps = (S.cat?.providers || []).filter(p => sourceOf(p) === source);
  return ps.find(p => p.key === S.providers[source]) || ps.find(p => p.key === defaultModel()?.provider) || ps[0];
}
function browseModel(p) {
  if (!p) return null;
  return p.models?.find(m => m.ref === S.models[p.key]) || p.models?.find(m => same(m, defaultModel())) || p.models?.[0] || null;
}
const modelMatches = (m, query) => !query.trim() || `${m.provider_label || ''} ${m.provider || ''} ${m.model} ${modelWords(m.model)}`.toLowerCase().includes(query.trim().toLowerCase());
const modelOptions = (models, selected, query = '') => models.filter(m => m.ref === selected || modelMatches(m, query)).map(m => `<option value="${esc(m.ref)}" ${m.ref === selected ? 'selected' : ''} ${canUse(m) ? '' : 'disabled'}>${esc(modelWords(m.model))}${!modelMatches(m, query) ? '（当前选择）' : ''}${canUse(m) ? '' : '（暂不可用）'}</option>`).join('');
const searchInput = (key, models, role = false) => models.length > 10 || S.searches[key] ? `<input type="search" data-ms-search="${esc(key)}" data-ms-keep="search:${esc(key)}" value="${esc(S.searches[key] || '')}" placeholder="${role ? '搜索模型或供应商' : '搜索模型 ID 或名称'}" aria-label="${role ? '搜索成员模型' : '搜索默认模型'}" autocomplete="off" spellcheck="false">` : '';
const searchEmpty = (models, query = '') => `<small class="ms-search-empty muted" role="status" ${query.trim() && !models.some(m => modelMatches(m, query)) ? '' : 'hidden'}>没有匹配的模型，当前选择未改变。</small>`;
function roleOptions(selected, query = '') {
  const groups = (S.cat?.providers || []).map(p => {
    const options = modelOptions(p.models || [], selected, query);
    return options ? `<optgroup label="${esc(p.label)}">${options}</optgroup>` : '';
  }).join('');
  const missing = selected && selected !== '__choose__' && !modelOf(selected) ? `<option value="${esc(selected)}" selected disabled>${esc(selected)}（连接已移除）</option>` : '';
  return `<option value="" ${selected === '' ? 'selected' : ''}>跟随默认</option>${selected === '__choose__' ? '<option value="__choose__" selected disabled>请选择模型</option>' : ''}${missing}${groups}`;
}
// 只替换下拉中的候选项：搜索框的焦点/输入法不重画，当前选项始终保留，不触发保存。
function filterModels(input) {
  const key = input.dataset.msSearch, query = input.value;
  S.browseVersion++;
  S.searches[key] = query;
  const field = input.closest('[data-ms-model-choice]'), select = field?.querySelector('select');
  if (!select) return;
  const selected = select.value, role = field.dataset.msModelChoice === 'role';
  const models = role ? (S.cat?.providers || []).flatMap(p => p.models || []) : browseProvider()?.models || [];
  select.innerHTML = role ? roleOptions(selected, query) : models.length ? modelOptions(models, selected, query) : '<option value="">还没有可选模型</option>';
  select.value = selected;
  const empty = field.querySelector('.ms-search-empty');
  if (empty) empty.hidden = !query.trim() || models.some(m => modelMatches(m, query));
}

function providerManage(p) {
  if (!p) return '';
  const meta = [KIND[p.kind] || p.kind_label || p.kind, p.base_host, p.discovered_at ? `更新于 ${when(p.discovered_at)}` : ''].filter(Boolean).join(' · ');
  const key = S.presets.some(x => x.key === p.key) ? browseBtn(`data-ms-open-key="${esc(p.key)}"`, '更换 Key') : '';
  const actions = `<div class="ms-acts">${p.discoverable ? btn(`data-ms-discover="${esc(p.key)}"`, S.busy === 'd:' + p.key ? '正在更新…' : '更新模型列表') : ''}${sourceOf(p) === 'key' ? key : ''}<a href="#settings/advanced/providers">连接设置</a></div>`;
  const manual = `<form class="ms-add-model" data-ms-add-model="${esc(p.key)}"><label class="ms-f"><span>添加模型</span><input name="model" data-ms-keep="am:${esc(p.key)}" autocomplete="off" spellcheck="false" maxlength="200" placeholder="模型 ID" aria-label="${esc(p.label)} · 模型 ID"></label><button type="submit" class="secondary mini" ${dis()}>添加并测试</button></form>${note('a:' + p.key)}`;
  return fold('provider:' + p.key, '管理此连接', `<p class="muted small">${esc(meta)}</p>${p.ready === false ? '<p class="ms-warn">此连接尚未就绪，请检查登录状态或 Key。</p>' : ''}${p.discovery_error ? `<p class="ms-bad">模型列表更新失败：${esc(p.discovery_error)}</p>` : ''}${actions}${note('d:' + p.key)}${manual}`);
}
function sourceBlock() {
  const source = browseSource(), p = browseProvider(source), m = browseModel(p);
  const searchKey = `default:${p?.key || ''}`, query = S.searches[searchKey] || '';
  const providers = (S.cat?.providers || []).filter(x => sourceOf(x) === source);
  const choices = [['free', 'OfferCrew 补给'], ['key', '自备 Key'], ['runtime', '本机 Runtime']];
  const tabs = `<div class="ms-sources" role="tablist" aria-label="接入来源">${choices.map(([key, name]) => `<button type="button" role="tab" id="ms-source-${key}" aria-controls="ms-source-panel" aria-selected="${source === key}" tabindex="${source === key ? '0' : '-1'}" data-ms-source="${key}">${name}</button>`).join('')}</div>`;
  const providerSelect = providers.length ? `<label class="ms-f"><span>${source === 'runtime' ? 'Runtime' : '供应商'}</span><select data-ms-provider aria-label="${source === 'runtime' ? 'Runtime' : '供应商'}">${providers.map(x => `<option value="${esc(x.key)}" ${x.key === p?.key ? 'selected' : ''}>${esc(x.label)}${x.ready === false ? '（未就绪）' : ''}</option>`).join('')}</select></label>` : '';
  const form = p ? `<form class="ms-model-form" data-ms-default-form><div class="ms-model-fields">${source === 'free' ? '' : providerSelect}<div class="ms-f" data-ms-model-choice="default"><span>模型</span>${searchInput(searchKey, p.models || [])}<select data-ms-model name="model" aria-label="默认模型" ${!m ? 'disabled' : ''}>${m ? modelOptions(p.models, m.ref, query) : '<option value="">还没有可选模型</option>'}</select>${searchEmpty(p.models || [], query)}</div></div>${m ? `<div class="ms-model-state"><span class="ms-model-id">${esc(m.model)}</span>${tags(m, { untested: false })}${verifyLine(m)}</div>` : '<p class="muted small">此连接还没有模型，可在「管理此连接」中更新或添加。</p>'}<div class="ms-form-actions"><button type="submit" class="primary mini" ${!canUse(m) || isDefault(m) || S.busy ? 'disabled' : ''}>${isDefault(m) ? '当前默认' : S.busy === 'default' ? '正在保存…' : '设为默认'}</button>${m && !isDefault(m) ? testButton(m.ref, 't:' + m.ref) : ''}</div>${m ? note('t:' + m.ref) : ''}</form>${providerManage(p)}` : '';
  const free = source === 'free' ? freeAccount() : '';
  const keys = source === 'key' ? `${!providers.length ? '<p class="muted small">还没有接入供应商。</p>' : ''}${providersBlock()}` : '';
  const runtime = source === 'runtime' ? `${!providers.length ? '<p class="muted small">还没有接入 Runtime。</p>' : ''}${localRows()}${chatgptAccount()}` : '';
  return `<section class="ms-source"><h3 class="ms-h">默认模型</h3>${tabs}<div id="ms-source-panel" class="ms-source-panel" role="tabpanel" aria-labelledby="ms-source-${source}">${free}${form}${keys}${runtime}</div></section>`;
}

// 成员只选已接入的模型，不混入来源管理。分别配置对话/文字的已有能力按需展开。
function roleInitial(r, channel = S.channel) {
  if (channel === 'chat') return r.inherits_chat ? '' : r.chat?.ref || r.effective_chat?.ref || '';
  if (channel === 'text') return r.inherits_text && !r.steps?.length ? '' : r.text?.[0]?.ref || r.effective_text?.[0]?.ref || '';
  if (r.inherits_chat && r.inherits_text && !r.steps?.length) return '';
  return same(r.effective_chat, r.effective_text?.[0]) ? r.effective_chat.ref : '__choose__';
}
function picker(scope) {
  const r = roleOf(scope); if (!r) return '';
  const key = `${scope}:${S.channel}`, selected = S.roleChoices[key] ?? roleInitial(r);
  const searchKey = `role:${key}`, query = S.searches[searchKey] || '', models = (S.cat?.providers || []).flatMap(p => p.models || []);
  const steps = r.steps?.length && S.channel !== 'chat' ? `<p class="ms-warn">保存后会替换 ${r.steps.length} 个步骤的单独模型设置。</p>` : '';
  const select = `<div class="ms-f" data-ms-model-choice="role"><span>模型</span>${searchInput(searchKey, models, true)}<select data-ms-role-model name="model" aria-label="${esc(r.label)}的模型">${roleOptions(selected, query)}</select>${searchEmpty(models, query)}</div>`;
  const channels = `<label class="ms-f"><span>应用范围</span><select data-ms-channel>${[['both', '对话和文字'], ['chat', '仅对话'], ['text', '仅文字']].map(([v, name]) => `<option value="${v}" ${S.channel === v ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`;
  const blocked = selected === '__choose__' || (selected !== '' && !canUse(modelOf(selected)));
  return `<form class="ms-pick" data-ms-role-form="${esc(scope)}">${select}${steps}${fold('channel:' + scope, '分别设置对话与文字', channels)}<div class="ms-form-actions"><button type="submit" class="primary mini" ${blocked || S.busy ? 'disabled' : ''}>保存</button>${browseBtn(`data-ms-pick="${esc(scope)}"`, '取消')}</div></form>`;
}
function roleRow(r, solo = false) {
  const open = S.pick === r.key, run = r.effective_text?.[0], both = same(r.effective_chat, run) && r.inherits_chat === r.inherits_text;
  const inherited = r.inherits_chat && r.inherits_text && !r.steps?.length;
  const line = (name, m) => `<div class="ms-kv">${name ? `<span class="ms-k">${name}</span>` : ''}${modelName(m)}${inherited ? '' : tags(m, { untested: false })}</div>`;
  const body = both ? line('', run) : `${line('对话', r.effective_chat)}${line('文字', run)}`;
  const rest = (r.effective_text || []).slice(1);
  const extra = `${rest.length ? `<p class="muted small">后备 ${rest.length} 个：${rest.map(m => esc(`${m.provider_label} · ${m.model}`)).join('、')}</p>` : ''}${r.steps?.length ? `<ul class="ms-steps">${r.steps.map(s => `<li>${esc(s.step)}：${s.models.map(m => `${esc(m.provider_label)} · ${esc(m.model)}`).join('、')}</li>`).join('')}</ul>` : ''}`;
  return `<div class="ms-role ${open ? 'open' : ''}" data-ms-role="${esc(r.key)}"><div class="ms-role-head"><div class="ms-role-main">${solo ? '' : `<b>${esc(r.label)} <small>${inherited ? '跟随默认' : '单独设置'}</small></b>`}${body}</div><div class="ms-acts">${browseBtn(`data-ms-pick="${esc(r.key)}" aria-expanded="${open}"`, open ? T.close : T.change)}</div></div>${note('role:' + r.key)}${open ? picker(r.key) + (extra ? fold('role:' + r.key, '当前调用设置', extra) : '') : ''}</div>`;
}
function rolesBlock() {
  const roles = S.cat?.roles || [];
  if (!roles.length) return '';
  const n = custom().length;
  return `<section class="ms-role-section"><h3 class="ms-h">成员模型<small>${n ? `${n} 位单独设置` : '全部跟随默认'}</small></h3><div class="ms-roles">${roles.map(r => roleRow(r)).join('')}</div></section>`;
}

// 尚未接入的本机 Runtime 用原有显式启用入口；浏览页签不会启用或切换它。
function localRows() {
  const rts = S.src?.local?.runtimes || [];
  const rows = rts.map(r => {
    const existing = (S.cat?.providers || []).some(p => (r.kind === 'codex' ? p.kind === 'codex_exec' && !p.account : p.kind === 'claude_code') && p.ready);
    const meta = [r.version ? `版本 ${r.version}` : '', r.state].filter(Boolean).join(' · ');
    return `<div class="ms-row"><div class="ms-row-main"><b>${esc(r.name)}</b><span>${esc(meta)}</span>${r.remedy ? `<small>${esc(r.remedy)}</small>` : ''}</div>${!existing && r.usable ? `<div class="ms-row-act">${btn(`data-ms-local="${esc(r.kind)}"`, '启用并设为默认')}</div>` : existing ? '<span class="ms-tag">已接入</span>' : ''}</div>`;
  }).join('');
  const content = `<div class="ms-acts">${btn('data-ms-detect', S.busy === 'detect' ? '正在检测…' : '重新检测')}</div>${rows ? `<div class="ms-list">${rows}</div>` : '<p class="muted small">这台电脑上未检测到可用的 Codex 或 Claude Code。</p>'}${note('local')}`;
  return fold('local', '接入本机 Runtime', content);
}
function presetList() {
  const have = new Set((S.cat?.providers || []).map(p => p.key));
  return `<p class="ob-note small">${esc(T.keysLead)}</p><div class="ob-keys">${S.presets.map((p, i) => `<details class="ob-key" data-ms-preset="${esc(p.key)}" ${S.keyOpen === p.key || (!S.keyOpen && i === 0) ? 'open' : ''}><summary><b>${esc(p.label)}</b>${have.has(p.key) ? '<span class="ms-tag quiet">已添加 · 换 Key</span>' : ''}</summary><div class="ob-key-body">${p.price ? `<p class="small">${esc(T.price)}${esc(p.price)}</p>` : ''}<ol class="ob-key-steps">${(p.steps || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol>${(p.notes || []).map(x => `<p class="ob-note small">${esc(x)}</p>`).join('')}<p class="ob-key-links">${p.signup ? `<a href="${esc(p.signup)}" target="_blank" rel="noopener noreferrer">${esc(T.signup)} ↗</a>` : ''}${p.key_page ? `<a href="${esc(p.key_page)}" target="_blank" rel="noopener noreferrer">${esc(T.keyPage)} ↗</a>` : ''}</p><form class="ob-key-form" data-ms-key-form="${esc(p.key)}"><input name="api_key" type="password" data-ms-keep="k:${esc(p.key)}" autocomplete="off" placeholder="${esc(T.paste)}" aria-label="${esc(p.label)} · ${esc(T.paste)}"><button type="submit" class="primary" ${dis()}>${esc(S.busy === 'key:' + p.key ? '正在保存…' : T.save)}</button></form>${note('key:' + p.key)}</div></details>`).join('')}</div>`;
}
function customForm() {
  const f = (name, label, attrs = '') => `<label class="ms-f"><span>${label}</span><input name="${name}" data-ms-keep="c:${name}" autocomplete="off" spellcheck="false" ${attrs}></label>`;
  return `<form class="ms-custom" data-ms-custom>
${f('label', '名字', 'placeholder="比如 公司网关" maxlength="40"')}${f('key', '标识（英文小写）', 'required pattern="[a-z][a-z0-9_\\-]{1,31}" placeholder="my_gateway"')}
<label class="ms-f"><span>协议</span><select name="kind" data-ms-keep="c:kind"><option value="openai_http|chat">OpenAI 兼容 · chat/completions</option><option value="openai_http|responses">OpenAI 兼容 · responses</option><option value="anthropic_http">Anthropic Messages 兼容</option></select></label>
${f('base_url', 'base_url', 'required type="url" placeholder="https://example.com/v1"')}
<label class="ms-f"><span>API key</span><input name="api_key" type="password" data-ms-keep="c:api_key" autocomplete="off" required></label>
${f('models', '型号名（可空，多个用逗号）', 'placeholder="拉取失败时用这些"')}
<div class="ms-f-act"><button type="submit" class="primary mini" ${dis()}>${S.busy === 'custom' ? '正在添加…' : '添加并拉取型号'}</button></div></form>${note('custom')}`;
}
function providersBlock() {
  const add = S.add;
  if (!add) return `<div class="ms-form-actions">${btn('data-ms-add="preset"', '添加供应商')}</div>`;
  const tabs = `<div class="ms-seg" role="tablist" aria-label="供应商类型">${[['preset', '常用服务商'], ['custom', '自定义兼容供应商']].map(([key, name]) => `<button type="button" role="tab" aria-selected="${add === key}" class="${add === key ? 'on' : ''}" data-ms-add="${key}" ${dis()}>${name}</button>`).join('')}</div>`;
  return `<div class="ms-addbox"><div class="ms-sub-h"><span>添加供应商</span>${btn('data-ms-add=""', T.close)}</div>${tabs}${add === 'preset' ? presetList() : customForm()}</div>`;
}

// ── 账号与补给（折起来）──────────────────────────────────────────────────────
function freePanel() {
  const f = S.free || {};
  // 补给跟着 OfferCrew 账户走（10-03）：没登录只放一个「登录」（左下角那个登录框，web/account.js）。
  if (!f.signed_in) return `<p class="ob-note ob-privacy">${esc(T.freePrivacy)}</p>${f.demo ? `<p class="ob-status st-warn"><b>${esc(f.reason || '')}</b></p>` : ''}<div class="ob-actions"><button type="button" class="primary" data-ms-login ${f.demo ? 'disabled' : ''}>${esc(T.login)}</button></div>`;
  const who = `<div class="ms-who"><span class="ms-av" aria-hidden="true">${esc((String(f.email || '').match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase())}</span><b>${esc(f.email || '')}</b>${btn('data-ms-logout', T.logout)}</div>${note('logout')}`;
  const blocked = f.demo || f.available === false || f.paused;
  const reason = blocked && f.reason ? `<p class="ob-status st-warn"><b>${esc(f.reason)}</b></p>` : '';
  const usingFree = S.src?.kind === 'free' && S.src.ok;
  const use = usingFree || (f.beta_full && !f.enabled) ? '' : `<div class="ob-actions"><button type="button" class="secondary" data-ms-free ${blocked || S.busy ? 'disabled' : ''}>${esc(S.busy === 'free' ? T.freeStarting : T.freeUse)}</button></div>`;
  const pts = (label, v, cls) => `<div class="ms-pt ${cls}"><span>${esc(label)}</span><b>${v == null ? '—' : esc(tokText(v))}</b><small>${esc(T.pt)}</small></div>`;
  const bal = f.enabled ? `<div class="ms-points">${pts(T.freeLabel, f.free_points, 'free')}${f.paid_points > 0 ? pts(T.paidLabel, f.paid_points, 'paid') : ''}</div>` : '';
  const redeem = `<form class="ms-redeem" data-ms-redeem><input name="code" data-ms-keep="redeem" autocomplete="off" spellcheck="false" maxlength="40" placeholder="OC-XXXX-XXXX-XXXX-XXXX" aria-label="${esc(T.code)}"><button type="submit" class="primary" ${dis()}>${esc(S.busy === 'redeem' ? T.redeeming : T.redeem)}</button>${f.buy_url ? `<a class="button secondary ms-buy" href="${esc(f.buy_url)}" target="_blank" rel="noopener noreferrer">${esc(T.buy)} ↗</a>` : ''}</form>${note('redeem')}`;
  const id = f.install_id || S.src?.free?.install_id;
  return `${who}<p class="ob-note ob-privacy">${esc(T.freePrivacy)}</p>${bal}<p class="ob-note">${esc(T.freeCost)}</p>${reason}${use}${note('free')}${redeem}${id ? `<p class="ob-note small muted">${esc(T.freeInstall(id))}</p>` : ''}`;
}
function freeAccount() {
  if (!S.free) return `<p class="ms-bad">补给状态暂时读不到。</p><div class="ms-form-actions">${btn('data-ms-retry', '重试')}</div>`;
  const f = S.free;
  if (!f.signed_in) return `<div class="ms-free-status"><span>${esc(f.reason || (f.available === false ? 'OfferCrew 补给暂不可用' : '尚未登录 OfferCrew'))}</span>${f.demo || f.available === false ? '' : btn('data-ms-login', T.login, 'primary mini')}</div>${fold('free-privacy', '数据与计费', `<p class="small">${esc(T.freePrivacy)}</p><p class="small">${esc(T.freeCost)}</p>`)}`;
  const status = f.reason || f.balance_label || f.remaining_label || (f.enabled ? (f.free_points == null ? '余额待查询' : `${tokText(f.free_points)} token 可用`) : '尚未启用补给');
  const summary = `<div class="ms-free-status"><span class="${f.paused || f.available === false ? 'ms-warn' : ''}">${esc(status)}</span><span class="muted small">${esc(f.email || '')}</span></div>`;
  return `${summary}${fold('free-account', '账户与补给', `<div class="ms-acct-part"><h4>OfferCrew 补给</h4>${freePanel()}</div>`)}`;
}
function chatgptAccount() {
  if (!S.codex) return '';
  // 此入口安装/登录 OfferCrew 自己管理的 Codex，不属于 BYOK。
  return fold('chatgpt', 'ChatGPT 账号', `<p class="ob-note">${esc(T.chatgptNote)}</p>${S.details.chatgpt ? codexSlotHtml() : ''}${note('chatgpt')}`);
}

const staleNote = () => S.cat && S.catErr ? `<div class="ms-warn-box" role="status">模型目录刷新失败：${esc(S.catErr)}。下面是上次读取的设置，可能不是最新状态。${btn('data-ms-retry', '重试')}</div>` : '';
function html() {
  if (!S.cat && !S.src) return S.catErr ? errBox() : `<p class="muted">正在读取…</p>`;
  return `${staleNote()}${S.cat ? defaultCard() : errBox()}${S.cat ? sourceBlock() : ''}${rolesBlock()}`;
}
function errBox() {
  const t = S.src?.title ? `<p class="small">配置里的默认：<b>${esc(S.src.title)}</b>${S.src.status ? ` · ${esc(S.src.status)}` : ''}</p>` : '';
  return `<section class="ms-def empty"><p class="ms-bad">型号目录读不到：${esc(S.catErr || '没有返回')}</p>${t}<div class="ms-acts">${btn('data-ms-retry', '重试')}</div></section>`;
}
function roleBox(key) {
  if (!S.cat) return S.catErr ? `<p class="ms-bad small">型号目录读不到：${esc(S.catErr)}</p>${btn('data-ms-retry', '重试')}` : '<p class="muted">正在读取…</p>';
  const r = roleOf(key);
  return r ? staleNote() + roleRow(r, true) : '<p class="muted">这位成员不用文字模型。</p>';
}

// 同步给占位（设置页先画、再挂）。
export function modelSimpleHtml() { return `<div id="settings-model" class="ms" data-model-simple>${S.html || '<p class="muted">正在读取…</p>'}</div>`; }
export function modelRoleHtml(key) { return `<div class="ms ms-solo" data-ms-role-box="${esc(key)}">${S.cat ? roleBox(key) : '<p class="muted">正在读取…</p>'}</div>`; }
// 设置页摘要用：目录没读到给 null（调用处用自己的老数据）。
export function modelSummary() {
  const m = S.cat?.default?.text?.[0] || S.cat?.default?.chat;
  return S.cat ? { model: m ? `${m.provider_label} · ${modelWords(m.model)}` : '', custom: custom().length } : null;
}

// ── 重画：保留输入框内容、焦点和光标 ─────────────────────────────────────────
const boxes = () => [...document.querySelectorAll('[data-model-simple],[data-ms-role-box]')];
function paint() {
  const all = boxes();
  if (!all.length) return;
  const keep = {}; let focus = null;
  for (const el of document.querySelectorAll('[data-ms-keep]')) keep[el.dataset.msKeep] = el.value;
  // toggle 异步派发；重画前直接取当前展开状态，避免紧接的 change 把刚打开的面板收起。
  for (const box of all) for (const d of box.querySelectorAll('[data-ms-detail]')) S.details[d.dataset.msDetail] = d.open;
  const a = document.activeElement;
  if (a?.dataset?.msKeep) focus = { k: a.dataset.msKeep, s: a.selectionStart, e: a.selectionEnd };
  else if (a?.matches?.('[data-ms-model],[data-ms-provider],[data-ms-role-model],[data-ms-channel]')) focus = { selector: `[${[...a.attributes].find(x => /^data-ms-(model|provider|role-model|channel)$/.test(x.name)).name}]` };
  S.html = html();
  for (const box of all) {
    box.innerHTML = box.dataset.msRoleBox ? roleBox(box.dataset.msRoleBox) : S.html;
    for (const el of box.querySelectorAll('[data-ms-keep]')) if (keep[el.dataset.msKeep] != null && el.type !== 'search') el.value = keep[el.dataset.msKeep];
    bind(box);
  }
  if (focus) { const el = document.querySelector(focus.selector || `[data-ms-keep="${CSS.escape(focus.k)}"]`); if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(focus.s, focus.e); } catch {} } }
}
async function refresh() { await load(); paint(); }
async function reloadSavedCatalog(saved) {
  if (S.loading) await S.loading;
  await load();
  if (S.catErr) throw Error(`${saved}，但最新配置读取失败：${S.catErr}。请重试。`);
}
async function run(key, fn) {
  if (S.busy) return;
  S.busy = key; S.configVersion++; S.messages[key] = (S.messages[key] || 0) + 1; delete S.msg[key]; paint();
  try { await fn(); } catch (e) { S.msg[key] = { ok: false, text: e.message || '没成功' }; }
  S.busy = false; paint();
  await refresh();
}
// 测试独立于保存；同一型号复用在途请求，结果只更新它自己的状态。
// 不重读整份配置，防止旧测试结束后把新默认或正在浏览的草稿换回去。
async function testRef(ref, msgKey, { saved = '' } = {}) {
  const version = S.messages[msgKey] = (S.messages[msgKey] || 0) + 1;
  S.msg[msgKey] = { ok: true, text: `${saved ? saved + '。' : ''}正在测试 ${label(ref)}…` };
  let task = S.tests[ref];
  if (!task?.pending) {
    task = S.tests[ref] = { pending: true };
    task.promise = Promise.resolve().then(async () => {
      const r = await post('/api/settings/test', { backend: ref }), t = r.body || {}, ok = r.ok && t.ok === true;
      task.verification = { ...t, ok, at: t.at || new Date().toISOString(), error: ok ? null : t.error || why(r, '没有回答') };
      task.pending = false;
      const actual = t.actual_model ? `；实际返回 ${t.actual_model}` : '；服务商未报告实际型号';
      return { ok, text: ok ? `测试通过：${t.requested_model || ref}，${sec(t.ms)}${actual}` : `测试失败：${task.verification.error}` };
    });
  }
  paint();
  const result = await task.promise;
  if (version === S.messages[msgKey] && (msgKey !== 'default' || defaultModel()?.ref === ref)) S.msg[msgKey] = { ...result, text: `${saved ? saved + (result.ok ? '。' : '，但') : ''}${result.text}` };
  paint();
  return result.ok;
}
const label = ref => { for (const p of S.cat?.providers || []) for (const m of p.models || []) if (m.ref === ref) return `${m.provider_label} · ${m.model}`; return ref; };
async function choose(ref, scope, channel = S.channel) {
  const browsing = S.browseVersion;
  if (scope === 'default') {
    const r = await post('/api/model/source', { use: ref });
    if (!r.ok) throw Error(`没换成：${why(r, '保存失败')}`);
    await reloadSavedCatalog('默认已保存');
    const n = custom().length;
    void testRef(ref, 'default', { saved: `默认已换成 ${label(ref)}${n ? `；${n} 位单独设置的成员不变` : ''}` });
  } else {
    const patch = channel === 'chat' ? { chat: ref } : channel === 'text' ? { text: ref } : { chat: ref, text: ref };
    const r = await post('/api/settings/agent', { role: scope, patch });
    if (!r.ok) throw Error(`没保存上：${why(r, '保存失败')}`);
    await reloadSavedCatalog('成员模型已保存');
    if (S.browseVersion === browsing && S.pick === scope) { S.pick = null; delete S.roleChoices[`${scope}:${channel}`]; }
    void testRef(ref, 'role:' + scope, { saved: '已保存' });
  }
  h?.refresh?.({ soft: true });
}
async function discover(key, msgKey = 'd:' + key) {
  const r = await post('/api/model/catalog', { action: 'discover', key }), d = r.body || {};
  S.msg[msgKey] = r.ok ? { ok: true, text: `模型列表已更新，共 ${(d.found || d.models || []).length} 个。` } : { ok: false, text: `模型列表更新失败：${d.error || '请求失败'}。可手动添加模型。` };
  return r.ok;
}
const openBrowse = (key, browsing) => { if (S.browseVersion === browsing) { S.source = 'key'; S.providers.key = key; S.pick = null; } };
async function resetRole(key, channel = 'both') {
  const browsing = S.browseVersion;
  const patch = channel === 'chat' ? { chat: null } : channel === 'text' ? { text: null } : { chat: null, text: null };
  const r = await post('/api/settings/agent', { role: key, patch });
  if (!r.ok) throw Error(`没恢复成：${why(r, '保存失败')}`);
  await reloadSavedCatalog('已恢复跟随默认');
  if (S.browseVersion === browsing && S.pick === key) { S.pick = null; delete S.roleChoices[`${key}:${channel}`]; }
  S.msg['role:' + key] = { ok: true, text: '已恢复跟随默认。' };
  h?.refresh?.({ soft: true });
}

function onClick(e) {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.msSource || d.msOpenKey || d.msPick != null || d.msAdd != null) S.browseVersion++;
  if (d.msSource) { S.source = d.msSource; paint(); document.querySelector(`[data-ms-source="${d.msSource}"]`)?.focus({ preventScroll: true }); return; }
  if (d.msOpenKey) { S.source = 'key'; S.add = 'preset'; S.keyOpen = d.msOpenKey; paint(); document.querySelector(`[data-ms-key-form="${CSS.escape(d.msOpenKey)}"] input`)?.focus(); return; }
  if (d.msPick != null) { S.pick = S.pick === d.msPick ? null : d.msPick; if (S.pick) { S.channel = 'both'; for (const key of Object.keys(S.roleChoices)) if (key.startsWith(S.pick + ':')) delete S.roleChoices[key]; } paint(); return; }
  if (d.msAdd != null) { S.add = d.msAdd ? (S.add === d.msAdd ? null : d.msAdd) : null; paint(); return; }
  if (d.msRetry != null) { refresh(); return; }
  if (d.msTest) { void testRef(d.msTest, d.msKey); return; }
  if (d.msDiscover) { const key = d.msDiscover; run('d:' + key, () => discover(key)); return; }
  if (d.msDetect != null) { run('detect', async () => { const r = await fetch('/api/local-runtimes?fresh=1').catch(() => null); if (!r?.ok) S.msg.local = { ok: false, text: '检测没跑成，稍后再试' }; }); return; }
  if (d.msLocal) {
    const pick = d.msLocal, browsing = S.browseVersion;
    run('local', async () => {
      const r = await post('/api/onboarding/model', { use: 'local', pick });
      if (!r.ok) throw Error(`没启用：${why(r, '请求失败')}`);
      S.msg.local = { ok: true, text: '已接入并设为默认。' };
      if (S.browseVersion === browsing) { S.source = 'runtime'; S.providers.runtime = pick === 'claude' ? 'claude_subscription' : 'openai'; }
      h?.refresh?.({ soft: true });
    });
    return;
  }
  if (d.msLogin != null) { window.dispatchEvent(new CustomEvent('oc:login')); return; }
  if (d.msLogout != null) { run('logout', async () => { const r = await post('/api/account', { action: 'logout' }); if (!r.ok) S.msg.logout = { ok: false, text: why(r, '没退出') }; window.dispatchEvent(new CustomEvent('oc:account')); }); return; }
  if (d.msFree != null) {
    run('free', async () => {
      const r = await post('/api/model/free', { action: 'start', make_default: true });
      // 内测名额满了：卡片上已经写着，不再重复。
      S.msg.free = r.ok ? { ok: true, text: T.freeDone(r.body.remaining_label) } : r.body.error === 'beta_full' ? null : { ok: false, text: why(r, '没开成') };
      if (r.ok) h?.refresh?.({ soft: true });
    });
  }
}
function onSubmit(e) {
  const f = e.target;
  if (f.matches('[data-ms-default-form]')) {
    e.preventDefault();
    const ref = f.elements.model.value, m = modelOf(ref);
    if (canUse(m) && !isDefault(m)) run('default', () => choose(ref, 'default'));
  } else if (f.matches('[data-ms-role-form]')) {
    e.preventDefault();
    const role = f.dataset.msRoleForm, ref = f.elements.model.value;
    if (ref === '') run('role:' + role, () => resetRole(role, S.channel));
    else if (canUse(modelOf(ref))) run('role:' + role, () => choose(ref, role));
  } else if (f.matches('[data-ms-redeem]')) {
    e.preventDefault();
    const code = f.code.value.trim();
    if (!code) { f.code.focus(); return; }
    run('redeem', async () => { const r = await post('/api/model/free', { action: 'redeem', code }); S.msg.redeem = r.ok ? { ok: true, text: r.body.receipt } : { ok: false, text: why(r, '没兑上') }; if (r.ok) f.code.value = ''; });
  } else if (f.matches('[data-ms-add-model]')) {
    e.preventDefault();
    const key = f.dataset.msAddModel, model = f.model.value.trim();
    if (!model) { f.model.focus(); return; }
    run('a:' + key, async () => {
      const r = await post('/api/model/catalog', { action: 'add', key, model });
      if (!r.ok) throw Error(`没加上：${why(r, '保存失败')}`);
      f.model.value = ''; document.querySelectorAll(`[data-ms-keep="am:${CSS.escape(key)}"]`).forEach(x => { x.value = ''; });
      void testRef(r.body.ref || `${key}/${model}`, 'a:' + key, { saved: '模型已添加' });
    });
  } else if (f.matches('[data-ms-key-form]')) {
    e.preventDefault();
    const key = f.dataset.msKeyForm, api_key = f.api_key.value.trim(), browsing = S.browseVersion;
    if (!api_key) { f.api_key.focus(); return; }
    S.keyOpen = key;
    run('key:' + key, async () => {
      const add = await post('/api/settings/providers', { action: 'preset_add', preset: key, api_key });
      // 这一家已经加过：换成新粘贴的 key。
      if (!add.ok && /已有供应商/.test(add.body.error || '')) { const up = await post('/api/settings/providers', { action: 'provider_update', key, api_key }); if (!up.ok) throw Error(`Key 没保存上：${why(up, '保存失败')}`); }
      else if (!add.ok) throw Error(`Key 没保存上：${why(add, '保存失败')}`);
      clearKeep('k:' + key);
      const ok = await discover(key, 'key:' + key);
      S.msg['key:' + key] = { ok, text: `Key 已保存。${S.msg['key:' + key].text}` };
      openBrowse(key, browsing);
    });
  } else if (f.matches('[data-ms-custom]')) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f)), [kind, wire] = String(v.kind).split('|');
    const key = String(v.key || '').trim(), browsing = S.browseVersion;
    run('custom', async () => {
      const r = await post('/api/settings/providers', { action: 'provider_add', key, label: String(v.label || '').trim() || key, kind, base_url: String(v.base_url || '').trim(), api_key: String(v.api_key || '').trim(), models: String(v.models || '').split(/[,，\s]+/).filter(Boolean), ...(kind === 'openai_http' ? { wire_api: wire || 'chat' } : {}) });
      if (!r.ok) throw Error(`没添加上：${why(r, '保存失败')}`);
      ['label', 'key', 'base_url', 'api_key', 'models'].forEach(n => clearKeep('c:' + n));
      const ok = await discover(key, 'custom');
      S.msg.custom = { ok, text: `已添加。${S.msg.custom.text}` };
      openBrowse(key, browsing);
    });
  }
}
const clearKeep = k => document.querySelectorAll(`[data-ms-keep="${CSS.escape(k)}"]`).forEach(x => { x.value = ''; });
const bound = new WeakSet();
function bind(box) {
  if (bound.has(box)) return;
  bound.add(box);
  box.addEventListener('click', onClick);
  box.addEventListener('submit', onSubmit);
  box.addEventListener('input', e => { if (e.target.matches('[data-ms-search]')) filterModels(e.target); });
  box.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && e.target.matches('select') && e.target.closest('[data-ms-default-form],[data-ms-role-form]')) { e.preventDefault(); return; }
    if (e.target.matches('[data-ms-search]')) {
      if (e.key === 'Enter') e.preventDefault();
      else if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; filterModels(e.target); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.target.closest('[data-ms-model-choice]')?.querySelector('select')?.focus(); }
      return;
    }
    if (!e.target.matches('[data-ms-source]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...box.querySelectorAll('[data-ms-source]')], current = tabs.indexOf(e.target);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); tabs[index]?.click();
  });
  box.addEventListener('change', e => {
    const el = e.target;
    let selector = null;
    if (el.matches('[data-ms-provider]')) { S.providers[browseSource()] = el.value; selector = '[data-ms-provider]'; }
    else if (el.matches('[data-ms-model]')) { const p = browseProvider(); if (p) S.models[p.key] = el.value; selector = '[data-ms-model]'; }
    else if (el.matches('[data-ms-role-model]')) { S.roleChoices[`${S.pick}:${S.channel}`] = el.value; selector = '[data-ms-role-model]'; }
    else if (el.matches('[data-ms-channel]')) { S.channel = el.value; selector = '[data-ms-channel]'; }
    if (selector) { S.browseVersion++; paint(); document.querySelector(selector)?.focus({ preventScroll: true }); }
  });
  // details 的 toggle 不冒泡：捕获阶段接。账号块展开才画内容（ChatGPT 登录槽位一出现就会去查状态）。
  box.addEventListener('toggle', e => {
    const d = e.target;
    if (!d.isConnected) return;
    if (d.matches?.('[data-ms-detail]') && !!d.open !== !!S.details[d.dataset.msDetail]) { S.details[d.dataset.msDetail] = d.open; if (d.dataset.msDetail === 'chatgpt') paint(); }
    else if (d.matches?.('details[data-ms-preset]') && d.open) S.keyOpen = d.dataset.msPreset;
  }, true);
}
function ensureCss() {
  if (typeof document === 'undefined' || document.querySelector('link[data-ms-css]')) return;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/model-settings.css'; l.dataset.msCss = '1'; document.head.append(l);
}
// 设置页画完之后调：记下拿 token 的办法，去取数据。
export function mountModelSimple(helpers, getToken) {
  h = helpers || h; tokenOf = getToken || tokenOf;
  const all = boxes();
  // 别的设置页（团队成员列表、概览）没有挂点：也先读一份目录，摘要用实际生效的型号。
  if (!all.length) { if (!S.cat && !S.loading) load().catch(() => {}); return; }
  ensureCss();
  all.forEach(bind);
  if (S.busy) return;
  refresh().catch(() => {});
}

// web/command.js、web/settings/* 不 import（测试在 vm 里跑），从这里拿。
if (typeof window !== 'undefined') window.OfferCrewModelSimple = { html: modelSimpleHtml, roleHtml: modelRoleHtml, summary: modelSummary, role: key => roleOf(key) || null, mount: mountModelSimple };
// 登录、退出之后（web/account.js 发 oc:account）：设置页开着就重读一遍。
if (typeof window !== 'undefined') for (const event of ['oc:account', 'offercrew:codex']) window.addEventListener(event, () => { if (boxes().length) refresh().catch(() => {}); });
