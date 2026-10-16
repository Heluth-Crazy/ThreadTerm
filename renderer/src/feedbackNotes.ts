import type { ChatFeedbackNote, ChatPart } from '@threadterm/protocol';
import { hasRedactedBrowserResult } from './browserToolActivity';

/**
 * E2 feedback notes. The store lives in the runtime; this module only reads
 * what a tool result already carries and shapes the strip's presentation.
 * No provider-name branching: detection is by the exact tool identity.
 */

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** The runtime store caps each note at 4,000 characters. */
export const MAX_NOTE_CHARS = 4000;

/** True while a serialized note body still fits the runtime's character cap. */
export function noteBodyFits(text: string): boolean {
  return Array.from(text).length <= MAX_NOTE_CHARS;
}

/** A read snapshot only lands while no later event or read superseded it. */
export function readIsCurrent(sequence: number, current: number): boolean {
  return sequence === current;
}

/** The exact `feedback_check` tool, whatever envelope a provider used. */
export function isFeedbackCheck(part: ChatPart): boolean {
  if (hasRedactedBrowserResult(part)) return false;
  const data = record(part.data);
  const tool = text(data.tool);
  const server = text(data.server);
  if (tool === 'feedback_check' && (server === undefined || server === 'threadterm')) return true;
  const name = text(part.toolName) ?? text(data.name);
  if (!name) return false;
  return name === 'feedback_check' || name === 'mcp__threadterm__feedback_check' || name === 'threadterm__feedback_check';
}

function note(value: unknown): ChatFeedbackNote | undefined {
  const item = record(value);
  const id = text(item.id), sessionId = text(item.sessionId), turnId = text(item.turnId);
  const body = text(item.text), status = item.status;
  if (!id || !sessionId || !turnId || body === undefined) return undefined;
  if (status !== 'waiting' && status !== 'received') return undefined;
  return {
    id, sessionId, turnId, text: body,
    status,
    createdAt: text(item.createdAt) ?? '',
  };
}

function notesOf(value: unknown, depth = 0): ChatFeedbackNote[] | undefined {
  if (depth > 4) return undefined;
  if (typeof value === 'string') {
    try {
      return notesOf(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  const item = record(value);
  if (Array.isArray(item.notes)) {
    return item.notes.map(note).filter((entry): entry is ChatFeedbackNote => entry !== undefined);
  }
  if (Array.isArray(item.content)) {
    for (const entry of item.content) {
      const found = notesOf(record(entry).text, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Notes carried by a completed `feedback_check` result, or `undefined` while
 * the call is still running or the result shape is unknown. An empty array
 * means the agent checked and there was nothing waiting.
 */
export function feedbackNotesFromPart(part: ChatPart): ChatFeedbackNote[] | undefined {
  if (!isFeedbackCheck(part)) return undefined;
  const data = record(part.data);
  const candidates = [
    record(data.result).content,
    data.result,
    record(data.partialResult).content,
    data.aggregatedOutput,
    data.output,
    data.rawOutput,
    data.content,
  ];
  for (const candidate of candidates) {
    const found = notesOf(candidate);
    if (found) return found;
  }
  return undefined;
}

/** Chronological order: the runtime returns rows oldest first per turn. */
export function sortNotes(notes: readonly ChatFeedbackNote[]): ChatFeedbackNote[] {
  return [...notes].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

/** Apply one `chat.feedback` event delta without duplicating or losing rows. */
export function applyNoteEvent(
  current: readonly ChatFeedbackNote[],
  sessionId: string,
  incoming: readonly ChatFeedbackNote[],
  removedIds: readonly string[],
): ChatFeedbackNote[] {
  const removed = new Set(removedIds);
  const byId = new Map<string, ChatFeedbackNote>();
  for (const existing of current) {
    if (!removed.has(existing.id)) byId.set(existing.id, existing);
  }
  for (const entry of incoming) {
    if (entry.sessionId === sessionId && !removed.has(entry.id)) byId.set(entry.id, entry);
  }
  return sortNotes([...byId.values()]);
}

/** Waiting notes can still be sent as an ordinary message at turn end. */
export function waitingNotes(notes: readonly ChatFeedbackNote[]): ChatFeedbackNote[] {
  return notes.filter(entry => entry.status === 'waiting');
}

/** One message body for "Send all as message". */
export function notesMessage(notes: readonly ChatFeedbackNote[]): string {
  return notes.map(entry => entry.text).join('\n\n');
}
