/**
 * tauri-bridge.ts
 * Unified bridge between React frontend and Tauri Rust backend.
 * Replaces all fetch() and WebSocket calls.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Re-export invoke for direct use
export { invoke };

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
    invoke<LoginResponse>('auth_login', { username, password }),
  register: (username: string, password: string) =>
    invoke<LoginResponse>('auth_register', { username, password }),
  verify: (token: string) =>
    invoke<UserInfo>('auth_verify', { token }),
  logout: (token: string) =>
    invoke<void>('auth_logout', { token }),
};

// ─── PTY ─────────────────────────────────────────────────────────────────────

export const pty = {
  create: (id: string, workingDir: string, rows: number, cols: number) =>
    invoke<string>('pty_create', { id, workingDir, rows, cols }),
  input: (id: string, data: string) =>
    invoke<void>('pty_input', { id, data }),
  resize: (id: string, rows: number, cols: number) =>
    invoke<void>('pty_resize', { id, rows, cols }),
  kill: (id: string) =>
    invoke<void>('pty_kill', { id }),
  onOutput: (cb: (payload: { id: string; data: string }) => void) =>
    listen<{ id: string; data: string }>('pty-output', (e) => cb(e.payload)),
  onExit: (cb: (payload: { id: string; code?: number }) => void) =>
    listen<{ id: string; code?: number }>('pty-exit', (e) => cb(e.payload)),
};

// ─── Projects ────────────────────────────────────────────────────────────────

export const projects = {
  list: () => invoke<Project[]>('projects_list'),
  get: (path: string) => invoke<Project>('projects_get', { path }),
  add: (name: string, path: string) => invoke<Project>('projects_add', { name, path }),
  remove: (path: string) => invoke<void>('projects_remove', { path }),
  renameSession: (projectPath: string, sessionId: string, name: string) =>
    invoke<void>('projects_update_session_name', { projectPath, sessionId, name }),
};

// ─── AI ──────────────────────────────────────────────────────────────────────

export const ai = {
  startSession: (sessionId: string, provider: string, projectPath: string, resumeSessionId?: string) =>
    invoke<string>('ai_start_session', { sessionId, provider, projectPath, resumeSessionId }),
  sendMessage: (ptyId: string, message: string) =>
    invoke<void>('ai_send_message', { ptyId, message }),
  abortSession: (ptyId: string) =>
    invoke<void>('ai_abort_session', { ptyId }),
  listSessions: (projectPath: string, provider: string) =>
    invoke<Session[]>('ai_list_sessions', { projectPath, provider }),
  getConfig: (provider: string) =>
    invoke<Record<string, string>>('settings_get_ai_config', { provider }),
};

// ─── Git ─────────────────────────────────────────────────────────────────────

export const git = {
  status: (projectPath: string) => invoke<GitStatus>('git_status', { projectPath }),
  diff: (projectPath: string, filePath?: string) => invoke<string>('git_diff', { projectPath, filePath }),
  log: (projectPath: string, limit?: number) => invoke<GitCommit[]>('git_log', { projectPath, limit }),
  branches: (projectPath: string) => invoke<GitBranches>('git_branches', { projectPath }),
  stage: (projectPath: string, files: string[]) => invoke<void>('git_stage', { projectPath, files }),
  commit: (projectPath: string, message: string) => invoke<string>('git_commit', { projectPath, message }),
  checkoutBranch: (projectPath: string, branch: string) =>
    invoke<void>('git_checkout_branch', { projectPath, branch }),
  createBranch: (projectPath: string, branch: string) =>
    invoke<void>('git_create_branch', { projectPath, branch }),
  pull: (projectPath: string) => invoke<void>('git_pull', { projectPath }),
  push: (projectPath: string) => invoke<void>('git_push', { projectPath }),
  onProgress: (cb: (line: string) => void) =>
    listen<string>('git-progress', (e) => cb(e.payload)),
};

// ─── File System ─────────────────────────────────────────────────────────────

export const fs = {
  listDir: (path: string) => invoke<DirEntry[]>('fs_list_dir', { path }),
  readFile: (path: string) => invoke<string>('fs_read_file', { path }),
  writeFile: (path: string, content: string) => invoke<void>('fs_write_file', { path, content }),
  deleteFile: (path: string) => invoke<void>('fs_delete_file', { path }),
};

// ─── Settings ────────────────────────────────────────────────────────────────

export const settings = {
  getAll: () => invoke<Record<string, unknown>>('settings_get_all'),
  set: (key: string, value: unknown) => invoke<void>('settings_set', { key, value }),
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
