// 材料页和服务端之间的几样东西（web/resume.js、resume-editor.js、resume-compare.js 共用）：token、读、写、上传、下载。
// 写都走 POST /api/resume {action, …}（同源 + X-Radar-Token）；工作台重启过 token 就换了，拿一次新的再试。
// 出错时 Error 带 status：409 这一版刚在别处改过（重新载入）、422 拒绝、403 只读、400 格式不对、424 导出失败、503 数据转换的问题。
let token = '';
export const setToken = t => { if (t) token = t; };
export async function getJson(url) {
  const r = await fetch(url), d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(d.error || '读取失败'), { status: r.status });
  setToken(d.token);
  return d;
}
async function refreshToken() { try { setToken((await (await fetch('/api/resume/view')).json()).token); } catch {} }
async function send(path, init, retried = false) {
  const r = await fetch(path, { ...init, method: 'POST', headers: { ...init.headers, 'X-Radar-Token': token } });
  const d = await r.json().catch(() => ({}));
  if (r.status === 403 && d.error === 'origin_or_token_invalid' && !retried) { await refreshToken(); return send(path, init, true); }
  if (!r.ok) throw Object.assign(Error(d.error === 'origin_or_token_invalid' ? '工作台刚重启过，刷新一下页面再试' : d.error || '请求失败'), { status: r.status });
  return d;
}
export const act = body => send('/api/resume', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 上传一份简历（和「开始使用」同一个入口），再导进材料：原简历存成 v1。
const TYPES = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', md: 'text/markdown' };
export const UPLOAD_ACCEPT = '.pdf,.docx,.txt,.md';
export async function upload(f) {
  const ext = (f.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if (!TYPES[ext]) throw Error('只收 PDF、Word（.docx）、TXT、Markdown 文件');
  if (f.size > 10 * 1024 * 1024) throw Error('文件超过 10 MB');
  const meta = await send('/api/setup/resume', { headers: { 'Content-Type': TYPES[ext], 'X-File-Name': encodeURIComponent(f.name) }, body: f });
  if (meta.status === 'unreadable') throw Error(meta.error || '这份文件读不出文字');
  return act({ action: 'import', upload_id: meta.id });
}
// 导出 PDF 再下载（附件，不离开页面）。
export async function exportPdf(doc, version) {
  await act({ action: 'export', doc, version, format: 'pdf' });
  const a = document.createElement('a');
  a.href = `/api/resume/file?doc=${encodeURIComponent(doc)}&v=${encodeURIComponent(version)}&format=pdf`;
  a.download = '';
  document.body.append(a); a.click(); a.remove();
}
