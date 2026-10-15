// 材料 · 简历版本怎么称呼（2026-10-01，视觉验收第 1 轮 #9、#38）。不 import 任何东西：
// lib/resume-choice.mjs（终审信、岗位页）、lib/team.mjs、事件文字都从这里拿，不会引出 import 环。
//
// 版本名读的时候整理一下：
//   - 挨着重复的「 · 」段只留一个（旧的「用这版」会在名字后面一再加「· Writer 改过」，迁移、演示里有叠了字的）；
//   - 末尾自动加的「 · Writer 改过」「 · Writer 定制」去掉：谁改的已经写在下面一行（「Writer 改的，基于 v2」）。
//     只认这两个原样的后缀，你自己起的名字不动。
const AUTO_SUFFIX = / · Writer (?:改过|定制)$/;
export function tidyName(n) {
  let s = String(n ?? '').split(' · ').filter((x, i, a) => i === 0 || x !== a[i - 1]).join(' · ');
  while (AUTO_SUFFIX.test(s)) s = s.replace(AUTO_SUFFIX, '');
  return s;
}

// 一个版本在哪儿都叫同一个名字（QA #9：岗位页、材料页、运行日志以前叫法各不一样）：「v3 · 通用版」。
// 语言要紧的地方（岗位页、终审信、运行日志、团队页）带 lang，前面加一次语言：「英文 · v3 · 通用版」。
//   doc      简历文档（拿它的 lang 和 versions）；没有也行。
//   version  版本对象（{ id, name }），或者版本编号（到 doc.versions 里找名字）。
//   lang     true 用 doc.lang；'zh' / 'en' 指定；默认不加。
export const LANG_WORD = { zh: '中文', en: '英文' };
export function versionLabel(doc, version, { lang = false } = {}) {
  const v = typeof version === 'string' ? (doc?.versions || []).find(x => x.id === version) || { id: version } : version || {};
  const id = String(v.id ?? ''), name = tidyName(v.name).trim();
  const core = !name || name === id ? id : id ? `${id} · ${name}` : name;
  const l = lang === true ? doc?.lang : lang;
  return core && LANG_WORD[l] ? `${LANG_WORD[l]} · ${core}` : core;
}
