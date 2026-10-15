import fs from "node:fs";
import { file } from "./store.mjs";
import { held } from "./lock-held.mjs";
export { LOCK_ENV } from "./lock-held.mjs";

// 有名字的独占锁：同一样外部资源一次只有一个进程在用（一轮周期 cycle、匹配 matching、扫官方源 discovery、读信 mailread、
// 发信 mailsend、电脑操作 computeruse、简历导 PDF resumepdf、浏览器工作区 browserspaces、访问节奏 visits……）。
// 锁文件 private/<名>.lock 写着持有进程的 pid；进程没了的锁下一个人来时清掉。同一个进程里不重入。
//
// 全局 state 锁退役了（第 2 步，2026-10-05）：状态在库里的靠事务（SQLite WAL + busy_timeout），还在文件里的靠 lib/store.mjs
// 写前重读、三方合并（lib/merge3.mjs），进程之间不再为了写状态排队。所以这里不再有缺省的名字，也不再有「借锁」。
export function lock(name) {
  if (!/^[a-z]+$/.test(name || '') || name === 'state') throw Error('invalid_lock_name');
  if (held.has(name)) throw Error("another_radar_writer_running");
  const path = file(`private/${name}.lock`);
  fs.mkdirSync(file("private"), { recursive: true });
  try {
    fs.writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(fs.readFileSync(path, "utf8"));
    try {
      process.kill(pid, 0);
      throw Error("another_radar_writer_running");
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
      fs.unlinkSync(path);
      fs.writeFileSync(path, String(process.pid), { flag: "wx" });
    }
  }
  const token = Symbol(name);
  held.set(name, token);
  const release = () => {
    if (held.get(name) === token) held.delete(name);
    if (fs.existsSync(path) && fs.readFileSync(path, "utf8") === String(process.pid)) fs.unlinkSync(path);
    process.removeListener('exit',release);
    process.removeListener('SIGTERM',terminate);
    process.removeListener('SIGINT',interrupt);
  };
  const terminate=()=>{release();process.exit(143);};
  const interrupt=()=>{release();process.exit(130);};
  process.once("exit", release);
  process.once("SIGTERM", terminate);
  process.once("SIGINT", interrupt);
  return release;
}

export async function waitForLock(name, {timeout=300000, interval=500}={}) {
  const deadline=Date.now()+timeout;
  for (;;) {
    try { return lock(name); } catch (e) {
      if(e.message!=='another_radar_writer_running'||Date.now()>=deadline) throw e;
      await new Promise(resolve=>setTimeout(resolve,interval));
    }
  }
}
