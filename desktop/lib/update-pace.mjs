// 什么时候查更新（主会话 10-04：0.1.5 发了以后，负责人的 App 要等到下一个 6 小时才亮「重启以更新」）：
// 启动时查一次；之后每小时查一次；窗口回到前台也查，但离上一次查不到 30 分钟就不查。你手动点「检查更新」（manual）不受这 30 分钟限制。
// 正在查的时候不再叠一次：回正在查的那次。
export const EVERY_MS = 3600 * 1000;
export const FOCUS_GAP_MS = 30 * 60 * 1000;

// run：真正去查的函数。返回的函数按 reason（'start' | 'timer' | 'focus' | 'manual'）决定查不查：查就回这次的 Promise；
// 正在查就回正在查的那次；离上次太近的 focus 回 null。
export function pacedCheck(run, { gapMs = FOCUS_GAP_MS, now = () => Date.now() } = {}) {
  let last = -Infinity, inflight = null;
  return (reason = 'timer') => {
    if (inflight) return inflight;
    if (reason === 'focus' && now() - last < gapMs) return null;
    last = now();
    inflight = Promise.resolve().then(run).finally(() => { inflight = null; });
    return inflight;
  };
}
