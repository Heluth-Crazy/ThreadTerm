import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { activeTurnId } from './chatPresentation';

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * A reply text part is a Markdown body the assistant wrote as its answer.
 * Commentary, the plan-usage card and empty bodies are not replies. Tool,
 * thinking and sub-agent parts are never text parts, so they are excluded.
 */
export function isReplyTextPart(part: ChatPart): boolean {
  if (part.type !== 'text' || typeof part.text !== 'string' || !part.text.trim()) return false;
  if (part.phase === 'commentary') return false;
  if (asRecord(part.data).kind === 'plan') return false;
  return true;
}

/**
 * The reply's Markdown source: its final-answer text parts, joined with blank
 * lines when the native turn split the answer across several parts.
 */
export function replyMarkdown(item: ChatItem): string {
  if (item.role !== 'assistant') return '';
  return item.parts.filter(isReplyTextPart).map(part => part.text ?? '').join('\n\n');
}

interface CachedReplyTurn {
  rows: readonly ChatItem[];
  active: boolean;
  itemId?: string;
  markdown?: string;
}

const sameRows = (left: readonly ChatItem[], right: readonly ChatItem[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** Reuse settled reply work across cumulative revisions of a different live turn. */
export function createReplyActionMarkdownCache() {
  let cachedTurns = new Map<string, CachedReplyTurn>();
  return {
    get(items: readonly ChatItem[], sessionStatus = 'idle', liveTurnId?: string): Map<string, string> {
      const sessionBusy = ['starting', 'running', 'waiting'].includes(sessionStatus);
      const turns = new Map<string, ChatItem[]>();
      for (const item of items) {
        const key = item.turnId ?? item.id;
        const rows = turns.get(key) ?? [];
        rows.push(item);
        turns.set(key, rows);
      }
      const nextCache = new Map<string, CachedReplyTurn>();
      const actions = new Map<string, string>();
      for (const [turnId, rows] of turns) {
        const active = sessionBusy && (!liveTurnId || !rows[0]?.turnId || turnId === liveTurnId);
        const cached = cachedTurns.get(turnId);
        if (cached && cached.active === active && sameRows(cached.rows, rows)) {
          nextCache.set(turnId, cached);
          if (cached.itemId && cached.markdown) actions.set(cached.itemId, cached.markdown);
          continue;
        }
        const status = [...rows].reverse().find(row => row.turnStatus)?.turnStatus;
        const recordedOutcome = status ? ['completed', 'failed', 'interrupted'].includes(status) : rows.some(row => row.elapsedMs != null);
        const unfinished = rows.some(row => row.parts.some(part => part.status === 'streaming' || part.status === 'running'));
        const settled = recordedOutcome || (!unfinished && !active);
        let itemId: string | undefined, markdown: string | undefined;
        if (settled) {
          const replies = rows.map(row => ({ row, markdown: replyMarkdown(row) })).filter(reply => reply.markdown);
          const last = replies.at(-1);
          if (last) {
            itemId = last.row.id;
            markdown = replies.map(reply => reply.markdown).join('\n\n');
            actions.set(itemId, markdown);
          }
        }
        nextCache.set(turnId, { rows: [...rows], active, itemId, markdown });
      }
      cachedTurns = nextCache;
      return actions;
    },
  };
}

/** One verbatim payload on the last answer item, only after its whole turn settles. */
export function replyActionMarkdown(items: readonly ChatItem[], sessionStatus = 'idle'): Map<string, string> {
  const sessionBusy = ['starting', 'running', 'waiting'].includes(sessionStatus);
  const liveTurnId = sessionBusy ? activeTurnId([...items], sessionStatus) : undefined;
  return createReplyActionMarkdownCache().get(items, sessionStatus, liveTurnId);
}
