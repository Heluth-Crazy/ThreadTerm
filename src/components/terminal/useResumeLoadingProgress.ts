import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { createResumeLoadingProgressController } from './resumeLoadingProgressController';
import {
  INACTIVE_RESUME_LOADING_SNAPSHOT,
  type ResumeLoadingProgressObserver,
  type ResumeLoadingSnapshot,
} from './resumeLoadingProgressTypes';

interface UseResumeLoadingProgressOptions {
  enabled: boolean;
  sessionKey: string;
  isGeometryReady: () => boolean;
  prepareTerminalForReveal: () => void;
  onRevealed: () => void;
}

interface UseResumeLoadingProgressResult extends ResumeLoadingSnapshot {
  inputBlockedRef: MutableRefObject<boolean>;
  observerRef: MutableRefObject<ResumeLoadingProgressObserver | null>;
  abort: () => void;
}

export function useResumeLoadingProgress({
  enabled,
  sessionKey,
  isGeometryReady,
  prepareTerminalForReveal,
  onRevealed,
}: UseResumeLoadingProgressOptions): UseResumeLoadingProgressResult {
  const [snapshot, setSnapshot] = useState<ResumeLoadingSnapshot>(
    INACTIVE_RESUME_LOADING_SNAPSHOT,
  );
  const inputBlockedRef = useRef(false);
  const controllerRef = useRef<ReturnType<
    typeof createResumeLoadingProgressController
  > | null>(null);
  const callbacksRef = useRef({
    isGeometryReady,
    prepareTerminalForReveal,
    onRevealed,
  });
  callbacksRef.current = {
    isGeometryReady,
    prepareTerminalForReveal,
    onRevealed,
  };

  const observerRef = useRef<ResumeLoadingProgressObserver | null>(null);
  if (!observerRef.current) {
    observerRef.current = {
      connectionReady: () => controllerRef.current?.connectionReady(),
      commandDispatching: () => controllerRef.current?.commandDispatching(),
      outputWriteStarted: (outputChars) =>
        controllerRef.current?.outputWriteStarted(outputChars),
      outputWriteCompleted: (frameOpen) =>
        controllerRef.current?.outputWriteCompleted(frameOpen),
      skip: () => controllerRef.current?.skip(),
      abort: () => controllerRef.current?.abort(),
    };
  }

  useEffect(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    inputBlockedRef.current = false;
    setSnapshot(INACTIVE_RESUME_LOADING_SNAPSHOT);
    if (!enabled) return;

    const controller = createResumeLoadingProgressController({
      isGeometryReady: () => callbacksRef.current.isGeometryReady(),
      prepareTerminalForReveal: () =>
        callbacksRef.current.prepareTerminalForReveal(),
      onRevealed: () => callbacksRef.current.onRevealed(),
      onChange: (nextSnapshot) => {
        inputBlockedRef.current = nextSnapshot.active;
        setSnapshot(nextSnapshot);
      },
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      inputBlockedRef.current = false;
      controller.dispose();
    };
  }, [enabled, sessionKey]);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return {
    ...snapshot,
    inputBlockedRef,
    observerRef,
    abort,
  };
}
