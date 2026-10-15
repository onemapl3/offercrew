// bin/host/*.sh 在演示 / 沙盒模式里什么都不跑（lib/sandbox.mjs）：脚本自己先认出模式（RADAR_SANDBOX
// 或根目录下的 state/sandbox.json），再用这里在运行日志里记一行 "sandbox: skipped <what>"。
//   node bin/host/sandbox-skip.mjs <actor> <what>
import { sandboxSkip } from '../../lib/sandbox.mjs';
const [actor = 'system', what = 'bin/host'] = process.argv.slice(2);
sandboxSkip(what, { actor });
