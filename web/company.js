// Watch 的公司调研和「怎么准备」在页面上（数据由 lib/company-brief.mjs 算好，这里只画）：
//   线索详情页：「公司」（摘要、要紧的事实、近期动态、面经与口碑、风险、来源）在左栏最上面，
//              「怎么准备」（补一补、准备讲、这家公司）在右栏「判断」下面——它回应的就是判断里的主要缺口。
//   指挥台抽屉：一张小卡，摘要 + 两三条要紧的事实，链到详情页。
// 每条说法后面的小数字是它的来源（点开原文）；只来自论坛、点评、面经站的标「二手」。
// 按钮（调研这家公司、生成怎么准备、写面试资料）走 /api/company：开一张卡，引擎在工作台里做。

const REF_MAX = 3;
// 今年的写「8-20」，往年的写「2025-02」（新闻按日期排，年份不能省）。
const md = x => { const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(x || '')); return !m ? '' : +m[1] === new Date().getFullYear() && m[3] ? `${+m[2]}-${+m[3]}` : `${m[1]}-${m[2]}`; };
const day = x => { const t = Date.parse(x || ''); return Number.isFinite(t) ? md(new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString()) : ''; };
const refs = (h, src = []) => src.slice(0, REF_MAX).map(s => `<a class="co-ref" href="${h.esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${h.esc([s.title, s.site, s.date].filter(Boolean).join(' · '))}">${h.esc(s.n)}</a>`).join('') + (src.length > REF_MAX ? `<span class="co-ref is-more">+${src.length - REF_MAX}</span>` : '');
const SECOND = '<span class="co-2" title="只来自论坛、点评或面经站，没有官方或媒体来源">二手</span>';
// mark=false：这一组整组都是二手，标在小标题上，条目上不再重复。
const claim = (h, c, mark = true) => `<span class="co-t">${h.esc(c.text)}</span>${mark && c.second ? SECOND : ''}${refs(h, c.src)}`;
const btn = (h, attrs, label, cls = '') => `<button type="button" class="cmd-btn ${cls}" ${attrs}>${h.esc(label)}</button>`;
const briefBtn = (h, company, rid, label, cls = '') => btn(h, `data-co-brief data-company="${h.esc(company)}" data-rid="${h.esc(rid || '')}"`, label, cls);

// ── 线索详情页 · 公司 ─────────────────────────────────────────────────────────
const FACTS = [['business', '业务'], ['scale', '规模'], ['hiring', '在哪招'], ['tech', '技术'], ['salary', '薪资']];
export function companySection(d, h) {
  const c = d.company || {}, rid = d.lead?.record_id || d.lead?.id || '', b = c.brief, name = c.name || d.lead?.company || '';
  const head = (hint, act = '') => `<header><h2>公司</h2><span class="co-name">${h.esc(b?.company || name)}</span>${hint ? `<span class="cmd-hint">${hint}</span>` : ''}${act ? `<span class="co-act">${act}</span>` : ''}</header>`;
  const wrap = (hint, body, act = '') => `<section class="cmd-panel co" id="ld-company">${head(hint, act)}<div class="ld-body">${c.scope_note ? `<p class="cmd-muted">${h.esc(c.scope_note)}</p>` : ''}${body}</div></section>`;
  if (c.state === 'unknown') return wrap('', `<p class="co-empty">公司还不明（待核）：先核实是哪家公司，再调研。</p>`);
  if (c.state === 'none') return wrap('', `<p class="co-empty">还没调研 · ${briefBtn(h, name, rid, '调研这家公司', 'primary')}</p>`);
  if (c.state === 'researching') return wrap('', `<p class="co-empty"><span class="co-spin" aria-hidden="true"></span>${h.crewName('lens')} 在调研 · ${c.job?.status === 'working' ? '在查' : '排队中'}${c.job?.created_at ? ` · ${h.esc(h.fmt(c.job.created_at))}` : ''}</p><p class="cmd-muted">查完就出现在这里：摘要、业务和规模、近期动态、面经、风险，每条带来源。</p>`);
  if (c.state === 'failed') return wrap('', `<p class="co-empty">上次没调研成${c.job?.result ? `：${h.esc(c.job.result)}` : ''} · ${briefBtn(h, name, rid, '再试一次')}</p>`);
  if (c.state === 'not_found') return wrap(`查过 ${h.esc(day(b.updated_at))}`, `<p class="co-empty">公开资料很少：${h.esc(b.note)}</p><p class="cmd-muted">查过：${h.esc((b.searched || []).join('、'))}</p>`, briefBtn(h, name, rid, '再查一次'));
  if (!b) return '';
  const stale = c.state === 'stale', refreshing = c.open;
  const hint = `${refreshing ? '在更新 · ' : ''}${stale ? `<span class="co-stale">调研已过 ${h.esc(c.age_days)} 天</span> · ` : ''}${h.esc(day(b.updated_at))} 调研 · ${b.sources.length} 个来源${b.engine ? ' · 没用搜索引擎' : ''}`;
  const skipped = (b.engine?.skipped || []).map(x => `<li><i></i><span>${h.esc(x.site)} · ${h.esc(x.why)}</span></li>`).join('');
  // 每样事实先放最要紧的一条（执行器按重要性排），其余收进「展开全部」。
  const facts = FACTS.filter(([k]) => b[k]?.length).map(([k, label]) => `<dt>${label}</dt><dd>${claim(h, b[k][0])}</dd>`).join('');
  const news = b.news.slice(0, 3).map(n => `<li><time>${h.esc(md(n.date))}</time><span>${claim(h, n)}</span></li>`).join('');
  const said = [...b.interview.slice(0, 3), ...b.culture.slice(0, 2)], allSecond = said.length && said.every(x => x.second);
  const talk = said.map(x => `<li><i></i><span>${claim(h, x, !allSecond)}</span></li>`).join('');
  const flags = b.red_flags.slice(0, 3).map(x => `<li><i></i><span>${claim(h, x)}</span></li>`).join('');
  // 默认只放最要紧的几条；其余（每节超出的、全部来源）收在「展开全部」里。
  const extra = [
    ...FACTS.filter(([k]) => b[k]?.length > 1).map(([k, label]) => [label, b[k].slice(1)]),
    ['近期动态', b.news.slice(3)], ['面试', b.interview.slice(3)], ['口碑', b.culture.slice(2)], ['风险', b.red_flags.slice(3)],
  ].filter(([, list]) => list.length);
  const more = `<details class="co-more" data-key="co-more"><summary>${extra.length ? `展开全部 · 另有 ${extra.reduce((n, [, l]) => n + l.length, 0)} 条和` : '看'} ${b.sources.length} 个来源</summary>
    ${extra.map(([label, list]) => `<div class="cmd-sec">${label}</div><ul class="co-list">${list.map(x => `<li>${x.date ? `<time>${h.esc(md(x.date))}</time>` : '<i></i>'}<span>${claim(h, x)}</span></li>`).join('')}</ul>`).join('')}
    ${skipped ? `<div class="cmd-sec">跳过的页面</div><ul class="co-list is-dots">${skipped}</ul>` : ''}
    <div class="cmd-sec">来源</div><ol class="co-srcs">${b.sources.map((s, i) => `<li><span class="co-n">${i + 1}</span><a href="${h.esc(s.url)}" target="_blank" rel="noopener noreferrer">${h.esc(s.title)}</a><small>${h.esc(s.site)}${s.date ? ' · ' + h.esc(s.date) : ''}${s.word ? ` · <b class="${s.kind === 'community' ? 'is-2' : ''}">${h.esc(s.word)}</b>` : ''}</small></li>`).join('')}</ol>
  </details>`;
  const body = `${b.summary ? `<p class="co-sum">${claim(h, b.summary)}</p>` : ''}
    ${facts ? `<dl class="co-facts">${facts}</dl>` : ''}
    ${news || talk ? `<div class="co-cols">${news ? `<div><div class="cmd-sec">近期动态</div><ul class="co-list">${news}</ul></div>` : '<div></div>'}${talk ? `<div><div class="cmd-sec">面经与口碑${allSecond ? SECOND : ''}</div><ul class="co-list is-dots">${talk}</ul></div>` : '<div></div>'}</div>` : ''}
    ${flags ? `<div class="co-flags"><div class="cmd-sec">风险</div><ul class="co-list is-dots">${flags}</ul></div>` : ''}
    ${more}`;
  return wrap(hint, body, refreshing ? '' : briefBtn(h, name, rid, stale ? '重新调研' : '更新调研', stale ? 'primary' : 'is-quiet'));
}

// ── 线索详情页 · 怎么准备 ─────────────────────────────────────────────────────
const OUTDATED = { brief: '公司调研后来更新过', jd: 'JD 变了' };
export function prepSection(d, h) {
  const p = d.prep || {}, rid = d.lead?.record_id || d.lead?.id || '', x = p.prep;
  const prepBtn = (label, cls = '') => btn(h, `data-co-prep data-rid="${h.esc(rid)}"`, label, cls);
  const materials = d.interview_materials || [];
  const dossier = materials.length ? `<p class="co-dossier">${materials.map(m => `<a href="${h.esc(m.href)}">${h.esc(m.title)}</a>`).join(' · ')}</p>` : p.dossier?.url ? `<p class="co-dossier">面试深度版：${h.link(p.dossier.url, '打开文档')}</p>` : '';
  const wrap = (hint, body, act = '') => `<section class="cmd-panel co-prep" id="ld-prep"><header><h2>${materials.length ? `<a href="${h.esc(materials[0].href)}">怎么准备 →</a>` : '怎么准备'}</h2>${hint ? `<span class="cmd-hint">${hint}</span>` : ''}${act ? `<span class="co-act">${act}</span>` : ''}</header><div class="ld-body">${body}${dossier}</div></section>`;
  if (p.state === 'no_jd') return wrap('', `<p class="co-empty">还没抓到 JD 正文，没法对着 JD 准备。</p>`);
  if (p.state === 'queued') return wrap('', `<p class="co-empty"><span class="co-spin" aria-hidden="true"></span>${h.crewName('lens')} 在写 · ${p.job?.status === 'working' ? '在写' : '排队中'}</p><p class="cmd-muted">对着 JD 和主要缺口，写几条要补的、要讲的。</p>`);
  if (p.state === 'failed') return wrap('', `<p class="co-empty">上次没写成${p.job?.result ? `：${h.esc(p.job.result)}` : ''} · ${prepBtn('再试一次')}</p>`);
  if (!x) return wrap('', `<p class="co-empty">还没写 · ${prepBtn('生成怎么准备', 'primary')}</p>`);
  const jd = list => (list || []).map(q => `<span class="co-jd">JD「${h.esc(q)}」</span>`).join('');
  const item = (it, extra = '') => `<li><i></i><div><div>${h.esc(it.text)}${extra}</div>${jd(it.jd)}</div></li>`;
  const groups = [
    ['补一补', (x.review || []).map(it => item(it))],
    ['准备讲', (x.pitch || []).map(it => item(it, it.proof ? `<span class="co-proof">用：${h.esc(it.proof)}</span>` : ''))],
    ['这家公司', (x.company || []).map(it => item(it, refs(h, it.src)))],
  ].filter(([, list]) => list.length);
  const stale = p.open ? [] : (p.outdated || []).map(k => OUTDATED[k]).filter(Boolean);
  const hint = `${p.open ? '在重写 · ' : ''}${h.esc(day(x.updated_at))} 写 · 当前版本${p.counts ? ` · ${p.counts.visible} 条` : ''}`;
  return wrap(hint, `${p.scope_note ? `<p class="cmd-muted">${h.esc(p.scope_note)}</p>` : ''}${stale.length ? `<p class="co-outdated">${h.esc(stale.join('，'))}，可以重新生成。</p>` : ''}${groups.map(([label, list]) => `<div class="cmd-sec">${label}</div><ul class="co-check">${list.join('')}</ul>`).join('')}`, p.open ? '' : prepBtn(stale.length ? '重新生成' : '重写', stale.length ? 'primary' : 'is-quiet'));
}

// ── 线索详情页 · 面试资料（Watcher 写，lib/interview-dossier.mjs）────────────────
// 每一条后面是它出自哪份材料；没用搜索引擎。到了面试这一步才有这一栏。
const IV = [['company', '公司和岗位要点'], ['questions', '可能会问的'], ['prepare', '你该准备的'], ['review', '复盘']];
export function interviewSection(d, h) {
  const v = d.interview;
  if (!v) return '';
  const rid = d.lead?.record_id || d.lead?.id || '', x = v.dossier;
  const ivBtn = (label, cls = '') => btn(h, `data-co-iv data-rid="${h.esc(rid)}"`, label, cls);
  const wrap = (hint, body, act = '') => `<section class="cmd-panel co-prep" id="ld-interview"><header><h2>面试资料</h2>${hint ? `<span class="cmd-hint">${hint}</span>` : ''}${act ? `<span class="co-act">${act}</span>` : ''}</header><div class="ld-body">${v.scope_note ? `<p class="cmd-muted">${h.esc(v.scope_note)}</p>` : ''}${body}</div></section>`;
  if (!x && v.state === 'writing') return wrap('', `<p class="co-empty"><span class="co-spin" aria-hidden="true"></span>${h.crewName('owl')} 在写</p>`);
  if (!x && v.state === 'failed') return wrap('', `<p class="co-empty">上次没写成${v.reason ? `：${h.esc(v.reason)}` : ''} · ${ivBtn('再试一次')}</p>`);
  if (!x) return wrap('', `<p class="co-empty">还没写 · ${ivBtn('写面试资料', 'primary')}</p>`);
  const from = list => (list || []).length ? `<span class="co-proof">出自：${h.esc(list.join('、'))}</span>` : '';
  const groups = IV.filter(([k]) => (x[k] || []).length).map(([k, label]) => `<div class="cmd-sec">${label}</div><ul class="co-check">${x[k].map(it => `<li><i></i><div><div>${h.esc(it.text)}</div>${from(it.from)}</div></li>`).join('')}</ul>`).join('');
  const hint = `${v.open ? '在重写 · ' : ''}${h.esc(x.phase_word)} · ${h.esc(day(x.updated_at))} 写 · 没用搜索引擎`;
  return wrap(hint, `${v.outdated && !v.open ? `<p class="co-outdated">面试有了新情况（${h.esc(v.phase_now || '')}），可以重写。</p>` : ''}${groups}`, v.open ? '' : ivBtn('重写', v.outdated ? 'primary' : 'is-quiet'));
}

// ── 指挥台抽屉 · 公司小卡 ─────────────────────────────────────────────────────
export function companyMini(card, r, h) {
  if (!card) return '';
  const name = r.company || '', rid = r.rid || '', link = `<a class="hq-co-link" href="${h.esc(h.leadUrl(rid))}">完整调研和怎么准备 →</a>`;
  const small = (text, act = '') => `<div class="hq-co is-empty"><span>${text}</span>${act}</div>`;
  const b = (label) => `<button type="button" class="hq-btn" data-co-brief data-company="${h.esc(name)}" data-rid="${h.esc(rid)}">${h.esc(label)}</button>`;
  if (card.state === 'unknown') return ''; // 公司还不明（待核）：抽屉里不占地方，详情页上有一句
  if (card.state === 'none') return small('还没调研', b('调研这家公司'));
  if (card.state === 'researching') return small(`<span class="co-spin" aria-hidden="true"></span>${h.crewName('lens')} 在调研这家公司，查完出现在这里`);
  if (card.state === 'failed') return small(`上次没调研成${card.job_result ? `：${h.esc(card.job_result)}` : ''}`, b('再试一次'));
  if (card.state === 'not_found') return small(`查过了，公开资料很少${card.note ? `：${h.esc(card.note)}` : ''}`);
  const facts = (card.facts || []).map(f => `<dt>${h.esc(f.k)}</dt><dd class="${f.k === '风险' ? 'is-flag' : ''}">${h.esc(f.v)}${f.second ? '<span class="co-2">二手</span>' : ''}</dd>`).join('');
  return `<div class="hq-co"><p class="hq-co-sum">${h.esc(card.summary || '')}</p>${facts ? `<dl class="hq-facts">${facts}</dl>` : ''}<div class="hq-co-foot"><span class="hq-muted">${card.state === 'stale' ? '调研已过期 · ' : ''}${h.esc(day(card.updated_at))} 调研 · ${h.esc(card.sources || 0)} 个来源${card.open ? ' · 在更新' : ''}</span>${link}</div></div>`;
}

// ── 按钮 ─────────────────────────────────────────────────────────────────────
export async function requestCompany(b, h) {
  const prep = b.hasAttribute('data-co-prep'), iv = b.hasAttribute('data-co-iv');
  b.disabled = true;
  try {
    const r = await h.post('/api/company', iv ? { action: 'interview', record_id: b.dataset.rid } : prep ? { action: 'prep', record_id: b.dataset.rid } : { action: 'brief', company: b.dataset.company || '', record_id: b.dataset.rid || null });
    h.toast(r.receipt || `已交给 ${h.crewName(iv ? 'owl' : 'lens')}`);
    setTimeout(() => h.refresh(), 800);
  } catch (e) { h.toast(e.message); b.disabled = false; }
}
export function bindCompany(root, h) {
  root.querySelectorAll('[data-co-brief],[data-co-prep],[data-co-iv]').forEach(b => { b.onclick = () => requestCompany(b, h); });
}
