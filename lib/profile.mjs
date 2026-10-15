import { cityName, cityNames } from './city.mjs';
// 「开始使用」的个人资料：结构化地读写 candidate/facts.yaml 的白名单字段（2026-09-28）。
//
// 只有 PROFILE_FIELDS 和 PROFILE_ROWS 列出的路径能从页面写进去，每个值按类型校验，整份校验通过
// 才动文件；写之前把旧文件备份到 candidate/backup-<时间>/facts.yaml。改动走 yaml 的 Document API：
// 只改被改的节点，文件里的注释、没列出的字段（经历里的 evidence 以外的键、项目、定位……）原样保留。
// 经历 / 教育按行编辑：带 i 的行对应文件里的第 i 条（只校验、只写改动过的字段，没动的古怪值原样留着），
// 没带 i 的是新增，没提交的行删除；行号依赖文件版本，所以要带上读取时的 base（文件内容的 sha1），
// 文件在别处改过就拒绝（409）。里面有结构（列表里是一组组字段）的项只读，不在这里改。
// 身份证号、户籍、政治面貌、出生日期不在白名单里：不收、不存。
// 求职方向（2026-09-29）：preferences.directions / tracks 只收 lib/directions.mjs 里有的键（也认中英文名，存成键）；
// 证书按行编辑（证书 / 状态 / 时间）；教育多一列 GPA；美国工作许可改成选项，文件里原来的自由文字照样显示、照样保留。
import { forgetFacts } from './facts.mjs';
import { recheckCityDrafts } from './city-draft-review.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { file, write } from './store.mjs';
import { event } from './events.mjs';
import { TZ } from './tz.mjs';
import { DIRECTIONS, directionKey, directionSummary } from './directions.mjs';

export const FACTS = 'candidate/facts.yaml';
const HEADER = ' 候选人事实：填申请表、写首联、回答招聘方问题时唯一的依据。\n 由「开始使用」页面生成；可以直接手改，页面保存时会保留注释。';

export const PROFILE_GROUPS = [
  { key: 'identity', title: '身份与联系方式' },
  { key: 'education', title: '教育经历', rows: 'education' },
  { key: 'certifications', title: '证书', rows: 'certifications', note: '状态照原话写：已通过、持证、Level I passed、一级已过、在考、通过 3 科' },
  { key: 'experience', title: '工作经历', rows: 'experience' },
  { key: 'current', title: '现职', note: '没有在职就留空' },
  { key: 'location', title: '城市' },
  { key: 'auth', title: '工作许可' },
  { key: 'availability', title: '到岗' },
  { key: 'compensation', title: '薪酬' },
  { key: 'targets', title: '求职方向与排除' },
  { key: 'skills', title: '技能' },
];
export const CHINA_AUTH = { '': '未填', citizen: '中国大陆公民', permanent_resident: '永久居留', work_permit: '持工作许可', needs_sponsorship: '需要工作签证担保' };
// 美国工作许可：判断层按这几个键读（金融、咨询的美国岗位几乎都问要不要担保）。
export const US_AUTH = { '': '未填', citizen: '美国公民', permanent_resident: '绿卡', f1_opt: 'F-1 OPT', f1_stem_opt: 'F-1 STEM OPT', h1b: 'H-1B', needs_sponsorship: '需要担保', none: '没有美国工作许可' };
// 方向和细分的选项（名字取 lib/directions.mjs，不另写一份）；细分目前只有金融有，键在各方向之间不重复。
const DIRECTION_OPTIONS = Object.fromEntries(Object.entries(DIRECTIONS).map(([k, d]) => [k, d.zh]));
const TRACKS = Object.fromEntries(Object.values(DIRECTIONS).flatMap(d => Object.entries(d.tracks || {})));
const TRACK_OPTIONS = Object.fromEntries(Object.entries(TRACKS).map(([k, t]) => [k, t.zh]));
const trackKey = v => { const s = String(v ?? '').trim(), low = s.toLowerCase(); return Object.entries(TRACKS).find(([k, t]) => k === s || t.zh === s || t.en.toLowerCase() === low)?.[0] || null; };
// 工作方式（location.work_mode_preference，按优先级）：引导里选，存成这几个键（facts.example.yaml 就是这么写的）。
export const WORK_MODES = { remote_china: '远程', hybrid: '混合办公', onsite: '坐班' };
const workModeKey = v => { const s = String(v ?? '').trim(), low = s.toLowerCase(); return Object.hasOwn(WORK_MODES, s) ? s : low === 'remote' || s === WORK_MODES.remote_china ? 'remote_china' : Object.entries(WORK_MODES).find(([, l]) => l === s)?.[0] || null; };
// directionKey（lib/directions.mjs）查的是普通对象：「constructor」「__proto__」这类名字会查出原型上的东西。只认选项里真有的键。
const optionKey = (f, x) => { const k = f.key(x); return typeof k === 'string' && Object.hasOwn(f.options, k) ? k : null; };
export const PROFILE_FIELDS = {
  'identity.name_zh': { label: '中文名', kind: 'text', max: 40, group: 'identity' },
  'identity.name_en': { label: '英文名', kind: 'text', max: 80, group: 'identity', placeholder: 'Alex Chen' },
  'identity.email': { label: '邮箱', kind: 'email', group: 'identity' },
  'identity.mailbox': { label: '收发求职邮件的邮箱', kind: 'email', group: 'identity' },
  'identity.phone_cn': { label: '手机', kind: 'phone', group: 'identity', placeholder: '+86 138 0000 0000' },
  'identity.linkedin': { label: 'LinkedIn', kind: 'url', group: 'identity' },
  'identity.github': { label: 'GitHub / 个人主页', kind: 'url', group: 'identity' },
  'current_work.company': { label: '公司', kind: 'text', max: 120, group: 'current' },
  'current_work.title': { label: '职位', kind: 'text', max: 120, group: 'current' },
  'current_work.start': { label: '入职', kind: 'month', group: 'current', placeholder: '2024-03' },
  'location.current_city': { label: '现居城市', kind: 'text', max: 40, group: 'location' },
  'location.target_cities': { label: '目标城市', kind: 'list', item: 40, max: 12, group: 'location', placeholder: '每行一个，按优先级' },
  'location.relocation_ok': { label: '可以搬迁', kind: 'text', max: 200, group: 'location', placeholder: '可以 / 只考虑长三角 / 不搬' },
  // 只在「开始使用」的引导里选（编辑器不显示；设置页也能改）。
  'location.work_mode_preference': { label: '工作方式', kind: 'choices', options: WORK_MODES, key: workModeKey, max: 3, group: 'location', hidden: true },
  'work_authorization.china_mainland': { label: '中国大陆', kind: 'choice', max: 60, options: CHINA_AUTH, group: 'auth' },
  'work_authorization.overseas_remote': { label: '海外公司远程', kind: 'text', max: 200, group: 'auth', placeholder: '例如：可以，按合同工' },
  // 选项之外的旧写法（「需要 H-1B 担保」这类自由文字）不拦：页面把它当成一个选项显示，不碰就原样留着。
  'work_authorization.us': { label: '美国', kind: 'choice', max: 200, options: US_AUTH, group: 'auth' },
  'availability.current_status': { label: '在职状态', kind: 'text', max: 80, group: 'availability', placeholder: '在职 / 已离职 / 在读' },
  'availability.earliest_start': { label: '最早到岗', kind: 'text', max: 80, group: 'availability', placeholder: '接 offer 后 30 天' },
  'availability.notice_period_days': { label: '通知期（天）', kind: 'int', min: 0, max: 365, group: 'availability' },
  'compensation.expected_annual_cny': { label: '期望年薪（人民币）', kind: 'text', max: 120, group: 'compensation', placeholder: '40 万以上，可谈' },
  'compensation.floor_annual_cny': { label: '底线年薪', kind: 'text', max: 120, group: 'compensation' },
  // 在美国找工作的人按美元谈（金融示例人物就是这样写的）。
  'compensation.expected_annual_usd': { label: '期望年薪（美元）', kind: 'text', max: 120, group: 'compensation', placeholder: 'base 100,000 以上，可谈' },
  // 方向和细分在「你的方向」弹窗里选（卡片 + 看示例），编辑器里只显示一行和「改方向」（picker）。
  // directions 第一个是主方向；旧写法 preferences.direction（单个）一起读，保存 directions 时并进来。
  'preferences.directions': { label: '求职方向', kind: 'choices', options: DIRECTION_OPTIONS, key: directionKey, max: Object.keys(DIRECTIONS).length, min: 1, group: 'targets', picker: 'direction', alias: 'preferences.direction' },
  'preferences.tracks': { label: '细分', kind: 'choices', options: TRACK_OPTIONS, key: trackKey, max: Object.keys(TRACKS).length, group: 'targets', picker: 'direction' },
  // 自由文字的补充说明（软件方向靠它解锁前端、测试、算法……）；和上面选的「求职方向」不是一回事，名字分开。
  'preferences.role_families': { label: '想做的岗位（补充说明）', kind: 'list', item: 80, max: 12, group: 'targets', placeholder: '每行一个，用你自己的话：Agent 工程、并购分析师、品牌营销……' },
  'preferences.hard_exclusions': { label: '硬排除（碰到就不推）', kind: 'lines', item: 200, max: 20, group: 'targets', placeholder: '每行一条，例如 外包 / 驻场' },
  'skills': { label: '技能', kind: 'list', item: 60, max: 60, group: 'skills', placeholder: '每行一个，或用逗号隔开' },
  // 简历文件：页面上不直接改，导入简历时勾选「设为英文 / 中文简历」写这里。
  'resume_routing.english_pdf': { label: '英文简历 PDF', kind: 'pdf', group: 'resume', hidden: true },
  'resume_routing.chinese_pdf': { label: '中文简历 PDF', kind: 'pdf', group: 'resume', hidden: true },
};
// 按行编辑的两张表：editor 字段 → 文件里的键（开始 / 结束合成 dates：「2019-07 至 2022-03」）。
export const PROFILE_ROWS = {
  education: { path: ['education'], label: '教育经历', max: 12, title: 'school', fields: {
    school: { label: '学校', kind: 'text', max: 120 }, degree: { label: '学位与专业', kind: 'text', max: 120, placeholder: '工学学士 · 计算机' },
    start: { label: '入学', kind: 'month', placeholder: '2017-09' }, end: { label: '毕业', kind: 'month', placeholder: '2021-06 / 至今' },
    gpa: { label: 'GPA', kind: 'text', max: 30, placeholder: '3.7/4.0' },
  }, file: { school: 'school', degree: 'degree', start: 'dates', end: 'dates', gpa: 'gpa' } },
  // 证书：{ name, status, date }，status 写原话（「已通过」「Level I passed」「在考」），判断层按原话分已持有 / 在考。
  certifications: { path: ['certifications'], label: '证书', max: 20, title: 'name', fields: {
    name: { label: '证书', kind: 'text', max: 80, placeholder: 'CFA / 证券从业资格' }, status: { label: '状态', kind: 'text', max: 60, placeholder: '已通过 / Level I passed / 在考' },
    date: { label: '时间', kind: 'month', placeholder: '2026-02' },
  }, file: { name: 'name', status: 'status', date: 'date' } },
  experience: { path: ['career_highlights', 'entries'], label: '工作经历', max: 30, title: 'company', fields: {
    company: { label: '公司', kind: 'text', max: 120 }, title: { label: '职位', kind: 'text', max: 120 },
    start: { label: '开始', kind: 'month', placeholder: '2019-07' }, end: { label: '结束', kind: 'month', placeholder: '2022-03 / 至今' },
    highlights: { label: '做了什么（每行一条，写数字）', kind: 'lines', item: 1000, max: 20 },
  }, file: { company: 'company', title: 'role', start: 'dates', end: 'dates', highlights: 'evidence' } },
};

// ── 校验：每种类型一个函数，返回规范化的值；空值统一成 '' / [] / null ──────────────
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function text(v, { max = 200 } = {}) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw Error('要是文字');
  const s = String(v).replace(/\s+/g, ' ').trim();
  // 说清楚是哪个字符：它在输入框里看不见，只说「不可见字符」你没法改（多半是从简历 / 网页复制进来的）。
  if (CTRL.test(s)) throw Error(`含有看不见的控制字符（U+${s.match(CTRL)[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}），把这一项删掉重新输入`);
  if (s.length > max) throw Error(`最多 ${max} 个字`);
  return s;
}
function list(v, { item = 60, max = 30, split = /[\n,，、;；]+/ } = {}) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(split);
  const out = [];
  for (const [i, x] of raw.entries()) {
    let s;
    try { s = text(x, { max: item }); } catch (e) { throw Error(raw.length > 1 ? `第 ${i + 1} 项「${String(x ?? '').replace(new RegExp(CTRL.source, 'g'), '').trim().slice(0, 20)}」${e.message}` : e.message); }
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > max) throw Error(`最多 ${max} 项`);
  return out;
}
const KINDS = {
  text: (v, f) => text(v, f),
  choice: (v, f) => text(v, f),
  month: v => text(v, { max: 40 }),
  email: v => { const s = text(v, { max: 120 }); if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw Error('邮箱格式不对'); return s; },
  phone: v => { const s = text(v, { max: 30 }); if (s && !/^\+?[\d\s()-]{6,}$/.test(s)) throw Error('只能有数字、空格和 + - ( )'); return s; },
  url: v => { const s = text(v, { max: 200 }); if (s && (/\s/.test(s) || (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)))) throw Error('要是 http(s) 链接'); return s; },
  int: (v, f) => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < f.min || n > f.max) throw Error(`要是 ${f.min}–${f.max} 的整数`); return n; },
  list: (v, f) => list(v, f),
  lines: (v, f) => list(v, { ...f, split: /\n+/ }),
  // 只能从选项里选（中英文名也认），存成键、按给的顺序、去重：方向的第一个是主方向。
  choices: (v, f) => {
    const out = [];
    for (const x of list(v, { item: 40, max: 50 })) {
      const k = optionKey(f, x);
      if (!k) throw Error(`「${x}」不在可选的里面（${Object.values(f.options).join('、')}）`);
      if (!out.includes(k)) out.push(k);
    }
    if (out.length > f.max) throw Error(`最多 ${f.max} 项`);
    // 方向必填（负责人 10-10）：不能存成空的（没方向一个推荐都不放，lib/recommend-gate.mjs directionSet）。
    if (f.min && out.length < f.min) throw Error(`至少选 ${f.min} 个`);
    return out;
  },
  pdf: v => { const s = text(v, { max: 200 }); if (!s) return ''; if (!/^candidate\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.pdf$/iu.test(s) || s.split('/').includes('..')) throw Error('只能指向 candidate/ 下的 PDF'); try { if (!fs.statSync(file(s)).isFile()) throw 0; } catch { throw Error(`${s} 不存在`); } return s; },
};
const isEmpty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
// 文件里的 400000（数）和页面上的 '400000'（字）算同一个值，不为这个改写文件。
const same = (a, b) => (isEmpty(a) && isEmpty(b)) || (a != null && b != null && typeof a !== 'object' && typeof b !== 'object' ? String(a) === String(b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
const check = (f, v, where) => { try { return KINDS[f.kind](v, f); } catch (e) { throw Error(`${where}：${e.message}`); } };

// ── 日期：文件里写「2019-07 至 2022-03」「2026-03 至今」，编辑器拆成开始 / 结束 ─────────────
const NOW = /^(至今|今|现在|present|now|current)$/i;
export function splitDates(s) {
  const t = String(s ?? '').trim();
  if (!t) return { start: '', end: '' };
  // 只有结束（「至 2026-05」：美国简历常只写 Expected May 2026）、或者只写了「至今」。
  if (NOW.test(t)) return { start: '', end: '至今' };
  const until = t.match(/^(?:至|~|～|–|—|-|(?:to|until)(?=\s))\s*(\S.*)$/i);
  if (until) return { start: '', end: NOW.test(until[1].trim()) ? '至今' : until[1].trim() };
  const cur = t.match(/^(.*?)\s*(?:至|~|～|–|—|-|to)?\s*(至今|present|now|current)$/i);
  if (cur && cur[1]) return { start: cur[1].trim(), end: '至今' };
  for (const sep of [/\s*至\s*/, /\s*[~～–—]\s*/, /\s+to\s+/i, /\s+-\s+/]) { const p = t.split(sep); if (p.length === 2 && p[0] && p[1]) return { start: p[0], end: p[1] }; }
  const y = t.match(/^(\d{4}(?:[./]\d{1,2})?)-(\d{4}(?:[./]\d{1,2})?)$/);
  return y ? { start: y[1], end: y[2] } : { start: t, end: '' };
}
export function joinDates(start, end) {
  const a = String(start ?? '').trim(), b = String(end ?? '').trim();
  if (!b) return a;
  if (NOW.test(b)) return a ? `${a} 至今` : '至今';
  // 没有开始只有结束：写成「至 2026-05」，读回来还是结束（只写「2026-05」会被当成开始）。
  return a ? `${a} 至 ${b}` : `至 ${b}`;
}
const toStr = v => v == null ? '' : typeof v === 'object' ? '' : String(v);
function rowFromFile(def, m) {
  const src = m && typeof m === 'object' && !Array.isArray(m) ? m : { [def.file[def.title]]: toStr(m) };
  const out = {};
  for (const [k, fk] of Object.entries(def.file)) {
    if (fk === 'dates') out[k] = splitDates(src.dates)[k];
    else if (def.fields[k].kind === 'lines') out[k] = Array.isArray(src[fk]) ? src[fk].map(toStr).filter(Boolean) : src[fk] ? [toStr(src[fk])] : [];
    else out[k] = toStr(src[fk]);
  }
  return out;
}
// 编辑器一行 → 文件里的键值（只给出这次要写的键）。
function rowToFile(def, r, keys = Object.values(def.file)) {
  const out = {};
  for (const [k, fk] of Object.entries(def.file)) if (keys.includes(fk)) out[fk] = fk === 'dates' ? joinDates(r.start, r.end) : r[k];
  return out;
}

// ── 读 ──────────────────────────────────────────────────────────────────────
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
// 资料文件读不了（YAML 写坏了、顶层不是字段表）时给你看的那句（主会话 10-03，和资料横条一个口径）：不出现文件名，不叫你手动修。
// 编辑器、选方向、导入简历照常能用：从空的开始填，保存时先把读不了的那份留一份旧版（backupCandidate），再写新的。
export const BROKEN_TEXT = '资料文件读不了：重新导入简历，或者到设置 → 资料重新填；原来那份会留一份旧版。';
function loadDoc() {
  let src = null;
  try { src = fs.readFileSync(file(FACTS), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (src == null) { const doc = new YAML.Document({}); doc.commentBefore = HEADER; return { doc, src: null, sig: 'missing' }; }
  const doc = YAML.parseDocument(src);
  if (doc.errors.length || (doc.contents != null && !YAML.isMap(doc.contents))) { const fresh = new YAML.Document({}); fresh.commentBefore = HEADER; return { doc: fresh, src, sig: sha(src), broken: true }; }
  return { doc, src, sig: sha(src) };
}
export const factsSig = () => { try { return sha(fs.readFileSync(file(FACTS), 'utf8')); } catch { return 'missing'; } };
const getPath = (o, keys) => keys.reduce((x, k) => (x == null ? undefined : x[k]), o);
export function currentFacts() {
  try { const { doc, sig, src, broken } = loadDoc(); return { data: doc.toJS() || {}, sig, exists: src != null, error: broken ? BROKEN_TEXT : null, ...(broken ? { broken: true } : {}) }; }
  catch (e) { return { data: {}, sig: factsSig(), exists: true, error: e.message }; }
}
const structured = v => v != null && typeof v === 'object' && (!Array.isArray(v) || v.some(x => x !== null && typeof x === 'object'));
// 手写的方向可能是一行字（「金融、数据分析」）：和 lib/directions.mjs 一样按逗号、顿号拆。
const rawList = v => Array.isArray(v) ? v.map(toStr).filter(Boolean) : v == null || v === '' ? [] : String(v).split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean);
const viewValue = (f, v) => {
  if (structured(v)) return { value: f.kind === 'list' || f.kind === 'lines' || f.kind === 'choices' ? [] : '', complex: true };
  if (f.kind === 'list' || f.kind === 'lines') return { value: Array.isArray(v) ? v.map(toStr).filter(Boolean) : v == null || v === '' ? [] : [toStr(v)] };
  // 选项列表显示成键；认不出的写法单列出来（页面说一句，保存时换成选的）。
  if (f.kind === 'choices') { const raw = rawList(v); return { value: [...new Set(raw.map(x => optionKey(f, x)).filter(Boolean))], unknown: raw.filter(x => !optionKey(f, x)) }; }
  if (f.kind === 'int') return { value: v == null || v === '' ? null : v };
  return { value: Array.isArray(v) ? v.map(toStr).join('、') : toStr(v), ...(Array.isArray(v) ? { complex: true } : {}) };
};
// 字段在文件里的值；有旧写法（alias）的两处合起来读。
const fileValue = (data, p, f) => { const v = getPath(data, p.split('.')); if (!f.alias) return v; const old = getPath(data, f.alias.split('.')); return old == null || old === '' ? v : [...rawList(v), ...rawList(old)]; };
// 「你的方向」弹窗要的：每个方向的中英文名、一句简介、细分（都取 lib/directions.mjs），和文件里现在写的。
// summary 只在认得出方向时有（「金融（投行、资管 / 投研）」）；没写方向的老资料按软件处理，由页面说明。
export function directionCatalog(data = {}) {
  const f = PROFILE_FIELDS['preferences.directions'], raw = rawList(fileValue(data, 'preferences.directions', f));
  const unknown = raw.filter(x => !optionKey(f, x));
  // 文件里混着查出原型的写法时，注册表自己的读法会出错：这时不给摘要，页面照「认不出」说。
  let summary = null;
  if (unknown.length < raw.length) { try { summary = { zh: directionSummary(data, 'zh'), en: directionSummary(data, 'en') }; } catch {} } // 兜底：方向说不出摘要就不带摘要
  return {
    written: raw.length > 0,
    summary,
    unknown,
    options: Object.entries(DIRECTIONS).map(([key, d]) => ({ key, zh: d.zh, en: d.en, blurb: d.blurb, tracks: Object.entries(d.tracks || {}).map(([k, t]) => ({ key: k, zh: t.zh, en: t.en })) })),
  };
}
export function profileView() {
  const { data, sig, exists, error, broken } = currentFacts();
  const fields = {};
  for (const [p, f] of Object.entries(PROFILE_FIELDS)) {
    if (f.hidden) continue;
    fields[p] = { label: f.label, kind: f.kind, group: f.group, ...(f.options ? { options: f.options } : {}), ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.picker ? { picker: f.picker } : {}), ...viewValue(f, fileValue(data, p, f)) };
  }
  const items = editorRows(data);
  const rows = Object.fromEntries(Object.entries(PROFILE_ROWS).map(([k, def]) => [k, { label: def.label, title: def.title, max: def.max, fields: Object.fromEntries(Object.entries(def.fields).map(([fk, f]) => [fk, { label: f.label, kind: f.kind, ...(f.placeholder ? { placeholder: f.placeholder } : {}) }])), items: items[k] }]));
  // 读不了的资料：不当成打不开，给一张空表让你重新填（broken 是给你看的那句），保存时旧的留一份。
  return { file: FACTS, exists, sig, error: broken ? null : error, ...(broken ? { broken: BROKEN_TEXT } : {}), groups: PROFILE_GROUPS, fields, rows, directions: directionCatalog(data), backups: recentBackups() };
}
// 文件里的教育 / 经历 → 编辑器的行（带 i = 文件里的位置）。
export function editorRows(data = {}) {
  return Object.fromEntries(Object.entries(PROFILE_ROWS).map(([k, def]) => { const raw = getPath(data, def.path); return [k, Array.isArray(raw) ? raw.map((m, i) => ({ i, ...rowFromFile(def, m) })) : []]; }));
}
function recentBackups() {
  try { return fs.readdirSync(file('candidate')).filter(n => /^backup-\d{8}-\d{6}/.test(n) && fs.existsSync(file(`candidate/${n}/facts.yaml`))).sort().slice(-5).map(n => `candidate/${n}/facts.yaml`); } catch { return []; } // 兜底：还没有资料目录就没有备份
}

// ── 写 ──────────────────────────────────────────────────────────────────────
const stampOf = now => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(/\D/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
// 把 candidate/ 下的几个文件复制进同一个 candidate/backup-<时间>/（同一秒再存一次就加 -2、-3）。
export function backupCandidate(rels, now = Date.now()) {
  const stamp = stampOf(now);
  let dir = `candidate/backup-${stamp}`;
  for (let n = 2; fs.existsSync(file(dir)); n++) dir = `candidate/backup-${stamp}-${n}`;
  const copied = [];
  for (const rel of rels) {
    if (!fs.existsSync(file(rel))) continue;
    fs.mkdirSync(file(dir), { recursive: true });
    const dest = `${dir}/${path.basename(rel)}`;
    fs.copyFileSync(file(rel), file(dest), fs.constants.COPYFILE_EXCL);
    copied.push(dest);
  }
  return copied;
}
// 在一个集合（文档或某一行）里改一个值：原来是标量就只换值（注释、引号跟着节点留下），
// 原来是列表就尽量复用原来的元素节点（元素上的注释也留下），其它情况换新节点并挪走注释。
function assign(doc, coll, keys, v, where) {
  const prev = coll.getIn(keys, true);
  if (prev === undefined && isEmpty(v)) return false;
  const before = YAML.isNode(prev) ? prev.toJSON() : prev;
  if (same(before, v)) return false;
  if (YAML.isMap(prev)) throw Error(`${where}：facts.yaml 里这一项是一组字段，不能在这里改，请手改文件`);
  if (YAML.isSeq(prev) && prev.items.some(n => !YAML.isScalar(n))) throw Error(`${where}：facts.yaml 里这一项是结构化的列表，不能在这里改，请手改文件`);
  if (YAML.isScalar(prev) && !Array.isArray(v)) prev.value = v;
  else if (YAML.isSeq(prev) && Array.isArray(v)) prev.items = v.map(x => prev.items.find(n => String(n.value) === String(x)) || doc.createNode(x));
  else if (YAML.isNode(prev)) { const node = doc.createNode(v); Object.assign(node, { comment: prev.comment, commentBefore: prev.commentBefore, spaceBefore: prev.spaceBefore }); coll.setIn(keys, node); }
  else { ensureParents(doc, coll, keys); try { coll.setIn(keys, v); } catch { throw Error(`${where}：facts.yaml 里上一级不是字段表，请手改文件`); } }
  return true;
}
const blankNode = n => n === null || (YAML.isScalar(n) && (n.value == null || n.value === ''));
// 上一级空着（`current_work:` 后面什么都没写）：先换成一张空表，注释留下。
function ensureParents(doc, coll, keys) {
  for (let n = 1; n < keys.length; n++) {
    const p = keys.slice(0, n), node = coll.getIn(p, true);
    if (node === undefined) return;
    if (blankNode(node)) { const map = doc.createNode({}); if (YAML.isNode(node)) Object.assign(map, { comment: node.comment, commentBefore: node.commentBefore, spaceBefore: node.spaceBefore }); coll.setIn(p, map); }
  }
}
// 行的校验放在读文件之后：新行整行校验；已有的行只校验改过的字段，其余照文件原样。
function prepareRows(doc, def, list) {
  let seq = doc.getIn(def.path, true);
  if (blankNode(seq)) seq = undefined; // `education:` 空着 = 还没有
  if (seq !== undefined && !YAML.isSeq(seq)) throw Error(`${def.label}：facts.yaml 里 ${def.path.join('.')} 不是列表，请手改文件`);
  const old = seq?.items || [];
  const rows = list.map((r, n) => {
    const where = `${def.label}第 ${n + 1} 行`;
    if (r.i == null) {
      const row = Object.fromEntries(Object.entries(def.fields).map(([k, f]) => [k, check(f, r[k], `${where} ${f.label}`)]));
      if (!row[def.title]) throw Error(`${where}：${def.fields[def.title].label}不能空`);
      return { row };
    }
    const node = old[r.i];
    if (node === undefined) throw Object.assign(Error(`${where}对不上文件（文件刚改过？请刷新后再改）`), { status: 409 });
    const cur = rowFromFile(def, YAML.isNode(node) ? node.toJSON() : node), row = { ...cur };
    const changed = Object.keys(def.fields).filter(k => Object.hasOwn(r, k) && !same(cur[k], r[k]));
    for (const k of changed) row[k] = check(def.fields[k], r[k], `${where} ${def.fields[k].label}`);
    if (changed.includes(def.title) && !row[def.title]) throw Error(`${where}：${def.fields[def.title].label}不能空`);
    return { i: r.i, node, row, keys: [...new Set(changed.filter(k => !same(cur[k], row[k])).map(k => def.file[k]))] };
  });
  return { seq, old, rows };
}
function applyRows(doc, def, { seq, old, rows }) {
  const changes = [], used = new Set();
  const fresh = row => doc.createNode(Object.fromEntries(Object.entries(rowToFile(def, row)).filter(([, v]) => !isEmpty(v))));
  const next = rows.map(({ i, node, row, keys }, n) => {
    const name = row[def.title];
    if (i == null) { changes.push({ path: def.path.join('.'), label: `${def.label}：新增「${name}」` }); return fresh(row); }
    used.add(i);
    if (!keys.length) return node;
    changes.push({ path: `${def.path.join('.')}[${i}]`, label: `${def.label}：改「${name}」的 ${keys.map(k => Object.entries(def.file).filter(([, fk]) => fk === k).map(([ek]) => def.fields[ek].label).join('/')).join('、')}` });
    if (!YAML.isMap(node)) return fresh(row);
    for (const [fk, v] of Object.entries(rowToFile(def, row, keys))) assign(doc, node, [fk], v, `${def.label}第 ${n + 1} 行`);
    return node;
  });
  old.forEach((node, i) => { if (!used.has(i)) changes.push({ path: `${def.path.join('.')}[${i}]`, label: `${def.label}：删除「${rowFromFile(def, YAML.isNode(node) ? node.toJSON() : node)[def.title]}」` }); });
  if (!changes.length && next.length === old.length && next.every((node, i) => node === old[i])) return [];
  if (!changes.length) changes.push({ path: def.path.join('.'), label: `${def.label}：调整顺序` });
  if (!seq) { if (!next.length) return []; ensureParents(doc, doc, def.path); doc.setIn(def.path, doc.createNode([])); seq = doc.getIn(def.path, true); }
  seq.items = next;
  return changes;
}
function checkRowShape(def, r, n) {
  const where = `${def.label}第 ${n + 1} 行`;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error(`${where}格式不对`);
  for (const k of Object.keys(r)) if (k !== 'i' && !Object.hasOwn(def.fields, k)) throw Error(`${where}：不允许的字段 ${k}`);
  if (r.i != null && (!Number.isInteger(r.i) || r.i < 0)) throw Error(`${where}：行号不对`);
}

// 换工作（现职的公司换了，简历导入或资料编辑都走这里）：原来的现职整段挪进工作经历（职位、起止、焦点和职责当证据），
// 现职重新开始，只留新公司和这次一起填的职位 / 入职。旧的职位、日期、职责不能挂在新公司下面——判断层会拿
// current_work 的职责当「现职」证据（2026-09-29 本人决定）。同一家公司改职位不算换工作。
const sameCompany = (a, b) => String(a || '').replace(/\s+/g, '').toLowerCase() === String(b || '').replace(/\s+/g, '').toLowerCase();
function switchJob(doc, values, now, old) {
  const node = doc.getIn(['current_work'], true), company = values['current_work.company'];
  if (!old?.company || typeof company !== 'string' || !company || sameCompany(company, old.company)) return [];
  const end = values['current_work.start'] || new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(now);
  const evidence = [old.focus, ...(Array.isArray(old.responsibilities) ? old.responsibilities : [old.responsibilities])].filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  const row = { company: old.company, ...(old.title ? { role: old.title } : {}), ...(old.start ? { dates: `${old.start} 至 ${end}` } : {}), ...(evidence.length ? { evidence } : {}) };
  let seq = doc.getIn(['career_highlights', 'entries'], true);
  if (blankNode(seq) || seq === undefined) { ensureParents(doc, doc, ['career_highlights', 'entries']); doc.setIn(['career_highlights', 'entries'], doc.createNode([])); seq = doc.getIn(['career_highlights', 'entries'], true); }
  if (!YAML.isSeq(seq)) throw Error('工作经历：facts.yaml 里 career_highlights.entries 不是列表，请手改文件');
  const already = seq.items.some(n => { const e = YAML.isNode(n) ? n.toJSON() : n; return sameCompany(e?.company, old.company) && (!old.start || String(e?.dates || '').startsWith(String(old.start))); });
  if (!already) seq.items.push(doc.createNode(row));
  const fresh = doc.createNode(Object.fromEntries([['company', company], ['title', values['current_work.title']], ['start', values['current_work.start']]].filter(([, v]) => !isEmpty(v))));
  Object.assign(fresh, { comment: node.comment, commentBefore: node.commentBefore, spaceBefore: node.spaceBefore });
  doc.setIn(['current_work'], fresh);
  return [{ path: 'current_work', label: `现职：换成「${company}」，原来的「${old.company}」${already ? '（工作经历里已经有）' : '挪进工作经历'}`, from: old.company, to: company }];
}
// 保存：set = { 路径: 值 }，rows = { education: [...], experience: [...] }（整张表）。
// 先整份校验，再核对版本，再改文档；有改动才备份和写。files 给内部调用（导入简历时的文字版）用：
// 和 facts.yaml 一起备份、一起写，HTTP 路由不传。
export function saveProfile({ base = null, set = {}, rows = {} } = {}, { now = Date.now(), files = [], source = '开始使用' } = {}) {
  if (!set || typeof set !== 'object' || Array.isArray(set) || !rows || typeof rows !== 'object' || Array.isArray(rows)) throw Error('格式不对');
  const values = {};
  for (const [p, v] of Object.entries(set)) { if (!Object.hasOwn(PROFILE_FIELDS, p)) throw Error(`不允许改 ${p}`); const f = PROFILE_FIELDS[p]; values[p] = check(f, v, f.label); if (p === 'location.current_city') values[p] = cityName(values[p]); if (p === 'location.target_cities') values[p] = cityNames(values[p]); }
  for (const [k, list] of Object.entries(rows)) {
    if (!Object.hasOwn(PROFILE_ROWS, k)) throw Error(`不允许改 ${k}`);
    const def = PROFILE_ROWS[k];
    if (!Array.isArray(list)) throw Error(`${def.label}要是一张表`);
    if (list.length > def.max) throw Error(`${def.label}最多 ${def.max} 条`);
    list.forEach((r, n) => checkRowShape(def, r, n));
    const seen = list.filter(r => r.i != null).map(r => r.i);
    if (new Set(seen).size !== seen.length) throw Error(`${def.label}有重复的行`);
  }
  const { doc, src, sig } = loadDoc();
  if (base == null && Object.values(rows).some(l => l.some(r => r.i != null))) throw Error('缺少读取时的版本（base），请刷新后再改');
  if (base != null && base !== sig) throw Object.assign(Error('个人资料刚在别处改过（另一个页面或脚本），请刷新后再改'), { status: 409 });
  const prepared = Object.fromEntries(Object.entries(rows).map(([k, list]) => [k, prepareRows(doc, PROFILE_ROWS[k], list)]));
  const changes = [], priorJob = (n => YAML.isMap(n) ? n.toJSON() : null)(doc.getIn(['current_work'], true)); // 改之前的现职（换工作要用）
  for (const [p, v] of Object.entries(values)) { const keys = p.split('.'), prev = doc.getIn(keys, true), before = YAML.isNode(prev) ? prev.toJSON() : prev; if (assign(doc, doc, keys, v, PROFILE_FIELDS[p].label)) changes.push({ path: p, label: PROFILE_FIELDS[p].label, from: before ?? null, to: v }); }
  // 旧写法（preferences.direction）：页面显示的是两处合起来的值，保存新写法时就并进来；留着会和新选的混在一起。
  for (const p of Object.keys(values)) {
    const alias = PROFILE_FIELDS[p].alias?.split('.');
    if (!alias || doc.getIn(alias, true) === undefined) continue;
    try { doc.deleteIn(alias); } catch { throw Error(`${PROFILE_FIELDS[p].label}：facts.yaml 里 ${alias.join('.')} 删不掉，请手改文件`); }
    changes.push({ path: alias.join('.'), label: `${PROFILE_FIELDS[p].label}：旧写法 ${alias.join('.')} 并进 ${p}` });
  }
  for (const [k, prep] of Object.entries(prepared)) changes.push(...applyRows(doc, PROFILE_ROWS[k], prep));
  changes.push(...switchJob(doc, values, now, priorJob));
  if (!changes.length && !files.length) return { status: 'unchanged', changes: [], sig };
  const copied = backupCandidate([...(src != null && changes.length ? [FACTS] : []), ...files.map(f => f.rel)], now);
  if (changes.length) { write(FACTS, doc.toString()); forgetFacts(); }
  for (const f of files) write(f.rel, f.text);
  const backup = copied.find(p => p.endsWith('/facts.yaml')) || null;
  // 备份在哪不写进句子（路径会被运行日志当内部 id 删掉，剩「旧版备份在 /」，10-02 开箱第 2 轮 N09）；refs 里照旧带着文件。
  event('user', 'setup', 'ok', `${source}：保存个人资料 ${changes.length} 项${files.length ? `，写 ${files.map(f => f.rel).join('、')}` : ''}${copied.length ? '（旧版已备份）' : ''}`, { refs: copied.map(p => ({ file: p })) });
  const cityReview = changes.some(c => ['location.target_cities', 'location.work_mode_preference'].includes(c.path)) ? recheckCityDrafts({ dryRun: false, source, now }) : null;
  return { status: 'saved', changes, files: files.map(f => f.rel), backup, backups: copied, sig: factsSig(), ...(cityReview ? { city_pauses: cityReview } : {}) };
}
