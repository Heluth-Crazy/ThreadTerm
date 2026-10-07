import type { ContextMenuItem } from './components/ContextMenu';
import { lineRangeLabel, menuText } from './contextMenuActions';

type Action = () => void | Promise<void>;
type Lines = { startLine: number; endLine: number };
type CommentOptions = { zh: boolean; lines: Lines; canComment: boolean; commentReason?: string; comment: Action };
const separator: ContextMenuItem = { separator: true, label: '' };

function commentItem(options: CommentOptions, prefix: string): ContextMenuItem {
  return { id: `${prefix}-comment`, label: menuText(options.zh, `Comment on ${lineRangeLabel(false, options.lines.startLine, options.lines.endLine)}`, `评论${lineRangeLabel(true, options.lines.startLine, options.lines.endLine)}`), disabled: !options.canComment, reason: !options.canComment ? options.commentReason ?? menuText(options.zh, 'Comments are unavailable in this workspace.', '此工作区无法添加评论。') : undefined, onSelect: options.comment, testId: `${prefix}-context-comment` };
}

export function sourceEditorMenuItems(options: CommentOptions & {
  hasSelection: boolean; readOnly: boolean; send?: Action; plans?: Action; pinned: boolean; plansDisabled: boolean; plansReason?: string; history?: Action;
  copy: Action; cut: Action; paste: Action; selectAll: Action; copyPath: Action; copyReference: Action;
}): ContextMenuItem[] {
  const text = (en: string, zh: string) => menuText(options.zh, en, zh);
  const noSelection = text('Select text first.', '请先选择文本。');
  const readOnly = text('This file is read-only.', '此文件为只读。');
  return [
    commentItem(options, 'editor'),
    { id: 'editor-send', label: options.hasSelection ? text(`Send ${lineRangeLabel(false, options.lines.startLine, options.lines.endLine)} to agent`, `将${lineRangeLabel(true, options.lines.startLine, options.lines.endLine)}发送给 Agent`) : text('Send file to agent', '将文件发送给 Agent'), disabled: !options.send, reason: !options.send ? text('Open a Chat session in this workspace first.', '请先在此工作区打开一个聊天会话。') : undefined, onSelect: options.send, testId: 'editor-context-send' },
    { id: 'editor-plan', label: options.pinned ? text('Remove from Plans & docs', '从计划与文档中移除') : text('Add to Plans & docs', '添加到计划与文档'), disabled: options.plansDisabled || !options.plans, reason: options.plansDisabled || !options.plans ? options.plansReason ?? text('Plans & docs is unavailable.', '计划与文档当前不可用。') : undefined, onSelect: options.plans, testId: 'editor-context-plan' },
    { id: 'editor-history', label: text('File history', '文件历史'), disabled: !options.history, reason: !options.history ? text('File history is unavailable for this workspace.', '此工作区无法查看文件历史。') : undefined, onSelect: options.history, testId: 'editor-context-history' },
    separator,
    { id: 'editor-cut', label: text('Cut', '剪切'), shortcut: 'Ctrl+X', disabled: options.readOnly || !options.hasSelection, reason: options.readOnly ? readOnly : !options.hasSelection ? noSelection : undefined, onSelect: options.cut, testId: 'editor-context-cut' },
    { id: 'editor-copy', label: text('Copy', '复制'), shortcut: 'Ctrl+C', disabled: !options.hasSelection, reason: !options.hasSelection ? noSelection : undefined, onSelect: options.copy, testId: 'editor-context-copy' },
    { id: 'editor-paste', label: text('Paste', '粘贴'), shortcut: 'Ctrl+V', disabled: options.readOnly, reason: options.readOnly ? readOnly : undefined, onSelect: options.paste, testId: 'editor-context-paste' },
    { id: 'editor-select-all', label: text('Select all', '全选'), shortcut: 'Ctrl+A', onSelect: options.selectAll, testId: 'editor-context-select-all' },
    { id: 'editor-copy-path', label: text('Copy path', '复制路径'), onSelect: options.copyPath, testId: 'editor-context-copy-path' },
    { id: 'editor-copy-reference', label: text('Copy reference', '复制引用'), onSelect: options.copyReference, testId: 'editor-context-copy-reference' },
  ];
}

export function diffSurfaceMenuItems(options: CommentOptions & { prefix: 'editor' | 'review-diff'; hasSelection: boolean; sendDiff?: Action; copy: Action; copyPath: Action }): ContextMenuItem[] {
  const text = (en: string, zh: string) => menuText(options.zh, en, zh);
  return [
    commentItem(options, options.prefix),
    ...(options.sendDiff ? [{ id: `${options.prefix}-send`, label: text('Send diff to agent', '将差异发送给 Agent'), onSelect: options.sendDiff, testId: `${options.prefix}-context-send` }] : []),
    separator,
    { id: `${options.prefix}-copy`, label: text('Copy', '复制'), shortcut: 'Ctrl+C', disabled: !options.hasSelection, reason: !options.hasSelection ? text('Select text first.', '请先选择文本。') : undefined, onSelect: options.copy, testId: `${options.prefix}-context-copy` },
    { id: `${options.prefix}-copy-path`, label: text('Copy path', '复制路径'), onSelect: options.copyPath, testId: `${options.prefix}-context-copy-path` },
  ];
}

export function renderedPreviewMenuItems(options: { zh: boolean; hasSelection: boolean; send?: Action; source?: Action; copy: Action; selectAll: Action }): ContextMenuItem[] {
  const text = (en: string, zh: string) => menuText(options.zh, en, zh);
  return [
    { id: 'file-preview-send', label: text('Send file to agent', '将文件发送给 Agent'), disabled: !options.send, reason: !options.send ? text('Open a Chat session in this workspace first.', '请先在此工作区打开一个聊天会话。') : undefined, onSelect: options.send, testId: 'file-preview-context-send-file' },
    { id: 'file-preview-source', label: text('Show source', '查看源代码'), disabled: !options.source, reason: !options.source ? text('Source is unavailable.', '源代码不可用。') : undefined, onSelect: options.source, testId: 'file-preview-context-show-source' },
    separator,
    { id: 'file-preview-copy', label: text('Copy', '复制'), shortcut: 'Ctrl+C', disabled: !options.hasSelection, reason: !options.hasSelection ? text('Select text first.', '请先选择文本。') : undefined, onSelect: options.copy, testId: 'file-preview-context-copy' },
    { id: 'file-preview-select-all', label: text('Select all', '全选'), shortcut: 'Ctrl+A', onSelect: options.selectAll, testId: 'file-preview-context-select-all' },
  ];
}
