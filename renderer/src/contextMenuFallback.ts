import { buildClipboardItems } from './contextMenuActions';
import { showContextMenu } from './components/ContextMenu';

type TextField = HTMLInputElement | HTMLTextAreaElement;
const textInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/** Number/email controls keep a native caret but do not expose text-selection offsets. */
function nativeFieldItems(field: TextField) {
  field.focus({ preventScroll: true });
  const command = (name: string, value?: string) => {
    if (!field.isConnected || field.disabled || field.readOnly && (name === 'cut' || name === 'insertText')) throw new Error('native_field_action_unavailable');
    field.focus({ preventScroll: true });
    if (!document.execCommand(name, false, value)) throw new Error('native_field_action_failed');
  };
  return buildClipboardItems({ language: document.documentElement.lang,
    hasSelection: !field.disabled && document.queryCommandEnabled('copy'), editable: !field.disabled && !field.readOnly,
    copy: () => command('copy'), cut: () => command('cut'),
    paste: async () => { const value = await navigator.clipboard.readText(); if (field.isConnected && !field.disabled && !field.readOnly) command('insertText', value); },
    selectAll: () => command('selectAll'),
  });
}

/** Preserve native setters so React's controlled inputs observe a normal input event. */
function replaceFieldSelection(field: TextField, start: number, end: number, replacement: string) {
  const value = field.value.slice(0, start) + replacement + field.value.slice(end);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
  field.focus({ preventScroll: true });
  if (field.selectionStart !== null) field.setSelectionRange(start + replacement.length, start + replacement.length);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: replacement ? 'insertFromPaste' : 'deleteByCut', data: replacement || null }));
}

export function textFieldContextMenuItems(field: TextField) {
  if (field.selectionStart === null) return nativeFieldItems(field);
  const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
  const password = field instanceof HTMLInputElement && field.type === 'password';
  const selected = password ? '' : field.value.slice(start, end);
  const editable = !field.disabled && !field.readOnly;
  return buildClipboardItems({ language: document.documentElement.lang, hasSelection: !!selected, editable,
    copy: () => navigator.clipboard.writeText(selected),
    cut: () => {
      // Clipboard failures must never delete the user's text.
      return navigator.clipboard.writeText(selected).then(() => replaceFieldSelection(field, start, end, ''));
    },
    paste: async () => {
      const value = await navigator.clipboard.readText();
      if (field.isConnected && editable) replaceFieldSelection(field, start, end, value);
    },
    selectAll: () => { field.focus({ preventScroll: true }); field.select(); },
    copyReason: password ? (document.documentElement.lang === 'zh-CN' ? '密码字段不能复制。' : 'Passwords cannot be copied.') : undefined,
  });
}

function selectionItems(target: HTMLElement, editable: HTMLElement | null) {
  const selection = window.getSelection();
  const saved = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
  const selected = selection?.toString() ?? '';
  const restore = () => {
    editable?.focus({ preventScroll: true });
    if (saved && saved.startContainer.isConnected && saved.endContainer.isConnected) {
      const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(saved);
    }
  };
  const selectAll = () => {
    const scope = editable ?? target.closest<HTMLElement>('article, pre, .v3-session-chat, .codex-markdown') ?? target;
    scope.focus({ preventScroll: true });
    const range = document.createRange(); range.selectNodeContents(scope);
    const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(range);
  };
  return buildClipboardItems({ language: document.documentElement.lang, hasSelection: !!selected, editable: !!editable,
    copy: () => navigator.clipboard.writeText(selected), selectAll,
    cut: editable ? async () => { await navigator.clipboard.writeText(selected); restore(); document.execCommand('delete'); } : undefined,
    paste: editable ? async () => { const value = await navigator.clipboard.readText(); if (editable.isConnected) { restore(); document.execCommand('insertText', false, value); } } : undefined,
  });
}

/** One bubbling fallback: surface handlers always have first refusal, including React handlers. */
export function installContextMenuFallback() {
  const context = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target || target.closest('[data-testid="context-menu"], .xterm')) return;
    const field = target.closest('input, textarea');
    if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && textInputTypes.has(field.type))) {
      event.preventDefault();
      showContextMenu({ x: event.clientX, y: event.clientY, items: textFieldContextMenuItems(field), restoreFocus: field });
      return;
    }
    const element = target instanceof HTMLElement ? target : target.parentElement;
    if (!element) return;
    const candidate = element.closest<HTMLElement>('[contenteditable]');
    const editable = candidate?.isContentEditable ? candidate : null;
    if (!editable && !window.getSelection()?.toString()) return;
    event.preventDefault();
    showContextMenu({ x: event.clientX, y: event.clientY, items: selectionItems(element, editable), restoreFocus: editable ?? document.activeElement as HTMLElement });
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (!target || target.closest('[role="menu"], .xterm')) return;
    const rect = target.getBoundingClientRect();
    const handled = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + Math.min(20, rect.width / 2), clientY: rect.top + Math.min(rect.height, 24), button: 2 });
    target.dispatchEvent(handled);
    if (handled.defaultPrevented) event.preventDefault();
  };
  document.addEventListener('contextmenu', context);
  document.addEventListener('keydown', keyboard);
  return () => { document.removeEventListener('contextmenu', context); document.removeEventListener('keydown', keyboard); };
}
