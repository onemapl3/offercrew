// 按方向的示例资料（2026-09-29）：candidate/templates/<名>.example.yaml，每份是一个虚构的人，
// 给「开始使用 → 你的方向 → 看示例」对照着写（GET /api/setup/template?direction=…）。
//
// 只读下面这三份：页面传来的方向只用来查表，从不拼进路径，别的文件一律读不到。没有专门示例的方向给最接近的一份，
// 并照实说是参照：咨询 → 金融（一样先看 GPA、证书、实习），产品、数据分析 → 市场（一样先看作品和数据成绩）；
// 运营就在市场那份示例人物的方向里（市场 + 运营），算对口。
// 示例跟着代码走（和 web/ 一样从代码目录读）：RADAR_ROOT 指向演示根或测试的临时目录时照样读得到。
import fs from 'node:fs';
import YAML from 'yaml';
import { DIRECTIONS, directionsOf, directionLabel } from './directions.mjs';

export const TEMPLATE_FILES = { software: 'software.example.yaml', finance: 'finance.example.yaml', marketing: 'marketing.example.yaml' };
const NEAREST = { consulting: 'finance', product: 'marketing', operations: 'marketing', data: 'marketing' };
const DIR = new URL('../candidate/templates/', import.meta.url);
// 界面文字（做中英文切换时换这里）：示例人物是谁，参照别的方向时怎么说。
const COPY = {
  who: { software: '一位做 AI 应用后端的软件工程师', finance: '一位在美国读金融本科的 2026 届应届生', marketing: '一位国内工作一年多的品牌营销（市场 + 运营）' },
  nearest: (dir, who) => `「${dir}」还没有专门的示例；这份是${who}的资料，字段一样，可以对照着写。`,
};

export function templateFor(direction) {
  const key = typeof direction === 'string' && Object.hasOwn(DIRECTIONS, direction) ? direction : null;
  if (!key) return null;
  return Object.hasOwn(TEMPLATE_FILES, key) ? key : NEAREST[key] || 'software';
}
export function templateView(direction) {
  const name = templateFor(direction);
  if (!name) throw Object.assign(Error('没有这个方向'), { status: 400 });
  const text = fs.readFileSync(new URL(TEMPLATE_FILES[name], DIR), 'utf8');
  // 对口 = 示例人物自己的方向里有它（运营在「市场 + 运营」那份里）。
  const exact = directionsOf(YAML.parse(text) || {}).includes(direction);
  return { direction, template: name, file: `candidate/templates/${TEMPLATE_FILES[name]}`, exact, who: COPY.who[name], note: exact ? null : COPY.nearest(directionLabel(direction), COPY.who[name]), text };
}
