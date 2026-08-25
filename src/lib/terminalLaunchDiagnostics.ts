/**
 * Small, bounded launch trace for the terminal hot path.
 *
 * The trace deliberately contains no cwd, command line, environment, or PTY
 * output. Frontend and backend clocks are kept as separate domains because a
 * Tauri event cannot provide a trustworthy shared monotonic clock.
 */

export type TerminalLaunchDomain = 'frontend' | 'backend';

export type TerminalLaunchPhase =
  | 'uiRequest'
  | 'xtermOpened'
  | 'providerEnvStarted'
  | 'providerEnvReady'
  | 'spawnGateWaitStarted'
  | 'spawnGateAcquired'
  | 'openPtyStarted'
  | 'openPtyReady'
  | 'childSpawned'
  | 'ptyCreateReturned'
  | 'firstRawByte'
  | 'shellReady'
  | 'xtermWriteStarted'
  | 'xtermWriteCompleted'
  | 'firstPaint'
  | 'startupCommandSent'
  | 'firstPostCommandByte'
  | 'connected'
  | 'failed';

export interface TerminalLaunchPhaseRecord {
  phase: TerminalLaunchPhase;
  domain: TerminalLaunchDomain;
  elapsedMs: number;
}

export interface TerminalLaunchPhasePayload {
  launchAttemptId: string;
  ptyId: string;
  phase: TerminalLaunchPhase;
  elapsedMs: number;
  domain: 'backend';
  mode?: 'create' | 'attach';
  provider?: string;
  outcome?: 'ok' | 'error';
}

export interface TerminalLaunchTrace {
  readonly launchAttemptId: string;
  readonly ptyId: string;
  readonly provider?: string;
  mark(phase: TerminalLaunchPhase): TerminalLaunchPhaseRecord | null;
  acceptBackendPhase(payload: TerminalLaunchPhasePayload): TerminalLaunchPhaseRecord | null;
  has(phase: TerminalLaunchPhase): boolean;
  records(): readonly TerminalLaunchPhaseRecord[];
}

const MAX_RECENT_TRACES = 64;
const MAX_PHASES_PER_TRACE = 32;
let traceCounter = 0;
const recentTraces: Array<{
  launchAttemptId: string;
  ptyId: string;
  provider?: string;
  records: readonly TerminalLaunchPhaseRecord[];
}> = [];

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function nextAttemptId(): string {
  traceCounter += 1;
  return `terminal-launch-${Date.now().toString(36)}-${traceCounter.toString(36)}`;
}

export function createTerminalLaunchTrace(options: {
  ptyId: string;
  provider?: string;
  launchAttemptId?: string;
  clock?: () => number;
}): TerminalLaunchTrace {
  const clock = options.clock ?? now;
  const startedAt = clock();
  const attemptId = options.launchAttemptId ?? nextAttemptId();
  const phaseRecords: TerminalLaunchPhaseRecord[] = [];
  const seen = new Set<TerminalLaunchPhase>();

  const remember = (record: TerminalLaunchPhaseRecord): TerminalLaunchPhaseRecord => {
    if (phaseRecords.length < MAX_PHASES_PER_TRACE) {
      phaseRecords.push(record);
    }
    return record;
  };

  const trace: TerminalLaunchTrace = {
    launchAttemptId: attemptId,
    ptyId: options.ptyId,
    provider: options.provider,
    mark(phase) {
      if (seen.has(phase)) return null;
      seen.add(phase);
      return remember({
        phase,
        domain: 'frontend',
        elapsedMs: Math.max(0, clock() - startedAt),
      });
    },
    acceptBackendPhase(payload) {
      if (
        payload.launchAttemptId !== attemptId ||
        payload.ptyId !== options.ptyId ||
        payload.domain !== 'backend' ||
        seen.has(payload.phase)
      ) {
        return null;
      }
      seen.add(payload.phase);
      return remember({
        phase: payload.phase,
        domain: 'backend',
        elapsedMs: Math.max(0, payload.elapsedMs),
      });
    },
    has(phase) {
      return seen.has(phase);
    },
    records() {
      return phaseRecords;
    },
  };

  const originalMark = trace.mark;
  trace.mark = (phase) => {
    const record = originalMark(phase);
    if (record && (phase === 'connected' || phase === 'failed')) {
      recentTraces.push({
        launchAttemptId: trace.launchAttemptId,
        ptyId: trace.ptyId,
        provider: trace.provider,
        records: [...phaseRecords],
      });
      if (recentTraces.length > MAX_RECENT_TRACES) {
        recentTraces.splice(0, recentTraces.length - MAX_RECENT_TRACES);
      }
    }
    return record;
  };

  return trace;
}

export function getRecentTerminalLaunchTraces(): ReadonlyArray<{
  launchAttemptId: string;
  ptyId: string;
  provider?: string;
  records: readonly TerminalLaunchPhaseRecord[];
}> {
  return recentTraces;
}

export function clearRecentTerminalLaunchTraces(): void {
  recentTraces.length = 0;
}
