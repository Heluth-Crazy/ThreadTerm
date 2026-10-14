// Mention actions (design-inline-mentions.md §9): pointer hit testing against
// the highlight layer's wrapped fragments, selection containment and the
// open-time snapshot revalidation shared by every menu action. Pure so the
// targeting rules are unit-testable without a browser.
import type { ResolvedMention } from './inlineMentions';

/** The text range fields an action needs; structurally satisfied by `ResolvedMention`. */
export type MentionRange = { start: number; end: number; token: string; itemId: string };
export type MentionRect = { x: number; y: number; width: number; height: number };
/** One `mark` of the highlight layer with each wrapped fragment's client rect. */
export type MentionMark = MentionRange & { rects: readonly MentionRect[] };
/** Captured when the menu opens and revalidated when an action runs. */
export type MentionActionSnapshot = { lifecycle: unknown; start: number; end: number; token: string };

function contains(rect: MentionRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** The mark whose rendered fragment contains the pointer. */
export function mentionMarkAtPoint(marks: readonly MentionMark[], x: number, y: number): MentionMark | undefined {
  for (const mark of marks) if (mark.rects.some(rect => contains(rect, x, y))) return mark;
  return undefined;
}

/** The resolved range fully containing a non-collapsed selection, if any. */
export function mentionContainingSelection(resolved: readonly ResolvedMention[], start: number, end: number): ResolvedMention | undefined {
  if (start === end) return undefined;
  return resolved.find(range => range.start <= start && range.end >= end);
}

/**
 * Pointer invocation: the mark under the pointer. When the pointer lands on a
 * mark the current non-collapsed selection fully covers, the target becomes the
 * resolved range fully containing that selection (so a selection wider than a
 * single token deliberately yields no mention actions). The caret is never used
 * for pointer invocation, so right-clicking plain text shows no mention actions
 * even when the caret happens to sit in a token.
 */
export function pointerMentionTarget(input: {
  resolved: readonly ResolvedMention[];
  marks: readonly MentionMark[];
  selectionStart: number;
  selectionEnd: number;
  x: number;
  y: number;
}): ResolvedMention | undefined {
  const mark = mentionMarkAtPoint(input.marks, input.x, input.y);
  if (!mark) return undefined;
  const selected = input.selectionStart !== input.selectionEnd
    && input.selectionStart <= mark.start && input.selectionEnd >= mark.end;
  if (selected) return mentionContainingSelection(input.resolved, input.selectionStart, input.selectionEnd);
  return mark;
}

export function mentionActionSnapshot(target: ResolvedMention, lifecycle: unknown): MentionActionSnapshot {
  return { lifecycle, start: target.start, end: target.end, token: target.token };
}

/** Whether the token still resolves at the same range on the same lifecycle. */
export function mentionActionStillValid(snapshot: MentionActionSnapshot, current: { lifecycle: unknown; resolved: readonly ResolvedMention[] }): boolean {
  if (snapshot.lifecycle !== current.lifecycle) return false;
  return current.resolved.some(range => range.start === snapshot.start && range.end === snapshot.end && range.token === snapshot.token);
}
