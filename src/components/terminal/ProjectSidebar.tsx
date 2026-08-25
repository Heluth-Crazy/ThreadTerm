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
 * Project rows share one persisted drag order with the Workbench overview.
 * Rename and delete remain outside this intentionally small surface.
 */
import {
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  GripVertical,
  LayoutDashboard,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
  TerminalSquare,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { git, isTauriEnv, type BranchRow } from '../../lib/tauri-bridge';
import { openLocalDirectory } from '../../lib/localDirectory';
import { useTerminalStore } from '../../stores/terminalStore';
import { useProjectGroups } from './useProjectGroups';
import { clearProjectWorktreeCache } from './useProjectWorktrees';
import { clearProjectBranchCache, useProjectBranches } from './useProjectBranches';
import { pendingWorktreePath, samePath } from '../../lib/worktreePaths';
import { AttentionDot } from './AttentionDot';
import type { PrimaryView } from '../../lib/workbench/types';
import { orderProjectItems } from '../../lib/workbench/projectOrder';
import { useWorkbenchStore } from '../../stores/workbenchStore';

interface ProjectSidebarProps {
  className?: string;
  onCloseMobile?: () => void;
  /** Invoked when the "新建终端" row is clicked — opens the create-terminal dialog. */
  onCreateTerminal?: () => void;
  primaryView?: PrimaryView;
  onSelectPrimaryView?: (view: PrimaryView) => void;
  onSelectProject?: (projectPath: string | null) => void;
  onSelectWorktree?: (
    projectPath: string,
    worktreePath: string,
    label?: string | null,
  ) => void;
  attentionCount?: number;
  getProjectAttentionCount?: (projectPath: string) => number;
  getWorktreeAttentionCount?: (
    projectPath: string,
    worktreePath: string,
  ) => number;
  compact?: boolean;
  isMobile?: boolean;
  /** Invoked when the user navigates to a project row — used to exit auxiliary views. */
  onExitMobileView?: () => void;
}

type ProjectGroup = ReturnType<typeof useProjectGroups>[number];

interface SidebarRowAuxAction {
  key: string;
  title?: string;
  icon: ReactNode;
  onClick: (e: MouseEvent) => void;
}

const zeroProjectAttentionCount = (_projectPath: string): number => 0;
const zeroWorktreeAttentionCount = (
  _projectPath: string,
  _worktreePath: string,
): number => 0;

export function ProjectSidebar({
  className = '',
  onCloseMobile,
  onCreateTerminal,
  primaryView = 'workbench',
  onSelectPrimaryView = () => {},
  onSelectProject,
  onSelectWorktree,
  attentionCount = 0,
  getProjectAttentionCount = zeroProjectAttentionCount,
  getWorktreeAttentionCount = zeroWorktreeAttentionCount,
  compact = false,
  isMobile = false,
  onExitMobileView,
}: ProjectSidebarProps) {
  const { t } = useTranslation('terminal');
  const projectGroups = useProjectGroups();
  const projectOrder = useWorkbenchStore((state) => state.projectOrder);
  const reconcileProjectOrder = useWorkbenchStore(
    (state) => state.reconcileProjectOrder,
  );
  const moveProject = useWorkbenchStore((state) => state.moveProject);
  const groups = useMemo(
    () =>
      orderProjectItems(
        projectGroups,
        projectOrder,
        (group) => group.path,
        (group) => group.name,
      ),
    [projectGroups, projectOrder],
  );
  const projectPathKey = JSON.stringify(groups.map((group) => group.path));
  const projectPaths = useMemo(
    () => JSON.parse(projectPathKey) as string[],
    [projectPathKey],
  );
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
  const selectProjectIntent = onSelectProject ?? selectProject;
  const selectWorktreeIntent = onSelectWorktree ?? selectWorktree;
  const createCard = useTerminalStore((s) => s.createCard);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const pushNotification = useTerminalStore((s) => s.pushNotification);

  const [collapsed, setCollapsed] = useState(false);
  const projectListRef = useRef<HTMLElement>(null);
  const lockedProjectListScrollLeftRef = useRef<number | null>(null);
  const rail = isMobile ? false : collapsed || compact;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    reconcileProjectOrder(projectPaths);
  }, [projectPaths, reconcileProjectOrder]);

  const handleProjectDragStart = () => {
    lockedProjectListScrollLeftRef.current =
      projectListRef.current?.scrollLeft ?? null;
  };

  const handleProjectListScroll = () => {
    const lockedScrollLeft = lockedProjectListScrollLeftRef.current;
    const projectList = projectListRef.current;
    if (
      lockedScrollLeft !== null
      && projectList
      && projectList.scrollLeft !== lockedScrollLeft
    ) {
      projectList.scrollLeft = lockedScrollLeft;
    }
  };

  const releaseProjectListHorizontalScroll = () => {
    const lockedScrollLeft = lockedProjectListScrollLeftRef.current;
    const projectList = projectListRef.current;
    if (lockedScrollLeft !== null && projectList) {
      projectList.scrollLeft = lockedScrollLeft;
    }
    lockedProjectListScrollLeftRef.current = null;
  };

  const handleProjectDragEnd = ({ active, over }: DragEndEvent) => {
    releaseProjectListHorizontalScroll();
    if (!over || active.id === over.id) return;
    moveProject(String(active.id), String(over.id), projectPaths);
  };

  const handleOpenDir = (path: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!isTauriEnv()) return;
    openLocalDirectory(path).catch((err) => {
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
    selectWorktreeIntent(projectPath, worktreePath, branchLabel);
    focusCard(id);
  };

  const handleSelectWorktree = (
    projectPath: string,
    worktreePath: string,
    label?: string | null,
  ) => {
    selectWorktreeIntent(projectPath, worktreePath, label);
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
        rail ? 'w-14' : 'w-64',
        className,
      ].join(' ')}
    >
      {/* Header — logo + title */}
      <div className="flex h-12 items-center justify-between etched-border-b px-3">
        {onCloseMobile ? (
          <button
            type="button"
            onClick={onCloseMobile}
            className="md:hidden rounded-md p-1 text-muted-foreground hover:bg-accent"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : null}
        {!rail && (
          <span className="flex items-center gap-2 pl-0.5 text-xs font-semibold text-foreground">
            <img
              src="/logo.svg"
              alt="ThreadTerm"
              className="h-5 w-5 rounded-sm"
              draggable={false}
            />
            ThreadTerm
          </span>
        )}
        {!isMobile && !compact && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Primary navigation stays intentionally small: page, page, create. */}
      <div
        className="flex shrink-0 flex-col gap-1 px-2 py-3 etched-border-b"
        role="group"
        aria-label={t('sidebar.primaryNavigation', { defaultValue: 'Primary navigation' })}
      >
        <PrimaryNavigationRow
          compact={rail}
          active={primaryView === 'workbench'}
          icon={<LayoutDashboard className="h-3.5 w-3.5" />}
          label={t('sidebar.workbench', { defaultValue: 'Workbench' })}
          count={attentionCount}
          onClick={() => onSelectPrimaryView('workbench')}
        />
        <PrimaryNavigationRow
          compact={rail}
          active={primaryView === 'terminals'}
          icon={<TerminalSquare className="h-3.5 w-3.5" />}
          label={t('sidebar.allTerminals', { defaultValue: 'All terminals' })}
          count={totalCards}
          onClick={() => onSelectPrimaryView('terminals')}
        />
        <PrimaryNavigationRow
          compact={rail}
          active={false}
          icon={<Plus className="h-3.5 w-3.5" />}
          label={t('app.newTerminal', { defaultValue: 'New terminal' })}
          title={t('app.newTerminalTitle', { defaultValue: 'New terminal (⌘/Ctrl+N)' })}
          disabled={!onCreateTerminal}
          onClick={() => onCreateTerminal?.()}
        />
      </div>

      <nav
        ref={projectListRef}
        onScroll={handleProjectListScroll}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        {!rail && (
          <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
            {t('sidebar.projectFilter', { defaultValue: 'Project filter' })}
          </div>
        )}
        {/* "All" pseudo-project is a scope filter, not page navigation. */}
        <SidebarRow
          collapsed={rail}
          selected={selectedPath === null}
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t('sidebar.allProjects', { defaultValue: 'All projects' })}
          count={totalCards}
          unread={totalUnread}
          dragHandleReserved={!rail && groups.length > 0}
          onClick={() => { selectProjectIntent(null); onExitMobileView?.(); }}
        />

        {groups.length > 0 && !rail && (
          <div className="my-1.5 border-t border-border" />
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleProjectDragStart}
          onDragCancel={releaseProjectListHorizontalScroll}
          onDragEnd={handleProjectDragEnd}
        >
          <SortableContext
            items={projectPaths}
            strategy={verticalListSortingStrategy}
          >
            {groups.map((g) => (
              <ProjectBranchSection
                key={g.path}
                group={g}
                collapsed={rail}
                selected={selectedPath === g.path}
                onSelect={() => { selectProjectIntent(g.path); onExitMobileView?.(); }}
                onOpenDir={(event) => handleOpenDir(g.path, event)}
                onOpenTerminal={handleOpenWorktreeTerminal}
                onSelectWorktree={handleSelectWorktree}
                onCreateWorktreeAndOpen={handleCreateWorktreeAndOpen}
                selectedWorktreePath={selectedWorktreePath}
                attentionCount={getProjectAttentionCount(g.path)}
                getWorktreeAttentionCount={getWorktreeAttentionCount}
              />
            ))}
          </SortableContext>
        </DndContext>

        {groups.length === 0 && !rail && (
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

function PrimaryNavigationRow({
  compact,
  active,
  icon,
  label,
  count,
  title,
  disabled = false,
  onClick,
}: {
  compact: boolean;
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
      title={title ?? (compact ? label : undefined)}
      className={[
        'relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
        'focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground/15',
        'disabled:pointer-events-none disabled:opacity-50',
        compact ? 'justify-center px-2' : '',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      ].join(' ')}
    >
      {active && !compact && (
        <span
          aria-hidden="true"
          className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-primary"
        />
      )}
      <span className="shrink-0">{icon}</span>
      {!compact && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {typeof count === 'number' && (
            <span
              className={[
                'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              ].join(' ')}
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </>
      )}
      {compact && typeof count === 'number' && count > 0 && (
        <AttentionDot size="sm" className="absolute right-1 top-1" />
      )}
    </button>
  );
}

interface ProjectBranchSectionProps {
  group: ProjectGroup;
  collapsed: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpenDir: (event: MouseEvent) => void;
  selectedWorktreePath: string | null;
  attentionCount: number;
  getWorktreeAttentionCount: (
    projectPath: string,
    worktreePath: string,
  ) => number;
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
  attentionCount,
  getWorktreeAttentionCount,
}: ProjectBranchSectionProps) {
  const { t } = useTranslation('terminal');
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: group.path, disabled: collapsed });
  const { branches, loading, error, refresh } = useProjectBranches(group.path);
  const [expanded, setExpanded] = useState(false);
  const hasBranches = branches.length > 0;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.86 : undefined,
  };
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
    <div
      ref={setNodeRef}
      style={style}
      data-testid="sidebar-project-section"
      data-project-path={group.path}
      className="relative"
    >
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
        attentionCount={attentionCount}
        unread={group.unreadCount}
        dragHandleReserved={!collapsed}
        dragHandle={
          !collapsed ? (
            <span
              ref={setActivatorNodeRef}
              data-testid="sidebar-project-drag-handle"
              aria-label={t('workbench.projects.reorder', {
                project: group.name,
                defaultValue: 'Drag to reorder {{project}}',
              })}
              title={t('workbench.projects.reorder', {
                project: group.name,
                defaultValue: 'Drag to reorder {{project}}',
              })}
              onClick={(event) => event.stopPropagation()}
              className="flex h-5 w-5 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing active:bg-accent"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          ) : undefined
        }
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
          getWorktreeAttentionCount={getWorktreeAttentionCount}
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
  getWorktreeAttentionCount: (
    projectPath: string,
    worktreePath: string,
  ) => number;
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
  getWorktreeAttentionCount,
}: ProjectBranchTreeProps) {
  const { t } = useTranslation('terminal');
  const [showAll, setShowAll] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState<string | null>(null);
  const visibleBranches = visibleBranchRows(branches, showAll);
  const hiddenCount = branches.length - visibleBranches.length;

  return (
    <div className="mb-1 ml-4 border-l border-border/60 pl-2">
      {error && (
        <div className="px-2 py-1 text-[11px] text-destructive">
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
          const branchAttentionCount = worktreePath
            ? getWorktreeAttentionCount(projectPath, worktreePath)
            : 0;
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
                'group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent',
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
                  <span className={['block truncate text-[11px]', detailClass].join(' ')}>
                    {detail}
                  </span>
                )}
              </span>
              {branchAttentionCount > 0 && (
                <span
                  data-testid="sidebar-worktree-attention-count"
                  title={t('sidebar.attentionCount', {
                    count: branchAttentionCount,
                    defaultValue: '{{count}} items need attention',
                  })}
                  className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-warning"
                >
                  {branchAttentionCount > 99 ? '99+' : branchAttentionCount}
                </span>
              )}
              {branch.isCurrent && (
                <span
                  aria-label={t('sidebar.currentBranch', { defaultValue: 'Current branch' })}
                  title={t('sidebar.currentBranch', { defaultValue: 'Current branch' })}
                  className="mr-0.5 shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[11px] font-medium leading-none text-primary"
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
            className="w-full rounded-md px-2 py-1 text-center text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
  attentionCount?: number;
  unread: number;
  dragHandle?: ReactNode;
  dragHandleReserved?: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  auxActions?: SidebarRowAuxAction[];
  hasChildren?: boolean;
  expanded?: boolean;
  toggleTitle?: string;
  onToggle?: (e: MouseEvent) => void;
}

const SidebarRow = memo(function SidebarRow({
  collapsed,
  selected,
  icon,
  label,
  subLabel,
  count,
  attentionCount = 0,
  unread,
  dragHandle,
  dragHandleReserved = false,
  onClick,
  onContextMenu,
  auxActions = [],
  hasChildren = false,
  expanded = false,
  toggleTitle,
  onToggle,
}: SidebarRowProps) {
  const { t } = useTranslation('terminal');
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={
        collapsed
          ? `${label} (${count})${
              attentionCount > 0 ? ` · ${attentionCount}` : ''
            }`
          : subLabel || label
      }
      className={[
        'group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
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
        {(unread > 0 || attentionCount > 0) && (
          <AttentionDot size="sm" className="absolute -right-1 -top-1" />
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
          {attentionCount > 0 && (
            <span
              data-testid="sidebar-project-attention-count"
              title={t('sidebar.attentionCount', {
                count: attentionCount,
                defaultValue: '{{count}} items need attention',
              })}
              className={[
                'shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-warning transition-opacity',
                auxActions.length > 0 ? 'group-hover:opacity-0' : '',
              ].join(' ')}
            >
              {attentionCount > 99 ? '99+' : attentionCount}
            </span>
          )}
          {/* A fixed drag column follows the count, so count edges still align
              across sortable rows and the non-sortable "All projects" row. */}
          <span
            className={[
              'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums transition-opacity',
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
            <span
              className={[
                'absolute top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100',
                dragHandleReserved ? 'right-8' : 'right-2',
              ].join(' ')}
            >
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
          {dragHandleReserved &&
            (dragHandle ?? (
              <span aria-hidden="true" className="h-5 w-5 shrink-0" />
            ))}
        </>
      )}
    </button>
  );
}, areSidebarRowPropsEqual);

function areSidebarRowPropsEqual(prev: SidebarRowProps, next: SidebarRowProps): boolean {
  return (
    prev.collapsed === next.collapsed &&
    prev.selected === next.selected &&
    prev.label === next.label &&
    prev.subLabel === next.subLabel &&
    prev.count === next.count &&
    prev.attentionCount === next.attentionCount &&
    prev.unread === next.unread &&
    prev.dragHandleReserved === next.dragHandleReserved &&
    prev.dragHandle === next.dragHandle &&
    prev.hasChildren === next.hasChildren &&
    prev.expanded === next.expanded &&
    prev.toggleTitle === next.toggleTitle &&
    renderIconsEqual(prev.icon, next.icon) &&
    auxActionsEqual(prev.auxActions, next.auxActions)
  );
}

function renderIconsEqual(prev: ReactNode, next: ReactNode): boolean {
  if (prev === next) return true;
  if (!isValidElement(prev) || !isValidElement(next)) return false;
  const prevProps = prev.props as { className?: string };
  const nextProps = next.props as { className?: string };
  return (
    prev.type === next.type &&
    prev.key === next.key &&
    prevProps.className === nextProps.className
  );
}

function auxActionsEqual(
  prev: SidebarRowAuxAction[] | undefined,
  next: SidebarRowAuxAction[] | undefined,
): boolean {
  const prevActions = prev ?? [];
  const nextActions = next ?? [];
  if (prevActions.length !== nextActions.length) return false;
  return prevActions.every((action, index) => {
    const nextAction = nextActions[index];
    return (
      action.key === nextAction.key &&
      action.title === nextAction.title &&
      renderIconsEqual(action.icon, nextAction.icon)
    );
  });
}
