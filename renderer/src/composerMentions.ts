// Composer-scoped inline mention logic (design-inline-mentions.md §2, §6).
//
// Everything here is pure so the composer behavior can be unit-tested without a
// DOM: the immutable submission snapshot, the pick-time budget check, the async
// session pick ticket, the local crash-recovery pair and the sr-only list.
import { serializeMentionedContext, type ContextItem } from './chatContext';
import {
  activeMentionEntries, contextIdentityKey, mentionLabelForItem, resolveMentions,
  validateMentionCatalogue,
  type MentionEntry, type MentionableItem,
} from './inlineMentions';

/** The capacity error for the 64-identity catalogue (no eviction). */
export const MAX_MENTION_MESSAGE = 'This draft has too many mentions. Send or clear it to add more. / 此草稿中的提及过多。请发送或清空后再添加。';

export type MentionRange = { start: number; end: number };

/** One immutable snapshot of the composer used by every submission path. */
export type ComposerSnapshot = { text: string; trayItems: ContextItem[]; active: MentionEntry[] };

/** Copies the latest text, tray and catalogue into one snapshot. */
export function composerSnapshot(text: string, trayItems: readonly ContextItem[], catalogue: readonly MentionEntry[], workspaceRoot?: string): ComposerSnapshot {
  const active = activeMentionEntries(catalogue, resolveMentions(text, catalogue));
  return { text, trayItems: [...trayItems], active: active.map(entry => ({ token: entry.token, item: entry.item })) };
}

/** Serializes a snapshot with the unified envelope (one block per identity). */
export function serializeComposerSnapshot(snapshot: ComposerSnapshot, workspaceRoot?: string): string {
  return serializeMentionedContext({ trayItems: snapshot.trayItems, active: snapshot.active, workspaceRoot }, snapshot.text.trim());
}

/** The text after a mention token replaces the `@query` range (with one space). */
export function mentionInsertedText(text: string, range: MentionRange, token: string): string {
  return `${text.slice(0, range.start)}${token} ${text.slice(range.end)}`;
}

/**
 * Builds the tentative post-pick snapshot and serializes it. Returns the
 * rejection reason so the caller can show the existing identity/byte error
 * while leaving `@query` in the draft.
 */
export function tentativeMentionPick(input: { text: string; trayItems: readonly ContextItem[]; catalogue: readonly MentionEntry[]; workspaceRoot?: string }): { ok: true } | { ok: false; error: unknown } {
  try {
    serializeComposerSnapshot(composerSnapshot(input.text, input.trayItems, input.catalogue, input.workspaceRoot), input.workspaceRoot);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A pending session-mention read that has not inserted anything yet. */
export type MentionPickTicket = {
  id: number;
  lifecycle: unknown;
  sessionId: string | undefined;
  composerGeneration: number;
  start: number;
  end: number;
  queryText: string;
};

/**
 * The composer conditions that decide whether it accepts any edit at all. The
 * textarea is disabled in exactly these states, so every programmatic edit and
 * every async pick must re-read them from live refs instead of a render
 * closure captured before an `await`.
 */
export type ComposerInputState = {
  writable: boolean;
  ended: boolean;
  busy: boolean;
  draftLoaded: boolean;
  overlayFull: boolean;
  recoveryPending: boolean;
};

/** Whether the composer is currently editable (textarea enabled, no recovery choice pending). */
export function composerEditable(state: ComposerInputState): boolean {
  return state.writable && !state.ended && !state.busy && state.draftLoaded && !state.overlayFull && !state.recoveryPending;
}

export type MentionPickCurrent = {
  lifecycle: unknown;
  sessionId: string | undefined;
  composerGeneration: number;
  text: string;
  composing: boolean;
  /** `composerEditable` evaluated from the live refs at resolution time. */
  editable: boolean;
};

/** Whether a resolved session read still belongs to the pick that started it. */
export function mentionPickStillValid(ticket: MentionPickTicket, current: MentionPickCurrent): boolean {
  return ticket.lifecycle === current.lifecycle
    && ticket.sessionId === current.sessionId
    && ticket.composerGeneration === current.composerGeneration
    && current.editable
    && !current.composing
    && current.text.slice(ticket.start, ticket.end) === ticket.queryText;
}

/** The local crash-recovery value: the composer text plus its live catalogue. */
export type LocalRecovery = { text: string; mentions: MentionEntry[] };

/** Writes one versioned `{v:2,text,mentions}` value atomically (single setItem string). */
export function encodeLocalRecovery(text: string, catalogue: readonly MentionEntry[], workspaceRoot?: string): string {
  const active = activeMentionEntries(catalogue, resolveMentions(text, catalogue));
  return JSON.stringify({ v: 2, text, mentions: active });
}

/** Reads the v2 value; any legacy plain-text value is returned as text-only. */
export function decodeLocalRecovery(value: string): LocalRecovery {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as { v?: unknown; text?: unknown; mentions?: unknown };
      if (record.v === 2 && typeof record.text === 'string') {
        return { text: record.text, mentions: validateMentionCatalogue(record.mentions) };
      }
    }
  } catch { /* Legacy plain text. */ }
  return { text: value, mentions: [] };
}

/** A stable signature of the live token → identity mapping of a pair. */
export function liveMentionSignatures(text: string, catalogue: readonly MentionEntry[], workspaceRoot?: string): string {
  return activeMentionEntries(catalogue, resolveMentions(text, catalogue))
    .map(entry => `${entry.token}\u0000${contextIdentityKey(entry.item, workspaceRoot)}`)
    .sort()
    .join('\n');
}

/** Whether the local pair differs from the runtime pair (text or live mapping). */
export function localRecoveryDiffers(local: LocalRecovery, runtime: LocalRecovery, workspaceRoot?: string): boolean {
  if (local.text !== runtime.text) return true;
  return liveMentionSignatures(local.text, local.mentions, workspaceRoot) !== liveMentionSignatures(runtime.text, runtime.mentions, workspaceRoot);
}

const KIND_LABEL: Record<MentionableItem['kind'], { en: string; zh: string }> = {
  file: { en: 'file', zh: '文件' },
  session: { en: 'session', zh: '会话' },
  commit: { en: 'commit', zh: '提交' },
  agent: { en: 'agent', zh: '代理' },
  skill: { en: 'skill', zh: '技能' },
};

/** The screen-reader line listing the active mentions ("Mentions: cart.ts (file), …"). */
export function mentionDescription(active: readonly MentionEntry[], zh: boolean): string {
  if (!active.length) return '';
  const parts = active.map(entry => {
    const kind = KIND_LABEL[entry.item.kind];
    return zh ? `${mentionLabelForItem(entry.item)}（${kind.zh}）` : `${mentionLabelForItem(entry.item)} (${kind.en})`;
  });
  return zh ? `提及：${parts.join('、')}` : `Mentions: ${parts.join(', ')}`;
}
