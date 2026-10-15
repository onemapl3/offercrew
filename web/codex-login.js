// 「用 ChatGPT 账号登录」槽位里的界面（接口 /api/codex，lib/codex-app.mjs，方案附录 H）。
// 引导的模型一步在 GET /api/codex 不是 404 时留一个空槽位 #ob-codex-login[data-slot="codex-login"]（web/desktop.js）；
// 这里看到槽位出现就把界面填进去，槽位被重画了就重新填。三步：安装官方 codex → 在浏览器里登录 → 已登录。
// 登录成功后发一个 offercrew:codex 事件（detail 是状态），引导可以据此把这一项标成已选好。
const T = {
  need: '需要 ChatGPT Plus 或更高的套餐。中国大陆和香港不在 OpenAI 的服务地区内，那里要用代理。',
  install: '安装 Codex（OpenAI 官方，约 95 MB）', installing: '正在下载并核对…', installNote: '从 OpenAI 的官方发布页下载，核对校验值和签名后装进 OfferCrew 自己的文件夹，不装到系统里。',
  login: '用 ChatGPT 账号登录', loggingIn: '在浏览器里登录 ChatGPT，登完回到这里…', openLink: '浏览器没打开？点这里',
  loginNote: '会在你的浏览器里打开 OpenAI 的登录页。OfferCrew 不经手你的密码，也不读登录信息，只看登上没有。',
  ok: (v) => `已登录 ChatGPT${v ? `（Codex ${v}）` : ''}。`, logout: '退出登录', cancel: '取消', retry: '再试一次',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let token = '', timer = null, last = null;

async function status() {
  const r = await fetch('/api/codex');
  if (!r.ok) return null;
  const s = await r.json();
  token = s.token || token;
  return s;
}
async function act(action) {
  const r = await fetch('/api/codex', { method: 'POST', headers: { 'content-type': 'application/json', 'x-radar-token': token }, body: JSON.stringify({ action }) });
  const d = await r.json().catch(() => ({}));
  return r.ok ? null : d.error || '没成功';
}

export function codexLoginHtml(s, err = '') {
  if (!s) return '';
  if (!s.available) return `<p class="ob-note">${esc(s.reason)}</p>`;
  const e = err || s.error ? `<p class="ob-err">${esc(err || s.error)}</p>` : '';
  if (s.busy === 'installing') return `<p class="ob-note">${T.installing} ${Math.round((s.progress || 0) * 100)}%</p><div class="ob-actions"><button type="button" class="secondary" data-codex="cancel">${T.cancel}</button></div>`;
  if (s.busy === 'logging_in') return `<p class="ob-note">${T.loggingIn}</p>${s.login_url ? `<p class="ob-note"><a href="${esc(s.login_url)}" target="_blank" rel="noopener">${T.openLink}</a></p>` : ''}<div class="ob-actions"><button type="button" class="secondary" data-codex="cancel">${T.cancel}</button></div>`;
  if (s.logged_in) return `<p class="ob-note">✓ ${esc(T.ok(s.version))}</p><div class="ob-actions"><button type="button" class="secondary" data-codex="logout">${T.logout}</button></div>`;
  if (s.installed) return `${e}<div class="ob-actions"><button type="button" class="primary" data-codex="login">${e ? T.retry : T.login}</button></div><p class="ob-note">${T.loginNote}</p><p class="ob-note">${T.need}</p>`;
  return `${e}<div class="ob-actions"><button type="button" class="primary" data-codex="install">${T.install}</button></div><p class="ob-note">${T.installNote}</p><p class="ob-note">${T.need}</p>`;
}

async function paint(slot, err = '') {
  const s = await status().catch(() => null);
  if (!slot.isConnected) return;
  slot.innerHTML = codexLoginHtml(s, err);
  slot.querySelectorAll('[data-codex]').forEach((b) => { b.onclick = async () => { b.disabled = true; const e = await act(b.dataset.codex); paint(slot, e || ''); }; });
  // 只在真的登录上的那一刻发（之前看到过没登录）；一打开就是登好的不发——那不是你刚才在这里登录的（开箱第 2 轮 X5）。
  if (s?.logged_in && last && !last.logged_in) window.dispatchEvent(new CustomEvent('offercrew:codex', { detail: s }));
  last = s;
  clearTimeout(timer);
  if (s?.busy) timer = setTimeout(() => paint(slot), 1500);
}

// 槽位出现（或被重画）时填进去。
function mount() {
  const slot = document.querySelector('#ob-codex-login[data-slot="codex-login"]');
  if (slot && !slot.dataset.mounted) { slot.dataset.mounted = '1'; paint(slot); }
}
if (typeof document !== 'undefined') {
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  mount();
}
