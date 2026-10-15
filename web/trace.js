// 岗位页「进展」里点开一步看到的东西，和「材料」里这次用的简历（数据来自 /api/lead/trace、/api/lead 的 resume_used，lib/lead-trace.mjs）。
// 只拼 HTML，不碰页面：web/hq.js 调它，测试直接调它。
const STATE = { sent: '已发出', submitted: '已提交', review: '待终审', submitting: '提交中', ready: '待发', planned: '待投' };
const VIA = { email: '邮件', form: '申请表' };
const size = n => n > 0 ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '';
const ext = (esc, url, label, cls = '') => `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;

// 证据按钮上的字：看路径猜是什么（点开后以内容为准）。
export function evidenceLabel(ref) {
  const r = String(ref || '');
  if (/\.log$/i.test(r)) return '日志';
  if (/\.(png|jpe?g|webp)$/i.test(r)) return '截图';
  if (/platform-dm|maimai|linkedin|boss/i.test(r)) return '私信';
  if (/auto-apply|prefill|apply/i.test(r)) return '申请表';
  if (/send|sent|mail|gmail/i.test(r)) return '邮件';
  return '记录';
}

export function traceHtml(v, { esc, fmt }) {
  if (v === 'loading' || v == null) return '<div class="ld-trace"><p class="hq-muted">正在读取…</p></div>';
  if (v.error) return `<div class="ld-trace"><p class="hq-muted">${esc(v.error)}</p></div>`;
  const rows = [...(v.rows || []), ...(v.at ? [['时间', fmt(v.at)]] : [])].filter(([, x]) => x !== '' && x != null);
  const kv = rows.length ? `<dl class="ld-kv">${rows.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('')}</dl>` : '';
  const atts = (v.attachments || []).length ? `<ul class="ld-atts">${v.attachments.map(a => `<li>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}${a.size ? `<small>${esc(size(a.size))}</small>` : ''}</li>`).join('')}</ul>` : '';
  const body = v.body ? `<pre class="ld-pre">${esc(v.body)}</pre>` : '';
  const quote = v.quote ? `<div class="ld-quote"><b>对话读回</b><pre class="ld-pre">${esc(v.quote)}</pre></div>` : '';
  const shots = (v.images || []).length ? `<div class="ld-shots">${v.images.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="截图" loading="lazy"></a>`).join('')}</div>` : '';
  const fields = (v.fields || []).length ? `<table class="hq-mini-table ld-fields">${v.fields.map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(x)}</td></tr>`).join('')}</table>` : '';
  const links = [...(v.links || []).map(l => ext(esc, l.url, l.label, 'ld-tr-go')), v.raw ? ext(esc, v.raw, v.kind === 'log' ? '日志' : '原始文件', 'ld-tr-raw') : ''].filter(Boolean).join('');
  const empty = !kv && !atts && !body && !quote && !shots && !fields ? '<p class="hq-muted">这份记录里没有可展示的内容</p>' : '';
  return `<div class="ld-trace ld-tr-${esc(v.kind || 'file')}">${kv}${atts}${body}${quote}${shots}${fields}${empty}${links ? `<div class="ld-tr-links">${links}</div>` : ''}</div>`;
}

// 材料 · 简历：这次用的是哪份（文件名、版本）、怎么递出去的、状态、打开。
export function resumeUsedHtml(list, { esc, fmt }) {
  if (!list?.length) return '';
  return `<ul class="ld-used">${list.map(u => `<li><div class="ld-used-f"><b>${esc(u.name)}</b><span class="ld-st ${u.state === 'sent' || u.state === 'submitted' ? 'is-ok' : ''}">${esc(STATE[u.state] || u.state || '')}</span></div><div class="ld-used-m">${[u.label, VIA[u.via] ? `${VIA[u.via]}${u.to ? ` · ${u.to}` : ''}` : '', u.at ? fmt(u.at) : ''].filter(Boolean).map(esc).join('<i>·</i>')}</div>${u.url ? `<a class="hq-btn" href="${esc(u.url)}" target="_blank" rel="noopener">打开</a>` : '<span class="hq-muted">找不到文件</span>'}</li>`).join('')}</ul>`;
}
