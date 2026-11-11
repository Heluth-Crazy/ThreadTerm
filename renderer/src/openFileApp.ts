import { openFileDefaultApp } from './bridge';
import { isRemoteFiles } from './remoteFiles';

/** The renderer uses the same list only to decide whether to show the action; main is the authority
 * (`design.md` §5, R20). */
export const OPEN_FILE_APP_EXTENSIONS = [
  '.docx', '.docm', '.doc', '.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.pptx', '.ppt', '.pdf',
];
const allowed = new Set(OPEN_FILE_APP_EXTENSIONS);

export type OpenFileAppTarget = { projectId: string; worktreePath?: string; path: string; externalId?: string };

export function canOpenWithSystemApp(path: string | undefined): boolean {
  if (!path || isRemoteFiles()) return false;
  const name = path.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && allowed.has(name.slice(dot).toLowerCase());
}

/** R20: one action; hidden on a remote machine and refused by main for every other extension. */
export async function openWithSystemApp(target: OpenFileAppTarget, zh: boolean, onIssue?: (message: string) => void): Promise<void> {
  if (!canOpenWithSystemApp(target.path)) return;
  try {
    await openFileDefaultApp(target.externalId
      ? { externalId: target.externalId }
      : { projectId: target.projectId, ...(target.worktreePath ? { worktreePath: target.worktreePath } : {}), path: target.path });
  } catch {
    onIssue?.(zh ? '无法用系统应用打开此文件。' : 'Could not open this file with a system app.');
  }
}
