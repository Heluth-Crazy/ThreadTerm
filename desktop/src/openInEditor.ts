import type { IpcMainInvokeEvent } from 'electron';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isWithinScope } from './revealFile.js';

/*
 * "Open in" (owner 2026-11-26, after T3 Code's Open-in picker): a project, a branch's folder or a file at its line, in
 * the editor or terminal the user picks. Only programs found in their standard install folders are offered, each by
 * its own executable with an argument list (never a shell command line), and every target is checked against the
 * project's own root from the runtime's records, like "Open with system app" (`openFileApp.ts`).
 */

export type OpenInStyle = 'goto' | 'line' | 'path-line' | 'terminal';
export interface OpenInEditor { id: string; label: string; exe: string; style: OpenInStyle }
interface EditorDefinition { id: string; label: string; style: OpenInStyle; candidates(env: OpenInEnvironment): string[] }

export interface OpenInEnvironment { localAppData?: string; programFiles?: string; programFilesX86?: string }

const JETBRAINS: [string, string, string][] = [
  ['idea', 'IntelliJ IDEA', 'idea64.exe'], ['pycharm', 'PyCharm', 'pycharm64.exe'], ['webstorm', 'WebStorm', 'webstorm64.exe'],
  ['goland', 'GoLand', 'goland64.exe'], ['clion', 'CLion', 'clion64.exe'], ['rider', 'Rider', 'rider64.exe'],
  ['rustrover', 'RustRover', 'rustrover64.exe'], ['phpstorm', 'PhpStorm', 'phpstorm64.exe'], ['android-studio', 'Android Studio', 'studio64.exe'],
];
const roots = (env: OpenInEnvironment) => [env.localAppData && join(env.localAppData, 'Programs'), env.programFiles, env.programFilesX86].filter((root): root is string => Boolean(root));

/** In picker order: VS Code-family editors, Zed, the JetBrains IDEs, then Windows Terminal. */
export const EDITOR_DEFINITIONS: readonly EditorDefinition[] = [
  { id: 'vscode', label: 'VS Code', style: 'goto', candidates: env => roots(env).map(root => join(root, 'Microsoft VS Code', 'Code.exe')) },
  { id: 'vscode-insiders', label: 'VS Code Insiders', style: 'goto', candidates: env => roots(env).map(root => join(root, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')) },
  { id: 'cursor', label: 'Cursor', style: 'goto', candidates: env => roots(env).map(root => join(root, 'cursor', 'Cursor.exe')) },
  { id: 'windsurf', label: 'Windsurf', style: 'goto', candidates: env => roots(env).map(root => join(root, 'Windsurf', 'Windsurf.exe')) },
  { id: 'zed', label: 'Zed', style: 'path-line', candidates: env => roots(env).map(root => join(root, 'Zed', 'Zed.exe')) },
  // JetBrains IDEs are found by `jetbrainsExecutables` (their folders carry a version).
  ...JETBRAINS.map(([id, label]): EditorDefinition => ({ id, label, style: 'line', candidates: () => [] })),
  { id: 'terminal', label: 'Windows Terminal', style: 'terminal', candidates: env => env.localAppData ? [join(env.localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')] : [] },
];

export interface OpenInFileSystem { exists(path: string): boolean; list(path: string): string[] }

/** The JetBrains IDE executables under `JetBrains\<version>\bin` (installer) and `Programs\<name>\bin` (Toolbox 2). */
function jetbrainsExecutables(env: OpenInEnvironment, fs: OpenInFileSystem): Map<string, string> {
  const found = new Map<string, string>();
  const folders: string[] = [];
  for (const root of [env.programFiles, env.programFilesX86].filter((value): value is string => Boolean(value))) {
    const vendor = join(root, 'JetBrains');
    if (fs.exists(vendor)) folders.push(...fs.list(vendor).map(name => join(vendor, name)));
  }
  if (env.localAppData) {
    const programs = join(env.localAppData, 'Programs');
    if (fs.exists(programs)) folders.push(...fs.list(programs).map(name => join(programs, name)));
  }
  // Newest folder name last, so a later version wins.
  for (const folder of folders.sort()) {
    for (const [id, , exe] of JETBRAINS) {
      const path = join(folder, 'bin', exe);
      if (fs.exists(path)) found.set(id, path);
    }
  }
  return found;
}

/** The editors installed on this PC. */
export function detectEditors(env: OpenInEnvironment, fs: OpenInFileSystem): OpenInEditor[] {
  const jetbrains = jetbrainsExecutables(env, fs);
  const out: OpenInEditor[] = [];
  for (const definition of EDITOR_DEFINITIONS) {
    const exe = jetbrains.get(definition.id) ?? definition.candidates(env).find(path => fs.exists(path));
    if (exe) out.push({ id: definition.id, label: definition.label, exe, style: definition.style });
  }
  return out;
}

/** The argument list for one launch. A folder opens as a workspace; a file opens at its line where the editor can. */
export function editorArguments(editor: Pick<OpenInEditor, 'style'>, target: { path: string; directory: boolean; line?: number }): string[] {
  const line = target.line !== undefined && Number.isSafeInteger(target.line) && target.line > 0 ? target.line : undefined;
  switch (editor.style) {
    case 'terminal': return ['-d', target.directory ? target.path : dirname(target.path)];
    case 'goto': return target.directory || !line ? [target.path] : ['--goto', `${target.path}:${line}`];
    case 'line': return target.directory || !line ? [target.path] : ['--line', String(line), target.path];
    case 'path-line': return [target.directory || !line ? target.path : `${target.path}:${line}`];
  }
}

export type OpenInRequest = { editorId: string; projectId: string; worktreePath?: string; path?: string; line?: number };

const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

/** Strict keys and bounded strings, like the other file commands. `path` is relative to the project or branch root. */
export function parseOpenInRequest(value: unknown): OpenInRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid open request');
  const data = value as Record<string, unknown>;
  if (!Object.keys(data).every(key => ['editorId', 'projectId', 'worktreePath', 'path', 'line'].includes(key))
    || !text(data.editorId, 64) || !text(data.projectId, 256)
    || data.worktreePath !== undefined && !text(data.worktreePath, 4096)
    || data.path !== undefined && !text(data.path, 16384)
    || data.line !== undefined && !(Number.isSafeInteger(data.line) && (data.line as number) > 0)) {
    throw new Error('Invalid open request');
  }
  return data as OpenInRequest;
}

export interface OpenInDependencies {
  editors(): OpenInEditor[];
  workspaceRoot(request: { projectId: string; worktreePath?: string }): Promise<string>;
  canonical(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  /** Starts the program detached; resolves once it started. */
  launch(exe: string, args: string[], cwd: string): Promise<void>;
}

/** The program and arguments a request starts, after every check. */
export async function resolveOpenIn(request: OpenInRequest, deps: Pick<OpenInDependencies, 'editors' | 'workspaceRoot' | 'canonical' | 'isDirectory'>) {
  const editor = deps.editors().find(row => row.id === request.editorId);
  if (!editor) throw new Error('That editor is not installed');
  if (request.path !== undefined && isAbsolute(request.path)) throw new Error('Invalid file path');
  const root = await deps.canonical(await deps.workspaceRoot(request));
  const target = request.path === undefined ? root : await deps.canonical(resolve(root, request.path));
  if (!isWithinScope(root, target)) throw new Error('The path is outside its project');
  const directory = await deps.isDirectory(target);
  return { editor, args: editorArguments(editor, { path: target, directory, line: request.line }), cwd: directory ? target : dirname(target), name: basename(target) };
}

export function createOpenInHandler(
  deps: OpenInDependencies,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  assertLocal: (event: IpcMainInvokeEvent) => void,
): (event: IpcMainInvokeEvent, input: unknown) => Promise<void> {
  return async (event, input) => {
    assertTrusted(event);
    assertLocal(event);
    const { editor, args, cwd } = await resolveOpenIn(parseOpenInRequest(input), deps);
    await deps.launch(editor.exe, args, cwd);
  };
}
