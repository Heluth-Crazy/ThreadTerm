import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  deriveAgentSessionTitle,
} from '../../lib/agentSessionTitle';
import {
  findTerminalSessionBindingConflict,
  isAgentTerminalType,
  terminalLaunchConfigurationFromCard,
  type TerminalLaunchConfiguration,
  type TerminalLaunchConfigurationDraft,
  type TerminalLaunchMode,
  type TerminalWorkspaceMode,
} from '../../lib/terminalConfiguration';
import { isTauriEnv, providerSessions } from '../../lib/tauri-bridge';
import {
  effectiveWorktreePath,
  samePath,
} from '../../lib/worktreePaths';
import { useTerminalStore } from '../../stores/terminalStore';
import type {
  AgentSessionPage,
  AgentSessionSummary,
} from '../../types/agentSession';
import type { TerminalCard, TerminalType } from '../../types/terminal';
import { terminalTypeMeta } from './terminalTypeMeta';

export type TerminalConfigurationAction = 'save' | 'apply';

export type TerminalConfigurationActionResult =
  | { ok: true }
  | { ok: false; kind: 'error'; message: string }
  | {
      ok: false;
      kind: 'workspace-choice';
      sessionProjectPath: string;
      message: string;
    }
  | {
      ok: false;
      kind: 'duplicate';
      cardId: string;
      archived: boolean;
      message: string;
    };

interface EditTerminalDialogProps {
  open: boolean;
  card: TerminalCard | null;
  pendingConfiguration?: TerminalLaunchConfiguration;
  onClose: () => void;
  onSubmit: (
    cardId: string,
    draft: TerminalLaunchConfigurationDraft,
    action: TerminalConfigurationAction,
  ) => Promise<TerminalConfigurationActionResult>;
  onDiscardPending: (cardId: string) => void;
  onLocateConflict: (cardId: string, archived: boolean) => void;
}

type SessionScope = 'project' | 'all';

const TYPE_LIST = Object.entries(terminalTypeMeta) as [
  TerminalType,
  (typeof terminalTypeMeta)[TerminalType],
][];

function formatUpdatedAt(value?: number | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) || path;
}

function sessionMatchesCardProject(
  session: AgentSessionSummary,
  card: TerminalCard,
): boolean {
  return (
    samePath(session.projectPath, card.projectPath)
    || samePath(session.projectPath, effectiveWorktreePath(card))
  );
}

export function EditTerminalDialog({
  open,
  card,
  pendingConfiguration,
  onClose,
  onSubmit,
  onDiscardPending,
  onLocateConflict,
}: EditTerminalDialogProps) {
  const { t } = useTranslation('terminal');
  const reduceMotion = useReducedMotion();
  const cards = useTerminalStore((state) => state.cards);
  const archivedCards = useTerminalStore((state) => state.archivedCards);
  const [terminalType, setTerminalType] = useState<TerminalType>('shell');
  const [launchMode, setLaunchMode] =
    useState<TerminalLaunchMode>('default');
  const [command, setCommand] = useState('');
  const [providerSessionId, setProviderSessionId] = useState('');
  const [sessionProjectPath, setSessionProjectPath] = useState<string | null>(
    null,
  );
  const [workspaceMode, setWorkspaceMode] =
    useState<TerminalWorkspaceMode | null>(null);
  const [scope, setScope] = useState<SessionScope>('project');
  const [query, setQuery] = useState('');
  const [manualIdOpen, setManualIdOpen] = useState(false);
  const [catalog, setCatalog] = useState<AgentSessionPage | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busyAction, setBusyAction] =
    useState<TerminalConfigurationAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    cardId: string;
    archived: boolean;
  } | null>(null);
  const cardId = card?.id ?? null;
  const activeTerminalType = card?.terminalType;
  const activeCommand = card?.command;
  const activeProviderSessionId = card?.providerSessionId;
  const activeProviderSessionState = card?.providerSessionState;
  const provider = isAgentTerminalType(terminalType)
    ? terminalType
    : null;
  const catalogRequestKey = `${provider ?? ''}\u0000${query.trim()}`;
  const catalogRequestKeyRef = useRef(catalogRequestKey);
  catalogRequestKeyRef.current = catalogRequestKey;

  useEffect(() => {
    if (!open || !cardId || !activeTerminalType) return;
    const configuration =
      pendingConfiguration
      ?? terminalLaunchConfigurationFromCard({
        terminalType: activeTerminalType,
        command: activeCommand,
        providerSessionId: activeProviderSessionId,
        providerSessionState: activeProviderSessionState,
      });
    setTerminalType(configuration.terminalType);
    setLaunchMode(configuration.launchMode);
    setCommand(
      configuration.launchMode === 'custom' ? configuration.command : '',
    );
    setProviderSessionId(
      configuration.launchMode === 'resume'
        ? configuration.providerSessionId
        : '',
    );
    setSessionProjectPath(
      configuration.launchMode === 'resume'
        ? (configuration.sessionProjectPath ?? null)
        : null,
    );
    setWorkspaceMode(
      configuration.launchMode === 'resume'
        ? configuration.workspaceMode
        : null,
    );
    setScope('project');
    setQuery('');
    setManualIdOpen(false);
    setCatalog(null);
    setCatalogLoading(false);
    setCatalogLoadingMore(false);
    setCatalogError(null);
    setActionError(null);
    setConflict(null);
    setBusyAction(null);
  }, [
    activeCommand,
    activeProviderSessionId,
    activeProviderSessionState,
    activeTerminalType,
    cardId,
    open,
    pendingConfiguration,
  ]);

  useEffect(() => {
    if (!open || launchMode !== 'resume' || !provider) return;
    if (!isTauriEnv()) {
      setCatalogError(t('edit.desktopOnly'));
      return;
    }

    let cancelled = false;
    const requestKey = catalogRequestKey;
    setCatalog(null);
    setCatalogLoading(true);
    setCatalogLoadingMore(false);
    setCatalogError(null);
    const timer = window.setTimeout(() => {
      void providerSessions
        .listAgentSessions({
          provider,
          limit: 80,
          query: query.trim() || null,
        })
        .then((page) => {
          if (
            cancelled
            || catalogRequestKeyRef.current !== requestKey
          ) {
            return;
          }
          setCatalog(page);
        })
        .catch((error: unknown) => {
          if (
            cancelled
            || catalogRequestKeyRef.current !== requestKey
          ) {
            return;
          }
          setCatalog(null);
          setCatalogError(
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          if (
            !cancelled
            && catalogRequestKeyRef.current === requestKey
          ) {
            setCatalogLoading(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [catalogRequestKey, launchMode, open, provider, query, t]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyAction) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busyAction, onClose, open]);

  const displayedSessions = useMemo(() => {
    if (!card || !catalog) return [];
    const items =
      scope === 'project'
        ? catalog.items.filter((session) =>
            sessionMatchesCardProject(session, card),
          )
        : [...catalog.items].sort((left, right) => {
            const leftCurrent = sessionMatchesCardProject(left, card) ? 1 : 0;
            const rightCurrent = sessionMatchesCardProject(right, card) ? 1 : 0;
            if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
            return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
          });
    return items;
  }, [card, catalog, scope]);

  const selectedConflict = useMemo(() => {
    if (!provider || !providerSessionId.trim()) return null;
    return findTerminalSessionBindingConflict(
      cards,
      archivedCards,
      provider,
      providerSessionId,
      card?.id,
    );
  }, [
    archivedCards,
    card?.id,
    cards,
    provider,
    providerSessionId,
  ]);

  const crossProject =
    Boolean(card && sessionProjectPath)
    && !samePath(sessionProjectPath, card?.projectPath)
    && !samePath(sessionProjectPath, card ? effectiveWorktreePath(card) : null);
  const basicValid =
    launchMode === 'default'
    || (launchMode === 'custom' && Boolean(command.trim()))
    || (
      launchMode === 'resume'
      && Boolean(provider)
      && Boolean(providerSessionId.trim())
      && (!crossProject || workspaceMode !== null)
    );

  if (!open || !card) return null;

  const handleTypeChange = (nextType: TerminalType) => {
    setTerminalType(nextType);
    setActionError(null);
    setConflict(null);
    if (launchMode === 'resume') {
      if (!isAgentTerminalType(nextType)) {
        setLaunchMode('default');
      }
      setProviderSessionId('');
      setSessionProjectPath(null);
      setWorkspaceMode(null);
      setCatalog(null);
    }
  };

  const selectSession = (session: AgentSessionSummary) => {
    if (!session.resumable) return;
    setProviderSessionId(session.id);
    setSessionProjectPath(session.projectPath);
    setWorkspaceMode(
      sessionMatchesCardProject(session, card) ? 'current' : null,
    );
    setActionError(null);
    setConflict(null);
  };

  const loadMoreSessions = async () => {
    if (
      !provider
      || !catalog?.nextCursor
      || catalogLoading
      || catalogLoadingMore
    ) {
      return;
    }
    const requestKey = catalogRequestKey;
    const cursor = catalog.nextCursor;
    setCatalogLoadingMore(true);
    setCatalogError(null);
    try {
      const nextPage = await providerSessions.listAgentSessions({
        provider,
        cursor,
        limit: 80,
        query: query.trim() || null,
      });
      if (catalogRequestKeyRef.current !== requestKey) return;
      setCatalog((current) => {
        if (!current || current.provider !== nextPage.provider) {
          return nextPage;
        }
        const seen = new Set(
          current.items.map((session) => `${session.provider}:${session.id}`),
        );
        return {
          ...nextPage,
          items: [
            ...current.items,
            ...nextPage.items.filter(
              (session) =>
                !seen.has(`${session.provider}:${session.id}`),
            ),
          ],
        };
      });
    } catch (error) {
      if (catalogRequestKeyRef.current !== requestKey) return;
      setCatalogError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (catalogRequestKeyRef.current === requestKey) {
        setCatalogLoadingMore(false);
      }
    }
  };

  const submit = async (
    event: FormEvent,
    action: TerminalConfigurationAction,
  ) => {
    event.preventDefault();
    if (!basicValid || busyAction) return;
    setBusyAction(action);
    setActionError(null);
    setConflict(null);
    const catalogSessionProjectPath = catalog?.items.find(
      (session) =>
        session.provider === provider
        && session.id === providerSessionId.trim(),
    )?.projectPath;
    const result = await onSubmit(
      card.id,
      {
        terminalType,
        launchMode,
        command,
        providerSessionId,
        workspaceMode,
        sessionProjectPath:
          sessionProjectPath ?? catalogSessionProjectPath ?? null,
      },
      action,
    );
    setBusyAction(null);
    if (result.ok) {
      onClose();
      return;
    }
    if (result.kind === 'workspace-choice') {
      setSessionProjectPath(result.sessionProjectPath);
      setWorkspaceMode(null);
      setActionError(result.message);
      return;
    }
    if (result.kind === 'duplicate') {
      setConflict({
        cardId: result.cardId,
        archived: result.archived,
      });
    }
    setActionError(result.message);
  };

  const activeConfiguration = terminalLaunchConfigurationFromCard(card);
  const activeModeLabel = t(`edit.mode.${activeConfiguration.launchMode}`);
  const proposedModeLabel = t(`edit.mode.${launchMode}`);
  const configurationDirty = (() => {
    if (terminalType !== activeConfiguration.terminalType) return true;
    if (launchMode !== activeConfiguration.launchMode) return true;
    if (launchMode === 'custom' && activeConfiguration.launchMode === 'custom') {
      return command !== activeConfiguration.command;
    }
    if (launchMode === 'resume' && activeConfiguration.launchMode === 'resume') {
      return providerSessionId.trim() !== activeConfiguration.providerSessionId;
    }
    return false;
  })();
  const agentTypes = TYPE_LIST.filter(([type]) => isAgentTerminalType(type));
  const presetTypes = TYPE_LIST.filter(([type]) => !isAgentTerminalType(type));
  const catalogHasSelection = Boolean(
    catalog?.items.some((session) => session.id === providerSessionId.trim()),
  );
  const manualEntryVisible =
    manualIdOpen || (providerSessionId.trim() !== '' && !catalogHasSelection);

  return (
    <>
      <motion.div
        initial={{ opacity: reduceMotion ? 1 : 0 }}
        animate={{ opacity: 1 }}
        onClick={busyAction ? undefined : onClose}
        className="fixed inset-0 z-40 bg-background/65 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5">
        <motion.div
          initial={
            reduceMotion
              ? { opacity: 1 }
              : { opacity: 0, scale: 0.985, y: 10 }
          }
          animate={{ opacity: 1, scale: 1, y: 0 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-terminal-title"
          className={[
            'pointer-events-auto flex h-[min(720px,calc(100vh-40px))] w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl',
            'max-w-2xl',
          ].join(' ')}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Settings2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 id="edit-terminal-title" className="truncate text-base font-semibold">
                  {t('edit.title')}
                </h2>
                <p className="truncate text-[11px] text-muted-foreground">
                  {card.projectName} · {pathLeaf(effectiveWorktreePath(card))}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={Boolean(busyAction)}
              aria-label={t('edit.close')}
              className="rounded-md p-1.5 hover:bg-accent disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form
            className="min-h-0 flex-1 overflow-y-auto"
            onSubmit={(event) => void submit(event, 'apply')}
          >
            <div className="space-y-4 p-4 sm:p-5">
                <div>
                  <label className="text-xs font-medium">{t('edit.type')}</label>
                  {[
                    [t('edit.typeGroupAgent'), agentTypes],
                    [t('edit.typeGroupPreset'), presetTypes],
                  ].map(([groupLabel, groupTypes]) => (
                    <div key={groupLabel as string} className="mt-1.5">
                      <div className="mb-1 text-[11px] text-muted-foreground">
                        {groupLabel as string}
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(groupTypes as typeof TYPE_LIST).map(([type, meta]) => {
                          const Icon = meta.Icon;
                          const selected = terminalType === type;
                          return (
                            <button
                              key={type}
                              type="button"
                              onClick={() => handleTypeChange(type)}
                              className={[
                                'flex min-w-0 flex-col items-center gap-1 rounded-md border px-1 py-2 text-[10px] transition-colors',
                                selected
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-border hover:bg-accent',
                              ].join(' ')}
                            >
                              <Icon className={`h-4 w-4 ${meta.accent}`} />
                              <span className="truncate">
                                {t(`types.${type}`, meta.label)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div>
                  <label className="text-xs font-medium">{t('edit.launchMode')}</label>
                  <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
                    {(['default', 'resume', 'custom'] as TerminalLaunchMode[]).map(
                      (mode) => {
                        const disabled =
                          mode === 'resume' && !isAgentTerminalType(terminalType);
                        return (
                          <button
                            key={mode}
                            type="button"
                            disabled={disabled}
                            title={disabled ? t('edit.resumeAgentOnly') : undefined}
                            onClick={() => {
                              setLaunchMode(mode);
                              setActionError(null);
                              setConflict(null);
                            }}
                            className={[
                              'rounded-md px-2 py-1.5 text-[11px] font-medium',
                              launchMode === mode
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                              disabled ? 'cursor-not-allowed opacity-35' : '',
                            ].join(' ')}
                          >
                            {t(`edit.mode.${mode}`)}
                          </button>
                        );
                      },
                    )}
                  </div>
                </div>

                {launchMode === 'default' && (
                  <div className="rounded-lg border border-border bg-muted/25 p-3 text-xs">
                    <div className="font-medium">{t('edit.defaultTitle')}</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {t('edit.defaultDescription', {
                        type: t(`types.${terminalType}`),
                      })}
                    </p>
                  </div>
                )}

                {launchMode === 'custom' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t('edit.command')}</label>
                    <textarea
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      rows={4}
                      placeholder={t('edit.commandPlaceholder')}
                      className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring/40"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t('edit.commandHint')}
                    </p>
                    <div className="rounded-lg border border-border bg-muted/25 p-3">
                      <div className="text-xs font-medium">{t('edit.customSideTitle')}</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {t('edit.customSideDescription')}
                      </p>
                    </div>
                  </div>
                )}

                {configurationDirty && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-xs font-medium">{t('edit.changeSummary')}</div>
                    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
                      <span className="text-muted-foreground">{t('edit.current')}</span>
                      <span>
                        {t(`types.${card.terminalType}`)} · {activeModeLabel}
                      </span>
                      <span className="text-muted-foreground">{t('edit.afterSave')}</span>
                      <span className="font-medium text-primary">
                        {t(`types.${terminalType}`)} · {proposedModeLabel}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {t('edit.preserveHint')}
                    </p>
                  </div>
                )}

              {launchMode === 'resume' && (
                <section className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-medium">{t('edit.historyTitle')}</div>
                        <p className="text-[11px] text-muted-foreground">
                          {t('edit.historyLocalHint')}
                        </p>
                      </div>
                      <div className="flex rounded-md border border-border p-0.5">
                        {(['project', 'all'] as SessionScope[]).map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setScope(value)}
                            className={[
                              'rounded px-2 py-1 text-[11px]',
                              scope === value
                                ? 'bg-primary/10 text-primary'
                                : 'text-muted-foreground hover:bg-accent',
                            ].join(' ')}
                          >
                            {t(`edit.scope.${value}`)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <label className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                      <Search className="h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('edit.searchSessions')}
                        className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                      />
                      {catalogLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    </label>

                    <div className="h-56 overflow-y-auto rounded-lg border border-border bg-muted/15 p-1.5">
                      {catalogError ? (
                        <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-destructive">
                          {catalogError}
                        </div>
                      ) : catalogLoading && !catalog ? (
                        <div className="flex h-full items-center justify-center">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : displayedSessions.length === 0 ? (
                        <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                          {t('edit.noSessions')}
                        </div>
                      ) : (
                        <ul className="space-y-1">
                          {displayedSessions.map((session) => {
                            const title = deriveAgentSessionTitle(session);
                            const selected = providerSessionId === session.id;
                            const existing = provider
                              ? findTerminalSessionBindingConflict(
                                  cards,
                                  archivedCards,
                                  provider,
                                  session.id,
                                  card.id,
                                )
                              : null;
                            return (
                              <li key={`${session.provider}:${session.id}`}>
                                <button
                                  type="button"
                                  disabled={!session.resumable}
                                  onClick={() => selectSession(session)}
                                  className={[
                                    'flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                                    selected
                                      ? 'border-primary bg-primary/10'
                                      : 'border-transparent hover:border-border hover:bg-accent/60',
                                    !session.resumable ? 'opacity-45' : '',
                                  ].join(' ')}
                                >
                                  <span
                                    className={[
                                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                      selected
                                        ? 'border-primary bg-primary text-primary-foreground'
                                        : 'border-border',
                                    ].join(' ')}
                                  >
                                    {selected && <Check className="h-2.5 w-2.5" />}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="flex min-w-0 items-center gap-2">
                                      <span className="truncate text-xs font-medium">
                                        {title.primary}
                                      </span>
                                      {existing && (
                                        <span className="shrink-0 text-[10px] text-warning">
                                          {t(
                                            existing.archived
                                              ? 'edit.usedArchived'
                                              : 'edit.usedActive',
                                          )}
                                        </span>
                                      )}
                                    </span>
                                    {title.secondary && (
                                      <span className="block truncate text-[11px] text-muted-foreground">
                                        {title.secondary}
                                      </span>
                                    )}
                                    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                                      <span title={session.projectPath}>
                                        {pathLeaf(session.projectPath)}
                                      </span>
                                      <span>{formatUpdatedAt(session.updatedAt)}</span>
                                    </span>
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                    {catalog?.nextCursor && !catalogError && (
                      <button
                        type="button"
                        disabled={catalogLoading || catalogLoadingMore}
                        onClick={() => void loadMoreSessions()}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {catalogLoadingMore && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {t('sessionRecovery.loadMore')}
                      </button>
                    )}

                    <div className="space-y-1.5">
                      <button
                        type="button"
                        onClick={() => setManualIdOpen((value) => !value)}
                        aria-expanded={manualEntryVisible}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        {manualEntryVisible ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        {t('edit.manualSessionId')}
                      </button>
                      {manualEntryVisible && (
                        <input
                          value={providerSessionId}
                          onChange={(event) => {
                            setProviderSessionId(event.target.value);
                            setSessionProjectPath(null);
                            setWorkspaceMode(null);
                            setActionError(null);
                            setConflict(null);
                          }}
                          placeholder={t('edit.manualSessionIdPlaceholder')}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring/40"
                        />
                      )}
                    </div>

                    {crossProject && (
                      <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {t('edit.crossProjectTitle')}
                        </div>
                        <p className="mt-1 break-all text-[11px] text-muted-foreground">
                          {sessionProjectPath}
                        </p>
                        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                          {(['current', 'session'] as TerminalWorkspaceMode[]).map(
                            (value) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => {
                                  setWorkspaceMode(value);
                                  setActionError(null);
                                }}
                                className={[
                                  'rounded-md border px-2.5 py-2 text-left text-[11px]',
                                  workspaceMode === value
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border hover:bg-accent',
                                ].join(' ')}
                              >
                                <span className="block font-medium">
                                  {t(`edit.workspace.${value}`)}
                                </span>
                                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                                  {t(`edit.workspace.${value}Hint`)}
                                </span>
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                </section>
              )}
            </div>

            {(actionError || selectedConflict) && (
                  <div
                    role="alert"
                    className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive sm:mx-5"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {actionError
                          ?? t(
                            selectedConflict?.archived
                              ? 'edit.duplicateArchived'
                              : 'edit.duplicateActive',
                          )}
                      </span>
                    </div>
                    {(conflict || selectedConflict) && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = conflict ?? selectedConflict;
                          if (target) onLocateConflict(target.cardId, target.archived);
                        }}
                        className="mt-2 rounded border border-destructive/30 px-2 py-1 font-medium hover:bg-destructive/10"
                      >
                        {(conflict ?? selectedConflict)?.archived
                          ? t('edit.restoreOriginal')
                          : t('edit.locateOriginal')}
                      </button>
                    )}
                  </div>
                )}

            <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-5">
              <p className="mb-2 text-[11px] text-muted-foreground">
                {card.status === 'running'
                  ? t('edit.footerHintRunning')
                  : t('edit.footerHint')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
              {pendingConfiguration && (
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => {
                    onDiscardPending(card.id);
                    onClose();
                  }}
                  className="rounded-md px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {t('edit.discardPending')}
                </button>
              )}
              <div className="ml-auto flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={onClose}
                  className="rounded-md px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {t('edit.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!basicValid || Boolean(busyAction)}
                  onClick={(event) => void submit(event, 'save')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                >
                  {busyAction === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('edit.saveOnly')}
                </button>
                <button
                  type="submit"
                  disabled={!basicValid || Boolean(busyAction)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busyAction === 'apply' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('edit.saveAndRestart')}
                </button>
              </div>
              </div>
            </div>
          </form>
        </motion.div>
      </div>
    </>
  );
}
