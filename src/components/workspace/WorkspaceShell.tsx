import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import type { WorkspaceRecord, WorkspaceTab } from '../../lib/workspace/types';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceTabStrip } from './WorkspaceTabStrip';

interface WorkspaceShellProps {
  workspace: WorkspaceRecord | null;
  tabs: WorkspaceTab[];
  activeTabId: string;
  dirtyByTabId: Record<string, boolean>;
  workspaceCards: TerminalCard[];
  homeActive: boolean;
  loading?: boolean;
  error?: string | null;
  unavailable?: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseOthers: (tabId: string) => void;
  onReorder?: (orderedTabIds: string[]) => void;
  onOpenTerminal: (cardId: string) => void;
  onCreateTerminal: () => void;
  onRetry?: () => void;
  children?: ReactNode;
}

export function WorkspaceShell({
  workspace,
  tabs,
  activeTabId,
  dirtyByTabId,
  workspaceCards,
  homeActive,
  loading = false,
  error = null,
  unavailable = false,
  onActivateTab,
  onCloseTab,
  onCloseAll,
  onCloseOthers,
  onReorder,
  onOpenTerminal,
  onCreateTerminal,
  onRetry,
  children,
}: WorkspaceShellProps) {
  const { t } = useTranslation('terminal');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-shell">
      <WorkspaceTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        dirtyTabIds={dirtyByTabId}
        homeLabel={t('workspace.homeTab', { defaultValue: 'Home' })}
        closeLabel={t('common.close', { defaultValue: 'Close' })}
        closeCurrentLabel={t('workspace.closeCurrentTab', { defaultValue: 'Close current' })}
        closeAllLabel={t('workspace.closeAllTabs', { defaultValue: 'Close all' })}
        closeOthersLabel={t('workspace.closeOtherTabs', { defaultValue: 'Close others' })}
        onActivate={onActivateTab}
        onClose={onCloseTab}
        onCloseAll={onCloseAll}
        onCloseOthers={onCloseOthers}
        onReorder={onReorder}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loading && !workspace && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('workspace.loading', { defaultValue: 'Loading workspace…' })}
          </div>
        )}
        {homeActive && (
          <WorkspaceHome
            workspace={workspace}
            workspaceCards={workspaceCards}
            tabs={tabs}
            dirtyByTabId={dirtyByTabId}
            unavailable={unavailable}
            error={error}
            onOpenTerminal={onOpenTerminal}
            onCreateTerminal={onCreateTerminal}
            onActivateTab={onActivateTab}
            onRetry={onRetry}
          />
        )}
        {children}
      </div>
    </div>
  );
}
