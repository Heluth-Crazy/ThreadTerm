/** A file dragged from the Explorer to a session pane. Only ThreadTerm reads this type: other drop targets
 * (editors, other apps, the tab bar) see nothing they would insert. */
export const FILE_DRAG_TYPE = "application/x-threadterm-file";

export type DraggedFile = { projectId: string; worktreePath?: string; path: string; externalId?: string };

const plain = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export function fileDragData(file: DraggedFile): string {
  return JSON.stringify({ projectId: file.projectId, ...(file.worktreePath ? { worktreePath: file.worktreePath } : {}), path: file.path, ...(file.externalId ? {externalId:file.externalId} : {}) });
}

/** The dropped file, or undefined for anything that is not one relative path inside a project or worktree. */
export function readFileDrag(data: string): DraggedFile | undefined {
  if (!data || data.length > 65_536) return undefined;
  let value: unknown;
  try { value = JSON.parse(data); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { projectId, worktreePath, path, externalId } = value as Record<string, unknown>;
  if (!plain(projectId, 256) || !plain(path, externalId===undefined?4096:16_384) || (worktreePath !== undefined && !plain(worktreePath, 4096))) return undefined;
  if(externalId!==undefined){
    if(!plain(externalId,256)||/[\u0080-\u009f]/.test(externalId)||/[\u0080-\u009f]/.test(path)||new TextEncoder().encode(path).length>16_384||!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path))return undefined;
    return {projectId,...(worktreePath?{worktreePath}:{}),path,externalId};
  }
  const segments = path.split(/[\\/]/);
  if (/^(?:[\\/]|[a-z]:)/i.test(path) || segments.some(segment => segment === ".." || segment === "")) return undefined;
  return { projectId, ...(worktreePath ? { worktreePath } : {}), path };
}
