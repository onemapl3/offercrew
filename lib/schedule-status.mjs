import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file, lines, read } from './store.mjs';
import { TZ, zonedTime, localHour, localTime, dayOf } from './tz.mjs';
import * as J from './jobs.mjs';
import { lastJson } from './watcher-mail.mjs';
import { cleanReason } from './wait-reason.mjs';
import { appSchedule, MAIL_POLL_HOURS, mailPollScheduleText } from './app-schedule.mjs';
import { mailReader, MAIL_WAITS } from './capabilities.mjs';
import { FACTS_EXIT } from './facts-gate.mjs';
import { discoveryOutcome, DISCOVERY_STAGES } from './discovery-outcome.mjs';
import { inQuietHours, shanghaiHour } from './personas.mjs';
export function scheduleStatus(now=Date.now()){
  const c=read('config/schedule.json',{});
  const p=process.env.RADAR_AUTOMATION_FILE||path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'automations',c.automation_id||'radar-full','automation.toml');
  let content='';try{content=fs.readFileSync(p,'utf8');}catch{} // 兜底：文件不在就是空的
  const status=content.match(/^status\s*=\s*"([^"]+)"/m)?.[1]||'UNKNOWN';
  const rule=content.match(/^rrule\s*=\s*"([^"]+)"/m)?.[1]||'';
  const hours=rule.match(/BYHOUR=([0-9,]+)/)?.[1]?.split(',').map(Number)||[];
  const minute=Number(rule.match(/BYMINUTE=(\d+)/)?.[1]||0);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(now);
  const start=zonedTime(day);
  const next=status==='ACTIVE'?[0,1].flatMap(d=>hours.map(h=>start+d*86400000+h*3600000+minute*60000)).filter(n=>n>now).sort((a,b)=>a-b)[0]:null;
  return {status,label:status==='ACTIVE'?'自动推进已开启':status==='PAUSED'?'自动推进已暂停':'调度状态待核实',next_at:next?new Date(next).toISOString():null,timezone:TZ};
}

const DAY = 86400000;
// 格式化器只建一次：每次 new Intl.DateTimeFormat 约 30 µs，一次指挥台刷新要按日期分一万多次。
export { dayOf };
const iso = x => new Date(x).toISOString();
const label = l => `${l.number ?? '待编号'} · ${l.company || '待核'} · ${l.role || ''}`;

// ── 调度────────────────────────────
export function nextCalendar(calendar = [], now = Date.now()) {
  const start = zonedTime(dayOf(now));
  const times = [0, 1].flatMap(d => calendar.map(c => start + d * DAY + c.hour * 3600000 + c.minute * 60000)).filter(t => t > now).sort((a, b) => a - b);
  return times.length ? iso(times[0]) : null;
}
export const parsePollLine = s => { const m = String(s).match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})[^\]]*\]\s*(.*)$/); return m ? { at: iso(zonedTime(m[1], m[2])), text: m[3] } : null; };
export function pollLog(sub, now = Date.now(), days = 3) {
  for (let d = 0; d < days; d++) {
    const day = dayOf(now - d * DAY).replaceAll('-', '');
    const p = file(`runs/${day}/${sub}/poll.log`);
    if (fs.existsSync(p)) return { day, lines: fs.readFileSync(p, 'utf8').split('\n').map(parsePollLine).filter(Boolean) };
  }
  return { day: null, lines: [] };
}
export function lastMatch(rows, re) { for (let i = rows.length - 1; i >= 0; i--) { const m = rows[i].text.match(re); if (m) return { ...rows[i], m }; } return null; }
// 退出码只说明进程结束。周期可能退出 0，但某一步失败；只读这次定时的账和回执，不拿后来成员的单独一轮盖它。
export function scheduledResult(startAt, finishedAt, exit) {
  if (!startAt || !finishedAt) return null;
  const begin = Date.parse(startAt), end = Date.parse(finishedAt);
  const job = J.list({ member: 'patch', kind: 'cycle', state: ['done', 'failed'], limit: 200 }).find(j => Date.parse(j.started_at || j.created_at) >= begin && Date.parse(j.finished_at || j.updated_at) <= end);
  const stamp = localTime(startAt), receipt = file(`runs/${dayOf(startAt).replaceAll('-', '')}/cycle-host/scheduled-${stamp.slice(-5).replace(':', '')}.json`);
  let data = null;
  try { data = lastJson(fs.readFileSync(receipt, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error(`[schedule] 读取周期回执失败：${e.message}`); }
  const results = Array.isArray(data?.results) ? data.results : [];
  const scan = discoveryOutcome(results);
  const partial = exit === 0 && job?.state !== 'failed' && (job?.result?.counts?.partial === true || data?.status === 'partial' && scan.status === 'partial' && !results.some(r => !DISCOVERY_STAGES.has(r.stage) && ['error', 'degraded', 'failed'].includes(r.status)));
  if (partial) return { state: 'done', partial: true, summary: job?.result?.summary || scan.text, reason: '', results, at: finishedAt, job_id: job?.id || null };
  const errors = [...(data?.errors || []), ...results.flatMap(r => [...(r.errors || []), r.error])].filter(e => typeof e === 'string' && e);
  const failed = job?.state === 'failed' || ['error', 'degraded', 'failed'].includes(data?.status) || results.some(r => ['error', 'degraded', 'failed'].includes(r.status)) || errors.length > 0 || exit !== 0;
  const recorded = job || ['changed', 'no_change', 'ok'].includes(data?.status);
  return { state: failed ? 'failed' : recorded ? 'done' : 'unknown', summary: job?.result?.summary || '', reason: cleanReason(job?.reason || errors.join('；')), results, at: finishedAt, job_id: job?.id || null };
}
// 上一次巡检之后，下一次真会跑的那一轮：每小时一格，窗口外的跳过；窗口里到点了还没跑（睡着了之类）就是现在。
export function mailPollNext(lastAt, now = Date.now()) {
  const last = Date.parse(lastAt || '');
  if (!Number.isFinite(last)) return null;
  const inWindow = t => { const h = localHour(t); return h >= MAIL_POLL_HOURS[0] && h < MAIL_POLL_HOURS[1]; };
  if (inWindow(now) && last + 3600000 <= now) return iso(now);
  for (let t = last + 3600000, i = 0; i < 72; t += 3600000, i++) if (t > now && inWindow(t)) return iso(t);
  return null;
}
// 桌面版（RADAR_SCHEDULER=app，10-02 开箱第 2 轮 X1）：定时在工作台进程里跑（lib/app-schedule.mjs），不看 launchd——这台电脑上
// launchd 里的项是别的安装的（以前团队页在 App 里写「没加载」「定时任务未安装」，查信写「马上会跑」）。周期按 App 的表，
// 周期只跑引擎那一段（命令行版 10-04 冻结）；查信接了内置邮箱才排，照实写。
export function appScheduleView({ now, runtime }) {
  const cycleLog = pollLog('cycle-host', now), reader = mailReader();
  const cal = times => times.map(t => { const [hour, minute] = t.split(':').map(Number); return { hour, minute }; });
  const items = appSchedule().map(j => {
    const isBrief = j.name === 'brief';
    const start = lastMatch(cycleLog.lines, isBrief ? /^brief start/ : /^scheduled start/);
    const end = lastMatch(cycleLog.lines, isBrief ? /^brief exit=(\d+)/ : /^codex exit=(\d+)|^scheduled exit=(\d+)/);
    const finishedAt = end && (!start || end.at >= start.at) ? end.at : null;
    const exit = finishedAt ? Number(end.m[1] ?? end.m[2]) : null;
    return { label: `app-${j.name}`, kind: isBrief ? 'brief' : 'cycle', calendar: cal(j.times), title: isBrief ? '今日战报' : '周期', schedule: `${j.times.join(' / ')}，App 开着时`, next_at: nextCalendar(cal(j.times), now), last_started_at: start?.at || null, last_finished_at: finishedAt, last_exit: exit, last_result: !isBrief ? scheduledResult(start?.at, finishedAt, exit) : null, facts_held: !isBrief && exit === FACTS_EXIT, running: !!start && !finishedAt && now - Date.parse(start.at) < 60 * 60000, loaded: null, pid: null };
  });
  // 接了内置邮箱：每小时整点读一次（lib/app-schedule.mjs 的 mail 任务），App 开着时有新信也读（lib/mail/live.mjs）；
  // 上次读信记在 runs/<日>/mail-poll/poll.log（和命令行版同一个）。没接就照旧写「查信要等邮箱接好」。
  if (reader.worker) {
    const mail = lastMatch(pollLog('mail-poll', now).lines, /^mail-poll exit=(\d+)/);
    const calendar = Array.from({ length: MAIL_POLL_HOURS[1] - MAIL_POLL_HOURS[0] }, (_, i) => ({ hour: MAIL_POLL_HOURS[0] + i, minute: 0 }));
    items.push({ label: 'app-mailpoll', kind: 'mailpoll', title: '收件箱巡检（内置邮箱）', calendar, schedule: mailPollScheduleText(), next_at: nextCalendar(calendar, now), last_started_at: null, last_finished_at: mail?.at || null, last_exit: mail ? Number(mail.m[1]) : null, running: false, loaded: null, pid: null });
  } else items.push({ label: 'app-mailpoll', kind: 'mailpoll', title: '收件箱巡检', schedule: MAIL_WAITS, off: true, next_at: null, last_started_at: null, last_finished_at: null, last_exit: null, running: false, loaded: null, pid: null });
  items.push({ label: 'app-workbench', kind: 'workbench', title: '本地工作台', schedule: 'App 开着就在', next_at: null, last_started_at: runtime.started_at || null, last_finished_at: null, last_exit: null, running: true, loaded: null, pid: process.pid });
  const starts = cycleLog.lines.filter(l => /^scheduled start/.test(l.text)).map(l => l.at);
  return { items, poll_log: cycleLog.lines.slice(-8), starts, mail_log: [], quiet_hours: inQuietHours(now, read('config/concierge.json', {})), hour: shanghaiHour(now), app: true };
}
// 定时只有一种（命令行版 10-04 冻结，launchd 不再看）：工作台进程里的 App 定时（lib/app-schedule.mjs）。
export function scheduleView({ now = Date.now(), runtime = {} } = {}) {
  return appScheduleView({ now, runtime });
}
