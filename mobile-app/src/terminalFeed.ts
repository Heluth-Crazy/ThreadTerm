import type { ServerMessage } from '@shared/mobile/bridge/protocol';

// Per-card terminal transport store (Stage 5, audit P1-3).
//
// Previously every terminal_output / terminal_snapshot chunk flowed through a
// single React state array in App (terminalMessages), which meant each chunk
// re-filtered the whole array, re-rendered the entire App tree, and made both
// MainTerminal instances (home preview + detail) loop the full transcript.
// This module replaces that with a plain per-card bucket + subscription model:
// pushing a chunk only touches one card's bucket (O(ring)), and subscribed
// MainTerminal instances receive the increment directly without any React
// re-render.
//
// The transcript semantics are carried over verbatim from the retired
// terminalTranscript.ts:
//   - a terminal_snapshot replaces the bucket's snapshot and drops outputs
//     whose seq is <= snapshot.seq (they are covered by the snapshot)
//   - a terminal_output is dropped when covered by the latest snapshot or
//     already recorded (seq guard de-dup)
//   - each card keeps at most MAX_MESSAGES_PER_CARD entries (snapshot counts
//     as one), trimming the oldest outputs first
//
// No React imports here on purpose: pure module singleton + functions so the
// push path stays trivially unit-testable.

export type TerminalFeedMessage = Extract<
  ServerMessage,
  { kind: 'terminal_output' | 'terminal_snapshot' }
>;
export type TerminalFeedSnapshot = Extract<TerminalFeedMessage, { kind: 'terminal_snapshot' }>;
export type TerminalFeedOutput = Extract<TerminalFeedMessage, { kind: 'terminal_output' }>;

export type TerminalFeedListener = (message: TerminalFeedMessage) => void;

// Same per-card transcript budget as the previous React-state transcript.
const MAX_MESSAGES_PER_CARD = 2000;

interface CardFeedBucket {
  snapshot: TerminalFeedSnapshot | null;
  outputs: TerminalFeedOutput[];
  listeners: Set<TerminalFeedListener>;
}

const buckets = new Map<string, CardFeedBucket>();

function ensureBucket(cardId: string): CardFeedBucket {
  let bucket = buckets.get(cardId);
  if (!bucket) {
    bucket = { snapshot: null, outputs: [], listeners: new Set() };
    buckets.set(cardId, bucket);
  }
  return bucket;
}

function messageSeq(value: number | undefined): number {
  return Number(value || 0);
}

function notify(bucket: CardFeedBucket, message: TerminalFeedMessage): void {
  for (const listener of [...bucket.listeners]) {
    listener(message);
  }
}

function trimBucket(bucket: CardFeedBucket): void {
  const outputBudget = bucket.snapshot
    ? Math.max(0, MAX_MESSAGES_PER_CARD - 1)
    : MAX_MESSAGES_PER_CARD;
  if (bucket.outputs.length > outputBudget) {
    bucket.outputs = bucket.outputs.slice(-outputBudget);
  }
}

export function terminalFeedCardId(message: ServerMessage): string | null {
  if (message.kind === 'terminal_output') return message.card_id;
  if (message.kind === 'terminal_snapshot') return message.snapshot.cardId;
  return null;
}

/**
 * Ingest a bridge terminal message into its card bucket and fan it out to that
 * card's subscribers. Only the single card bucket is touched: O(ring), never
 * O(all cards' transcripts).
 */
export function pushTerminalFeedMessage(message: TerminalFeedMessage): void {
  const cardId = terminalFeedCardId(message);
  if (!cardId) return;
  const bucket = ensureBucket(cardId);

  if (message.kind === 'terminal_snapshot') {
    const snapshotSeq = messageSeq(message.snapshot.seq);
    bucket.snapshot = message;
    // Outputs covered by the snapshot are superseded by its payload; outputs
    // ahead of it (a lagging snapshot behind the live stream) are retained.
    bucket.outputs = bucket.outputs.filter((output) => messageSeq(output.seq) > snapshotSeq);
    trimBucket(bucket);
    notify(bucket, message);
    // Re-deliver retained outputs after the snapshot. This mirrors the old
    // array-replay semantics: an output that arrived BEFORE the first snapshot
    // was skipped by MainTerminal (no source dimensions yet) but stayed in the
    // transcript and was re-applied once the snapshot landed. Live consumers
    // that already wrote these outputs drop the re-delivery via their seq
    // guard, so this is a no-op for them.
    for (const output of [...bucket.outputs]) {
      notify(bucket, output);
    }
    return;
  }

  const seq = messageSeq(message.seq);
  const snapshotSeq = bucket.snapshot ? messageSeq(bucket.snapshot.snapshot.seq) : 0;
  // Same guard as the retired terminalTranscript.appendTerminalMessage: an
  // output already covered by the latest snapshot is stale and dropped.
  if (snapshotSeq > 0 && seq <= snapshotSeq) return;
  // Seq de-dup: MainTerminal's write-time lastAppliedOutputSeq guard already
  // skipped duplicates/out-of-order replays; enforcing it at the feed keeps
  // the bucket (and therefore remount backlogs) equally clean.
  const lastOutput = bucket.outputs[bucket.outputs.length - 1];
  if (lastOutput && seq > 0 && seq <= messageSeq(lastOutput.seq)) return;

  bucket.outputs.push(message);
  trimBucket(bucket);
  notify(bucket, message);
}

/**
 * Current bucket content for a card: latest snapshot (if any) followed by the
 * retained outputs, in apply order. Used by MainTerminal on mount / card
 * switch to replay the transcript into a fresh xterm epoch.
 */
export function getTerminalFeedBacklog(cardId: string): TerminalFeedMessage[] {
  const bucket = buckets.get(cardId);
  if (!bucket) return [];
  return bucket.snapshot ? [bucket.snapshot, ...bucket.outputs] : [...bucket.outputs];
}

/**
 * Subscribe to a card's incremental feed messages. The listener receives every
 * message accepted into the bucket from the moment of subscription; pair with
 * getTerminalFeedBacklog() for the content that landed before.
 */
export function subscribeTerminalFeed(
  cardId: string,
  listener: TerminalFeedListener,
): () => void {
  const bucket = ensureBucket(cardId);
  bucket.listeners.add(listener);
  return () => {
    bucket.listeners.delete(listener);
  };
}

/** Test-only helper: drop all buckets and subscriptions. */
export function resetTerminalFeed(): void {
  buckets.clear();
}
