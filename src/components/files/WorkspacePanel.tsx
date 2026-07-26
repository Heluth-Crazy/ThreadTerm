/**
 * WorkspacePanel — right-side navigator for Files / Changes.
 *
 * The panel intentionally stays compact: it lists files and git changes, then
 * asks the main content area to open heavyweight editor or diff tabs.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, FolderTree, GitCompare, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type GitStatusEntry } from '../../lib/tauri-bridge';
import { cn } from '../../lib/utils';
import { IconButton } from '../ui/icon-button';
import { basename, type DirEntry } from './fileMeta';
import { FileTree } from './FileTree';
import {
  getCachedWorkspaceChanges,
  loadWorkspaceChanges,
} from './workspaceLoadCache';

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
  const panelStateRef = useRef(panelState);
  const onStateChangeRef = useRef(onStateChange);
  panelStateRef.current = panelState;
  onStateChangeRef.current = onStateChange;
  const controlled = state !== undefined;
  const updatePanelState = useCallback(
    (patch: Partial<WorkspacePanelState>) => {
      const current = panelStateRef.current;
      const next = { ...current, ...patch };
      if (
        next.tab === current.tab &&
        next.selectedFilePath === current.selectedFilePath &&
        next.selectedChangePath === current.selectedChangePath
      ) {
        return;
      }
      panelStateRef.current = next;
      if (!controlled) setInternalState(next);
      onStateChangeRef.current?.(next);
    },
    [controlled],
  );
  const [changes, setChanges] = useState<GitStatusEntry[]>([]);
  const [changesLoaded, setChangesLoaded] = useState(false);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);

  const loadChanges = useCallback(async () => {
    const cached = getCachedWorkspaceChanges(rootCwd);
    if (cached !== null) {
      setChanges(cached);
      setChangesLoaded(true);
    }
    setChangesLoading(cached === null);
    setChangesError(null);
    try {
      const result = await loadWorkspaceChanges(rootCwd);
      setChanges(result);
      setChangesLoaded(true);
      const selectedChangePath = panelStateRef.current.selectedChangePath;
      updatePanelState({
        selectedChangePath:
          selectedChangePath &&
          result.some((entry) => entry.path === selectedChangePath)
            ? selectedChangePath
            : null,
      });
    } catch (error) {
      if (cached === null) {
        setChanges([]);
        setChangesLoaded(false);
        updatePanelState({ selectedChangePath: null });
        setChangesError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setChangesLoading(false);
    }
  }, [rootCwd, updatePanelState]);

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
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
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
        className="truncate border-b border-border px-3 py-1 font-mono text-[11px] text-muted-foreground"
        title={rootCwd}
        dir="rtl"
      >
        {rootCwd}
      </div>

      {panelState.tab === 'explorer' ? (
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto" data-tree-scroller>
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
          loaded={changesLoaded}
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
  loaded,
  error,
  selectedPath,
  onRefresh,
  onSelectChange,
}: {
  changes: GitStatusEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  selectedPath: string | null;
  onRefresh: () => void;
  onSelectChange: (entry: GitStatusEntry) => void;
}) {
  const { t } = useTranslation('terminal');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[34px] items-center gap-2 border-b border-border px-2 py-1">
        <span className="text-[11px] font-medium text-foreground">
          {t('workspace.changedFiles', { count: changes.length, defaultValue: '{{count}} changed files' })}
        </span>
        <IconButton
          title={t('workspace.refresh', { defaultValue: 'Refresh' })}
          size="sm"
          className="text-muted-foreground"
          onClick={onRefresh}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </IconButton>
      </div>
      {error ? (
        <PanelMessage icon={<AlertTriangle className="h-4 w-4" />} tone="error">
          {error}
        </PanelMessage>
      ) : loading && !loaded ? (
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
        'w-10 shrink-0 rounded px-1 py-0.5 text-center text-[11px] font-semibold uppercase',
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
      className: 'bg-success/10 text-success',
    };
  }
  if (raw.includes('D')) {
    return {
      label: 'Del',
      title: 'Deleted file',
      className: 'bg-destructive/10 text-destructive',
    };
  }
  if (raw.includes('R')) {
    return {
      label: 'Ren',
      title: 'Renamed file',
      className: 'bg-info/10 text-info',
    };
  }
  if (raw.includes('A')) {
    return {
      label: 'Add',
      title: 'Added file',
      className: 'bg-success/10 text-success',
    };
  }
  return {
    label: 'Mod',
    title: 'Modified file',
    className: 'bg-warning/10 text-warning',
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
        'flex h-full min-h-[120px] items-center justify-center gap-2 px-4 text-center text-xs',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground/75',
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
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
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
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
