// 桌面：只在 OfferCrew 的 Mac App 里出现（开机自动启动、全局快捷键；web/desktop.js 照用）。
import { desktopControlsHtml, bindDesktop, hotkeyLabel } from '../desktop.js';
export default {
  id: 'desktop', title: '桌面', icon: 'desktop',
  hidden: D => !D.desktop,
  summary: D => [D.desktop?.loginItem ? '开机启动' : '', hotkeyLabel(D.desktop?.hotkey)].filter(Boolean).join(' · ') || 'Mac App',
  top: D => `<div class="st-card st-pad" id="settings-desktop">${desktopControlsHtml(D.desktop, D.h.esc)}</div>`,
  cards: () => [],
  bind: (root, D) => bindDesktop(root.querySelector('#settings-desktop'), { toast: D.h.toast }),
};
