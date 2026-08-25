import type { PtyCreateSessionV2Disposition, PtyStartupDescriptorDisposition, PtyStartupSnapshot, PtyStartupState } from '../../types/ptyStartup';
export const PTY_STARTUP_RECONCILIATION_MAX_GENERATIONS = 4;
/** The safe subset of a create result needed by this presentation-only utility. */
export interface PtyStartupCreateObservation {
  readonly ptyId: string;
  readonly generation: string;
  readonly startup: PtyStartupSnapshot;
  readonly disposition: PtyCreateSessionV2Disposition;
  readonly descriptorDisposition: PtyStartupDescriptorDisposition;
}
export interface PtyStartupReconciliationResult {
  readonly accepted: boolean;
  readonly current: PtyStartupSnapshot | null;
  readonly changed: boolean;
  /** True only for the first accepted `sent` state for this observer/generation. */
  readonly sent: boolean;
  /** A live event skipped a revision; the caller should recover with one query. */
  readonly needsQuery: boolean;
  readonly bufferedGenerations: number;
}
export interface PtyStartupReconciliation {
  acceptCreate(observation: PtyStartupCreateObservation): PtyStartupReconciliationResult;
  acceptEvent(snapshot: PtyStartupSnapshot): PtyStartupReconciliationResult;
  acceptQuery(generation: string, snapshot: PtyStartupSnapshot | null): PtyStartupReconciliationResult;
  /** Clears active observation, but keeps sent history for this observer. */
  reset(): void;
  dispose(): void;
  getCurrent(): PtyStartupSnapshot | null;
}
const STARTUP_STATES: readonly PtyStartupState[] = ['notRequired', 'waiting', 'ready', 'timedOut',
  'dispatching', 'sent', 'cancelled', 'failed'];
const STARTUP_TRIGGERS = ['marker', 'firstOutput', 'timeout', 'immediate', 'ptyExit', 'killed'];
function isSnapshot(value: unknown): value is PtyStartupSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<PtyStartupSnapshot>;
  return typeof snapshot.ptyId === 'string' && snapshot.ptyId.length > 0
    && typeof snapshot.generation === 'string' && snapshot.generation.length > 0
    && typeof snapshot.revision === 'number' && Number.isSafeInteger(snapshot.revision)
    && snapshot.revision >= 0
    && typeof snapshot.state === 'string' && STARTUP_STATES.includes(snapshot.state)
    && (snapshot.trigger === undefined || STARTUP_TRIGGERS.includes(snapshot.trigger));
}

function copySnapshot(snapshot: PtyStartupSnapshot): PtyStartupSnapshot {
  const copy: PtyStartupSnapshot = {
    ptyId: snapshot.ptyId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    state: snapshot.state,
    ...(snapshot.trigger ? { trigger: snapshot.trigger } : {}),
  };
  return Object.freeze(copy);
}
export function createPtyStartupReconciliation(): PtyStartupReconciliation {
  const buffered = new Map<string, PtyStartupSnapshot>();
  const sentGenerations = new Set<string>();
  const retiredGenerations = new Set<string>();
  let current: PtyStartupSnapshot | null = null;
  let confirmedGeneration: string | null = null;
  let disposed = false;
  const result = (accepted: boolean, changed: boolean, sent = false, needsQuery = false):
    PtyStartupReconciliationResult => Object.freeze({
    accepted,
    current,
    changed,
    sent,
    needsQuery,
    bufferedGenerations: buffered.size,
  });
  const rememberBuffered = (snapshot: PtyStartupSnapshot): boolean => {
    const previous = buffered.get(snapshot.generation);
    if (previous && previous.revision >= snapshot.revision) return false;
    buffered.set(snapshot.generation, copySnapshot(snapshot));
    while (buffered.size > PTY_STARTUP_RECONCILIATION_MAX_GENERATIONS) {
      const oldest = buffered.keys().next().value;
      if (typeof oldest !== 'string') break;
      buffered.delete(oldest);
    }
    return true;
  };
  const applyCurrent = (snapshot: PtyStartupSnapshot, gapFromRevision: number | null, presentSent = true):
    PtyStartupReconciliationResult => {
    const previous = current;
    current = copySnapshot(snapshot);
    const sent = current.state === 'sent' && !sentGenerations.has(current.generation);
    if (sent) sentGenerations.add(current.generation);
    return result(
      true,
      previous?.generation !== current.generation || previous?.ptyId !== current.ptyId
        || previous?.revision !== current.revision || previous?.state !== current.state,
      sent && presentSent,
      gapFromRevision !== null && current.revision > gapFromRevision + 1,
    );
  };
  const noOp = () => result(false, false);
  const acceptBuffered = (snapshot: PtyStartupSnapshot): PtyStartupReconciliationResult =>
    result(rememberBuffered(snapshot), false);
  const acceptCreate = (
    observation: PtyStartupCreateObservation,
  ): PtyStartupReconciliationResult => {
    if (disposed || !observation || typeof observation !== 'object') return noOp();
    const startup = observation.startup;
    if (typeof observation.ptyId !== 'string' || typeof observation.generation !== 'string'
      || !isSnapshot(startup)
      || startup.ptyId !== observation.ptyId
      || startup.generation !== observation.generation) return noOp();
    if (retiredGenerations.has(startup.generation)) return noOp();
    const presentSent = observation.disposition === 'created'
      || (observation.disposition === 'attached'
        && observation.descriptorDisposition === 'legacyClaimed');

    if (current && current.generation === startup.generation) {
      if (current.ptyId !== startup.ptyId || startup.revision <= current.revision) return noOp();
      return applyCurrent(startup, null, presentSent);
    }

    if (confirmedGeneration && confirmedGeneration !== startup.generation) {
      retiredGenerations.add(confirmedGeneration);
    }
    confirmedGeneration = startup.generation;
    const pending = buffered.get(startup.generation);
    buffered.clear();
    const merged = pending && pending.ptyId === startup.ptyId && pending.revision > startup.revision
      ? pending
      : startup;
    return applyCurrent(merged, startup.revision, presentSent);
  };
  const acceptEvent = (snapshot: PtyStartupSnapshot): PtyStartupReconciliationResult => {
    if (disposed || !isSnapshot(snapshot)) return noOp();
    if (retiredGenerations.has(snapshot.generation)) return noOp();
    if (!current) return acceptBuffered(snapshot);
    if (snapshot.generation !== current.generation) {
      return snapshot.ptyId === current.ptyId ? acceptBuffered(snapshot) : noOp();
    }
    if (snapshot.ptyId !== current.ptyId || snapshot.revision <= current.revision) return noOp();
    return applyCurrent(snapshot, current.revision);
  };

  const acceptQuery = (generation: string, snapshot: PtyStartupSnapshot | null):
    PtyStartupReconciliationResult => {
    if (disposed || typeof generation !== 'string' || generation.length === 0) return noOp();
    if (snapshot === null) return noOp();
    if (!isSnapshot(snapshot) || snapshot.generation !== generation) return noOp();
    if (retiredGenerations.has(generation)) return noOp();
    if (!current || current.generation !== generation) {
      return current && snapshot.ptyId !== current.ptyId ? noOp() : acceptBuffered(snapshot);
    }
    if (snapshot.ptyId !== current.ptyId || snapshot.revision <= current.revision) return noOp();
    return applyCurrent(snapshot, null);
  };

  return {
    acceptCreate,
    acceptEvent,
    acceptQuery,
    reset: () => {
      current = null;
      buffered.clear();
    },
    dispose: () => {
      disposed = true;
      current = null;
      confirmedGeneration = null;
      buffered.clear();
      sentGenerations.clear();
      retiredGenerations.clear();
    },
    getCurrent: () => current,
  };
}
