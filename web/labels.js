// 界面上的人话（2026-09-30 发版前打磨）：原始值、内部 id、文件名不直接给你看。
// 纯函数，浏览器和测试（tests/labels.test.mjs）都直接 import。
//   valueLabel(v)          个人信息里的枚举值：remote_china → 可以远程、true → 是、prefer_not_to_disclose → 不透露
//   dimLabel(d)            偏好学习的维度：company_type → 公司类型
//   prefLabel(dim, value)  偏好学习的一条：company_type:foreign_mnc → 公司类型：外企
//   runLabel(id, names)    运行 id：ops-round-scout-17… → Radar 跑一轮、cycle-… → 定时一轮
//   evidenceLabel(file)    证据文件：…/9.json → 证据、round-scout-….log → 日志
export const VALUE = {
  quant: '量化', 'low-latency trading': '低延迟交易', 'data labeling': '数据标注', internship: '实习', intern: '实习',
  sales: '销售', recruiting: '招聘', 'non-technical ops': '非技术运营', 'pure frontend': '纯前端', design: '设计',
  true: '是', false: '否', yes: '是', no: '否', unknown: '不确定',
  remote_china: '可以远程', hybrid: '一周去几天公司', onsite: '每天去公司', remote: '远程',
  employed: '在职', unemployed: '已离职', student: '在读', freelance: '自由职业',
  prefer_not_to_disclose: '不透露', negotiable: '可谈', 'cash first': '现金优先', cash_first: '现金优先', equity_ok: '可以接受股票',
  foreign_or_global_team: '外企或全球团队', large_low_overtime: '大公司、加班少', credible_startup: '靠谱的创业公司',
  foreign_mnc: '外企', chinese_big_tech: '国内大厂', state_owned: '国企', startup: '创业公司', outsourcing: '外包',
};
export const DIM = { direction: '方向', company: '公司', city: '城市', seniority: '级别', stack: '技术栈', salary_band: '薪资', source_type: '来源', company_type: '公司类型', job_family: '岗位类型' };
export const valueLabel = v => {
  if (Array.isArray(v)) return v.map(valueLabel);
  if (typeof v === 'boolean') return VALUE[String(v)];
  const s = String(v ?? '');
  const parts = s.split(/\s*\/\s*/);
  return Object.hasOwn(VALUE, s) ? VALUE[s] : parts.length > 1 && parts.every(p => Object.hasOwn(VALUE, p)) ? parts.map(valueLabel).join(' / ') : s;
};
export const dimLabel = d => DIM[d] || String(d || '');
export function prefLabel(dim, value) {
  const d = String(dim || ''), v = String(value ?? '');
  if (!v && d.includes(':')) { const i = d.indexOf(':'); return prefLabel(d.slice(0, i), d.slice(i + 1)); }
  return `${dimLabel(d)}：${valueLabel(v)}`;
}

// 运行 id → 人话。names：成员 id → 显示名（快照里的 crew 表）。认不得的写「一次运行」，不露 id。
const OP = { 'judge-leads': '判断新岗位', 'judge_now': '判断岗位', 'recompute-preferences': '重算偏好', 'browser-tidy': '收拾浏览器', 'sync': '同步', 'digest': '整理日报' };
export function runLabel(id, names = {}) {
  const s = String(id || '');
  const name = old => { const k = names[old] ? old : ({ radar: 'scout', reacher: 'quill', watch: 'owl', system: 'patch' }[old] || old); return (names[k]?.name || String(names[k]?.label || (typeof names[k] === 'string' ? names[k] : '')).split(' · ')[0]) || '成员'; };
  let m = /^(?:ops-)?round-([a-z]+)/.exec(s);
  if (m) return `${name(m[1])} 跑一轮`;
  if (/^cycle/.test(s)) return '定时一轮';
  if (/^judge/.test(s)) return '判断岗位';
  if (/^run_\d+/.test(s)) return '本机 AI 任务';
  if (/^(fb_|feedback)/.test(s)) return '处理你的反馈';
  if (/^chat|^talk/.test(s)) return '对话';
  m = /^ops-(.+?)-\d{6,}$/.exec(s);
  if (m) return OP[m[1]] || '一次操作';
  return OP[s] || '一次运行';
}
export const evidenceLabel = f => {
  const s = String(f || '');
  if (/\.log$/i.test(s)) return '诊断日志';
  if (/\.(png|jpe?g|webp)$/i.test(s)) return '页面截图';
  if (/\.pdf$/i.test(s)) return 'PDF 文件';
  if (s.includes('/model-attempts/')) return '模型调用记录';
  if (/\/match-/.test(s)) return '岗位判断记录';
  if (s.includes('/company-search/')) return '网页读取记录';
  return '步骤记录';
};
// web/command.js 不 import（测试在 vm 里跑它的源码），从这里拿：app.js 载入本文件时挂上。
globalThis.OfferCrewLabels = { valueLabel, dimLabel, prefLabel, runLabel, evidenceLabel };

// 模型 id 的人话：claude-opus-5-5 → Opus 5.5、claude-haiku-4-5-20251001 → Haiku 4.5、gpt-6-astra → GPT-6 Astra、
// gpt-5.6-luna → GPT-5.6 Luna、deepseek-v4-pro → DeepSeek V4 Pro、jev-latest → 判断模型。带供应商前缀（openai/gpt-6）也认。
// 认不出的名字原样给（自己填的模型名，你认得）。
const capWord = w => (/^v?\d/i.test(w) ? w.toUpperCase() : w === 'mini' || w === 'nano' ? w : w.charAt(0).toUpperCase() + w.slice(1));
export function modelWords(id) {
  const s = String(id ?? '').trim().split('/').pop();
  if (!s) return '';
  if (/^jev(-|$)/i.test(s)) return '判断模型';
  if (s === 'default') return '默认模型';
  let m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(s);
  if (m) return `${capWord(m[1].toLowerCase())} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  m = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(s);
  if (m) return `${capWord(m[3].toLowerCase())} ${m[1]}${m[2] ? '.' + m[2] : ''}`;
  if (/^(opus|sonnet|haiku|fable)$/i.test(s)) return capWord(s.toLowerCase());
  m = /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z0-9]+)*)$/i.exec(s);
  if (m) return `GPT-${m[1]}${m[2].split('-').filter(Boolean).map(w => ' ' + capWord(w.toLowerCase())).join('')}`;
  m = /^deepseek-([a-z0-9.-]+)$/i.exec(s);
  if (m) return `DeepSeek ${m[1].split('-').map(w => capWord(w.toLowerCase())).join(' ')}`;
  return s;
}

if (typeof window !== 'undefined') window.OfferCrewLabels = { ...(window.OfferCrewLabels || {}), modelWords };
