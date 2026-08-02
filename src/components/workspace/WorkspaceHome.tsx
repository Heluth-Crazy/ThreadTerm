import {
  FileText,
  FolderOpen,
  GitCompare,
  Plus,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import type { WorkspaceRecord, WorkspaceTab } from '../../lib/workspace/types';
import { pathBasename } from '../../lib/workspace/paths';
import { AttentionDot } from '../terminal/AttentionDot';

interface WorkspaceHomeProps {
  workspace: WorkspaceRecord | null;
  workspaceCards: TerminalCard[];
  tabs: WorkspaceTab[];
  dirtyByTabId: Record<string, boolean>;
  unavailable?: boolean;
  error?: string | null;
  onOpenTerminal: (cardId: string) => void;
  onCreateTerminal: () => void;
  onActivateTab: (tabId: string) => void;
  onRetry?: () => void;
}

export function WorkspaceHome({
  workspace,
  workspaceCards,
  tabs,
  dirtyByTabId,
  unavailable = false,
  error = null,
  onOpenTerminal,
  onCreateTerminal,
  onActivateTab,
  onRetry,
}: WorkspaceHomeProps) {
  const { t } = useTranslation('terminal');
  const displayPath = workspace?.displayPath ?? workspace?.canonicalRoot ?? '';
  const name = displayPath ? pathBasename(displayPath) : t('workspace.homeUntitled', {
    defaultValue: 'Workspace',
  });
  const recentContent = tabs.filter(
    (tab) => tab.kind === 'file' || tab.kind === 'diff',
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-background px-6 py-6"
      data-testid="workspace-home"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-primary" />
            <h1 className="truncate text-lg font-semibold text-foreground">{name}</h1>
          </div>
          {displayPath && (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={displayPath}>
              {displayPath}
            </p>
          )}
          {unavailable && (
            <p className="mt-2 text-sm text-warning">
              {t('workspace.homeUnavailable', {
                defaultValue: 'This worktree is currently unavailable.',
              })}
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-destructive">{error}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(unavailable || error) && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('workspace.homeRetry', { defaultValue: 'Retry' })}
            </button>
          )}
          <button
            type="button"
            onClick={onCreateTerminal}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('workspace.homeNewTerminal', { defaultValue: 'New terminal' })}
          </button>
        </div>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('workspace.homeTerminals', { defaultValue: 'Terminals in this worktree' })}
        </h2>
        {workspaceCards.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            {t('workspace.homeNoTerminals', {
              defaultValue: 'No terminals yet. Create one or open a file from the panel.',
            })}
          </p>
        ) : (
          <ul className="space-y-1">
            {workspaceCards.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  onClick={() => onOpenTerminal(card.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-left text-sm hover:bg-accent/50"
                >
                  <TerminalSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{card.projectName}</span>
                  <span className="text-[11px] text-muted-foreground">{card.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('workspace.homeRecent', { defaultValue: 'Recent files and diffs' })}
        </h2>
        {recentContent.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            {t('workspace.homeNoRecent', {
              defaultValue: 'Shared file and diff tabs will appear here.',
            })}
          </p>
        ) : (
          <ul className="space-y-1">
            {recentContent.map((tab) => (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => onActivateTab(tab.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-left text-sm hover:bg-accent/50"
                >
                  {tab.kind === 'file' ? (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <GitCompare className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  {dirtyByTabId[tab.id] && <AttentionDot size="sm" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
