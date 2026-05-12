/**
 * ProjectSidebar — left pane showing a rollup of projects.
 *
 * Behaviour (Finder-style):
 *   • "All" row always at top — clicking clears the project filter
 *   • Each project below shows name + card count + optional unread dot
 *   • Click a project → set as filter, grid in the main area filters to it
 *   • Collapse toggle reduces the sidebar to an icon rail (w-12)
 *   • Open-dir button on hover uses a local-directory Tauri command
 *
 * No drag-and-drop, rename, or delete — keep surface small.
 */
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Layers,
  Download,
  Pencil,
  Play,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { openLocalDirectory } from '../../lib/localDirectory';
import { useTerminalStore } from '../../stores/terminalStore';
import { useProjectGroups } from './useProjectGroups';
import {
  classifyApplyEntries,
  type ApplyPresetEntry,
} from '../../lib/workflows/dedupWorkflows';
import {
  ensureDir,
  loadProjectPresetWorkflows,
  resolveProjectWorkflowsDir,
} from '../../lib/workflows/tauriFs';
import {
  workflowAiIntent,
  workflowTerminalType,
} from '../../lib/workflows/workflowRun';
import { ApplyPresetDialog } from '../workflows/ApplyPresetDialog';
import type { DiscoveryErrorReason } from '../../lib/workflows/discoverWorkflows';

const DISCOVERY_ERROR_I18N_KEY: Record<DiscoveryErrorReason, string> = {
  'parse-failed': 'parseFailed',
  'duplicate-name': 'duplicateName',
  'too-large': 'fileTooLarge',
  'read-failed': 'readFailed',
};

interface ProjectSidebarProps {
  className?: string;
  onImportWorkflow?: (projectPath: string, projectName: string) => void;
  onCloseMobile?: () => void;
}

export function ProjectSidebar({
  className = '',
  onImportWorkflow,
  onCloseMobile,
}: ProjectSidebarProps) {
  const { t } = useTranslation('terminal');
  const groups = useProjectGroups();
  const cards = useTerminalStore((s) => s.cards);
  const totalCards = cards.length;
  const totalUnread = useMemo(
    () => cards.filter((c) => c.unread).length,
    [cards],
  );
  const selectedPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const createCard = useTerminalStore((s) => s.createCard);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const updateCardAiIntent = useTerminalStore((s) => s.updateCardAiIntent);
  const pushNotification = useTerminalStore((s) => s.pushNotification);

  const [collapsed, setCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
  } | null>(null);
  const [applyPreset, setApplyPreset] = useState<{
    projectPath: string;
    projectName: string;
    entries: ApplyPresetEntry[];
    loading: boolean;
  } | null>(null);

  const handleOpenDir = (path: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!isTauriEnv()) return;
    openLocalDirectory(path).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[ProjectSidebar] open dir failed:', err);
    });
  };

  const notifyWorkflowFailure = (title: string, body: string) => {
    pushNotification({
      cardId: 'system:workflows',
      kind: 'failed',
      title,
      body,
    });
  };

  const handleEditPreset = async (projectPath: string) => {
    setContextMenu(null);
    if (!isTauriEnv()) {
      notifyWorkflowFailure(
        t('workflow.editPreset', { defaultValue: 'Edit project preset' }),
        t('dialog.browseDesktopOnly'),
      );
      return;
    }
    try {
      const dir = await resolveProjectWorkflowsDir(projectPath);
      await ensureDir(dir);
      await openLocalDirectory(dir);
    } catch (err) {
      notifyWorkflowFailure(
        t('workflow.dirCreateFailed', { defaultValue: 'Could not open workflow directory' }),
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const handleApplyPreset = async (projectPath: string, projectName: string) => {
    setContextMenu(null);
    setApplyPreset({ projectPath, projectName, entries: [], loading: true });
    try {
      const result = await loadProjectPresetWorkflows(projectPath);
      for (const err of result.errors) {
        notifyWorkflowFailure(
          t(`workflow.${DISCOVERY_ERROR_I18N_KEY[err.reason]}`, {
            defaultValue: err.reason,
          }),
          `${err.filePath}: ${err.message}`,
        );
      }
      const existingCards = cards
        .filter((card) => card.projectPath === projectPath && card.command)
        .map((card) => ({
          id: card.id,
          cwd: card.worktreePath ?? card.projectPath,
          command: card.command ?? '',
        }));
      setApplyPreset({
        projectPath,
        projectName,
        entries: classifyApplyEntries(result.workflows, existingCards, projectPath),
        loading: false,
      });
    } catch (err) {
      setApplyPreset(null);
      notifyWorkflowFailure(
        t('workflow.applyPreset', { defaultValue: 'Apply preset' }),
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const handleImportWorkflow = (projectPath: string, projectName: string) => {
    setContextMenu(null);
    if (!isTauriEnv()) {
      notifyWorkflowFailure(
        t('workflow.importWorkflow', { defaultValue: 'Import workflow from URL...' }),
        t('dialog.browseDesktopOnly'),
      );
      return;
    }
    onImportWorkflow?.(projectPath, projectName);
  };

  const confirmApplyPreset = () => {
    if (!applyPreset) return;
    let lastCreatedId: string | null = null;
    let created = 0;
    for (const entry of applyPreset.entries) {
      if (entry.state !== 'new') continue;
      const id = createCard({
        projectName: applyPreset.projectName,
        projectPath: applyPreset.projectPath,
        worktreePath:
          entry.resolvedCwd && entry.resolvedCwd !== applyPreset.projectPath
            ? entry.resolvedCwd
            : undefined,
        terminalType: workflowTerminalType(entry.workflow),
        command: entry.resolvedCommand ?? entry.workflow.command,
      });
      const intent = workflowAiIntent(entry.workflow);
      if (intent) updateCardAiIntent(id, intent);
      lastCreatedId = id;
      created += 1;
    }
    if (lastCreatedId) {
      selectProject(applyPreset.projectPath);
      focusCard(lastCreatedId);
    }
    pushNotification({
      cardId: 'system:workflows',
      kind: 'completed',
      title: t('workflow.applyPreset', { defaultValue: 'Apply preset' }),
      body: t('workflow.applyPresetCreatedCount', {
        count: created,
        defaultValue: 'Created {{count}} workflow cards.',
      }),
    });
    setApplyPreset(null);
  };

  return (
    <aside
      className={[
        'flex h-full shrink-0 flex-col etched-border-r bg-white/5 backdrop-blur-2xl transition-all duration-300 ease-in-out',
        collapsed ? 'w-14' : 'w-64',
        className,
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex h-12 items-center justify-between etched-border-b px-3">
        {onCloseMobile ? (
          <button
            type="button"
            onClick={onCloseMobile}
            className="md:hidden rounded-[var(--radius-md)] p-1 text-muted-foreground hover:bg-accent"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : null}
        {!collapsed && (
          <span className="pl-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
            {t('sidebar.projects')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          className="ml-auto rounded-[var(--radius-md)] p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* "All" pseudo-project */}
        <SidebarRow
          collapsed={collapsed}
          selected={selectedPath === null}
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t('sidebar.allTerminals')}
          count={totalCards}
          unread={totalUnread}
          onClick={() => selectProject(null)}
        />

        {groups.length > 0 && !collapsed && (
          <div className="mx-2 my-1.5 border-t border-white/10/60" />
        )}

        {groups.map((g) => (
          <SidebarRow
            key={g.path}
            collapsed={collapsed}
            selected={selectedPath === g.path}
            icon={
              selectedPath === g.path ? (
                <FolderOpen className="h-3.5 w-3.5" />
              ) : (
                <Folder className="h-3.5 w-3.5" />
              )
            }
            label={g.name}
            subLabel={g.path}
            count={g.cards.length}
            unread={g.unreadCount}
            onClick={() => selectProject(g.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                path: g.path,
                name: g.name,
              });
            }}
            onAux={(e) => handleOpenDir(g.path, e)}
            auxTitle={isTauriEnv() ? t('sidebar.openDir') : undefined}
          />
        ))}

        {groups.length === 0 && !collapsed && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t('sidebar.emptyLine1')}
            <br />
            {t('sidebar.emptyLine2')}
          </div>
        )}
      </nav>

      {contextMenu && (
        <div
          role="menu"
          className="fixed z-[230] w-52 rounded-[var(--radius-md)] border border-white/10 bg-popover p-1 text-xs shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => handleApplyPreset(contextMenu.path, contextMenu.name)}
          >
            <Play className="h-3.5 w-3.5" />
            {t('workflow.applyPreset', { defaultValue: 'Apply preset' })}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => handleImportWorkflow(contextMenu.path, contextMenu.name)}
          >
            <Download className="h-3.5 w-3.5" />
            {t('workflow.importWorkflow', {
              defaultValue: 'Import workflow from URL...',
            })}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => handleEditPreset(contextMenu.path)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('workflow.editPreset', { defaultValue: 'Edit project preset...' })}
          </button>
        </div>
      )}

      <ApplyPresetDialog
        open={applyPreset !== null}
        projectName={applyPreset?.projectName ?? ''}
        projectPath={applyPreset?.projectPath ?? ''}
        entries={applyPreset?.entries ?? []}
        loading={applyPreset?.loading ?? false}
        onCancel={() => setApplyPreset(null)}
        onApply={confirmApplyPreset}
      />

    </aside>
  );
}

interface SidebarRowProps {
  collapsed: boolean;
  selected: boolean;
  icon: ReactNode;
  label: string;
  subLabel?: string;
  count: number;
  unread: number;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  onAux?: (e: MouseEvent) => void;
  auxTitle?: string;
}

function SidebarRow({
  collapsed,
  selected,
  icon,
  label,
  subLabel,
  count,
  unread,
  onClick,
  onContextMenu,
  onAux,
  auxTitle,
}: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={collapsed ? `${label} (${count})` : undefined}
      className={[
        'group relative flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[12px] transition-colors',
        collapsed ? 'justify-center' : '',
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
      ].join(' ')}
      style={collapsed ? undefined : { marginLeft: 8, marginRight: 8, width: 'calc(100% - 16px)' }}
    >
      <div className={[
        'absolute inset-0 rounded-inherit transition-opacity duration-300',
        selected ? 'bg-primary/10 opacity-100' : 'bg-white/5 opacity-0 group-hover:opacity-100'
      ].join(' ')} />
      <span className="relative z-10 shrink-0">
        {icon}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]" />
        )}
      </span>

      {!collapsed && (
        <>
          <span className="relative z-10 flex-1 min-w-0">
            <span className={['block truncate font-semibold tracking-tight', selected ? 'text-primary' : 'text-foreground/90'].join(' ')}>{label}</span>
            {subLabel && (
              <span
                className="block truncate text-[9px] font-mono text-muted-foreground/50 mt-0.5"
                title={subLabel}
              >
                {subLabel}
              </span>
            )}
          </span>
          <span
            className={[
              'relative z-10 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold tabular-nums',
              selected ? 'bg-primary text-primary-foreground' : 'bg-white/10 text-muted-foreground',
            ].join(' ')}
          >
            {count}
          </span>
          {onAux && (
            <span
              role="button"
              tabIndex={0}
              onClick={onAux}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onAux(e as unknown as MouseEvent);
              }}
              title={auxTitle}
              className="relative z-10 opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 ml-1"
            >
              <FolderOpen className="h-3 w-3" />
            </span>
          )}
        </>
      )}
    </button>
  );
}
