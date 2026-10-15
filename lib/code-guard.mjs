// 代码守卫的信（09-30 负责人：执行器可以执行代码，不能改代码）：bin/host/code-guard.mjs 在执行器跑完后发现代码被改，
// 已经存档、还原，并在 state/code-guard/blocked.ndjson 记一笔；收件箱据此出一封「System 改了代码」，点「知道了」收起。
import { read, write, lines } from './store.mjs';

export const BLOCKED_PATH = 'state/code-guard/blocked.ndjson';
export const ACKED_PATH = 'state/code-guard/acked.json';
const acked = () => new Set(read(ACKED_PATH, []) || []);
const list = (xs, n = 4) => `${xs.slice(0, n).join('、')}${xs.length > n ? ` 等 ${xs.length} 个` : ''}`;

export function codeGuardAsks() {
  let recs = [];
  try { recs = lines(BLOCKED_PATH); } catch { recs = []; } // 兜底：记录不在就没有被拦下的
  const done = acked();
  return recs.filter(r => r?.id && !done.has(r.id)).slice(-5).reverse().map(r => {
    const files = (r.files || []).map(f => f.rel), failed = r.failed || [];
    return {
      from: 'system', id: `codeguard:${r.id}`, type: 'info',
      title: failed.length ? 'System 改了代码，没能全部还原' : 'System 改了代码，已经还原',
      question: `本机 AI 这一轮改了 ${files.length} 个代码文件（${list(files)}）。本机 AI 只能跑代码、不能改代码，${failed.length ? `能还原的已经还原，还没恢复：${list(failed)}` : '已经全部恢复原样'}；改动存在 ${r.patch}。`,
      context: ['System · 代码守卫'],
      options: [{ key: '1', label: '知道了', steps: [{ type: 'codeguard', action: 'ack', id: r.id }], primary: true }],
      other: null,
      // 全部还原了：只是告诉你一声，写进运行日志（lib/notices.mjs）；没能全部还原的留在收件箱。
      notice: !failed.length,
    };
  });
}
export function ackCodeGuard(id) {
  const done = acked();
  done.add(String(id));
  write(ACKED_PATH, [...done].slice(-200));
  return '收起了';
}
