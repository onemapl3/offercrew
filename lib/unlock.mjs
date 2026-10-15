// 「还差几步，就能用上全部功能」（负责人 10-03，第 5 轮）：引导里勾了要登录的渠道，可后面没人带你去登录，入口藏得很深，
// 用了半天系统大部分功能都没解锁。这里是那份清单的唯一来源：收件箱的那封信（unlockAsk）和「设置 → 检查清单」的那一项
// （lib/setup.mjs）都从 unlockItems 来。以后有别的前提，加在 unlockItems 里，两边一起变。
//
// 现在的几行：
//   - 引导里勾了的、要登录的渠道（BOSS、脉脉、LinkedIn、小红书）：每个站一行，按钮在专用 Chrome 里打开它的登录页，
//     并让登录看守（lib/login-watch.mjs）接下来 10 分钟每 20 秒看一次；看到登好了，和点「我登好了」一样记下，这一行就打勾；
//   - 接上邮箱（内置邮箱，lib/mail/）：接好、测通了就打勾；
//   - 配对手机：可选，不算在「还差几步」里。
// 只在 Mac 版、引导走完以后来信；同一封信（id 固定），必须做的都做完就自己收起来；「以后再说」一周内不再出现。
// 不挂在指挥台顶上（负责人定过：那里只放真挡路的）。
import { read, write } from './store.mjs';
import { DISCOVERY_SOURCES, sourceEnabled } from './discovery-policy.mjs';
import { loadAccounts, sessionForKey } from './accounts.mjs';
import { loadPortalSessions } from './apply-channel.mjs';
import { loadAccount } from './mail/vault.mjs';
import { phoneLink } from './phone-status.mjs';
import { onboardingState } from './onboarding-state.mjs';
import { appShell } from './capabilities.mjs';

// 要登录才能扫的渠道 → config/accounts.json 里的账号（登录页、检查方法都在那里）。和 lib/onboarding.mjs 的 BROWSER_SOURCES 同一组。
export const LOGIN_SOURCES = { boss: 'boss', maimai: 'maimai', linkedin: 'linkedin', xiaohongshu: 'xiaohongshu' };
export const UNLOCK_ID = 'unlock';
// 接邮箱的那一页是「设置 → 账号与连接 → 邮箱」（web/settings/accounts.js 的 mail 子页：授权码 → 测试 → 保存）。以前指到「高级」里的
// 「高级邮箱接入」（自己的 Google 授权），那是另一条路，第 6b 轮负责人照着点找不到接邮箱的地方。
export const MAIL_GO = '#settings/accounts/mail';
const PHONE_GO = '#settings/notify';

// 每行 { key, label, done, required, step }。step 就是收件箱选项里的那一步（open 带 watch / navigate），信和设置页按同一个走。
export function unlockItems({
  policy = read('config/human-source-policy.json', {}) || {},
  sessions = loadPortalSessions(),
  cfg = loadAccounts(),
  mail = () => loadAccount()?.status === 'ok',
  phone = () => phoneLink().paired > 0,
} = {}) {
  const rows = [];
  for (const [source, account] of Object.entries(LOGIN_SOURCES)) {
    if (!sourceEnabled(source, policy)) continue;
    const fam = cfg.families?.[account];
    if (!fam?.login_url) continue;
    const name = DISCOVERY_SOURCES[source] || fam.label || account;
    // why：按钮下面那一小行，只说做了以后能用上什么（不是教程）。
    rows.push({ key: `login:${account}`, label: `登录${name}`, done: sessionForKey(account, sessions, cfg)?.logged_in === true, required: true,
      // BOSS 直聘的网页让你用手机上的 BOSS App 扫码登录（第 6b 轮负责人登 BOSS 时碰到的）。
      why: source === 'boss' ? '在专用 Chrome 里打开，用手机上的 BOSS 直聘 App 扫码登录' : `在专用 Chrome 里登录；${name}上的岗位${source === 'xiaohongshu' ? '帖' : '和私信'}要用`, url: fam.login_url, account: fam.probe ? account : null,
      step: { type: 'open', url: fam.login_url, ...(fam.probe ? { watch: account } : {}) } });
  }
  rows.push({ key: 'mail', label: '接上邮箱', done: !!mail(), required: true, why: '招聘方的回信、面试邀约会自动读进来', step: { type: 'navigate', to: MAIL_GO } });
  rows.push({ key: 'phone', label: '配对手机', done: !!phone(), required: false, why: '等你回的事在手机上也能看、能批准', step: { type: 'navigate', to: PHONE_GO } });
  return rows;
}

const option = (key, label, steps, extra = {}) => ({ key: String(key), label, steps, ...extra });
// 什么时候来（第 6b 轮）：引导走完了；或者不在引导里、资料也在——从命令行版导进来的数据（没有引导的记号，status 是 null）、
// 在引导里点了「跳过」后来自己把资料补齐的，都算。以前只认 status === 'finished'，这两种人顶上那行和信都不来。
// 跳过了又还没有资料的不算：他们收到的是「还没告诉团队你想找什么」（lib/onboarding-state.mjs skippedGuideAsk）。
export const unlockReady = (o = onboardingState()) => o.status === 'finished' || (!o.first_run && !!o.facts);
// 「以后再说」：信里点的和顶上那一行是同一个开关（state/ask-snooze.json 的 unlock，lib/ask-actions.mjs snooze）。
export const unlockSnoozed = (now = Date.now()) => Date.parse(read('state/ask-snooze.json', {})?.[UNLOCK_ID] || '') > now;

// 指挥台顶上那一行（负责人 10-03 看了截图：要放在最上面，新用户不一定会去翻收件箱）。「顶上只放挡路的」的例外：它挡的是用上全部功能。
// 只数必须做的（可选的手机不算）；都做完了、或者点过「以后再说」的那一周里没有；只在 Mac 版、引导走完以后。真挡路的那几条（lib/blockers.mjs）
// 排在它前面：一次只放一条，有挡路的就先放挡路的。点按钮打开收件箱里那封完整的清单信。
export function unlockTop({ items = null, desktop = appShell(), onboarding = onboardingState(), snoozed = unlockSnoozed(), dismissed = dismissedKeys() } = {}) {
  if (!desktop || !unlockReady(onboarding) || snoozed) return null;
  const need = (items || unlockItems()).filter(r => r.required && !r.done);
  // 关掉过（×）：那时还差的几件都还在、没有新的，就不再出来；清单里多了新的必须做的事（又勾了一个要登录的站……）才再出来。
  if (!need.length || need.every(r => dismissed.has(r.key))) return null;
  return { kind: 'unlock', text: `还差 ${need.length} 步，就能用上全部功能`, go: `#inbox?ask=${UNLOCK_ID}`, label: '看清单', closable: true };
}
// 顶上这一行的「×」（负责人 10-03：「它也可以关掉」）：记下关的时候还差哪几件。只关顶上这一行，收件箱的信、设置的检查清单照旧。
// 「以后再说」是另一个开关（一周后再提醒）。
export const DISMISS_PATH = 'state/unlock-dismissed.json';
function dismissedKeys() { const k = read(DISMISS_PATH, {})?.keys; return new Set(Array.isArray(k) ? k.map(String) : []); }
export function dismissUnlockTop({ items = null, now = Date.now() } = {}) {
  const keys = (items || unlockItems()).filter(r => r.required && !r.done).map(r => r.key);
  write(DISMISS_PATH, { keys, at: new Date(now).toISOString() });
  return { status: 'dismissed', keys };
}
// 收件箱的那封信。没做完的每行一个按钮；做完的写在上面打勾（信里看得到进度）。必须做的都做完了就不来信。
export function unlockAsk({ items = null, desktop = appShell(), onboarding = onboardingState() } = {}) {
  if (!desktop || !unlockReady(onboarding)) return null;
  const rows = items || unlockItems(), todo = rows.filter(r => !r.done), need = todo.filter(r => r.required);
  if (!need.length) return null;
  return {
    from: 'patch', id: UNLOCK_ID, type: 'info', title: '已选的连接还没接齐',
    question: `你选的连接还有 ${need.length} 项没接好。各项只影响下面列出的功能；发消息和投递仍要你批准。`,
    context: rows.filter(r => r.done).map(r => `✓ ${r.label}`),
    options: [
      ...todo.map((r, i) => option(i + 1, r.required ? r.label : `${r.label}（可选）`, [r.step], { ...(r.why ? { hint: r.why } : {}), ...(i === 0 ? { primary: true } : {}) })),
      option(todo.length + 1, '以后再说', [{ type: 'snooze', hours: 24 * 7 }]),
    ],
  };
}
