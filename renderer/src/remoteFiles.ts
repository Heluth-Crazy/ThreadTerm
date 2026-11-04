import type { AttachedFile, PageShot } from '@threadterm/protocol';

export type RemoteFilesBridge = {
  uploadClientFiles(sessionId: string, paths: string[]): Promise<string[]>;
  readAttachPaths(paths: string[]): Promise<AttachedFile[]>;
  persistPageShot(shotId: string, sessionId?: string, projectId?: string, root?: string): Promise<{ id: string; path: string }>;
  onHostFiles(listener: (request: HostFilesRequest) => void): () => void;
  completeHostFiles(id: string, paths: string[]): Promise<void>;
};
export type HostFilesRequest = { id: string; mode: 'directory' | 'files' | 'reveal'; path?: string; selectedPath?: string };
const adapter = () => window.threadterm as typeof window.threadterm & Partial<RemoteFilesBridge> & { machineId?: string };
export const isRemoteFiles = () => typeof window !== 'undefined' && Boolean(adapter().machineId && adapter().machineId !== 'local');

export async function uploadRemotePaths(sessionId: string, paths: string[]): Promise<string[]> {
  if (!isRemoteFiles()) return paths;
  if (!adapter().uploadClientFiles) throw new Error('Remote file uploads are unavailable');
  return adapter().uploadClientFiles!(sessionId, paths);
}

export async function persistRemotePageShot(shot: PageShot, sessionId?: string, projectId?: string, root?: string): Promise<PageShot> {
  if (!isRemoteFiles()) return shot;
  if (!adapter().persistPageShot) throw new Error('Remote screenshot uploads are unavailable');
  return { ...shot, ...await adapter().persistPageShot!(shot.id, sessionId, projectId, root) };
}

export async function readRemoteDropPaths(paths: string[]): Promise<AttachedFile[]> {
  if (!isRemoteFiles() || !adapter().readAttachPaths) throw new Error('Remote file uploads are unavailable');
  return adapter().readAttachPaths!(paths);
}
