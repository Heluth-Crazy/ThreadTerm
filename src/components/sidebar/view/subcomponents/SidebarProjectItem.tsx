import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderTree, Star } from 'lucide-react';
import type { TFunction } from 'i18next';
import { formatTimeAgo } from '../../../../utils/dateUtils';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, SessionLaunchOptions, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import {
  getProjectDisplayLabel,
  getProjectLastActivityMs,
  getProjectPath,
  getProjectSessionCounts,
} from '../../../workbench/projects/projectOverviewModels';
import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  worktreeCount: number;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onCreateBranchWorkspace: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project, provider?: string, launchOptions?: SessionLaunchOptions) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string) => void;
  t: TFunction;
};

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-border/60 bg-background/95 px-2 py-1.5">
      <div
        className="truncate text-[9px] font-semibold uppercase tracking-[0.08em] leading-3 text-muted-foreground"
        title={label}
      >
        {label}
      </div>
      <div className="mt-0.5 text-[12px] font-medium text-foreground">{value}</div>
    </div>
  );
}

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  sessions,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  editingSession,
  editingSessionName,
  worktreeCount,
  onToggleProject,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPrimaryFocused, setIsPrimaryFocused] = useState(false);
  const isSelected = selectedProject?.name === project.name;
  const counts = getProjectSessionCounts(project);
  const lastActivityMs = getProjectLastActivityMs(project);
  const showPreview = isHovered || isPrimaryFocused || isExpanded;

  return (
    <div
      className={cn('space-y-1', isDeleting && 'pointer-events-none opacity-50')}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={cn(
          'rounded-[18px] border border-transparent bg-transparent transition-colors',
          isSelected && 'border-border/60 bg-muted/35',
        )}
      >
        <div className="flex items-center gap-1.5 px-1.5 py-1">
          <button
            type="button"
            onClick={() => onProjectSelect(project)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[14px] px-1.5 py-[5px] text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            onFocus={() => setIsPrimaryFocused(true)}
            onBlur={() => setIsPrimaryFocused(false)}
          >
            <div className={cn('flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[14px]', isSelected ? 'bg-foreground text-background' : 'bg-muted text-foreground')}>
              {project.isGitWorktree ? <FolderTree className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="truncate text-[13px] font-medium leading-5 text-foreground">{getProjectDisplayLabel(project)}</div>
                {isStarred ? <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-yellow-500" /> : null}
              </div>
              <div className="truncate text-[11px] leading-[1.15rem] text-muted-foreground">{getProjectPath(project)}</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onToggleProject(project.name)}
            className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[14px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            aria-label={isExpanded ? t('actions.collapse', { defaultValue: '折叠' }) : t('actions.expand', { defaultValue: '展开' })}
          >
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </div>

        {showPreview ? (
          <div className="mx-1.5 mb-1.5 rounded-[18px] border border-border/60 bg-card/75 p-2.5 shadow-sm">
            <div className="grid grid-cols-2 gap-1.5">
              <MiniStat label="Claude" value={String(counts.claudeCount)} />
              <MiniStat label="Codex" value={String(counts.codexCount)} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              {project.isGitWorktree ? (
                <span className="rounded-full border border-border/60 bg-background px-2 py-[3px]">
                  {t('workbench.projectOverview.worktreeBadge', { defaultValue: 'Worktree' })}
                </span>
              ) : null}
              {worktreeCount > 0 ? (
                <span className="truncate" title={t('workbench.projectOverview.stats.worktrees', { defaultValue: 'Worktrees' })}>
                  {t('workbench.projectOverview.stats.worktrees', { defaultValue: 'Worktrees' })}: {worktreeCount}
                </span>
              ) : null}
              <span>
                {lastActivityMs > 0
                  ? formatTimeAgo(new Date(lastActivityMs).toISOString(), currentTime, t)
                  : t('workbench.overview.noRecentActivity')}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        isLoadingSessions={isLoadingSessions}
        currentTime={currentTime}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}
