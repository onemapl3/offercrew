// 三方合并（第 2 步·锁退役）：一份数据读出来时的样子（base）、我改成的样子（mine）、现在库里 / 文件里的样子（theirs，别的进程可能刚改过）。
//   我没动的字段：用现在的（别人改的不被我手里的旧值盖掉）；别人没动的：用我的；两边都改了的普通对象往下一层合；两边都改了的值：我的为准。
// 全局 state 锁退役以后，「整份读出来、改几条、整份写回去」的老写法靠它不丢别的进程同时写的东西（lib/store.mjs、lib/leads.mjs、
// lib/drafts.mjs、lib/send-requests.mjs）。undefined 表示这一项不在了。
const same = (a, b) => a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function merge3(base, mine, theirs) {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(theirs, mine)) return mine;
  if (plain(base) && plain(mine) && plain(theirs)) {
    const out = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const v = merge3(base[k], mine[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return mine;
}
