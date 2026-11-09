/** Public machine metadata only. Credentials stay in Electron main. */
export type MachineState = 'local' | 'connecting' | 'connected' | 'disconnected' | 'incompatible' | 'pin-mismatch';
export interface MachineInfo { id: string; name: string; color: string; state: MachineState; message?: string }
export interface MachineSnapshot { enabled: boolean; currentId: string; machines: MachineInfo[] }
export type MachineNavigation = { action: 'new-session'; projectId?: string; path?: string } | { action: 'add-project' };
export interface MachineBridge {
  readonly machineId: string;
  machineList(): Promise<MachineSnapshot>;
  machineShow(id: string, sessionId?: string, navigation?: MachineNavigation): Promise<void>;
  machineSettings(): Promise<void>;
  machineTree(): Promise<MachineTreeFeed>;
  machineExpand(key: string, expanded: boolean): Promise<void>;
  onMachineTree(listener: (feed: MachineTreeFeed) => void): () => void;
  machinePrepare(text: string): Promise<{ checkCode: string; endpoint: string }>;
  machineAdd(options: { name: string; color: string }): Promise<MachineInfo>;
  machineRemove(id: string): Promise<void>;
  onMachinesChanged(listener: () => void): () => void;
}

/** Parent identity and lifecycle are enough for nesting and the finished-delegate fold. */
export type MachineTreeSessionMetadata = Pick<import('@threadterm/protocol').Session,
  'id' | 'title' | 'provider' | 'mode' | 'status' | 'createdAt' | 'updatedAt' | 'projectId' | 'worktreePath'
  | 'exitCode' | 'readOnly' | 'released' | 'archived' | 'activity' | 'terminalAgent'> & {
  delegation?: Pick<import('@threadterm/protocol').SessionDelegation, 'parentSessionId' | 'state'>;
};
export interface MachineTreeSession { session: MachineTreeSessionMetadata; needsYou: number }
export interface MachineTree { machine: MachineInfo; projects: import('@threadterm/protocol').Project[]; worktrees: import('@threadterm/protocol').Worktree[]; sessions: MachineTreeSession[]; needsYou: number }
export interface MachineTreeFeed { machines: MachineTree[]; expanded: Record<string, boolean> }
/** JSON tuple encoding also avoids collisions when ids/paths contain separators. */
export const machineTreeKey = (machineId: string, kind: string, id: string) => JSON.stringify([machineId, kind, id]);
