// 社招、校招、实习：一家公司的招聘门户往往三样都有，读哪几样由候选人所处的阶段决定（design P1-1）。
//
//   在读（最后一段教育还没结束）  → 实习 + 校招
//   应届（毕业不到 18 个月）      → 校招 + 社招
//   有经验                        → 只读社招，和以前一样
//
// 阶段来自 lib/directions.mjs 的 candidateStage(facts)。软件方向（没写方向的人，包括作者本人）不看阶段，
// 永远只读社招：那条老路径一条都不变。companies.yaml 里写 `recruit_types: [social, campus, intern]` 可以
// 按公司覆盖（比如某家只想看它的实习）。每条线索记下自己是哪一种（recruit_type），收件箱和判断都能看见。
import { currentFacts } from '../facts.mjs';
import { candidateStage, isGeneral } from '../directions.mjs';

export const RECRUIT_TYPES = ['social', 'campus', 'intern'];
export const RECRUIT_LABEL = { social: '社招', campus: '校招', intern: '实习' };
const ALIAS = { social: 'social', experienced: 'social', 社招: 'social', campus: 'campus', graduate: 'campus', new_grad: 'campus', 校招: 'campus', intern: 'intern', internship: 'intern', 实习: 'intern' };

export function stageRecruitTypes(facts = {}) {
  if (!isGeneral(facts)) return ['social'];
  const stage = candidateStage(facts);
  return stage === 'student' ? ['intern', 'campus'] : stage === 'new_grad' ? ['campus', 'social'] : ['social'];
}

// 这一家要读哪几类，按上面的顺序（先读的先占预算）。写错的类别名直接忽略；全写错等于没写。
export function recruitTypesOf(c = {}, facts = currentFacts()) {
  const own = [...new Set([c.recruit_types].flat().map((t) => ALIAS[String(t ?? '').trim().toLowerCase()] || ALIAS[String(t ?? '').trim()]).filter(Boolean))];
  return own.length ? own : stageRecruitTypes(facts);
}

// 校招板上一条岗位是实习还是正式校招：板子自己标了类型就用它（美国银行的 Program type），否则看标题。
// 暑期分析师、off-cycle、industrial placement、以 Stage 开头的法语岗位名都是实习；Analyst Program、Graduate、管培生是校招。
const INTERN = /\bintern(?:ship)?s?\b|summer (?:analyst|associate|program)|off[- ]cycle|industrial placement|placement year|work experience|insight (?:week|programme|program)|spring week|^\s*stage\b|\bco-?op\b|实习/i;
export const internOrCampus = (...texts) => (texts.some((t) => INTERN.test(String(t || ''))) ? 'intern' : 'campus');
