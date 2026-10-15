// 页面里只多这一个对象：window.OfferCrewDesktop（新手引导和「设置 → 桌面」用它显示桌面独有的两项）。
// 普通浏览器里没有它，桌面独有的东西就不显示。别的都不暴露。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('OfferCrewDesktop', {
  version: ipcRenderer.sendSync('desktop:version'),
  loginItem: {
    get: () => ipcRenderer.invoke('desktop:loginItem:get'),
    set: (on) => ipcRenderer.invoke('desktop:loginItem:set', !!on),
  },
  hotkey: {
    get: () => ipcRenderer.invoke('desktop:hotkey:get'),
    set: (accel) => ipcRenderer.invoke('desktop:hotkey:set', String(accel || '')),
  },
  // 更新：{ current, ready, can_check, check: { state, version, percent, text } }，ready 是 Squirrel 已接收、退出时会装上的新版本号。
  // check() 是「检查更新」：马上查，查完回同样的对象，check.text 是要给你看的那句话。
  update: {
    get: () => ipcRenderer.invoke('desktop:update:get'),
    download: () => ipcRenderer.invoke('desktop:update:download'),
    install: () => ipcRenderer.invoke('desktop:update:install'),
    check: () => ipcRenderer.invoke('desktop:update:check'),
    onChange: (fn) => { ipcRenderer.on('desktop:update', (_e, v) => fn(v)); },
  },
});
