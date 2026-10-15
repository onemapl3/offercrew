// 版本号比较，和「移到应用程序」时要不要替换（主会话 10-03：不能拿旧版顶掉新版）。
// 核心版本按数字比；同核心正式版高于预发布版，预发布数字标识按数值比，构建元数据不参与。
import fs from 'node:fs';
import path from 'node:path';

const parts = v => String(v ?? '').trim().split(/[-+]/)[0].split('.').map(n => Number.parseInt(n, 10) || 0);
const prerelease = v => {
  const s = String(v ?? '').trim().split('+')[0], i = s.indexOf('-');
  return i < 0 ? null : s.slice(i + 1).split('.');
};
// a 比 b 新：1；一样：0；旧：-1。
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  const p = prerelease(a), q = prerelease(b);
  if (!p || !q) return p ? -1 : q ? 1 : 0;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn !== qn) return pn ? -1 : 1;
    if (pn) {
      const d = BigInt(p[i]) - BigInt(q[i]);
      if (d) return d > 0n ? 1 : -1;
    } else return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}

// 一个 .app 的版本号（Info.plist 的 CFBundleShortVersionString）；没有这个 App、读不了就是 null。
export function bundleVersion(appPath, read = p => fs.readFileSync(p, 'utf8')) {
  try { return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(read(path.join(appPath, 'Contents', 'Info.plist')))?.[1]?.trim() || null; }
  catch { return null; }
}

// 「应用程序」里已经有一份（theirs），这一份是 mine：
//   none     那里没有：照常问要不要移过去；
//   replace  那里的更旧：可以换，对话框写清两个版本号；
//   keep     那里的一样新或更新：不换，打开那一份。
export function moveDecision(mine, theirs) {
  if (!theirs) return 'none';
  return compareVersions(theirs, mine) >= 0 ? 'keep' : 'replace';
}
