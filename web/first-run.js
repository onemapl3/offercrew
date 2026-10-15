// 第一次打开工作台：还没做完引导的新用户，打开哪一页都先进「开始使用」的引导（2026-09-30）。
// 规则在服务端（lib/onboarding-state.mjs，GET /api/onboarding/state 的 first_run）；这里只决定跳到哪。
// bootTarget / setupTarget 是纯函数，tests/first-run.test.mjs 直接测。

// ── 界面文字 ────────────────────────────────────────────────────────────────

let state = null;
export const firstRunState = () => state;
// 桌面版刚启动时引擎可能还没完全起来：读不到就再试两次（每次隔半秒），还不行才当作「不跳」。
export async function loadFirstRun({ tries = 3, wait = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch('/api/onboarding/state'); if (r.ok) { state = await r.json(); return state; } } catch {}
    if (i < tries - 1) await new Promise(res => setTimeout(res, wait));
  }
  return state;
}

const pageOf = hash => String(hash || '').replace(/^#/, '').split(/[/?]/)[0];
// 打开工作台时要不要先跳进引导：还没做完（first_run），而且不是已经在引导里。返回要换成的 hash，或者 null。
export function bootTarget(s, hash) {
  if (!s?.first_run) return null;
  return pageOf(hash) === 'onboarding' ? null : '#onboarding';
}
// 旧的 #setup 链接：还没做完的去引导，做完了（或老用户）去「设置 → 检查清单」。
export const setupTarget = s => (s?.first_run ? '#onboarding' : '#settings/setup');
// 跳过了引导的新用户：以前指挥台上有一张小卡片，10-02 起是收件箱里的一封信（lib/onboarding-state.mjs skippedGuideAsk）。
