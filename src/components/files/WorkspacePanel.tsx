/**
 * WorkspacePanel — right-side navigator for Files / Changes.
 *
 * The panel intentionally stays compact: it lists files and git changes, then
 * asks the main content area to open heavyweight editor or diff tabs.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, FolderTree, GitCompare, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { git, type GitStatusEntry } from '../../lib/tauri-bridge';
import { cn } from '../../lib/utils';
import { basename, type DirEntry } from './fileMeta';
import { FileTree } from './FileTree';

export type WorkspaceTab = 'explorer' | 'changes';

export interface WorkspacePanelState {
  tab: WorkspaceTab;
  selectedFilePath: string | null;
  selectedChangePath: string | null;
}

interface WorkspacePanelProps {
  /** Live working directory of the focused card (tree root). */
  rootCwd: string;
  state?: WorkspacePanelState;
  activeFilePath?: string | null;
  activeDiffPath?: string | null;
  onStateChange?: (state: WorkspacePanelState) => void;
  onClose?: () => void;
  onOpenFile: (rootPath: string, entry: DirEntry) => void;
  onOpenDiff: (entry: GitStatusEntry) => void;
}

const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  tab: 'explorer',
  selectedFilePath: null,
  selectedChangePath: null,
};

export function WorkspacePanel({
  rootCwd,
  state,
  activeFilePath = null,
  activeDiffPath = null,
  onStateChange,
  onClose,
  onOpenFile,
  onOpenDiff,
}: WorkspacePanelProps) {
  const { t } = useTranslation('terminal');
  const [internalState, setInternalState] = useState<WorkspacePanelState>(
    DEFAULT_WORKSPACE_PANEL_STATE,
  );
  const panelState = state ?? internalState;
  const updatePanelState = useCallback(
    (patch: Partial<WorkspacePanelState>) => {
      const next = { ...panelState, ...patch };
      if (
        next.tab === panelState.tab &&
        next.selectedFilePath === panelState.selectedFilePath &&
        next.selectedChangePath === panelState.selectedChangePath
      ) {
        return;
      }
      if (!state) setInternalState(next);
      onStateChange?.(next);
    },
    [onStateChange, panelState, state],
  );
  const [changes, setChanges] = useState<GitStatusEntry[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);

  const loadChanges = useCallback(async () => {
    setChangesLoading(true);
    setChangesError(null);
    try {
      const result = await git.changes.status(rootCwd);
      setChanges(result);
      updatePanelState({
        selectedChangePath:
          panelState.selectedChangePath &&
          result.some((entry) => entry.path === panelState.selectedChangePath)
            ? panelState.selectedChangePath
            : null,
      });
    } catch (error) {
      setChanges([]);
      updatePanelState({ selectedChangePath: null });
      setChangesError(error instanceof Error ? error.message : String(error));
    } finally {
      setChangesLoading(false);
    }
  }, [panelState.selectedChangePath, rootCwd, updatePanelState]);

  useEffect(() => {
    if (panelState.tab === 'changes') void loadChanges();
  }, [loadChanges, panelState.tab]);

  const handleSelectFile = useCallback(
    (entry: DirEntry) => {
      updatePanelState({ selectedFilePath: entry.path });
      onOpenFile(rootCwd, entry);
    },
    [onOpenFile, rootCwd, updatePanelState],
  );

  const handleSelectChange = useCallback(
    (entry: GitStatusEntry) => {
      updatePanelState({ selectedChangePath: entry.path });
      onOpenDiff(entry);
    },
    [onOpenDiff, updatePanelState],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <TabButton
          active={panelState.tab === 'explorer'}
          onClick={() => updatePanelState({ tab: 'explorer' })}
          icon={<FolderTree className="h-3.5 w-3.5" />}
          label={t('workspace.files', { defaultValue: 'Files' })}
        />
        <TabButton
          active={panelState.tab === 'changes'}
          onClick={() => updatePanelState({ tab: 'changes' })}
          icon={<GitCompare className="h-3.5 w-3.5" />}
          label={t('workspace.changes', { defaultValue: 'Changes' })}
        />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div
        className="truncate border-b border-white/5 px-3 py-1 font-mono text-[10px] text-muted-foreground"
        title={rootCwd}
        dir="rtl"
      >
        {rootCwd}
      </div>

      {panelState.tab === 'explorer' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FileTree
            rootPath={rootCwd}
            selectedPath={activeFilePath ?? panelState.selectedFilePath}
            onSelectFile={handleSelectFile}
          />
        </div>
      ) : (
        <ChangesList
          changes={changes}
          loading={changesLoading}
          error={changesError}
          selectedPath={activeDiffPath ?? panelState.selectedChangePath}
          onRefresh={() => void loadChanges()}
          onSelectChange={handleSelectChange}
        />
      )}
    </div>
  );
}

function ChangesList({
  changes,
  loading,
  error,
  selectedPath,
  onRefresh,
  onSelectChange,
}: {
  changes: GitStatusEntry[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  onRefresh: () => void;
  onSelectChange: (entry: GitStatusEntry) => void;
}) {
  const { t } = useTranslation('terminal');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[34px] items-center gap-2 border-b border-white/10 px-2 py-1">
        <span className="text-[11px] font-medium text-foreground">
          {t('workspace.changedFiles', { count: changes.length, defaultValue: '{{count}} changed files' })}
        </span>
        <IconButton title={t('workspace.refresh', { defaultValue: 'Refresh' })} onClick={onRefresh}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </IconButton>
      </div>
      {error ? (
        <PanelMessage icon={<AlertTriangle className="h-4 w-4" />} tone="error">
          {error}
        </PanelMessage>
      ) : loading ? (
        <PanelMessage icon={<Loader2 className="h-4 w-4 animate-spin" />} tone="muted">
          {t('workspace.loadingChanges', { defaultValue: 'Loading changes...' })}
        </PanelMessage>
      ) : changes.length === 0 ? (
        <PanelMessage icon={<GitCompare className="h-4 w-4" />} tone="muted">
          {t('workspace.noChanges', { defaultValue: 'No Git changes.' })}
        </PanelMessage>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {changes.map((entry) => (
            <button
              type="button"
              key={entry.path}
              onClick={() => onSelectChange(entry)}
              title={entry.path}
              className={cn(
                'flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] transition-colors',
                selectedPath === entry.path
                  ? 'bg-primary/15 text-foreground'
                  : 'text-foreground/85 hover:bg-accent/60',
              )}
            >
              <ChangeStatusPill entry={entry} />
              <span className="min-w-0 flex-1 truncate">{basename(entry.path)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeStatusPill({ entry }: { entry: GitStatusEntry }) {
  const status = changeStatus(entry);
  return (
    <span
      className={cn(
        'w-10 shrink-0 rounded px-1 py-0.5 text-center text-[9px] font-semibold uppercase',
        status.className,
      )}
      title={status.title}
    >
      {status.label}
    </span>
  );
}

function changeStatus(entry: GitStatusEntry): {
  label: string;
  title: string;
  className: string;
} {
  const raw = `${entry.staged ?? ''}${entry.unstaged ?? ''}`;
  if (entry.isUntracked) {
    return {
      label: 'New',
      title: 'Untracked file',
      className: 'bg-emerald-500/15 text-emerald-300',
    };
  }
  if (raw.includes('D')) {
    return {
      label: 'Del',
      title: 'Deleted file',
      className: 'bg-red-500/15 text-red-300',
    };
  }
  if (raw.includes('R')) {
    return {
      label: 'Ren',
      title: 'Renamed file',
      className: 'bg-sky-500/15 text-sky-300',
    };
  }
  if (raw.includes('A')) {
    return {
      label: 'Add',
      title: 'Added file',
      className: 'bg-emerald-500/15 text-emerald-300',
    };
  }
  return {
    label: 'Mod',
    title: 'Modified file',
    className: 'bg-amber-500/15 text-amber-300',
  };
}

function PanelMessage({
  icon,
  tone,
  children,
}: {
  icon: ReactNode;
  tone: 'muted' | 'error';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-[120px] items-center justify-center gap-2 px-4 text-center text-[12px]',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground/75',
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'bg-primary/15 text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
