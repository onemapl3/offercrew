// 「开始使用」引导走到哪了（2026-09-29）：第一次打开工作台要不要自动进引导，看这一个小文件。
//
// state/onboarding.json（state/ 整个不进仓库，.gitignore 的 state/**）：
//   { "status": "started" | "finished" | "skipped", "at": "<ISO 时间>", "started_at"?: …, "card_dismissed_at"?: … }
// 以前只写 { "completed_at": … }（走完了），照 finished 读。
//
// 「还没做完」的规则（first_run = true 时，打开工作台的任何一页都先进引导）：
//   - finished（走完了）或 skipped（点了「跳过，先看看」）：永远不再自己打开；
//   - started（自动打开过、还没走完也没跳过）：下次打开接着进引导——中途刷新、工作台重启都不丢；
//   - 没有记号：有 candidate/facts.yaml 的是老用户，从不强制进引导；没有 facts.yaml 的是新用户，进引导。
// 跳过了的新用户，指挥台顶上有一张小卡片请他回来（card），点 × 记下 card_dismissed_at 就不再出现。
import fs from 'node:fs';
import { file, read, write } from './store.mjs';
import { event } from './events.mjs';

const PATH = 'state/onboarding.json';
const STATUSES = ['started', 'finished', 'skipped'];
const fail = (status, message) => Object.assign(Error(message), { status });
const COPY = {
  skipped: '开始使用 · 引导：先跳过了，指挥台上留一张小卡片，随时点「开始」回来',
  done: '开始使用 · 引导走完了：你的求职团队已经就位',
};

function flag() {
  let f;
  try { f = read(PATH, null); } catch { return {}; } // 手改坏了：当没有记号（老用户有 facts.yaml，照样不会被拉进引导） // 兜底：手改坏了当没有记号
  if (!f || typeof f !== 'object' || Array.isArray(f)) return {};
  if (STATUSES.includes(f.status)) return f;
  return f.completed_at ? { status: 'finished', at: f.completed_at } : {};
}

export function onboardingState() {
  const f = flag(), facts = fs.existsSync(file('candidate/facts.yaml'));
  const status = f.status || null;
  const first_run = status !== 'finished' && status !== 'skipped' && (status === 'started' || !facts);
  return { status, at: f.at || null, facts, first_run, card: status === 'skipped' && !f.card_dismissed_at, completed: status === 'finished' ? f.at || null : null };
}

// action：start（自动打开时记一笔，只对还没做完的新用户）、skip、finish、dismiss_card。
export function markOnboarding(action, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString(), f = flag(), s = onboardingState();
  const keep = f.started_at ? { started_at: f.started_at } : {};
  const unchanged = () => ({ status: 'unchanged', state: s });
  if (action === 'start') {
    if (!s.first_run || s.status === 'started') return unchanged();
    write(PATH, { status: 'started', at, started_at: at });
  } else if (action === 'skip') {
    // 只有还没做完的时候跳过才算数：老用户、走完了的、已经跳过的都不变（老用户不会因此冒出指挥台卡片）。
    if (!s.first_run) return unchanged();
    write(PATH, { status: 'skipped', at, ...keep });
    event('user', 'setup', 'ok', COPY.skipped);
  } else if (action === 'finish') {
    write(PATH, { status: 'finished', at, ...keep });
    event('user', 'setup', 'ok', COPY.done);
  } else if (action === 'dismiss_card') {
    if (!s.card) return unchanged();
    write(PATH, { ...f, card_dismissed_at: at });
  } else throw fail(400, '只能是 start、skip、finish 或 dismiss_card');
  return { status: 'saved', state: onboardingState() };
}

// 跳过了引导的新用户：以前是指挥台上的一张小卡片（web/first-run.js），负责人 10-02「要你决定的进收件箱」，现在是一封信。
// 「先不设置」一周后再来；走完引导（status finished）就不再有。
export function skippedGuideAsk() {
  if (!onboardingState().card) return null;
  const option = (key, label, steps, extra = {}) => ({ key: String(key), label, steps, ...extra });
  return {
    from: 'patch', id: 'onboarding-skipped', type: 'info', title: '还没告诉团队你想找什么',
    question: '方向、城市和简历还空着，团队还没法开始找。',
    options: [option(1, '开始设置', [{ type: 'navigate', to: '#onboarding' }], { primary: true }), option(2, '先不设置', [{ type: 'snooze', hours: 24 * 7 }])],
  };
}
