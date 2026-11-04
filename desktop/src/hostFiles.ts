import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { deletedRevealScope, revealTarget } from './revealFile.js';
import type { RuntimeClient } from './runtime-client.js';
import type { HostFilesRequest } from '../../renderer/src/remoteFiles.js';

type Sender = { id: number; send(channel: string, value: unknown): void; once(event: 'destroyed', listener: () => void): unknown; removeListener(event: 'destroyed', listener: () => void): unknown };

/** Dialog completion is bound to the originating machine renderer. */
export class HostFilePickers {
  private readonly pending = new Map<string, { senderId: number; finish(paths: string[]): void }>();
  choose(sender: Sender, mode: 'directory' | 'files'): Promise<string[]> {
    const id = randomUUID();
    return new Promise(resolve => {
      const cancel = () => finish([]);
      const finish = (paths: string[]) => { this.pending.delete(id); sender.removeListener('destroyed', cancel); resolve(paths); };
      this.pending.set(id, { senderId: sender.id, finish }); sender.once('destroyed', cancel);
      sender.send('threadterm:host-files', { id, mode } satisfies HostFilesRequest);
    });
  }
  complete(senderId: number, id: unknown, paths: unknown): void {
    if (typeof id !== 'string' || !Array.isArray(paths) || paths.length > 10 || !paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= 16384 && !/[\u0000-\u001f\u007f]/.test(path))) throw new Error('Invalid host file selection');
    const pending = this.pending.get(id);
    if (!pending || pending.senderId !== senderId) throw new Error('Host file dialog belongs to another window');
    pending.finish(paths);
  }
}

export async function hostRevealTarget(runtime: Pick<RuntimeClient, 'request'>, sessionId: string, path: string): Promise<{ path: string; selectedPath: string }> {
  try {
    const resolved = await runtime.request('filesystem.resolve', { sessionId, path });
    if (!resolved.worktreePath) throw new Error('File project scope is unavailable');
    const target = join(resolved.worktreePath, resolved.path);
    return { path: dirname(target), selectedPath: target };
  } catch (error) {
    // Navigation does not need the resolver's text/image bytes or their preview size limits.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (!['file_too_large', 'image_too_large', 'unsupported_image', 'file_reference_not_found'].includes(String(code))) throw error;
    const scope = deletedRevealScope(await runtime.request('runtime.snapshot', {}), sessionId);
    const target = revealTarget({ worktreePath: scope, path }, scope);
    return { path: dirname(target.path), selectedPath: target.path };
  }
}
