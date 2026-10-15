// 手机 App 的纯逻辑（web/phone/app.js 用；tests/phone-app.test.mjs 在 Node 里直接测）。不碰 DOM、不发请求。
// 对话模型（design/phone-m2/实施方案.md 第十节，2026-09-30 中午定）：一段对话就是和整个团队说；
// 输入框里 @某位 只把这一句交给那一位（POST /api/talk 带 member），对话不切换；@#12 带上一条岗位（「正在看 #12」）。

// 老的角色名（收件箱信里的 from、旧会话）→ 名册里的成员 id
export const OLD_ROLE = { radar: 'scout', reacher: 'quill', watch: 'owl', system: 'patch', judge: 'lens', writer: 'tailor', watcher: 'owl' };
export const memberKey = k => { const x = String(k || '').toLowerCase(); return OLD_ROLE[x] || x || null; };

// ── 输入框里的 @ ────────────────────────────────────────────────────────────
// 「@Writer 把 #12 的自我介绍改短」→ { member: 'tailor', leads: [], text: '把 #12 的自我介绍改短' }：这一句只交给 Writer。
// 「@#128 值得投吗」→ { member: null, leads: [128], text: '#128 值得投吗' }。@团队 等于不 @。认不出的 @ 原样留着（邮箱里的 @ 前面不是空白，不算）。
// 一句话里只认第一个成员。
export function parseAt(text, list = []) {
  const byName = new Map();
  for (const m of list) { if (!m?.key) continue; for (const a of [m.key, m.name, ...(m.aliases || [])]) if (a) byName.set(String(a).toLowerCase(), m.key); }
  byName.set('团队', 'team'); byName.set('team', 'team');
  let who = null;
  const leads = [];
  let out = String(text ?? '').replace(/(^|\s)@#?(\d{1,6})(?![\d\w])/g, (all, pre, n) => { if (!leads.includes(Number(n))) leads.push(Number(n)); return `${pre}#${n}`; });
  out = out.replace(/(^|\s)@([A-Za-z一-鿿][\w一-鿿]*)/g, (all, pre, name) => { const k = byName.get(name.toLowerCase()); if (!k || who) return all; who = k; return pre; });
  return { member: who === 'team' ? null : who, leads, text: out.replace(/[ \t]{2,}/g, ' ').trim() };
}
// 光标前面正在打的 @（弹出选人）：{ q, start, end, lead }；不在打就是 null。lead：在打 @# 或 @数字（找岗位）。
export function atToken(text, caret) {
  const before = String(text ?? '').slice(0, caret ?? String(text ?? '').length);
  const m = /(^|\s)@(#?[\w一-鿿]*)$/.exec(before);
  if (!m) return null;
  return { q: m[2], start: before.length - m[2].length - 1, end: before.length, lead: /^#|^\d/.test(m[2]) };
}
// 输入框上面那一排成员（F6）：点着一位，之后的话都交给它；打的 @ 只管这一句、比点的优先，@团队 就是整个团队。
export function memberFor(raw, at, picked = null) {
  if (at?.member) return at.member;
  return /(^|\s)@(团队|team)(?=\s|$)/i.test(String(raw ?? '')) ? null : picked || null;
}
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 抬头（负责人 10-03）：这段对话在跟谁说——当前那位带名字、高亮，其他几位一个小头像，点一下就换（data-to，团队是 team）。
// keys 为空（一件活的对话：手机上不换人，回电脑换）就只有当前那位。
export function whoRowHtml(cur, keys = [], { name = k => k, face = () => '', tint = () => '' } = {}) {
  const one = (k, on) => { const t = on ? tint(k) : ''; return `<button type="button" class="who-b${on ? ' on' : ''}"${t ? ` style="${esc(t)}"` : ''} aria-pressed="${on}"${on ? '' : ` data-to="${esc(k)}"`} title="${esc(name(k))}">${face(k)}${on ? `<b>${esc(name(k))}</b>` : ''}</button>`; };
  return one(cur || 'team', true) + keys.filter(k => k !== (cur || 'team')).map(k => one(k, false)).join('');
}
// 选人列表：成员按名字、id、别名的开头过滤。
export function memberMatches(list = [], q = '') {
  const s = String(q || '').toLowerCase();
  return list.filter(m => m?.key && (!s || [m.key, m.name, ...(m.aliases || [])].some(a => String(a || '').toLowerCase().startsWith(s))));
}
// 选中之后输入框里的字：成员 → 「@Writer 」留在原处（发的时候 parseAt 拿走，只管这一句）；岗位 → 「#12 」并带上「正在看 #12」。
export function applyPick(text, tok, pick) {
  const s = String(text ?? ''), before = s.slice(0, tok.start), after = s.slice(tok.end).replace(/^\s+/, '');
  const ins = pick.kind === 'lead' ? `#${pick.number} ` : `@${pick.name} `;
  return { text: before + ins + after, caret: (before + ins).length, focus: pick.kind === 'lead' ? focusOf(pick) : null };
}

// ── 「正在看 #12」 ─────────────────────────────────────────────────────────
// 一条岗位 → 标签 { rid, number, company, role }；发给服务端只带 { rid, number }。
// 规则：从岗位点进来的、自己用 @# 带上的，都留着（发完一句也留着），点 × 或开新对话才拿掉。打字里写了 #N 不自动加。
export function focusOf(x) {
  if (!x || x.number == null || !/^\d{1,6}$/.test(String(x.number))) return null;
  return { rid: x.rid || x.record_id || x.id || null, number: Number(x.number), company: x.company || '', role: x.role || '' };
}
export const focusBody = f => (f && (f.rid || f.number != null) ? { rid: f.rid || null, number: f.number ?? null } : null);
export const focusLabel = f => (f ? `正在看 #${f.number}` : '');

// 一句话发给 /api/talk 的内容。member 只跟着这一句；focus 有就带。
export function talkBody({ session_id = null, text, member = null, focus = null, via = null, confirm = false, action = null } = {}) {
  const f = focusBody(focus);
  return { session_id: session_id || null, text, ...(member ? { member } : {}), ...(f ? { focus: f } : {}), ...(via ? { via } : {}), ...(action ? { action } : {}), ...(confirm ? { confirm: true } : {}) };
}

// ── 时间和历史 ───────────────────────────────────────────────────────────────
const two = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export const clock = iso => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''; const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000), d = new Date(t), today = new Date(now), y = new Date(now - 86400000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (dayKey(d) === dayKey(today)) return `${Math.floor(s / 3600)} 小时前`;
  if (dayKey(d) === dayKey(y)) return `昨天 ${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
// 对话列表（/api/chat 的 sessions），和电脑上的切换器同一套（web/talk.js sessionRows，负责人 10-03）：所有对话按最后说话的时间排成一列，
// 任务和聊天混在一起，任务带四态小标，聊天不带。一页一页从服务端取（?limit=&before=&q=），搜也交给服务端（hit 是它给的那一小段）。
// 定时周期的那几段只在搜的时候出来；空会话不列（正在看的那段除外）。
// face：一件活是管它的那位（目标是团队）；聊天是单独说话的那位，只有一位回过话就是那位，不然是团队。
// 名字：标题，没有标题用第一句（first），再没有用那位成员或「团队」。
export const PAGE = 50;
export const pageUrl = ({ q = '', before = null, limit = PAGE } = {}) => { const u = new URLSearchParams({ limit: String(limit) }); if (String(q).trim()) u.set('q', String(q).trim()); if (before) u.set('before', before); return '/api/chat?' + u; };
export const rowFace = s => s?.task ? (s.owner && s.owner !== 'team' ? memberKey(s.owner) : 'team') : s?.member ? memberKey(s.member) : (s?.crew || []).length === 1 ? memberKey(s.crew[0]) : 'team';
export function sessionRows(list = [], { q = '', current = null, nameOf = x => x } = {}) {
  const searching = !!String(q || '').trim(), seen = new Set();
  return list.filter(s => s && !seen.has(s.id) && seen.add(s.id) && (s.messages || s.id === current) && (!s.routine || searching || s.id === current))
    .map(s => ({ ...s, face: rowFace(s), label: s.title && s.title !== '新对话' ? s.title : s.first || (s.member ? nameOf(s.member) : '团队'), tag: s.task ? taskTag(s) : null, hit: searching ? s.hit || '' : '' }))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || String(b.id).localeCompare(String(a.id)));
}
// 状态小标：{ tone, word }，都是服务端给的（lib/status.mjs，卡、小条、对话行上的 word / tone；颜色是 .st 的 t-<tone>）。没有的是 null。
export const taskTag = x => x?.word ? { tone: x.tone || 'mute', word: x.word } : null;
// 有新消息：最后的动静晚于你看过的那一下（seen_at 记在服务端，手机和电脑同一份）。
export const isUnread = s => !!s?.updated_at && (!s.seen_at || String(s.updated_at) > String(s.seen_at));

// ── 任务卡：收到 → 进度 → 结果 ─────────────────────────────────────────────────
// 两种来源一样画：对话里交出去的事（/api/talk 的 tasks：queued/running/done/needs_you/stuck/withdrawn）
// 和任务板上的卡（cards：unclaimed/queued/running/needs_you/stuck/done/cancelled）。
// beat 1 收到（排队）· 2 进度（在做）· 3 结果（做完、等你、卡住、撤回）。
const BEAT = { unclaimed: 1, queued: 1, running: 2, done: 3, needs_you: 3, stuck: 3, withdrawn: 3, cancelled: 3 };
export const MAC = '回电脑确认';
export function cardView(t, { board = false } = {}) {
  if (!t) return null;
  const status = String(t.status || 'queued'), steps = (t.steps || []).map(s => ({ at: s.at || null, who: memberKey(s.who) || null, text: String(s.text || ''), bad: ['blocked', 'failed'].includes(s.status), you: s.status === 'waiting_user', evidence: [...(s.evidence || [])] }));
  const files = [...new Set([...(t.evidence_files || []), ...(t.evidence ? [t.evidence] : []), ...steps.flatMap(s => s.evidence)].filter(Boolean))];
  const last = steps.at(-1);
  const result = status === 'done' ? String(t.result || '做完了') : status === 'stuck' ? String(t.detail || t.result || '没做成') : status === 'withdrawn' ? '撤回了，不会做这件事' : status === 'cancelled' ? String(t.result || '取消了') : null;
  // 手机上开的卡里要开执行器 / 浏览器的那一棒（lib/tasks.mjs mac_hold）：写「回电脑确认」和要跑什么，手机上没有按钮。
  const mac = status === 'queued' && t.mac_hold ? String(t.mac_hold.label || '') : null;
  const wait = status === 'queued' || status === 'unclaimed' ? String((typeof t.hold === 'string' && t.hold) || t.wait_note || '') : '';
  return {
    id: String(t.id || ''), board, owner: memberKey(t.owner || t.persona) || 'team', title: String(t.title || ''), status, label: mac != null ? MAC : t.word || '', beat: BEAT[status] || 1, tone: mac != null ? 'you' : t.tone || '', mac,
    now: mac != null ? mac : ['queued', 'running', 'unclaimed'].includes(status) ? (status === 'running' && last ? last.text : wait || (last ? last.text : '')) : '',
    result, steps, files, leads: (t.leads || []).filter(r => r && r.number != null).map(r => ({ number: r.number, rid: r.rid || null, company: r.company || '' })),
    ask: status === 'needs_you' ? t.ask || null : null, ask_id: status === 'needs_you' ? t.ask?.id || t.links?.ask_id || null : null,
    detail: status === 'needs_you' ? String(t.detail || '') : '', can_withdraw: !!t.can_withdraw, answer: t.answer || null,
  };
}
// Writer 的活（体检、改一句、改一版，lib/resume-talk.mjs）：在做时是一张卡；做完是一段纯文字。
// 撤销、按这几条改一版、查看对比这些按钮要在电脑的材料页上用，手机上不放（不放点不动的按钮）。
export function writerView(t) {
  if (!t) return { card: null, text: '', bad: false };
  if (t.status === 'running') return { card: cardView(t), text: '', bad: false };
  return { card: null, text: String(t.short || t.result || ''), bad: !!t.bad };
}
// 目标卡：几棒接力，一棒一行；要你答的那一棒指到「等你」。
const STEP_LABEL = { intake: '收录并核验', judge: '判断', tailor: '定制简历', apply: '找内推 / 填表', referrers: '找内推', draft: '写消息', send: '发出', research: '公司调研', prep: '怎么准备', resume: '改简历', letters: '求职信' };
export function goalView(g, all = {}) {
  if (!g) return null;
  const legs = (g.route || []).map(s => {
    const c = s.card ? all[s.card] : null, st = s.state === 'skip' ? 'skip' : c ? c.status : 'planned', mac = st === 'queued' && c?.mac_hold ? String(c.mac_hold.label || '') : null;
    return { owner: memberKey(s.owner), what: STEP_LABEL[s.kind] || s.kind, status: mac != null ? 'mac' : st, mac, label: mac != null ? MAC : st === 'skip' ? '跳过' : st === 'planned' ? '等上一棒' : c?.word || '', card: c?.id || null, ask_id: st === 'needs_you' ? c?.links?.ask_id || null : null };
  });
  return { id: g.id, title: String(g.title || ''), status: g.status, label: g.word || '', beat: BEAT[g.status] || 1, legs, result: g.status === 'done' ? g.result || null : null, halt: g.halt && !g.halt.answered ? { question: String(g.halt.question || ''), options: (g.halt.options || []).map(String) } : null };
}

// 一件活的对话，输入框上面那一行（任务即对话 第七节）：等你 = 目标停下来问的选项，或者指到「等你」里那封信；
// ── 任务标签（10-03 负责人「任务卡片」，样稿 phone.html）：列表按六种状态的队列分组，点一件进卡片 ──────────────
// 和电脑上任务页同一份（GET /api/tasks、GET /api/tasks/<id>/card）。卡片上手机能做的只有 回答、再试一次、撤回、看原因
// （网关放开的就是这些）；打开填好的表、终审这类链接、在这台电脑上运行，写「回电脑确认」。派给、改要求手机上只看。
const SIX = { unclaimed: 'queued', queued: 'queued', running: 'running', needs_you: 'needs_you', done: 'done', stuck: 'stuck', cancelled: 'cancelled' };
export const sixOf = st => SIX[st] || null;
const sixTag = x => x?.word ? `<span class="st t-${esc(x.tone || 'mute')}">${esc(x.word)}</span>` : '';
// 分组按账上的状态（c.state），组名是那一组的状态词（服务端给的）；这里只定顺序、尾巴和哪组收起。
export const TASK_GROUPS = [['queued'], ['running'], ['waiting_you'], ['done', ' · 今天'], ['failed'], ['cancelled', '', true]];
export const PHONE_ACTS = new Set(['answer', 'retry', 'withdraw', 'why']);
export function taskListHtml(d = {}, { face = () => '', open = new Set(), now = Date.now() } = {}) {
  const goals = d.goals || [], inGoal = new Set(goals.map(g => g.id));
  const top = [...goals, ...(d.cards || []).filter(c => !(c.goal && inGoal.has(c.goal)) && !c.parent_task && !c.routine)].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const today = x => { const t = Date.parse(x || ''); return Number.isFinite(t) && new Date(t).toDateString() === new Date(now).toDateString(); };
  const row = c => `<a class="k-row" href="#tasks/${encodeURIComponent(c.id)}" data-task-open="${esc(c.id)}">${face(c.owner && c.owner !== 'team' ? memberKey(c.owner) : 'team')}<b>${esc(c.short || c.title || '')}</b>${sixTag(c)}<time>${esc(clock(c.updated_at))}</time></a>`;
  const sec = (k, label, rows, fold = false) => { if (!rows.length) return ''; const shut = fold && !open.has(k); return `<section class="k-sec" data-group="${k}">${fold ? `<button type="button" class="k-sh is-fold" data-fold="${k}" aria-expanded="${!shut}">${esc(label)} <i>${rows.length}</i></button>` : `<h3 class="k-sh">${esc(label)} <i>${rows.length}</i></h3>`}${shut ? '' : rows.map(row).join('')}</section>`; };
  const body = TASK_GROUPS.map(([k, tail = '', fold]) => { const all = top.filter(c => c.state === k), rows = k === 'done' ? all.filter(c => today(c.done_at || c.updated_at)) : all; return sec(k, `${rows[0]?.word || ''}${tail}`, rows, fold); }).join('')
    + sec('earlier', '更早', top.filter(c => c.state === 'done' && !today(c.done_at || c.updated_at)), true);
  return body || '<p class="empty-line">还没有任务。</p>';
}
const leadText = l => l ? `${l.number != null ? `#${l.number} ` : ''}${l.company || ''}${l.role ? ` · ${l.role}` : ''}`.trim() : '';
export function phoneCardHtml(c = {}, { face = () => '', name = k => k, sub = null, why = null } = {}) {
  // 「在对话里答」（#talk?session=…）手机上也能点：进那段对话。
  const inTalk = b => b.act === 'open' && /^#talk\?/.test(String(b.href || ''));
  const n = c.next || null, btns = (n?.buttons || []).filter(b => PHONE_ACTS.has(b.act) || inTalk(b)), off = (n?.buttons || []).some(b => !PHONE_ACTS.has(b.act) && !inTalk(b));
  const ordered = [...btns.filter(b => b.act === 'why'), ...btns.filter(b => b.act !== 'why')];
  const btn = b => inTalk(b) ? `<a class="btn pri go-wait" href="#talk/${esc(new URLSearchParams(String(b.href).split('?')[1] || '').get('session') || '')}">${esc(b.label || '在对话里答')}</a>` : b.act === 'answer' ? `<a class="btn pri go-wait" href="#wait/${encodeURIComponent(b.ask_id || '')}">回答</a>`
    : b.act === 'retry' ? `<button type="button" class="btn pri" data-move="${esc(c.id)}" data-status="queued"${b.disabled ? ' disabled' : ''}>再试一次</button>`
    : b.act === 'why' ? `<button type="button" class="btn" data-why="${esc(c.id)}">看原因</button>`
    : `<button type="button" class="btn" data-move="${esc(c.id)}" data-status="cancelled">撤回</button>`;
  const tone = n?.kind === 'you' ? 'is-you' : n?.kind === 'bad' ? 'is-bad' : 'is-plain';
  const m = /^(等你|没做成)[：:]\s*/.exec(String(n?.text || ''));
  const plan = (n?.then || []).length ? `<div class="k-plan">${n.then.map((s, i) => `<span class="k-step${i === 0 && n.kind === 'you' ? ' is-now' : i === 0 && n.kind === 'run' ? ' is-run' : ''}">${s.who ? face(memberKey(s.who) || s.who) : ''}${esc(s.text)}</span>`).join('<i>→</i>')}</div>` : '';
  const said = m ? `<p class="k-ask"><b>${esc(m[1])}：</b>${esc(String(n.text).slice(m[0].length))}</p>` : n?.text && (tone !== 'is-plain' || !plan || n.again) ? `<p class="k-ask">${esc(n.text)}</p>` : '';
  const acts = ordered.length || off ? `<div class="k-acts">${ordered.map(btn).join('')}</div>${off ? `<p class="on-mac">${esc(MAC)}</p>` : ''}` : '';
  // 看原因：System 就地答一句（POST /api/tasks/<id>/why），和电脑一样不开对话。
  const whyBox = why?.id === c.id && (why.busy || why.content) ? `<div class="k-why">${face('patch')}<p>${why.busy ? '…' : esc(why.content)}</p></div>` : '';
  const next = n ? `<div class="k-sec2"><h3>接下来</h3><div class="k-next ${tone}">${said}${acts}${whyBox}${plan}</div></div>` : '';
  const l = c.lead, o = c.owner || {};
  const fields = `<div class="k-fields"><span>要做成什么</span><div>${esc(c.requirement || c.title || '')}</div>${l ? `<span>岗位</span><div><span class="k-job">${esc(leadText(l))}</span></div>` : ''}<span>派给</span><div class="k-who">${face(memberKey(o.id) || 'team')}${esc(o.name || '团队')}</div></div>`;
  // 子任务：每步带自己的卡（s.card），点了进它的卡片；「+ 子任务」说一句话（POST /api/tasks/<id>/subtask），派给照新建的规矩。
  const steps = c.route || [], many = steps.length > 1 || steps.some(s => s.card && s.card !== c.id), live = SIX[c.status] !== 'cancelled';
  const li = (s, i) => { const k = s.tone || 'queued', inner = `<span class="n">${SIX[s.status] === 'done' ? '✓' : i + 1}</span><div><b>${esc(s.label)}</b>${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</div>${sixTag(s)}`; return s.card && s.card !== c.id ? `<li class="is-${k}"><a class="k-sub" href="#tasks/${encodeURIComponent(s.card)}" data-task-open="${esc(s.card)}">${inner}</a></li>` : `<li class="is-${k}">${inner}</li>`; };
  const subForm = sub?.open ? `<form class="k-subnew" id="k-sub" autocomplete="off"><textarea name="text" rows="2" maxlength="500" required aria-label="子任务">${esc(sub.draft || '')}</textarea><div class="k-cbar">派给${subPick(sub, { face, name })}<button type="button" class="btn" data-sub-cancel>取消</button><button type="submit" class="btn pri"${sub.busy ? ' disabled' : ''}>加上</button></div>${sub.err ? `<p class="c-err">${esc(sub.err)}</p>` : ''}</form>` : '';
  const route = many || subForm || live ? `<div class="k-sec2"><h3>子任务${live && !sub?.open ? '<button type="button" class="k-add" data-sub-new>+ 子任务</button>' : ''}</h3>${many ? `<ol class="k-subs">${steps.map(li).join('')}</ol>` : ''}${subForm}</div>` : '';
  const whoSaid = h => { const n = h.who ? name(memberKey(h.who) || h.who) : ''; return n && !String(h.text || '').startsWith(n) ? `<b>${esc(n)}</b>：` : ''; };
  const did = (c.history || []).length ? `<div class="k-sec2"><h3>做了什么</h3><ol class="k-did">${c.history.map(h => `<li><time>${esc(clock(h.at))}</time>${face(memberKey(h.who) || h.who || 'team')}<span>${whoSaid(h)}${esc(h.text)}</span></li>`).join('')}</ol></div>` : '';
  // 引擎自己用模型做的结果（lib/task-do.mjs）：做完了就只给结果，不再重复「接下来」那一行。
  const ans = c.answer?.text ? `<div class="k-sec2"><h3>结果</h3><div class="k-answer">${face(memberKey(c.answer.by) || c.answer.by || 'team')}<p>${esc(c.answer.text)}</p>${(c.answer.basis || []).length ? `<small>照：${esc(c.answer.basis.join('、'))}</small>` : ''}</div></div>` : '';
  return `<div class="k-card" data-card-view="${esc(c.id)}">${fields}${ans && SIX[c.status] === 'done' ? '' : next}${ans}${route}${did}</div>`;
}
// 派给（子任务）：认得出类型、只有一位能做的只写名字；「你交代的事」给一个下拉，System 建议的预先选上。
function subPick(st = {}, { face = () => '', name = k => k } = {}) {
  const a = st.assign || null, sel = st.owner || st.suggest || '';
  if (a?.fixed && a.owner) return `<span class="k-who">${face(a.owner.id)}${esc(a.owner.name || name(a.owner.id))}</span>`;
  const opts = a?.options?.length ? a.options : (st.members || []).map(m => ({ id: m.key, name: m.name }));
  return `<select data-sub-owner aria-label="派给"><option value=""${sel ? '' : ' selected'}>System 定</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === sel ? ' selected' : ''}>${esc(o.name)}${o.id === st.suggest ? ' · System 建议' : ''}</option>`).join('')}</select>`;
}
// 给这件活下指令（POST /api/tasks/<id>/say）：撤回的不显示；placeholder 读 say。
// reply：成员对这句的回应（say 回来的 { who, text }），照它说的写在框上面。
export const sayFormHtml = (c = {}, { draft = '', busy = false, err = '', reply = null, face = () => '', name = k => k } = {}) => (c.say ? c.say.enabled !== false : SIX[c.status] !== 'cancelled')
  ? `${reply?.text ? `<div class="k-reply">${face(memberKey(reply.who) || 'team')}<p>${reply.who ? `<b>${esc(name(memberKey(reply.who) || reply.who))}</b>：` : ''}${esc(reply.text)}</p></div>` : ''}<form class="k-say" id="k-say" autocomplete="off"><textarea name="text" rows="1" maxlength="2000" required enterkeyhint="send" aria-label="给这件活下指令" placeholder="${esc(c.say?.placeholder || '给这件活下指令…')}">${esc(draft)}</textarea><button type="submit" class="send"${busy ? ' disabled' : ''} aria-label="发出"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7l7 7"/></svg></button>${err ? `<p class="c-err">${esc(err)}</p>` : ''}</form>` : '';
export const cardTitleHtml = c => `<span class="k-title">${esc(c?.title || '')}</span>${sixTag(c)}`;
export function cardFootHtml(c = {}) {
  const o = c.origin || {}, FROM = { chat: '来自对话', cycle: '来自定时', you: '你新建的', page: '来自岗位页', inbox: '来自收件箱' };
  const t = o.by === 'chat' ? `↩ 来自对话${o.label ? ` <b>「${esc(o.label)}」</b>` : ''}` : `↩ ${esc(o.label || FROM[o.by] || '')}`;
  return o.by ? (o.by === 'chat' && o.session_id ? `<a class="k-from" href="#talk/${esc(o.session_id)}">${t}</a>` : `<span class="k-from">${t.replace(/^↩ /, '')}</span>`) : '';
}
export const WHY_TEXT = '这件为什么没做成';
// 一封信属于哪件活。经网关来的 /api/inbox（lib/task-chat.mjs askTasks）是 task（卡 id）、task_title、task_session 三个字段；
// 第一版的手机接口（lib/phone/api.mjs phoneAsk）是 task: { id, title, session_id }。两种都认。
export const askTask = a => a?.task && typeof a.task === 'object' ? (a.task.id ? a.task : null) : a?.task ? { id: String(a.task), title: a.task_title || '', session_id: a.task_session || null } : null;

// ── 等你：哪些要回电脑做 ─────────────────────────────────────────────────────
// 这些步骤只能在电脑上做：打开页面、切到投递页、改稿编辑器、飞书扫码（和 lib/phone/api.mjs MAC_ONLY 同一份）。
export const MAC_STEPS = new Set(['open', 'application_page', 'reveal_resume', 'draft_editor', 'feishu_login', 'navigate']); // navigate：工作台里的某一页（定制版的「打开看看」）
const macOnly = o => !!(o?.steps?.length) && o.steps.every(s => MAC_STEPS.has(s.type));
// 手机上能点的选项（要回电脑的拿掉）。
export const phoneOptions = a => (a?.type === 'login' ? [] : (a?.options || []).filter(o => !macOnly(o)));
// 要回电脑做的事：写清是什么、回电脑哪里做；null = 手机上能答。
//   登录：「登录 Boss 直聘：回电脑，在专用 Chrome 里登录后点『好了』」（这类卡片没有按钮）。
//   别的：能点的选项一个都没有、也不能写一句话时，「<选项>：回电脑处理」。
export function onMacLine(a) {
  if (!a) return null;
  const opts = a.options || [];
  if (a.type === 'login') {
    const ready = opts.find(o => (o.steps || []).some(s => s.type === 'account_ready'));
    const what = String(a.title || '登录').replace(/^登录\s*/, '');
    return `登录 ${what}：回电脑，在专用 Chrome 里登录后点「${ready?.label || '好了'}」`;
  }
  if (phoneOptions(a).length || a.other) return null;
  const mac = opts.filter(macOnly);
  return mac.length ? `${mac.map(o => o.label).join(' / ')}：回电脑处理` : null;
}
// 选项点下去之后还要什么：原因、时间、要补的几项；什么都不要就直接答。
export function optionNeeds(o) {
  if (!o) return null;
  if (o.reasons?.length) return 'reason';
  if (o.input === 'datetime') return 'datetime';
  if (o.input === 'fields') return 'fields';
  return null;
}

// ── 往外生效的确认：服务端给的预览 → 确认卡上的几行 ─────────────────────────────────
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const CHANNEL = { email: '邮件', platform_dm: '平台私信', boss: 'BOSS 直聘', wechat: '微信', linkedin: '领英', portal: '公司招聘站' };
export function confirmView(p, fallback = '确认') {
  if (!p || typeof p !== 'object') return { title: fallback, lines: [] };
  if (p.kind === 'queue_apply') return { title: '确认投递', lines: (p.rows || []).flatMap(r => [`#${r.number ?? '?'} ${cut(r.company, 30)} · ${cut(r.role, 40)}${r.city ? `（${cut(r.city, 12)}）` : ''}`, ...(r.warn ? [r.warn] : [])]) };
  if (p.kind === 'send') return { title: '确认发出', lines: (p.drafts || []).flatMap(d => [`#${d.number ?? '?'} ${cut(d.company, 30)} → ${cut(d.to || '对方', 60)}${d.channel ? `（${CHANNEL[d.channel] || cut(d.channel, 12)}）` : ''}`, ...(d.subject ? [`主题：${cut(d.subject, 80)}`] : [])]) };
  if (p.kind === 'draft') return { title: '确认发出', lines: [`发给：${cut(p.to || '对方', 80)}`, ...(p.subject ? [`主题：${cut(p.subject, 80)}`] : []), ...(p.body ? [cut(p.body, 160)] : [])] };
  if (p.kind === 'form') return { title: '确认提交', lines: (p.fields || []).slice(0, 8).map(f => `${cut(f.label ?? f.key, 20)}：${cut(f.value, 60)}`) };
  return { title: fallback, lines: [] };
}

// ── 输入框下面那一行（/api/talk/parse）──────────────────────────────────────────
// { persona, text }：谁接这一句、这一句会怎么办。@ 了某位就是那位，不问服务端。
export function hintOf({ at = null, parse = null } = {}) {
  if (at?.member) return { persona: at.member, text: '' };
  if (!parse) return null;
  if (parse.kind === 'command') {
    const rows = (parse.rows || []).map(r => `#${r.number} ${cut(r.company, 16)}`).join('、');
    return { persona: memberKey(parse.persona), text: `${parse.verb || ''}${rows ? ' ' + rows : ''}`.trim(), confirm: !!parse.confirm };
  }
  if (parse.kind === 'empty') return null;
  return { persona: memberKey(parse.persona), text: '' };
}

// ── 地址（通知点进来、深链接）─────────────────────────────────────────────────
// #talk、#talk/<会话>、#tasks、#tasks/<任务>、#wait、#wait/<信>、#me；别的都回到对话。
export function route(hash) {
  // 电脑上的写法也认（lib/routes.mjs）：#inbox?ask=<信> 就是「等你」里那一封，#tasks?task=<编号> 就是那件任务。
  const [path, query = ''] = String(hash || '').replace(/^#/, '').split('?'), q = new URLSearchParams(query);
  if (path === 'inbox') return { tab: 'wait', ask: (q.get('ask') || '').length <= 200 ? q.get('ask') || null : null };
  if (path === 'tasks' && q.get('task')) return { tab: 'tasks', task: q.get('task').length <= 120 ? q.get('task') : null };
  const h = path, [tab, ...rest] = h.split('/'), id = (() => { try { return decodeURIComponent(rest.join('/')); } catch { return ''; } })();
  if (tab === 'wait') return { tab: 'wait', ask: id && id.length <= 200 ? id : null };
  if (tab === 'me') return { tab: 'me' };
  if (tab === 'tasks') return { tab: 'tasks', task: id && id.length <= 120 ? id : null };
  return { tab: 'talk', session: tab === 'talk' && /^[a-z0-9]{8,32}$/.test(id) ? id : null };
}
export const hashOf = r => (r.tab === 'wait' ? (r.ask ? `#wait/${encodeURIComponent(r.ask)}` : '#wait') : r.tab === 'me' ? '#me' : r.tab === 'tasks' ? (r.task ? `#tasks/${encodeURIComponent(r.task)}` : '#tasks') : r.session ? `#talk/${r.session}` : '#talk');
// 通知点进来要找的那一条（#wait/<信>）已经不在「等你」里了：你在电脑上答了、那条不推进了……「等你」顶上说一句，
// 不留一页什么都没有（09-30 #29）。清单还没取回来时不说。
export const ASK_GONE = '这条已经处理了。';
export const askGone = (target, asks) => !!target && Array.isArray(asks) && !asks.some(a => (Array.isArray(target) ? target : [target]).includes(a?.id));

// 回话里的按钮上给人看的字（和电脑上一样：按钮背后还是那条指令）。
export function actLabel(cmd) {
  const t = String(cmd ?? '').trim(), nums = s => [...new Set(String(s).match(/\d{1,6}/g) || [])].map(Number).sort((a, b) => a - b).map(n => '#' + n).join('、');
  let m;
  if ((m = /^(?:投|投递)\s+([\d\s,，]+)$/.exec(t))) return `批准投递 ${nums(m[1])}`;
  if ((m = /^(?:发|发送)\s+([\d\s,，]+)$/.exec(t))) return `发出 ${nums(m[1])} 的草稿`;
  if ((m = /^pass\s+([\d\s,，]+)(?:\s+\D.*)?$/i.exec(t))) return `不投 ${nums(m[1])}`;
  if ((m = /^(\d{1,6})\s*(跟进|联系)$/.exec(t))) return `${m[2]} #${m[1]}`;
  return t;
}
