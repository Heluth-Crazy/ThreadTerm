/**
 * useBlockSearch — React hook that runs `searchAcrossBlocks` either
 * synchronously (≤ SYNC_BUDGET total blocks) or via a Web Worker.
 *
 * Cancellation: a monotonically incrementing `seq` lets us discard stale
 * worker responses when the query/store changes faster than the worker
 * can reply.
 *
 * Fallback: if `Worker` is unavailable (e.g. happy-dom test env or older
 * webview) we silently run the sync matcher even past the budget. The
 * UX-visible delay is the only loss.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Block, TerminalCard } from '../../types/terminal';
import { searchAcrossBlocks, type SearchMatch } from './searchAcrossBlocks';

const SYNC_BUDGET = 5000;
const RESULT_LIMIT = 500;

export interface UseBlockSearchInput {
  cards: TerminalCard[];
  blocks: Record<string, Block[]>;
  query: string;
}

export interface UseBlockSearchResult {
  matches: SearchMatch[];
  loading: boolean;
}

function totalBlocks(blocks: Record<string, Block[]>): number {
  let n = 0;
  for (const k in blocks) n += blocks[k].length;
  return n;
}

export function useBlockSearch(input: UseBlockSearchInput): UseBlockSearchResult {
  const { cards, blocks, query } = input;
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);

  // total block count snapshot — affects the sync/worker branch decision
  const blockCount = useMemo(() => totalBlocks(blocks), [blocks]);

  // Lazily create the Worker only when it would be useful and supported.
  useEffect(() => {
    if (blockCount <= SYNC_BUDGET) return;
    if (typeof Worker === 'undefined') return;
    if (workerRef.current) return;

    try {
      workerRef.current = new Worker(
        new URL('./blockSearchWorker.ts', import.meta.url),
        { type: 'module' },
      );
    } catch {
      workerRef.current = null;
    }

    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [blockCount]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches([]);
      setLoading(false);
      return;
    }

    const seq = ++seqRef.current;

    // Sync branch.
    if (blockCount <= SYNC_BUDGET || !workerRef.current) {
      const result = searchAcrossBlocks(cards, blocks, q, RESULT_LIMIT);
      // Even sync results need the seq guard — guarantees the latest
      // setState wins under React 18 batching weirdness.
      if (seq === seqRef.current) {
        setMatches(result);
        setLoading(false);
      }
      return;
    }

    // Worker branch.
    setLoading(true);
    const worker = workerRef.current;
    const onMessage = (e: MessageEvent<{ seq: number; matches: SearchMatch[] }>) => {
      if (e.data.seq !== seq) return; // stale reply
      setMatches(e.data.matches);
      setLoading(false);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ seq, cards, blocks, query: q, limit: RESULT_LIMIT });

    return () => {
      worker.removeEventListener('message', onMessage);
    };
  }, [cards, blocks, blockCount, query]);

  return { matches, loading };
}
