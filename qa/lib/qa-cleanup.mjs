import {rm} from 'node:fs/promises';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = child => !child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null;

export function waitForChildExit(child, {label = 'child process', timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimer(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const timer = setTimer(() => { cleanup(); reject(new Error(`${label} did not exit within ${timeoutMs} ms`)); }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function stopChild(child, {label = 'child process', gracefulTimeoutMs = 10_000, forcedTimeoutMs = 5_000, wait = waitForChildExit} = {}) {
  if (exited(child)) return;
  const gracefulExit = wait(child, {label, timeoutMs: gracefulTimeoutMs});
  child.kill();
  try {
    await gracefulExit;
  } catch (gracefulError) {
    if (exited(child)) return;
    const forcedExit = wait(child, {label: `${label} after forced termination`, timeoutMs: forcedTimeoutMs});
    child.kill('SIGKILL');
    try {
      await forcedExit;
    } catch (forcedError) {
      forcedError.cause = gracefulError;
      throw forcedError;
    }
  }
}

export async function removeScratch(path, {rmImpl = rm, maxRetries = 10, retryDelayMs = 200, sleepImpl = sleep} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rmImpl(path, {recursive: true, force: true, maxRetries: 0});
      return;
    } catch (error) {
      const retryable = error?.code === 'EBUSY' || error?.code === 'EPERM';
      if (!retryable || attempt >= maxRetries) throw error;
      await sleepImpl(retryDelayMs);
    }
  }
}
