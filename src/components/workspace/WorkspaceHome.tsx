import {
  FileText,
  FolderOpen,
  GitCompare,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import type { WorkspaceRecord, WorkspaceTab } from '../../lib/workspace/types';
import { pathBasename } from '../../lib/workspace/paths';
import { buildWorkspaceTerminalPresentation } from '../../lib/workspaceTerminalPresentation';
import { AttentionDot } from '../terminal/AttentionDot';
import { CardStatusBadge } from '../terminal/CardStatusBadge';
import { getTerminalTypeMeta } from '../terminal/terminalTypeMeta';
import { useBoundSessionMetadata } from './useWorkspaceAgentMetadata';

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

function WorkspaceTerminalRow({
  card,
  onOpen,
}: {
  card: TerminalCard;
  onOpen: (cardId: string) => void;
}) {
  const { t } = useTranslation('terminal');
  const metadata = useBoundSessionMetadata(card);
  const presentation = buildWorkspaceTerminalPresentation(card, { t, metadata });
  const Icon = presentation.Icon;
  const typeAccent = getTerminalTypeMeta(card.terminalType).accent;
  const contextLine = [presentation.secondaryTitle, ...presentation.contextLabels]
    .filter(Boolean)
    .join(' · ');

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        title={presentation.tooltip}
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/50"
        data-testid={`workspace-home-terminal-${card.id}`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
          <Icon className={`h-4 w-4 ${typeAccent}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {presentation.primaryTitle}
          </span>
          {contextLine && (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {contextLine}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <CardStatusBadge status={card.status} />
          <span className="text-[11px] text-muted-foreground">
            {presentation.activityLabel}
          </span>
        </span>
      </button>
    </li>
  );
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
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-background/20 px-6 py-6"
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
          <ul className="divide-y divide-border/60">
            {workspaceCards.map((card) => (
              <WorkspaceTerminalRow
                key={card.id}
                card={card}
                onOpen={onOpenTerminal}
              />
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
