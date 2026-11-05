import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LocalFileBackend = 'runtime' | 'main';
export const isLocalFileBackend = (value: unknown): value is LocalFileBackend => value === 'runtime' || value === 'main';

/** Machine-local preference. No source contents or portable Runtime settings live here. */
export class LocalFileBackendConfig {
  constructor(readonly path: string) {}

  async load(): Promise<LocalFileBackend> {
    let text: string;
    try {
      if ((await stat(this.path)).size > 4096) return 'runtime';
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'runtime';
      throw error;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && 'version' in value && value.version === 1
        && 'backend' in value && isLocalFileBackend(value.backend)) return value.backend;
    } catch { /* Old or malformed preferences retain the original Runtime default. */ }
    return 'runtime';
  }

  async save(backend: LocalFileBackend): Promise<void> {
    if (!isLocalFileBackend(backend)) throw new Error('Invalid local file backend');
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ version: 1, backend })}\n`, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}
