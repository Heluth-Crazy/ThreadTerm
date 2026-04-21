import type { TFunction } from 'i18next';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../lib/tauri-bridge';
import type { Project } from '../../../../types/app';
import SidebarContent from './SidebarContent';

const storeState = vi.hoisted(() => ({
  sessionStatus: {
    statuses: {} as Record<string, { status: 'idle' | 'processing' | 'needs_attention' | 'completed' }>,
  },
  taskStore: {
    tasksByProject: {} as Record<string, Task[]>,
    refresh: vi.fn(async () => []),
  },
}));

vi.mock('../../../ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('./SidebarFooter', () => ({
  default: () => <div>SidebarFooter</div>,
}));

vi.mock('./SidebarHeader', () => ({
  default: () => <div>SidebarHeader</div>,
}));

vi.mock('./SidebarProjectList', () => ({
  default: () => <div>SidebarProjectList</div>,
}));

vi.mock('./SidebarRecentSessions', () => ({
  default: () => <div>SidebarRecentSessions</div>,
}));

vi.mock('../../../task-queue/TaskQueuePanel', () => ({
  TaskQueuePanel: ({
    projectPath,
    onOpenMissionControlSurface,
  }: {
    projectPath?: string;
    onOpenMissionControlSurface?: (target: string, locator?: { taskId?: string }) => void;
  }) => (
    <div>
      <div>TaskQueuePanel:{projectPath ?? 'none'}</div>
      <button
        type="button"
        onClick={() => onOpenMissionControlSurface?.('review-queue', { taskId: 'task-review-1' })}
      >
        TaskQueuePanel open review
      </button>
    </div>
  ),
}));

vi.mock('../../../../stores/sessionStatusStore', () => ({
  useSessionStatusStore: (selector: (state: typeof storeState.sessionStatus) => unknown) =>
    selector(storeState.sessionStatus),
}));

vi.mock('../../../../stores/taskStore', () => ({
  countActiveDurableTasks: (tasks: Task[]) => tasks.filter((task) => ['open', 'queued', 'dispatched', 'in_progress', 'pending_approval', 'pending_review'].includes(task.status)).length,
  useTaskStore: (selector: (state: typeof storeState.taskStore) => unknown) =>
    selector(storeState.taskStore),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'repo-a',
    displayName: 'Repo A',
    fullPath: '/repo-a',
    sessions: [],
    codexSessions: [],
    ...overrides,
  };
}

function makeProjectListProps(selectedProject: Project | null) {
  return {
    projects: selectedProject ? [selectedProject] : [],
    filteredProjects: selectedProject ? [selectedProject] : [],
    selectedProject,
    selectedSession: null,
    isLoading: false,
    loadingProgress: null,
    expandedProjects: new Set<string>(),
    editingProject: null,
    editingName: '',
    loadingSessions: {},
    initialSessionsLoaded: new Set<string>(),
    currentTime: new Date('2026-04-21T00:00:00.000Z'),
    editingSession: null,
    editingSessionName: '',
    deletingProjects: new Set<string>(),
    getProjectSessions: () => [],
    isProjectStarred: () => false,
    onEditingNameChange: vi.fn(),
    onToggleProject: vi.fn(),
    onProjectSelect: vi.fn(),
    onToggleStarProject: vi.fn(),
    onStartEditingProject: vi.fn(),
    onCancelEditingProject: vi.fn(),
    onSaveProjectName: vi.fn(),
    onDeleteProject: vi.fn(),
    onCreateBranchWorkspace: vi.fn(),
    onSessionSelect: vi.fn(),
    onDeleteSession: vi.fn(),
    onLoadMoreSessions: vi.fn(),
    onNewSession: vi.fn(),
    onEditingSessionNameChange: vi.fn(),
    onStartEditingSession: vi.fn(),
    onCancelEditingSession: vi.fn(),
    onSaveEditingSession: vi.fn(),
    t: ((key: string) => key) as unknown as TFunction,
  };
}

describe('SidebarContent', () => {
  beforeEach(() => {
    storeState.sessionStatus.statuses = {};
    storeState.taskStore.tasksByProject = {};
    storeState.taskStore.refresh.mockClear();
  });

  it('shows the queue tab count from durable task status and refreshes taskStore when opening queue view', async () => {
    const project = makeProject();
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        { id: 'task-open', status: 'open', project_path: '/repo-a' } as Task,
        { id: 'task-running', status: 'in_progress', project_path: '/repo-a' } as Task,
        { id: 'task-done', status: 'done', project_path: '/repo-a' } as Task,
      ],
    };

    render(
      <SidebarContent
        isLoading={false}
        projects={[project]}
        searchFilter=""
        onSearchFilterChange={vi.fn()}
        onClearSearchFilter={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
        onCreateProject={vi.fn()}
        onCollapseSidebar={vi.fn()}
        updateAvailable={false}
        releaseInfo={null}
        latestVersion={null}
        onShowVersionModal={vi.fn()}
        onShowSettings={vi.fn()}
        projectListProps={makeProjectListProps(project)}
        t={((key: string) => ({
          'sidebar:viewProjects': 'Projects',
          'sidebar:viewSessions': 'Sessions',
        }[key] ?? key)) as unknown as TFunction}
      />,
    );

    const queueButton = screen.getByRole('button', { name: 'Queue (2)' });
    expect(queueButton).toHaveTextContent('Queue(2)');

    fireEvent.click(queueButton);

    await waitFor(() => {
      expect(storeState.taskStore.refresh).toHaveBeenCalledWith('/repo-a');
    });
    expect(screen.getByText('TaskQueuePanel:/repo-a')).toBeInTheDocument();
  });

  it('passes Mission Control surface routing through to the sidebar queue view', () => {
    const onOpenMissionControlSurface = vi.fn();
    const project = makeProject();

    render(
      <SidebarContent
        isLoading={false}
        projects={[project]}
        searchFilter=""
        onSearchFilterChange={vi.fn()}
        onClearSearchFilter={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
        onCreateProject={vi.fn()}
        onCollapseSidebar={vi.fn()}
        updateAvailable={false}
        releaseInfo={null}
        latestVersion={null}
        onShowVersionModal={vi.fn()}
        onShowSettings={vi.fn()}
        onOpenMissionControlSurface={onOpenMissionControlSurface}
        projectListProps={makeProjectListProps(project)}
        t={((key: string) => ({
          'sidebar:viewProjects': 'Projects',
          'sidebar:viewSessions': 'Sessions',
        }[key] ?? key)) as unknown as TFunction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'TaskQueuePanel open review' }));

    expect(onOpenMissionControlSurface).toHaveBeenCalledWith('review-queue', { taskId: 'task-review-1' });
  });
});
