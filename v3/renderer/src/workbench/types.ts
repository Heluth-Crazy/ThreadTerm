import type { GitStatus } from '@threadterm/protocol';
import type { AgentReference } from './agentReference';

/** A registered project root or worktree the side bar operates on. */
export type WorkbenchScope = { projectId:string; worktreePath?:string; rootPath:string };

/** Host callbacks; content always opens through the host's tab/pane rules. */
export type WorkbenchActions = {
 openFile:(path:string, position?:{line?:number;column?:number}) => void;
 /** Opens the file as a preview owned by the active session (hidden when switching sessions). */
 openBeside?:(path:string) => void;
 openDiff:(path:string, staged:boolean) => void;
 /** Absent when the host has no history tab (standalone Files page). */
 openHistory?:(path?:string) => void;
 openReview?:(target:{sessionId:string;checkpointId:string;toCheckpointId?:string;path:string}) => void;
 /** Absent when no agent session can receive a reference. */
 sendToAgent?:(reference:AgentReference) => void;
 /** Paths with unsaved editor changes; rename/delete refuse to touch them. */
 dirtyPaths:() => string[];
 renamed:(from:string, to:string) => void;
 deleted:(path:string) => void;
};

export type GitState = { status?:GitStatus; error?:string; loading:boolean; refresh:() => Promise<void> };

/** Fired after a workbench tab writes files, so side-bar lists refresh now instead of on their next poll. */
export const FILES_CHANGED_EVENT = 'threadterm:workbench-files-changed';
export const notifyFilesChanged = () => { dispatchEvent(new Event(FILES_CHANGED_EVENT)); };

export const scopeParams = (scope:Pick<WorkbenchScope,'projectId'|'worktreePath'>) => ({projectId:scope.projectId, ...(scope.worktreePath ? {worktreePath:scope.worktreePath} : {})});

export const joinPath = (dir:string, name:string) => dir ? `${dir}/${name}` : name;
export const parentPath = (path:string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const baseName = (path:string) => path.slice(path.lastIndexOf('/') + 1);
export const absolutePath = (root:string, path:string) => {
 const separator = root.includes('\\') ? '\\' : '/';
 return `${root.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
};
/** True when `path` is `target` or lies inside the folder `target`. */
export const coveredBy = (path:string, target:string) => path === target || path.startsWith(`${target}/`);
