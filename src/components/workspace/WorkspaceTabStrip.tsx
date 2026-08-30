import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  GitCompare,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { TerminalCard } from '../../types/terminal';
import {
  agentSessionMetadataCacheKey,
  isAgentSessionProvider,
} from '../../types/agentSession';
import type { WorkspaceTab } from '../../lib/workspace/types';
import {
  buildWorkspaceTerminalPresentation,
  type WorkspaceTerminalPresentation,
} from '../../lib/workspaceTerminalPresentation';
import { effectiveWorktreePath } from '../../lib/worktreePaths';
import { useAgentSessionMetadataCache } from '../../stores/agentSessionMetadataCache';
import { AttentionDot } from '../terminal/AttentionDot';

interface WorkspaceTabStripProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  dirtyTabIds: Record<string, boolean>;
  workspaceCards?: TerminalCard[];
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

function TerminalTabLabel({
  tab,
  presentation,
}: {
  tab: WorkspaceTab;
  presentation: WorkspaceTerminalPresentation | null;
}) {
  if (!presentation) {
    return (
      <>
        <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{tab.title}</span>
      </>
    );
  }
  const Icon = presentation.Icon;
  return (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{presentation.primaryTitle}</span>
    </>
  );
}

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  dirtyTabIds,
  workspaceCards = [],
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
  const { t } = useTranslation('terminal');
  const metadataEntries = useAgentSessionMetadataCache((state) => state.entries);
  const cardsById = useMemo(() => {
    const map = new Map<string, TerminalCard>();
    for (const card of workspaceCards) map.set(card.id, card);
    return map;
  }, [workspaceCards]);
  const [menu, setMenu] = useState<{ tabId: string; left: number; top: number } | null>(
    null,
  );
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const concreteTabs = useMemo(
    () => tabs.filter((tab) => tab.kind !== 'home'),
    [tabs],
  );

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
    const ids = concreteTabs.map((tab) => tab.id);
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
      {concreteTabs.map((tab) => {
        const card =
          tab.kind === 'terminal' && tab.cardId
            ? cardsById.get(tab.cardId)
            : undefined;
        const metadataEntry = card?.providerSessionId
          && isAgentSessionProvider(card.terminalType)
          ? metadataEntries.get(agentSessionMetadataCacheKey(
              card.terminalType,
              card.providerSessionId,
              effectiveWorktreePath(card),
            ))
          : undefined;
        const presentation = card
          ? buildWorkspaceTerminalPresentation(card, {
              t,
              metadata: metadataEntry?.status === 'found'
                ? metadataEntry.summary
                : null,
            })
          : null;
        const tooltip =
          tab.kind === 'terminal' && presentation
            ? presentation.tooltip
            : (tab.relativePath ?? tab.title);
        return (
        <div
          key={tab.id}
          title={tooltip}
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
              <TerminalTabLabel tab={tab} presentation={presentation} />
            ) : tab.kind === 'file' ? (
              <>
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tab.title}</span>
              </>
            ) : (
              <>
                <GitCompare className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tab.title}</span>
              </>
            )}
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
        );
      })}
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
