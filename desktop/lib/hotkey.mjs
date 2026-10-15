// 全局快捷键：默认 ⌥⇧空格。⌃空格、⌃⌥空格是 macOS 切换输入法的键，用户写了也不用；被别的 App 占了就试备选。
export const DEFAULT_HOTKEY = 'Alt+Shift+Space';
export const FALLBACK_HOTKEYS = ['Command+Shift+Space', 'Alt+Shift+K', 'Command+Alt+K'];
const FORBIDDEN = new Set(['Control+Space', 'Control+Alt+Space', 'Command+Space']);

export function pickHotkey({ wanted, register }) {
  const order = [...new Set([wanted && !FORBIDDEN.has(wanted) ? wanted : null, DEFAULT_HOTKEY, ...FALLBACK_HOTKEYS].filter(Boolean))];
  const tried = [];
  for (const key of order) { tried.push(key); if (register(key)) return { key, tried }; }
  return { key: null, tried };
}
