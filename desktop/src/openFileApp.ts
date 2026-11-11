import type { IpcMainInvokeEvent } from 'electron';
import { isAbsolute, resolve } from 'node:path';
import { isWithinScope } from './revealFile.js';

/** `design.md` §5: one action, document formats only, checked in main. Executables,
 * scripts, shortcuts and every other extension are refused before any path work. */
export const OPEN_FILE_APP_EXTENSIONS = [
  '.docx', '.docm', '.doc', '.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.pptx', '.ppt', '.pdf',
] as const;
const allowedExtensions = new Set<string>(OPEN_FILE_APP_EXTENSIONS);

export type OpenFileAppRequest =
  | { projectId: string; worktreePath?: string; path: string }
  | { externalId: string };

export type OpenFileAppRootRequest = { projectId: string; worktreePath?: string };

export interface OpenFileAppDependencies {
  /** Resolve a project/worktree root from runtime-owned records, as the HTML preview grant does. */
  workspaceRoot(request: OpenFileAppRootRequest): Promise<string>;
  /** A registered external file's canonical path, by registration id only. */
  externalPath(id: string): Promise<string>;
  canonical(path: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
  /** `shell.openPath`: the system's empty string on success, an error line otherwise. */
  openPath(path: string): Promise<string>;
}

const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

/** Strict key checks, like the HTML preview grant commands: no extra fields, bounded strings. */
export function parseOpenFileAppRequest(value: unknown): OpenFileAppRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file request');
  const data = value as Record<string, unknown>;
  if (data.externalId !== undefined) {
    if (!Object.keys(data).every(key => ['externalId'].includes(key)) || !text(data.externalId, 256)) {
      throw new Error('Invalid file request');
    }
    return { externalId: data.externalId };
  }
  if (!Object.keys(data).every(key => ['projectId', 'worktreePath', 'path'].includes(key))
    || !text(data.projectId, 256) || !text(data.path, 16384)
    || data.worktreePath !== undefined && !text(data.worktreePath, 4096)) {
    throw new Error('Invalid file request');
  }
  return data as OpenFileAppRequest;
}

/** The lower-case extension of the last path segment, or undefined when there is none. */
export function openFileAppExtension(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : undefined;
}

export function canOpenFileWithSystemApp(path: string): boolean {
  const extension = openFileAppExtension(path);
  return extension !== undefined && allowedExtensions.has(extension);
}

/** The exact path `shell.openPath` would receive, after every authority check. */
export async function resolveOpenFileAppPath(request: OpenFileAppRequest, deps: OpenFileAppDependencies): Promise<string> {
  if ('externalId' in request) {
    const target = await deps.canonical(await deps.externalPath(request.externalId));
    assertOpenable(target);
    if (!(await deps.isFile(target))) throw new Error('This file is not a regular file');
    return target;
  }
  if (isAbsolute(request.path)) throw new Error('Invalid file path');
  const root = await deps.canonical(await deps.workspaceRoot(request));
  const target = await deps.canonical(resolve(root, request.path));
  if (!isWithinScope(root, target) || target === root) throw new Error('File is outside its project scope');
  assertOpenable(target);
  if (!(await deps.isFile(target))) throw new Error('This file is not a regular file');
  return target;
}

function assertOpenable(path: string): void {
  if (!canOpenFileWithSystemApp(path)) throw new Error('This file type cannot be opened with a system app');
}

export type OpenFileDefaultAppHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<void>;

export function createOpenFileDefaultAppHandler(
  deps: OpenFileAppDependencies,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  assertLocal: (event: IpcMainInvokeEvent) => void,
): OpenFileDefaultAppHandler {
  return async (event, input) => {
    assertTrusted(event);
    assertLocal(event);
    const target = await resolveOpenFileAppPath(parseOpenFileAppRequest(input), deps);
    const error = await deps.openPath(target);
    if (error) throw new Error(error);
  };
}

/** QA-only seam: the probe records the path instead of starting Word, Excel or a browser.
 * Ignored in a packaged build, like `THREADTERM_V3_OPEN_EXTERNAL_QA`. */
export function qaOpenFileAppRecordPath(envValue: string | undefined, isPackaged: boolean): string | undefined {
  if (isPackaged || envValue === undefined || envValue.trim() === '') return undefined;
  return isAbsolute(envValue) ? envValue : undefined;
}
