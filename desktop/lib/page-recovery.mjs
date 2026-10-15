// 页面进程退出时仍能显示原生提示。恢复只 GET 工作台，不重放页面地址里的动作或业务请求。
export function watchPage({ window, base, log = () => {}, showMessageBox, isQuitting = () => false, timeoutMs = 15000 }) {
  const contents = window.webContents, home = new URL('/', base).href;
  let notified = false, prompting = false, loading = null, disposed = false;
  const available = () => !disposed && !isQuitting() && !window.isDestroyed() && !contents.isDestroyed();
  const note = (event, details = {}) => log(`page ${event} ${JSON.stringify({ webContentsId: contents.id, ...details })}`);
  // 错误描述可能带网页 URL；诊断只留错误码，不把页面参数或认证信息写入外壳日志。
  const errorCode = error => /^[A-Z0-9_-]{1,80}$/.test(String(error?.code || '')) ? error.code : 'unknown';
  async function offer(message) {
    if (!available() || notified || prompting || loading) return;
    notified = true; prompting = true;
    try {
      const { response } = await showMessageBox({ type: 'warning', buttons: ['重新打开页面', '稍后'], defaultId: 0, cancelId: 1,
        message, detail: '重新打开会返回工作台。未保存的输入可能需要重新填写。' });
      if (response === 0 && available()) await reopen();
    } catch (error) { note('recovery-dialog-failed', { code: errorCode(error) }); }
    finally { prompting = false; }
  }
  function gone(_event, details = {}) {
    note('render-process-gone', { reason: /^[a-z-]+$/.test(details.reason || '') ? details.reason : 'unknown', exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null });
    void offer('OfferCrew 的页面意外关闭');
  }
  function failed(_event, code, _description, _url, mainFrame) {
    if (!mainFrame || code === -3) return; // ERR_ABORTED 是主动切换页面，不作为故障提示。
    note('did-fail-load', { errorCode: code });
    void offer('OfferCrew 的页面未能加载');
  }
  const loaded = () => { notified = false; };
  contents.on('render-process-gone', gone);
  contents.on('did-fail-load', failed);
  contents.on('did-finish-load', loaded);

  function reopen() {
    if (loading) return loading;
    if (!available()) return Promise.resolve(false);
    note('reopen-requested');
    // 每次明确点击只加载一次；连点共用这个 Promise。加载失败或超时都不自动重试。
    loading = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => window.loadURL(home)),
          new Promise((_, reject) => { timer = setTimeout(() => {
            try { if (!contents.isDestroyed()) contents.stop(); }
            catch (error) { note('stop-load-failed', { code: errorCode(error) }); }
            reject(Object.assign(Error('page recovery timed out'), { code: 'PAGE_RECOVERY_TIMEOUT' }));
          }, timeoutMs); }),
        ]);
        notified = false;
        note('reopened');
        return true;
      } catch (error) {
        clearTimeout(timer);
        note('reopen-failed', { code: errorCode(error) });
        if (available()) {
          try { await showMessageBox({ type: 'warning', buttons: ['好'], message: '页面暂时打不开',
            detail: '可以稍后在“显示”菜单里重新打开页面。' }); }
          catch (error) { note('recovery-dialog-failed', { code: errorCode(error) }); }
        }
        return false;
      } finally { clearTimeout(timer); loading = null; }
    })();
    return loading;
  }
  function dispose() {
    disposed = true;
    contents.removeListener('render-process-gone', gone);
    contents.removeListener('did-fail-load', failed);
    contents.removeListener('did-finish-load', loaded);
  }
  window.once('closed', dispose);
  return { reopen, dispose };
}
