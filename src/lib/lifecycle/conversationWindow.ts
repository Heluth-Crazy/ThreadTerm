export const MAX_MOUNTED_CONVERSATION_ROWS = 160;

export interface ConversationWindow<T> {
  items: T[];
  startIndex: number;
  endIndex: number;
  totalCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  atLatest: boolean;
}

/**
 * Return one fixed-size page without copying or mutating authoritative items.
 * `endExclusive=null` follows the live tail; a number pins an older page.
 */
export function deriveConversationWindow<T>(
  items: readonly T[],
  endExclusive: number | null,
  limit = MAX_MOUNTED_CONVERSATION_ROWS,
): ConversationWindow<T> {
  const totalCount = items.length;
  const safeLimit = Math.max(1, Math.floor(limit));
  const resolvedEnd = endExclusive === null
    ? totalCount
    : Math.min(totalCount, Math.max(0, Math.floor(endExclusive)));
  const startIndex = Math.max(0, resolvedEnd - safeLimit);
  return {
    items: items.slice(startIndex, resolvedEnd),
    startIndex,
    endIndex: resolvedEnd,
    totalCount,
    hasOlder: startIndex > 0,
    hasNewer: resolvedEnd < totalCount,
    atLatest: resolvedEnd === totalCount,
  };
}

export type ConversationProvider = 'claude' | 'codex';

interface MountedConversationRows {
  provider: ConversationProvider;
  mountedCount: number;
  totalCount: number;
}

const mountedRowsByView = new Map<string, MountedConversationRows>();

export function publishMountedConversationRows(
  viewId: string,
  sample: MountedConversationRows,
): () => void {
  const normalized = {
    provider: sample.provider,
    mountedCount: Math.max(0, Math.floor(sample.mountedCount)),
    totalCount: Math.max(0, Math.floor(sample.totalCount)),
  };
  mountedRowsByView.set(viewId, normalized);
  return () => {
    if (mountedRowsByView.get(viewId) === normalized) {
      mountedRowsByView.delete(viewId);
    }
  };
}

export function getMountedConversationRowDiagnostics() {
  const samples = [...mountedRowsByView.values()];
  const claude = samples.filter((sample) => sample.provider === 'claude');
  const codex = samples.filter((sample) => sample.provider === 'codex');
  const sum = (values: MountedConversationRows[], key: 'mountedCount' | 'totalCount') =>
    values.reduce((total, sample) => total + sample[key], 0);
  return {
    mountedMessageRowCount: sum(samples, 'mountedCount'),
    claudeMountedMessageRowCount: sum(claude, 'mountedCount'),
    codexMountedMessageRowCount: sum(codex, 'mountedCount'),
    authoritativeMessageCount: sum(samples, 'totalCount'),
    viewCount: samples.length,
    perViewLimit: MAX_MOUNTED_CONVERSATION_ROWS,
  };
}
