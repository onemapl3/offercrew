// 迁移到另一台机器。
//   node bin/migrate.mjs --export [--out 路径.tgz] [--with-state] [--with-logins]
//   node bin/migrate.mjs --import 路径.tgz [--dry-run] [--take-over] [--overwrite-codex-config]
//   node bin/migrate.mjs --list [--with-state] [--with-logins]     # 只看会打包哪些文件
import { arg } from '../lib/store.mjs';
import { exportBundle, importBundle, bundleItems } from '../lib/migrate.mjs';
const has = f => process.argv.includes(f);
try {
  if (has('--export')) { const r = exportBundle({ out: arg('--out'), withState: has('--with-state'), withLogins: has('--with-logins') }); console.log(JSON.stringify({ status: 'exported', path: r.path, bytes: r.bytes, items: r.items, with_state: has('--with-state'), with_logins: has('--with-logins'), note: '包里有密钥，只通过你自己的通道传到新机器。' }, null, 2)); }
  else if (has('--import')) { const r = importBundle({ archive: arg('--import'), dryRun: has('--dry-run'), takeOver: has('--take-over'), overwriteCodexConfig: has('--overwrite-codex-config') }); console.log(JSON.stringify(r, null, 2)); }
  else if (has('--list')) console.log(JSON.stringify(bundleItems({ withState: has('--with-state'), withLogins: has('--with-logins') }).map(i => `${i.kind}:${i.rel}`), null, 2));
  else { console.log('用法见文件头'); process.exitCode = 2; }
} catch (e) { console.log(JSON.stringify({ status: 'error', error: e.message })); process.exitCode = 1; }
