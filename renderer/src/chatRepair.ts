import type { ChatRepairAvailability as SnapshotRepairAvailability } from '@threadterm/protocol';

/** Snapshot-authored repair availability shared by mounted Chat and its session menu. */
export type ChatRepairAvailability = SnapshotRepairAvailability & {
  /** Renderer-only: the mounted view currently owns the normal Chat lease. */
  writable?: boolean;
};

const availability = new Map<string, Map<string, ChatRepairAvailability>>();
export const CHAT_REPAIR_CHANGED = 'threadterm:chat-repair-changed';
export const CHAT_REPAIR_REQUEST = 'threadterm:chat-repair-request';

export function setChatRepairAvailability(sessionId: string, owner: string, next: ChatRepairAvailability | undefined): void {
  const views = availability.get(sessionId) ?? new Map<string, ChatRepairAvailability>();
  views.delete(owner);
  if (next) views.set(owner, next);
  if (views.size) availability.set(sessionId, views);
  else availability.delete(sessionId);
  dispatchEvent(new CustomEvent(CHAT_REPAIR_CHANGED, { detail: { sessionId } }));
}

function repairView(sessionId: string): [string, ChatRepairAvailability] | undefined {
  const views = [...(availability.get(sessionId)?.entries() ?? [])].reverse();
  return views.find(([, value]) => value.offered && value.writable)
    ?? views.find(([, value]) => value.offered)
    ?? views[0];
}

export function chatRepairAvailability(sessionId: string): ChatRepairAvailability | undefined {
  return repairView(sessionId)?.[1];
}

export function requestChatRepair(sessionId: string): void {
  const view = repairView(sessionId);
  if (view?.[1].offered && view[1].writable) {
    dispatchEvent(new CustomEvent(CHAT_REPAIR_REQUEST, { detail: { sessionId, owner: view[0] } }));
  }
}
