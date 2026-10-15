// 任务页（2026-09-30；10-03 负责人定的「任务卡片」：任务是任务页里的一张卡片，对话栏只放对话）。
//   #tasks                 看板：六种状态横向排列，可左右拖动；更早完成和定时任务收在末尾；点开一件换成它的卡片
//   #tasks?task=<id>       打开那一件（旧链接 card=<id> 也认）；owner=quill 只看一位；lead=31 只看这条岗位；goal=<id> 只看这件事
// 约定：design/handoff/L-任务卡片-接口.md。目录 GET /api/tasks，卡片 GET /api/tasks/<id>/card；动作 POST /api/tasks（新建）、
// /api/tasks/<id>/edit（改要求）、/assign（只在「你交代的事」）、/move（再试一次、撤回）；回答走收件箱同一封（/api/inbox/answer）。
// 页面上的 HTML 都由纯函数拼（directoryHtml / composeHtml / taskCardHtml / pageHtml），不碰 DOM，测试直接 import。
// cardHtml / listHtml / detailHtml 是旧的看板卡和详情，页面不再用。
import { faceHtml } from './face.js';
import { setLeadOrigin } from './hq.js';
import { openDraftEditor } from './command.js';
import { openEditor } from './setup.js';
import { morph } from './morph.js';
import { href } from './routes.js';
const leadHref = rid => esc(rid ? href.lead(rid) : href.tasks());

const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// 卡上的一句话：不从一个词、一道题中间切开（同 lib/needs.mjs clipText）。
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; const head = t.slice(0, n - 1), at = cs => Math.max(...cs.map(c => head.lastIndexOf(c))), i = at(['、', '；', '。', '，', ';']), j = at([' ', ',']); return head.slice(0, i >= Math.min(8, n / 3) ? i : j >= n / 2 ? j : n - 1).replace(/[、；。，,;:：\s]+$/, '') + '…'; };
const TZ = typeof document !== 'undefined' ? document.querySelector('meta[name="radar-tz"]')?.content || undefined : undefined;
export const clock = (x, now = Date.now()) => { if (!x) return ''; try { const d = new Date(x), day = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ }); if (!Number.isFinite(d.getTime())) return ''; const prefix = day(x) === day(now) ? '' : d.toLocaleDateString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric' }) + ' '; return prefix + d.toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };
const HOW = { script: ['script', '脚本'], browser: ['script', '浏览器'], model: ['model', '要模型'], executor: ['model', '要模型'] }; // 执行器做的事也是要模型的事；卡上不说「执行器」（第 2 轮新 38）
const WAIT = { final: '终审', login: '登录', info: '补信息' };
const FROM_WORD = { you: '你', team: '团队', cycle: '定时' }; // repair 用名册里 patch 的名字（fromChip）

// ── 小零件 ───────────────────────────────────────────────────────────────────
const who = (v, id) => v.byKey?.[id] || null;
// 认不出的编号不原样写出来（实测 10-04 第 8 条：「reacher：等你……」）：服务端已经换成成员 id，这里兜底。
const nameOf = (v, id) => NEUTRAL[id]?.[0] || who(v, id)?.name || '';
const NEUTRAL = { you: ['你', 'user'], team: ['团队', 'users'], executor: ['本机 AI', 'robot'] };
const face = (v, id, cls = 'tb-face') => id ? faceHtml(NEUTRAL[id] ? { name: NEUTRAL[id][0], face: { icon: NEUTRAL[id][1], fill: null, ink: null } } : who(v, id) || { name: id }, cls) : '<span class="tb-face tb-nobody" aria-hidden="true"></span>';
// 状态小标：词和色调都是服务端给的（lib/status.mjs，卡、子任务上的 word / tone），页面不自己换算。
export const stChip = (x, extra = '') => x?.word ? `<span class="tb-st is-${esc(x.tone || 'mute')}">${esc(x.word)}${extra ? ` · ${esc(extra)}` : ''}</span>` : '';
// 来源照实写：System 自己排进来的修复是「来自 System」（lib/tasks.mjs jobFrom），不是你。定时周期开的不标。
// 详情里这一格的名字已经是「来自」（bare）：芯片里不再写一遍（N06：「来自 来自你」）。
const fromChip = (v, c, { bare = false } = {}) => { const f = c.from || {}; const id = f.by === 'member' || f.by === 'repair' ? f.member || 'patch' : f.by === 'you' ? 'you' : f.by === 'team' ? 'team' : null; return f.by === 'cycle' ? '' : `<span class="tb-chip">${id ? face(v, id, 'tb-face is-xs') : ''}${bare ? '' : '来自 '}${esc(f.by === 'member' || f.by === 'repair' ? nameOf(v, id) : FROM_WORD[f.by] || '你')}${f.via === 'phone' && f.by !== 'member' ? '（手机）' : ''}</span>`; };
const goalChip = (v, c) => { const g = c.goal && v.goalById?.[c.goal]; return g ? `<a class="tb-chip is-goal" href="#tasks?goal=${encodeURIComponent(g.id)}" data-goal="${esc(g.id)}">目标：${esc(cut(g.title.replace(/\s·.*$/, ''), 16))}</a>` : ''; };
// 卡上一行：短标题（lib/tasks.mjs headline）；执行器的长指令全文只在详情里。
const titleOf = c => c.short || c.title || '';
const leadLink = c => { const t = titleOf(c), l = c.leads?.[0]; if (!l || l.number == null) return esc(t); const tag = `#${l.number} ${l.company || ''}`.trim(); return String(t).startsWith(tag) ? `<a href="${leadHref(l.rid)}" class="tb-lead" data-rid="${esc(l.rid)}">${esc(tag)}</a>${esc(t.slice(tag.length))}` : esc(t); };
// 标题下面那一行：等你的是要你做什么（短标题），其余是现在到哪了。都只占一行，全文点开看。
const noteOf = c => c.status === 'needs_you' ? c.need_title || c.detail || '' : c.status === 'done' ? c.result : c.status === 'queued' && c.mac_hold ? c.mac_hold.label : c.status === 'queued' && c.wait_note ? c.wait_note.replace(/^排队中[：:，,\s]*/, '') : c.detail || c.result || '';
// 手机上开的卡里要开执行器 / 浏览器的那一棒（lib/tasks.mjs mac_hold）：点了才跑，只在这台电脑上。
const held = c => !!c.mac_hold && c.status === 'queued';
const releaseBtn = c => held(c) ? `<div class="tb-acts"><button type="button" class="tb-btn is-warn" data-release="${esc(c.id)}">在这台电脑上运行</button></div>` : '';
// 认不出的类型不写代号（N06：详情、卡上露出 round）。
const kindLabel = (v, k) => v.kindById?.[k]?.label || v.kind_labels?.[k] || (k === 'goal' ? '目标' : k === 'ask' ? '你交代的事' : '');
// 一张卡「谁该接」：类型定了成员的就是它（待认领的卡上「交给 X」）。
const suggest = (v, c) => v.kindById?.[c.kind]?.member || null;
function askButtons(c, { all = false } = {}) {
  if (c.resume_prefill) return `<div class="tb-acts"><button type="button" class="tb-btn is-warn" data-resume-prefill="${esc(c.id)}">继续预填</button></div>`;
  // 要填字段的信：表单在收件箱，卡上只放「补信息」（和指挥台、详情里「等你 · 补信息」同一个词；要补的常常是一段 JD，不是申请表，视觉验收第 16 条）。
  // 按钮叫法是动作本身，不带「去」（09-30 负责人）；不放一个点了会交空表的「填好提交」。
  if (c.ask?.form?.length) return `<div class="tb-acts">${all ? `<a class="tb-btn is-warn" href="#inbox?ask=${encodeURIComponent(c.ask.id)}">${WAIT.info}</a>` : `<button type="button" class="tb-btn is-warn" data-open-card="${esc(c.id)}">${WAIT.info}</button>`}</div>`;
  const opts = c.ask?.options || [];
  // 等打开本机 AI 的（lib/task-do.mjs）：没有要答的问题，卡片上有「打开本机 AI」，这里不放「回答」。
  if (!opts.length) return c.status === 'needs_you' && !['local_ai', 'mail'].includes(c.wait) ? `<div class="tb-acts"><button type="button" class="tb-btn is-warn" data-open-card="${esc(c.id)}">${c.wait === 'final' ? '看一眼再批准' : '回答'}</button></div>` : '';
  // 卡上的选项和对话、收件箱里同一封信一样多（视觉验收第 17 条）；超过四个才收成三个加「更多」。终审照旧：「看一眼再批准」打开详情，外加不投。
  const final = !all && c.wait === 'final';
  const pick = all ? opts : final ? [opts.find(o => o.primary) || opts[0], opts.find(o => o.danger)].filter(Boolean) : opts.length <= 4 ? opts : opts.slice(0, 3);
  const more = !all && !final && opts.length > 4 ? `<button type="button" class="tb-btn" data-open-card="${esc(c.id)}">更多</button>` : '';
  return `<div class="tb-acts">${pick.map(o => o.primary && final ? `<button type="button" class="tb-btn is-warn" data-open-card="${esc(c.id)}">${c.wait === 'final' ? '看一眼再批准' : esc(o.label)}</button>` : `<button type="button" class="tb-btn${o.primary ? ' is-warn' : ''}" data-answer="${esc(c.id)}" data-option="${esc(o.key)}" data-label="${esc(o.label)}" data-confirm="${o.confirm_inline || o.danger ? 1 : ''}">${esc(o.label)}</button>`).join('')}${more}</div>`;
}

// ── 一张卡 ────────────────────────────────────────────────────────────────────
export function cardHtml(c, v = {}) {
  const tone = c.status === 'needs_you' ? ' is-you' : c.status === 'stuck' ? ' is-bad' : '';
  const sel = v.selected === c.id ? ' is-sel' : '';
  // 类型标签：标题里已经写了（「#6 Contoso · 预填申请表」）就不再写一遍。
  const kl = c.legacy ? '旧记录' : kindLabel(v, c.kind), kTag = kl && !c.adopted && !String(titleOf(c)).includes(kl) ? `<span class="tb-k">${esc(kl)}</span>` : '';
  const head = `<div class="tb-h">${face(v, c.owner)}<b>${c.owner ? esc(nameOf(v, c.owner)) : '还没人认领'}</b>${kTag}</div>`;
  const items = (c.items || []).length ? (() => { const n = c.items.length, d = c.items.filter(i => i.result).length; return `<div class="tb-prog" title="${d}/${n}"><i style="width:${Math.round(100 * d / Math.max(1, n))}%"></i></div>`; })() : '';
  const s = suggest(v, c) || (c.kind === 'ask' ? null : null);
  const claim = !c.owner && !c.legacy ? `<div class="tb-acts">${s ? `<button type="button" class="tb-btn" data-assign="${esc(c.id)}" data-owner="${esc(s)}">${face(v, s, 'tb-face is-xs')}交给 ${esc(nameOf(v, s))}</button>` : ''}<select class="tb-pick" data-assign-pick="${esc(c.id)}" aria-label="换一位"><option value="">${s ? '换一位' : '交给…'}</option>${(v.members || []).map(m => `<option value="${esc(m.key)}">${esc(m.name)}</option>`).join('')}</select></div>` : '';
  const meta = [fromChip(v, c), goalChip(v, c), c.routine ? `<span class="tb-chip is-routine">定时</span>` : '', held(c) ? '<span class="tb-chip is-you">等你确认</span>' : c.status === 'queued' ? '<span class="tb-chip is-q">排队</span>' : '', c.how === 'model' && v.model && !v.model.ok && !['done', 'cancelled'].includes(c.status) ? '<span class="tb-chip is-model">要模型</span>' : ''].join('');
  return `<article class="tb-card${tone}${sel}${c.legacy ? ' is-legacy' : ''}" data-card="${esc(c.id)}" tabindex="0">${head}<div class="tb-t">${leadLink(c)}</div>${noteOf(c) ? `<div class="tb-n${c.status === 'needs_you' ? ' is-you' : ''}">${esc(clip(noteOf(c), 90))}</div>` : ''}${items}${c.status === 'needs_you' ? askButtons(c) : ''}${releaseBtn(c)}${claim}<div class="tb-m">${meta}<time>${esc(clock(c.status === 'done' ? c.done_at : c.updated_at))}</time></div></article>`;
}
// 路线上还没开的那一棒：虚线，写「等上一棒」。
const ghostHtml = (v, g, s) => `<div class="tb-card is-ghost" data-goal="${esc(g.id)}"><div class="tb-h">${face(v, s.owner)}<b>${esc(nameOf(v, s.owner))}</b><span class="tb-k">${esc(kindLabel(v, s.kind))}</span></div><div class="tb-n">等上一棒 · ${esc(cut(g.title, 30))}</div></div>`;

// ── 目录（任务卡片，负责人 10-03；design/handoff/L-任务卡片-接口.md 第一节第 2 条）──────────────────────
// 状态是一条队列，六种，按这个顺序分组：排队 → 在做 → 等你 → 做完 · 今天 → 没做成 → 撤回（收起）。「等你」不放最上面。
// 更早做完的收成「更早 N 件」，和撤回一样点开才列。一行一件活（目标卡一行，它下面的卡、parent_task 卡不单列）。
export const SIX = { unclaimed: 'queued', queued: 'queued', running: 'running', needs_you: 'needs_you', done: 'done', stuck: 'stuck', cancelled: 'cancelled' };
export const sixOf = st => SIX[st] || null;
export const dirChip = x => stChip(x);
// 分组按账上的状态（c.state），组名就是那一组的状态词（服务端给的），页面只定顺序和哪组收起。
export const DIR_GROUPS = [['queued'], ['running'], ['waiting_you'], ['done', ' · 今天'], ['failed'], ['cancelled', '', true]];
const dayOf = x => { const t = Date.parse(x || ''); if (!Number.isFinite(t)) return ''; try { return new Date(t).toLocaleDateString('zh-CN', { timeZone: TZ }); } catch { return ''; } };
const today = (x, now) => !!x && dayOf(x) === dayOf(new Date(now).toISOString());
const rowFace = (v, c) => face(v, c.owner && c.owner !== 'team' ? c.owner : 'team', 'tb-face');
// 任务位于对应的状态分区，整区接收允许的拖放操作。
// 一张卡只写三样：做成什么（标题）、现在卡在哪 / 下一步（一行）、谁在做和时间。按钮都在点开的详情里。
// 能不能落、为什么不能，每张卡自己带着（GET /api/tasks 每行的 board.moves，lib/task-card.mjs boardOf）；落下去统一
// POST /api/tasks/<id>/move { column }：待做 / 完成 / 不做了存你的安排，进行中真的开始或接着做，等你、没做成只由执行结果产生。
// 服务器回来再画真实状态，卡片不先挪过去。
export const BOARD = [['queued', '待做'], ['running', '进行中'], ['waiting_you', '等你'], ['done', '完成'], ['failed', '没做成'], ['cancelled', '不做了', true]];
export const movesOf = c => Object.fromEntries((c?.board?.moves || []).map(m => [m.column, m]));
const lineOf = c => c.state === 'cancelled' ? '' : c.state === 'waiting_you' ? c.what?.label || c.need_title || c.need || c.reason || c.detail || '' : c.state === 'failed' ? c.reason || c.detail || '' : noteOf(c) || c.reason || '';
const dirRow = (v, c, ui) => {
  const mv = ui.move?.id === c.id ? ` is-${ui.move.state}` : '', line = lineOf(c), who = c.owner && c.owner !== 'team' ? nameOf(v, c.owner) : '团队';
  return `<div class="tc-tk${mv} tc-row${ui.sel === c.id ? ' is-sel' : ''}" data-task="${esc(c.id)}" data-st="${esc(c.state || '')}" draggable="${!c.legacy && !c.routine && !mv.includes('saving')}" role="button" tabindex="0"><span class="t">${esc(titleOf(c))}</span>${line ? `<p class="n"${line.length > 180 ? ` title="${esc(line)}"` : ''}>${esc(clip(line, 180))}</p>` : ''}<span class="m">${rowFace(v, c)}<span class="who">${esc(who)}</span>${c.routine ? stChip(c) : ''}<time>${esc(clock(c.state === 'done' ? c.done_at || c.updated_at : c.updated_at))}</time></span></div>`;
};
const CHEV_D = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';
export function topCards(v = {}) {
  const goals = v.goals || [], inGoal = new Set(goals.map(g => g.id));
  return [...goals, ...(v.cards || []).filter(c => !(c.goal && inGoal.has(c.goal)) && !c.parent_task)].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
export function directoryHtml(v = {}, ui = {}, { now = Date.now() } = {}) {
  const top = topCards(v), routine = top.filter(c => c.routine), rest = top.filter(c => !c.routine);
  const open = ui.open || new Set();
  const fold = (k, label, n, shut, attr = `data-fold="${k}"`) => `<button type="button" class="tc-sh is-fold${shut ? '' : ' is-open'}" ${attr} aria-expanded="${!shut}">${CHEV_D}${esc(label)} <b>${n}</b></button>`;
  // 移动的结果写在一列顶上：保存中 / 没移过去（服务器原话）写在要去的那一列；没能进行中的原因（why）写在它真实所在的那一列。
  // 不自己消失：下一次移动或点「×」才清。
  const x = '<button type="button" class="tc-colx" data-tc-movex aria-label="关闭">×</button>';
  const note = (k, all) => { const m = ui.move; if (!m || (m.state === 'why' ? !all.some(c => c.id === m.id) : m.to !== k)) return ''; return m.state === 'failed' ? `<p class="tc-colnote is-bad" role="alert"><span>没移过去：${esc(m.err || '没保存上')}</span>${x}</p>` : m.state === 'why' ? `<p class="tc-colnote is-why" role="status"><span>${esc(m.title ? `「${clip(m.title, 18)}」` : '')}${esc(m.err)}</span>${x}</p>` : '<p class="tc-colnote" role="status">保存中…</p>'; };
  const col = ([k, label, folds]) => {
    const all = rest.filter(c => c.state === k), rows = k === 'done' ? all.filter(c => today(c.done_at || c.updated_at, now)) : all, shut = folds && !open.has(k);
    return `<section class="tc-col is-${k}${shut ? ' is-shut' : ''}" data-group="${k}" aria-label="${esc(label)} ${rows.length}"><header class="tc-colh">${folds ? fold(k, label, rows.length, shut) : `<h3 class="tc-sh"><i></i>${esc(label)} <b>${rows.length}</b></h3>`}</header>${note(k, all)}<div class="tc-colbody">${shut ? '' : rows.map(c => dirRow(v, c, ui)).join('')}</div></section>`;
  };
  const earlier = rest.filter(c => c.state === 'done' && !today(c.done_at || c.updated_at, now));
  const scheduled = (v.schedules || []).map(s => `<div class="tc-schedule"><b>${esc(s.label)}</b><p>${esc(s.schedule || (s.hourly ? '每小时整点' : (s.times || []).join('、')))} · 本地时间</p>${s.next_at ? `<p>下次 <time>${esc(clock(s.next_at))}</time></p>` : ''}</div>`).join('');
  // 定时是来源，不是状态落点；末尾默认收起，展开才列出计划与历史执行。
  const shutR = !open.has('routines');
  const schedules = `<section class="tc-routines${shutR ? ' is-shut' : ''}" aria-label="定时任务">${fold('routines', '定时任务', routine.length, shutR)}${shutR ? '' : `<div class="tc-routinebody">${scheduled}${routine.map(c => dirRow(v, c, ui)).join('')}${!scheduled && !routine.length ? '<p class="tc-colnote">还没有定时任务</p>' : ''}</div>`}</section>`;
  // 更早做完的普通任务收在看板下面，点开才列。
  const shutE = !open.has('earlier');
  const tray = earlier.length ? `<section class="tc-sec" data-group="earlier">${fold('earlier', '更早完成', earlier.length, shutE)}${shutE ? '' : `<div class="tc-grid">${earlier.map(c => dirRow(v, c, ui)).join('')}</div>`}</section>` : '';
  return `<div class="tc-board" tabindex="0" aria-label="任务状态看板">${BOARD.map(col).join('')}</div>${tray ? `<div class="tc-tray">${tray}</div>` : ''}${schedules}`;
}

// ── 新建：说一句话，派给谁 ─────────────────────────────────────────────────────────
// 「派给」：只有「你交代的事」（kind ask）不限人，列全部六位，System 建议的预先选上、旁边标「System 建议」；
// 认得出类型、只有一位能做的，只写名字（接口第一节第 4 条）。建议来自 GET /api/talk/parse（persona；带 task.assign 就照它）。
// 新建和「+ 子任务」共用：st = { assign, suggest, owner }；attr 是下拉上的 data 属性（data-new-owner / data-sub-owner）。
export function pickHtml(v = {}, st = {}, attr = 'data-new-owner') {
  const a = st.assign || null, sugg = st.suggest || null, sel = st.owner || sugg;
  if (a?.fixed && a.owner) return `<span class="tc-who">${face(v, a.owner.id, 'tb-face is-xs')}${esc(a.owner.name || nameOf(v, a.owner.id))}</span>`;
  const opts = a && !a.fixed && a.options?.length ? a.options : (v.members || []).map(m => ({ id: m.key, name: m.name }));
  return `<span class="tc-pick">${sel ? face(v, sel, 'tb-face is-xs') : ''}<select ${attr} aria-label="派给"><option value=""${sel ? '' : ' selected'}>System 定</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === sel ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></span>${sel && sel === sugg ? `<span class="tc-sugg">${face(v, 'patch', 'tb-face is-xxs')}System 建议</span>` : ''}`;
}
export function composeHtml(v = {}, ui = {}) {
  if (!ui.creating) return '';
  const pick = pickHtml(v, { assign: ui.newAssign, suggest: ui.newSuggest, owner: ui.newOwner });
  return `<form class="tc-compose" id="tc-new" autocomplete="off"><textarea name="text" rows="2" maxlength="500" required aria-label="要做的事">${esc(ui.draft || '')}</textarea><div class="tc-cbar">派给${pick}<button type="button" class="tc-btn is-ghost" data-new-cancel>取消</button><button type="submit" class="tc-btn is-pri"${ui.newBusy ? ' disabled' : ''}>新建</button></div>${ui.newErr ? `<p class="tc-err" role="alert">${esc(ui.newErr)}</p>` : ''}</form>`;
}

// ── 一张卡片（GET /api/tasks/<id>/card，接口第二节）────────────────────────────────────
// 从上到下：标题加状态 → 字段（要做成什么、改要求、岗位、派给）→ 结果 / 接下来 → 子任务 → 做了什么 → 底（从哪来、看运行日志）。
// 没有「换人」：派给 fixed 的只写名字，只有「你交代的事」给一个小下拉。卡片上不写「收件箱里也有这封」。
const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6l6 6"/></svg>';
const AI_CHIP = '<span class="tc-ai"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4"/><path d="M12 2v2"/><path d="M9 12v9"/><path d="M15 12v9"/><path d="M10 8v.01"/><path d="M14 8v.01"/></svg>本机 AI</span>';
const withAi = t => esc(t).replace(/本机 AI/g, AI_CHIP);
// 每一项的后果，只写会被误会的那几项。
const MOVE_NOTE = { later: '明天再提醒', self: '这件我接手，团队先不动', resume: '照原记录接着' };
const EXTRA = new Set(['later', 'self', 'resume']);
const LIVE = new Set(['queued', 'running', 'needs_you', 'stuck']);
export function assignHtml(c, v = {}) {
  const o = c.owner || {}, a = c.assign || { fixed: true };
  const who = `<span class="tc-who">${face(v, o.id || 'team', 'tb-face')}${esc(o.name || nameOf(v, o.id) || '团队')}</span>`;
  if (a.fixed || !(a.options || []).length || !LIVE.has(SIX[c.status])) return who;
  return `<span class="tc-pick">${face(v, o.id || 'team', 'tb-face is-xs')}<select data-tc-assign="${esc(c.id)}" aria-label="派给">${a.options.map(x => `<option value="${esc(x.id)}"${x.id === o.id ? ' selected' : ''}>${esc(x.name)}${x.id === a.suggested ? ' · System 建议' : ''}</option>`).join('')}</select></span>`;
}
const leadText = l => l ? `${l.number != null ? `#${l.number} ` : ''}${l.company || ''}${l.role ? ` · ${l.role}` : ''}`.trim() : '';
export function nextHtml(c, ui = {}) {
  // 已有完整正文时，只补实际产物入口；不再画第二份结果或执行按钮。
  const links = ui.artifactsOnly ? [...(c.next?.buttons || []).filter(b => b.act === 'open'), ...(c.receipt?.links || []).map(b => ({ ...b, act: 'open' }))].filter((b, i, all) => b.href && all.findIndex(x => x.href === b.href) === i) : [];
  const n = ui.artifactsOnly ? { kind: 'done', buttons: links } : c.next; if (!n) return '';
  const done = n.kind === 'done';
  const tone = n.kind === 'you' ? 'is-you' : n.kind === 'bad' ? 'is-bad' : 'is-plain';
  const btns = n.buttons || [], hasRetry = btns.some(b => b.act === 'retry');
  let pri = false;
  const one = b => {
    if (b.act === 'resume_prefill') return `<button type="button" class="tc-btn is-pri" data-resume-prefill="${esc(b.task_id || c.id)}">继续预填</button>`;
    if (b.act === 'answer') {
      // Writer 那封先问的几句（questions）在收件箱里逐题答；没有选项的也去收件箱那封。
      if (!(b.options || []).length || (b.questions || []).length) return `<a class="tc-btn is-pri" href="#inbox?ask=${encodeURIComponent(b.ask_id || '')}">回答</a>`;
      return b.options.map((o, i) => `<button type="button" class="tc-btn${i === 0 && !pri ? ((pri = true), ' is-pri') : ''}" data-tc-answer="${esc(b.ask_id)}" data-key="${esc(o.key)}">${esc(o.label)}</button>`).join('');
    }
    // 「在对话里答」（#talk?session=…&m=…）：打开对话栏、跳到那条消息，主区域的卡片不动。
    if (b.act === 'open' && /^#talk\?/.test(String(b.href || ''))) { const q = new URLSearchParams(String(b.href).split('?')[1] || ''); const cls = done ? ' is-link' : pri ? '' : ((pri = true), ' is-pri'); return `<button type="button" class="tc-btn${cls}" data-tc-talk="${esc(q.get('session') || '')}" data-mid="${esc(q.get('m') || '')}">${esc(done ? '查看对话' : b.label || '在对话里答')}</button>`; }
    if (b.act === 'open') { const out = !/^#/.test(String(b.href || '')); const rid = /^#lead\/([^?#/]+)$/.exec(String(b.href || ''))?.[1]; const cls = done ? ' is-link' : pri ? '' : ((pri = true), ' is-pri'); const label = done && rid ? `查看岗位：${b.label || '岗位详情'}` : b.label || (done ? '查看结果' : '打开'); return `<a class="tc-btn${cls}" href="${esc(b.href || '#')}"${rid ? ` data-tc-result="${esc(rid)}"` : ''}${out ? ' target="_blank" rel="noopener"' : ''}>${esc(label)}</a>`; }
    if (b.act === 'why') return `<button type="button" class="tc-btn" data-tc-why="${esc(c.id)}"${ui.why?.busy ? ' disabled' : ''}>看原因</button>`;
    if (b.act === 'retry') return `<button type="button" class="tc-btn is-pri" data-tc-move="queued"${b.disabled ? ' disabled' : ''}>再试一次</button>`;
    if (b.act === 'release') return `<button type="button" class="tc-btn is-pri" data-tc-release>在这台电脑上运行</button>`;
    if (b.act === 'withdraw') return `<button type="button" class="tc-btn${tone === 'is-plain' ? '' : ' is-ghost'}" data-tc-move="cancelled">撤回</button>`;
    return '';
  };
  // 「再试一次」是主按钮，「看原因」排在它前面（样稿 phone.html）；别的照接口给的顺序。
  const ordered = hasRetry ? [...btns.filter(b => b.act === 'why'), ...btns.filter(b => b.act !== 'why')] : btns;
  const acts = ordered.map(one).join('');
  if (ui.artifactsOnly) return acts ? `<div class="tc-acts">${acts}</div>` : '';
  // 看原因：System 就地答一句（POST /api/tasks/<id>/why），不开对话。
  const why = ui.why?.id === c.id && (ui.why.busy || ui.why.content) ? `<div class="tc-why">${ui.faceOf('patch')}<p>${ui.why.busy ? '…' : esc(ui.why.content)}</p></div>` : '';
  const confirm = ui.confirm ? `<div class="tc-confirm">${esc(ui.confirm.text || '交出去就撤不回来了。')}<button type="button" class="tc-btn is-pri" data-tc-yes>确定</button><button type="button" class="tc-btn is-ghost" data-tc-no>先不</button></div>` : '';
  const then = n.then || [];
  const step = (s, i) => `<span class="tc-step${i === 0 && n.kind === 'you' ? ' is-now' : i === 0 && n.kind === 'run' ? ' is-run' : ''}">${s.who ? ui.faceOf(s.who) : ''}${esc(s.text)}</span>`;
  const plan = then.length ? `<div class="tc-plan">${then.map(step).join('<i>→</i>')}</div>` : '';
  // 失败已经有结构字段：原因和必要处理各显示一次，不再把三段模板及回执总结重复拼在一起。
  const f = n.failure;
  const said = f ? `<div class="tc-ask"><p>${esc(f.reason)}</p>${f.remedy && f.remedy !== f.reason ? `<p class="tc-remedy">${esc(f.remedy)}</p>` : ''}${f.impact && ![f.reason, f.remedy].includes(f.impact) ? `<details class="tc-impact"><summary>查看影响</summary><p>${esc(f.impact)}</p></details>` : ''}</div>` : n.text && !(done && ui.resultInHistory) && (done || tone !== 'is-plain' || !then.length || n.again) ? `<p class="tc-ask${tone === 'is-plain' ? ' is-plain' : ''}">${esc(n.text)}</p>` : '';
  const questions = (n.questions || []).length ? `<ol class="tc-questions">${n.questions.map(q => `<li><p>${esc(q.text)}</p>${q.options?.length ? `<div class="tc-question-options">${q.options.map(o => `<span>${esc(o)}</span>`).join('')}</div>` : ''}</li>`).join('')}</ol>` : '';
  const body = tone === 'is-plain' ? `${said}${confirm}${why}${plan}${acts ? `<div class="tc-acts">${acts}</div>` : ''}` : `${said}${questions}${acts ? `<div class="tc-acts">${acts}</div>` : ''}${confirm}${why}${plan}`;
  return `<div class="tc-sec2"><h3>${esc(done ? '结果' : c.intervention?.prompt || (n.kind === 'bad' ? '未完成' : n.kind === 'you' ? '需要你' : '进度'))}</h3><div class="tc-next ${tone}">${body}</div></div>`;
}
// 引擎自己用模型做的结果（lib/task-do.mjs）：正文，下面一行照什么做的。
const answerHtml = (c, faceOf, artifacts = '') => c.answer?.text ? `<div class="tc-sec2"><h3>结果</h3><div class="tc-answer">${faceOf(c.answer.by || c.owner?.id || 'team')}<p>${esc(c.answer.text)}</p>${(c.answer.basis || []).length ? `<small class="tc-basis">照：${esc(c.answer.basis.join('、'))}</small>` : ''}${artifacts}</div></div>` : '';
// 投递停下来的那一页（lib/task-card.mjs proof）：截图点开看大图；地址、停在哪一步；原始的码只在这里，卡上那一句是人话。
const webUrl = u => /^https?:\/\//i.test(String(u || ''));
const proofHtml = p => p ? `<details class="tc-sec2 tc-proof"><summary>详情与证据</summary>${p.screenshot ? `<a href="/api/evidence?file=${encodeURIComponent(p.screenshot)}" target="_blank" rel="noopener"><img class="tc-shot" alt="停下时的页面截图" loading="lazy" src="/api/evidence?file=${encodeURIComponent(p.screenshot)}"></a>` : ''}<dl class="ib-facts">${p.step ? `<dt>停在</dt><dd>${esc(p.step)}</dd>` : ''}${webUrl(p.url) ? `<dt>页面</dt><dd><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(clip(p.url, 70))}</a></dd>` : ''}${p.at ? `<dt>时间</dt><dd>${esc(clock(p.at))}</dd>` : ''}</dl></details>` : '';
export function taskCardHtml(c, v = {}, ui = {}) {
  if (!c?.id) return '';
  // 刚点、卡片还在路上（openTaskCard）：先放标题和状态，别的等它回来。
  if (c.loading) return `<section class="tc-card is-loading" data-card-view="${esc(c.id)}" aria-busy="true"><div class="tc-body"><button type="button" class="tc-crumb" data-tc-back>${CHEV_L}任务</button><div class="tc-h"><h2>${esc(c.title)}</h2>${dirChip(c)}</div></div></section>`;
  const faceOf = k => face(v, k === 'ai' ? 'executor' : k, 'tb-face');
  const live = LIVE.has(SIX[c.status]);
  // 「移动到」：和看板上拖到某一列是同一件事（card.board.moves，同一个 POST …/move { column }），键盘、触屏都走这里；
  // 不能去的那一列照样列出来，灰着写上原因。少用的安排（晚点再说、我自己来、恢复原任务）另放一小组，不算状态列。
  const moves = c.board?.moves || [], extra = (c.controls || []).filter(b => EXTRA.has(b.action)), busy = ui.move?.state === 'saving';
  const moveBtn = m => `<button type="button" data-task-column="${esc(m.column)}" data-control-id="${esc(c.id)}"${m.disabled || busy ? ` aria-disabled="true"${m.reason ? ` title="${esc(m.reason)}"` : ''}` : ''}>${esc(m.label)}${m.disabled && m.reason ? `<small>${esc(m.reason)}</small>` : ''}</button>`;
  const extraBtn = b => `<button type="button" data-task-control="${esc(b.action)}" data-control-id="${esc(b.task_id || c.id)}"${busy ? ' aria-disabled="true"' : ''}>${esc(b.label)}${MOVE_NOTE[b.action] ? `<small>${MOVE_NOTE[b.action]}</small>` : ''}</button>`;
  // 在卡片里移的：没移过去的原话、没能进行中的原因写在标题下面，不自己消失。
  const m = ui.move?.id === c.id && ui.move.state !== 'saving' ? ui.move : null;
  const moveNote = m ? `<p class="tc-colnote tc-movenote${m.state === 'failed' ? ' is-bad' : ' is-why'}" role="${m.state === 'failed' ? 'alert' : 'status'}"><span>${m.state === 'failed' ? `没移过去：${esc(m.err || '没保存上')}` : esc(m.err)}</span><button type="button" class="tc-colx" data-tc-movex aria-label="关闭">×</button></p>` : '';
  const controls = moves.length || extra.length ? `<details class="tc-move"><summary class="tc-btn">移动到${CHEV_D}</summary><div class="tc-move-list">${moves.length ? `<div role="group" aria-label="移动到">${moves.map(moveBtn).join('')}</div>` : ''}${extra.length ? `<div class="tc-move-more" role="group" aria-label="其他安排">${extra.map(extraBtn).join('')}</div>` : ''}</div></details>` : '';
  const goal = c.requirement || c.title || '';
  const req = ui.editing ? `<div class="tc-edit"><textarea data-tc-req rows="3" maxlength="2000" aria-label="要求">${esc(ui.reqDraft ?? goal)}</textarea><div class="tc-ebar"><button type="button" class="tc-btn is-pri" data-tc-save${ui.saving ? ' disabled' : ''}>保存</button><button type="button" class="tc-btn is-ghost" data-tc-unedit>取消</button><small>从下一步起生效</small></div></div>`
    : `<span class="tc-goal">${esc(goal)}</span>${live && !c.receipt_only ? '<button type="button" class="tc-btn is-link" data-tc-edit>改要求</button>' : ''}`;
  const l = c.lead;
  const fields = `<div class="tc-fields"><span>要做成什么</span><div>${req}</div>${l ? `<span>岗位</span><div><a href="${leadHref(l.rid)}" class="tc-job"${l.rid ? ` data-rid="${esc(l.rid)}"` : ''}>${esc(leadText(l))}</a></div>` : ''}<span>派给</span><div>${assignHtml(c, v)}</div></div>`;
  // 子任务：每一步带自己的卡（s.card），点了打开它；「+ 子任务」说一句话挂在这件下面（POST /api/tasks/<id>/subtask），派给照新建的规矩。
  const steps = (c.route || []).filter(s => s.card !== c.id || (c.route || []).length > 1);
  const subs = steps.length > 1 || steps.some(s => s.card && s.card !== c.id) ? `<ol class="tc-subs">${steps.map((s, i) => { const k = s.tone || 'queued', open = s.card && s.card !== c.id; return `<li class="is-${k}${open ? ' is-link' : ''}"${open ? ` data-tc-open="${esc(s.card)}" tabindex="0"` : ''}><span class="n">${SIX[s.status] === 'done' ? '✓' : i + 1}</span><div><b>${esc(s.label)}</b>${s.detail ? `<small>${withAi(s.detail)}</small>` : ''}</div>${dirChip(s)}</li>`; }).join('')}</ol>` : '';
  const sub = ui.sub?.open ? `<form class="tc-compose tc-subnew" id="tc-sub" autocomplete="off"><textarea name="text" rows="2" maxlength="500" required aria-label="子任务">${esc(ui.sub.draft || '')}</textarea><div class="tc-cbar">派给${pickHtml(v, ui.sub, 'data-sub-owner')}<button type="button" class="tc-btn is-ghost" data-sub-cancel>取消</button><button type="submit" class="tc-btn is-pri"${ui.sub.busy ? ' disabled' : ''}>加上</button></div>${ui.sub.err ? `<p class="tc-err" role="alert">${esc(ui.sub.err)}</p>` : ''}</form>` : '';
  const canAdd = !c.receipt_only && SIX[c.status] !== 'cancelled';
  const route = subs || sub ? `<div class="tc-sec2"><h3>子任务${canAdd && !ui.sub?.open ? '<button type="button" class="tc-btn is-link tc-subadd" data-sub-new>+ 子任务</button>' : ''}</h3>${subs}${sub}</div>` : canAdd ? '<div class="tc-add-sub"><button type="button" class="tc-btn is-link" data-sub-new>+ 子任务</button></div>' : '';
  const resultInHistory = c.next?.kind === 'done' && (c.next.buttons || []).length > 0 && (c.history || []).some(h => String(h.text || '').trim() === String(c.next.text || '').trim());
  const answered = c.answer?.text && SIX[c.status] === 'done';
  const next = answered ? '' : nextHtml(c, { ...ui, faceOf, resultInHistory });
  const answer = answerHtml(c, faceOf, answered ? nextHtml(c, { artifactsOnly: true }) : '');
  // 做了什么：按时间，谁说的写清（你下的指令、成员的回应）——文字里已经以名字开头的不再写一遍。
  const said = h => { const n = h.who ? nameOf(v, h.who) : ''; return n && !String(h.text || '').startsWith(n) ? `<b>${esc(n)}</b>：` : ''; };
  const history = [...(c.history || [])];
  // 旧回执有时只留下结果或等待原因。补进已有时间线；已在「接下来」、结果或时间线里的不重复，工具明细留在运行日志。
  const plain = t => String(t || '').replace(/\s+/g, ' ').trim();
  const shown = [...history.map(h => h.text), c.answer?.text].map(plain).filter(Boolean);
  // receipt 是同一次执行的摘要，不是新增进展。结构化失败 / 正文已有完整结果；旧卡只有动作时仍补其回执。
  const fallbackReceipt = !c.next?.failure && !c.answer?.text ? c.receipt : null;
  for (const [label, value] of [['', fallbackReceipt?.summary], ['卡在：', fallbackReceipt?.reason], ['下一步：', fallbackReceipt?.next]]) {
    const text = plain(value);
    if (!text || shown.some(s => s.includes(text)) || next.includes(esc(value))) continue;
    history.push({ at: c.updated_at, who: c.owner?.id || 'team', text: `${label}${value}` });
    shown.push(text);
  }
  const did = history.length ? `<div class="tc-sec2"><h3>做了什么</h3><ol class="tc-did">${history.map(h => `<li${h.who === 'you' ? ' class="is-you"' : ''}><time>${esc(clock(h.at))}</time>${faceOf(h.who || 'team')}<span>${said(h)}${withAi(h.text)}${(h.evidence || []).map(f => ` <a class="tc-ev" href="/api/evidence?file=${encodeURIComponent(f)}">${fileWord(f)}</a>`).join('')}</span></li>`).join('')}</ol></div>` : '';
  const o = c.origin || {}, FROM = { chat: '来自对话', cycle: '来自定时', you: '你新建的', page: '来自岗位页', inbox: '来自收件箱' };
  // origin.label：对话来的是会话标题（「来自对话「…」」），别的就是短名本身（岗位页、收件箱、定时周期、你新建的）。
  const fromIn = o.by === 'chat' ? `↩ 来自对话${o.label ? ` <b>「${esc(o.label)}」</b>` : ''}` : `↩ ${esc(o.label || FROM[o.by] || '')}`;
  const from = o.by === 'chat' && o.session_id ? `<button type="button" class="tc-from" data-tc-thread="${esc(o.session_id)}">${fromIn}</button>`
    : o.by === 'inbox' ? `<a class="tc-from" href="#inbox${o.message_id ? `?ask=${encodeURIComponent(o.message_id)}` : ''}">${fromIn}</a>`
    : o.by === 'page' && l?.rid ? `<a href="${leadHref(l.rid)}" class="tc-from" data-rid="${esc(l.rid)}">${fromIn}</a>` : o.by ? `<span class="tc-from">${fromIn.replace(/^↩ /, '')}</span>` : '';
  const log = `${c.log?.note ? `<small class="tc-log-note">${esc(c.log.note)}</small>` : ''}${c.log?.href ? `<a class="tc-btn tc-log" href="${esc(c.log.href)}">看运行日志</a>` : ''}${c.log?.history_href ? `<a class="tc-btn" href="${esc(c.log.history_href)}">查看岗位进展</a>` : ''}`;
  // 给这件活下指令（POST /api/tasks/<id>/say）：撤回的不显示；等你的时候这一句就是答它在等的事。
  const say = c.say ? c.say.enabled !== false : SIX[c.status] !== 'cancelled';
  // 成员对这句的回应（say 回来的 reply）：照它说的写在框上面，比如「先别投」撤回了这次投递、脚本类「这句记下了」。
  const reply = ui.sayReply?.id === c.id && ui.sayReply.text ? `<div class="tc-reply">${faceOf(ui.sayReply.who || 'team')}<p>${say && ui.sayReply.who ? `<b>${esc(nameOf(v, ui.sayReply.who))}</b>：` : ''}${esc(ui.sayReply.text)}</p></div>` : '';
  const sayBox = say ? `${reply}<form class="tc-say" id="tc-say" autocomplete="off"><textarea name="text" rows="1" maxlength="2000" required aria-label="给这件活下指令" placeholder="${esc(c.say?.placeholder || '给这件活下指令…')}">${esc(ui.sayDraft || '')}</textarea><button type="submit" class="tc-btn is-pri"${ui.saying ? ' disabled' : ''} aria-label="发出">↑</button>${ui.sayErr ? `<p class="tc-err" role="alert">${esc(ui.sayErr)}</p>` : ''}</form>` : '';
  const up = c.parent?.id ? `<button type="button" class="tc-up" data-tc-open="${esc(c.parent.id)}">${CHEV_L}${esc(c.parent.title || '上一级')}</button>` : '';
  return `<section class="tc-card" data-card-view="${esc(c.id)}"><div class="tc-body"><button type="button" class="tc-crumb" data-tc-back>${CHEV_L}任务</button>${up}<div class="tc-h"><h2>${esc(c.title)}</h2>${dirChip(c)}${controls}</div>${moveNote}${fields}${next}${answer}${route}${did}${proofHtml(c.proof)}</div>${sayBox}${from || log ? `<div class="tc-foot">${from}${log}</div>` : ''}</section>`;
}

// ── 列表：按目标归组 ───────────────────────────────────────────────────────────
const rowHtml = (v, c, { label = null } = {}) => `<div class="tb-lr${c.status === 'needs_you' ? ' is-hl' : ''}" data-card="${esc(c.id)}" tabindex="0">${face(v, c.owner, 'tb-face is-lg')}<div><div class="tb-lt">${label ? esc(label) : leadLink(c)}</div>${noteOf(c) ? `<div class="tb-ln${c.status === 'needs_you' ? ' is-you' : ''}">${esc(clip(noteOf(c), 120))}</div>` : ''}${fromChip(v, c) || c.routine ? `<div class="tb-lm">${fromChip(v, c)}${c.routine ? '<span class="tb-chip is-routine">定时</span>' : ''}</div>` : ''}</div><div class="tb-lr-r">${held(c) ? `<button type="button" class="tb-btn is-warn" data-release="${esc(c.id)}">在这台电脑上运行</button>` : stChip(c, c.status === 'needs_you' && c.wait ? WAIT[c.wait] : '')}<time>${esc(clock(c.status === 'done' ? c.done_at : c.updated_at))}</time></div></div>`;
export function routeRows(v, g, cards) {
  return (g.route || []).map(s => {
    const c = s.card && cards.find(x => x.id === s.card);
    if (c) return rowHtml(v, c, { label: kindLabel(v, s.kind) });
    if (s.state === 'skip') return `<div class="tb-lr is-skip">${face(v, s.owner, 'tb-face is-lg')}<div><div class="tb-lt">${esc(kindLabel(v, s.kind))}</div><div class="tb-ln">${esc(s.why || '跳过')}</div></div>${g.can_judge_first ? `<div class="tb-lr-r"><button type="button" class="tb-link" data-judge-first="${esc(g.id)}">改成先判断</button></div>` : ''}</div>`;
    return `<div class="tb-lr is-ghost">${face(v, s.owner, 'tb-face is-lg')}<div><div class="tb-lt">${esc(kindLabel(v, s.kind))}</div><div class="tb-ln">${esc(nameOf(v, s.owner))} · 等上一棒</div></div><div class="tb-lr-r"><span class="tb-st is-open">没开</span></div></div>`;
  }).join('');
}
export function goalHtml(v, g, cards) {
  const said = g.from?.by === 'team' ? `你 ${clock(g.created_at)} 在「团队」里说的` : g.from?.member ? `你 ${clock(g.created_at)} 跟 ${nameOf(v, g.from.member)} 说的` : clock(g.created_at);
  const halt = g.halt && !g.halt.answered ? `<div class="tb-halt"><b>${esc(g.halt.question)}</b><div class="tb-acts">${(g.halt.options || []).map(o => `<button type="button" class="tb-btn${o === '还投' ? ' is-warn' : ''}" data-answer="${esc(g.id)}" data-option="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>` : '';
  return `<section class="tb-goal${g.status === 'needs_you' ? ' is-you' : ''}" data-goal-box="${esc(g.id)}"><header class="tb-gh">${face(v, 'team', 'tb-face')}<b>${esc(g.title)}</b><small>${esc(said)}</small>${stChip(g)}</header>${halt}${routeRows(v, g, cards)}${g.status === 'done' && g.result ? `<div class="tb-gfoot">${esc(g.result)}</div>` : ''}</section>`;
}
export function listHtml(v = {}) {
  const cards = v.cards || [], goals = v.goals || [];
  const inGoal = new Set(goals.map(g => g.id));
  // 没有目标的卡：等你的、卡住的在前，其余按时间（服务端已按更新时间排好）。
  const rank = { needs_you: 0, stuck: 1, running: 2, queued: 3, unclaimed: 4, done: 5, cancelled: 6 };
  const rest = cards.filter(c => !c.goal || !inGoal.has(c.goal)).map((c, i) => [c, i]).sort((a, b) => (rank[a[0].status] ?? 9) - (rank[b[0].status] ?? 9) || a[1] - b[1]).map(x => x[0]);
  const body = goals.map(g => goalHtml(v, g, cards)).join('') + (rest.length ? `${goals.length ? '<h4 class="tb-sec">其他在做的</h4>' : ''}<div class="tb-goal">${rest.map(c => rowHtml(v, c)).join('')}</div>` : '');
  return body || '<p class="tb-empty">没有卡片。</p>';
}

// ── 页头：「任务」、按成员筛（头像加名字）、搜索、「+ 新建」 ─────────────────────────────
export function headHtml(v = {}, ui = {}) {
  const chips = `<div class="tc-mf" role="group" aria-label="成员"><button type="button" class="${!ui.owner ? 'is-on' : ''}" aria-pressed="${!ui.owner}" data-owner-chip="">全部</button>${(v.members || []).map(m => `<button type="button" class="${ui.owner === m.key ? 'is-on' : ''}" aria-pressed="${ui.owner === m.key}" data-owner-chip="${esc(m.key)}">${ui.owner === m.key ? '' : face(v, m.key, 'tb-face is-xs')}${esc(m.name)}</button>`).join('')}</div>`;
  const lead = ui.lead ? `<button type="button" class="tc-lead" data-clear-lead aria-label="不按岗位筛">#${esc(ui.lead)} ✕</button>` : '';
  return `<div class="tc-head"><h1>任务</h1>${chips}<div class="tc-tools">${lead}<input id="tb-q" type="search" placeholder="搜任务 / #编号" value="${esc(ui.q || '')}" aria-label="搜任务"><button type="button" class="tc-btn is-pri" data-new>+ 新建</button></div></div>`;
}
// 页面：没选的时候是看板；点开一件换成它的卡片（不把看板压窄），顶上「‹ 任务」回看板。
export function pageHtml(v = {}, ui = {}, card = null) {
  const nomodel = v.model && !v.model.ok && v.model.why !== 'sandbox' ? `<div class="tb-nomodel">现在没有能用的模型：需要模型的任务先排着，其余照常。<a href="#settings/model">设置模型</a></div>` : '';
  const slot = card?.error ? `<section class="tc-card is-empty"><div class="tc-body"><button type="button" class="tc-crumb" data-tc-back>${CHEV_L}任务</button><p class="tc-empty">${esc(card.error)}</p></div></section>` : card ? taskCardHtml(card, v, ui) : '';
  return `<div class="tb-page tc-page${slot ? ' has-card' : ''}${ui.sel && !ui.auto ? ' is-picked' : ''}">${headHtml(v, ui)}${nomodel}<div class="tc-cols"><section class="tc-dir"${ui.busy ? ' aria-busy="true"' : ''}>${composeHtml(v, ui)}${directoryHtml(v, ui)}</section>${slot ? `<div class="tc-slot">${slot}</div>` : ''}</div></div>`;
}

// ── 卡片详情（右侧面板「详情」）────────────────────────────────────────────────
// 证据链接写它是什么（日志、截图），文件名（「round-first-17….log」）只放在悬停提示里（N06）。
const fileWord = f => /\.log$/i.test(f) ? '日志' : /\.(png|jpe?g|webp)$/i.test(f) ? '截图' : '证据';
const field = (k, val) => val ? `<div class="tb-f"><span>${esc(k)}</span><div>${val}</div></div>` : '';
export function handoffHtml(v, h) {
  if (!h) return '';
  return `<section class="tb-ho"><h4>交接单 · ${esc(nameOf(v, h.from) || '你')} → ${esc(nameOf(v, h.to))}</h4>${[['事', h.what], ['线索', h.lead], ['JD 全文', h.jd], ['已经知道的', h.known], ['下一步', h.next], ['要用的文件', (h.files || []).join(' ')]].map(([k, x]) => x ? `<div class="tb-f"><span>${esc(k)}</span><div>${esc(x)}</div></div>` : '').join('')}</section>`;
}
export function detailHtml(d = {}, v = {}, ui = {}) {
  const c = d.card || {}, g = d.goal;
  const isGoal = c.kind === 'goal';
  const owner = c.owner && c.owner !== 'team' ? `${face(v, c.owner)}<b>${esc(nameOf(v, c.owner))}</b>` : isGoal ? `${face(v, 'team')}<b>团队</b>` : '<b>还没人认领</b>';
  const pick = !isGoal && !c.legacy ? `<select class="tb-pick" data-assign-pick="${esc(c.id)}" aria-label="换人"><option value="">换人</option>${(v.members || []).map(m => `<option value="${esc(m.key)}" ${v.kindById?.[c.kind]?.member && v.kindById[c.kind].member !== m.key ? 'class="is-off"' : ''}>${esc(m.name)}${v.kindById?.[c.kind]?.member && v.kindById[c.kind].member !== m.key ? '（它不管这类事）' : ''}</option>`).join('')}<option value="-">放回待认领</option></select>` : '';
  const from = c.from ? `${fromChip(v, c, { bare: true })}${d.parent ? `<small>接力：${esc(nameOf(v, d.parent.owner))} 做完${esc(kindLabel(v, d.parent.kind))}，交给它</small>` : ''}` : '';
  const said = g ? `${g.from?.by === 'team' ? `你 ${clock(g.created_at)} 在「团队」里说的` : ''}` : '';
  const lead = c.leads?.[0] ? `<a href="${leadHref(c.leads[0].rid)}" class="tb-lead" data-rid="${esc(c.leads[0].rid)}">#${esc(c.leads[0].number)} ${esc(c.leads[0].company)}${c.leads[0].role ? ` · ${esc(c.leads[0].role)}` : ''}</a>` : '';
  const ask = c.status === 'needs_you' && c.ask ? `<section class="tb-need"><h4>${esc(c.need_title || '需要你')}</h4>${c.ask.preview?.screenshot ? `<a class="tb-shot" href="/api/evidence?file=${encodeURIComponent(c.ask.preview.screenshot)}">申请页截图${(c.ask.preview.fields || []).length ? ` · ${c.ask.preview.fields.length} 项已填` : ''}</a>` : ''}<p>${esc(c.ask.question || c.detail)}</p>${(c.ask.form || []).length ? `<ul class="tb-form">${c.ask.form.map(f => `<li>${esc(f.label)}${f.value != null ? `<small>答案簿里有：${esc(f.value)}</small>` : ''}</li>`).join('')}</ul>` : ''}${askButtons(c, { all: true })}${ui.confirming === c.id ? `<div class="tb-confirm">「${esc(ui.confirmLabel)}」之后就交出去了，撤不回来。<button type="button" class="tb-btn is-warn" data-answer-yes="${esc(c.id)}" data-option="${esc(ui.confirmOption)}">确定</button><button type="button" class="tb-btn" data-answer-no>先不</button></div>` : ''}</section>` : c.status === 'needs_you' && !isGoal ? `<section class="tb-need"><h4>${esc(c.need_title || '需要你')}</h4><p>${esc(c.detail || '')}</p>${c.wait === 'local_ai' ? '' : `<div class="tb-acts"><a class="tb-btn is-warn" href="#inbox${c.links?.ask_id ? `?ask=${encodeURIComponent(c.links.ask_id)}` : ''}">回答</a></div>`}</section>` : '';
  const halt = isGoal && c.halt && !c.halt.answered ? `<section class="tb-need"><h4>需要你</h4><p>${esc(c.halt.question)}</p><div class="tb-acts">${c.halt.options.map(o => `<button type="button" class="tb-btn${o === '还投' ? ' is-warn' : ''}" data-answer="${esc(c.id)}" data-option="${esc(o)}">${esc(o)}</button>`).join('')}</div></section>` : '';
  // 列表里在目标框里展开的卡：目标的每一棒就在正上方，不再画一遍（视觉验收第 18 条）。
  const route = g && !ui.inGoal ? `<section class="tb-route">${routeRows(v, g, [...(d.siblings || []), ...(isGoal ? [] : [c])].map(x => x.id === c.id ? c : x))}</section>` : '';
  // 每一步：「Writer：Writer 认领了」这种名字重复的，只写一次。
  const stepText = s => { const n = nameOf(v, s.who); return n && String(s.text).startsWith(n + ' ') ? String(s.text).slice(n.length + 1) : s.text; };
  // 操作台跑的一轮：存着的步骤（谁认领、开始跑）后面接上这一轮实际做的每一步（lib/tasks.mjs runTrail：Radar 扫完、Judge 判断到第几个）。
  const allSteps = [...(c.steps || []), ...(c.run_steps || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const steps = allSteps.length ? `<section class="tb-steps"><h4>每一步</h4><ol>${allSteps.map(s => `<li><time>${esc(clock(s.at))}</time><span><b>${esc(nameOf(v, s.who))}</b>${s.tool ? ` · ${esc(HOW[s.tool]?.[1] || s.tool)}` : ''}：${esc(stepText(s))}${(s.evidence || []).map(f => ` <a class="tb-link" href="/api/evidence?file=${encodeURIComponent(f)}">证据</a>`).join('')}</span></li>`).join('')}</ol>${(c.evidence || []).length ? `<div class="tb-files">${c.evidence.map(f => `<a class="tb-link" href="/api/evidence?file=${encodeURIComponent(f)}">${fileWord(f)}</a>`).join('')}</div>` : ''}</section>` : '';
  const k = v.kindById?.[c.kind];
  const canRun = !c.legacy && !isGoal && c.owner && k && !c.links?.job_id && ['script', 'browser'].includes(k.how) && ['queued', 'stuck'].includes(c.status) && !c.links?.op_id && !c.mac_hold;
  const modelWait = !c.legacy && k?.how === 'model' && c.status === 'queued' && v.model && !v.model.ok;
  const acts = c.legacy ? '<p class="tb-legacy">旧记录，只读。</p>' : `<div class="tb-acts tb-moves">${held(c) ? `<button type="button" class="tb-btn is-pri" data-release="${esc(c.id)}">在这台电脑上运行</button>` : ''}${canRun ? `<button type="button" class="tb-btn is-pri" data-run="${esc(c.id)}">▶ 运行</button>` : ''}${modelWait ? `<button type="button" class="tb-btn" data-move="${esc(c.id)}" data-status="done">我自己做了 · 标为完成</button>` : !['done', 'cancelled'].includes(c.status) ? `<button type="button" class="tb-btn" data-move="${esc(c.id)}" data-status="done">标为完成</button>` : ''}${!['stuck', 'done', 'cancelled'].includes(c.status) && !isGoal ? `<button type="button" class="tb-btn" data-move="${esc(c.id)}" data-status="stuck">卡住了</button>` : ''}${!['done', 'cancelled'].includes(c.status) ? `<button type="button" class="tb-btn is-quiet" data-move="${esc(c.id)}" data-status="cancelled">取消</button>` : ''}${['stuck', 'cancelled'].includes(c.status) && !isGoal ? `<button type="button" class="tb-btn is-quiet" data-move="${esc(c.id)}" data-status="queued">放回排队</button>` : ''}</div>`;
  // 照实写：脚本里调了模型（首轮的 Judge）就是「用了模型」，带上用量；真没调才写「没用模型」（N06）。
  const how = c.used_model ? '<span class="tb-chip is-model">用了模型</span>' : HOW[c.how] ? `<span class="tb-chip is-${HOW[c.how][0]}">${esc(HOW[c.how][1])}</span>` : '';
  const cost = c.cost?.tokens ? `<small>${c.cost.calls ? `${esc(c.cost.calls)} 次 · ` : ''}${esc(c.cost.tokens.toLocaleString('zh-CN'))} token</small>` : c.cost?.calls ? `<small>${esc(c.cost.calls)} 次</small>` : c.used_model || c.how === 'model' || c.how === 'executor' ? '' : '<small>没用模型</small>';
  // 标题是短的那一行；执行器的长指令整句放在标题下面。卡片编号是内部的，不给你看。
  const head = titleOf(c), full = c.title && c.title !== head ? `<p class="tb-full">${esc(c.title)}</p>` : '';
  return `<div class="tb-detail" data-detail="${esc(c.id)}"><div class="tb-dtop"><small>${esc(c.legacy ? '旧记录' : c.adopted || String(head).includes(kindLabel(v, c.kind)) ? '' : kindLabel(v, c.kind))}</small><button type="button" class="tb-x" data-close-card aria-label="收起">✕</button></div><h2>${esc(head)}</h2>${full}<div class="tb-dchips">${stChip(c, c.status === 'needs_you' && c.wait ? WAIT[c.wait] : '')}${how}${cost}</div>
    ${field('谁在做', `${owner}${pick}`)}${field('来自', from)}${g && !isGoal ? field('为了', `<a class="tb-chip is-goal" href="#tasks?goal=${encodeURIComponent(g.id)}" data-goal="${esc(g.id)}">目标：${esc(g.title)}</a>`) : ''}${said ? field('', `<small>${esc(said)}</small>`) : ''}${field('岗位', lead)}${!['done', 'needs_you', 'cancelled'].includes(c.status) && noteOf(c) ? field('现在', esc(noteOf(c))) : ''}${c.result && c.status === 'done' ? field('结果', esc(c.result)) : ''}
    ${halt}${ask}${handoffHtml(v, c.handoff)}${route}${steps}${acts}</div>`;
}

// ── 页面 ──────────────────────────────────────────────────────────────────────
// #tasks?task=<id>（旧链接 card=<id> 也认）打开那一件；owner=quill 只看一位；lead=31 只看这条岗位；goal=<id> 只看这件事。
let H = null, V = null, C = null, sig = '';
// 点过的卡片留一份（id → 卡片）：再点它先画这一份，新的回来再换（实测 10-04 第 5 条）。
const cardCache = new Map();
const ui = { owner: '', lead: '', q: '', creating: false, draft: '', sel: null, auto: false, open: new Set(), editing: false, reqDraft: null, confirm: null };
const $ = s => document.querySelector(s);
export const tasksSig = () => sig;
export function viewModel(d = {}) {
  const members = d.members || [];
  return { ...d, byKey: Object.fromEntries(members.map(m => [m.key, m])), kindById: Object.fromEntries((d.kinds || []).map(k => [k.key, k])), goalById: Object.fromEntries((d.goals || []).map(g => [g.id, g])) };
}
const hashQ = () => new URLSearchParams(location.hash.split('?')[1] || '');
function readHash() {
  const q = hashQ();
  if (q.has('owner')) ui.owner = q.get('owner') || '';
  if (q.has('lead')) ui.lead = (q.get('lead') || '').replace(/^#/, '');
  ui.goal = q.get('goal') || '';
  const t = q.get('task') || q.get('card');
  if (t && t !== ui.sel) { ui.sel = t; ui.auto = false; ui.editing = false; ui.confirm = null; ui.why = null; ui.sub = null; ui.sayDraft = ''; ui.sayErr = ''; ui.sayReply = null; }
  // 从侧栏点「任务」进来（网址里没有 task=）：不接着开上次那件，先放目录。
  if (!t && !ui.auto) { ui.sel = null; ui.editing = false; ui.confirm = null; }
}
function setHash(id) {
  const [base, q = ''] = location.hash.split('?'), p = new URLSearchParams(q);
  p.delete('card'); if (id) p.set('task', id); else p.delete('task');
  history.replaceState(null, '', (base || '#tasks') + (p.toString() ? '?' + p : ''));
}
async function getCard(id) {
  try { const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/card`), d = await r.json(); if (!r.ok) return { id, error: d.error || '这件读不到了' }; const c = d.card || d; cardCache.set(id, c); return c; }
  catch { return { id, error: '这件读不到了' }; }
}
const listQuery = () => {
  const p = new URLSearchParams();
  if (ui.owner) { p.set('owner', ui.owner); p.set('member', ui.owner); }
  if (ui.lead) p.set('lead', ui.lead); if (ui.goal) p.set('goal', ui.goal); if (ui.q) p.set('q', ui.q);
  p.set('routine', '1'); // 独立的定时栏始终带上最近执行状态，不依赖展开动作。
  return p;
};
// 还没打开过任务页时先把目录拉下来（web/app.js 空闲时、鼠标移到左栏「任务」上时调），换过来就能当场画。
export async function tasksPrefetch(helpers) {
  if (V) return;
  H = H || helpers;
  try { const r = await fetch('/api/tasks?' + listQuery()), d = await r.json(); if (r.ok && !V) V = viewModel(d); } catch {}
}
export async function tasksPage(helpers) {
  H = helpers; readHash();
  const p = listQuery();
  const want = ui.sel && !ui.auto ? ui.sel : null;
  const [r, got] = await Promise.all([fetch('/api/tasks?' + p), want ? getCard(want) : null]);
  const d = await r.json();
  if (!r.ok) throw Error(d.error || '任务读取失败');
  V = viewModel(d);
  // 拉的这一会儿你又点了另一张（openTaskCard）：拉回来的是上一张，不用它，也不拿第一件顶掉你点的那张（实测 10-04 第 5、9 条）。
  const mine = ui.sel && !ui.auto ? ui.sel : null, picked = mine && mine === want ? got : null;
  // 同一个岗位并成一张的卡（lib/tasks.mjs foldSame）：点的是收起来的那张，就选留下的那张。
  const keep = mine && [...(V.cards || []), ...(V.goals || [])].find(c => (c.merged || []).includes(mine));
  if (keep) { ui.sel = keep.id; setHash(keep.id); }
  // 没选的时候只放看板，不替你开第一件。
  if (!mine) { ui.sel = null; ui.auto = false; }
  C = (!keep && picked) || (ui.sel ? await getCard(ui.sel) : null);
  const next = JSON.stringify([d.cards?.map(c => [c.id, c.status, c.updated_at]), d.goals?.map(g => [g.id, g.status, g.updated_at]), d.model?.ok, C?.updated_at, C?.status, C?.error]);
  // 正在拖一张卡：sig 先不换，web/app.js 后台刷新看它没变就不重画（重画会把手里那张卡打断）；松手以后再画。
  if (drag && sig) drag.stale ||= next !== sig; else sig = next;
  return pageHtml(V, ui, C);
}
// 换到任务页时先用手上这份目录画（web/app.js 换页立刻换）；选中的那件用点过时留下的卡片，没有就先放标题和状态。没拉过目录返回 null。
export function tasksNow() {
  if (!V || !H) return null;
  readHash();
  const want = ui.sel && !ui.auto ? ui.sel : null;
  if (want) C = cardCache.get(want) || placeholder(want);
  else { ui.sel = null; ui.auto = false; C = null; }
  return pageHtml(V, ui, C);
}
const placeholder = id => { const row = [...(V?.cards || []), ...(V?.goals || [])].find(c => c.id === id); return { id, title: row ? titleOf(row) : '', word: row?.word, tone: row?.tone, status: row?.raw_status || row?.status, loading: true }; };
// web/app.js 每次画完任务页调：正在写的那一句、正在改的要求，重画以后光标还在原处。
export function tasksAfter() {
  bindTasks();
  const el = { new: () => $('#tc-new textarea'), req: () => $('[data-tc-req]'), sub: () => $('#tc-sub textarea'), say: () => $('#tc-say textarea') }[tasksAfter.focus]?.() || null;
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  tasksAfter.focus = null;
  // 从卡片回看板：焦点回到刚才那张。
  const back = tasksAfter.back && !ui.sel ? document.querySelector(`#main .tc-board [data-task="${CSS.escape(tasksAfter.back)}"]`) : null;
  if (back) { back.focus({ preventScroll: true }); back.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  if (!ui.sel) tasksAfter.back = null;
}
const post = (path, body = {}) => H.post(path, body);
// 点了就先按手上的数据画一次（筛选的高亮、展开、新建框当场就有），再拉新的就地更新。
async function rerender() { sig = ''; if (pageEl() && V) H?.paintNow?.(pageHtml(V, { ...ui, busy: true }, C)); await H?.refresh?.(); }
async function act(fn, ok) { try { const r = await fn(); if (ok) H?.toast?.(ok); await rerender(); return r; } catch (e) { H?.toast?.(e.message); } }
// 在主区域打开一件（对话里的小条、成员页、收件箱都走这里）：不在任务页就先过去。
export function openTaskCard(id) {
  if (!id) return;
  ui.sel = id; ui.auto = false; ui.editing = false; ui.confirm = null; ui.why = null; ui.sub = null; ui.sayDraft = ''; ui.sayErr = ''; ui.sayReply = null;
  if (!location.hash.startsWith('#tasks')) { location.hash = `#tasks?task=${encodeURIComponent(id)}`; return; }
  setHash(id);
  // 点了就换（实测 10-04 第 5、9 条）：高亮、右边的卡片当场换成这一件（点过的先用留着的那份，没点过的先放标题和状态），
  // 窄窗口只放卡片、滚到它；只拉这一张卡片，回来就画上。整页的刷新照常排在后面，不再等它。
  if (pageEl()) { pickNow(id); getCard(id).then(card => { if (ui.sel === id && !ui.auto && pageEl()) { C = card; paintSlot(card); } }); }
  rerender();
}
// 页面上已经画着的任务页：不重画整页，只改高亮、分栏和右边那张卡片。
function pageEl() { if (typeof document === 'undefined') return null; const p = document.querySelector('#main .tc-page'); return p && document.querySelector('#main')?.dataset.page === 'tasks' ? p : null; }
function paintSlot(card) {
  const page = pageEl(); if (!page || !card) return;
  let slot = page.querySelector('.tc-slot');
  if (!slot) { slot = document.createElement('div'); slot.className = 'tc-slot'; page.querySelector('.tc-cols')?.append(slot); }
  morph(slot, card.error ? `<section class="tc-card is-empty"><div class="tc-body"><button type="button" class="tc-crumb" data-tc-back>${CHEV_L}任务</button><p class="tc-empty">${esc(card.error)}</p></div></section>` : taskCardHtml(card, V || {}, ui));
  page.classList.add('has-card', 'is-picked');
  const top = slot.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight - 80) slot.scrollIntoView({ block: 'start' });
}
function pickNow(id) {
  const page = pageEl(); if (!page) return;
  page.querySelectorAll('.tc-row.is-sel').forEach(r => r.classList.remove('is-sel'));
  page.querySelector(`.tc-row[data-task="${CSS.escape(id)}"]`)?.classList.add('is-sel');
  const had = cardCache.get(id);
  if (had) { C = had; return paintSlot(had); }
  C = placeholder(id);
  paintSlot(C);
}
export const openTaskId = () => (location.hash.startsWith('#tasks') && ui.sel && !ui.auto ? ui.sel : null);
// 回答一件「等你」：和收件箱同一封（POST /api/inbox/answer）；要确认的先在卡上问一句。
async function answerAsk(id, key, extra = {}) {
  try {
    const r = await post('/api/inbox/answer', { id, option: key, ...extra });
    if (r.needs_confirm) { ui.confirm = { id, key, text: r.preview?.kind === 'record' ? r.preview.text : r.confirm_text || '' }; return rerender(); }
    ui.confirm = null;
    // 选项要页面做的那一步（定制版的「打开看看」= 跳到材料页那一版）：和收件箱、对话、指挥台一样真的做（10-04：以前卡上点了没反应）。
    if (r.client?.navigate) { location.hash = r.client.navigate; return; }
    if (r.client?.draft_editor) { openDraftEditor(r.client.draft_editor); return; }
    if (r.client?.profile_editor) { openEditor(r.client.profile_editor, H, r.client.profile_context); return; }
    if (r.receipt) H?.toast?.(r.receipt);
  } catch (e) { H?.toast?.(e.message); } // 和收件箱一样照服务端的原话说（打开申请页这类只是打开页面，不是「没交上去」）
  setTimeout(rerender, 600);
}
// 移到某一列（拖动和「移动到」同一个）：POST …/move { column }，一次只发一件；保存中写在要去的那一列顶上。
// 没移过去：照服务器原话写在那一列，并拉回真实状态（手上的 moves 可能过时，服务器会再查）；
// 移了但没能进行中（why：还在排队、要你补一步、没做成）：写在它真实所在的那一列，也弹一句。两种都不自己消失。
let drag = null, dragEnd = 0, stopDrag = null;
// app.js 所有重画入口共用：同一张看板的拖动先做完，连延时普通刷新也不换掉手里的卡。
export function holdTasksPaint(hash) {
  if (!drag) return false;
  if (drag.hash !== hash) { stopDrag?.(); return false; }
  drag.stale = true;
  return true;
}
const rowOf = id => [...(V?.cards || []), ...(V?.goals || [])].find(c => c.id === id);
const repaint = () => { if (pageEl() && V) H?.paintNow?.(pageHtml(V, ui, C)); };
async function moveTo(id, column) {
  if (ui.move?.state === 'saving') return;
  const title = titleOf(rowOf(id) || (C?.id === id ? C : {}));
  ui.move = { id, to: column, state: 'saving' };
  repaint();
  try {
    const r = await post(`/api/tasks/${encodeURIComponent(id)}/move`, { column });
    ui.move = r?.why ? { id, state: 'why', err: r.why, title } : null;
    H?.toast?.(r?.why || r?.receipt || (r?.card?.word ? `现在：${r.card.word}` : '任务安排已保存'));
  } catch (err) { ui.move = { id, to: column, state: 'failed', err: err.message }; }
  cardCache.delete(id);
  await rerender();
}
function onClick(e) {
  const t = e.target.closest('button, a, select, summary, [data-task], [data-tc-open]');
  // 点在「移动到」外面：收起它。
  document.querySelectorAll('#main .tc-move[open]').forEach(m => { if (!m.contains(e.target)) m.open = false; });
  if (!t || t.matches('select, summary')) return;
  // 刚拖完松手的那一下不当成点开。
  if (Date.now() - dragEnd < 300 && t.matches('[data-task]')) return;
  const d = t.dataset, id = C?.id;
  if (t.getAttribute('aria-disabled') === 'true') return;
  if (d.tcMovex !== undefined) { ui.move = null; return repaint(); }
  if (d.taskColumn) { t.closest('.tc-move')?.removeAttribute('open'); return moveTo(d.controlId || id, d.taskColumn); }
  if (d.taskControl) { if (ui.move?.state === 'saving') return; ui.move = null; t.disabled = true; return act(() => post(`/api/tasks/${encodeURIComponent(d.controlId || id)}/move`, { control: d.taskControl })); }
  if (d.ownerChip !== undefined) { ui.owner = d.ownerChip; return rerender(); }
  if (d.fold) { ui.open.has(d.fold) ? ui.open.delete(d.fold) : ui.open.add(d.fold); return rerender(); }
  if (d.clearLead !== undefined) { ui.lead = ''; const [base, q = ''] = location.hash.split('?'), p = new URLSearchParams(q); p.delete('lead'); history.replaceState(null, '', base + (p.toString() ? '?' + p : '')); return rerender(); }
  if (d.new !== undefined) { if (ui.sel) { ui.sel = null; C = null; setHash(null); } ui.creating = true; ui.newErr = ''; tasksAfter.focus = 'new'; return rerender(); }
  if (d.newCancel !== undefined) { ui.creating = false; ui.draft = ''; ui.newSuggest = ui.newOwner = ui.newAssign = null; return rerender(); }
  if (d.tcBack !== undefined) { tasksAfter.back = ui.sel; ui.sel = null; ui.auto = false; C = null; setHash(null); return rerender(); }
  if (d.tcEdit !== undefined) { ui.editing = true; ui.reqDraft = null; tasksAfter.focus = 'req'; return rerender(); }
  if (d.tcUnedit !== undefined) { ui.editing = false; ui.reqDraft = null; return rerender(); }
  if (d.tcSave !== undefined && id) { const v = ($('[data-tc-req]')?.value || '').trim(); ui.saving = true; return act(async () => { try { await post(`/api/tasks/${encodeURIComponent(id)}/edit`, { requirement: v }); ui.editing = false; ui.reqDraft = null; } finally { ui.saving = false; } }, '要求已保存，从下一步起生效'); }
  if (d.resumePrefill) { t.disabled = true; return act(async () => { const r = await post(`/api/tasks/${encodeURIComponent(d.resumePrefill)}/resume-prefill`); if (r.receipt) H?.toast?.(r.receipt); return r; }); }
  if (d.tcMove && id) { if (d.tcMove === 'done') { ui.confirm = { move: 'done', id, text: '确认这件事已经做完？标为完成会让后续步骤接着做。' }; return rerender(); } t.disabled = true; return act(() => post(`/api/tasks/${encodeURIComponent(id)}/move`, { status: d.tcMove })); }
  if (d.tcRelease !== undefined && id) { t.disabled = true; return act(() => post(`/api/tasks/${encodeURIComponent(id)}/release`), '开始跑了'); }
  if (d.tcAnswer) { t.disabled = true; return answerAsk(d.tcAnswer, d.key); }
  if (d.tcYes !== undefined && ui.confirm?.move) { const c = ui.confirm; ui.confirm = null; return act(() => post(`/api/tasks/${encodeURIComponent(c.id)}/move`, { status: c.move, confirm: true })); }
  if (d.tcYes !== undefined && ui.confirm) return answerAsk(ui.confirm.id, ui.confirm.key, { confirm: true });
  if (d.tcNo !== undefined) { ui.confirm = null; return rerender(); }
  if (d.tcWhy) { ui.why = { id: d.tcWhy, busy: true }; rerender(); return post(`/api/tasks/${encodeURIComponent(d.tcWhy)}/why`).then(r => { ui.why = { id: d.tcWhy, content: r.content || '说不上来' }; }).catch(err => { ui.why = { id: d.tcWhy, content: err.message }; }).finally(rerender); }
  if (d.tcOpen) return openTaskCard(d.tcOpen);
  if (d.subNew !== undefined) { ui.sub = { open: true, draft: '' }; tasksAfter.focus = 'sub'; return rerender(); }
  if (d.subCancel !== undefined) { ui.sub = null; return rerender(); }
  if (d.tcTalk !== undefined) return window.OfferCrew?.openThread?.(d.tcTalk, { anchor: d.mid || null });
  if (d.tcThread) return window.OfferCrew?.openThread?.(d.tcThread);
  if (d.tcResult) { e.preventDefault(); setLeadOrigin({ hash: location.hash || '#tasks', label: '任务', list: [d.tcResult], rid: d.tcResult }); location.hash = '#lead/' + encodeURIComponent(d.tcResult); return; }
  if (d.rid && (t.classList.contains('tc-job') || t.classList.contains('tc-from') || t.classList.contains('tb-lead'))) { e.preventDefault(); setLeadOrigin({ hash: location.hash || '#tasks', label: '任务', list: [d.rid], rid: d.rid }); location.hash = '#lead/' + encodeURIComponent(d.rid); return; }
  if (t.tagName === 'A' && t.getAttribute('href') === '#') { e.preventDefault(); return; }
  if (d.task && t.classList.contains('tc-row')) { if (ui.sel === d.task && !ui.auto) return; return openTaskCard(d.task); }
}
function onKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tc-row') && e.target.dataset.task) { e.preventDefault(); return openTaskCard(e.target.dataset.task); }
  if (e.key === 'Escape') { const m = e.target.closest?.('.tc-move[open]'); if (m) { m.open = false; m.querySelector('summary')?.focus(); return; } }
  if (e.key === 'Enter' && e.target.dataset?.tcOpen) return openTaskCard(e.target.dataset.tcOpen);
  // 下指令的框：Enter 发出，Shift+Enter 换行。
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.closest?.('#tc-say')) { e.preventDefault(); e.target.closest('form').requestSubmit(); }
}
function onChange(e) {
  const s = e.target;
  if (s.dataset?.tcAssign) return act(() => post(`/api/tasks/${encodeURIComponent(s.dataset.tcAssign)}/assign`, { owner: s.value }), `派给了 ${nameOf(V, s.value)}`);
  if (s.dataset?.newOwner !== undefined) { ui.newOwner = s.value || null; return rerender(); }
  if (s.dataset?.subOwner !== undefined && ui.sub) { ui.sub.owner = s.value || null; return rerender(); }
}
// 写着要做的事时问 System 建议谁做（GET /api/talk/parse 的 persona；带 task.assign 的照它定能不能换）。
let parseSeq = 0;
// 建议谁做：新建框（ui.newSuggest / newAssign）和「+ 子任务」（ui.sub.suggest / assign）同一套。
export function suggestion(x, byKey = {}) {
  const k = x?.task?.assign?.suggested || x?.persona || null;
  return { assign: x?.task?.assign ? { ...x.task.assign, owner: x.task.assign.owner || x.task.owner || null } : null, suggest: k && byKey[k] ? k : null };
}
async function suggestFor(text, where = 'new') {
  const seq = ++parseSeq;
  const set = g => { if (where === 'sub') { if (ui.sub) Object.assign(ui.sub, g); } else { ui.newAssign = g.assign; ui.newSuggest = g.suggest; } };
  const now = () => where === 'sub' ? [ui.sub?.suggest, ui.sub?.assign?.fixed] : [ui.newSuggest, ui.newAssign?.fixed];
  if (!text) { set({ assign: null, suggest: null }); return; }
  try {
    const r = await fetch('/api/talk/parse?text=' + encodeURIComponent(text.slice(0, 500))), x = await r.json(); if (seq !== parseSeq || !r.ok) return;
    const was = now(); set(suggestion(x, V?.byKey || {}));
    const is = now(); if (was[0] !== is[0] || was[1] !== is[1]) { tasksAfter.focus = where; rerender(); }
  } catch {}
}
export function bindTasks() {
  const main = $('#main');
  if (!main || main.dataset.tbBound) return;
  main.dataset.tbBound = '1';
  const here = () => main.dataset.page === 'tasks' || location.hash.startsWith('#tasks');
  // 看板拖动：拿起一张卡，每一列照这张卡的 board.moves 标上能落（is-can）/ 不能落（is-no，淡下去）；停在不能落的一列，
  // 列上写一句原因（data-why，只在停着的时候出现），不接这次投放。松手、Esc、拖出去都清掉高亮。
  const cols = () => main.querySelectorAll('.tc-board .tc-col[data-group]');
  const colAt = e => e.target.closest?.('.tc-board .tc-col[data-group]') || null;
  const over = col => cols().forEach(x => x !== col && x.classList.remove('is-over', 'is-reject'));
  let scrollFrame = null;
  const cancelScroll = () => { if (scrollFrame !== null) cancelAnimationFrame(scrollFrame); scrollFrame = null; };
  // 拖到看板左右边缘时移动到屏幕外的状态列；长列内上下滚动，不带动整页横向溢出。
  const scrollEdge = () => {
    scrollFrame = null;
    const board = main.querySelector('.tc-board'), p = drag?.point;
    if (!board || !p) return;
    const r = board.getBoundingClientRect(), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    if (p.y < top || p.y > bottom || p.x < r.left || p.x > r.right) return;
    const speed = (at, lo, hi) => { const edge = Math.min(64, (hi - lo) / 4); return edge > 0 ? at < lo + edge ? -Math.ceil(12 * (lo + edge - at) / edge) : at > hi - edge ? Math.ceil(12 * (at - hi + edge) / edge) : 0 : 0; };
    const beforeX = board.scrollLeft; board.scrollLeft += speed(p.x, r.left, r.right);
    const col = document.elementFromPoint(p.x, p.y)?.closest?.('.tc-board .tc-col'), body = col?.querySelector('.tc-colbody');
    const beforeY = body?.scrollTop;
    if (body) { const b = body.getBoundingClientRect(); body.scrollTop += speed(p.y, Math.max(top, b.top), Math.min(bottom, b.bottom)); }
    if (board.scrollLeft !== beforeX || (body && body.scrollTop !== beforeY)) scrollFrame = requestAnimationFrame(scrollEdge);
  };
  const stop = () => {
    const d = drag; drag = null; dragEnd = Date.now();
    cancelScroll();
    main.querySelector('.tc-page')?.classList.remove('is-dragging');
    main.querySelectorAll('.tc-tk.is-lift').forEach(x => x.classList.remove('is-lift'));
    cols().forEach(x => { x.classList.remove('is-over', 'is-reject', 'is-can', 'is-no', 'is-from'); delete x.dataset.why; });
    return d;
  };
  stopDrag = stop;
  main.addEventListener('dragstart', e => {
    const row = e.target.closest?.('.tc-tk[data-task]'); if (!here() || !row) return;
    if (ui.move?.state === 'saving') return e.preventDefault();
    const c = rowOf(row.dataset.task), moves = movesOf(c);
    drag = { id: row.dataset.task, hash: location.hash, from: c?.board?.column || row.dataset.st, moves, no: null, rejectedDrop: null, stale: false, point: null };
    e.dataTransfer.setData('application/x-offercrew-task', drag.id); e.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-lift'); main.querySelector('.tc-page')?.classList.add('is-dragging');
    cols().forEach(x => {
      const m = moves[x.dataset.group], ok = !!m && !m.disabled;
      x.classList.add(ok ? 'is-can' : 'is-no'); x.classList.toggle('is-from', x.dataset.group === drag.from);
      if (!ok) x.dataset.why = m?.reason || '刷新页面后再试';
    });
  });
  main.addEventListener('dragover', e => {
    if (!drag || !here()) return;
    drag.rejectedDrop = null;
    drag.point = { x: e.clientX, y: e.clientY };
    if (scrollFrame === null) scrollFrame = requestAnimationFrame(scrollEdge);
    const col = colAt(e); over(col);
    if (!col) { drag.no = null; return; }
    const m = drag.moves[col.dataset.group];
    if (m && !m.disabled) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('is-over'); drag.no = null; }
    else { col.classList.add('is-reject'); drag.no = { column: col.dataset.group, reason: col.dataset.why }; }
  });
  main.addEventListener('dragleave', e => {
    if (!drag || !here()) return;
    // Chromium 在不能落的列松手时先发 relatedTarget=null 的 dragleave，再发 dragend。
    // 暂存这次拒绝；dragend 还要核对鼠标确实停在该列。Esc 直接结束拖动，不记成一次投放。
    if (!e.relatedTarget && drag.no?.column === colAt(e)?.dataset.group) drag.rejectedDrop = drag.no;
    if (!e.relatedTarget?.closest?.('.tc-board .tc-col')) { over(null); drag.no = null; }
    if (e.relatedTarget && !e.relatedTarget.closest?.('.tc-board')) { drag.point = null; cancelScroll(); }
  });
  main.addEventListener('drop', e => {
    if (!drag || !here()) return;
    const col = colAt(e), m = col && drag.moves[col.dataset.group];
    if (!m || m.disabled) return;
    e.preventDefault(); const d = stop(); moveTo(d.id, m.column);
  });
  main.addEventListener('dragend', e => {
    if (!drag) return;
    const d = stop();
    // 松在不能落的那一列：原因留在那一列顶上，不是悄悄没反应（放回原来那一列就只是放下）。
    const no = d.rejectedDrop, col = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.tc-board .tc-col[data-group]');
    if (no && no.column !== d.from && col?.dataset.group === no.column && e.dataTransfer?.dropEffect === 'none') { ui.move = { id: d.id, to: no.column, state: 'failed', err: no.reason }; repaint(); }
    if (d.stale) { sig = ''; H?.refresh?.({ soft: true }); }
  });
  main.addEventListener('click', e => { if (here()) onClick(e); });
  main.addEventListener('keydown', e => { if (here()) onKey(e); });
  main.addEventListener('change', e => { if (here()) onChange(e); });
  main.addEventListener('input', e => {
    if (!here()) return; const t = e.target;
    // 搜索框就在主区、正有焦点：要强制重画一次（app.js 平时不在你打字时重画），画完把焦点和光标放回去。
    if (t.id === 'tb-q') { clearTimeout(t._t); t._t = setTimeout(() => { ui.q = t.value.trim(); sig = ''; H?.refresh?.({ force: true }).then(() => { const x = document.getElementById('tb-q'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }); }, 300); }
    if (t.closest?.('#tc-new') && t.name === 'text') { ui.draft = t.value; clearTimeout(suggestFor.t); suggestFor.t = setTimeout(() => suggestFor(t.value.trim()), 300); }
    if (t.dataset?.tcReq !== undefined) ui.reqDraft = t.value;
    if (t.closest?.('#tc-say')) ui.sayDraft = t.value;
    if (t.closest?.('#tc-sub') && ui.sub) { ui.sub.draft = t.value; clearTimeout(suggestFor.s); suggestFor.s = setTimeout(() => suggestFor(t.value.trim(), 'sub'), 300); }
  });
  main.addEventListener('submit', e => {
    if (e.target.id === 'tc-say' || e.target.id === 'tc-sub') { e.preventDefault(); return e.target.id === 'tc-say' ? sayTo(e.target) : addSub(e.target); }
    if (e.target.id !== 'tc-new') return;
    e.preventDefault();
    const text = String(new FormData(e.target).get('text') || '').trim();
    if (!text) return;
    const owner = ui.newOwner && ui.newOwner !== ui.newSuggest ? ui.newOwner : null;
    ui.newBusy = true; ui.newErr = '';
    // 按岗位筛着（#tasks?lead=31，岗位上点进来的）新建：这件活带着这条岗位。投递、联系先弹确认框（和对话里「投 1」同一个），取消就什么都不做。
    const body = { text, ...(owner ? { owner } : {}), ...(ui.lead ? { lead: ui.lead } : {}) };
    confirmed('/api/tasks', body)
      .then(r => { ui.creating = false; ui.draft = ''; ui.newSuggest = ui.newOwner = ui.newAssign = null; const nid = r?.id || r?.card?.id; if (nid) { ui.sel = nid; ui.auto = false; setHash(nid); } })
      .catch(err => { ui.newErr = err.message; })
      .finally(() => { ui.newBusy = false; rerender(); });
  });
}
// 新建、加子任务：服务端认出是投递或联系，先回 needs_confirm 和预览（lib/task-api.mjs confirmFor）。弹确认框（web/command.js confirmPreview，
// 指挥台和对话共用的那个）；确认了带 confirm: true 再来一次才开，取消就什么都不建，回一句。→ 建好的结果，或者 null（取消了）
async function confirmed(url, body) {
  const r = await post(url, body);
  if (!r?.needs_confirm) return r;
  const { confirmPreview } = await import('./command.js');
  if (!(await confirmPreview(r))) { H?.toast?.(`好，先不${r.plan === 'contact' ? '联系' : '投'}了。什么都没做。`); return null; }
  return post(url, { ...body, confirm: true });
}
// 给这件活下指令：回来的卡片就地重画（POST /api/tasks/<id>/say → { card, reply? }）。没发出去的那句留在框里。
async function sayTo(form) {
  const id = C?.id, text = String(new FormData(form).get('text') || '').trim();
  if (!id || !text || ui.saying) return;
  ui.saying = true; ui.sayErr = '';
  try { const r = await post(`/api/tasks/${encodeURIComponent(id)}/say`, { text }); ui.sayDraft = ''; if (r?.card?.id === id) C = r.card; ui.sayReply = r?.reply?.text ? { id, who: r.reply.who || null, text: r.reply.text } : null; }
  catch (err) { ui.sayErr = err.message; }
  finally { ui.saying = false; tasksAfter.focus = 'say'; rerender(); }
}
// 加一件子任务：只在改了人时带 owner（照新建）；建好了留在这张卡上，子任务那一块多出一步。
async function addSub(form) {
  const id = C?.id, text = String(new FormData(form).get('text') || '').trim();
  if (!id || !text || !ui.sub || ui.sub.busy) return;
  const owner = ui.sub.owner && ui.sub.owner !== ui.sub.suggest ? ui.sub.owner : null;
  ui.sub.busy = true; ui.sub.err = '';
  try { const r = await confirmed(`/api/tasks/${encodeURIComponent(id)}/subtask`, { text, ...(owner ? { owner } : {}) }); if (r?.card?.id === id) C = r.card; ui.sub = null; }
  catch (err) { if (ui.sub) { ui.sub.busy = false; ui.sub.err = err.message; } }
  rerender();
}
export function initTasks() {
  if (initTasks.done || typeof window === 'undefined') return;
  initTasks.done = true;
  window.OfferCrew = window.OfferCrew || {};
  window.OfferCrew.openTaskCard = openTaskCard;
  window.OfferCrew.openTaskId = openTaskId;
  // 旧的叫法（收件箱、指挥台里「在任务板上看」）：一样在主区域打开卡片。
  window.OfferCrew.openCard = openTaskCard;
}
