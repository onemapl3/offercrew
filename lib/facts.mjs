// candidate/facts.yaml 里「本人是谁」的部分，给代码用的共用读法：姓名、系统收发邮件的 Gmail、
// 简历文件、学校和前雇主的叫法、对外短消息里的固定几句。以前这些写死在各个模块里（lib/gmail.mjs 的
// 邮箱、bin/reach.mjs 的简历文件名、lib/referrers.mjs 的学校……），换一个人用就得改代码；现在只改
// facts.yaml。迁移时核对过：由 facts.yaml 推出的值与改动之前写死的常量逐字相同。
//
// 读不到或解析失败给 {}，派生值为空：由调用方决定怎么办（邮箱为空时 assertMailbox 一律拒绝；
// 短消息缺哪句就不写哪句），绝不在 import 时抛错，也绝不编。
// 但 {} 不再是悄悄的：readFacts / currentFacts 给的对象都带着 [FACTS_HEALTH]（不可枚举，序列化、展开都不带），
// 说明这份资料是 ok、missing 还是 broken；factsHealth() 直接给这一项。判断、写信、填表、周期的入口看它停下
// （lib/facts-gate.mjs，2026-10-03 兜底清单 G02），不对着空候选人干活。
// 只依赖 node 自带模块和 yaml：lib/city.mjs 也用它，不能引出 import 环。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const FACTS_PATH = 'candidate/facts.yaml';
const root = process.env.RADAR_ROOT || fileURLToPath(new URL('../', import.meta.url));
// RADAR_FACTS 指向另一份 facts 文件：测试读固定的虚构候选人（tests/fixtures/facts.yaml），结果不随本机
// 的 candidate/facts.yaml 变。设置页（lib/settings.mjs）编辑的始终是 candidate/facts.yaml 本身。
export const factsPath = () => process.env.RADAR_FACTS || path.join(root, FACTS_PATH);

// 资料文件现在怎么样：ok（能读、顶层是「名字: 内容」，内容多少不论，空文件也算）、missing（没有这个文件）、
// broken（打不开、YAML 解析失败、顶层是列表或一句话）。reason 是给人看的短话：文件名，能定位就带行号。
export const FACTS_HEALTH = Symbol('facts-health');
function load() {
  const p = factsPath(), name = path.basename(p), broken = (reason) => ({ facts: {}, health: { state: 'broken', file: name, reason } });
  let t, v;
  try { t = fs.readFileSync(p, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { facts: {}, health: { state: 'missing', file: name } } : broken(`${name} 打不开（${e.code || '读取失败'}）`); }
  try { v = YAML.parse(t); } catch (e) { const line = e.linePos?.[0]?.line; return broken(line ? `${name} 第 ${line} 行格式不对` : `${name} 格式不对`); }
  if (v == null) v = {};
  if (typeof v !== 'object' || Array.isArray(v)) return broken(`${name} 不是「名字: 内容」的写法`);
  return { facts: v, health: { state: 'ok', file: name } };
}
export function readFacts() {
  const { facts, health } = load();
  return Object.defineProperty(facts, FACTS_HEALTH, { value: health });
}
export const factsHealth = () => load().health;
// 工作台常驻：设置页改了 facts.yaml 要能看到，但排序比较里一秒调几十万次，不能次次 stat。
// 一秒内复用上次的结果；文件签名（mtime + size + inode）变了才重新解析。测试里每次都看文件。
const TTL_MS = process.env.NODE_TEST_CONTEXT ? 0 : 1000;
let cache = { checked: -Infinity, sig: null, facts: null };
const signature = () => { try { const s = fs.statSync(factsPath()); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return '-'; } };
// 这个进程刚写过 facts.yaml（设置页保存）：下一次读不复用一秒内的结果。
export const forgetFacts = () => { cache.checked = -Infinity; };
export function currentFacts() {
  const now = Date.now();
  if (cache.facts && now - cache.checked < TTL_MS) return cache.facts;
  const sig = signature();
  if (!cache.facts || sig !== cache.sig || cache.path !== factsPath()) cache = { checked: now, sig, path: factsPath(), facts: Object.freeze(readFacts()) };
  else cache.checked = now;
  return cache.facts;
}

const str = (v) => (v == null ? '' : String(v).trim());
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(str).filter(Boolean);

// 系统读写的 Gmail：identity.mailbox；没写就是 identity.email（多数人只有一个邮箱）。
// 两个邮箱可以不同：简历上印的、申请表上填的是 identity.email（个人资料里的联系邮箱）；系统连接、读信、发信用 identity.mailbox。
// （负责人 10-05 G4 / E5：以前申请表填的是收信邮箱，和个人资料里的联系邮箱对不上。）
export const mailboxOf = (facts = currentFacts()) => str(facts?.identity?.mailbox) || str(facts?.identity?.email);
// 申请表、对外留的联系邮箱：个人资料里的 identity.email；没写才用收信邮箱。
export const contactEmailOf = (facts = currentFacts()) => str(facts?.identity?.email) || str(facts?.identity?.mailbox);
// 系统读写的邮箱，每次用都现读（以前在 lib/gmail.mjs）：工作台常驻，引导是在它启动以后才写进邮箱的——以前启动时定死，
// 要重启才认（10-01 开箱测试）。读不到就是空串：那时任何邮箱都不认，绝不借用别的。
export const currentMailbox = () => mailboxOf(currentFacts());

// 简历 PDF（仓库内相对路径）；只配了一份时两种语言都用它。
export function resumeFiles(facts = currentFacts()) {
  const r = facts?.resume_routing || {};
  const english = str(r.english_pdf), chinese = str(r.chinese_pdf);
  return { english: english || chinese, chinese: chinese || english };
}
export const resumeList = (facts = currentFacts()) => [...new Set(Object.values(resumeFiles(facts)).filter(Boolean))];
export const resumeNames = (facts = currentFacts()) => resumeList(facts).map((p) => path.basename(p));

// 「张三 / Alex」：中文名和英文名的名（name_en 的第一个词）。
export function ownerLabel(facts = currentFacts()) {
  const id = facts?.identity || {};
  return [str(id.name_zh), str(id.name_en).split(/\s+/)[0]].filter(Boolean).join(' / ');
}
// 对外短消息和 Jev 判断里的本人说法（facts.yaml `outreach`，2026-09-28 从代码搬来）。
const outreach = (facts) => facts?.outreach || {};
// 「我是某某，」后面的学历，如「示例大学计算机本科、XYZ 计算机硕士」。
export const educationShort = (facts = currentFacts()) => str(outreach(facts).education);
// 「现职做……」的那一句（outreach.current_role）。
export const currentRoleShort = (facts = currentFacts()) => str(outreach(facts).current_role);
// 平台私信里接在现职后面的一句。
export const outreachExtra = (facts = currentFacts()) => str(outreach(facts).extra);
// 脉脉加好友附言（50 字以内）里的自我介绍（「我做AI应用开发」）和项目一句（长、短两种写法）。
export const outreachIntro = (facts = currentFacts()) => str(outreach(facts).intro);
export function projectLines(facts = currentFacts()) {
  const long = str(outreach(facts).project_line), short = str(outreach(facts).project_line_short);
  return { long: long || short, short: short || long };
}
// 判断校友时给 Jev 看的学校叫法，学校之间用「, or 」；没写就用 education[].school。
export function schoolNames(facts = currentFacts()) {
  const named = list(outreach(facts).school_names);
  return (named.length ? named : (facts?.education || []).map((e) => str(e?.school)).filter(Boolean)).join(', or ');
}
// 候选人证据里的语言那一条；没写就用 standard_answers.languages。
export const languageEvidence = (facts = currentFacts()) => str(outreach(facts).language_evidence) || list(facts?.standard_answers?.languages).join('，');
// 前雇主（career_highlights 的顺序）。
export const formerEmployers = (facts = currentFacts()) => (facts?.career_highlights?.entries || []).map((e) => str(e?.company)).filter(Boolean);
// 中文短消息里去掉汉字与字母数字之间的空格（「XYZ 计算机硕士」→「XYZ计算机硕士」），平台私信一向这么写。
export const tightCjk = (s) => String(s || '').replace(/(?<=[\p{Script=Han}])\s+(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])\s+(?=[\p{Script=Han}])/gu, '');

// 交给模型做事时带上的「你是谁」（原 lib/task-do.mjs candidateBrief，面试资料也用）：资料去掉身份、沟通口吻、外联和想搬去的城市，
// 加上 candidate/profile.md、candidate/resume.tex 的原文（截短；没有就是 null）。
const clipText = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const optional = rel => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
export async function candidateBrief() {
  const facts = structuredClone(currentFacts() || {});
  for (const k of ['identity', 'communication', 'outreach']) delete facts[k];
  if (facts.location) delete facts.location.relocation_cities;
  return { facts, profile: clipText(optional('candidate/profile.md'), 3000) || null, resume: clipText(optional('candidate/resume.tex'), 6000) || null };
}
