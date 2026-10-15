// 主导航只收起文字，页面、导航链接和收件箱计数仍在；保存本机显示偏好。
export function initSidebar({ doc = document, storage = localStorage } = {}) {
  const button = doc.querySelector('#sidebar-toggle');
  if (!button) return;
  let collapsed = false;
  try { collapsed = storage.getItem('offercrew.sidebar.collapsed') === '1'; }
  catch { /* 兜底：浏览器不让读显示偏好时，导航默认展开 */ }
  for (const link of doc.querySelectorAll('.sidebar nav a')) link.title = link.textContent.replace(/\s+/g, ' ').trim();
  const paint = () => {
    doc.body.classList.toggle('sidebar-collapsed', collapsed);
    button.textContent = collapsed ? '›' : '‹ 收起导航';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? '展开主导航' : '收起主导航');
    button.title = collapsed ? '展开主导航' : '收起主导航';
  };
  button.onclick = () => {
    collapsed = !collapsed; paint();
    try { storage.setItem('offercrew.sidebar.collapsed', collapsed ? '1' : '0'); }
    catch { /* 兜底：显示偏好不能保存时，本次展开/收起仍然生效 */ }
  };
  paint();
}
