// 高级：工程参数。高级页本身只是一列行，每行一个子页；原来的大表单按主题拆进子页，最下面一行小字写它在哪个文件。
// 已经搬走的字段（花费、只看优先城市、排除公司、自动修复、判断、飞书开关与静默）不在这里重复。
import { esc, fileLine } from './ui.js';

const files = D => D.cc.settings?.files || {};
const vals = (D, f) => files(D)[f]?.values || {};
const fieldsOf = (D, f, skip = []) => Object.keys(files(D)[f]?.fields || {}).filter(k => !skip.includes(k));
const executorAgent = D => D.cc.settings?.agents?.find(a => a.role === 'executor');
const ownCli = D => (executorAgent(D)?.source || D.setup?.local_ai?.source) === 'local';
const MOVED = {
  pipeline: ['discovery.focus_only', 'discovery.excluded_companies', 'spend_tier', 'budget.daily_usd', 'budget.daily_tokens', 'desktop_executor', 'browser', 'recommend.min_score', 'recommend.daily_limit'],
  host: ['system_auto_repair.enabled', 'system_auto_repair.per_hour', 'system_auto_repair.cooldown_hours'],
  concierge: ['enabled', 'callbacks_enabled', 'top_picks_card', 'quiet_start', 'quiet_end', 'auto_apply_policy.require_batch_review', 'auto_apply_policy.require_referrer_search', 'auto_apply_policy.deal_one_by_one'],
  model: ['text.backends'], chat: ['default'],
};
// 子页：{ 标题, 用哪些配置文件的哪些字段, 前面加什么 }
const FORMS = {
  discover: { title: '发现与匹配', file: 'pipeline', words: '匹配 扫描 城市冲刺 真人帖' },
  // 「执行器」是内部叫法；给你看的是这台电脑上跑任务的那个程序（引导里也这么说：这台电脑上的 Claude Code / Codex）。10-01 第 2 轮验收第 29 条。
  executor: { title: '本机工具（可选）', file: 'host', pre: D => D.kit.stack(['executor']), skip: ['executor', 'claude_provider', 'models', 'codex_models.fallback'], words: '执行器 Claude Codex 超时 轮数' },
  text: { title: '文字与图片', file: 'model', words: 'token 超时 图片识别' },
  chat: { title: '对话', file: 'chat', pre: D => D.kit.stack(['chat']), words: '对话 底座 历史 token' },
};
const skipped = (D, f) => [...(MOVED[f.file] || []), ...(f.skip || []), ...(f.file === 'host' && ownCli(D) ? ['codex_models.chain', 'codex_models.cycle_effort'] : [])];
const formSub = ([, f]) => ({ title: f.title, render: D => `${f.pre ? f.pre(D) : ''}<div class="st-card st-pad">${D.kit.form(f.file, fieldsOf(D, f.file, skipped(D, f)))}</div>${fileLine(files(D)[f.file]?.file)}` });
// 运行日志最近一条：今天写几点，别的日子写几月几日。
const lastEvent = D => { const t = (D.cc.recent_events || [])[0]?.ts; if (!t) return ''; const d = new Date(t), now = new Date(), p2 = n => String(n).padStart(2, '0'); return d.toDateString() === now.toDateString() ? `最近一条 ${p2(d.getHours())}:${p2(d.getMinutes())}` : `最近一条 ${d.getMonth() + 1}-${d.getDate()}`; };
const step = (D, k) => (D.setup?.steps || []).find(s => s.key === k);
// 执行器的名字照产品名写（10-01：摘要里印着小写的 codex）。
const EXEC_NAME = { codex: 'Codex', claude: 'Claude Code', 'claude-code': 'Claude Code' };
// 10-02 开箱第 2 轮 X1（负责人定）：App 里的定时（清单「定时运行」那一项带 app 和 times）写几点跑、App 开着才跑、
// 查信要等邮箱接好；下面一行是本机 AI 的开关（默认关，lib/capabilities.mjs）——打开了写明后果（会动浏览器、能读到
// 这台电脑上的文件、提交和发送照旧要你批准，三点一个不能少，主会话 10-02），打开了却没在跑写原因。界面上不说「执行器」。
// 命令行装的没有这个开关，定时那一行照旧是 launchd 的摘要。
const schedRow = D => {
  const s = step(D, 'schedule');
  if (!s?.app) return { id: 'schedule', label: '定时运行', value: esc(s?.summary || ''), warn: s?.status !== 'ok', words: 'launchd 定时 每天' };
  return { id: 'schedule', label: '定时运行', value: esc(`每天 ${s.times?.cycle || ''}${s.times?.brief ? ` · ${s.times.brief} 战报` : ''}`), note: 'App 开着时才跑；查信要等邮箱接好。', words: '定时 每天 查信 邮箱' };
};
const HANDS_ON = '用于你明确交代的本机文件、命令或单独启用的额外排查，能读取这台电脑上的文件。找岗、判断、材料、浏览器和邮件由引擎照常处理；发送和提交仍要你批准。';
// 关着时也写：打开之前就该知道打开意味着什么（10-02 开箱第 3 轮：关着的开关下面什么都没写，这三件事只有打开以后才看得到）。
const HANDS_OFF = `打开后，${HANDS_ON}`;
const hands = D => {
  const s = step(D, 'schedule');
  if (!s?.app) return null;
  const x = D.setup?.local_ai, on = vals(D, 'pipeline').desktop_executor === true, why = on ? x?.why : null;
  return { id: 'hands', label: '允许使用本机工具（可选）', value: on ? `${x?.launch || '尚未检查启动'} · ${x?.execution || '当前空闲'}` : '未打开', warn: !!why, toggle: { on, set: v => D.h.post('/api/settings', { name: 'pipeline', patch: { desktop_executor: v } }) }, note: on ? `${why ? `${why}。` : ''}${HANDS_ON}` : HANDS_OFF, words: '本机 AI 执行器 Codex 动手 浏览器 预填 表单 文件 定时' };
};
// 这台电脑上的 AI（R23）：自动检测到的 Claude Code / Codex 各一行，版本、登录、身份照实写；能用的直接「用它」，
// 没登录的写在哪里登录（OfferCrew 里不放登录）。「试一次」才调一次模型（lib/local-ai-check.mjs）。
const runtimeHtml = D => {
  const s = D.setup?.local_ai;
  if (!s?.runtimes) return '';
  const meta = r => [r.version ? `版本 ${r.version}` : '', r.state].filter(Boolean).map(esc).join(' · ');
  const act = r => `${r.selected ? `<em class="lr-cur">本机 AI 用它</em>` : r.usable ? `<button type="button" class="primary mini" data-local-ai-use="${esc(r.kind)}">用它</button>` : ''}${r.usable ? `<button type="button" class="secondary mini" data-local-ai-check="${esc(r.kind)}" aria-label="让 ${esc(r.name)} 试一次">试一次</button>` : ''}`;
  const last = r => r.last ? `<p class="st-note">${r.last.source === 'task' ? '最近一次任务' : '最近一次试'}：${esc(new Date(r.last.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} · <span>${esc(r.last.ok ? '跑通了' : r.last.reason || '没跑通')}</span></p>` : '';
  return `<div class="st-card st-pad lr" data-local-ai><div class="lr-head"><h3>本机工具（可选）</h3><button type="button" class="secondary mini" data-local-ai-detect>重新检测</button></div>
    <p class="lr-line ${s.on && !s.configured ? 'warn' : ''}">${esc(s.sentence || '')}</p>
    ${s.runtimes.map(r => `<div class="lr-row ${r.usable ? '' : 'off'}"><div class="lr-main"><b>${esc(r.name)}</b><span class="lr-meta">${meta(r)}</span>${r.remedy ? `<p class="st-note">${esc(r.remedy)}</p>` : ''}${last(r)}</div><div class="lr-act">${act(r)}</div></div>`).join('')}
    <p class="st-note">「试一次」会让它回一句话，用它自己的额度。${esc(s.independent)}</p>
    <p data-local-ai-result role="status"></p></div>`;
};
const bindRuntime = (page, D) => {
  const out = () => page.querySelector('[data-local-ai-result]');
  for (const b of page.querySelectorAll('[data-local-ai-check]')) b.onclick = async () => {
    b.disabled = true; out().textContent = '正在让它回一句话…';
    try { const r = await D.h.post('/api/settings/local-ai/check', { kind: b.dataset.localAiCheck }); out().textContent = [r.reason, r.remedy].filter(Boolean).join('；'); await D.h.refresh(); }
    catch (e) { out().textContent = e.message; } finally { b.disabled = false; }
  };
  for (const b of page.querySelectorAll('[data-local-ai-use]')) b.onclick = async () => {
    b.disabled = true;
    try { await D.h.post('/api/settings', { name: 'host', patch: { executor: b.dataset.localAiUse } }); await D.h.refresh(); }
    catch (e) { out().textContent = e.message; b.disabled = false; }
  };
  const det = page.querySelector('[data-local-ai-detect]');
  if (det) det.onclick = async () => {
    det.disabled = true; det.textContent = '正在检测…';
    try { await fetch('/api/local-runtimes?fresh=1'); await D.h.refresh(); }
    finally { det.disabled = false; det.textContent = '重新检测'; }
  };
};
const brief = (D, f) => { const v = vals(D, FORMS[f].file), selected = executorAgent(D)?.local_cli || D.setup?.local_ai?.selected || files(D).host?.values?.executor; return { discover: `每轮最多匹配 ${v.match_limit ?? '—'} · 单公司 ${v.match_per_company ?? '—'}`, executor: `${esc(EXEC_NAME[selected] || selected || '')}${v.timeout_minutes ? ` · 超时 ${esc(v.timeout_minutes)} 分钟` : ''}`, text: v['text.max_tokens'] ? `最大输出 ${esc(v['text.max_tokens'])}` : '', chat: v.history ? `带入 ${esc(v.history)} 轮` : '', cards: v.max_rows_per_card ? `每卡 ${esc(v.max_rows_per_card)} 行` : '' }[f] ?? ''; };

export default {
  id: 'advanced', title: '高级', icon: 'adj',
  bind: bindRuntime,
  summary: () => '定时运行、记忆库、供应商、本机 AI、备份与迁移',
  cards: D => [
    { rows: [
      schedRow(D),
      // 右边写一个事实（最近一条在什么时候、记了几条），不空着（10-01 第 2 轮验收第 29 条）。
      { id: 'stream', label: '运行日志', value: lastEvent(D), note: '排查执行失败、查看某一步的原始记录；任务进度和结果在任务里。', go: '#stream', words: '日志 事件 记录 诊断 排查' },
      { id: 'memory', label: '记忆库', value: D.cc.memory?.stats?.total ? `${D.cc.memory.stats.total} 条` : '还没有', sub: 'memory', words: '记忆 偏好 记住的事' },
    ].filter(Boolean) },
    { rows: [
      { id: 'providers', label: '供应商与预设', value: `${(D.cc.settings?.catalog || []).length} 个`, sub: 'providers', words: 'API key base_url 预设 模型目录 账号' },
      ...Object.entries(FORMS).map(([k, f]) => ({ id: k, label: f.title, value: brief(D, k) || '', sub: k, words: f.words })),
      { id: 'auth', label: '凭据', value: `${Object.values(D.cc.settings?.auth || {}).filter(a => a.exists).length} 个已配置`, sub: 'auth', words: 'token 密钥' },
    ] },
    // 从「账号与连接」挪过来的两项（10-01 开箱测试 #27）：自己建 Google 授权收发 Gmail、电脑操作用什么驱动。
    { rows: [
      { id: 'browser', label: '浏览器操作', value: '专用 Chrome', note: '内推检索和预填由引擎操作浏览器；提交仍要你批准。', words: '电脑操作 浏览器 Chrome' },
    ] },
    { rows: [hands(D)].filter(Boolean) },
    { rows: [{ id: 'backup', label: '备份与迁移', value: D.cc.settings?.backups?.length ? `${D.cc.settings.backups.length} 份备份` : '', sub: 'backup', words: '导出 迁移 换电脑 备份' }] },
  ],
  subs: {
    providers: { title: '供应商与预设', render: D => `<div class="st-card st-pad">${D.kit.catalog()}</div><h3 class="st-h">整套换模型（所有成员一起换）</h3>${D.kit.presets()}` },
    auth: { title: '凭据', render: D => `<div class="st-card st-pad">${D.kit.auth()}</div>` },
    memory: { title: '记忆库', render: D => D.kit.memory() },
    backup: { title: '备份与迁移', render: D => `<div class="st-card st-pad">${D.kit.migration()}</div><h3 class="st-h">最近备份</h3><div class="st-card st-pad">${D.kit.backups()}</div>` },
    ...Object.fromEntries(Object.entries(FORMS).map(e => [e[0], e[0] === 'executor' ? { ...formSub(e), render: D => runtimeHtml(D) + formSub(e).render(D), bind: bindRuntime } : formSub(e)])),
  },
  // 搜索也能搜到子页里的每个字段。
  index: D => Object.entries(FORMS).flatMap(([k, f]) => fieldsOf(D, f.file, skipped(D, f)).map(key => ({ id: `f-${f.file}-${key}`, label: `${f.title} · ${files(D)[f.file].fields[key].label}`, value: esc(fmt(vals(D, f.file)[key])), sub: k }))),
};
const fmt = v => (v == null ? '' : Array.isArray(v) ? `${v.length} 项` : typeof v === 'object' ? '' : typeof v === 'boolean' ? (v ? '开' : '关') : String(v));
