import { useState } from 'react';
import { loadEditors, openInEditor, openInLabel, useOpenInEditors, type OpenInEditor, type OpenInTarget } from '../openIn';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';
import { Icon } from './PrototypeIcon';
import './open-in.css';

/** The program's own icon, read from its executable by main; a line icon when it has none. */
export function EditorIcon({ editor }: { editor: OpenInEditor }) {
  return editor.icon ? <img className="open-in-icon" src={editor.icon} alt="" draggable={false} /> : <Icon name={editor.id === 'terminal' ? 'terminal' : 'popout'} />;
}

/** Menu rows for every installed editor (for ⋯ menus that list them directly). A function target is read when the row
 * is picked, so a file opens at the line the cursor is on then. */
export function openInMenuItems(editors: readonly OpenInEditor[], target: OpenInTarget | (() => OpenInTarget), zh: boolean): ContextMenuItem[] {
  return editors.map(editor => ({ id: `open-in-${editor.id}`, label: openInLabel(editor, zh), icon: <EditorIcon editor={editor} />, onSelect: () => openInEditor(editor, typeof target === 'function' ? target() : target, zh) }));
}

/**
 * "Open" split button (after T3 Code's Open-in picker): the main part opens in the editor used last, the arrow lists
 * every editor found on this PC and the terminal. Nothing shows on another computer or with no editor installed.
 */
export function OpenInButton({ target, zh, compact = false }: { target: OpenInTarget; zh: boolean; compact?: boolean }) {
  const { editors, preferred } = useOpenInEditors();
  const [busy, setBusy] = useState(false);
  if (!preferred) return null;
  const run = (editor: OpenInEditor) => { setBusy(true); void openInEditor(editor, target, zh).finally(() => setBusy(false)); };
  return <div className={`open-in${compact ? ' is-compact' : ''}`} role="group" aria-label={zh ? '打开方式' : 'Open in'}>
    <button type="button" className="btn open-in-main" disabled={busy} data-tip={openInLabel(preferred, zh)} aria-label={openInLabel(preferred, zh)} onClick={() => run(preferred)}>
      <EditorIcon editor={preferred} />{!compact && <span>{zh ? '打开' : 'Open'}</span>}
    </button>
    <button type="button" className="btn open-in-more" aria-haspopup="menu" aria-label={zh ? '选择打开方式' : 'Choose where to open'} onClick={event => {
      const box = event.currentTarget.getBoundingClientRect();
      showContextMenu({ x: box.right - 220, y: box.bottom + 4, restoreFocus: event.currentTarget, items: [
        ...openInMenuItems(editors, target, zh).map(item => ({ ...item, onSelect: () => run(editors.find(editor => `open-in-${editor.id}` === item.id)!) })),
        { id: 'open-in-sep', label: '', separator: true },
        { id: 'open-in-refresh', label: zh ? '重新查找已安装的编辑器' : 'Find installed editors again', icon: <Icon name="refresh" />, onSelect: () => loadEditors(true) },
      ] });
    }}><Icon name="chevD" /></button>
  </div>;
}
