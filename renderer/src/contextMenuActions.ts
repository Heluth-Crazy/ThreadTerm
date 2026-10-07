import type { ContextMenuItem } from './components/ContextMenu';

export function menuText(language: string | boolean, en: string, zh: string): string {
  return language === true || language === 'zh-CN' ? zh : en;
}

export function lineRangeLabel(language: string | boolean, start: number, end: number): string {
  const first = Math.max(1, Math.floor(Math.min(start, end)));
  const last = Math.max(first, Math.floor(Math.max(start, end)));
  return menuText(language, first === last ? `line ${first}` : `lines ${first}–${last}`, first === last ? `第 ${first} 行` : `第 ${first}–${last} 行`);
}

/** Flip at the pointer before clamping; oversized menus scroll inside the viewport. */
export function clampContextMenu(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, margin = 8) {
  const left = x + width + margin > viewportWidth ? x - width : x;
  const top = y + height + margin > viewportHeight ? y - height : y;
  return {
    left: Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - width - margin))),
    top: Math.max(margin, Math.min(top, Math.max(margin, viewportHeight - height - margin))),
  };
}

export function nextMenuIndex(key: string, current: number, count: number): number {
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current < 0) return key === 'ArrowUp' ? count - 1 : 0;
  return (current + (key === 'ArrowUp' ? -1 : 1) + count) % count;
}

export function buildClipboardItems(options: {
  language: string | boolean;
  hasSelection: boolean;
  editable?: boolean;
  copy: () => void | Promise<void>;
  cut?: () => void | Promise<void>;
  paste?: () => void | Promise<void>;
  selectAll?: () => void;
  copyReason?: string;
}): ContextMenuItem[] {
  const text = (en: string, zh: string) => menuText(options.language, en, zh);
  const noSelection = options.copyReason ?? text('Select text first.', '请先选择文本。');
  const items: ContextMenuItem[] = [{ id: 'copy', label: text('Copy', '复制'), shortcut: 'Ctrl+C', disabled: !options.hasSelection, reason: !options.hasSelection ? noSelection : undefined, onSelect: options.copy, testId: 'context-menu-copy' }];
  if (options.cut) items.unshift({ id: 'cut', label: text('Cut', '剪切'), shortcut: 'Ctrl+X', disabled: !options.editable || !options.hasSelection, reason: !options.editable ? text('This field is read-only.', '此字段为只读。') : !options.hasSelection ? noSelection : undefined, onSelect: options.cut, testId: 'context-menu-cut' });
  if (options.paste) items.push({ id: 'paste', label: text('Paste', '粘贴'), shortcut: 'Ctrl+V', disabled: !options.editable, reason: !options.editable ? text('This field is read-only.', '此字段为只读。') : undefined, onSelect: options.paste, testId: 'context-menu-paste' });
  if (options.selectAll) items.push({ id: 'select-all', label: text('Select all', '全选'), shortcut: 'Ctrl+A', onSelect: options.selectAll, testId: 'context-menu-select-all' });
  return items;
}
