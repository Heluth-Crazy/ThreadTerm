import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderKanban,
  FolderTree,
  GitBranch,
  PencilLine,
  Plus,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTimeAgo } from '../../../utils/dateUtils';
import { projects as tauriProjects } from '../../../lib/tauri-bridge';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { loadStarredProjects, persistStarredProjects } from '../../sidebar/utils/utils';
import {
  getProjectDisplayLabel,
  getProjectLastActivityMs,
  getProjectLastUsedSession,
  getProjectPath,
  getProjectSessionRecords,
  getProjectSessionCounts,
  getProjectWorktreeContext,
  type ProjectOverviewSessionRecord,
} from './projectOverviewModels';
import { useProjectOverviewState } from './useProjectOverviewState';
import { SessionStatusBadge } from '../../shared/SessionStatusBadge';

type SelectedProjectOverviewPageProps = {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onSelectSession: (session: ProjectSession) => void;
  onNewSession: (project: Project, provider?: string) => void;
  onCreateProject: () => void;
  onRefreshProjects: () => Promise<void>;
  onDeleteSession: (projectName: string, sessionId: string, provider: SessionProvider) => void;
  onDeleteProjectState: (projectName: string) => void;
  onSelectOverview: () => void;
};

function ProviderBadge({ provider }: { provider: SessionProvider }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-[0.06em] uppercase',
        provider === 'claude'
          ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
    >
      {provider === 'claude' ? 'Claude' : 'Codex'}
    </span>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[18px] border border-border/60 bg-background/90 px-3 py-2.5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[1.15rem] font-semibold tracking-tight text-foreground">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[20px] border border-border/60 bg-card/72 p-3.5 shadow-sm">
      <div className="mb-2.5 flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SessionRow({
  record,
  currentTime,
  isManaging,
  isSelected,
  onToggleSelect,
  onOpen,
  timeLabel,
}: {
  record: ProjectOverviewSessionRecord;
  currentTime: Date;
  isManaging: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  timeLabel: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-[18px] border border-border/60 bg-background/95 px-2.5 py-2 transition-colors hover:bg-muted/35">
      {isManaging ? (
        <label className="mt-0.5 flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/60 bg-card">
          <input type="checkbox" checked={isSelected} onChange={onToggleSelect} className="h-3.5 w-3.5" />
        </label>
      ) : (
        <div className="mt-0.5 flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[14px] bg-muted text-muted-foreground">
          <Clock3 className="h-4 w-4" />
        </div>
      )}

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus:outline-none">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-5 text-foreground">{record.label}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <ProviderBadge provider={record.provider} />
              <SessionStatusBadge sessionId={record.session.id} />
              <span>{timeLabel}</span>
            </div>
          </div>
          <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        </div>
      </button>
    </div>
  );
}

export default function SelectedProjectOverviewPage({
  projects,
  selectedProject,
  onSelectProject,
  onSelectSession,
  onNewSession,
  onCreateProject,
  onRefreshProjects,
  onDeleteSession,
  onDeleteProjectState,
  onSelectOverview,
}: SelectedProjectOverviewPageProps) {
  const { t } = useTranslation('sidebar');
  const [starredProjects, setStarredProjects] = useState<Set<string>>(() => loadStarredProjects());
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [projectDeletePending, setProjectDeletePending] = useState(false);
  const currentTime = new Date();
  const overviewState = useProjectOverviewState();

  const counts = useMemo(
    () => (selectedProject ? getProjectSessionCounts(selectedProject) : { claudeCount: 0, codexCount: 0, totalCount: 0 }),
    [selectedProject],
  );
  const lastUsedSession = useMemo(
    () => (selectedProject ? getProjectLastUsedSession(selectedProject, t) : null),
    [selectedProject, t],
  );
  const allSessions = useMemo(
    () => (selectedProject ? getProjectSessionRecords(selectedProject, t) : []),
    [selectedProject, t],
  );
  const claudeSessions = useMemo(() => allSessions.filter((item) => item.provider === 'claude'), [allSessions]);
  const codexSessions = useMemo(() => allSessions.filter((item) => item.provider === 'codex'), [allSessions]);
  const worktreeContext = useMemo(
    () => (selectedProject ? getProjectWorktreeContext(projects, selectedProject) : { role: 'standalone' as const, sourceProject: null, worktrees: [] }),
    [projects, selectedProject],
  );
  const lastActivityMs = selectedProject ? getProjectLastActivityMs(selectedProject) : 0;
  const isStarred = selectedProject ? starredProjects.has(selectedProject.name) : false;

  const syncRefresh = async () => {
    await onRefreshProjects();
  };

  const handleToggleStar = () => {
    if (!selectedProject) {
      return;
    }

    setStarredProjects((current) => {
      const next = new Set(current);
      if (next.has(selectedProject.name)) {
        next.delete(selectedProject.name);
      } else {
        next.add(selectedProject.name);
      }
      persistStarredProjects(next);
      return next;
    });
  };

  const handleRenameProject = async () => {
    if (!selectedProject || isSavingProject) {
      return;
    }

    const nextName = window.prompt(
      t('workbench.projectOverview.actions.renamePrompt', {
        defaultValue: '输入新的项目显示名称',
      }),
      getProjectDisplayLabel(selectedProject),
    );

    if (nextName === null) {
      return;
    }

    const displayName = nextName.trim();
    if (!displayName || displayName === getProjectDisplayLabel(selectedProject)) {
      return;
    }

    setIsSavingProject(true);
    try {
      await tauriProjects.rename(selectedProject.path || selectedProject.fullPath, displayName);
      await syncRefresh();
    } catch (error) {
      console.error('Failed to rename project from overview:', error);
      alert(
        t('workbench.projectOverview.errors.rename', {
          defaultValue: '重命名项目失败',
        }),
      );
    } finally {
      setIsSavingProject(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!selectedProject || projectDeletePending) {
      return;
    }

    const confirmDelete = window.confirm(
      t('workbench.projectOverview.actions.deleteConfirm', {
        project: getProjectDisplayLabel(selectedProject),
        count: counts.totalCount,
        defaultValue:
          counts.totalCount > 0
            ? `删除项目 ${getProjectDisplayLabel(selectedProject)}？这会同时删除 ${counts.totalCount} 个会话。`
            : `删除项目 ${getProjectDisplayLabel(selectedProject)}？`,
      }),
    );

    if (!confirmDelete) {
      return;
    }

    setProjectDeletePending(true);
    try {
      await tauriProjects.remove(selectedProject.fullPath || selectedProject.name);
      onDeleteProjectState(selectedProject.name);
      onSelectOverview();
      await syncRefresh();
    } catch (error) {
      console.error('Failed to delete project from overview:', error);
      alert(
        t('workbench.projectOverview.errors.deleteProject', {
          defaultValue: '删除项目失败',
        }),
      );
    } finally {
      setProjectDeletePending(false);
    }
  };

  const handleDeleteSelectedSessions = async (provider: SessionProvider, records: ProjectOverviewSessionRecord[]) => {
    if (!selectedProject || overviewState.isDeleting) {
      return;
    }

    const selectedIds = overviewState.selectedIdsByProvider[provider];
    if (selectedIds.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      t('workbench.projectOverview.actions.deleteSessionsConfirm', {
        count: selectedIds.length,
        provider: provider === 'claude' ? 'Claude' : 'Codex',
        defaultValue: `删除选中的 ${selectedIds.length} 条${provider === 'claude' ? ' Claude' : ' Codex'}会话？`,
      }),
    );

    if (!confirmed) {
      return;
    }

    overviewState.setIsDeleting(true);
    try {
      const targets = records.filter((item) => selectedIds.includes(item.session.id));
      for (const item of targets) {
        const projectPath = selectedProject.fullPath || selectedProject.path || selectedProject.name;
        try {
          await tauriProjects.deleteSession(item.session.id, projectPath);
        } catch (err) {
          console.error('[Overview] deleteSession backend error:', err);
        }
        onDeleteSession(selectedProject.name, item.session.id, provider);
      }

      overviewState.exitManageMode();
      await syncRefresh();
    } catch (error) {
      console.error('Failed to delete selected sessions:', error);
      alert(
        t('workbench.projectOverview.errors.deleteSessions', {
          defaultValue: '删除会话失败',
        }),
      );
    } finally {
      overviewState.setIsDeleting(false);
    }
  };

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="w-full max-w-lg rounded-[22px] border border-border/60 bg-card/72 p-5 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-foreground">
            <FolderKanban className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
            {t('workbench.projectOverview.emptyTitle', { defaultValue: '选择一个项目' })}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('workbench.projectOverview.emptyDescription', { defaultValue: '从左侧进入一个项目，或先创建新的项目。' })}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={onSelectOverview} className="rounded-xl border border-border/60 bg-background px-3 py-[7px] text-[13px] text-foreground transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
              {t('workbench.overview.nav')}
            </button>
            <button type="button" onClick={onCreateProject} className="rounded-xl border border-border/60 bg-card px-3 py-[7px] text-[13px] text-foreground transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
              {t('workbench.overview.actions.createProject')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const projectLabel = getProjectDisplayLabel(selectedProject);
  const claudeSelected = overviewState.selectedIdsByProvider.claude;
  const codexSelected = overviewState.selectedIdsByProvider.codex;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-background">
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-2.5 px-5 py-3.5 lg:px-6">
        <section className="overflow-hidden rounded-[22px] border border-border/60 bg-card/72 p-3.5 shadow-sm">
          <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.55fr)_308px]">
            <div className="min-w-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={onSelectOverview}
                className="mb-2 gap-1 text-muted-foreground hover:text-foreground px-2 h-7"
              >
                <ChevronLeft className="w-4 h-4" />
                {t('navigation.back', 'Back')}
              </Button>
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 text-xl font-semibold tracking-tight text-foreground">{projectLabel}</h1>
                {selectedProject.isGitWorktree ? (
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                    {t('workbench.projectOverview.worktreeBadge', { defaultValue: 'Worktree' })}
                  </Badge>
                ) : null}
                {isStarred ? (
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                    {t('projects.starred')}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 truncate text-sm leading-6 text-muted-foreground" title={getProjectPath(selectedProject)}>
                {getProjectPath(selectedProject)}
              </p>
              <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile label="Claude" value={String(counts.claudeCount)} />
                <StatTile label="Codex" value={String(counts.codexCount)} />
                <StatTile
                  label={t('workbench.projectOverview.stats.worktrees', { defaultValue: 'Worktrees' })}
                  value={String(worktreeContext.worktrees.length)}
                />
                <StatTile
                  label={t('workbench.projectOverview.stats.activity', { defaultValue: 'Last activity' })}
                  value={
                    lastActivityMs > 0
                      ? formatTimeAgo(new Date(lastActivityMs).toISOString(), currentTime, t)
                      : t('workbench.overview.noRecentActivity')
                  }
                />
              </div>
            </div>

            <div className="rounded-[20px] border border-border/60 bg-background/90 p-3 shadow-sm overflow-hidden">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('workbench.projectOverview.actions.title', { defaultValue: '项目操作' })}
              </div>
              <div className="mt-2.5 grid gap-1.5">
                <button type="button" onClick={() => onNewSession(selectedProject, 'claude')} className="flex items-start gap-2 rounded-[16px] border border-border/60 bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
                  <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[14px] bg-amber-500/10 text-amber-700 dark:text-amber-300">
                    <Plus className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium leading-5 text-foreground">{t('workbench.overview.actions.claude')}</div>
                    <div className="text-[11px] leading-4 text-muted-foreground">{t('workbench.overview.actions.claudeHint', { project: projectLabel })}</div>
                  </div>
                </button>
                <button type="button" onClick={() => onNewSession(selectedProject, 'codex')} className="flex items-start gap-2 rounded-[16px] border border-border/60 bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
                  <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[14px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium leading-5 text-foreground">{t('workbench.overview.actions.codex')}</div>
                    <div className="text-[11px] leading-4 text-muted-foreground">{t('workbench.overview.actions.codexHint', { project: projectLabel })}</div>
                  </div>
                </button>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={handleToggleStar} className="flex-1 min-w-[80px] rounded-xl border border-border/60 bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
                    {isStarred
                      ? t('workbench.projectOverview.actions.unstar', { defaultValue: '取消星标' })
                      : t('workbench.projectOverview.actions.star', { defaultValue: '星标项目' })}
                  </button>
                  <button type="button" onClick={() => void handleRenameProject()} disabled={isSavingProject} className="flex-1 min-w-[80px] rounded-xl border border-border/60 bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60">
                    <span className="inline-flex items-center gap-1.5"><PencilLine className="h-3.5 w-3.5" />{t('projects.renameProject')}</span>
                  </button>
                  <button type="button" onClick={() => void handleDeleteProject()} disabled={projectDeletePending} className="flex-1 min-w-[80px] rounded-xl border border-red-500/20 bg-red-500/5 px-2.5 py-1.5 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/20 dark:text-red-300 disabled:opacity-60">
                    <span className="inline-flex items-center gap-1.5"><Trash2 className="h-3.5 w-3.5" />{t('projects.deleteProject')}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {lastUsedSession ? (
          <SectionCard
            title={t('workbench.projectOverview.continue', { defaultValue: '继续上次会话' })}
            description={t('workbench.projectOverview.continueDescription', { defaultValue: '保留项目入口一致，但仍然可以一键继续最近一次上下文。' })}
          >
            <button
              type="button"
              onClick={() => onSelectSession({ ...lastUsedSession.session, __projectName: selectedProject.name, __provider: lastUsedSession.provider })}
              className="flex w-full items-start gap-2.5 rounded-[18px] border border-border/60 bg-background/95 px-3 py-2.5 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[14px] bg-muted text-foreground">
                <Clock3 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium leading-5 text-foreground">{lastUsedSession.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                      <ProviderBadge provider={lastUsedSession.provider} />
                      <span>{formatTimeAgo(lastUsedSession.timestamp, currentTime, t)}</span>
                    </div>
                  </div>
                  <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </div>
              </div>
            </button>
          </SectionCard>
        ) : null}

        <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.16fr)_minmax(0,0.84fr)]">
          <div className="min-w-0 space-y-2.5">
            {(['claude', 'codex'] as SessionProvider[]).map((provider) => {
              const providerRecords = provider === 'claude' ? claudeSessions : codexSessions;
              const isManaging = overviewState.manageProvider === provider;
              const selectedIds = provider === 'claude' ? claudeSelected : codexSelected;

              return (
                <SectionCard
                  key={provider}
                  title={t(`workbench.projectOverview.providers.${provider}.title`, {
                    defaultValue: provider === 'claude' ? 'Claude 会话' : 'Codex 会话',
                  })}
                  description={t(`workbench.projectOverview.providers.${provider}.description`, {
                    defaultValue:
                      provider === 'claude'
                        ? '在项目总览里集中管理 Claude 会话。'
                        : '在项目总览里集中管理 Codex 会话。',
                  })}
                  action={
                    providerRecords.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => (isManaging ? overviewState.exitManageMode() : overviewState.enterManageMode(provider))}
                        className="rounded-xl border border-border/60 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/45"
                      >
                        {isManaging
                          ? t('common.cancel', { defaultValue: '取消' })
                          : t('workbench.projectOverview.actions.manage', { defaultValue: '管理' })}
                      </button>
                    ) : null
                  }
                >
                  {providerRecords.length === 0 ? (
                    <div className="rounded-[18px] border border-dashed border-border/60 bg-background/70 px-3 py-2.5 text-sm text-muted-foreground">
                      {t(`workbench.projectOverview.providers.${provider}.empty`, {
                        defaultValue: provider === 'claude' ? '还没有 Claude 会话。' : '还没有 Codex 会话。',
                      })}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {isManaging ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-[18px] border border-border/60 bg-background/85 px-2.5 py-1.5">
                          <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                            {t('workbench.projectOverview.selectedCount', {
                              count: selectedIds.length,
                              defaultValue: `${selectedIds.length} selected`,
                            })}
                          </Badge>
                          <button type="button" onClick={() => overviewState.selectAll(provider, providerRecords)} className="text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                            {t('workbench.projectOverview.actions.selectAll', { defaultValue: '全选' })}
                          </button>
                          <button type="button" onClick={() => overviewState.clearSelection(provider)} className="text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                            {t('workbench.projectOverview.actions.clear', { defaultValue: '清空' })}
                          </button>
                          <button type="button" onClick={() => void handleDeleteSelectedSessions(provider, providerRecords)} disabled={selectedIds.length === 0 || overviewState.isDeleting} className="rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-1 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/20 dark:text-red-300 disabled:opacity-60">
                            {t('workbench.projectOverview.actions.deleteSelected', { defaultValue: '删除选中' })}
                          </button>
                        </div>
                      ) : null}

                      {providerRecords.map((record) => (
                        <SessionRow
                          key={record.session.id}
                          record={record}
                          currentTime={currentTime}
                          isManaging={isManaging}
                          isSelected={selectedIds.includes(record.session.id)}
                          onToggleSelect={() => overviewState.toggleSelection(provider, record.session.id)}
                          onOpen={() =>
                            onSelectSession({
                              ...record.session,
                              __projectName: selectedProject.name,
                              __provider: provider,
                            })
                          }
                          timeLabel={formatTimeAgo(record.timestamp, currentTime, t)}
                        />
                      ))}
                    </div>
                  )}
                </SectionCard>
              );
            })}
          </div>

          <div className="min-w-0 space-y-3">
            {worktreeContext.sourceProject ? (
              <SectionCard
                title={t('workbench.projectOverview.sourceProject', { defaultValue: '源项目' })}
                description={t('workbench.projectOverview.sourceProjectDescription', { defaultValue: '当前项目属于某个 worktree 组时，这里提供返回源项目的入口。' })}
              >
                <button type="button" onClick={() => onSelectProject(worktreeContext.sourceProject!)} className="flex w-full items-start gap-3 rounded-2xl border border-border/60 bg-background px-3.5 py-3 text-left transition-colors hover:bg-muted/45">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                    <FolderKanban className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium leading-5 text-foreground">{getProjectDisplayLabel(worktreeContext.sourceProject)}</div>
                    <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{getProjectPath(worktreeContext.sourceProject)}</div>
                  </div>
                  <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </button>
              </SectionCard>
            ) : null}

            <SectionCard
              title={t('workbench.projectOverview.worktreesTitle', { defaultValue: '相关 Worktrees' })}
            >
              {worktreeContext.worktrees.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 bg-background/70 px-3.5 py-3 text-sm text-muted-foreground">
                  {t('workbench.projectOverview.worktreesEmpty', { defaultValue: '当前项目还没有其他关联 worktrees。' })}
                </div>
              ) : (
                <div className="space-y-2">
                  {worktreeContext.worktrees.map((item) => (
                    <button key={item.project.name} type="button" onClick={() => onSelectProject(item.project)} className="flex w-full items-start gap-3 rounded-2xl border border-border/60 bg-background px-3.5 py-3 text-left transition-colors hover:bg-muted/45">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                        <FolderTree className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="truncate text-[13px] font-medium leading-5 text-foreground">{getProjectDisplayLabel(item.project)}</div>
                          {item.branchLabel ? (
                            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                              <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{item.branchLabel}</span>
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{getProjectPath(item.project)}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-muted-foreground">
                          <span>Claude {item.claudeCount}</span>
                          <span>Codex {item.codexCount}</span>
                          <span>
                            {item.lastActivityMs > 0
                              ? formatTimeAgo(new Date(item.lastActivityMs).toISOString(), currentTime, t)
                              : t('workbench.overview.noRecentActivity')}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  );
}
