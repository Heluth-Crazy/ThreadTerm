import { useEffect, useState } from 'react';
import { ScrollArea } from '../../../ui/scroll-area';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from '../../../../lib/mission-control';
import { useSessionStatusStore } from '../../../../stores/sessionStatusStore';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { SidebarView } from '../../types/types';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarRecentSessions from './SidebarRecentSessions';
import { TaskQueuePanel } from '../../../task-queue/TaskQueuePanel';
import { countActiveDurableTasks, useTaskStore } from '../../../../stores/taskStore';
import type { SessionWithProvider } from '../../types/types';

type SidebarContentProps = {
  isLoading: boolean;
  projects: Project[];
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  onOpenMissionControlSurface?: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

export default function SidebarContent({

  isLoading,
  projects,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  updateAvailable,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  onOpenMissionControlSurface,
  projectListProps,
  t,
}: SidebarContentProps) {
  const [sidebarView, setSidebarView] = useState<SidebarView>('projects');
  const hasAttention = useSessionStatusStore((s) =>
    Object.values(s.statuses).some((e) => e.status === 'needs_attention'),
  );
  const refreshTasks = useTaskStore((s) => s.refresh);
  const queuedCount = useTaskStore((s) =>
    countActiveDurableTasks(Object.values(s.tasksByProject).flatMap((tasksForProject) => tasksForProject)),
  );
  const selectedProjectPath = projectListProps.selectedProject?.fullPath || projectListProps.selectedProject?.path;

  useEffect(() => {
    if (sidebarView !== 'queue' || !selectedProjectPath) return;
    void refreshTasks(selectedProjectPath);
  }, [refreshTasks, selectedProjectPath, sidebarView]);

  const handleOpenSessionById = (targetSessionId: string) => {
    for (const project of projects) {
      const matchedClaudeSession = (project.sessions ?? []).find((session) => session.id === targetSessionId);
      if (matchedClaudeSession) {
        projectListProps.onProjectSelect(project);
        projectListProps.onSessionSelect({ ...matchedClaudeSession, __provider: 'claude' } as SessionWithProvider, project.name);
        return;
      }

      const matchedCodexSession = (project.codexSessions ?? []).find((session) => session.id === targetSessionId);
      if (matchedCodexSession) {
        projectListProps.onProjectSelect(project);
        projectListProps.onSessionSelect({ ...matchedCodexSession, __provider: 'codex' } as SessionWithProvider, project.name);
        return;
      }
    }
  };

  return (
    <div
      className="h-full flex flex-col bg-background/80 backdrop-blur-sm md:select-none"
      style={{}}
    >
      <SidebarHeader
        isLoading={isLoading}
        projectsCount={projects.length}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        onShowSettings={onShowSettings}
        t={t}
      />

      <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5 mx-2 mb-2">
        <button
          className={cn(
            'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            sidebarView === 'projects'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setSidebarView('projects')}
        >
          {t('sidebar:viewProjects')}
        </button>
        <button
          className={cn(
            'relative flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            sidebarView === 'sessions'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setSidebarView('sessions')}
        >
          {t('sidebar:viewSessions')}
          {hasAttention && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
          )}
        </button>
        <button
          className={cn(
            'relative flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            sidebarView === 'queue'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setSidebarView('queue')}
        >
          Queue
          {queuedCount > 0 && (
            <span className="ml-1 text-[10px] text-muted-foreground">({queuedCount})</span>
          )}
        </button>
      </div>

      <ScrollArea className="flex-1 md:px-1.5 md:py-2 overflow-y-auto overscroll-contain">
        {sidebarView === 'projects' ? (
          <SidebarProjectList {...projectListProps} />
        ) : sidebarView === 'sessions' ? (
          <SidebarRecentSessions
            projects={projects}
            currentSessionId={projectListProps.selectedSession?.id}
            onSessionSelect={projectListProps.onSessionSelect}
            onProjectSelect={projectListProps.onProjectSelect}
          />
        ) : (
          <TaskQueuePanel
            projectPath={projectListProps.selectedProject?.fullPath || projectListProps.selectedProject?.path}
            selectedProject={projectListProps.selectedProject ?? undefined}
            projects={projects}
            onOpenSessionById={handleOpenSessionById}
            onOpenMissionControlSurface={onOpenMissionControlSurface}
          />
        )}
      </ScrollArea>

      <SidebarFooter
        t={t}
      />
    </div>
  );
}
