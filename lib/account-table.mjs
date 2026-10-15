// 账号表只有一张（rebuild7/one-source，10-10）：收件箱「账号」标签、设置 · 账号与连接、System 页「网站账号」一行都读它。
// 以前两份各列各的（lib/ask-actions.mjs 只列有岗位的招聘站，lib/setup.mjs 再加上招聘平台），登录状态也各看各的：
// 收件箱写「已登录」，同一行下面「系统自动看过：没看到你的账号」（实测 D16）；设置里一长串「没记录」，System 却说「3 个已登录、0 个没登录」（G15）。
//   列哪些    招聘平台（config/accounts 里 kind: platform 的）一直列着；公司招聘站有还在推进的岗位在那里才列。
//   登没登录  最近一次的结论为准：登录记录（state/portal-sessions）和系统自动看的那一次（lib/login-watch.mjs）谁新听谁。
//             自动看的更新、说没看到你的账号：算没登录（logged_in: false，maybe_out 标出来是自动看出来的）。
import { accountsView, hostOf, loadAccounts } from './accounts.mjs';
import { loadPortalSessions, applyChannel, applyUrl } from './apply-channel.mjs';
import { loginWatchState } from './login-watch.mjs';
import { endedLead, appliedLead } from './lead-state.mjs';
import { excludedCompany } from './discovery-policy.mjs';

const live = l => !!l && !l.superseded && !excludedCompany(l) && !endedLead(l) && !appliedLead(l);
export function accountTable({ leads = [], sessions = loadPortalSessions(), watch = loginWatchState(), cfg = loadAccounts(), services = {}, now = Date.now() } = {}) {
  const platforms = Object.values(cfg.families || {}).filter(f => f.kind === 'platform').map(f => f.hosts?.[0]).filter(Boolean);
  const hosts = [...new Set([...platforms, ...leads.filter(l => live(l) && applyChannel(l) === 'portal').map(l => hostOf(applyUrl(l))).filter(Boolean)])];
  return accountsView({ sessions, hosts, cfg, services }).map(a => {
    const w = watch?.[a.key];
    const auto_check = w ? { at: w.checked_at || null, logged_in: w.logged_in ?? null, reason: w.reason || null } : null;
    const newer = auto_check?.at && (!a.verified_at || Date.parse(auto_check.at) > Date.parse(a.verified_at));
    const row = newer && auto_check.logged_in !== null ? { ...a, logged_in: auto_check.logged_in, maybe_out: auto_check.logged_in === false && a.logged_in === true, verified_at: auto_check.at, auto_check } : { ...a, auto_check };
    const age = row.verified_at ? Math.max(0, Math.floor((now - Date.parse(row.verified_at)) / 86400000)) : null;
    return { ...row, confirmed_days_ago: Number.isFinite(age) ? age : null };
  });
}
