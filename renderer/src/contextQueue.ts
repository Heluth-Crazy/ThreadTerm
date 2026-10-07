import { MAX_CONTEXT_BYTES, parseContext } from './chatContext';

/** Queue edits change the instructions while retaining the exact accepted context envelope. */
export function contextQueueText(original: string, text: string): string {
  const parsed = parseContext(original);
  const next = parsed ? original.slice(0, original.length - parsed.text.length) + text : text;
  if (new TextEncoder().encode(next).length > MAX_CONTEXT_BYTES) throw new Error('Context attachments and message must not exceed 128 KiB.');
  return next;
}
