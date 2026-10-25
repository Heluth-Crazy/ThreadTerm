import { mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Shared with older harnesses that mkdir TEMP/qa-electron.lock directly.
export async function acquireElectronQaLock({ directory = tmpdir(), timeoutMs = 40 * 60_000, retryMs = 15_000 } = {}) {
  const lock = join(directory, 'qa-electron.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      console.log('Waiting for shared Electron QA lock');
      await delay(Math.min(retryMs, Math.max(0, deadline - Date.now())));
    }
  }
  let held = true;
  return async () => { if (held) { await rmdir(lock); held = false; } };
}
