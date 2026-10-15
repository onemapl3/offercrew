// 这个脚本是不是被直接运行的（node bin/x.mjs），而不是被别的模块 import 进来的。
//
// 必须比较真实路径。Mac App 的数据目录里 bin/ 是指向 App 包的软链接（lib/data-root.mjs），路径里还有空格
// （~/Library/Application Support/OfferCrew）；演示目录的 bin/ 也是软链接（bin/demo-seed.mjs）。import.meta.url
// 是解析过软链接、空格写成 %20 的地址，拿它和 process.argv[1] 直接比永远不相等：脚本什么都不做就以 0 退出，
// 执行器用 node bin/job.mjs 汇报的结果就这样悄悄丢了。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl)); } catch { return false; } // 兜底：路径解析不了就不是直接运行
}
