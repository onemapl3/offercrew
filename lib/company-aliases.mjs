// 公司跨语言别名属于本机配置，不随产品发布。每组第一项是用户选定的显示名。
import fs from 'node:fs';
import { file } from './paths.mjs';
let cached = null;
export function companyAliasGroups() {
  const p = file('config/company-aliases.json');
  let stat;
  try { stat = fs.statSync(p); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const sig = `${p}:${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  if (cached?.sig === sig) return cached.groups;
  const groups = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(groups) || groups.some(g => !Array.isArray(g) || g.length < 2 || g.some(s => typeof s !== 'string' || !s.trim()))) throw Error('config/company-aliases.json 必须是别名组数组，每组至少两个非空名称');
  cached = { sig, groups };
  return groups;
}
