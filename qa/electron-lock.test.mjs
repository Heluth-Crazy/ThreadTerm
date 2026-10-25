import assert from 'node:assert/strict';
import { mkdtemp, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

test('Electron QA lock excludes overlapping runs and releases after failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tt-electron-lock-'));
  let release;
  try {
    release = await acquireElectronQaLock({ directory });
    await assert.rejects(acquireElectronQaLock({ directory, timeoutMs: 0 }), { code: 'EEXIST' });
    const next = acquireElectronQaLock({ directory, retryMs: 5, timeoutMs: 1000 });
    await release();
    release = await next;
    await assert.rejects(async () => { try { throw Error('fixture failed'); } finally { await release(); } }, /fixture failed/);
    await release();
    await assert.rejects(stat(join(directory, 'qa-electron.lock')), { code: 'ENOENT' });
  } finally { await release?.(); await rmdir(directory); }
});
