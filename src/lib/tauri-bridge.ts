/**
 * tauri-bridge.ts
 * Unified bridge between React frontend and Tauri Rust backend.
 * Supports both Tauri desktop mode and web/mobile browser mode (LAN access).
 */

// Static imports — safe in all environments; actual calls are gated by isTauriEnv()
import { invoke as _tauriInvoke } from '@tauri-apps/api/core';
import { listen as _tauriListen } from '@tauri-apps/api/event';

// ─── Environment Detection ───────────────────────────────────────────────────

/** Returns true when running inside the Tauri webview (desktop app). */
export const isTauriEnv = (): boolean => {
  return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
};

// Re-export the real Tauri invoke (only works inside the Tauri webview)
export const invoke = _tauriInvoke;

// listen wrapper — no-op stub in web mode
const listen = isTauriEnv()
  ? _tauriListen
  : async <T>(_event: string, _handler: (e: { payload: T }) => void): Promise<() => void> =>
      () => {};

// ─── Web Mode HTTP Helpers ───────────────────────────────────────────────────

async function httpGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function httpPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Web Mode PTY WebSocket ──────────────────────────────────────────────────

const ptyWsConnections = new Map<string, WebSocket>();

/**
 * Connect to a PTY session via WebSocket (web/mobile mode).
 * Returns a cleanup function to close the connection.
 */
export const webPtyConnect = (
  sessionId: string,
  onOutput: (data: string) => void,
  onExit: (code?: number) => void,
): (() => void) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/pty/${sessionId}/ws`;
  const ws = new WebSocket(wsUrl);
  ptyWsConnections.set(sessionId, ws);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'pty-output' || msg.type === 'pty-history') {
        onOutput(msg.data);
      } else if (msg.type === 'pty-exit') {
        onExit(msg.code);
      }
    } catch {
      // Ignore parse errors
    }
  };

  ws.onclose = () => {
    ptyWsConnections.delete(sessionId);
  };

  return () => {
    ws.close();
    ptyWsConnections.delete(sessionId);
  };
};

/** Send input to a PTY session via its WebSocket connection. */
export const webPtySend = (sessionId: string, data: string): void => {
  const ws = ptyWsConnections.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'pty-input', data }));
  }
};

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface UserInfo {
  id: number;
  username: string;
  created_at?: string;
  has_completed_onboarding: boolean;
}

export interface LoginResponse {
  token: string;
  user: UserInfo;
}

export const auth = {
  login: (username: string, password: string) =>
    isTauriEnv()
      ? invoke<LoginResponse>('auth_login', { username, password })
      : httpPost<LoginResponse>('/api/auth/login', { username, password }),
  register: (username: string, password: string) =>
    isTauriEnv()
      ? invoke<LoginResponse>('auth_register', { username, password })
      : httpPost<LoginResponse>('/api/auth/register', { username, password }),
  verify: (token: string) =>
    isTauriEnv()
      ? invoke<UserInfo>('auth_verify', { token })
      : httpPost<UserInfo>('/api/auth/verify', { token }),
  logout: (token: string) =>
    isTauriEnv()
      ? invoke<void>('auth_logout', { token })
      : httpPost<void>('/api/auth/logout', { token }),
};

// ─── PTY ─────────────────────────────────────────────────────────────────────

export const pty = {
  create: (id: string, workingDir: string, rows: number, cols: number): Promise<string> =>
    isTauriEnv()
      ? invoke<string>('pty_create', { id, workingDir, rows, cols })
      : httpPost<{ ok: boolean; ptyId: string }>('/api/sessions', { project_path: workingDir, provider: 'shell' }).then((r) => r.ptyId || id),
  input: (id: string, data: string) =>
    isTauriEnv()
      ? invoke<void>('pty_input', { id, data })
      : (webPtySend(id, data), Promise.resolve()),
  resize: (id: string, rows: number, cols: number) =>
    isTauriEnv()
      ? invoke<void>('pty_resize', { id, rows, cols })
      : Promise.resolve(), // resize not supported in web mode
  kill: (id: string) =>
    isTauriEnv()
      ? invoke<void>('pty_kill', { id })
      : httpPost<void>(`/api/sessions/${id}/kill`, {}),
  getSessionState: (ptyId: string) =>
    isTauriEnv()
      ? invoke<SessionState>('pty_get_session_state', { ptyId })
      : Promise.resolve('Running' as SessionState),
  onOutput: (cb: (payload: { id: string; data: string }) => void) =>
    isTauriEnv()
      ? listen<{ id: string; data: string }>('pty-output', (e) => cb(e.payload))
      : Promise.resolve(() => {}),
  onExit: (cb: (payload: { id: string; code?: number }) => void) =>
    isTauriEnv()
      ? listen<{ id: string; code?: number }>('pty-exit', (e) => cb(e.payload))
      : Promise.resolve(() => {}),
  onStateChanged: (cb: (payload: { ptyId: string; state: SessionState }) => void) =>
    isTauriEnv()
      ? listen<{ ptyId: string; state: SessionState }>('session-state-changed', (e) => cb(e.payload))
      : Promise.resolve(() => {}),
  onAttentionRequired: (cb: (payload: AttentionRequiredEvent) => void) =>
    isTauriEnv()
      ? listen<AttentionRequiredEvent>('attention-required', (e) => cb(e.payload))
      : Promise.resolve(() => {}),
};

// ─── Projects ────────────────────────────────────────────────────────────────

export const projects = {
  list: () =>
    isTauriEnv()
      ? invoke<Project[]>('projects_list')
      : httpGet<Project[]>('/api/projects'),
  get: (path: string) =>
    isTauriEnv()
      ? invoke<Project>('projects_get', { path })
      : httpGet<Project>(`/api/projects?path=${encodeURIComponent(path)}`),
  add: (name: string, path: string) =>
    isTauriEnv()
      ? invoke<Project>('projects_add', { name, path })
      : httpPost<Project>('/api/projects', { name, path }),
  remove: (path: string) =>
    isTauriEnv()
      ? invoke<void>('projects_remove', { path })
      : httpPost<void>('/api/projects/remove', { path }),
  rename: (path: string, newName: string): Promise<void> =>
    isTauriEnv()
      ? invoke('rename_project', { path, newName })
      : httpPost('/api/projects/rename', { path, newName }),
  restore: (path: string): Promise<void> =>
    isTauriEnv()
      ? invoke('restore_project', { path })
      : Promise.resolve(),
  deleteSession: (sessionId: string, projectPath: string): Promise<void> =>
    isTauriEnv()
      ? invoke('delete_session', { sessionId, projectPath })
      : Promise.resolve(),
  renameSession: (projectPath: string, sessionId: string, name: string) =>
    isTauriEnv()
      ? invoke<void>('projects_update_session_name', { projectPath, sessionId, name })
      : Promise.resolve(), // not yet implemented in web mode
};

// ─── AI ──────────────────────────────────────────────────────────────────────

export const ai = {
  startSession: (sessionId: string, provider: string, projectPath: string, resumeSessionId?: string): Promise<string> =>
    isTauriEnv()
      ? invoke<string>('ai_start_session', { sessionId, provider, projectPath, resumeSessionId })
      : httpPost<{ ok: boolean; ptyId: string }>('/api/sessions', { project_path: projectPath, provider, resume_session_id: resumeSessionId }).then((r) => r.ptyId),
  sendMessage: (ptyId: string, message: string): Promise<void> =>
    isTauriEnv()
      ? invoke<void>('ai_send_message', { ptyId, message })
      : httpPost<void>(`/api/sessions/${ptyId}/send`, { text: message }),
  abortSession: (ptyId: string): Promise<void> =>
    isTauriEnv()
      ? invoke<void>('ai_abort_session', { ptyId })
      : httpPost<void>(`/api/sessions/${ptyId}/kill`, {}),
  listSessions: (projectPath: string, provider: string): Promise<Session[]> =>
    isTauriEnv()
      ? invoke<Session[]>('ai_list_sessions', { projectPath, provider })
      : httpGet<Session[]>(`/api/session-history?project_path=${encodeURIComponent(projectPath)}&provider=${encodeURIComponent(provider)}&limit=50`).then(
          (data) => (Array.isArray(data) ? data : [])
        ).catch(() => []),
  getConfig: (provider: string): Promise<Record<string, string>> =>
    isTauriEnv()
      ? invoke<Record<string, string>>('settings_get_ai_config', { provider })
      : Promise.resolve({} as Record<string, string>),
};

// ─── Handoff ─────────────────────────────────────────────────────────────────

export interface HandoffRequest {
  sourcePtyId: string;
  targetProvider: string;
  projectPath: string;
  taskDescription?: string;
}

export interface HandoffResult {
  newPtyId: string;
  handoffPrompt: string;
}

export const handoff = {
  session: (req: HandoffRequest) =>
    isTauriEnv()
      ? invoke<HandoffResult>('handoff_session', {
          req: {
            source_pty_id: req.sourcePtyId,
            target_provider: req.targetProvider,
            project_path: req.projectPath,
            task_description: req.taskDescription,
          },
        })
      : Promise.reject(new Error('Handoff not supported in web mode')),
};

// ─── Git ─────────────────────────────────────────────────────────────────────

export const git = {
  status: (projectPath: string) =>
    isTauriEnv() ? invoke<GitStatus>('git_status', { projectPath }) : Promise.reject(new Error('Git not available in web mode')),
  diff: (projectPath: string, filePath?: string) =>
    isTauriEnv() ? invoke<string>('git_diff', { projectPath, filePath }) : Promise.resolve(''),
  stagedDiff: (projectPath: string, filePath?: string): Promise<string> =>
    isTauriEnv() ? invoke<string>('git_staged_diff', { projectPath, filePath }) : Promise.resolve(''),
  log: (projectPath: string, limit?: number) =>
    isTauriEnv() ? invoke<GitCommit[]>('git_log', { projectPath, limit }) : Promise.resolve([]),
  branches: (projectPath: string) =>
    isTauriEnv() ? invoke<GitBranches>('git_branches', { projectPath }) : Promise.resolve({ current: '', local: [], remote: [] } as GitBranches),
  stage: (projectPath: string, files: string[]) =>
    isTauriEnv() ? invoke<void>('git_stage', { projectPath, files }) : Promise.resolve(),
  commit: (projectPath: string, message: string) =>
    isTauriEnv() ? invoke<string>('git_commit', { projectPath, message }) : Promise.resolve(''),
  checkoutBranch: (projectPath: string, branch: string) =>
    isTauriEnv() ? invoke<void>('git_checkout_branch', { projectPath, branch }) : Promise.resolve(),
  createBranch: (projectPath: string, branch: string) =>
    isTauriEnv() ? invoke<void>('git_create_branch', { projectPath, branch }) : Promise.resolve(),
  discardFile: (projectPath: string, filePath: string) =>
    isTauriEnv() ? invoke<void>('git_discard_file', { projectPath, filePath }) : Promise.resolve(),
  pull: (projectPath: string) =>
    isTauriEnv() ? invoke<void>('git_pull', { projectPath }) : Promise.resolve(),
  push: (projectPath: string) =>
    isTauriEnv() ? invoke<void>('git_push', { projectPath }) : Promise.resolve(),
  onProgress: (cb: (line: string) => void) =>
    isTauriEnv() ? listen<string>('git-progress', (e) => cb(e.payload)) : Promise.resolve(() => {}),
  worktreeList: (projectPath: string) =>
    isTauriEnv() ? invoke<WorktreeInfo[]>('git_worktree_list', { projectPath }) : Promise.resolve([]),
  worktreeAdd: (projectPath: string, worktreeName: string, baseBranch?: string) =>
    isTauriEnv() ? invoke<string>('git_worktree_add', { projectPath, worktreeName, baseBranch }) : Promise.resolve(''),
  worktreeRemove: (projectPath: string, worktreePath: string, force?: boolean) =>
    isTauriEnv() ? invoke<void>('git_worktree_remove', { projectPath, worktreePath, force: force ?? false }) : Promise.resolve(),
};

// ─── File System ─────────────────────────────────────────────────────────────

export const fs = {
  listDir: (path: string) =>
    isTauriEnv() ? invoke<DirEntry[]>('fs_list_dir', { path }) : Promise.resolve([]),
  readFile: (path: string) =>
    isTauriEnv() ? invoke<string>('fs_read_file', { path }) : Promise.resolve(''),
  writeFile: (path: string, content: string) =>
    isTauriEnv() ? invoke<void>('fs_write_file', { path, content }) : Promise.resolve(),
  deleteFile: (path: string) =>
    isTauriEnv() ? invoke<void>('fs_delete_file', { path }) : Promise.resolve(),
};

// ─── Settings ────────────────────────────────────────────────────────────────

export interface CustomSlashCommand {
  name: string;
  description?: string;
  prompt: string;
  provider: 'all' | 'claude' | 'codex' | 'cursor';
}

export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  icon?: string;
  isBuiltIn?: boolean;
  systemPrompt?: string;
  initialMessage?: string;
  provider?: 'all' | 'claude' | 'codex' | 'cursor';
}

export interface AppSettings {
  customSlashCommands?: CustomSlashCommand[];
  sessionTemplates?: SessionTemplate[];
  skills?: unknown[];
  skillRoots?: unknown[];
  worktreeRootPath?: string;
  theme?: string;
  language?: string;
  [key: string]: unknown;
}

export const settings = {
  getAll: (): Promise<AppSettings> =>
    isTauriEnv() ? invoke<AppSettings>('settings_get_all') : Promise.resolve({}),
  set: (key: string, value: unknown) =>
    isTauriEnv() ? invoke<void>('settings_set', { key, value }) : Promise.resolve(),
};

// ─── Session History ─────────────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  project_path: string;
  provider: string;
  name?: string;
  message_count: number;
  last_message?: string;
  created_at?: string;
}

export interface SessionMessage {
  uuid: string;
  role: string;
  content: unknown;
  timestamp?: string;
  is_sidechain?: boolean;
}

export const sessions = {
  list: (projectPath: string, provider: string, limit?: number, offset?: number) =>
    isTauriEnv()
      ? invoke<SessionSummary[]>('session_list', { projectPath, provider, limit, offset })
      : httpGet<SessionSummary[]>(
          `/api/session-history?project_path=${encodeURIComponent(projectPath)}&provider=${encodeURIComponent(provider)}${limit != null ? `&limit=${limit}` : ''}${offset != null ? `&offset=${offset}` : ''}`
        ).then((d) => (Array.isArray(d) ? d : [])).catch(() => []),
  messages: (projectPath: string, sessionId: string, limit?: number, offset?: number, provider?: string) =>
    isTauriEnv()
      ? invoke<SessionMessage[]>('session_messages', { projectPath, sessionId, limit, offset, provider })
      : httpGet<SessionMessage[]>(
          `/api/session-history/${encodeURIComponent(sessionId)}/messages?project_path=${encodeURIComponent(projectPath)}&provider=${encodeURIComponent(provider ?? 'claude')}${limit != null ? `&limit=${limit}` : ''}${offset != null ? `&offset=${offset}` : ''}`
        ).then((d) => (Array.isArray(d) ? d : [])).catch(() => []),
};

// ─── App Info ────────────────────────────────────────────────────────────────

export const appInfo = {
  version: () =>
    isTauriEnv() ? invoke<string>('get_app_version') : Promise.resolve('web'),
  readFileBase64: (path: string) =>
    isTauriEnv() ? invoke<string>('fs_read_file_base64', { path }) : Promise.resolve(''),
};

// ─── Skills ──────────────────────────────────────────────────────────────────

export interface DiscoveredCommand {
  name: string;
  description: string;
  provider: string;
  scope: 'user' | 'project';
  filePath: string;
}

export interface DiscoveredSkill {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  scope: 'user' | 'vendor';
}

export interface CommandDiscoveryResult {
  commands: DiscoveredCommand[];
  skills: DiscoveredSkill[];
}

export const commandDiscovery = {
  discover: (provider: string, projectPath?: string): Promise<CommandDiscoveryResult> => {
    if (isTauriEnv()) {
      return invoke<CommandDiscoveryResult>('commands_discover', { provider, projectPath });
    }
    const params = new URLSearchParams({ provider });
    if (projectPath) params.set('project_path', projectPath);
    return httpGet<{ ok: boolean; data: CommandDiscoveryResult }>(`/api/commands/discover?${params}`)
      .then((r) => r.data);
  },
};

export interface SkillRoot {
  id: string;
  label: string;
  provider: string;
  path: string;
  exists: boolean;
  writable: boolean;
}

export interface SkillSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  provider: string;
  rootId: string;
  rootLabel: string;
  rootPath: string;
  path: string;
  filePath: string;
  updatedAt: string;
  writable: boolean;
}

export interface SkillRecord extends SkillSummary {
  content: string;
  frontmatter?: Record<string, unknown>;
}

export const skills = {
  list: () =>
    isTauriEnv()
      ? invoke<{ roots: SkillRoot[]; skills: SkillSummary[] }>('skills_list')
      : Promise.resolve({ roots: [] as SkillRoot[], skills: [] as SkillSummary[] }),
  read: (skillId: string) =>
    isTauriEnv() ? invoke<SkillRecord>('skills_read', { skillId }) : Promise.reject(new Error('Not available in web mode')),
  create: (rootId: string, slug: string, content: string) =>
    isTauriEnv() ? invoke<SkillRecord>('skills_create', { rootId, slug, content }) : Promise.reject(new Error('Not available in web mode')),
  update: (skillId: string, content: string) =>
    isTauriEnv() ? invoke<SkillRecord>('skills_update', { skillId, content }) : Promise.reject(new Error('Not available in web mode')),
  delete: (skillId: string) =>
    isTauriEnv() ? invoke<void>('skills_delete', { skillId }) : Promise.resolve(),
};

// ─── Type definitions (match Rust structs) ────────────────────────────────────

export interface Project {
  name: string;
  path: string;
  full_path: string;
  description?: string;
  sessions: Session[];
  created_at?: string;
  last_accessed?: string;
  config?: unknown;
}

export interface Session {
  id: string;
  project_path: string;
  provider: string;
  name?: string;
  created_at?: string;
  last_message?: string;
  message_count: number;
}

export interface GitStatus {
  branch: string;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  ahead: number;
  behind: number;
}

export interface FileStatus {
  path: string;
  status: string;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitBranches {
  current: string;
  local: string[];
  remote: string[];
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: string;
}

// ─── Session State ───────────────────────────────────────────────────────────

export type SessionState = 'Idle' | 'Running' | 'WaitingForInput' | 'Completed' | 'Failed';

export interface AttentionRequiredEvent {
  ptyId: string;
  sessionId: string;
  type: 'waiting' | 'error';
  message: string;
}

// ─── Git Worktree ────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  isLocked: boolean;
}

// ─── Tasks (Markdown persistence) ────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'done' | 'failed';
  created_at: string;
  updated_at: string;
  deps: string[];
  session_id?: string;
}

export const tasks = {
  list: (projectPath: string) =>
    isTauriEnv() ? invoke<Task[]>('task_list', { projectPath }) : Promise.resolve([]),
  create: (projectPath: string, title: string, description?: string, deps: string[] = []) =>
    isTauriEnv() ? invoke<Task>('task_create', { projectPath, title, description, deps }) : Promise.reject(new Error('Not available in web mode')),
  update: (projectPath: string, id: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'session_id'>>) =>
    isTauriEnv() ? invoke<Task>('task_update', { projectPath, id, ...updates }) : Promise.reject(new Error('Not available in web mode')),
  delete: (projectPath: string, id: string) =>
    isTauriEnv() ? invoke<void>('task_delete', { projectPath, id }) : Promise.resolve(),
};

// ─── Loop Runner ─────────────────────────────────────────────────────────────

export interface LoopConfig {
  projectPath: string;
  workerProvider: string;
  verifierProvider: string;
  taskPrompt: string;
  verifyPrompt: string;
  maxIterations: number;
}

export interface LoopState {
  loopId: string;
  config: LoopConfig;
  iteration: number;
  workerPtyId?: string;
  verifierPtyId?: string;
  status: 'running' | 'waiting_verification' | 'passed' | 'failed' | 'cancelled';
  lastOutput: string;
}

export const loop = {
  start: (config: LoopConfig) =>
    isTauriEnv() ? invoke<LoopState>('loop_start', { config }) : Promise.reject(new Error('Not available in web mode')),
  cancel: (loopId: string) =>
    isTauriEnv() ? invoke<void>('loop_cancel', { loopId }) : Promise.resolve(),
  list: () =>
    isTauriEnv() ? invoke<LoopState[]>('loop_list') : Promise.resolve([]),
  cleanup: () =>
    isTauriEnv() ? invoke<number>('loop_cleanup') : Promise.resolve(0),
};

// ─── CLI Auth ────────────────────────────────────────────────────────────────

export const cliAuth = {
  getStatus: (provider: string): Promise<{ authenticated: boolean; email: string | null; provider: string }> =>
    isTauriEnv()
      ? invoke('get_cli_auth_status', { provider })
      : Promise.resolve({ authenticated: false, email: null, provider }),
};
