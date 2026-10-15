// Radar 的招聘源：config/companies.yaml 里的每一家公司，加上最近一次扫描读到了什么（state/discovery-sources.json）。
// 2026-10-01 开箱测试 #16：源的列表藏在折叠里、最多 6 行，而且没有核实过的一律算坏；也没法单独加、删、改一家，
// 没法从 Radar 的页面交给它一个链接。
//
//   sourcesView()                     每一家：名字、招聘系统、招聘页、现在怎样（lib/discovery-source.mjs sourceState）
//   addSource({ name, url })          加一家：从招聘页链接认出招聘系统和板名（Greenhouse、Lever、Ashby、SmartRecruiters）
//   updateSource({ name, set })       改名、换链接、暂停（paused: 原因）/ 恢复（paused: false）
//   removeSource({ name })            删一家
//   改名、换链接、删除时，上一次扫描报告（state/discovery-sources.json）里这一家的那一行跟着改（QA 第 2 轮 #9：删掉的源还留在
//   列表里照样标红，改了名新旧各占一行——清单写对了，列表却还读着报告里的旧行）。
//   giveLink({ url })                 「交给 Radar 一个链接」：招聘板的首页 → 加成招聘源；一个岗位的链接 → 收录并核验（任务板的卡）
//
// 写 config/companies.yaml 时拿状态写锁（lib/lock.mjs，和 bin/discover.mjs 回写健康字段同一把），在文件现在的文本上改
// （YAML 文档：注释、别的字段、扫描中新加的公司都留着），用 lib/store.mjs 的 write（先写临时文件再改名）。
// 本机还没有这份文件时从示例开始（和「开始使用」加公司包同一个做法），不让正在扫的公司消失。
import YAML from 'yaml';
import fs from 'node:fs';
import { read, write, file, configSource } from './store.mjs';
import { event } from './events.mjs';
import { sourceState } from './discovery-source.mjs';
import { planTalk, startGoal } from './card-ops.mjs';
import { noteSwallowed } from './swallow.mjs';
import { addSourceContact, removeSourceContact } from './source-contacts.mjs';

const COMPANIES = 'config/companies.yaml';
const REPORT = 'state/discovery-sources.json';
// 招聘系统的名字（页面上显示）。lib/ats/ 里每个适配器都要在这里有一个名字，tests/sources-ats-labels.test.mjs 盯着。
export const ATS_LABEL = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workday: 'Workday', larkhire: '飞书招聘', moka: 'Moka', beisen: '北森', hotjob: '大易', oracle: 'Oracle', oleeo: 'Oleeo', tencent: '腾讯招聘', netease: '网易招聘', alitalent: '阿里招聘', microsoft: 'Microsoft', getui: '个推', publiccareers: '官网', cn: '官网', generic: '官网（要浏览器读）' };
const fail = (status, message) => Object.assign(Error(message), { status });
const str = x => String(x ?? '').trim();
const keyName = s => str(s).normalize('NFKC').toLowerCase().replace(/[\s·.,，()（）-]+/g, '');

// 招聘板首页的链接 → { ats, board }；认不出、或者是一个具体岗位的链接，返回 null（岗位链接见 postingLike）。
export function boardRef(url) {
  let u;
  try { u = new URL(str(url)); } catch { return null; } // 兜底：写得不像网址就不认
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase(), parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [board, more] = parts;
  if (!board) return null;
  if (/^jobs\.(eu\.)?lever\.co$/.test(host)) return more ? null : { ats: 'lever', board };
  if (host === 'jobs.ashbyhq.com') return more ? null : { ats: 'ashby', board };
  if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) return more ? null : { ats: 'greenhouse', board };
  if (/^(?:careers|jobs)\.smartrecruiters\.com$/.test(host)) return more ? null : { ats: 'smartrecruiters', board };
  return null;
}
const boardUrl = r => ({ lever: `https://jobs.lever.co/${r.board}`, ashby: `https://jobs.ashbyhq.com/${r.board}`, greenhouse: `https://job-boards.greenhouse.io/${r.board}`, smartrecruiters: `https://careers.smartrecruiters.com/${r.board}` }[r.ats]);
const nameFromBoard = b => str(b).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function companiesDoc() {
  const rel = configSource(COMPANIES);
  const doc = YAML.parseDocument(rel ? fs.readFileSync(file(rel), 'utf8') : '[]\n');
  if (doc.errors.length) throw fail(400, `config/companies.yaml 读不出来（${doc.errors[0].message.split('\n')[0]}），先手动修好`);
  if (doc.contents == null) doc.contents = doc.createNode([]);
  if (!YAML.isSeq(doc.contents)) throw fail(400, 'config/companies.yaml 不是一张公司列表，先手动修好');
  return doc;
}
const entries = doc => doc.contents.items.filter(YAML.isMap);
const findEntry = (doc, name) => entries(doc).find(n => keyName(n.get('name')) === keyName(name));
// 扫描报告里这一家的那一行：fix(row) 返回新的一行，返回 null 就拿掉。报告的 sources 是数组（老的是按名字的对象），两种都认。
function fixReport(name, fix) {
  const rep = read(REPORT, null);
  if (!rep || typeof rep !== 'object' || !rep.sources || typeof rep.sources !== 'object') return;
  const k = keyName(name), hit = r => r && typeof r === 'object' && keyName(r.company) === k;
  let changed = false;
  const one = r => { if (!hit(r)) return r; changed = true; return fix(r); };
  const sources = Array.isArray(rep.sources) ? rep.sources.map(one).filter(Boolean) : Object.fromEntries(Object.entries(rep.sources).map(([key, r]) => [key, one(r)]).filter(([, r]) => r));
  if (changed) write(REPORT, { ...rep, sources });
}
// 拿锁、读、改、写回；改的函数返回这次的回执。扫描报告和清单在同一把锁里改（bin/discover.mjs 写报告也拿这把）。
async function edit(change) {
  const doc = companiesDoc(), report = [];
  const out = change(doc, (name, fix) => report.push([name, fix]));
  write(COMPANIES, doc.toString());
  for (const [name, fix] of report) fixReport(name, fix);
  return out;
}

// ── 列出 ──────────────────────────────────────────────────────────────────
export function sourcesView({ now = Date.now() } = {}) {
  let items = [];
  try { items = entries(companiesDoc()).map(n => n.toJSON()); } catch (e) { noteSwallowed('sources.companies', e, { member: 'scout', doing: '读公司清单', then: '这次当一家都没有' }); items = []; }
  const report = read('state/discovery-sources.json', {}) || {};
  const rows = Array.isArray(report.sources) ? report.sources : Object.values(report.sources || {});
  const byName = new Map(rows.filter(r => r && typeof r === 'object' && r.company).map(r => [keyName(r.company), r]));
  const list = items.filter(c => str(c.name)).map(c => {
    const r = byName.get(keyName(c.name));
    // 这一轮扫到了：用报告里的这一行（带这次的原因）；没扫到（重试没到期、暂停）：用 companies.yaml 里记着的。
    const st = sourceState(c.paused ? c : r ? { ...r, last_error: r.error || r.reason || c.last_error, verification_error: c.verification_error, city_count: r.city_count ?? c.city_count } : c);
    // 上次读它（或核对它）的时间：读到了岗位、读失败了、核对招聘页，取最近的一次。
    const times = [r?.checked_at, c.verified_at, c.last_error_at, c.careers_checked_at].filter(t => Number.isFinite(Date.parse(t)));
    const at = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    return {
      name: str(c.name), ats: c.ats_type || null, ats_label: ATS_LABEL[c.ats_type] || c.ats_type || '', url: c.careers_url || null, board: c.board || null,
      preset: c.preset || null, paused: c.paused || false, count: r?.count ?? c.job_count ?? null, state: st.state, bad: st.bad, text: st.text, reason: st.reason, at, editable: true,
    };
  });
  // 扫过、但不在清单里的：只列 --wide 读的存档公司（报告里带 wide_source），只是不能在这里改。
  // 别的（删掉的、改名前的旧名字、手改清单拿掉的）是报告里的旧行，不列（QA 第 2 轮 #9）。清单本身读不到时照旧全列。
  const listed = new Set(list.map(x => keyName(x.name)));
  // 清单本身读不到（还没有这份文件）时，报告里的每一行都列。
  for (const r of rows) if (r?.company && (r.wide_source || !items.length) && !listed.has(keyName(r.company))) {
    const st = sourceState(r);
    list.push({ name: str(r.company), ats: null, ats_label: '', url: null, board: null, preset: null, paused: false, count: r.count ?? null, state: st.state, bad: st.bad, text: st.text, reason: st.reason, at: r.checked_at || report.at || null, editable: false });
  }
  const rank = { broken: 0, failing: 1, new: 2, held: 3, quiet: 4, unconfirmed: 5, ok: 6, paused: 7 };
  list.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name, 'zh'));
  return { sources: list, total: list.length, broken: list.filter(s => s.bad).length, unconfirmed: list.filter(s => s.state === 'unconfirmed').length, quiet: list.filter(s => s.state === 'quiet').length, held: list.filter(s => s.state === 'held').length, at: report.at || null };
}

// ── 加、改、删 ────────────────────────────────────────────────────────────
export async function addSource({ name, url } = {}) {
  const ref = boardRef(url);
  if (!ref) throw fail(400, '认不出这个招聘页：现在能直接读 Greenhouse、Lever、Ashby、SmartRecruiters 的招聘板首页');
  const n = str(name) || nameFromBoard(ref.board);
  if (n.length > 60) throw fail(400, '公司名太长了');
  return edit(doc => {
    if (findEntry(doc, n)) throw fail(409, `「${n}」已经在招聘源里了`);
    const same = entries(doc).find(e => e.get('ats_type') === ref.ats && str(e.get('board')).toLowerCase() === ref.board.toLowerCase());
    if (same) throw fail(409, `这个招聘板已经是「${same.get('name')}」了`);
    doc.contents.items.push(doc.createNode({ name: n, ats_type: ref.ats, board: ref.board, careers_url: boardUrl(ref) }));
    event('user', 'sources', 'ok', `招聘源：加了 ${n}（${ATS_LABEL[ref.ats]}）`);
    return { ok: true, name: n, ats: ref.ats, receipt: `加好了：${n}。下一次扫描官方源会读它` };
  });
}
// 清单里每一家的原样（带扫描写回的健康字段：consecutive_failures、last_error……）：System 的标准做法 P2 看连续几轮没读到。
export function sourceEntries() {
  try { return entries(companiesDoc()).map(n => n.toJSON()).filter(c => str(c.name)); } catch (e) { noteSwallowed('sources.companies', e, { member: 'scout', doing: '读公司清单', then: '这次当一家都没有' }); return []; }
}
// by：谁改的（运行日志那一行的 actor），System 的标准做法传 'system'。
// set.retest：恢复时让下一轮扫描马上再读一次（没读通过的源平时按退避的时间才重试，lib/discovery-source.mjs selectSources）。
export async function updateSource({ name, set = {}, by = 'user', now = Date.now() } = {}) {
  if (!str(name)) throw fail(400, '要改哪一家？');
  return edit((doc, report) => {
    const e = findEntry(doc, name);
    if (!e) throw fail(404, `招聘源里没有「${str(name)}」`);
    const was = str(e.get('name')), done = [];
    if (set.name != null && str(set.name) && keyName(set.name) !== keyName(e.get('name'))) {
      const n = str(set.name);
      if (n.length > 60) throw fail(400, '公司名太长了');
      if (findEntry(doc, n)) throw fail(409, `「${n}」已经在招聘源里了`);
      e.set('name', n); done.push(`改名为 ${n}`);
      report(was, r => ({ ...r, company: n }));
    }
    if (set.url != null && str(set.url)) {
      const ref = boardRef(set.url);
      if (!ref) throw fail(400, '认不出这个招聘页：现在能直接读 Greenhouse、Lever、Ashby、SmartRecruiters 的招聘板首页');
      e.set('ats_type', ref.ats); e.set('board', ref.board); e.set('careers_url', boardUrl(ref));
      // 换了地方：上一个板子的读取记录不再算数，下一轮当新加的读。
      for (const k of ['status', 'job_count', 'city_count', 'http_status', 'verified_at', 'retry_at', 'last_error', 'last_error_at', 'consecutive_failures', 'failing_since', 'error', 'verification_error', 'careers_http_status', 'careers_checked_at']) e.delete(k);
      report(str(e.get('name')), () => null);
      done.push('换了招聘页');
    }
    if (set.paused !== undefined) {
      if (set.paused === false || set.paused === null) { if (e.has('paused')) { e.delete('paused'); done.push('恢复扫描'); } }
      else { e.set('paused', str(set.paused).slice(0, 60) || '你暂停的'); done.push('暂停扫描'); }
    }
    if (set.retest && e.get('retry_at')) e.set('retry_at', new Date(now).toISOString());
    if (!done.length) return { ok: true, name: str(e.get('name')), receipt: '没有要改的' };
    event(by, 'sources', 'ok', `招聘源：${was} ${done.join('、')}`);
    // 回执用改之前的名字开头（「Fabrikam：改名为 Fabrikam Labs」，不是新名字说两遍，QA 第 2 轮 #17）。
    return { ok: true, name: str(e.get('name')), receipt: `${was}：${done.join('、')}` };
  });
}
export async function removeSource({ name } = {}) {
  if (!str(name)) throw fail(400, '要删哪一家？');
  return edit((doc, report) => {
    const e = findEntry(doc, name);
    if (!e) throw fail(404, `招聘源里没有「${str(name)}」`);
    doc.contents.items = doc.contents.items.filter(x => x !== e);
    report(str(e.get('name')), () => null);
    event('user', 'sources', 'ok', `招聘源：删了 ${str(e.get('name'))}`);
    return { ok: true, name: str(e.get('name')), receipt: `删了 ${str(e.get('name'))}，以后不再扫它；已经收下的岗位还在` };
  });
}

// ── 交给 Radar 一个链接 ────────────────────────────────────────────────────
// 招聘板首页 → 加成招聘源；别的链接（一个岗位、一篇招聘帖）→ 开一张「收录并核验」的卡，和在对话里对 Radar 贴链接同一条路。
export async function giveLink({ url, name = '' } = {}, { start = startGoal } = {}) {
  const u = str(url);
  if (!/^https?:\/\/\S+$/.test(u)) throw fail(400, '要一个 http 开头的链接');
  if (boardRef(u)) return { kind: 'source', ...(await addSource({ name, url: u })) };
  const plan = planTalk(u, { member: 'scout' });
  if (!plan || plan.type !== 'intake') throw fail(400, '要一个 http 开头的链接');
  const { card } = start(plan, { origin: { member: 'scout' }, text: u, single: true });
  event('user', 'sources', 'ok', `交给 Radar 收录：${u.slice(0, 120)}`);
  return { ok: true, kind: 'intake', card: card?.id || null, receipt: '交给 Radar 了：收录并核验这个岗位，结果在任务里' };
}

// POST /api/sources { action: add | update | remove | link | contact_add | contact_remove, ... }
export async function sourcesPost(body = {}) {
  const a = str(body.action);
  if (a === 'contact_add') return addSourceContact(body);
  if (a === 'contact_remove') return removeSourceContact(body);
  if (a === 'add') return addSource({ name: body.name, url: body.url });
  if (a === 'update') return updateSource({ name: body.name, set: body.set && typeof body.set === 'object' ? body.set : {} });
  if (a === 'remove') return removeSource({ name: body.name });
  if (a === 'link') return giveLink({ url: body.url, name: body.name });
  throw fail(400, '未知的操作');
}
