// 批准太久的对外动作（线 F，升级前的红线）：发信、私信、预填、提交批准超过 24 小时还没被领走，不自动做（lib/actions.mjs holdStale），
// 压成 hold 'stale:'、那件活「等你」。这里出收件箱那封信，接你点的两下：
//   确认（发送 / 投递 / 提交）  按现在的内容重新确认：requestAction 带你看到的指纹，原地刷新那一条（指纹重新绑、批准时间是现在）
//   不要了                      动作取消；发信的草稿作废、发送请求取消，投递的批准撤回（各动作的 drop，lib/action-kinds.mjs）
// 信只读：GET /api/inbox 走到这里不写任何东西（预览是各动作的 prepare 现算的）。
import { listActions, getAction, isStaleHeld, settle, STALE } from './actions.mjs';
import { requestAction, specOf } from './action-kinds.mjs';

const VERB = { send_email: '发', send_dm: '发', prefill: '投', submit: '提交' };
const LABEL = { send_email: '发送', send_dm: '发送', prefill: '投递', submit: '提交' };
const WHAT = { send_email: '邮件', send_dm: '私信', prefill: '投递', submit: '提交' };
export const STALE_PREFIX = `${STALE}:`;

// 重新确认时交给 prepare 的输入：按动作上记的对象。
export function inputOf(a) {
  const p = a?.payload || {};
  if (a.kind === 'send_email' || a.kind === 'send_dm') return { draft_id: p.draft_id || String(a.target || '').replace(/^draft:/, '') };
  const record_id = p.record_id || String(a.target || '').replace(/^lead:/, '');
  return a.kind === 'submit' ? { record_id, reconfirm: true } : { record_id };
}

const daysOf = (a, now) => (a.approved_at ? Math.max(1, Math.floor((now - Date.parse(a.approved_at)) / 86400000)) : null);
export const staleQuestion = (a, now = Date.now()) => `${daysOf(a, now) ? `这是 ${daysOf(a, now)} 天前批准的` : '这是旧版里批准的'}，还要${VERB[a.kind]}吗？`;

// 这一份现在的样子（信上给你看的，指纹也从这里来）。规格还没加载（工作台启动时会加载）、准备不出来：没有预览，确认时再给你看一眼。
function current(a, now) {
  const spec = specOf(a.kind);
  if (!spec?.prepare) return null;
  try { return spec.prepare(inputOf(a), { origin: 'inbox', now, input: inputOf(a) }); }
  catch (e) { return { blocked: true, reason: String(e.message || e).slice(0, 120) }; }
}
function previewOf(a, p) {
  if (!p || p.blocked || p instanceof Promise) return null;
  const v = p.preview || {};
  if (a.kind === 'send_email' || a.kind === 'send_dm') return { kind: 'draft', channel: v.channel || (a.kind === 'send_dm' ? 'platform_dm' : 'email'), to: v.to || '', subject: v.subject || '', body: v.body || '', attachments: (v.attachments || []).map(x => x.name || String(x)), fingerprint: p.fingerprint };
  if (a.kind === 'submit') return { kind: 'form', fields: v.fields || [], screenshot: v.screenshot || null, url: v.url || null, fingerprint: p.fingerprint };
  return { kind: 'prefill', fingerprint: p.fingerprint };
}

// 收件箱的信：一条压着的动作一封。
export function staleAsks({ now = Date.now() } = {}) {
  return listActions({ state: 'approved' }).filter(isStaleHeld).map(a => {
    const p = current(a, now), v = p && !p.blocked ? p.preview || {} : {};
    const n = v.number ?? a.payload?.number ?? null, company = v.company || '';
    const rid = a.payload?.record_id || (String(a.target || '').startsWith('lead:') ? a.target.slice(5) : null);
    const stuck = p?.blocked ? p.reason : null;
    return {
      from: 'reacher', id: `${STALE_PREFIX}${a.id}`, type: 'review',
      title: [n != null ? `#${n}` : '', company || WHAT[a.kind]].filter(Boolean).join(' '),
      question: stuck ? `${staleQuestion(a, now).replace(/，还要.+$/, '')}，现在${VERB[a.kind]}不了：${stuck}` : staleQuestion(a, now),
      context: [WHAT[a.kind], v.role ? String(v.role).slice(0, 40) : '', a.kind === 'send_email' && v.to ? `发给 ${v.to}` : ''].filter(Boolean),
      preview: previewOf(a, p),
      ...(a.kind === 'prefill' && rid ? { form_preview: rid } : {}),
      options: [
        ...(stuck ? [] : [{ key: '1', label: LABEL[a.kind], steps: [{ type: 'stale', act: 'confirm', id: a.id }], confirm_inline: true, primary: true }]),
        { key: stuck ? '1' : '2', label: '不要了', steps: [{ type: 'stale', act: 'drop', id: a.id }], danger: true, ...(stuck ? { primary: true } : {}) },
      ],
      other: null,
      lead: rid || n != null ? { number: n, company, role: v.role || '', record_id: rid } : null,
    };
  });
}

const gone = () => Object.assign(Error('这一项已经处理过或刚刚变了，请刷新'), { status: 409 });
// 确认：按现在的内容。fingerprint 是你在信上看到的那一份；对不上（中间改过）就再给你看一眼。
export async function reconfirmStale(id, { fingerprint = null, origin = 'inbox', now = Date.now(), kick, ident } = {}) {
  const a = getAction(id);
  if (!a || a.state !== 'approved' || !isStaleHeld(a)) throw gone();
  return requestAction(a.kind, inputOf(a), { origin, confirm: fingerprint || null, now, job_id: a.job_id, ...(kick ? { kick } : {}), ...(ident ? { ident } : {}) });
}
// 不要了：先把旧文件里那一份收掉（草稿作废、批准撤回），再取消动作，那件活记已取消。
export async function dropStale(id, { now = Date.now() } = {}) {
  const a = getAction(id);
  if (!a || a.state !== 'approved' || !isStaleHeld(a)) throw gone();
  const receipt = (await specOf(a.kind)?.drop?.(a, { now })) || '不做了';
  settle(a.id, 'cancelled', { reason: '批准太久，你说不要了', now });
  return { receipt };
}
