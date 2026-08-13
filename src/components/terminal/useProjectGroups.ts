/**
 * useProjectGroups — aggregate terminal cards by `projectPath`.
 *
 * Returns a stable, sorted list of groups. Used by the left sidebar to show
 * a project-level roll-up of the flat card list.
 *
 *   • path         primary key = `projectPath` (verbatim)
 *   • name         first seen `projectName` for that path
 *   • cards        original TerminalCard objects, preserving card-array order
 *   • unreadCount  how many cards in this group have unread=true
 *   • lastActivity max(`lastActivity`) across the group
 */
import { useMemo } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard, TerminalStatus } from '../../types/terminal';
import { projectDisplayName } from '../../lib/worktreePaths';

export interface ProjectGroup {
  path: string;
  name: string;
  cards: TerminalCard[];
  unreadCount: number;
  lastActivity: number;
  statuses: Set<TerminalStatus>;
}

export function groupCardsByProject(cards: TerminalCard[]): ProjectGroup[] {
  const byPath = new Map<string, ProjectGroup>();
  for (const card of cards) {
    const existing = byPath.get(card.projectPath);
    if (existing) {
      existing.cards.push(card);
      if (card.unread) existing.unreadCount += 1;
      if (card.lastActivity > existing.lastActivity) existing.lastActivity = card.lastActivity;
      existing.statuses.add(card.status);
    } else {
      byPath.set(card.projectPath, {
        path: card.projectPath,
        name: projectDisplayName(card),
        cards: [card],
        unreadCount: card.unread ? 1 : 0,
        lastActivity: card.lastActivity,
        statuses: new Set<TerminalStatus>([card.status]),
      });
    }
  }
  // Sort: unread first, then by lastActivity desc
  return Array.from(byPath.values()).sort((a, b) => {
    if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
    return b.lastActivity - a.lastActivity;
  });
}

export function useProjectGroups(): ProjectGroup[] {
  const cards = useTerminalStore((s) => s.cards);
  return useMemo(() => groupCardsByProject(cards), [cards]);
}
