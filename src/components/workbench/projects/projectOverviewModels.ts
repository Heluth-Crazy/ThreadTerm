import type { TFunction } from 'i18next';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';

export type ProjectOverviewSessionRecord = {
  session: ProjectSession;
  provider: SessionProvider;
  timestamp: string;
  timestampMs: number;
  label: string;
};

export type ProjectWorktreeSummary = {
  project: Project;
  branchLabel: string | null;
  claudeCount: number;
  codexCount: number;
  lastActivityMs: number;
};

export type ProjectWorktreeContext = {
  role: 'standalone' | 'source' | 'worktree';
  sourceProject: Project | null;
  worktrees: ProjectWorktreeSummary[];
};

export function parseOverviewTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getProjectDisplayLabel(project: Project): string {
  return project.displayName || project.name;
}

export function getProjectPath(project: Project): string {
  return project.fullPath || project.path || project.name;
}

export function getProjectSessionTimestamp(session: ProjectSession, provider: SessionProvider): string {
  if (provider === 'codex') {
    return String(session.createdAt || session.lastActivity || session.updated_at || '');
  }

  return String(session.lastActivity || session.updated_at || session.createdAt || '');
}

export function getProjectSessionLabel(
  session: ProjectSession,
  provider: SessionProvider,
  t: TFunction,
): string {
  if (provider === 'codex') {
    return String(session.summary || session.name || session.title || t('projects.codexSession'));
  }

  return String(session.summary || session.title || session.name || t('projects.newSession'));
}

export function getProjectSessionRecords(
  project: Project,
  t: TFunction,
): ProjectOverviewSessionRecord[] {
  const claudeSessions = (project.sessions || []).map((session) => {
    const timestamp = getProjectSessionTimestamp(session, 'claude');
    return {
      session,
      provider: 'claude' as const,
      timestamp,
      timestampMs: parseOverviewTimestamp(timestamp),
      label: getProjectSessionLabel(session, 'claude', t),
    };
  });

  const codexSessions = (project.codexSessions || []).map((session) => {
    const timestamp = getProjectSessionTimestamp(session, 'codex');
    return {
      session,
      provider: 'codex' as const,
      timestamp,
      timestampMs: parseOverviewTimestamp(timestamp),
      label: getProjectSessionLabel(session, 'codex', t),
    };
  });

  return [...claudeSessions, ...codexSessions].sort((a, b) => b.timestampMs - a.timestampMs);
}

export function getProjectSessionCounts(project: Project) {
  const claudeCount = project.sessions?.length || 0;
  const codexCount = project.codexSessions?.length || 0;

  return {
    claudeCount,
    codexCount,
    totalCount: claudeCount + codexCount,
  };
}

export function getProjectLastActivityMs(project: Project): number {
  return Math.max(
    0,
    ...[...(project.sessions || []), ...(project.codexSessions || [])].map((session) =>
      parseOverviewTimestamp(
        String(session.lastActivity || session.updated_at || session.createdAt || session.created_at || ''),
      ),
    ),
  );
}

export function getProjectLastUsedSession(project: Project, t: TFunction): ProjectOverviewSessionRecord | null {
  return getProjectSessionRecords(project, t)[0] || null;
}

export function getProjectRecentSessions(project: Project, t: TFunction, limit = 6): ProjectOverviewSessionRecord[] {
  return getProjectSessionRecords(project, t).slice(0, limit);
}

export function getProjectWorktreeContext(projects: Project[], project: Project): ProjectWorktreeContext {
  const sourceName = project.isGitWorktree ? project.sourceProjectName || null : project.name;
  const sourceProject = sourceName
    ? projects.find((item) => item.name === sourceName && !item.isGitWorktree) || null
    : null;

  if (!sourceName) {
    return {
      role: 'standalone',
      sourceProject: null,
      worktrees: [],
    };
  }

  const worktrees = projects
    .filter((item) => item.isGitWorktree && item.sourceProjectName === sourceName && item.name !== project.name)
    .map((item) => ({
      project: item,
      branchLabel: item.branch || null,
      claudeCount: item.sessions?.length || 0,
      codexCount: item.codexSessions?.length || 0,
      lastActivityMs: getProjectLastActivityMs(item),
    }))
    .sort((a, b) => {
      if (b.lastActivityMs !== a.lastActivityMs) {
        return b.lastActivityMs - a.lastActivityMs;
      }

      return getProjectDisplayLabel(a.project).localeCompare(getProjectDisplayLabel(b.project));
    });

  return {
    role: project.isGitWorktree ? 'worktree' : worktrees.length > 0 ? 'source' : 'standalone',
    sourceProject: project.isGitWorktree ? sourceProject : null,
    worktrees,
  };
}
