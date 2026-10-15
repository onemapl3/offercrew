// 录制与回放（2026-09-28）：同一个站点、同一张表，第二次起不再问模型。
//
// 一次任务停在终审（或做完）后，把成功执行的动作存成「配方」：按 站点 + 页面签名 存进
// state/operator-recipes/<host>.json。页面签名 = 第一页控件标签排序后的哈希（链接不算，数字抹掉——
// 导航栏里"消息(3)"这种会变的东西不该让签名变）。配方里的目标不用 data-jm-id（每次打开都重新编号），
// 用 name → 标签 → CSS 路径 依次去认；填的值记来源：来自 data 的记键名（下次换一份 data 照样能用），
// 模型自己定的（比如"是否需要签证：否"）记原值。
//
// 回放每一步照样过 guard.mjs：站点白名单、不碰密码 / 验证码、不点最终提交。哪一步对不上（控件没了、
// 值缺了、动作报错），就停在那一步，把已经做过的交给 agent 从这里接着做。
//
// 分级（调研 10-02「新配方先重放一遍」，Webwright 的两道闸）：
//   candidate  模型刚走通、录下来的，还没证明能照做；下次遇到同一张表先不问模型重放一遍——
//   verified   重放成功过：可以照做；
//   reference  重放没成：不再照着点，交给模型时把上次的步骤当参考附上；模型这次走通了，录下的新步骤又是 candidate。
// 「提交」那一步从来不进配方（guard 不让点，停在终审）。
import path from 'node:path';
import { read, write, hash } from '../store.mjs';
import { checkAction, wallOf, flatten, rememberUrls, hostOf, stopPattern, allowedFiles, normUrl } from './guard.mjs';
import { performAction } from './browser.mjs';

export const RECIPES_DIR = 'state/operator-recipes';
const RECORDABLE = ['click', 'fill', 'select', 'check', 'upload', 'press', 'scroll', 'goto'];
const MAX_PER_HOST = 30;
export const normLabel = s => String(s ?? '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function signatureLabels(obs = {}) {
  const els = obs.elements || [];
  const pick = els.some(e => e.tag !== 'a') ? els.filter(e => e.tag !== 'a') : els;
  return [...new Set(pick.map(e => `${e.tag}:${normLabel(e.label)}`).filter(x => !x.endsWith(':')))].sort();
}
export const pageSignature = obs => hash(signatureLabels(obs).join('\n')).slice(0, 16);

// 元素 → 不依赖 data-jm-id 的描述；回放时在新的观察结果里认回来。
export function targetOf(el) {
  if (!el) return null;
  const t = { tag: el.tag, type: el.type || '', role: el.role || '', label: el.label || '' };
  if (el.name) t.name = el.name;
  if (el.css) t.css = el.css;
  if (el.href) t.href = el.href;
  return t;
}
export function matchTarget(t, els = []) {
  if (!t) return null;
  const same = e => e.tag === t.tag && (e.type || '') === (t.type || '');
  const lab = normLabel(t.label);
  const tries = [
    t.name ? e => same(e) && e.name === t.name && (!/^(radio|checkbox)$/.test(t.type) || normLabel(e.label) === lab) : null,
    lab ? e => same(e) && normLabel(e.label) === lab : null,
    t.css ? e => e.tag === t.tag && e.css === t.css : null,
  ].filter(Boolean);
  for (const f of tries) { const hits = els.filter(f); if (hits.length === 1) return hits[0]; }
  return null;
}
// 填进去的值从哪来：data 里恰好一个键是这个值，就记键名。"是 / 否 / Yes"这种短词、好几个键同值时记原值——
// 否则"是否接受出差"填的"是"可能被记成"是否愿意搬家"的键，换一份资料回放就填错了题。
const GENERIC = /^(?:yes|no|y|n|true|false|none|n\/a|是|否|有|无|男|女|\d{1,2})$/i;
export function valueSource(value, data = {}) {
  if (typeof value !== 'string' || GENERIC.test(value.trim())) return { literal: value };
  const flat = flatten(data);
  const v = value.trim();
  const keys = Object.keys(flat).filter(k => (typeof flat[k] === 'string' && flat[k].trim() === v) || (typeof flat[k] === 'number' && String(flat[k]) === v));
  return keys.length === 1 ? { data: keys[0] } : { literal: value };
}

// 同一页、不同的目标（"看看登录没" 和 "把表填好"）是两份配方：键 = 页面签名 + 目标的短哈希，
// 不然一个目标录下的步骤会被另一个目标拿去回放。
export const recipeKey = (signature, goal = '') => `${signature}.${hash(String(goal).toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 8)}`;
const fileOf = host => `${RECIPES_DIR}/${String(host || 'unknown').toLowerCase().replace(/[^a-z0-9.-]/g, '_')}.json`;
export const loadRecipes = host => read(fileOf(host), { host, recipes: {} });
export function findRecipe(host, signature, goal = '') { return loadRecipes(host).recipes?.[recipeKey(signature, goal)] || null; }
export function saveRecipe(host, recipe) {
  const store = loadRecipes(host);
  store.host = host; store.recipes ||= {};
  const key = recipeKey(recipe.signature, recipe.goal);
  const old = store.recipes[key] || {};
  const at = new Date().toISOString();
  store.recipes[key] = { ...old, ...recipe, key, status: recipe.replayed ? 'verified' : 'candidate', ...(recipe.replayed ? { verified_at: at } : {}), created_at: old.created_at || at, updated_at: at, uses: (old.uses || 0) + (recipe.replayed ? 1 : 0), recorded: (old.recorded || 0) + (recipe.replayed ? 0 : 1) };
  delete store.recipes[key].replayed;
  // 只留最近用过的一批，免得一个站点攒出几百份。
  const keys = Object.keys(store.recipes).sort((a, b) => String(store.recipes[b].updated_at).localeCompare(String(store.recipes[a].updated_at)));
  for (const k of keys.slice(MAX_PER_HOST)) delete store.recipes[k];
  write(fileOf(host), store);
  return store.recipes[key];
}
export function noteReplay(host, key, result) {
  const store = loadRecipes(host);
  const r = store.recipes?.[key];
  if (!r) return;
  r.last_replay = { at: new Date().toISOString(), ok: !!result.ok, ...(result.ok ? {} : { failed_at: result.failed_at, reason: result.reason }) };
  // 页面要你登录 / 验证（wall）不怪配方；别的失败：没证明过的降成参考，证明过的这次也降——表单多半改了。
  if (result.ok) { r.status = 'verified'; r.verified_at = r.last_replay.at; }
  else if (!result.wall) r.status = 'reference';
  write(fileOf(host), store);
}

// 值得记下来的跑法：停在终审的必须真填过东西（填 / 选 / 勾 / 上传），做完的至少有一个不是滚动的动作。
// 否则"滚了一下就点提交"这种跑法会被一直回放，还把一张空表报成"已预填"（09-28 审查）。
export function worthKeeping({ outcome, steps = [] }) {
  if (outcome === 'ready_for_review') return steps.some(s => ['fill', 'select', 'upload'].includes(s.action) || (s.action === 'check' && s.value?.literal === true));
  if (outcome === 'done') return steps.some(s => s.action !== 'scroll');
  return false;
}

// 执行轨迹 → 配方步骤：只要成功执行的动作；值记来源。
export function recipeFromTrace(trace = []) {
  return trace.filter(s => s.ok && RECORDABLE.includes(s.action)).map(s => {
    const step = { action: s.action };
    if (s.target) step.target = s.target;
    if (s.action !== 'click') step.value = s.value_from ? { data: s.value_from } : { literal: s.raw_value ?? s.value };
    return step;
  });
}
const shown = (action, v) => (action === 'upload' && typeof v === 'string' ? path.basename(v) : v);

// 回放一份配方。返回 { ok, steps, obs, stop_el? } 或 { ok: false, failed_at, reason, wall?, steps, obs }。
export async function replayRecipe(recipe, { page, data = {}, ctx, obs = null, onStep = null, startIndex = 1 }) {
  const steps = [];
  const flat = flatten(data);
  let cur = obs || await page.observe();
  const fail = (k, reason, extra = {}) => ({ ok: false, failed_at: k, reason, steps, obs: cur, ...extra });
  for (const [k, s] of (recipe.steps || []).entries()) {
    if (ctx.signal?.aborted) return fail(k, 'aborted');
    const wall = wallOf(cur, ctx.hosts);
    if (wall) return fail(k, wall.reason, { wall });
    const el = s.target ? matchTarget(s.target, cur.elements) : null;
    if (s.target && !el) return fail(k, `target_not_found:${s.target.label || s.target.name || s.target.css || ''}`);
    // 点击只点标题一模一样的那个：按 name / 位置认出来、标题却变了的按钮（下一步 → 提 交），不点，交给模型重新看。
    if (s.action === 'click' && normLabel(el.label) !== normLabel(s.target.label)) return fail(k, `target_changed:${s.target.label} → ${el.label}`);
    let value = null;
    if (s.value?.data != null) { value = flat[s.value.data]; if (value == null || value === '') return fail(k, `data_missing:${s.value.data}`); }
    else if (s.value) value = s.value.literal;
    const a = { action: s.action, id: el?.id ?? null, value };
    const chk = checkAction(a, cur, ctx);
    if (chk.stop) return fail(k, 'final_button');
    if (!chk.ok) return fail(k, `guard:${chk.refused}`);
    const rec = { i: startIndex + steps.length, action: s.action, id: el?.id ?? null, label: el?.label ?? '', value: shown(s.action, chk.value ?? value), url: cur.url, replay: true };
    try { await performAction(page, { ...a, value: chk.value ?? value, fp: el?.fp || null }); }
    catch (e) { const bad = { ...rec, ok: false, error: String(e.message).slice(0, 200) }; steps.push(bad); onStep?.(bad); try { cur = await page.observe(); } catch {} return fail(k, `error:${String(e.message).slice(0, 120)}`); } // 兜底：这一步已经出错了，最后看一眼没看成也照样报这一步的错
    cur = await page.observe();
    if (ctx.known) rememberUrls(ctx.known, cur, ctx.links);
    const done = { ...rec, ok: true, url_after: cur.url, ...(el ? { target: targetOf(el) } : {}), ...(s.value?.data != null ? { value_from: s.value.data } : {}), raw_value: chk.value ?? value };
    steps.push(done); onStep?.(done);
  }
  const wall = wallOf(cur, ctx.hosts);
  if (wall) return fail(recipe.steps.length, wall.reason, { wall });
  // 停在终审的配方：最后那个"提交"按钮还得在，才算回放到位。
  if (recipe.outcome === 'ready_for_review' && recipe.stop) {
    const stopEl = matchTarget(recipe.stop, cur.elements);
    if (!stopEl) return fail(recipe.steps.length, 'stop_target_not_found');
    return { ok: true, steps, obs: cur, stop_el: stopEl };
  }
  return { ok: true, steps, obs: cur };
}

// 不经 agent、单独回放一份配方：打开它记下的起始页，逐步执行，对不上就停在那一步（不问模型）。
// runTask 里的回放和这里是同一段逻辑；这个入口给排查和"只想按老样子再填一遍"用。
export async function replay(recipe, data = {}, { page, allow_hosts = null, stop_before = null, onStep = null } = {}) {
  const ctx = { hosts: allow_hosts?.length ? allow_hosts : [hostOf(recipe.start_url)], gate: stopPattern(stop_before), files: allowedFiles(data), data, known: new Set([normUrl(recipe.start_url)]), links: new Map() };
  await page.goto(recipe.start_url);
  const obs = await page.observe();
  rememberUrls(ctx.known, obs, ctx.links);
  return replayRecipe(recipe, { page, data, ctx, obs, onStep });
}
