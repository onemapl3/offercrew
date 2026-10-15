// 打开网站沿普通网页链接；供系统读取的登录仍在专用 Chrome，核实后续办等待这个账号的任务。
import { esc, pill } from './ui.js';
import { mailState, loadMail, mailConnectHtml, bindMailConnect, unsavedCode } from '../mail-connect.js';
import { linkedinInboxHtml, bindLinkedinInbox } from '../linkedin-inbox.js';

// 邮箱子页：连上内置邮箱（授权码 → 测试 → 保存），连上以后重新测试、换授权码、断开（web/mail-connect.js）。
const MAIL = mailState({ askAddress: true });
const MAIL_HASH = '#settings/accounts/mail';
let toastOf = null;
// 只贴了授权码、没点「保存」就离开这一页：提醒一句，回来时授权码还在框里（第 6 轮）。
if (typeof window !== 'undefined') window.addEventListener('hashchange', e => {
  if (!String(e.oldURL || '').includes(MAIL_HASH) || location.hash.startsWith(MAIL_HASH) || MAIL.busy) return;
  // 上一次测试、保存的结果只在这一页上看；离开就收起来。
  MAIL.result = null; MAIL.err = '';
  if (unsavedCode(MAIL)) toastOf?.('邮箱的授权码还没保存', { label: '回去保存', run: () => { location.hash = MAIL_HASH; } });
});

const step = (D, k) => (D.setup?.steps || []).find(s => s.key === k);
// 收发求职邮件的邮箱：identity.mailbox，没写就是简历上的 identity.email（lib/facts.mjs mailboxOf）。
const mailbox = D => String(D.kit?.factValue?.('identity.mailbox') || D.kit?.factValue?.('identity.email') || '').trim();
// 内置邮箱接上了没有：Mac 版的检查清单里有「解锁全部功能」那一项（lib/setup.mjs），没有就是 null（命令行装的，这一行照旧只写地址）。
const mailOn = D => { const r = step(D, 'unlock')?.unlock?.find(i => i.key === 'mail'); return r ? !!r.done : null; };
const STATE = a => (a.logged_in === true ? pill(a.confirmed_days_ago >= 1 ? '上次确认已登录' : '已登录', 'good') : a.logged_in === false ? pill(a.maybe_out ? '可能掉线了' : '没登录', 'warn') : pill('还没核实', 'off'));
// LinkedIn 绑定时的披露（负责人 10-02，主会话定的原话）。
export const LINKEDIN_NOTE = 'LinkedIn 不允许第三方自动化，自动扫描有被限制账号的风险，随时可以关。';
const website = a => /^https?:\/\//i.test(a.login_url || '') ? a.login_url : null;
const LOGIN = a => `${STATE(a)}<span class="st-acct-do">${website(a) ? `<a class="secondary mini st-acct-site" href="${esc(website(a))}" target="_blank" rel="noopener noreferrer">打开网站</a>` : ''}${a.key ? `<details class="st-acct-connect"><summary>系统登录</summary><div>${website(a) ? `<button type="button" class="secondary mini" data-acct-open="${esc(website(a))}" data-acct-key="${esc(a.key)}">在专用 Chrome 登录</button>` : ''}<button type="button" class="secondary mini" data-acct-ready="${esc(a.key)}">我登好了</button></div></details>` : ''}</span>${a.key === 'linkedin' ? linkedinInboxHtml({ loggedIn: a.logged_in }) : ''}`;
function bindLogins(root, D) {
  root.querySelectorAll('[data-acct-open]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await D.h.post('/api/open-url', { url: b.dataset.acctOpen, account: b.dataset.acctKey || null }); if (r.navError) throw Error(`网页未打开：${r.navError}`); D.h.toast(r.sandbox ? '界面预览不打开专用 Chrome；可用「打开网站」在当前浏览器查看' : r.receipt || '已在专用 Chrome 打开'); } catch (e) { D.h.toast(e.message); } finally { b.disabled = false; } });
  root.querySelectorAll('[data-acct-ready]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await D.h.post('/api/account-ready', { account: b.dataset.acctReady, confirm: b.dataset.confirmed === '1' }); if (r.needs_confirm) { b.dataset.confirmed = '1'; b.textContent = '确认已登录并继续'; const note = document.createElement('p'); note.className = 'muted small'; note.textContent = r.preview.text; b.parentElement.append(note); b.disabled = false; return; } D.h.toast(r.receipt || '已记下'); await D.h.refresh(); } catch (e) { D.h.toast(e.message); b.disabled = false; } });
}
// 浏览器：登录页、登录检查、扫描、预填都在这里。第一次出现写全「OfferCrew 专用的 Chrome」并说明分开登录（必要的披露）；
// 只有专用 Chrome 一种（10-04 ego 删了）。没装 Chrome 照实说。
function browserCard(b) {
  if (!b) return null;
  const value = b.chrome ? pill('专用 Chrome', 'good') : pill('没装 Google Chrome', 'warn');
  const note = b.chrome ? '「打开网站」使用当前浏览器；系统读取、收信和预填使用专用 Chrome，登录状态分开。' : '先装上 Google Chrome（https://www.google.com/chrome/）。';
  return { rows: [{ id: 'browser', label: '浏览器', value, note, words: '浏览器 Chrome 专用', warn: !b.chrome }] };
}
export default {
  id: 'accounts', title: '账号与连接', icon: 'link',
  summary: D => { const a = step(D, 'accounts')?.accounts || [], out = a.filter(x => x.logged_in === false).length; return `${a.length} 个平台账号${out ? ` · ${out} 个没登录` : ''}`; },
  cards(D) {
    const list = step(D, 'accounts')?.accounts || [];
    const order = a => (a.logged_in === false ? 0 : a.logged_in == null ? 1 : 2);
    return [
      browserCard(D.setup?.browser),
      { title: '平台账号', rows: list.length ? [...list].sort((x, y) => order(x) - order(y)).map((a, i) => ({ id: 'acct-' + i, label: a.label, value: LOGIN(a), words: '登录 账号', warn: a.logged_in === false })) : [{ id: 'acct-none', label: '平台账号', value: '<span class="st-muted">还没有</span>' }] },
      // 邮箱这一行只说收发求职邮件用哪个地址；「高级邮箱接入」（自己的 Google 授权）和「浏览器操作」挪到「高级」（10-01 开箱测试 #27）。
      // 接没接上也写在这一行（Mac 版，和「还差几步」同一份，lib/unlock.mjs）：以前只写地址，写了地址像是已经接好了（第 6b 轮）。
      { rows: [{ id: 'mail', label: '邮箱', value: `${mailOn(D) == null ? '' : pill(mailOn(D) ? '已接上' : '没接上', mailOn(D) ? 'good' : 'warn')}${mailbox(D) ? ` ${esc(mailbox(D))}` : mailOn(D) == null ? '<span class="st-muted">没填</span>' : ''}`, warn: mailOn(D) === false, words: '邮件 Gmail QQ 163 iCloud 授权码 收件 发信 接邮箱', sub: 'mail' }] },
    ].filter(Boolean);
  },
  bind: (root, D) => { bindLogins(root, D); bindLinkedinInbox(root, D.h); },
  subs: {
    mail: {
      title: '邮箱', keep: true,
      render: async () => { await loadMail(MAIL); return `<div class="st-card st-pad">${mailConnectHtml(MAIL, esc)}</div>`; },
      bind(root, D) {
        // 设置页后台刷新会把整页换掉：每次都找页面上现在的那一块，不用绑的时候那个旧的。
        toastOf = (t, a) => D.h.toast(t, a);
        const live = () => document.querySelector('.st-root[data-st-sub="mail"]') || root;
        const paint = () => { const box = live().querySelector('.mc'); if (!box) return; box.outerHTML = mailConnectHtml(MAIL, esc); bind(); };
        const bind = () => bindMailConnect(live, MAIL, { post: D.h.post, address: () => MAIL.address.trim() || MAIL.view?.address || mailbox(D), repaint: paint, onSaved: () => D.h.toast('邮箱接好了') });
        bind();
      },
    },
  },
};
