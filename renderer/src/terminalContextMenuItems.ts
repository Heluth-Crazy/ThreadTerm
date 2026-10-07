import type { ContextMenuItem } from './components/ContextMenu';

type Options = {
  zh: boolean; selection: string; canPaste: boolean; canSend: boolean;
  copy: () => void | Promise<void>; paste: () => void | Promise<void>; send: () => void | Promise<void>; selectAll: () => void;
};

/** Pure menu model: callers capture xterm selection before focus moves to the menu. */
export function terminalContextMenuItems(options: Options): ContextMenuItem[] {
  const text = (en: string, cn: string) => options.zh ? cn : en;
  const selected = Boolean(options.selection);
  return [
    { label: text('Send selection to agent', '将选区发送给 Agent'), disabled: !selected || !options.canSend, reason: !options.canSend ? text('Open a Chat session in this workspace first.', '请先在此工作区打开一个聊天会话。') : text('Select terminal output first.', '请先选中终端输出。'), onSelect: options.send, testId: 'terminal-selection-send-to-agent' },
    { label: '', separator: true },
    { id: 'copy', label: text('Copy', '复制'), disabled: !selected, reason: text('Select terminal output first.', '请先选中终端输出。'), onSelect: options.copy, testId: 'terminal-context-copy' },
    { id: 'paste', label: text('Paste', '粘贴'), disabled: !options.canPaste, reason: text('Terminal input is unavailable.', '终端输入不可用。'), onSelect: options.paste, testId: 'terminal-context-paste' },
    { id: 'select-all', label: text('Select all', '全选'), onSelect: options.selectAll, testId: 'terminal-context-select-all' },
  ];
}
