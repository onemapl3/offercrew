// K46：旧资料中的中英文城市别名合并。启动时运行；幂等，先备份，不改陌生结构。
import fs from 'node:fs';
import YAML from 'yaml';
import { file, write } from './store.mjs';
import { forgetFacts } from './facts.mjs';
import { backupCandidate } from './profile.mjs';
import { cityName, cityNames } from './city.mjs';
const FACTS = 'candidate/facts.yaml';
export function upgradeCityNames({ now = Date.now() } = {}) {
  let src;
  try { src = fs.readFileSync(file(FACTS), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { upgraded: 0 }; throw e; }
  const doc = YAML.parseDocument(src);
  if (doc.errors.length || !YAML.isMap(doc.contents)) throw Error('个人资料无法读取，城市迁移未写入');
  const loc = doc.get('location', true);
  if (!YAML.isMap(loc)) return { upgraded: 0 };
  let upgraded = 0;
  for (const key of ['current_city', 'target_cities', 'relocation_cities']) {
    const node = loc.get(key, true), old = YAML.isNode(node) ? node.toJSON() : node;
    if (typeof old !== 'string' && !(key !== 'current_city' && Array.isArray(old) && old.every(x => typeof x === 'string'))) continue;
    const next = key === 'current_city' ? cityName(old) : cityNames(old);
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    const replacement = doc.createNode(next);
    for (const p of ['comment', 'commentBefore', 'spaceBefore']) if (node?.[p] != null) replacement[p] = node[p];
    loc.set(key, replacement); upgraded++;
  }
  if (!upgraded) return { upgraded: 0 };
  const [backup] = backupCandidate([FACTS], now);
  write(FACTS, doc.toString()); forgetFacts();
  return { upgraded, backup };
}
