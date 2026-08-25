import { invoke } from './helpers';

export type ProviderShell = 'pwsh' | 'windowsPowerShell' | 'cmd';
export type ProviderShellAvailability = 'available' | 'unavailable';

export const PROVIDER_SHELLS: readonly ProviderShell[] = [
  'pwsh',
  'windowsPowerShell',
  'cmd',
];

const SENTINEL_PREFIX = 'THREADTERM_PROVIDER_';
const SENTINEL_SUFFIX = 'SENTINEL_7E4B';
export const PROVIDER_SENTINEL = `${SENTINEL_PREFIX}${SENTINEL_SUFFIX}`;

const PROVIDER_BARRIER_TIMEOUT_MS = 20_000;
const PROVIDER_BARRIER_POLL_MS = 75;
const LIVE_SESSION_STATES = new Set([
  'idle',
  'running',
  'waitingforinput',
  'waiting_for_input',
]);

export type ProviderBarrierSnapshot = {
  expectedConcurrency: number;
  peakConcurrentAlive: number;
  barrierReleased: boolean;
};

function sessionStateName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const state = (value as { state?: unknown }).state;
  return typeof state === 'string' ? state : undefined;
}

function isLiveSessionState(value: unknown): boolean {
  const state = sessionStateName(value)?.replaceAll('-', '_').toLowerCase();
  return state !== undefined && LIVE_SESSION_STATES.has(state.replaceAll('_', ''));
}

async function observeLiveSession(ptyId: string): Promise<boolean> {
  const result = await invoke('pty_get_session_state', { ptyId });
  return result.ok && isLiveSessionState(result.value);
}

/**
 * A per-round barrier for independent PTYs.  It keeps identifiers in memory
 * only; reports receive counts and fixed booleans, never the identifiers.
 */
export class ProviderConcurrencyBarrier {
  private readonly expectedConcurrency: number;
  private readonly arrived = new Set<string>();
  private abortedError: string | undefined;
  private peakConcurrentAlive = 0;
  private barrierReleased = false;

  constructor(expectedConcurrency: number) {
    if (!Number.isSafeInteger(expectedConcurrency) || expectedConcurrency < 1) {
      throw new Error('provider-concurrency-invalid');
    }
    this.expectedConcurrency = expectedConcurrency;
  }

  snapshot(): ProviderBarrierSnapshot {
    return {
      expectedConcurrency: this.expectedConcurrency,
      peakConcurrentAlive: this.peakConcurrentAlive,
      barrierReleased: this.barrierReleased,
    };
  }

  abort(error: unknown): void {
    if (this.barrierReleased || this.abortedError) return;
    const message = error instanceof Error ? error.message : '';
    this.abortedError = message.startsWith('provider-')
      ? message
      : 'provider-concurrency-barrier-failed';
  }

  async arriveAndWait(ptyId: string): Promise<ProviderBarrierSnapshot> {
    if (this.abortedError) throw new Error(this.abortedError);
    if (this.arrived.has(ptyId)) {
      this.abort(new Error('provider-duplicate-session-identity'));
      throw new Error('provider-duplicate-session-identity');
    }
    if (this.arrived.size >= this.expectedConcurrency) {
      this.abort(new Error('provider-concurrency-barrier-overflow'));
      throw new Error('provider-concurrency-barrier-overflow');
    }
    this.arrived.add(ptyId);

    const deadline = Date.now() + PROVIDER_BARRIER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.abortedError) throw new Error(this.abortedError);
      if (this.barrierReleased) return this.snapshot();

      const observations = await Promise.all(
        [...this.arrived].map(async (id) => observeLiveSession(id)),
      );
      if (this.abortedError) throw new Error(this.abortedError);
      const alive = observations.filter(Boolean).length;
      this.peakConcurrentAlive = Math.max(this.peakConcurrentAlive, alive);
      if (alive !== observations.length) {
        this.abort(new Error('provider-session-not-alive'));
        throw new Error('provider-session-not-alive');
      }
      if (this.arrived.size === this.expectedConcurrency && alive === this.expectedConcurrency) {
        this.barrierReleased = true;
        return this.snapshot();
      }
      await browser.pause(Math.min(PROVIDER_BARRIER_POLL_MS, Math.max(1, deadline - Date.now())));
    }

    this.abort(new Error('provider-concurrency-barrier-timeout'));
    throw new Error('provider-concurrency-barrier-timeout');
  }
}

export async function assertProviderSessionWritable(ptyId: string): Promise<void> {
  if (!(await observeLiveSession(ptyId))) throw new Error('provider-session-not-alive');
}

export type ProviderSessionCleanup = {
  killRequested: boolean;
  disappeared: boolean;
};

export async function killProviderSessionAndConfirm(
  ptyId: string,
): Promise<ProviderSessionCleanup> {
  const initial = await invoke('pty_get_session_state', { ptyId });
  if (!initial.ok) return { killRequested: false, disappeared: true };

  const killed = await invoke('pty_kill', { id: ptyId });
  if (!killed.ok) return { killRequested: false, disappeared: false };

  const deadline = Date.now() + PROVIDER_BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await invoke('pty_get_session_state', { ptyId });
    if (!state.ok) return { killRequested: true, disappeared: true };
    await browser.pause(Math.min(PROVIDER_BARRIER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return { killRequested: true, disappeared: false };
}

/**
 * The command is intentionally assembled from two literals.  The shell
 * echoes the submitted line, so the complete sentinel must never be present
 * in that line; only command evaluation may produce it.
 */
export function syntheticProviderCommand(shell: ProviderShell): string {
  if (shell === 'pwsh' || shell === 'windowsPowerShell') {
    return `Write-Output ('${SENTINEL_PREFIX}' + '${SENTINEL_SUFFIX}')`;
  }
  return `"${canonicalCmdReceipt()}" /d /q /V:ON /C "set tt_prefix=${SENTINEL_PREFIX}&echo !tt_prefix!${SENTINEL_SUFFIX}"`;
}

/** Process-private runner receipt; paths never enter reports or IPC. */
export function canonicalCmdReceipt(): string {
  const value = process.env.THREADTERM_WDIO_PROVIDER_CMD_PATH;
  const diskPath = value?.startsWith('\\\\?\\') ? value.slice(4) : value;
  if (
    !value
    || !diskPath
    || diskPath.length < 3
    || !/^[A-Za-z]:\\/.test(diskPath)
    || value.includes('/')
    || value.startsWith('\\\\.\\')
    || value.toLowerCase().startsWith('\\\\?\\unc\\')
    || /['"`$&|<>^%()!]/.test(value)
    || value.slice(value.lastIndexOf('\\') + 1).toLowerCase() !== 'cmd.exe'
  ) {
    throw new Error('provider-cmd-shell-receipt-missing');
  }
  return value;
}

export function harnessShellValue(shell: ProviderShell): ProviderShell {
  return shell;
}

export function shellAvailability(shell: ProviderShell): ProviderShellAvailability {
  const envName = shell === 'pwsh'
    ? 'THREADTERM_WDIO_PROVIDER_PWSH_AVAILABLE'
    : shell === 'windowsPowerShell'
      ? 'THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_AVAILABLE'
      : 'THREADTERM_WDIO_PROVIDER_CMD_AVAILABLE';
  const value = process.env[envName];
  if (value === '1') {
    if (shell === 'cmd') {
      try {
        canonicalCmdReceipt();
      } catch {
        return 'unavailable';
      }
    }
    return 'available';
  }
  if (value === '0') return 'unavailable';
  throw new Error('provider-shell-availability-missing');
}

export type ProviderUnavailableSample = {
  slot: number;
  repetition: number;
};

/**
 * Expand an unavailable-shell observation to the same sample cardinality as
 * the requested matrix round.  This is pure so it can be checked without a
 * WebDriver session or a Tauri process.
 */
export function providerUnavailableSamplePlan(
  expectedConcurrency: number,
  repetitions: number,
): ProviderUnavailableSample[] {
  if (
    !Number.isSafeInteger(expectedConcurrency)
    || expectedConcurrency < 1
    || !Number.isSafeInteger(repetitions)
    || repetitions < 1
  ) {
    throw new Error('provider-concurrency-invalid');
  }
  return Array.from({ length: repetitions }, (_, repetition) =>
    Array.from({ length: expectedConcurrency }, (_, slot) => ({
      slot: slot + 1,
      repetition: repetition + 1,
    }))).flat();
}

export function countExactOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const found = value.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function startupState(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = value as { state?: unknown };
  return typeof snapshot.state === 'string' ? snapshot.state : undefined;
}

export async function waitForStartupSent(ptyId: string, generation: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await invoke('pty_get_startup_state', { ptyId, generation });
    if (result.ok && startupState(result.value) === 'sent') return;
    if (result.ok && ['failed', 'cancelled'].includes(startupState(result.value) ?? '')) {
      throw new Error('provider-startup-terminal-state');
    }
    await browser.pause(75);
  }
  throw new Error('provider-startup-sent-timeout');
}

export async function waitForSentinelExactlyOnce(ptyId: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  let observed = 0;
  while (Date.now() < deadline) {
    const result = await invoke('pty_get_recent_output', { ptyId });
    const output = result.ok && typeof result.value === 'string' ? result.value : '';
    observed = countExactOccurrences(output, PROVIDER_SENTINEL);
    if (observed > 1) throw new Error('provider-sentinel-duplicate');
    if (observed === 1) {
      // Keep a short quiet window so a delayed second dispatch cannot pass on
      // the first read. This is only an output count; no bytes cross the report.
      const quietDeadline = Date.now() + 500;
      while (Date.now() < quietDeadline) {
        await browser.pause(100);
        const followUp = await invoke('pty_get_recent_output', { ptyId });
        if (!followUp.ok) continue;
        const followUpOutput = typeof followUp.value === 'string' ? followUp.value : '';
        observed = countExactOccurrences(followUpOutput, PROVIDER_SENTINEL);
        if (observed > 1) throw new Error('provider-sentinel-duplicate');
      }
      return observed;
    }
    await browser.pause(100);
  }
  throw new Error('provider-sentinel-missing');
}
