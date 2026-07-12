export type OutputConsumerKind = 'background' | 'renderer';

export interface OutputAckRequest {
  id: string;
  throughSeq: number;
  consumerKind: OutputConsumerKind;
  consumerId?: string;
}

type AckSender = (request: OutputAckRequest) => Promise<void>;

interface PendingAck {
  request: OutputAckRequest;
  inFlight: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_RETRY_DELAY_MS = 250;

function requestKey(request: OutputAckRequest): string {
  return `${request.id}\u0000${request.consumerKind}\u0000${request.consumerId ?? ''}`;
}

/**
 * Coalesces cumulative PTY ACKs and retries failed IPC calls even when no
 * later output arrives. Each consumer has one in-flight call at a time; newer
 * sequences replace older pending values rather than amplifying duplicates.
 */
export function createOutputAcknowledger(
  send: AckSender,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
) {
  const pending = new Map<string, PendingAck>();
  let disposed = false;

  const sendPending = (key: string) => {
    const state = pending.get(key);
    if (disposed || !state || state.inFlight || state.retryTimer) return;

    state.inFlight = true;
    const sentThroughSeq = state.request.throughSeq;
    const request = { ...state.request };

    void Promise.resolve()
      .then(() => send(request))
      .then(() => {
        if (disposed) return;
        const latest = pending.get(key);
        // A per-PTY cleanup may delete this entry and a replacement session
        // may create the same key before the old IPC settles. Never let the
        // old completion mutate the replacement entry.
        if (latest !== state) return;
        latest.inFlight = false;
        if (latest.request.throughSeq > sentThroughSeq) {
          sendPending(key);
        } else {
          pending.delete(key);
        }
      })
      .catch(() => {
        if (disposed) return;
        const latest = pending.get(key);
        if (latest !== state) return;
        latest.inFlight = false;
        latest.retryTimer = setTimeout(() => {
          const retry = pending.get(key);
          if (!retry) return;
          retry.retryTimer = null;
          sendPending(key);
        }, retryDelayMs);
      });
  };

  return {
    ack(request: OutputAckRequest) {
      if (disposed || request.throughSeq <= 0) return;
      const key = requestKey(request);
      const existing = pending.get(key);
      if (existing) {
        if (request.throughSeq > existing.request.throughSeq) {
          existing.request = request;
        }
      } else {
        pending.set(key, {
          request: { ...request },
          inFlight: false,
          retryTimer: null,
        });
      }
      sendPending(key);
    },

    /** Drop queued/retrying ACK state for one PTY without affecting others. */
    discard(id: string) {
      for (const [key, state] of pending.entries()) {
        if (state.request.id !== id) continue;
        if (state.retryTimer) clearTimeout(state.retryTimer);
        pending.delete(key);
      }
    },

    getDiagnostics() {
      return {
        pendingCount: pending.size,
        requests: Array.from(pending.values(), (state) => ({ ...state.request })),
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of pending.values()) {
        if (state.retryTimer) clearTimeout(state.retryTimer);
      }
      pending.clear();
    },
  };
}
