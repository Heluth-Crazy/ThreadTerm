import type { ServerMessage } from '@shared/mobile/bridge/protocol';

// Per-card terminal transport store. Terminal output bypasses React state so a
// hot stream only touches the relevant card bucket and its mounted xterm.

export type BridgeTerminalFeedMessage = Extract<
  ServerMessage,
  { kind: 'terminal_output' | 'terminal_snapshot' }
>;
export type TerminalFeedSnapshot = Extract<
  BridgeTerminalFeedMessage,
  { kind: 'terminal_snapshot' }
>;
export type TerminalFeedOutput = Extract<
  BridgeTerminalFeedMessage,
  { kind: 'terminal_output' }
>;
export interface TerminalFeedTruncationNotice {
  kind: 'history_truncated';
  card_id: string;
  omittedBytes: number;
}
export interface TerminalFeedRecoveryBoundary {
  kind: 'recovery_boundary';
  runtimeId: string | null;
}
export type TerminalFeedMessage =
  | BridgeTerminalFeedMessage
  | TerminalFeedTruncationNotice
  | TerminalFeedRecoveryBoundary;
export type TerminalFeedListener = (message: TerminalFeedMessage) => void;

export interface TerminalFeedPushResult {
  accepted: boolean;
  runtimeChanged: boolean;
  needsResync: boolean;
  duplicateTransport: boolean;
}

export interface TerminalFeedRuntimeResult {
  runtimeChanged: boolean;
  resyncCompleted: boolean;
}

export const TERMINAL_FEED_CARD_BUDGET_BYTES = 4 * 1024 * 1024;
export const TERMINAL_FEED_GLOBAL_BUDGET_BYTES = 32 * 1024 * 1024;

interface RetainedOutput {
  message: TerminalFeedOutput;
  bytes: number;
}

interface CardFeedBucket {
  snapshot: TerminalFeedSnapshot | null;
  outputs: RetainedOutput[];
  listeners: Set<TerminalFeedListener>;
  outputBytes: number;
  truncated: boolean;
  omittedBytes: number;
  lastTouched: number;
}

const encoder = new TextEncoder();
const buckets = new Map<string, CardFeedBucket>();
let activeRuntimeId: string | null = null;
let streamBaselineEstablished = false;
let lastStreamSeq = 0;
let resyncPending = false;
let totalOutputBytes = 0;
let touchCounter = 0;

function ensureBucket(cardId: string): CardFeedBucket {
  let bucket = buckets.get(cardId);
  if (!bucket) {
    bucket = {
      snapshot: null,
      outputs: [],
      listeners: new Set(),
      outputBytes: 0,
      truncated: false,
      omittedBytes: 0,
      lastTouched: 0,
    };
    buckets.set(cardId, bucket);
  }
  touchBucket(bucket);
  return bucket;
}

function touchBucket(bucket: CardFeedBucket): void {
  touchCounter += 1;
  bucket.lastTouched = touchCounter;
}

function messageSeq(value: number | undefined): number {
  return Number(value || 0);
}

function messageStreamSeq(value: number | undefined): number {
  return Number(value || 0);
}

function outputBytes(message: TerminalFeedOutput): number {
  return encoder.encode(message.data).byteLength;
}

function notify(bucket: CardFeedBucket, message: TerminalFeedMessage): void {
  for (const listener of [...bucket.listeners]) {
    listener(message);
  }
}

function truncationNotice(cardId: string, bucket: CardFeedBucket): TerminalFeedTruncationNotice {
  return {
    kind: 'history_truncated',
    card_id: cardId,
    omittedBytes: bucket.omittedBytes,
  };
}

function trimOldestOutputBytes(
  cardId: string,
  bucket: CardFeedBucket,
  bytesToFree: number,
): number {
  let freed = 0;
  let removeCount = 0;
  while (removeCount < bucket.outputs.length && freed < bytesToFree) {
    freed += bucket.outputs[removeCount].bytes;
    removeCount += 1;
  }
  if (removeCount === 0) return 0;
  bucket.outputs.splice(0, removeCount);
  bucket.outputBytes = Math.max(0, bucket.outputBytes - freed);
  totalOutputBytes = Math.max(0, totalOutputBytes - freed);
  bucket.truncated = true;
  bucket.omittedBytes += freed;
  notify(bucket, truncationNotice(cardId, bucket));
  return freed;
}

function trimCard(cardId: string, bucket: CardFeedBucket): void {
  const excess = bucket.outputBytes - TERMINAL_FEED_CARD_BUDGET_BYTES;
  if (excess > 0) trimOldestOutputBytes(cardId, bucket, excess);
}

function trimGlobal(): void {
  while (totalOutputBytes > TERMINAL_FEED_GLOBAL_BUDGET_BYTES) {
    let candidateCardId: string | null = null;
    let candidate: CardFeedBucket | null = null;
    for (const [cardId, bucket] of buckets) {
      if (bucket.outputs.length === 0) continue;
      if (!candidate || bucket.lastTouched < candidate.lastTouched) {
        candidateCardId = cardId;
        candidate = bucket;
      }
    }
    if (!candidate || !candidateCardId) return;
    const excess = totalOutputBytes - TERMINAL_FEED_GLOBAL_BUDGET_BYTES;
    if (trimOldestOutputBytes(candidateCardId, candidate, excess) === 0) return;
  }
}

function clearBucketContent(bucket: CardFeedBucket): void {
  bucket.snapshot = null;
  bucket.outputs = [];
  bucket.outputBytes = 0;
  bucket.truncated = false;
  bucket.omittedBytes = 0;
}

function observeRuntime(runtimeId: string | undefined): boolean {
  if (!runtimeId) return false;
  if (activeRuntimeId === null) {
    activeRuntimeId = runtimeId;
    if (buckets.size === 0) return false;
  } else if (activeRuntimeId === runtimeId) {
    return false;
  } else {
    activeRuntimeId = runtimeId;
  }

  totalOutputBytes = 0;
  lastStreamSeq = 0;
  streamBaselineEstablished = false;
  resyncPending = false;
  for (const bucket of buckets.values()) {
    clearBucketContent(bucket);
  }
  return true;
}

/**
 * Apply identity from the authoritative state snapshot. Ordinary metadata
 * snapshots do not advance the output waterline because doing so could hide a
 * missing terminal frame. The first snapshot and an explicit resync establish
 * a new baseline.
 */
export function observeTerminalFeedSnapshot(
  message: Extract<ServerMessage, { kind: 'snapshot' }>,
): TerminalFeedRuntimeResult {
  const runtimeChanged = observeRuntime(message.runtimeId);
  const streamSeq = messageStreamSeq(message.streamSeq);
  const resyncCompleted = resyncPending;
  if (message.runtimeId && (!streamBaselineEstablished || runtimeChanged || resyncPending)) {
    lastStreamSeq = streamSeq;
    streamBaselineEstablished = true;
    resyncPending = false;
  }
  if (runtimeChanged || resyncCompleted) {
    const boundary: TerminalFeedRecoveryBoundary = {
      kind: 'recovery_boundary',
      runtimeId: message.runtimeId ?? activeRuntimeId,
    };
    for (const bucket of buckets.values()) {
      notify(bucket, boundary);
    }
  }
  return { runtimeChanged, resyncCompleted };
}

export function terminalFeedCardId(message: ServerMessage): string | null {
  if (message.kind === 'terminal_output') return message.card_id;
  if (message.kind === 'terminal_snapshot') return message.snapshot.cardId;
  return null;
}

/**
 * Ingest one bridge terminal message. `streamSeq` detects missing WebSocket
 * frames across all cards; the existing PTY `seq` remains the per-card
 * snapshot/output ordering guard.
 */
export function pushTerminalFeedMessage(
  message: BridgeTerminalFeedMessage,
): TerminalFeedPushResult {
  const runtimeId =
    message.kind === 'terminal_snapshot' ? message.snapshot.runtimeId : message.runtimeId;
  const streamSeq =
    message.kind === 'terminal_snapshot' ? message.snapshot.streamSeq : message.streamSeq;
  const runtimeChanged = observeRuntime(runtimeId);
  const cardId = terminalFeedCardId(message);
  if (!cardId) {
    return {
      accepted: false,
      runtimeChanged,
      needsResync: false,
      duplicateTransport: false,
    };
  }

  if (message.kind === 'terminal_output' && runtimeId && streamSeq) {
    const nextStreamSeq = messageStreamSeq(streamSeq);
    if (!streamBaselineEstablished || runtimeChanged) {
      lastStreamSeq = nextStreamSeq;
      streamBaselineEstablished = true;
    } else if (nextStreamSeq <= lastStreamSeq) {
      return {
        accepted: false,
        runtimeChanged,
        needsResync: false,
        duplicateTransport: true,
      };
    } else {
      const gapDetected = nextStreamSeq > lastStreamSeq + 1;
      lastStreamSeq = nextStreamSeq;
      if (gapDetected && !resyncPending) {
        resyncPending = true;
        const accepted = appendTerminalOutput(cardId, message);
        return {
          accepted,
          runtimeChanged,
          needsResync: true,
          duplicateTransport: false,
        };
      }
    }
  }

  if (message.kind === 'terminal_snapshot') {
    const bucket = ensureBucket(cardId);
    const snapshotSeq = messageSeq(message.snapshot.seq);
    bucket.snapshot = message;
    const retained: RetainedOutput[] = [];
    let removedBytes = 0;
    for (const output of bucket.outputs) {
      if (messageSeq(output.message.seq) > snapshotSeq) {
        retained.push(output);
      } else {
        removedBytes += output.bytes;
      }
    }
    bucket.outputs = retained;
    bucket.outputBytes = Math.max(0, bucket.outputBytes - removedBytes);
    totalOutputBytes = Math.max(0, totalOutputBytes - removedBytes);
    trimCard(cardId, bucket);
    trimGlobal();
    notify(bucket, message);
    if (bucket.truncated) notify(bucket, truncationNotice(cardId, bucket));
    for (const output of [...bucket.outputs]) {
      notify(bucket, output.message);
    }
    return {
      accepted: true,
      runtimeChanged,
      needsResync: false,
      duplicateTransport: false,
    };
  }

  return {
    accepted: appendTerminalOutput(cardId, message),
    runtimeChanged,
    needsResync: false,
    duplicateTransport: false,
  };
}

function appendTerminalOutput(cardId: string, message: TerminalFeedOutput): boolean {
  if (!message.data) return false;
  const bucket = ensureBucket(cardId);
  const seq = messageSeq(message.seq);
  const snapshotSeq = bucket.snapshot ? messageSeq(bucket.snapshot.snapshot.seq) : 0;
  if (snapshotSeq > 0 && seq <= snapshotSeq) return false;
  const lastOutput = bucket.outputs[bucket.outputs.length - 1]?.message;
  if (lastOutput && seq > 0 && seq <= messageSeq(lastOutput.seq)) return false;

  const bytes = outputBytes(message);
  bucket.outputs.push({ message, bytes });
  bucket.outputBytes += bytes;
  totalOutputBytes += bytes;
  trimCard(cardId, bucket);
  trimGlobal();
  notify(bucket, message);
  return true;
}

export function getTerminalFeedBacklog(cardId: string): TerminalFeedMessage[] {
  const bucket = buckets.get(cardId);
  if (!bucket) return [];
  touchBucket(bucket);
  const messages: TerminalFeedMessage[] = [];
  if (bucket.snapshot) messages.push(bucket.snapshot);
  if (bucket.truncated) messages.push(truncationNotice(cardId, bucket));
  messages.push(...bucket.outputs.map((output) => output.message));
  return messages;
}

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

export function disposeTerminalFeed(cardId: string): void {
  const bucket = buckets.get(cardId);
  if (!bucket) return;
  totalOutputBytes = Math.max(0, totalOutputBytes - bucket.outputBytes);
  buckets.delete(cardId);
}

export function retainTerminalFeedCards(cardIds: readonly string[]): void {
  const retained = new Set(cardIds);
  for (const cardId of [...buckets.keys()]) {
    if (!retained.has(cardId)) disposeTerminalFeed(cardId);
  }
}

export function getTerminalFeedMemoryUsage(): {
  runtimeId: string | null;
  lastStreamSeq: number;
  resyncPending: boolean;
  totalOutputBytes: number;
  cards: Record<string, { outputBytes: number; truncated: boolean; omittedBytes: number }>;
} {
  return {
    runtimeId: activeRuntimeId,
    lastStreamSeq,
    resyncPending,
    totalOutputBytes,
    cards: Object.fromEntries(
      [...buckets.entries()].map(([cardId, bucket]) => [
        cardId,
        {
          outputBytes: bucket.outputBytes,
          truncated: bucket.truncated,
          omittedBytes: bucket.omittedBytes,
        },
      ]),
    ),
  };
}

/** Test-only helper: drop all buckets, subscriptions, and transport identity. */
export function resetTerminalFeed(): void {
  buckets.clear();
  activeRuntimeId = null;
  streamBaselineEstablished = false;
  lastStreamSeq = 0;
  resyncPending = false;
  totalOutputBytes = 0;
  touchCounter = 0;
}
