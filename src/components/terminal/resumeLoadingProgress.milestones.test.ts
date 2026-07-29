import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RESUME_LOADING_TIMING } from './resumeLoadingProgressController';
import { frames, runNextFrame } from './resumeLoadingProgress.testHarness';
import { useResumeLoadingProgress } from './useResumeLoadingProgress';

describe('useResumeLoadingProgress milestones', () => {
  it('advances through fixed milestones and reaches 100 only after substantive replay output settles', () => {
    const prepareTerminalForReveal = vi.fn();
    const onRevealed = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'claude:session-a',
        isGeometryReady: () => true,
        prepareTerminalForReveal,
        onRevealed,
      }),
    );

    expect(result.current.active).toBe(true);
    expect(result.current.visible).toBe(false);
    expect(result.current.inputBlockedRef.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.showDelayMs);
    });
    expect(result.current.visible).toBe(true);

    act(() => result.current.observerRef.current?.connectionReady());
    expect(result.current.progress).toBe(25);

    act(() => result.current.observerRef.current?.commandDispatching());
    expect(result.current.progress).toBe(50);

    act(() => {
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars,
      );
      result.current.observerRef.current?.outputWriteCompleted(false);
    });
    expect(result.current.progress).toBe(75);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    expect(prepareTerminalForReveal).toHaveBeenCalledTimes(1);
    act(() => runNextFrame());
    act(() => runNextFrame());
    expect(result.current.progress).toBeLessThan(100);
    expect(result.current.active).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs);
    });
    expect(result.current.progress).toBe(100);
    act(() => runNextFrame());
    act(() => runNextFrame());
    expect(result.current.active).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(result.current.monitoring).toBe(false);
    expect(result.current.inputBlockedRef.current).toBe(false);
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it('waits for a synchronized frame to close before accepting replay evidence', () => {
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'codex:session-b',
        isGeometryReady: () => true,
        prepareTerminalForReveal: vi.fn(),
        onRevealed: vi.fn(),
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.commandDispatching();
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars,
      );
      result.current.observerRef.current?.outputWriteCompleted(true);
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs * 2);
    });
    expect(result.current.progress).toBeLessThan(75);
    expect(result.current.active).toBe(true);

    act(() => {
      result.current.observerRef.current?.outputWriteStarted(1);
      result.current.observerRef.current?.outputWriteCompleted(false);
    });
    expect(result.current.progress).toBe(75);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs);
    });
    expect(result.current.progress).toBe(100);
  });

  it('does not mistake the measured Codex startup gap for completed history', () => {
    const prepareTerminalForReveal = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'codex:delayed-history',
        isGeometryReady: () => true,
        prepareTerminalForReveal,
        onRevealed: vi.fn(),
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.commandDispatching();
      result.current.observerRef.current?.outputWriteStarted(519);
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(2_500);
    });

    expect(prepareTerminalForReveal).not.toHaveBeenCalled();
    expect(result.current.progress).toBeLessThan(75);
    expect(result.current.active).toBe(true);

    act(() => {
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars - 519,
      );
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs);
    });

    expect(result.current.progress).toBe(100);
  });

  it('keeps the percentage below 75 through OpenCode initial chrome and its long pre-history pause', () => {
    const prepareTerminalForReveal = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'opencode:delayed-history',
        isGeometryReady: () => true,
        prepareTerminalForReveal,
        onRevealed: vi.fn(),
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.commandDispatching();
      result.current.observerRef.current?.outputWriteStarted(2_395);
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(2_800);
    });

    expect(prepareTerminalForReveal).not.toHaveBeenCalled();
    expect(result.current.progress).toBeLessThan(75);

    act(() => {
      result.current.observerRef.current?.outputWriteStarted(10_000);
      result.current.observerRef.current?.outputWriteCompleted(false);
    });
    expect(result.current.progress).toBe(75);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs);
    });

    expect(result.current.progress).toBe(100);
  });

});
