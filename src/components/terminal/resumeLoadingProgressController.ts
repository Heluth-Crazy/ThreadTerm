import {
  INACTIVE_RESUME_LOADING_SNAPSHOT,
  type ResumeLoadingProgressObserver,
  type ResumeLoadingSnapshot,
} from './resumeLoadingProgressTypes';

export const RESUME_LOADING_TIMING = {
  showDelayMs: 160,
  tickMs: 180,
  // A shell echo or an Agent bootstrap frame is not restored history. Real
  // resume probes show ~0.5 KB before Codex history and ~2.4 KB before
  // OpenCode paints its restored conversation. Keep completion locked until
  // the terminal has received a substantive post-dispatch screen payload.
  minimumReplayChars: 3_072,
  stableOutputMs: 2_000,
  geometryRetryMs: 120,
  // Keep the last stability guard before 100%. Once 100% is published, the
  // reveal is committed and must no longer be cancellable by a late write.
  finalCommitGuardMs: 320,
} as const;

interface ResumeLoadingProgressControllerOptions {
  isGeometryReady: () => boolean;
  prepareTerminalForReveal: () => void;
  onRevealed: () => void;
  onChange: (snapshot: ResumeLoadingSnapshot) => void;
}

interface ResumeLoadingRuntime {
  active: boolean;
  visible: boolean;
  monitoring: boolean;
  progress: number;
  cap: number;
  commandDispatched: boolean;
  replayChars: number;
  replayEvidenceObserved: boolean;
  currentWriteEligible: boolean;
  writeInProgress: boolean;
  synchronizedFrameOpen: boolean;
  completing: boolean;
  committed: boolean;
}

export function createResumeLoadingProgressController(
  options: ResumeLoadingProgressControllerOptions,
): ResumeLoadingProgressObserver & {
  start: () => void;
  dispose: () => void;
} {
  let generation = 0;
  let runtime: ResumeLoadingRuntime = {
    ...INACTIVE_RESUME_LOADING_SNAPSHOT,
    cap: 23,
    commandDispatched: false,
    replayChars: 0,
    replayEvidenceObserved: false,
    currentWriteEligible: false,
    writeInProgress: false,
    synchronizedFrameOpen: false,
    completing: false,
    committed: false,
  };
  let showTimer: number | null = null;
  let tickTimer: number | null = null;
  let quietTimer: number | null = null;
  let completeTimer: number | null = null;
  let firstRevealFrame: number | null = null;
  let secondRevealFrame: number | null = null;

  const emit = () => {
    options.onChange({
      active: runtime.active,
      visible: runtime.visible,
      monitoring: runtime.monitoring,
      progress: runtime.progress,
    });
  };

  const clearTimer = (timer: number | null) => {
    if (timer !== null) window.clearTimeout(timer);
  };

  const clearScheduledWork = () => {
    clearTimer(showTimer);
    clearTimer(tickTimer);
    clearTimer(quietTimer);
    clearTimer(completeTimer);
    showTimer = null;
    tickTimer = null;
    quietTimer = null;
    completeTimer = null;
    if (firstRevealFrame !== null) cancelAnimationFrame(firstRevealFrame);
    if (secondRevealFrame !== null) cancelAnimationFrame(secondRevealFrame);
    firstRevealFrame = null;
    secondRevealFrame = null;
  };

  const stop = (notify: boolean) => {
    generation += 1;
    clearScheduledWork();
    runtime = {
      ...runtime,
      active: false,
      visible: false,
      monitoring: false,
      completing: false,
      committed: false,
      writeInProgress: false,
      currentWriteEligible: false,
    };
    if (notify) emit();
  };

  const reveal = () => {
    stop(true);
    options.onRevealed();
  };

  const scheduleTick = () => {
    clearTimer(tickTimer);
    const tickGeneration = generation;
    const tick = () => {
      if (tickGeneration !== generation || !runtime.active) {
        tickTimer = null;
        return;
      }
      if (
        !runtime.completing &&
        !runtime.committed &&
        runtime.progress < runtime.cap
      ) {
        runtime.progress += 1;
        emit();
      }
      tickTimer = window.setTimeout(tick, RESUME_LOADING_TIMING.tickMs);
    };
    tickTimer = window.setTimeout(tick, RESUME_LOADING_TIMING.tickMs);
  };

  const advance = (minimum: number, cap: number) => {
    if (!runtime.active || runtime.completing || runtime.committed) return;
    runtime.cap = Math.max(runtime.cap, cap);
    if (runtime.progress < minimum) {
      runtime.progress = minimum;
      emit();
    }
  };

  const canComplete = () =>
    runtime.active &&
    runtime.commandDispatched &&
    runtime.replayEvidenceObserved &&
    !runtime.writeInProgress &&
    !runtime.synchronizedFrameOpen &&
    !runtime.completing &&
    !runtime.committed;

  const completionStillReady = () =>
    runtime.active &&
    runtime.commandDispatched &&
    runtime.replayEvidenceObserved &&
    !runtime.writeInProgress &&
    !runtime.synchronizedFrameOpen &&
    runtime.completing &&
    !runtime.committed;

  const cancelPendingCompletion = () => {
    if (!runtime.completing || runtime.committed) return;
    clearTimer(completeTimer);
    completeTimer = null;
    if (firstRevealFrame !== null) cancelAnimationFrame(firstRevealFrame);
    if (secondRevealFrame !== null) cancelAnimationFrame(secondRevealFrame);
    firstRevealFrame = null;
    secondRevealFrame = null;
    runtime.completing = false;
  };

  const complete = () => {
    if (!canComplete()) return;
    const completionGeneration = generation;
    runtime.completing = true;
    clearTimer(quietTimer);
    quietTimer = null;

    options.prepareTerminalForReveal();
    firstRevealFrame = requestAnimationFrame(() => {
      firstRevealFrame = null;
      if (completionGeneration !== generation || !runtime.active) return;
      secondRevealFrame = requestAnimationFrame(() => {
        secondRevealFrame = null;
        if (
          completionGeneration !== generation ||
          !completionStillReady()
        ) {
          return;
        }

        if (!runtime.visible) {
          reveal();
          return;
        }

        completeTimer = window.setTimeout(() => {
          completeTimer = null;
          if (
            completionGeneration !== generation ||
            !completionStillReady()
          ) {
            return;
          }

          runtime.committed = true;
          runtime.progress = 100;
          emit();
          firstRevealFrame = requestAnimationFrame(() => {
            firstRevealFrame = null;
            if (
              completionGeneration !== generation ||
              !runtime.active ||
              !runtime.committed
            ) {
              return;
            }
            secondRevealFrame = requestAnimationFrame(() => {
              secondRevealFrame = null;
              if (
                completionGeneration !== generation ||
                !runtime.active ||
                !runtime.committed
              ) {
                return;
              }
              reveal();
            });
          });
        }, RESUME_LOADING_TIMING.finalCommitGuardMs);
      });
    });
  };

  const waitForGeometry = (quietGeneration: number) => {
    if (quietGeneration !== generation || !canComplete()) return;
    if (!options.isGeometryReady()) {
      quietTimer = window.setTimeout(() => {
        quietTimer = null;
        waitForGeometry(quietGeneration);
      }, RESUME_LOADING_TIMING.geometryRetryMs);
      return;
    }
    complete();
  };

  const scheduleCompletionCheck = () => {
    clearTimer(quietTimer);
    quietTimer = null;
    if (!canComplete()) return;
    const quietGeneration = generation;
    quietTimer = window.setTimeout(() => {
      quietTimer = null;
      waitForGeometry(quietGeneration);
    }, RESUME_LOADING_TIMING.stableOutputMs);
  };

  const start = () => {
    generation += 1;
    const startGeneration = generation;
    clearScheduledWork();
    runtime = {
      active: true,
      visible: false,
      monitoring: true,
      progress: 0,
      cap: 23,
      commandDispatched: false,
      replayChars: 0,
      replayEvidenceObserved: false,
      currentWriteEligible: false,
      writeInProgress: false,
      synchronizedFrameOpen: false,
      completing: false,
      committed: false,
    };
    emit();

    showTimer = window.setTimeout(() => {
      showTimer = null;
      if (startGeneration !== generation || !runtime.active) return;
      runtime.visible = true;
      emit();
    }, RESUME_LOADING_TIMING.showDelayMs);

    scheduleTick();
  };

  return {
    start,
    connectionReady() {
      if (!runtime.monitoring) start();
      advance(25, 48);
    },
    commandDispatching() {
      if (!runtime.monitoring) start();
      runtime.commandDispatched = true;
      advance(50, 73);
    },
    outputWriteStarted(outputChars) {
      if (!runtime.active || runtime.committed) return;
      runtime.currentWriteEligible = runtime.commandDispatched;
      if (!runtime.currentWriteEligible) return;

      cancelPendingCompletion();
      runtime.writeInProgress = true;
      runtime.replayChars += Math.max(0, Math.floor(outputChars));
      clearTimer(quietTimer);
      quietTimer = null;
    },
    outputWriteCompleted(synchronizedFrameOpen) {
      if (!runtime.active || !runtime.currentWriteEligible) return;
      runtime.currentWriteEligible = false;
      runtime.writeInProgress = false;
      runtime.synchronizedFrameOpen = synchronizedFrameOpen;

      if (
        !runtime.replayEvidenceObserved &&
        runtime.replayChars >= RESUME_LOADING_TIMING.minimumReplayChars &&
        !synchronizedFrameOpen
      ) {
        runtime.replayEvidenceObserved = true;
        advance(75, 98);
      }
      scheduleCompletionCheck();
    },
    skip() {
      stop(true);
    },
    abort() {
      stop(true);
    },
    dispose() {
      stop(false);
    },
  };
}
