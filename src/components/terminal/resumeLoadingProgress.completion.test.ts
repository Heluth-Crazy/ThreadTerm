import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RESUME_LOADING_TIMING } from './resumeLoadingProgressController';
import { frames, runNextFrame } from './resumeLoadingProgress.testHarness';
import { useResumeLoadingProgress } from './useResumeLoadingProgress';

describe('useResumeLoadingProgress completion guards', () => {
  it('cancels a pending reveal without rolling the percentage backwards', () => {
    const prepareTerminalForReveal = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'claude:late-before-completion',
        isGeometryReady: () => true,
        prepareTerminalForReveal,
        onRevealed: vi.fn(),
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.commandDispatching();
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars,
      );
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    const progressBeforeLateWrite = result.current.progress;
    expect(prepareTerminalForReveal).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.observerRef.current?.outputWriteStarted(500);
      result.current.observerRef.current?.outputWriteCompleted(false);
    });
    expect(frames.size).toBe(0);
    expect(result.current.progress).toBeGreaterThanOrEqual(
      progressBeforeLateWrite,
    );
    expect(result.current.progress).toBeLessThan(100);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs);
    });
    expect(result.current.progress).toBe(100);
    expect(prepareTerminalForReveal).toHaveBeenCalledTimes(2);
  });

  it('commits 100 only after the final hold and cannot strand the overlay on a late write', () => {
    const prepareTerminalForReveal = vi.fn();
    const onRevealed = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'claude:atomic-final-commit',
        isGeometryReady: () => true,
        prepareTerminalForReveal,
        onRevealed,
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.commandDispatching();
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars,
      );
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());

    expect(prepareTerminalForReveal).toHaveBeenCalledTimes(1);
    expect(result.current.progress).toBeLessThan(100);

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs - 1);
      result.current.observerRef.current?.outputWriteStarted(512);
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(1);
    });
    expect(result.current.progress).toBeLessThan(100);
    expect(onRevealed).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.finalCommitGuardMs);
    });
    expect(result.current.progress).toBe(100);

    act(() => {
      result.current.observerRef.current?.outputWriteStarted(128);
      result.current.observerRef.current?.outputWriteCompleted(false);
    });
    act(() => runNextFrame());
    act(() => runNextFrame());

    expect(onRevealed).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    expect(result.current.monitoring).toBe(false);
  });

  it('ignores the initial attach snapshot before the resume command is sent', () => {
    const prepareTerminalForReveal = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'claude:initial-snapshot',
        isGeometryReady: () => true,
        prepareTerminalForReveal,
        onRevealed: vi.fn(),
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars * 2,
      );
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs * 2);
    });

    expect(prepareTerminalForReveal).not.toHaveBeenCalled();
    expect(result.current.progress).toBeLessThan(75);
    expect(result.current.active).toBe(true);
  });

  it('waits for valid terminal geometry after replay output has settled', () => {
    let geometryReady = false;
    const prepareTerminalForReveal = vi.fn();
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'gemini:geometry',
        isGeometryReady: () => geometryReady,
        prepareTerminalForReveal,
        onRevealed: vi.fn(),
      }),
    );

    act(() => {
      result.current.observerRef.current?.connectionReady();
      result.current.observerRef.current?.commandDispatching();
      result.current.observerRef.current?.outputWriteStarted(
        RESUME_LOADING_TIMING.minimumReplayChars,
      );
      result.current.observerRef.current?.outputWriteCompleted(false);
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.stableOutputMs);
    });
    expect(prepareTerminalForReveal).not.toHaveBeenCalled();

    geometryReady = true;
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.geometryRetryMs);
    });
    expect(prepareTerminalForReveal).toHaveBeenCalledTimes(1);
  });

  it('cancels before it becomes visible when the PTY already exists', () => {
    const { result } = renderHook(() =>
      useResumeLoadingProgress({
        enabled: true,
        sessionKey: 'gemini:existing',
        isGeometryReady: () => true,
        prepareTerminalForReveal: vi.fn(),
        onRevealed: vi.fn(),
      }),
    );

    act(() => result.current.observerRef.current?.skip());
    act(() => {
      vi.advanceTimersByTime(RESUME_LOADING_TIMING.showDelayMs * 2);
    });

    expect(result.current.active).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(result.current.monitoring).toBe(false);
    expect(result.current.inputBlockedRef.current).toBe(false);
  });
});
