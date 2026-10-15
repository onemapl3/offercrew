// 宿主脚本（bin/host/*.sh）按名字调 node。桌面版的用户电脑上没有 node，就在数据目录里放一个同名小脚本，
// 让它用 App 自己的程序、带上 ELECTRON_RUN_AS_NODE=1 当 Node 跑。每次启动按 App 当前的位置重写。
import fs from 'node:fs';
import path from 'node:path';

export function writeNodeShim({ dataDir, nodeBinary }) {
  const dir = path.join(dataDir, '.offercrew', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const q = s => `'${String(s).replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(nodeBinary)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(path.join(dir, 'node'), 0o755);
  return dir;
}
