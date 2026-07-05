/**
 * 终端 store —— slice 与 persist 配置共用的纯函数。
 *
 * 均为从原单文件 store 逐字节搬出的代码；集中放这里让各 slice 复用同一份逻辑，
 * 避免 slice 之间互相 import。
 */
import type {
  ProviderSessionImportInfo,
  TerminalCard,
  TerminalEvent,
  TerminalStatus,
} from '../../types/terminal';
import { MAX_TIMELINE_EVENTS } from '../../types/terminal';
import {
  cancelPendingAutoRestart,
  normalizeAutoRestartConfig,
} from '../../lib/autoRestart';
import { emitSettingsChanged, type TerminalPreferenceSnapshot } from '../../lib/settingsSync';
import { orderCardsByIdList } from '../../lib/cardSort';
import { cardMatchesWorktree } from '../../lib/worktreePaths';
import type { ArchivedTerminalCard, TerminalStore } from './types';
import { MAX_RECENTLY_VIEWED_CARDS } from './types';

export function uid(): string {
  // Not security-sensitive; time + random is plenty.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function uuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();

  // RFC 4122 v4 fallback for older webviews/test environments.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function appendEvent(card: TerminalCard, event: TerminalEvent): TerminalCard {
  const events = [...card.events, event];
  if (events.length > MAX_TIMELINE_EVENTS) {
    events.splice(0, events.length - MAX_TIMELINE_EVENTS);
  }
  return { ...card, events, lastActivity: event.at };
}

export function tailJoin(buffer: string, chunk: string, limit: number): string {
  if (!chunk) return buffer;
  const next = buffer + chunk;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

// Strip ANSI escape sequences and non-printable control characters so the
// preview on cards stays readable. Handles:
//   • CSI  ESC [ ... final-byte         (cursor moves, SGR, erase, DECSET/DECRST...)
//   • OSC  ESC ] ... (BEL | ESC \)      (titles, hyperlinks)
//   • DCS / SOS / PM / APC              (similar structure to OSC)
//   • 2-byte ESC sequences  ESC <single>
//   • single-char C0 controls           (keeping \t \n)
//   • DEL (0x7f) and all C1 controls (0x80-0x9f)
/* eslint-disable no-control-regex */
const ANSI_RE = new RegExp(
  [
    // CSI sequences (ESC [ ... with optional private markers + intermediates + final)
    '\\x1b\\[[0-?]*[ -/]*[@-~]',
    // OSC / DCS / SOS / PM / APC — terminated by BEL or ST (ESC \)
    '\\x1b[\\]PX^_][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    // Escape sequences per VT100 spec: ESC (intermediate 0x20-0x2F)* (final 0x30-0x7E)
    '\\x1b[\\x20-\\x2f]*[\\x30-\\x7e]',
  ].join('|'),
  'g',
);
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(/\r/g, '');
}

export function isProviderSessionType(type: TerminalCard['terminalType']): boolean {
  return type === 'claude' || type === 'codex';
}

export function providerSessionKey(
  provider: ProviderSessionImportInfo['provider'],
  id: string,
): string {
  return `${provider}\0${id}`;
}

export function normalizeImportedProviderSession(
  session: ProviderSessionImportInfo,
): ProviderSessionImportInfo | null {
  const id = session.id.trim();
  const projectPath = session.projectPath.trim();
  if (!id || !projectPath) return null;
  if (session.provider !== 'claude' && session.provider !== 'codex') return null;

  return {
    id,
    provider: session.provider,
    projectPath,
    updatedAt:
      typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : null,
  };
}

export function isTransientStatus(status: TerminalStatus): boolean {
  return status === 'running' || status === 'waiting';
}

export function prepareAutoRestartForPersistence(card: TerminalCard): TerminalCard['autoRestart'] {
  if (!card.autoRestart) return undefined;
  const normalized = normalizeAutoRestartConfig(card.autoRestart);
  return {
    ...cancelPendingAutoRestart(normalized, Date.now()),
    enabled: normalized.enabled,
  };
}

export function terminalPreferenceSnapshotFromState(
  state: Pick<TerminalStore, 'osNotificationsEnabled' | 'supervisorEnabled'>,
): TerminalPreferenceSnapshot {
  return {
    osNotificationsEnabled: state.osNotificationsEnabled,
    supervisorEnabled: state.supervisorEnabled,
  };
}

export function notifyTerminalPreferencesChanged(snapshot: TerminalPreferenceSnapshot): void {
  void emitSettingsChanged({
    domain: 'terminal-preferences',
    sourceWindow: 'settings',
    terminalPreferences: snapshot,
  });
}

export function cardsForProjectView(
  cards: readonly TerminalCard[],
  projectCardOrder: Record<string, string[]> | undefined,
  path: string | null,
  worktreePath?: string | null,
): TerminalCard[] {
  if (!path) return [...cards];
  const projectCards = cards.filter(
    (card) => card.projectPath === path && cardMatchesWorktree(card, worktreePath),
  );
  return orderCardsByIdList(projectCards, projectCardOrder?.[path]);
}

export function prependProjectCardOrder(
  order: Record<string, string[]> | undefined,
  projectPath: string,
  cardId: string,
): Record<string, string[]> {
  const current = order?.[projectPath] ?? [];
  return {
    ...(order ?? {}),
    [projectPath]: [cardId, ...current.filter((id) => id !== cardId)],
  };
}

export function compactProjectCardOrder(
  order: Record<string, string[]> | undefined,
  cards: readonly TerminalCard[],
): Record<string, string[]> {
  if (!order) return {};
  const idsByProject = new Map<string, Set<string>>();
  for (const card of cards) {
    const ids = idsByProject.get(card.projectPath);
    if (ids) ids.add(card.id);
    else idsByProject.set(card.projectPath, new Set([card.id]));
  }

  const next: Record<string, string[]> = {};
  for (const [projectPath, orderedIds] of Object.entries(order)) {
    const validIds = idsByProject.get(projectPath);
    if (!validIds) continue;
    const seen = new Set<string>();
    const cleaned = orderedIds.filter((id) => {
      if (!validIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (cleaned.length > 0) next[projectPath] = cleaned;
  }
  return next;
}

function sameStringArray(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function compactRecentCardIds(
  ids: readonly string[] | undefined,
  cards: readonly TerminalCard[],
): string[] {
  if (!ids || ids.length === 0) return [];
  const liveIds = new Set(cards.map((card) => card.id));
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of ids) {
    if (!liveIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_RECENTLY_VIEWED_CARDS) break;
  }

  return sameStringArray(ids, next) ? (ids as string[]) : next;
}

export function recentCardIdsAfterFocus(
  ids: readonly string[] | undefined,
  id: string | null,
  cards: readonly TerminalCard[],
): string[] {
  const compacted = compactRecentCardIds(ids, cards);
  if (!id || !cards.some((card) => card.id === id)) return compacted;

  const next = [id, ...compacted.filter((candidate) => candidate !== id)].slice(
    0,
    MAX_RECENTLY_VIEWED_CARDS,
  );
  return sameStringArray(ids, next) ? (ids as string[]) : next;
}

export function archiveCardSnapshot(card: TerminalCard, archivedAt: number): ArchivedTerminalCard {
  return {
    ...card,
    archivedAt,
    status: 'idle',
    unread: false,
    autoRestart: prepareAutoRestartForPersistence(card),
  };
}

export function restoreArchivedCardSnapshot(card: ArchivedTerminalCard, now: number): TerminalCard {
  const { archivedAt: _archivedAt, ...restored } = card;
  void _archivedAt;
  return {
    ...restored,
    status: 'idle',
    unread: false,
    lastActivity: now,
    autoRestart: prepareAutoRestartForPersistence(restored),
  };
}

export function archivedCardsForProject(
  archivedCards: readonly ArchivedTerminalCard[] | undefined,
  path: string,
  worktreePath?: string | null,
): ArchivedTerminalCard[] {
  return (archivedCards ?? [])
    .filter((card) => card.projectPath === path && cardMatchesWorktree(card, worktreePath))
    .sort((a, b) => b.archivedAt - a.archivedAt);
}
