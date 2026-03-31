export type SessionProvider = 'claude' | 'codex';

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'preview' | 'hybrid';
export type SessionLaunchProvider = 'claude' | 'codex';

export interface SessionLaunchProfile {
  id: string;
  name: string;
  args: string[];
}

export interface SessionLaunchOptions {
  profileId?: string;
  args?: string[];
}

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  approvalPolicy?: string;
  sandboxType?: string;
  permissionModeHint?: 'default' | 'acceptEdits' | 'bypassPermissions';
  __provider?: SessionProvider;
  __projectName?: string;
  __launchProfileId?: string | null;
  __launchArgs?: string[];
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Project {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isGitRepo?: boolean;
  workspaceType?: string | null;
  isGitWorktree?: boolean;
  branch?: string | null;
  sourceProjectName?: string | null;
  repoRoot?: string | null;
  worktreePath?: string | null;
  worktreeBaseRoot?: string | null;
  sessions?: ProjectSession[];
  codexSessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  [key: string]: unknown;
}

export interface LoadingProgress {
  type?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

export interface ProjectsUpdatedMessage {
  type: 'projects_updated';
  projects: Project[];
  changedFile?: string;
  [key: string]: unknown;
}

export interface LoadingProgressMessage extends LoadingProgress {
  type: 'loading_progress';
}

export type AppSocketMessage =
  | LoadingProgressMessage
  | ProjectsUpdatedMessage
  | { type?: string; [key: string]: unknown };
