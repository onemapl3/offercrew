// 执行已批准的投递：lib/apply-run.mjs applyApproved（每一条只在读写数据的那一下拿锁）。周期里那一步、操作台「执行已批准的投递」跑它；
// 从收件箱、任务卡、对话批准的那几条由引擎的 worker（lib/workers.mjs）领走后直接调同一个函数。
import { applyApproved } from '../lib/apply-run.mjs';
import { log } from '../lib/store.mjs';
import { isMain } from '../lib/is-main.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
if (isMain(import.meta.url)) {
  const spaceArg = arg('--space');
  const space = spaceArg == null ? null : Number(spaceArg);
  if (spaceArg != null && (!Number.isSafeInteger(space) || space <= 0)) throw Error('invalid_ego_space');
  const only = arg('--records') ? arg('--records').split(',').filter(Boolean) : null;
  const r = await applyApproved({ only, dryRun: process.argv.includes('--dry-run'), space });
  console.log(JSON.stringify(log('auto-apply', r)));
}
