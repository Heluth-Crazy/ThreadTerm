import { request } from '../bridge';
import { conflictBlocks } from './conflictBlocks';
import type { WorkbenchScope } from './types';

export type ConflictSavedState = { kind: 'clear' | 'markers' | 'unparseable' | 'unknown'; fingerprint?: string };

/** Inspect saved bytes, never the unsaved editor buffer. */
export async function readConflictState(scope: Pick<WorkbenchScope, 'projectId' | 'worktreePath'>, path: string): Promise<ConflictSavedState> {
  try {
    const file = await request('filesystem.read', { projectId: scope.projectId, worktreePath: scope.worktreePath, path });
    const parsed = conflictBlocks(file.content);
    return { kind: parsed.blocks.length ? 'markers' : parsed.unparseable ? 'unparseable' : 'clear', fingerprint: file.fingerprint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A both-deleted conflict has no worktree file to inspect.
    if (/\bfile_not_found\b/.test(message)) return { kind: 'clear' };
    return { kind: 'unknown' };
  }
}

export function conflictStageReason(state: ConflictSavedState | undefined, zh: boolean): string | undefined {
  if (!state) return zh ? '正在检查已保存文件中的冲突标记…' : 'Checking the saved file for conflict markers…';
  if (state.kind === 'markers') return zh ? '已保存文件仍包含冲突标记。请解决所有冲突并保存后再暂存。' : 'The saved file still contains conflict markers. Resolve all conflicts and save before staging.';
  return undefined;
}

export const malformedConflictWarning = (zh: boolean) => zh
  ? '冲突标记不完整或存在嵌套，无法安全解析。仍要暂存此文件吗？'
  : 'Conflict markers are malformed or nested and cannot be parsed safely. Stage this file anyway?';

export const unknownConflictWarning = (zh: boolean) => zh
  ? '无法检查此文件中的冲突标记。仍要暂存吗？'
  : 'This file could not be checked for conflict markers. Stage anyway?';

export type ConflictStageReview = { fingerprints: Record<string, string>; warnings: Record<string, ConflictSavedState> };

/** Every staging entry point checks saved bytes immediately before its mutation. */
export async function reviewConflictStage(
  scope: Pick<WorkbenchScope, 'projectId' | 'worktreePath'>,
  paths: readonly string[], zh: boolean,
  confirmed?: Record<string, ConflictSavedState>,
  read = readConflictState,
): Promise<ConflictStageReview> {
  const fingerprints = new Map<string, string>(), warnings = new Map<string, ConflictSavedState>();
  for (const [index, path] of [...new Set(paths)].entries()) {
    const state: ConflictSavedState = index < 100 ? await read(scope, path) : {kind:'unknown'};
    const blocked = conflictStageReason(state, zh);
    if (blocked) throw Error(blocked);
    const previous = confirmed && Object.hasOwn(confirmed, path) ? confirmed[path] : undefined;
    if (previous?.fingerprint !== undefined && previous.fingerprint !== state.fingerprint) throw Error('file_conflict');
    if ((state.kind === 'unknown' || state.kind === 'unparseable') && previous?.kind !== state.kind) warnings.set(path, state);
    if (state.fingerprint) fingerprints.set(path, state.fingerprint);
  }
  return { fingerprints: Object.fromEntries(fingerprints), warnings: Object.fromEntries(warnings) };
}
