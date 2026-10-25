import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

test('Electron QA lock is released when its holder receives a termination signal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tt-electron-lock-'));
  const lock = join(directory, 'qa-electron.lock');
  const moduleUrl = new URL('./lib/electron-lock.mjs', import.meta.url).href;
  try {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', `
        import { acquireElectronQaLock } from ${JSON.stringify(moduleUrl)};
        await acquireElectronQaLock({ directory: ${JSON.stringify(directory)} });
        process.send?.('locked');
        process.on('message', received => process.emit(received));
        setInterval(() => {}, 1_000);
      `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      try {
        await once(child, 'message');
        if (process.platform === 'win32') child.send(signal);
        else child.kill(signal);
        await Promise.race([
          once(child, 'exit'),
          new Promise((_, reject) => setTimeout(() => reject(Error(`child did not exit after ${signal}`)), 1_000)),
        ]);
        await assert.rejects(stat(lock), { code: 'ENOENT' });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Electron QA lock is released when its holder exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tt-electron-lock-'));
  const lock = join(directory, 'qa-electron.lock');
  const moduleUrl = new URL('./lib/electron-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { acquireElectronQaLock } from ${JSON.stringify(moduleUrl)};
    await acquireElectronQaLock({ directory: ${JSON.stringify(directory)} });
    process.exit(0);
  `]);
  try {
    await once(child, 'exit');
    await assert.rejects(stat(lock), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
