// 内置邮箱的主密钥放在哪：钥匙串这一层可以替换，测试一律用假的（负责人 10-02 红线）。
//
//   mac      真的 macOS 钥匙串，只经 /usr/bin/security 读写我们自己的那一个条目（服务 SERVICE、账户 ACCOUNT）：
//            读 = find-generic-password -s … -a … -w；写 = add-generic-password，经 `security -i` 的标准输入传，
//            密钥不出现在命令行参数里（ps 看不到）。只加不改（不带 -U），已经有了就读它。
//            不列出、不读别的条目，也从来不删（任何 delete-* 都不跑）。
//   file     假钥匙串：数据目录里的一个普通文件（private/mail/keychain-stand-in.json）。只给测试、演示 / 沙盒用，
//            它和加密的授权码放在同一个目录里，等于没加密；正式运行不会选到它。
//   memory   假钥匙串：只在这个进程的内存里（单元测试）。
//
// 选哪一个（keychain()）：先看 useKeychain() 换上的；再看 RADAR_MAIL_KEYCHAIN=file|memory；沙盒（lib/sandbox.mjs）
// 和 node --test 底下（NODE_TEST_CONTEXT，测试起的子进程也带着）一律用 file，绝不碰登录钥匙串；剩下的 macOS 用 mac。
// 已知局限：用 security 建的条目，本机别的程序也能用 security 读出来（README「已知限制」）；
// 等 Mac 版 v0.2 关掉 runAsNode 时一起换成钥匙串原生的存法。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from '../spawn.mjs';
import { file } from '../store.mjs';
import { sandboxed } from '../sandbox.mjs';

export const SERVICE = 'offercrew.mail';
export const ACCOUNT = 'master-key-v1';
const SECURITY = '/usr/bin/security';
const NOT_FOUND = 44; // security 的退出码：找不到条目
export const STAND_IN = 'private/mail/keychain-stand-in.json';

const fail = (code, message) => Object.assign(Error(message), { code });
const validKey = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

export const underTest = () => !!process.env.NODE_TEST_CONTEXT;

// 真的钥匙串。security 读不到就是 null；别的失败（钥匙串锁着、用户拒绝）报 keychain_unavailable。
// bin 只给测试换成一个假的 security（核对命令的写法）；测试和沙盒里用真的 /usr/bin/security 一律拒绝。
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
export function macKeychain({ bin = SECURITY } = {}) {
  if ((underTest() || sandboxed()) && (!path.isAbsolute(bin) || real(bin) === real(SECURITY))) throw fail('keychain_refused', '测试和演示 / 沙盒模式不碰登录钥匙串');
  const run = (args, input) => new Promise((resolve) => {
    const child = input == null
      ? execFile(bin, args, { timeout: 15000 }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout || '') }))
      : spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], timeout: 15000 });
    if (input != null) {
      child.on('error', () => resolve({ code: -1, stdout: '' }));
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout: '' }));
      child.stdin.end(input);
    }
  });
  const read = async () => {
    const r = await run(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw fail('keychain_unavailable', '钥匙串打不开（可能锁着，或者没允许）');
    const v = r.stdout.trim();
    if (!validKey(v)) throw fail('keychain_unavailable', '钥匙串里的邮箱密钥坏了');
    return v;
  };
  return {
    kind: 'mac',
    read,
    async add(hex) {
      if (!validKey(hex)) throw fail('keychain_bad_key', 'bad key');
      // 交互模式从标准输入读命令：服务名、账户名都是不带空格的固定字串，不用引号。
      await run(['-i'], `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${hex}\n`);
      // security -i 的退出码不总带出子命令的结果：写完再读一次，读得到才算数（已经有了也一样，读到的就是那一把）。
      const back = await read();
      if (back) return back;
      throw fail('keychain_unavailable', '钥匙串没写进去（可能锁着，或者没允许）');
    },
  };
}

// 假钥匙串：一个文件。只给测试和沙盒。
export function fileKeychain(p = STAND_IN) {
  const abs = () => (path.isAbsolute(p) ? p : file(p));
  return {
    kind: 'file',
    async read() {
      try { const v = JSON.parse(fs.readFileSync(abs(), 'utf8'))?.[`${SERVICE}/${ACCOUNT}`]; return validKey(v) ? v : null; } catch { return null; } // 兜底：没有存过就是 null
    },
    async add(hex) {
      if (!validKey(hex)) throw fail('keychain_bad_key', 'bad key');
      const cur = await this.read();
      if (cur) return cur;
      fs.mkdirSync(path.dirname(abs()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(abs(), JSON.stringify({ note: 'stand-in keychain for tests and sandbox only', [`${SERVICE}/${ACCOUNT}`]: hex }) + '\n', { mode: 0o600 });
      return hex;
    },
  };
}

export function memoryKeychain() {
  let v = null;
  return { kind: 'memory', async read() { return v; }, async add(hex) { if (!validKey(hex)) throw fail('keychain_bad_key', 'bad key'); if (!v) v = hex; return v; } };
}

let chosen = null;
export function useKeychain(k) { chosen = k || null; }

export function keychain() {
  if (chosen) return chosen;
  const want = String(process.env.RADAR_MAIL_KEYCHAIN || '').trim().toLowerCase();
  if (want === 'memory') return (chosen = memoryKeychain());
  if (want === 'file' || underTest() || sandboxed()) return fileKeychain();
  if (process.platform === 'darwin') return macKeychain();
  throw fail('keychain_unavailable', '这台电脑上没有钥匙串，内置邮箱只支持 Mac');
}
