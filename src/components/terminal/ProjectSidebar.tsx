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
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Smartphone,
  Terminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { git, isTauriEnv, type BranchRow } from '../../lib/tauri-bridge';
import { openLocalDirectory } from '../../lib/localDirectory';
import { useTerminalStore } from '../../stores/terminalStore';
import { useProjectGroups } from './useProjectGroups';
import { clearProjectWorktreeCache } from './useProjectWorktrees';
import { clearProjectBranchCache, useProjectBranches } from './useProjectBranches';
import { pendingWorktreePath, samePath } from '../../lib/worktreePaths';

interface ProjectSidebarProps {
  className?: string;
  onCloseMobile?: () => void;
  /** Invoked when the "新建终端" row is clicked — opens the create-terminal dialog. */
  onCreateTerminal?: () => void;
  /** Invoked when the "移动端" row is clicked — shows the mobile access view. */
  onOpenMobileAccess?: () => void;
  /** When true, the "移动端" row is rendered as the active selection. */
  mobileViewActive?: boolean;
  /** Invoked when the user navigates to a project row — used to exit the mobile view. */
  onExitMobileView?: () => void;
}

type ProjectGroup = ReturnType<typeof useProjectGroups>[number];

interface SidebarRowAuxAction {
  key: string;
  title?: string;
  icon: ReactNode;
  onClick: (e: MouseEvent) => void;
}

export function ProjectSidebar({
  className = '',
  onCloseMobile,
  onCreateTerminal,
  onOpenMobileAccess,
  mobileViewActive = false,
  onExitMobileView,
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
  const selectedWorktreePath = useTerminalStore((s) => s.selectedWorktreePath);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const selectWorktree = useTerminalStore((s) => s.selectWorktree);
  const createCard = useTerminalStore((s) => s.createCard);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const pushNotification = useTerminalStore((s) => s.pushNotification);

  const [collapsed, setCollapsed] = useState(false);

  const handleOpenDir = (path: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!isTauriEnv()) return;
    openLocalDirectory(path).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[ProjectSidebar] open dir failed:', err);
    });
  };

  const handleOpenWorktreeTerminal = (
    projectPath: string,
    projectName: string,
    worktreePath: string,
    branchLabel?: string,
  ) => {
    const id = createCard({
      projectName,
      projectPath,
      worktreePath,
      branchLabel,
      terminalType: 'shell',
    });
    selectWorktree(projectPath, worktreePath, branchLabel);
    focusCard(id);
  };

  const handleSelectWorktree = (
    projectPath: string,
    worktreePath: string,
    label?: string | null,
  ) => {
    selectWorktree(projectPath, worktreePath, label);
  };

  const handleCreateWorktreeAndOpen = async (
    projectPath: string,
    projectName: string,
    branch: string,
    refreshBranches: () => Promise<void>,
  ) => {
    try {
      const worktree = await git.worktrees.add(projectPath, branch);
      clearProjectBranchCache();
      clearProjectWorktreeCache();
      await refreshBranches();
      handleOpenWorktreeTerminal(projectPath, projectName, worktree.path, branch);
      pushNotification({
        cardId: 'system:worktrees',
        kind: 'completed',
        title: t('sidebar.createWorktree', {
          defaultValue: 'Create worktree and open terminal',
        }),
        body: t('sidebar.worktreeCreated', {
          path: worktree.path,
          defaultValue: 'Created worktree {{path}}.',
        }),
      });
    } catch (err) {
      pushNotification({
        cardId: 'system:worktrees',
        kind: 'failed',
        title: t('sidebar.worktreeCreateFailed', {
          defaultValue: 'Failed to create worktree',
        }),
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  return (
    <aside
      className={[
        'flex h-full shrink-0 flex-col etched-border-r bg-background/80 backdrop-blur-2xl transition-all duration-300 ease-in-out',
        collapsed ? 'w-14' : 'w-64',
        className,
      ].join(' ')}
    >
      {/* Header — logo + title */}
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
          <span className="flex items-center gap-2 pl-0.5 text-xs font-semibold text-foreground">
            <img
              src="/logo.svg"
              alt="ThreadTerm"
              className="h-5 w-5 rounded-[6px]"
              draggable={false}
            />
            ThreadTerm
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

      {/* Create-area — 新建终端 / 移动端 rows (occupies ~1/3 of the sidebar body). */}
      <div
        className="flex flex-col justify-start gap-2 px-3 py-4 etched-border-b"
        role="group"
        aria-label={t('sidebar.projects', { defaultValue: 'Projects' })}
        style={{ flex: '1 1 0%' }}
      >
        <button
          type="button"
          onClick={onCreateTerminal}
          disabled={!onCreateTerminal}
          title={t('app.newTerminalTitle', { defaultValue: 'New terminal (⌘/Ctrl+N)' })}
          className={[
            'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-left text-xs leading-[1.35] font-medium transition-colors',
            'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            'focus-visible:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground/15',
            'disabled:opacity-50 disabled:pointer-events-none',
            collapsed ? 'justify-center' : '',
          ].join(' ')}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          {!collapsed && <span>{t('app.newTerminal', { defaultValue: 'New terminal' })}</span>}
        </button>
        <button
          type="button"
          onClick={onOpenMobileAccess}
          disabled={!onOpenMobileAccess}
          title={t('sidebar.mobileAccess', { defaultValue: 'Mobile' })}
          className={[
            'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-left text-xs leading-[1.35] font-medium transition-colors',
            mobileViewActive
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            'focus-visible:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground/15',
            'disabled:opacity-50 disabled:pointer-events-none',
            collapsed ? 'justify-center' : '',
          ].join(' ')}
        >
          <Smartphone className="h-3.5 w-3.5 shrink-0" />
          {!collapsed && <span>{t('sidebar.mobileAccess', { defaultValue: 'Mobile' })}</span>}
        </button>
      </div>

      <nav className="min-h-0 px-2 py-1.5 overflow-y-auto" style={{ flex: '2 1 0%' }}>
        {/* "All" pseudo-project (now labelled "项目" / Projects) */}
        <SidebarRow
          collapsed={collapsed}
          selected={selectedPath === null && !mobileViewActive}
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t('sidebar.projects')}
          count={totalCards}
          unread={totalUnread}
          onClick={() => { selectProject(null); onExitMobileView?.(); }}
        />

        {groups.length > 0 && !collapsed && (
          <div className="my-1.5 border-t border-border" />
        )}

        {groups.map((g) => (
          <ProjectBranchSection
            key={g.path}
            group={g}
            collapsed={collapsed}
            selected={selectedPath === g.path}
            onSelect={() => { selectProject(g.path); onExitMobileView?.(); }}
            onOpenDir={(event) => handleOpenDir(g.path, event)}
            onOpenTerminal={handleOpenWorktreeTerminal}
            onSelectWorktree={handleSelectWorktree}
            onCreateWorktreeAndOpen={handleCreateWorktreeAndOpen}
            selectedWorktreePath={selectedWorktreePath}
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

    </aside>
  );
}

interface ProjectBranchSectionProps {
  group: ProjectGroup;
  collapsed: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpenDir: (event: MouseEvent) => void;
  selectedWorktreePath: string | null;
  onOpenTerminal: (
    projectPath: string,
    projectName: string,
    worktreePath: string,
    branchLabel?: string,
  ) => void;
  onSelectWorktree: (projectPath: string, worktreePath: string, label?: string | null) => void;
  onCreateWorktreeAndOpen: (
    projectPath: string,
    projectName: string,
    branch: string,
    refreshBranches: () => Promise<void>,
  ) => Promise<void>;
}

function ProjectBranchSection({
  group,
  collapsed,
  selected,
  onSelect,
  onOpenDir,
  selectedWorktreePath,
  onOpenTerminal,
  onSelectWorktree,
  onCreateWorktreeAndOpen,
}: ProjectBranchSectionProps) {
  const { t } = useTranslation('terminal');
  const { branches, loading, error, refresh } = useProjectBranches(group.path);
  const [expanded, setExpanded] = useState(false);
  const hasBranches = branches.length > 0;
  const auxActions: SidebarRowAuxAction[] = [
    ...(isTauriEnv()
      ? [
          {
            key: 'open-dir',
            title: t('sidebar.openDir'),
            icon: <FolderOpen className="h-3 w-3" />,
            onClick: onOpenDir,
          },
        ]
      : []),
    ...(hasBranches
      ? [
          {
            key: 'refresh-branches',
            title: t('sidebar.refreshWorktrees'),
            icon: loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            ),
            onClick: (event: MouseEvent) => {
              event.stopPropagation();
              void refresh();
            },
          },
        ]
      : []),
  ];

  return (
    <div>
      <SidebarRow
        collapsed={collapsed}
        selected={selected}
        icon={
          selected ? (
            <FolderOpen className="h-3.5 w-3.5" />
          ) : (
            <Folder className="h-3.5 w-3.5" />
          )
        }
        label={group.name}
        subLabel={group.path}
        count={group.cards.length}
        unread={group.unreadCount}
        onClick={onSelect}
        auxActions={auxActions}
        hasChildren={hasBranches}
        expanded={expanded}
        toggleTitle={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
        onToggle={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
      />
      {!collapsed && hasBranches && expanded && (
        <ProjectBranchTree
          projectPath={group.path}
          projectName={group.name}
          branches={branches}
          error={error}
          refresh={refresh}
          selectedWorktreePath={selectedWorktreePath}
          onOpenTerminal={onOpenTerminal}
          onSelectWorktree={onSelectWorktree}
          onCreateWorktreeAndOpen={onCreateWorktreeAndOpen}
        />
      )}
    </div>
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || path;
}

function shortHead(head: string): string {
  return head ? head.slice(0, 7) : '';
}

const MAX_COLLAPSED_BRANCHES = 8;

interface ProjectBranchTreeProps {
  projectPath: string;
  projectName: string;
  branches: BranchRow[];
  error: string | null;
  refresh: () => Promise<void>;
  selectedWorktreePath: string | null;
  onOpenTerminal: (
    projectPath: string,
    projectName: string,
    worktreePath: string,
    branchLabel?: string,
  ) => void;
  onSelectWorktree: (projectPath: string, worktreePath: string, label?: string | null) => void;
  onCreateWorktreeAndOpen: (
    projectPath: string,
    projectName: string,
    branch: string,
    refreshBranches: () => Promise<void>,
  ) => Promise<void>;
}

function visibleBranchRows(branches: BranchRow[], showAll: boolean): BranchRow[] {
  if (showAll || branches.length <= MAX_COLLAPSED_BRANCHES) return branches;
  const pinned = branches.filter((row) => row.isCurrent || row.worktreePath);
  const pinnedBranches = new Set(pinned.map((row) => row.branch));
  const rest = branches.filter((row) => !pinnedBranches.has(row.branch));
  const restLimit = Math.max(0, MAX_COLLAPSED_BRANCHES - pinned.length);
  return [...pinned, ...rest.slice(0, restLimit)];
}

function ProjectBranchTree({
  projectPath,
  projectName,
  branches,
  error,
  refresh,
  selectedWorktreePath,
  onOpenTerminal,
  onSelectWorktree,
  onCreateWorktreeAndOpen,
}: ProjectBranchTreeProps) {
  const { t } = useTranslation('terminal');
  const [showAll, setShowAll] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState<string | null>(null);
  const visibleBranches = visibleBranchRows(branches, showAll);
  const hiddenCount = branches.length - visibleBranches.length;

  return (
    <div className="mb-1 ml-4 border-l border-border/60 pl-2">
      {error && (
        <div className="px-2 py-1 text-[10px] text-red-500">
          {error}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleBranches.map((branch) => {
          const worktreePath = branch.worktreePath ?? '';
          const targetWorktreePath =
            worktreePath || pendingWorktreePath(projectPath, branch.branch);
          const isSelected = selectedWorktreePath
            ? worktreePath
              ? samePath(selectedWorktreePath, worktreePath)
              : selectedWorktreePath === targetWorktreePath
            : false;
          const isCreating = creatingBranch === branch.branch;
          const detail = worktreePath
            ? basename(worktreePath)
            : branch.upstream || shortHead(branch.head);
          const branchIconClass = branch.isCurrent
            ? 'text-primary'
            : worktreePath
              ? 'text-foreground/70'
              : 'text-muted-foreground/50';
          const branchTextClass = branch.isCurrent
            ? 'text-primary'
            : worktreePath
              ? 'text-foreground/90'
              : 'text-foreground/70';
          const detailClass = branch.isCurrent
            ? 'text-primary/70'
            : 'text-muted-foreground';
          const runBranchAction = async (event: MouseEvent | KeyboardEvent) => {
            event.stopPropagation();
            if (isCreating) return;
            if (worktreePath) {
              onOpenTerminal(projectPath, projectName, worktreePath, branch.branch);
              return;
            }
            setCreatingBranch(branch.branch);
            try {
              await onCreateWorktreeAndOpen(
                projectPath,
                projectName,
                branch.branch,
                refresh,
              );
            } catch {
              // The parent handler already emits the failure notification.
            } finally {
              setCreatingBranch(null);
            }
          };
          return (
            <button
              key={branch.branch}
              type="button"
              title={
                worktreePath
                  ? `${branch.branch} — ${worktreePath}`
                  : branch.branch
              }
              onClick={() => onSelectWorktree(projectPath, targetWorktreePath, branch.branch)}
              className={[
                'group relative flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                isSelected ? 'bg-primary/10 text-primary' : branchTextClass,
              ].join(' ')}
            >
              {isSelected && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
                />
              )}
              <span className={['shrink-0 group-hover:text-primary', branchIconClass].join(' ')}>
                <GitBranch className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{branch.branch}</span>
                {detail && (
                  <span className={['block truncate text-[10px]', detailClass].join(' ')}>
                    {detail}
                  </span>
                )}
              </span>
              {branch.isCurrent && (
                <span
                  aria-label={t('sidebar.currentBranch', { defaultValue: 'Current branch' })}
                  title={t('sidebar.currentBranch', { defaultValue: 'Current branch' })}
                  className="mr-0.5 shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] font-medium leading-none text-primary"
                >
                  {t('sidebar.currentShort', { defaultValue: 'Current' })}
                </span>
              )}
              {isCreating ? (
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                  aria-label={t('sidebar.creatingWorktree', {
                    defaultValue: 'Creating worktree...',
                  })}
                />
              ) : worktreePath ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t('sidebar.openWorktreeTerminal')}
                  title={t('sidebar.openWorktreeTerminal')}
                  onClick={runBranchAction}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void runBranchAction(event);
                    }
                  }}
                  className="shrink-0 text-muted-foreground opacity-60 transition-opacity hover:text-primary group-hover:opacity-100"
                >
                  <Terminal className="h-3.5 w-3.5" />
                </span>
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t('sidebar.createWorktree', {
                    defaultValue: 'Create worktree and open terminal',
                  })}
                  title={t('sidebar.createWorktree', {
                    defaultValue: 'Create worktree and open terminal',
                  })}
                  onClick={runBranchAction}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void runBranchAction(event);
                    }
                  }}
                  className="shrink-0 text-muted-foreground opacity-60 transition-opacity hover:text-primary group-hover:opacity-100"
                >
                  <Plus className="h-3.5 w-3.5" />
                </span>
              )}
            </button>
          );
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full rounded-[var(--radius-md)] px-2 py-1 text-center text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {t('sidebar.showAllBranches', {
              count: branches.length,
              defaultValue: 'Show all {{count}} branches',
            })}
          </button>
        )}
      </div>
    </div>
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
  auxActions?: SidebarRowAuxAction[];
  hasChildren?: boolean;
  expanded?: boolean;
  toggleTitle?: string;
  onToggle?: (e: MouseEvent) => void;
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
  auxActions = [],
  hasChildren = false,
  expanded = false,
  toggleTitle,
  onToggle,
}: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={collapsed ? `${label} (${count})` : subLabel || label}
      className={[
        'group relative flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[13px] transition-colors',
        collapsed ? 'justify-center' : '',
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
      ].join(' ')}
    >
      {/* Active indicator — left accent bar (Finder/VSCode style). */}
      {selected && !collapsed && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
        />
      )}
      {!collapsed && (
        <span
          data-testid="sidebar-disclosure-column"
          className="flex h-full w-4 shrink-0 items-center justify-center"
        >
          {hasChildren && onToggle ? (
            <span
              role="button"
              tabIndex={0}
              data-testid="sidebar-disclosure-toggle"
              onClick={onToggle}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(e as unknown as MouseEvent);
                }
              }}
              title={toggleTitle}
              className="flex h-5 w-4 items-center justify-center text-muted-foreground hover:text-primary"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </span>
          ) : (
            <span
              aria-hidden="true"
              data-testid="sidebar-disclosure-placeholder"
              className="h-5 w-4"
            />
          )}
        </span>
      )}
      <span className="relative shrink-0">
        {icon}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]" />
        )}
      </span>

      {!collapsed && (
        <>
          {/* Single-line label; full path lives in the button `title` tooltip
              so the row height stays constant (no layout shift on hover). */}
          <span
            className={[
              'min-w-0 flex-1 truncate font-semibold tracking-tight',
              selected ? 'text-primary' : 'text-foreground/90',
            ].join(' ')}
          >
            {label}
          </span>
          {/* Count badge stays last in the flex flow, so its right edge aligns
              across every row regardless of how many aux actions a row has. */}
          <span
            className={[
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-opacity',
              auxActions.length > 0 ? 'group-hover:opacity-0' : '',
              selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            ].join(' ')}
          >
            {count}
          </span>
          {/* Hover actions float over the row's right edge instead of occupying
              flow width — otherwise their (invisible) boxes would push the count
              badge left by a per-row-variable amount and misalign it. On hover
              the badge fades out and these fade in, so they never overlap. */}
          {auxActions.length > 0 && (
            <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              {auxActions.map((action) => (
                <span
                  key={action.key}
                  role="button"
                  tabIndex={0}
                  onClick={action.onClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      action.onClick(e as unknown as MouseEvent);
                    }
                  }}
                  title={action.title}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-primary"
                >
                  {action.icon}
                </span>
              ))}
            </span>
          )}
        </>
      )}
    </button>
  );
}
