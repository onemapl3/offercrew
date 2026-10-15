// 把提示词模板（config/*-prompt.md）里的占位符填好写到 stdout，原样保留其余每个字节（lib/prompt.mjs）。
// 用法：node bin/host/render-prompt.mjs <模板> [仓库根，缺省为当前目录]
// 出错时什么都不写、退出码非 0：调用它的脚本会退回模板原文（见 bin/host/run-now.sh 的 prompt_text）。
import fs from 'node:fs';
import { renderPrompt, promptVars } from '../../lib/prompt.mjs';

const [template, root = process.cwd()] = process.argv.slice(2);
const text = renderPrompt(fs.readFileSync(template, 'utf8'), promptVars({ root }));
process.stdout.write(text);
