// 告警的几条规矩（负责人 10-04：「最上面的 12 条严重告警……好像解决不了，也消不掉」）。lib/command-center.mjs alertsView 算出每一条，这里定：
//   严重   只留真挡路、而且你能动手的：有一个修它的去处（fix：哪一页、按钮上写什么）。别的一律降成「警告」，进团队页 System 名下和运行日志，
//          不占指挥台顶上（lib/blockers.mjs、团队页顶栏、System 的回答都只数严重的）。
//   关掉   每一条都能点「不用管这条」：同类（同一位、同一步）24 小时内不再上来（state/alerts-dismissed.json）。
//   恢复   查账：后来同一步，或者同一类活同一位成员在账上做完了（done）就算恢复（laterSuccess）。挂在哪个岗位上的失败，
//          那个岗位的活自己还是失败的，在任务卡和那一行上看得到；告警只管这类活还在不在出错。
//   不算失败  求职信 / 简历「核对没过」是正常结果（信上已经标出来了），不进告警（老记录按原话认）。
//   飞书   Mac 模式下，只有这个 App 里真接过飞书（有飞书的凭据文件或环境变量）才报长连接和同步；只有从命令行版导进来的 profile 的不报。
import fs from 'node:fs';
import { file, read, write } from './store.mjs';
import { STAGE_KIND } from './crew.mjs';
import * as J from './jobs.mjs';

export const DISMISSED = 'state/alerts-dismissed.json';
const DAY = 86400000;
const T = x => Date.parse(x || '') || 0;

// 不算系统出错的「fail」：核对没过（Writer 写的话在你的材料里找不到出处，信上标着，等你改）。
export const notFailure = e => !!e.check_failed || (e.actor === 'tailor' || e.actor === 'reacher') && /核对没过/.test(String(e.msg || ''));

// 一类活：步骤名不一样、做的是同一件事。周期的步按 lib/crew.mjs STAGE_KIND 认成任务卡的类型（discover 和「扫官方源」的卡是一类），
// 剩下几个 Writer 的步骤名在这里并类。
const FAMILY = { 'tailor-resume': 'tailor', resume: 'tailor', cover_letter: 'letter', self_intro: 'letter', email: 'letter' };
export const family = step => STAGE_KIND[step] || FAMILY[step] || step;

// 恢复查账（线 S）：失败之后，账上同一步（kind 一样）、或者同一位成员同一类活有一件做完了（state done，「成功」只有这一种写法），
// 这条告警就算恢复。g：{ role, step, last_at }。done：账上做完了的活（不给就查账）。回那件活做完的时间，没有就是 null。
export function laterSuccess(g, done = J.list({ state: 'done', since: g.last_at, limit: 1000 })) {
  const fam = family(g.step);
  const hit = done.filter(j => j.state === 'done' && String(j.finished_at || j.updated_at || '') > String(g.last_at || '') && ((j.kind === g.step && (g.step !== 'cycle' || j.member === g.role)) || (family(j.kind) === fam && j.member === g.role)));
  return hit.map(j => j.finished_at || j.updated_at).sort().at(-1) || null;
}

// 这个 App 里有没有真接过飞书（命令行版 10-04 冻结：只写了 profile 不算）。
// 每类告警修它的去处（按钮上的字不以「去」开头）。没有的就只能「不用管这条」。
const FIX = {
  stack: { label: '模型设置', to: '#settings/model' },
  'stack-skip': { label: '模型设置', to: '#settings/model' },
  'stack-roles': { label: '模型设置', to: '#settings/model' },
};

const loadDismissed = (now) => { const d = read(DISMISSED, {}) || {}; return Object.fromEntries(Object.entries(d).filter(([, until]) => T(until) > now)); };
export const alertKey = a => `${a.source || 'patch'}|${a.id || a.step || 'run'}`;

// 收尾：每条带上 key、fix（有的话）、能不能关；没有去处的严重降成警告；关掉的同类拿掉。
export function finishAlerts(list, { now = Date.now() } = {}) {
  const off = loadDismissed(now);
  return list.map(a => {
    const key = alertKey(a), fix = a.fix || FIX[a.id] || null;
    return { ...a, key, ...(fix ? { fix } : {}), level: a.level === 'error' && !fix ? 'warn' : a.level, dismissible: !a.recovered_at };
  }).filter(a => !off[a.key]);
}

// POST /api/alerts { action: 'dismiss', key }：这一类 24 小时内不再上来。
export function alertsPost({ action, key } = {}, { now = Date.now() } = {}) {
  if (action !== 'dismiss') throw Object.assign(Error('未知的操作'), { status: 400 });
  const k = String(key || '');
  if (!k || k.length > 200 || !k.includes('|')) throw Object.assign(Error('这条告警认不出来'), { status: 400 });
  write(DISMISSED, { ...loadDismissed(now), [k]: new Date(now + DAY).toISOString() });
  return { ok: true, key: k, until: new Date(now + DAY).toISOString() };
}
