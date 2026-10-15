// 这个进程手里拿着哪些锁（lib/lock.mjs 写）。不引别的模块。
// 锁相关的旧环境变量（RADAR_LOCK_OWNER、RADAR_LOCK_LENT）：全局 state 锁和「借锁」都退役了（第 2 步），lib/spawn.mjs 起子进程时照旧清掉，
// 免得老版本的父进程留下的值被误认。
export const held = new Map(); // name -> token
export const LOCK_ENV = ['RADAR_LOCK_OWNER', 'RADAR_LOCK_LENT'];
