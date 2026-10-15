// 旧“不跟了”只存当时提醒的覆盖；升级一次，把有证据的本人决定接到岗位上。
import { lines, read, write, writeLines } from './store.mjs';
import { scanEvents } from './events.mjs';
import { deriveJourney, leadKey } from './journey.mjs';

const MARK = 'state/followup-upgrade.json';
function decision(e) {
  if (e.actor !== 'user' || e.status !== 'ok' || !Number.isFinite(Date.parse(e.ts))) return null;
  const command = e.step === 'room' && /^操作台指令：(\d+)\s+(暂停提醒|恢复提醒|明天提醒|后天提醒|晚点提醒)$/.exec(e.msg || '');
  const stop = e.step === 'inbox' && /^收件箱：#(\d+)\s+.+ · 不跟了$/.exec(e.msg || '');
  const m = command || stop;
  return m ? { number: Number(m[1]), paused: !command || m[2] === '暂停提醒', at: e.ts, source: 'legacy_event', run_id: e.run_id || null, lead_id: e.lead_id || null } : null;
}

export async function upgradeFollowupPreferences({ now = Date.now() } = {}) {
  if (read(MARK, {}).version === 1) return { upgraded: 0 };
  const initial = lines('state/leads.ndjson'), byNumber = new Map(), choices = new Map();
  for (const l of initial.filter(l => !l.superseded && typeof l.followup_paused !== 'boolean' && l.number != null)) {
    const n = Number(l.number);
    byNumber.set(n, byNumber.has(n) ? null : leadKey(l)); // 不把冲突编号的旧决定猜给其中一条。
  }
  for await (const e of scanEvents()) {
    const d = decision(e), rid = d && byNumber.get(d.number);
    if (!rid || (d.lead_id && d.lead_id !== rid)) continue;
    const prev = choices.get(rid);
    if (!prev || Date.parse(d.at) >= Date.parse(prev.at)) choices.set(rid, d);
  }
  // 日志缺了但当前跟进提醒的覆盖仍对得上：只认暂停，不把归档/完成或别的普通提醒当“不跟”。
  const overrides = read('state/action-overrides.json', {});
  const current = deriveJourney({ leads: initial, outbound: lines('state/outbound.ndjson'), overrides, now });
  for (const a of current.actions.filter(a => a.kind === 'followup')) {
    const o = overrides[a.id];
    if (!choices.has(a.record_id) && byNumber.get(a.number) === a.record_id && o?.paused === true && !o.completed_at && !o.archived_at) choices.set(a.record_id, { paused: true, at: null, source: 'legacy_override', action_id: a.id });
  }
  // 扫描期间若本人已有新选择，以它为准。只改旧版没有岗位级选择的行，不覆盖其他更新。
  const fresh = lines('state/leads.ndjson'); let upgraded = 0;
  for (const l of fresh) {
    const d = choices.get(leadKey(l));
    if (!d || l.superseded || typeof l.followup_paused === 'boolean') continue;
    l.followup_paused = d.paused;
    l.followup_preference = { ...d }; delete l.followup_preference.number; delete l.followup_preference.lead_id;
    upgraded++;
  }
  if (upgraded) writeLines('state/leads.ndjson', fresh);
  write(MARK, { version: 1, at: new Date(now).toISOString(), upgraded });
  return { upgraded };
}
