/**
 * blockSearchWorker — Web Worker entry that delegates to the shared
 * `searchAcrossBlocks` matcher. Used by `useBlockSearch` when the total
 * block count exceeds the sync-budget threshold.
 *
 * Protocol:
 *   IN  { seq: number; cards; blocks; query; limit }
 *   OUT { seq: number; matches: SearchMatch[] }
 *
 * The hook discards messages whose `seq` is older than its current job.
 */
import { searchAcrossBlocks, type SearchMatch } from './searchAcrossBlocks';
import type { Block, TerminalCard } from '../../types/terminal';

interface Request {
  seq: number;
  cards: TerminalCard[];
  blocks: Record<string, Block[]>;
  query: string;
  limit: number;
}

interface Response {
  seq: number;
  matches: SearchMatch[];
}

self.addEventListener('message', (e: MessageEvent<Request>) => {
  const { seq, cards, blocks, query, limit } = e.data;
  const matches = searchAcrossBlocks(cards, blocks, query, limit);
  const reply: Response = { seq, matches };
  (self as unknown as { postMessage: (m: Response) => void }).postMessage(reply);
});

// keep TS happy — file must be a module
export {};
