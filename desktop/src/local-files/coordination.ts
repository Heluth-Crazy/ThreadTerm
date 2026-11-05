import { isRecord } from '@threadterm/protocol';

export const localFileCommands = [
  'desktop.files.access.begin', 'desktop.files.access.release',
  'desktop.files.context',
  'desktop.files.external.get', 'desktop.files.external.list',
  'desktop.files.external.open', 'desktop.files.external.forget',
  'desktop.files.mutation.begin', 'desktop.files.mutation.complete', 'desktop.files.mutation.abort',
] as const;
export type LocalFileCommand = typeof localFileCommands[number];
export type LocalFileCoordination = (command: string, params: Record<string, unknown>) => Promise<unknown>;
/** Only a proven pre-send failure or definitive Runtime admission refusal may use this marker. */
export class LocalFileAccessNotCreatedError extends Error {}
export const isLocalFileCommand = (value: unknown): value is LocalFileCommand =>
  typeof value === 'string' && (localFileCommands as readonly string[]).includes(value);

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\x00-\x1f\x7f]/.test(value);
export interface WorkspaceContext { kind: 'workspace'; projectId: string; rootPath: string; worktreePath?: string }
export function isWorkspaceContext(value: unknown): value is WorkspaceContext {
  return isRecord(value) && value.kind === 'workspace' && text(value.projectId) && text(value.rootPath)
    && (value.worktreePath === undefined || text(value.worktreePath));
}
function externalRow(value: unknown): boolean {
  return isRecord(value) && text(value.id) && text(value.canonicalPath) && text(value.name)
    && text(value.openedAt) && ['dialog', 'drop', 'link', 'recent'].includes(String(value.source));
}

/** The private response never bypasses validation just because it stays in main. */
export function validateLocalFileResult(command: LocalFileCommand, value: unknown): void {
  let valid = false;
  switch (command) {
    case 'desktop.files.access.begin': valid = isRecord(value) && text(value.accessId); break;
    case 'desktop.files.access.release': valid = value === null; break;
    case 'desktop.files.context':
      valid = isWorkspaceContext(value) || isRecord(value) && value.kind === 'session'
        && text(value.sessionId) && text(value.projectId) && text(value.rootPath) && text(value.cwd)
        && text(value.provider) && text(value.mode) && typeof value.relativeRequiresAbsolute === 'boolean'
        && (value.worktreePath === undefined || text(value.worktreePath));
      break;
    case 'desktop.files.external.get': case 'desktop.files.external.open': valid = externalRow(value); break;
    case 'desktop.files.external.list': valid = isRecord(value) && Array.isArray(value.files) && value.files.length <= 30 && value.files.every(externalRow); break;
    case 'desktop.files.external.forget': case 'desktop.files.mutation.abort': valid = value === null; break;
    case 'desktop.files.mutation.begin':
      valid = isRecord(value) && (value.kind === 'replay' && Object.hasOwn(value, 'result')
        || value.kind === 'execute' && text(value.reservationId) && text(value.projectId) && text(value.rootPath)
        && (value.worktreePath === undefined || text(value.worktreePath)));
      break;
    case 'desktop.files.mutation.complete': valid = value === null || isRecord(value); break;
  }
  if (!valid) throw new Error(`Invalid local file coordination response: ${command}`);
}
