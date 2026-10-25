import { rmdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  const releaseSync = () => {
    if (!held) return;
    try { rmdirSync(lock); held = false; }
    catch (error) { if (error.code === 'ENOENT') held = false; else throw error; }
  };
  const removeCleanupHooks = () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  const onExit = () => { try { releaseSync(); } catch {} };
  const onSignal = signal => {
    try { releaseSync(); } catch {}
    removeCleanupHooks();
    process.kill(process.pid, signal);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return async () => {
    releaseSync();
    removeCleanupHooks();
  };
}
