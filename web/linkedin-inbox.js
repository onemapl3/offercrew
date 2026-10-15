// LinkedIn 网页收信状态；读取状态不启动检查，只有明确点击才排检查任务。
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const label = { ok: '检查完成', partial: '只检查了部分会话', checking: '正在检查', never_checked: '尚未检查', failed: '检查未完成', login_required: '需要登录 LinkedIn', verification_required: '需要在网页完成验证' };
let view = null, error = '', busy = false, waiting = false, previousCheck = null, pending = '', job = null, card = null, timer = null, loading = null;
let helpers = null;
const expanded = new Map();
const pageKey = () => typeof location === 'undefined' ? '' : location.hash;
const active = () => busy || waiting || view?.pending || view?.status === 'checking';
const when = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : String(value); };
function content({ open = false, loggedIn = null } = {}) {
  const state = (waiting || view?.pending) && view?.status !== 'checking' ? '检查已排队' : view ? label[view.status] || '收信状态待确认' : '正在读取收信状态';
  const counts = view?.checked_at ? `查看 ${Number(view.conversations) || 0} 个会话 · 读到 ${Number(view.received) || 0} 条 · 新增提醒 ${Number(view.raised) || 0} 条` : '';
  const auto = view?.enabled === true ? (loggedIn === true ? '自动收信已开启' : '自动收信 · 登录后生效') : view?.enabled === false ? '自动收信已关闭' : '网页收信';
  const taskId = card || view?.task_id, jobId = job || view?.job_id;
  const jobHref = taskId ? `#tasks?task=${encodeURIComponent(taskId)}` : jobId ? `#stream?job=${encodeURIComponent(jobId)}` : '#tasks';
  const pendingText = pending || (view?.pending ? view.task_reason || '检查任务正在等待或读取' : '');
  const failed = !!error || ['failed', 'partial', 'login_required', 'verification_required'].includes(view?.status);
  const reason = error || (failed ? view?.reason : '');
  return `<details class="li-inbox-detail" ${open ? 'open' : ''}><summary><span>${esc(auto)}</span><span class="li-inbox-status" role="status">${esc(error ? '收信状态读取失败' : state)}</span>${view?.checked_at ? `<span class="muted">${esc(when(view.checked_at))}</span>` : ''}</summary><div class="li-inbox-controls">${counts ? `<p class="muted small">${esc(counts)}${view.partial ? ' · 部分会话尚未读完' : ''}${view.unlinked ? ` · ${Number(view.unlinked)} 条未关联岗位` : ''}</p>` : ''}<div class="li-inbox-actions"><button type="button" class="secondary mini" data-li-check ${active() || view?.manual_available === false ? 'disabled' : ''}>${active() ? '等待检查结果' : '检查新消息'}</button>${typeof view?.enabled === 'boolean' ? `<button type="button" class="secondary mini" data-li-toggle ${busy ? 'disabled' : ''}>${view.enabled ? '关闭自动收信' : '开启自动收信'}</button>` : ''}<a href="#inbox">查看收到的消息</a></div><p class="muted small">登录后默认自动收信；09:00–21:00 检查，手动检查不受时段限制。打开会话可能将消息标为已读，邮件通知只作补充。</p><p class="muted small">LinkedIn 不允许第三方自动化，自动扫描有被限制账号的风险，随时可以关。</p></div></details>${reason ? `<p class="li-inbox-problem" role="status">${esc(reason)}</p>` : ''}${pendingText ? `<p class="small">${esc(pendingText)} <a href="${esc(jobHref)}">查看检查任务</a></p>` : ''}`;
}
export function linkedinInboxHtml({ loggedIn = null } = {}) {
  const key = pageKey(), live = typeof document === 'undefined' ? null : [...document.querySelectorAll('[data-li-inbox]')].find(x => x.dataset.liPage === key);
  if (live) expanded.set(key, !!live.querySelector('details')?.open);
  return `<div class="li-inbox" data-li-inbox data-li-page="${esc(key)}" data-li-login="${loggedIn === true ? 'yes' : loggedIn === false ? 'no' : 'unknown'}">${content({ loggedIn, open: expanded.get(key) === true })}</div>`;
}
const boxes = () => [...document.querySelectorAll('[data-li-inbox]')];
function paint(h) { for (const box of boxes()) { const open = !!box.querySelector('details')?.open; box.innerHTML = content({ open, loggedIn: box.dataset.liLogin === 'yes' }); bindButtons(box, h); } }
async function load(h) {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await fetch('/api/linkedin-inbox'); const next = await r.json(); if (!r.ok) throw Error(next.error || '收信状态读取失败');
      const ours = !next.job_id || !job || next.job_id === job;
      if (waiting && ours && next.status !== 'checking' && next.checked_at && next.checked_at !== previousCheck) { waiting = false; pending = ''; }
      else if (waiting && next.job_id === job && ['done', 'failed', 'cancelled'].includes(next.job_state)) { waiting = false; pending = next.job_state === 'cancelled' ? '检查任务已取消' : next.job_state === 'failed' ? '检查任务未完成，请查看任务原因' : '检查任务已结束'; }
      view = next; error = '';
    }
    catch (e) { error = e.message || '收信状态读取失败'; }
    finally { loading = null; paint(h); }
  })();
  return loading;
}
function schedule(h, remaining = 40) {
  clearTimeout(timer);
  if (!remaining || !boxes().length) return;
  timer = setTimeout(async () => { if (!boxes().length) return; await load(h); if (active()) schedule(h, remaining - 1); else await h.refresh?.(); }, 3000);
}
function bindButtons(box, h) {
  const details = box.querySelector('details');
  if (details) details.ontoggle = () => { if (details.isConnected) expanded.set(box.dataset.liPage || '', details.open); };
  box.querySelector('[data-li-check]')?.addEventListener('click', async () => {
    if (active()) return;
    busy = true; error = ''; pending = ''; previousCheck = view?.checked_at || null; paint(h);
    try {
      const r = await h.post('/api/linkedin-inbox', { action: 'check' });
      job = r.op?.job_id || null; card = typeof r.card === 'string' ? r.card : r.card?.id || null;
      pending = r.receipt || (r.queued ? '检查已排队' : '检查任务已提交');
      waiting = true;
      await load(h);
    } catch (e) { error = e.message; }
    finally { busy = false; paint(h); schedule(h); }
  });
  box.querySelector('[data-li-toggle]')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true; error = ''; paint(h);
    try { await h.post('/api/settings', { name: 'pipeline', patch: { linkedin_chat_watch: !view.enabled } }); await load(h); }
    catch (e) { error = e.message; }
    finally { busy = false; paint(h); }
  });
}
export function bindLinkedinInbox(root, h) {
  if (!root.querySelector('[data-li-inbox]')) return;
  helpers = h;
  paint(h); load(h).then(() => { if (active()) schedule(h); });
}
// app 会恢复整页 DOM；回来后重读状态，不能留下离页时的“已排队”。
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => {
  setTimeout(() => { if (helpers && boxes().length) load(helpers).then(() => { if (active()) schedule(helpers); }); }, 0);
});
