import { BookmarkPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { samePath } from '../../lib/worktreePaths';
import type { TerminalCard } from '../../types/terminal';
import { useProjectBranches } from '../terminal/useProjectBranches';
import { RecallTerminalFilters } from './RecallTerminalFilters';
import { RecallTerminalList } from './RecallTerminalList';
import {
  ALL_RECALL_CONTEXTS,
  buildRecallContextOptions,
  buildRecallProjectOptions,
  filterRecallCards,
  recallPathContextId,
  type RecallScope,
} from './recallTerminalModel';

interface RecallTerminalDialogProps {
  open: boolean;
  cards: readonly TerminalCard[];
  followedCardIds: readonly string[];
  selectedProjectPath: string | null;
  selectedWorktreePath: string | null;
  onClose: () => void;
  onConfirm: (cardIds: readonly string[]) => void;
}

export function RecallTerminalDialog({
  open,
  cards,
  followedCardIds,
  selectedProjectPath,
  selectedWorktreePath,
  onClose,
  onConfirm,
}: RecallTerminalDialogProps) {
  const { t } = useTranslation('terminal');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<RecallScope>(
    selectedProjectPath ? 'current' : 'all',
  );
  const [projectPath, setProjectPath] = useState<string>(
    selectedProjectPath ?? 'all',
  );
  const [contextId, setContextId] = useState<string>(
    selectedWorktreePath
      ? recallPathContextId(selectedWorktreePath)
      : ALL_RECALL_CONTEXTS,
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const followedIds = useMemo(
    () => new Set(followedCardIds),
    [followedCardIds],
  );

  const projects = useMemo(
    () => buildRecallProjectOptions(cards),
    [cards],
  );
  const effectiveProjectPath =
    scope === 'current' && selectedProjectPath
      ? selectedProjectPath
      : projectPath === 'all'
        ? null
        : projectPath;
  const effectiveProjectOptionPath = effectiveProjectPath
    ? projects.find((project) => samePath(project.path, effectiveProjectPath))
        ?.path ?? effectiveProjectPath
    : 'all';
  const { branches: projectBranches } = useProjectBranches(
    open ? effectiveProjectPath : null,
  );
  const contextOptions = useMemo(
    () =>
      buildRecallContextOptions(cards, effectiveProjectPath, projectBranches),
    [cards, effectiveProjectPath, projectBranches],
  );
  const selectedContext =
    contextId === ALL_RECALL_CONTEXTS
      ? null
      : contextOptions.find((option) => option.id === contextId) ?? null;
  const contextOptionId = selectedContext?.id ?? ALL_RECALL_CONTEXTS;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCards = useMemo(
    () =>
      filterRecallCards(
        cards,
        effectiveProjectPath,
        selectedContext,
        normalizedQuery,
      ),
    [cards, effectiveProjectPath, normalizedQuery, selectedContext],
  );

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setScope(selectedProjectPath ? 'current' : 'all');
    setProjectPath(selectedProjectPath ?? 'all');
    setContextId(
      selectedWorktreePath
        ? recallPathContextId(selectedWorktreePath)
        : ALL_RECALL_CONTEXTS,
    );
    setSelectedIds(new Set());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      priorFocusRef.current?.focus();
    };
  }, [onClose, open, selectedProjectPath, selectedWorktreePath]);

  if (!open) return null;

  const toggleCard = (cardId: string) => {
    if (followedIds.has(cardId)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const confirm = () => {
    const orderedIds = cards
      .map((card) => card.id)
      .filter((cardId) => selectedIds.has(cardId));
    if (orderedIds.length === 0) return;
    onConfirm(orderedIds);
    onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label={t('workbench.recall.close', {
          defaultValue: 'Close recall dialog',
        })}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-background/60 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="recall-terminal-title"
          className="pointer-events-auto flex h-[min(720px,calc(100vh-32px))] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background text-card-foreground shadow-2xl"
        >
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <BookmarkPlus className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <h2 id="recall-terminal-title" className="text-sm font-semibold">
                {t('workbench.recall.title', {
                  defaultValue: 'Recall terminals',
                })}
              </h2>
              <p className="truncate text-[11px] text-muted-foreground">
                {t('workbench.recall.subtitle', {
                  defaultValue:
                    'Choose active terminals to keep in your Workbench.',
                })}
              </p>
            </span>
            <button
              type="button"
              onClick={onClose}
              title={t('workbench.recall.close', { defaultValue: 'Close' })}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <RecallTerminalFilters
            query={query}
            scope={scope}
            selectedProjectPath={selectedProjectPath}
            effectiveProjectPath={effectiveProjectPath}
            effectiveProjectOptionPath={effectiveProjectOptionPath}
            projectOptions={projects}
            contextOptions={contextOptions}
            contextOptionId={contextOptionId}
            onQueryChange={setQuery}
            onScopeChange={(nextScope) => {
              setScope(nextScope);
              if (nextScope === 'current' && selectedProjectPath) {
                setProjectPath(selectedProjectPath);
                setContextId(
                  selectedWorktreePath
                    ? recallPathContextId(selectedWorktreePath)
                    : ALL_RECALL_CONTEXTS,
                );
              } else {
                setProjectPath('all');
                setContextId(ALL_RECALL_CONTEXTS);
              }
            }}
            onProjectPathChange={(nextProjectPath) => {
              setProjectPath(nextProjectPath);
              setContextId(ALL_RECALL_CONTEXTS);
            }}
            onContextIdChange={setContextId}
          />

          <RecallTerminalList
            cards={visibleCards}
            followedCardIds={followedIds}
            selectedCardIds={selectedIds}
            onToggleCard={toggleCard}
          />

          <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
            <span className="text-[11px] text-muted-foreground">
              {t('workbench.recall.selectedCount', {
                count: selectedIds.size,
                defaultValue: '{{count}} selected',
              })}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto h-8 rounded-md border border-border px-3 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t('workbench.recall.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              disabled={selectedIds.size === 0}
              onClick={confirm}
              className="h-8 rounded-md bg-primary px-3 text-[11px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('workbench.recall.confirm', {
                defaultValue: 'Add to Workbench',
              })}
            </button>
          </footer>
        </div>
      </div>
    </>
  );
}
