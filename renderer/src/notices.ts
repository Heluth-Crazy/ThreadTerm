import { useSyncExternalStore } from 'react';
import { transportText, type TransportKind } from './requestErrors';

/**
 * App-wide notices: floating messages in a corner instead of error bars inside a view (owner 11-25). One notice per
 * key; a newer message with the same key replaces it. Errors close after a while on their own (hovering keeps them),
 * every notice has a close button, and the transport notice stays until the runtime answers again.
 */
export type NoticeTone = 'error' | 'warning' | 'info';
export interface Notice { id: number; key: string; tone: NoticeTone; text: string; ttlMs?: number }

const MAX_NOTICES = 4;
const DEFAULT_TTL: Record<NoticeTone, number | undefined> = { error: 9_000, warning: undefined, info: 4_000 };
export const TRANSPORT_NOTICE = 'runtime-transport';

let notices: readonly Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const publish = (next: readonly Notice[]) => { notices = next; for (const listener of listeners) listener(); };

export function notify(notice: { key?: string; tone: NoticeTone; text: string; ttlMs?: number | null }): string {
  const key = notice.key ?? `notice-${nextId}`;
  const ttlMs = notice.ttlMs === null ? undefined : notice.ttlMs ?? DEFAULT_TTL[notice.tone];
  const current = notices.find(row => row.key === key);
  if (current && current.text === notice.text && current.tone === notice.tone) return key;
  const row: Notice = { id: nextId++, key, tone: notice.tone, text: notice.text, ...(ttlMs ? { ttlMs } : {}) };
  publish([...notices.filter(item => item.key !== key), row].slice(-MAX_NOTICES));
  return key;
}

export function dismissNotice(key: string): void {
  if (notices.some(row => row.key === key)) publish(notices.filter(row => row.key !== key));
}

export const currentNotices = (): readonly Notice[] => notices;
export function subscribeNotices(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useNotices(): readonly Notice[] { return useSyncExternalStore(subscribeNotices, currentNotices, currentNotices); }

/*
 * Recovery: after a transport failure, the next request the runtime answers (or the desktop reporting that it
 * reconnected) clears the transport notice and bumps `recoveryGeneration`, so views that could not read reload.
 * A success with no failure before it changes nothing, so views never reload on ordinary traffic.
 */
let failing = false;
let recoveryGeneration = 0;
const recoveryListeners = new Set<() => void>();

/** A lost connection only marks views for reload: the status chip in the header already says it is reconnecting. */
export function reportTransportFailure(kind: TransportKind, zh: boolean): void {
  failing = true;
  if (kind === 'timeout') notify({ key: TRANSPORT_NOTICE, tone: 'warning', text: transportText(kind, zh), ttlMs: null });
}

export function reportTransportRecovered(): void {
  if (!failing) return;
  failing = false;
  dismissNotice(TRANSPORT_NOTICE);
  recoveryGeneration += 1;
  for (const listener of recoveryListeners) listener();
}

const currentRecovery = () => recoveryGeneration;
function subscribeRecovery(listener: () => void): () => void { recoveryListeners.add(listener); return () => { recoveryListeners.delete(listener); }; }
/** Changes when the runtime answers again after a transport failure: put it in the deps of an effect that loads. */
export function useRuntimeRecovery(): number { return useSyncExternalStore(subscribeRecovery, currentRecovery, currentRecovery); }
