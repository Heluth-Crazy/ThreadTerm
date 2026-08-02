import {
  useEffect,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  GitCompare,
  Home,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { WorkspaceTab } from '../../lib/workspace/types';
import { HOME_TAB_ID } from '../../lib/workspace/types';
import { AttentionDot } from '../terminal/AttentionDot';

interface WorkspaceTabStripProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  dirtyTabIds: Record<string, boolean>;
  homeLabel: string;
  closeLabel: string;
  closeCurrentLabel: string;
  closeAllLabel: string;
  closeOthersLabel: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseOthers: (tabId: string) => void;
  onReorder?: (orderedTabIds: string[]) => void;
}

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  dirtyTabIds,
  homeLabel,
  closeLabel,
  closeCurrentLabel,
  closeAllLabel,
  closeOthersLabel,
  onActivate,
  onClose,
  onCloseAll,
  onCloseOthers,
  onReorder,
}: WorkspaceTabStripProps) {
  const [menu, setMenu] = useState<{ tabId: string; left: number; top: number } | null>(
    null,
  );
  const [dragTabId, setDragTabId] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu]);

  const openMenu = (event: ReactMouseEvent, tabId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 160;
    const height = 112;
    const padding = 8;
    setMenu({
      tabId,
      left: Math.min(event.clientX, window.innerWidth - width - padding),
      top: Math.min(event.clientY, window.innerHeight - height - padding),
    });
  };

  const runMenuAction = (action: () => void) => {
    setMenu(null);
    action();
  };

  const handleDropOn = (targetTabId: string) => {
    if (!dragTabId || !onReorder || dragTabId === targetTabId) {
      setDragTabId(null);
      return;
    }
    const ids = tabs.map((tab) => tab.id);
    const from = ids.indexOf(dragTabId);
    const to = ids.indexOf(targetTabId);
    if (from < 0 || to < 0) {
      setDragTabId(null);
      return;
    }
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragTabId);
    onReorder(next);
    setDragTabId(null);
  };

  return (
    <div
      className="flex min-h-[34px] items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-2 py-1"
      data-terminal-context-menu
      data-testid="workspace-tab-strip"
    >
      <button
        type="button"
        onClick={() => onActivate(HOME_TAB_ID)}
        className={[
          'inline-flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors',
          activeTabId === HOME_TAB_ID
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        ].join(' ')}
        data-testid="workspace-tab-home"
      >
        <Home className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{homeLabel}</span>
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          title={tab.relativePath ?? tab.title}
          draggable={Boolean(onReorder)}
          onDragStart={() => setDragTabId(tab.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => handleDropOn(tab.id)}
          onContextMenu={(event) => openMenu(event, tab.id)}
          data-terminal-context-menu
          data-testid={`workspace-tab-${tab.kind}`}
          className={[
            'inline-flex h-7 max-w-[240px] shrink-0 items-center overflow-hidden rounded-md text-[11px] transition-colors',
            activeTabId === tab.id
              ? 'bg-primary/15 text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            dragTabId === tab.id ? 'opacity-60' : '',
          ].join(' ')}
        >
          <button
            type="button"
            onClick={() => onActivate(tab.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1"
          >
            {tab.kind === 'terminal' ? (
              <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
            ) : tab.kind === 'file' ? (
              <FileText className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <GitCompare className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{tab.title}</span>
            {dirtyTabIds[tab.id] && <AttentionDot size="sm" />}
          </button>
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={() => onClose(tab.id)}
            className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {menu &&
        createPortal(
          <div
            role="menu"
            data-testid="workspace-tab-context-menu"
            data-terminal-context-menu
            className="fixed z-50 w-40 overflow-hidden rounded-md border border-border bg-popover py-1 text-[11px] text-popover-foreground shadow-xl shadow-black/30"
            style={{ left: menu.left, top: menu.top }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <WorkspaceTabMenuItem
              label={closeCurrentLabel}
              onClick={() => runMenuAction(() => onClose(menu.tabId))}
            />
            <WorkspaceTabMenuItem
              label={closeAllLabel}
              onClick={() => runMenuAction(onCloseAll)}
            />
            <WorkspaceTabMenuItem
              label={closeOthersLabel}
              onClick={() => runMenuAction(() => onCloseOthers(menu.tabId))}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

function WorkspaceTabMenuItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
    >
      {label}
    </button>
  );
}

// Keep type import used for drag typing in some TS configs.
export type { ReactDragEvent };
