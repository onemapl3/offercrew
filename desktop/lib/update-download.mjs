// 仍由 electron-updater 下载、Squirrel 接收；这里只把它们的事件接回同一个更新状态。
import { updateErrorText } from './update-status.mjs';

export function wireUpdateDownload(updater, squirrel, { getCheck, setCheck, onReady, log = () => {} }) {
  let pending = null, flight = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  const failed = e => {
    log(`update error: ${e?.message || e}`);
    if (getCheck().state === 'ready') return;
    const version = pending || getCheck().version;
    pending = null;
    setCheck({ state: 'error', version, error: updateErrorText(e) });
  };
  updater.on('checking-for-update', () => setCheck({ state: 'checking', version: getCheck().version }));
  updater.on('update-available', i => setCheck({ state: 'available', version: i?.version }));
  updater.on('update-not-available', () => setCheck({ state: 'latest' }));
  updater.on('error', failed);
  updater.on('download-progress', p => {
    if (getCheck().state !== 'downloading') return;
    const percent = Number.isFinite(p?.percent) ? Math.max(0, Math.min(100, Math.floor(p.percent))) : null;
    setCheck({ state: 'downloading', version: getCheck().version, percent });
  });
  updater.on('update-downloaded', i => {
    pending = i.version;
    setCheck({ state: 'preparing', version: pending });
    log(`update ${pending} downloaded, handing it to Squirrel`);
  });
  squirrel.on('update-downloaded', () => { if (pending) { const version = pending; pending = null; onReady(version); } });
  return function download() {
    if (flight) return flight;
    const { state, version } = getCheck();
    if (!version || !['available', 'error'].includes(state)) return Promise.resolve(false);
    setCheck({ state: 'downloading', version, manual: true });
    flight = Promise.resolve().then(() => updater.downloadUpdate()).then(() => true, e => { failed(e); return false; }).finally(() => { flight = null; });
    return flight;
  };
}
