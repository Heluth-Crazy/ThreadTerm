import { LocalFileAccessNotCreatedError, validateLocalFileResult, type LocalFileCoordination } from './coordination.js';
import { randomUUID } from 'node:crypto';

/** Runtime-visible lifetime for Node I/O; only release messages may be retried. */
export class LocalFileAccess {
  private readonly settled = new Set<string>();

  constructor(private readonly coordination: LocalFileCoordination) {}

  async run<T>(action: (accessId: string) => Promise<T>, write = false): Promise<T> {
    await this.flush();
    const accessId = randomUUID();
    let releaseRequired = true;
    try {
      const opened = await this.coordination('desktop.files.access.begin', { accessId, pid: process.pid, write }).catch(error => {
        if (error instanceof LocalFileAccessNotCreatedError) releaseRequired = false;
        throw error;
      });
      validateLocalFileResult('desktop.files.access.begin', opened);
      if ((opened as { accessId: string }).accessId !== accessId) throw new Error('Invalid local file access identity');
      return await action(accessId);
    } finally {
      // A lost release response must not erase the original file result/error.
      // Keep its id so a later operation, lifecycle change or quit can retry safely.
      if (releaseRequired) {
        this.settled.add(accessId);
        await this.release(accessId).catch(() => {});
      }
    }
  }

  async flush(): Promise<void> {
    for (const accessId of [...this.settled]) await this.release(accessId);
  }

  private async release(accessId: string): Promise<void> {
    const result = await this.coordination('desktop.files.access.release', { accessId });
    validateLocalFileResult('desktop.files.access.release', result);
    this.settled.delete(accessId);
  }
}
