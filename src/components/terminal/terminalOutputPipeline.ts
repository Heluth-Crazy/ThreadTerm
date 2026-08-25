import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type { Terminal } from '@xterm/xterm';
import { createOutputSequencer } from './outputSequencer';
import { countNewlines, shouldFollowOutput } from './shellBehavior';
import type {
  OutputAcknowledger,
  OutputSequencer,
  RendererOutputConsumer,
} from './shellRuntimeTypes';
import { createSynchronizedFrameRefreshGate } from './synchronizedFrameRefreshGate';
import type { ResumeLoadingProgressObserver } from './resumeLoadingProgressTypes';

const CLEANUP_SEQUENCE_RE = /\x1b\[[0-9;]*[JKLMPX]/;
// W0.3: above this size, a session-restore snapshot is written to xterm in
// byte-budgeted slices (chained on term.write's drain callback) instead of one
// blocking write, so input/scroll stay responsive while a history-heavy session
// restores. End state is identical — xterm's parser is stateful across writes.
const SNAPSHOT_RESTORE_CHUNK_CHARS = 65536;

interface CreateTerminalOutputPipelineOptions {
  connectedPtyId: string;
  consumerId: string;
  outputAcknowledger: OutputAcknowledger;
  isStaleSetup: () => boolean | string | undefined;
  terminalRef: MutableRefObject<Terminal | null>;
  outputConsumerRef: MutableRefObject<RendererOutputConsumer | null>;
  activeRef: MutableRefObject<boolean>;
  scrolledUpRef: MutableRefObject<boolean>;
  pendingNewLinesRef: MutableRefObject<number>;
  setScrolledUp: Dispatch<SetStateAction<boolean>>;
  scrollTerminalToBottom: (shouldFocus?: boolean, shouldRefresh?: boolean) => void;
  scheduleNewOutputFlush: () => void;
  scheduleTerminalRefresh: () => void;
  onTerminalWriteStarted?: () => void;
  onTerminalWriteCompleted?: () => void;
  resumeLoadingObserverRef?: MutableRefObject<ResumeLoadingProgressObserver | null>;
}

export function createTerminalOutputPipeline({
  connectedPtyId,
  consumerId,
  outputAcknowledger,
  isStaleSetup,
  terminalRef,
  outputConsumerRef,
  activeRef,
  scrolledUpRef,
  pendingNewLinesRef,
  setScrolledUp,
  scrollTerminalToBottom,
  scheduleNewOutputFlush,
  scheduleTerminalRefresh,
  onTerminalWriteStarted,
  onTerminalWriteCompleted,
  resumeLoadingObserverRef,
}: CreateTerminalOutputPipelineOptions): OutputSequencer {
  const synchronizedRefreshGate = createSynchronizedFrameRefreshGate();
  const sequencer = createOutputSequencer((data, seq, onWritten, meta) => {
    const term = terminalRef.current;
    const isCurrentConsumer = () =>
      !isStaleSetup() &&
      outputConsumerRef.current?.consumerId === consumerId;
    const ackWritten = () => {
      if (!isCurrentConsumer()) {
        onWritten();
        return;
      }
      if (meta.ack) {
        outputAcknowledger.ack({
          id: connectedPtyId,
          throughSeq: seq,
          consumerKind: 'renderer',
          consumerId,
        });
      }
      onWritten();
    };

    if (!isCurrentConsumer()) {
      onWritten();
      return;
    }

    if (!meta.render) {
      ackWritten();
      return;
    }

    if (!term) {
      onWritten();
      return;
    }

    // Audit P0-1: decide follow-or-not BEFORE the write. Follow only
    // when the viewport already sits at the bottom (or the app runs on
    // the alternate screen); a user reading history must not be yanked
    // back down by every incoming chunk.
    const applyDisplayEffects = activeRef.current;
    const followOutput = applyDisplayEffects && (
      term.buffer.active.type === 'alternate' ||
      shouldFollowOutput(term.buffer.active)
    );
    const needsRefresh = CLEANUP_SEQUENCE_RE.test(data) || data.includes('\r');
    const shouldScheduleRefresh =
      synchronizedRefreshGate.shouldRefreshAfterWrite(data, needsRefresh);
    const observesResumeWrite = Boolean(data);
    if (observesResumeWrite) {
      resumeLoadingObserverRef?.current?.outputWriteStarted(data.length);
    }
    const finalize = () => {
      if (!isCurrentConsumer()) {
        onWritten();
        return;
      }
      if (applyDisplayEffects && activeRef.current) {
        if (followOutput) {
          if (!term.hasSelection()) {
            // The xterm write has already painted normal output. Avoid
            // a full refresh for every chunk; CR/cleanup paths use the
            // coalesced scheduler below.
            scrollTerminalToBottom(false, false);
          }
        } else {
          scrolledUpRef.current = true;
          setScrolledUp(true);
          pendingNewLinesRef.current += countNewlines(data);
          scheduleNewOutputFlush();
        }
        if (shouldScheduleRefresh) {
          scheduleTerminalRefresh();
        }
      }
      if (observesResumeWrite) {
        resumeLoadingObserverRef?.current?.outputWriteCompleted(
          synchronizedRefreshGate.isOpen(),
        );
      }
      if (data) {
        onTerminalWriteCompleted?.();
      }
      ackWritten();
    };

    // W0.3: a large session-restore snapshot is otherwise one
    // giant term.write that blocks input/scroll while xterm parses it.
    // Feed it in byte-budgeted slices, chaining on term.write's drain
    // callback so the main thread yields between slices. Realtime chunks
    // and small snapshots keep the single write (zero behavior change).
    if (!data) {
      finalize();
    } else if (meta.snapshot && data.length > SNAPSHOT_RESTORE_CHUNK_CHARS) {
      let offset = 0;
      const writeNextSlice = () => {
        if (!isCurrentConsumer()) {
          onWritten();
          return;
        }
        if (!terminalRef.current || offset >= data.length) {
          finalize();
          return;
        }
        const slice = data.slice(offset, offset + SNAPSHOT_RESTORE_CHUNK_CHARS);
        offset += SNAPSHOT_RESTORE_CHUNK_CHARS;
        onTerminalWriteStarted?.();
        term.write(slice, writeNextSlice);
      };
      writeNextSlice();
    } else {
      // Preserve DEC 2026 frames byte-for-byte. Agent TUIs use ED2/ED3
      // inside those frames when history or composer height changes;
      // removing the clears leaves the previous layout underneath the
      // new one and makes prompt rows visibly jump between redraws.
      onTerminalWriteStarted?.();
      term.write(data, finalize);
    }
  });

  return {
    ...sequencer,
    reset() {
      synchronizedRefreshGate.reset();
      sequencer.reset();
    },
  };
}
