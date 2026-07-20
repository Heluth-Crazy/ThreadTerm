import { History, Loader2, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauriEnv } from '../../lib/tauri-bridge';
import {
  agentSessionSelectionKey,
  deriveAgentSessionTitle,
} from '../../lib/agentSessionTitle';
import { useAgentSessionCatalogStore } from '../../stores/agentSessionCatalogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { isCatalogProviderSessionType, providerSessionKey } from '../../stores/terminal/helpers';
import type { AgentSessionProvider, AgentSessionSummary } from '../../types/agentSession';
import { AGENT_SESSION_PROVIDERS } from '../../types/agentSession';
import type { ProviderSessionImportInfo } from '../../types/terminal';
import { getTerminalTypeMeta } from './terminalTypeMeta';

export interface SessionRecoveryPanelProps {
  onClose: () => void;
}

function formatUpdatedAt(value?: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function SessionRecoveryPanel({ onClose }: SessionRecoveryPanelProps) {
  const { t } = useTranslation('terminal');
  const panelRef = useRef<HTMLDivElement>(null);
  const closeLabel = t('common.close', { defaultValue: 'Close' });

  const activeProvider = useAgentSessionCatalogStore((s) => s.activeProvider);
  const query = useAgentSessionCatalogStore((s) => s.query);
  const selectedKeys = useAgentSessionCatalogStore((s) => s.selectedKeys);
  const providers = useAgentSessionCatalogStore((s) => s.providers);
  const setActiveProvider = useAgentSessionCatalogStore((s) => s.setActiveProvider);
  const setQuery = useAgentSessionCatalogStore((s) => s.setQuery);
  const toggleSelected = useAgentSessionCatalogStore((s) => s.toggleSelected);
  const clearSelection = useAgentSessionCatalogStore((s) => s.clearSelection);
  const ensureLoaded = useAgentSessionCatalogStore((s) => s.ensureLoaded);
  const loadMore = useAgentSessionCatalogStore((s) => s.loadMore);
  const retry = useAgentSessionCatalogStore((s) => s.retry);
  const getSelectedSummaries = useAgentSessionCatalogStore((s) => s.getSelectedSummaries);
  const resetCatalog = useAgentSessionCatalogStore((s) => s.reset);

  const importProviderSessionCards = useTerminalStore((s) => s.importProviderSessionCards);
  const cards = useTerminalStore((s) => s.cards);
  const archivedCards = useTerminalStore((s) => s.archivedCards);

  const knownStatus = useMemo(() => {
    const active = new Set<string>();
    const archived = new Set<string>();
    for (const card of cards) {
      if (isCatalogProviderSessionType(card.terminalType) && card.providerSessionId) {
        active.add(
          providerSessionKey(
            card.terminalType as ProviderSessionImportInfo['provider'],
            card.providerSessionId,
          ),
        );
      }
    }
    for (const card of archivedCards ?? []) {
      if (isCatalogProviderSessionType(card.terminalType) && card.providerSessionId) {
        archived.add(
          providerSessionKey(
            card.terminalType as ProviderSessionImportInfo['provider'],
            card.providerSessionId,
          ),
        );
      }
    }
    return { active, archived };
  }, [archivedCards, cards]);

  useEffect(() => {
    if (!isTauriEnv()) return;
    void ensureLoaded(activeProvider);
  }, [activeProvider, ensureLoaded]);

  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = node.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => {
      previouslyFocused?.focus?.();
      resetCatalog();
    };
  }, [resetCatalog]);

  const providerState = providers[activeProvider];
  const selectedCount = selectedKeys.size;

  const handleRestore = () => {
    const selected = getSelectedSummaries().filter((summary) => {
      const key = providerSessionKey(summary.provider, summary.id);
      return !knownStatus.active.has(key) && !knownStatus.archived.has(key);
    });
    if (selected.length === 0) return;

    const payload: ProviderSessionImportInfo[] = selected.map((summary) => {
      const title = deriveAgentSessionTitle(summary);
      return {
        id: summary.id,
        provider: summary.provider,
        projectPath: summary.projectPath,
        updatedAt: summary.updatedAt ?? null,
        projectNameHint: title.primary.slice(0, 80),
      };
    });
    importProviderSessionCards(payload);
    clearSelection();
    onClose();
  };

  const renderStatus = (summary: AgentSessionSummary) => {
    const key = providerSessionKey(summary.provider, summary.id);
    if (knownStatus.active.has(key) || knownStatus.archived.has(key)) {
      return (
        <span className="shrink-0 text-[10px] text-emerald-600">
          {t('sessionRecovery.alreadyAdded')}
        </span>
      );
    }
    return null;
  };

  const renderBody = () => {
    if (!isTauriEnv()) {
      return (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
          {t('sessionRecovery.desktopOnly')}
        </div>
      );
    }

    if (providerState.loadState === 'loading' && providerState.items.length === 0) {
      return (
        <div className="flex flex-1 flex-col gap-2 p-2" aria-busy="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-12 animate-pulse rounded-[var(--radius-md)] bg-white/[0.04]"
            />
          ))}
        </div>
      );
    }

    if (
      providerState.loadState === 'error' ||
      providerState.availability === 'error'
    ) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-[11px] text-muted-foreground">
            {providerState.errorMessage ||
              providerState.warning ||
              t('sessionRecovery.error')}
          </p>
          <button
            type="button"
            onClick={() => void retry(activeProvider)}
            className="inline-flex items-center gap-1 rounded-[var(--radius-md)] border border-white/10 px-2 py-1 text-[11px] hover:bg-accent"
          >
            <RotateCcw className="h-3 w-3" />
            {t('sessionRecovery.retry')}
          </button>
        </div>
      );
    }

    if (providerState.availability === 'missingCli') {
      return (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
          {t('sessionRecovery.missingCli', {
            provider: t(`types.${activeProvider}`, activeProvider),
          })}
        </div>
      );
    }

    if (providerState.availability === 'unavailable') {
      return (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
          {t('sessionRecovery.unavailable', {
            provider: t(`types.${activeProvider}`, activeProvider),
          })}
        </div>
      );
    }

    if (providerState.items.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
          {t('sessionRecovery.empty')}
        </div>
      );
    }

    return (
      <ul className="flex-1 space-y-1 overflow-y-auto p-1.5">
        {providerState.items.map((summary) => {
          const key = agentSessionSelectionKey(summary.provider, summary.id);
          const statusKey = providerSessionKey(summary.provider, summary.id);
          const alreadyAdded =
            knownStatus.active.has(statusKey) || knownStatus.archived.has(statusKey);
          const selected = selectedKeys.has(key);
          const title = deriveAgentSessionTitle(summary);
          const typeMeta = getTerminalTypeMeta(summary.provider);
          const TypeIcon = typeMeta.Icon;
          const titleKindLabel =
            summary.provider === 'opencode'
              ? t('sessionRecovery.titleKind.providerTitle')
              : title.kind === 'explicit'
                ? t('sessionRecovery.titleKind.renamed')
                : title.kind === 'firstPrompt'
                  ? t('sessionRecovery.titleKind.firstPrompt')
                  : t('sessionRecovery.titleKind.providerTitle');

          return (
            <li key={key}>
              <label
                className={[
                  'flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border px-2 py-2',
                  selected
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-white/10 bg-white/[0.03]',
                  alreadyAdded ? 'opacity-60' : '',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected}
                  disabled={alreadyAdded}
                  onChange={() => toggleSelected(summary.provider, summary.id)}
                  aria-label={title.primary}
                />
                <div
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-muted ${typeMeta.accent}`}
                >
                  <TypeIcon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{title.primary}</span>
                    {renderStatus(summary)}
                  </div>
                  {title.secondary && (
                    <div className="truncate text-[10px] text-muted-foreground">
                      {title.secondary}
                    </div>
                  )}
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span title={summary.projectPath}>{pathLeaf(summary.projectPath)}</span>
                    <span>{formatUpdatedAt(summary.updatedAt)}</span>
                    <span>{titleKindLabel}</span>
                  </div>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div ref={panelRef} className="flex h-full flex-col" role="dialog" aria-label={t('sessionRecovery.title')}>
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <History className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate">{t('sessionRecovery.title')}</span>
        <button
          type="button"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <p className="border-b border-white/5 px-3 py-1.5 text-[10px] text-muted-foreground">
        {t('sessionRecovery.localOnlyHint')}
      </p>

      <div className="flex gap-1 overflow-x-auto border-b border-white/10 px-2 py-1.5">
        {AGENT_SESSION_PROVIDERS.map((provider) => (
          <button
            key={provider}
            type="button"
            onClick={() => setActiveProvider(provider as AgentSessionProvider)}
            className={[
              'rounded-[var(--radius-md)] px-2 py-1 text-[11px] font-medium',
              activeProvider === provider
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-accent hover:text-accent-foreground',
            ].join(' ')}
          >
            {t(`types.${provider}`, provider)}
          </button>
        ))}
      </div>

      <div className="border-b border-white/10 px-2 py-1.5">
        <label className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-white/10 bg-white/[0.02] px-2 py-1">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sessionRecovery.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      {renderBody()}

      {providerState.nextCursor && providerState.loadState !== 'error' && (
        <div className="border-t border-white/10 p-2">
          <button
            type="button"
            onClick={() => void loadMore(activeProvider)}
            disabled={providerState.loadState === 'loading'}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-white/10 px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
          >
            {providerState.loadState === 'loading' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {t('sessionRecovery.loadMore')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-white/10 p-2">
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {t('sessionRecovery.selectedCount', { count: selectedCount })}
        </span>
        <button
          type="button"
          onClick={handleRestore}
          disabled={selectedCount === 0 || !isTauriEnv()}
          className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
        >
          {t('sessionRecovery.restoreSelected')}
        </button>
      </div>
    </div>
  );
}
