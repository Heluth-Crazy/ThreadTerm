/**
 * Tauri ↔ WorkflowFs adapter for Stage 7.1 PR2.
 *
 * Lives next to the pure workflow modules so the only responsibility here is
 * binding `@tauri-apps/plugin-fs` (+ `@tauri-apps/api/path` for HOME) into the
 * narrow `WorkflowFs` interface. The pure modules stay testable without Tauri,
 * and React components consume `loadAllWorkflows()` rather than wiring the
 * filesystem themselves.
 */
import { readDir, readTextFile, stat, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir, join } from '@tauri-apps/api/path';

import {
  discoverWorkflows,
  type DiscoveryResult,
  type WorkflowFs,
  type WorkflowFsEntry,
} from './discoverWorkflows';

const WORKFLOWS_DIR_SEGMENT = '.threadterm/workflows';

export function tauriWorkflowFs(): WorkflowFs {
  return {
    readDir: async (path: string): Promise<WorkflowFsEntry[]> => {
      const entries = await readDir(path);
      const fileEntries = entries.filter((e) => e.isFile);
      // stat() each file in parallel — readDir does not return size.
      const sized = await Promise.all(
        fileEntries.map(async (entry) => {
          const fullPath = await join(path, entry.name);
          try {
            const meta = await stat(fullPath);
            return { name: entry.name, size: Number(meta.size) };
          } catch {
            // If stat fails, fall back to size 0; discoverWorkflows will then
            // try to read the file and surface any real read error.
            return { name: entry.name, size: 0 };
          }
        }),
      );
      return sized;
    },
    readTextFile: async (path: string): Promise<string> => {
      return readTextFile(path);
    },
  };
}

export async function resolveGlobalWorkflowsDir(): Promise<string> {
  const home = await homeDir();
  return join(home, WORKFLOWS_DIR_SEGMENT);
}

export async function resolveProjectWorkflowsDir(projectCwd: string): Promise<string> {
  return join(projectCwd, WORKFLOWS_DIR_SEGMENT);
}

/**
 * Build the discovery paths and run `discoverWorkflows`. The focused project
 * cwd may be `null` when the user is on the "All terminals" view.
 */
export async function loadAllWorkflows(
  focusedProjectCwd: string | null,
): Promise<DiscoveryResult> {
  const fs = tauriWorkflowFs();
  const globalDir = await resolveGlobalWorkflowsDir();
  const projectDir = focusedProjectCwd
    ? await resolveProjectWorkflowsDir(focusedProjectCwd)
    : null;
  return discoverWorkflows(fs, { globalDir, projectDir });
}

export async function loadProjectPresetWorkflows(
  projectCwd: string,
): Promise<DiscoveryResult> {
  const fs = tauriWorkflowFs();
  const projectDir = await resolveProjectWorkflowsDir(projectCwd);
  return discoverWorkflows(fs, { globalDir: null, projectDir });
}

/**
 * Ensure a directory exists, creating intermediate parents as needed. Used by
 * "Edit project preset…" so the target dir is openable even on a fresh repo.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
