// macOS 应用菜单；正式包不提供调试入口。
export function appMenu({ brand = 'OfferCrew', packaged = true, settings = () => {}, update = () => {}, updates = true, reopen = () => {} } = {}) {
  return [
    { label: brand, submenu: [
      { label: `关于 ${brand}`, role: 'about' },
      { label: '设置…', accelerator: 'CommandOrControl+,', click: settings },
      ...(updates ? [{ label: '检查更新…', click: update }] : []),
      { type: 'separator' }, { label: '服务', role: 'services' }, { type: 'separator' },
      { label: `隐藏 ${brand}`, role: 'hide' }, { label: '隐藏其他', role: 'hideOthers' }, { label: '显示全部', role: 'unhide' },
      { type: 'separator' }, { label: `退出 ${brand}`, role: 'quit' },
    ] },
    { label: '编辑', submenu: [ { label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' } ] },
    { label: '显示', submenu: [ { label: '重新打开页面', accelerator: 'CommandOrControl+R', click: reopen }, { label: '进入全屏', role: 'togglefullscreen' }, ...(!packaged ? [{ type: 'separator' }, { label: '强制重新加载', role: 'forceReload' }, { label: '开发者工具', role: 'toggleDevTools' }] : []) ] },
    { label: '窗口', submenu: [ { label: '最小化', role: 'minimize' }, { label: '缩放', role: 'zoom' }, { label: '关闭窗口', role: 'close' }, { type: 'separator' }, { label: '全部置前', role: 'front' } ] },
  ];
}
