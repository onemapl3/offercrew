// 起子进程只走这里（2026-10-04 契约 2.7）：统一清掉锁相关的环境变量，子进程不继承父进程的锁。
// 签名和 node:child_process 一样，换导入路径就行。（以前的 lendLock「借锁」随全局 state 锁一起退役了，第 2 步。）
// 调用时才从 child_process 取函数，沙盒（lib/sandbox.mjs）换掉的版本照样生效。
import * as cp from 'node:child_process';
import { promisify } from 'node:util';
import { LOCK_ENV } from './lock-held.mjs';

export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of LOCK_ENV) delete out[k];
  // 那件活的 id（RADAR_JOB_ID，lib/command-center.mjs runOp 传给它直接起的那一层）：只给直接起的那一层，孙进程不继承——
  // 和这个进程自己拿到的一样，就是顺手传下去的，拿掉；调用方显式给了另一件，才留着。
  if (out.RADAR_JOB_ID && out.RADAR_JOB_ID === process.env.RADAR_JOB_ID) delete out.RADAR_JOB_ID;
  return out;
}

const isOpts = a => a != null && typeof a === 'object' && !Array.isArray(a);
// argv 是 (命令, [参数], [选项], [回调]) 或 (命令, [选项])：找到选项换上干净的 env，没有就补一个。
function clean(argv) {
  const args = [...argv];
  let i = args.findIndex((a, k) => k > 0 && isOpts(a));
  if (i < 0) {
    i = Array.isArray(args[1]) ? 2 : 1;
    while (args.length < i) args.push(undefined);
    args.splice(i, 0, {});
  }
  const { lendLock: _old, ...opts } = args[i]; // 旧的 lendLock 选项：不再有借锁，丢掉
  args[i] = { ...opts, env: childEnv(opts.env ?? process.env) };
  return args;
}

export const spawnChild = (...a) => cp.spawn(...clean(a));
export const spawn = spawnChild;
export const spawnSync = (...a) => cp.spawnSync(...clean(a));
export const execFile = (...a) => cp.execFile(...clean(a));
execFile[promisify.custom] = (...a) => promisify(cp.execFile)(...clean(a));
export const execFileSync = (...a) => cp.execFileSync(...clean(a));
export const execSync = (...a) => cp.execSync(...clean(a));
