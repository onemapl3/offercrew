// 材料 · 求职信 / 自我介绍的页面（2026-10-02，设计说明 3.7 和第 10 节）：和简历页同一种页面。
//   正文就是一张纸，点进去就改；停下 700 ms 自动保存（带 rev，409 = 别处改过，重新载入）；⌘Z / ⇧⌘Z 和顶栏的撤销走服务端的历史。
//   Writer「改一版」：对话里先问几句（POST /api/resume {action:'letter_rewrite', key} → 面板打开到那一段，Writer 选好），
//   答完写成这封信的新一版，对话里一张版本卡片「打开」。几版之间顶栏切换；「用这封」以后这一版用在它的岗位上。
//   核对没过（10-03）：Writer 写的、没过的句子在纸上标出来，纸上方一栏列出每一句和原因（点一句就选中它）；「按原简历改掉这几处」让 Writer
//   只重写这几句（letter_fix）。改到核对通过才有「用这封」。你打字时标记跟着走：改掉的那句标记就消失。
// 数据：GET /api/resume/letter?key=…（lib/resume-letters.mjs letterView）；写都是 POST /api/resume。
import { esc } from './resume-paper.js';
import { getJson, act } from './resume-api.js';
import { faceHtml } from './crew-faces.js';

let C = null, M = null;
const $ = s => document.querySelector(s);
export const letterHash = key => `#materials/letter?key=${encodeURIComponent(key)}`;
export const letterSig = () => M ? `letter:${M.key}:${M.shown}` : null;
let seq = 0;
const STATE = { chosen: ['在用', 'is-use'], proposed: ['等你确认', 'is-wait'], failed: ['核对没过', 'is-fail'], declined: ['不用', 'is-quiet'] };

export async function letterPage(ctx, route) {
  C = ctx;
  if (M && M.key === route.key && $('#rs[data-route="letter"]')) return html();
  await flush();
  let view;
  try { view = await getJson(`/api/resume/letter?key=${encodeURIComponent(route.key || '')}`); }
  catch (e) { M = null; return `<div class="rs" id="rs" data-route="letter"><p class="rs-error">${esc(e.message)}</p></div>`; }
  M = { key: view.letter.key, view, rev: view.letter.rev, text: view.letter.text, status: 'saved', timer: null, q: Promise.resolve(), shown: ++seq };
  return html();
}
export function leaveLetter() { if (M?.timer) flush(); M = null; }
function html() {
  return `<div class="rs is-edit is-letter" id="rs" data-route="letter"><header class="rs-bar" id="rs-bar">${barHtml()}</header><div class="rs-desk"><section class="rs-lcheck" id="rs-lcheck"${checkHtml() ? '' : ' hidden'}>${checkHtml()}</section><div class="rs-sheet is-edit rs-lsheet" lang="${M.view.letter.lang === 'zh' ? 'zh-CN' : 'en'}"><div class="rs-lwrap"><div class="rs-lmarks" id="rs-lmarks" aria-hidden="true">${marksHtml(M.text)}</div><textarea id="rs-ltext" class="rs-ltext" spellcheck="false" aria-label="${esc(M.view.letter.title)}">${esc(M.text)}</textarea></div></div></div></div>`;
}
// 没过的句子在纸上的位置（按现在纸上的字找：你改掉的那句就找不到了，标记跟着消失）。
function spans(text) {
  const out = [];
  for (const [i, f] of (M.view.letter.flags || []).entries()) {
    const at = f.text ? text.indexOf(f.text) : -1;
    if (at >= 0 && !out.some(x => at < x.end && x.start < at + f.text.length)) out.push({ i, start: at, end: at + f.text.length });
  }
  return out.sort((a, b) => a.start - b.start);
}
function marksHtml(text) {
  let out = '', pos = 0;
  for (const x of spans(text)) { out += esc(text.slice(pos, x.start)) + `<mark>${esc(text.slice(x.start, x.end))}</mark>`; pos = x.end; }
  return out + esc(text.slice(pos)) + '\n';
}
function checkHtml() {
  const L = M.view.letter, flags = L.flags || [], text = $('#rs-ltext')?.value ?? M.text;
  if (!flags.length && !L.length) return '';
  const here = new Set(spans(text).map(x => x.i)), fix = L.fix;
  const head = flags.length ? `<b>${flags.length} 句核对没过</b>` : `<b>核对没过</b>`;
  const act = fix?.can ? `<button type="button" class="rs-btn is-writer" data-lfix ${M.busy || M.view.running ? 'disabled' : ''}>${M.view.crew?.face ? faceHtml(M.view.crew.face, { size: 18 }) : ''}按原简历改掉这几处</button>`
    : fix ? `<button type="button" class="rs-btn is-writer" disabled>按原简历改掉这几处</button><small class="rs-lfix-note">${esc(fix.note || '')}</small>` : '';
  const items = flags.map((f, i) => `<li${here.has(i) ? '' : ' class="is-gone"'}><button type="button" data-lflag="${i}"><q>${esc(f.text)}</q><small>${esc((f.why || []).join('；') || '找不到出处')}</small></button></li>`).join('');
  return `<header>${head}<span class="rs-sp"></span>${act}</header>${items ? `<ol>${items}</ol>` : ''}${L.length ? `<p class="rs-llen">${esc(L.length)}</p>` : ''}`;
}
function paintCheck() {
  const box = $('#rs-lcheck'), marks = $('#rs-lmarks');
  if (box) { const h = checkHtml(); box.innerHTML = h; box.hidden = !h; }
  if (marks) marks.innerHTML = marksHtml($('#rs-ltext')?.value ?? M.text);
}
// 点一句：在纸上选中它（找不到就是你已经改掉了）。
function pick(i) {
  const ta = $('#rs-ltext'), f = M.view.letter.flags?.[i];
  if (!ta || !f) return;
  const at = ta.value.indexOf(f.text);
  if (at < 0) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(at, at + f.text.length);
  const mark = [...document.querySelectorAll('#rs-lmarks mark')][spans(ta.value).findIndex(x => x.i === i)];
  (mark || ta).scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function barHtml() {
  const L = M.view.letter, fam = M.view.family || [], [st, cls] = STATE[L.status] || ['', ''];
  const tab = L.kind === 'self_intro' ? 'intros' : 'letters';
  const vers = fam.length > 1 ? `<span class="rs-lvers" role="group" aria-label="几版">${fam.map(x => `<a href="${letterHash(x.key)}" class="${x.key === L.key ? 'is-on' : ''}" aria-current="${x.key === L.key}">第 ${x.n} 版${x.status === 'chosen' ? ' ✓' : ''}</a>`).join('')}</span>` : '';
  const used = (M.view.used_for || []).filter(x => x.number != null).map(x => `#${x.number}`);
  const saved = `<span class="rs-saved${M.status === 'error' ? ' is-bad' : ''}">${{ saved: '已保存', saving: '正在保存…', error: '没存上' }[M.status]}</span>`;
  const canUse = L.can_use ?? (L.status !== 'chosen' && L.status !== 'failed');
  return `<a class="rs-back" href="#materials?tab=${tab}">← 材料</a><span class="rs-div"></span><b class="rs-title">${esc(L.title)}</b>${vers}${st ? `<span class="rs-tag ${cls}">${st}</span>` : ''}${used.length ? `<span class="rs-tag is-use">${esc(used.join('、'))} 投递在用</span>` : ''}${saved}${M.view.running ? `<span class="rs-job"><span class="rs-spin"></span>${esc(M.view.crew?.name || 'Writer')} 在改</span>` : ''}<span class="rs-sp"></span>
    <button type="button" class="rs-btn is-writer" data-lrewrite ${M.busy ? 'disabled' : ''}>改一版</button><span class="rs-div"></span>
    <button type="button" class="rs-btn is-ghost" data-lundo ${L.can_undo || M.dirty ? '' : 'disabled'} title="撤销（⌘Z）" aria-label="撤销">↶<span class="rs-undo-t"> 撤销</span></button>${canUse ? `<button type="button" class="rs-btn is-pri" data-luse ${M.busy ? 'disabled' : ''}>用这${L.kind === 'self_intro' ? '段' : '封'}</button>` : ''}`;
}
function paintBar() { const b = $('#rs-bar'); if (b && M) b.innerHTML = barHtml(); if (M) paintCheck(); }
const grow = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
async function reload() {
  if (!M) return;
  const me = M, view = await getJson(`/api/resume/letter?key=${encodeURIComponent(me.key)}`);
  if (M !== me) return;
  me.view = view; me.rev = view.letter.rev; me.text = view.letter.text; me.status = 'saved'; me.dirty = false;
  const ta = $('#rs-ltext'); if (ta && ta.value !== me.text) { ta.value = me.text; grow(ta); }
  paintBar();
}
function queue(fn) { const run = M.q.then(fn, fn); M.q = run.catch(() => {}); return run; }
function save() {
  const me = M; if (!me) return Promise.resolve();
  clearTimeout(me.timer); me.timer = null;
  const text = $('#rs-ltext')?.value ?? me.text;
  if (text === me.text) { me.dirty = false; return Promise.resolve(); }
  return queue(async () => {
    try {
      const r = await act({ action: 'letter_edit', key: me.key, text, rev: me.rev });
      me.rev = r.rev; me.text = text; me.dirty = false; me.status = 'saved';
      Object.assign(me.view.letter, { by: 'you', status: r.status || me.view.letter.status, can_undo: r.can_undo, can_redo: r.can_redo, fp: r.fp || me.view.letter.fp, ...('flags' in r ? { flags: r.flags, length: r.length, can_use: r.can_use, fix: r.fix } : {}) });
    } catch (e) {
      me.status = 'error';
      C.h.toast(e.message);
      if (e.status === 409) await reload().catch(() => {});
    }
    if (M === me) paintBar();
  });
}
const flush = () => M?.timer || M?.dirty ? save() : Promise.resolve();
async function command(action) {
  await flush();
  try { const r = await act({ action, key: M.key, rev: M.rev }); M.rev = r.rev; await reload(); }
  catch (e) { C.h.toast(e.message); if (e.status === 409) await reload().catch(() => {}); }
}
async function use() {
  await flush();
  M.busy = true; paintBar();
  try { const r = await act({ action: 'letter_decide', key: M.key, decision: 'use', fp: M.view.letter.fp }); C.h.toast(r.receipt ? `用这一版了。${r.receipt}` : r.warn?.length ? `用这一版了。${r.warn[0]}` : '用这一版了'); await reload(); }
  catch (e) { C.h.toast(e.message); }
  finally { if (M) { M.busy = false; paintBar(); } }
}
async function fix() {
  await flush();
  M.busy = true; paintBar();
  const me = M;
  me.view.running = true; paintBar();
  try {
    const r = await act({ action: 'letter_fix', key: me.key });
    const who = me.view.crew?.name || 'Writer';
    C.h.toast(r.status === 'done' ? `改了 ${r.fixed} 句，核对通过` : r.status === 'partial' ? `改了 ${r.fixed} 句，还有 ${r.left} 句没过` : r.status === 'failed_check' ? `${who} 改了，还是没过` : r.reason || '没改');
    await reload();
  } catch (e) { C.h.toast(e.message); }
  finally { if (M) { M.busy = false; paintBar(); } }
}
async function rewrite() {
  await flush();
  M.busy = true; paintBar();
  try { const r = await act({ action: 'letter_rewrite', key: M.key }); if (r.session_id) window.OfferCrew?.panel?.open?.({ session_id: r.session_id, anchor: r.message_id, pick: 'tailor' }); }
  catch (e) { C.h.toast(e.message); }
  finally { if (M) { M.busy = false; paintBar(); } }
}
export function bindLetter() {
  const root = $('#rs[data-route="letter"]');
  if (!root || !M) return;
  const ta = root.querySelector('#rs-ltext');
  if (ta) { grow(ta); requestAnimationFrame(() => grow(ta)); }
  root.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    const ds = t.dataset;
    if ('lundo' in ds) return command('letter_undo');
    if ('luse' in ds) return use();
    if ('lrewrite' in ds) return rewrite();
    if ('lfix' in ds) return fix();
    if ('lflag' in ds) return pick(Number(ds.lflag));
  });
  ta?.addEventListener('input', () => {
    grow(ta);
    paintCheck();
    M.dirty = true;
    if (M.status !== 'saving') { M.status = 'saving'; paintBar(); }
    clearTimeout(M.timer); M.timer = setTimeout(save, 700);
  });
  ta?.addEventListener('blur', () => { if (M?.timer) save(); });
  ta?.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !/^[zy]$/i.test(e.key)) return;
    // 还没存的这几个字交给浏览器自己撤；存过的走服务端的历史，两边不打架。
    if (M.dirty) return;
    e.preventDefault();
    command(e.key.toLowerCase() === 'y' || e.shiftKey ? 'letter_redo' : 'letter_undo');
  });
}
