import { effectiveWorktreePath, worktreeDisplayLabel } from '../worktreePaths';
import type { TerminalCard } from '../../types/terminal';
import type {
  AttentionItem,
  ExecutionContextGroup,
  ExecutionContextStatus,
} from './types';

export function deriveExecutionGroups(
  cards: readonly TerminalCard[],
  attentionItems: readonly AttentionItem[],
): ExecutionContextGroup[] {
  const attentionByCard = new Map<string, AttentionItem[]>();
  for (const item of attentionItems) {
    const existing = attentionByCard.get(item.cardId);
    if (existing) existing.push(item);
    else attentionByCard.set(item.cardId, [item]);
  }

  const grouped = new Map<string, TerminalCard[]>();
  for (const card of cards) {
    const hasAttention = attentionByCard.has(card.id);
    if (card.status === 'idle' && !hasAttention) continue;
    const worktreePath = effectiveWorktreePath(card);
    const id = executionContextGroupId(card.projectPath, worktreePath);
    const current = grouped.get(id);
    if (current) current.push(card);
    else grouped.set(id, [card]);
  }

  const groups = Array.from(grouped, ([id, groupedCards]) => {
    const latestCard = [...groupedCards].sort((a, b) => b.lastActivity - a.lastActivity)[0];
    const groupAttention = groupedCards.flatMap(
      (card) => attentionByCard.get(card.id) ?? [],
    );
    const worktreePath = effectiveWorktreePath(latestCard);
    return {
      id,
      projectPath: latestCard.projectPath,
      projectName: latestCard.projectName,
      worktreePath,
      branchLabel: worktreeDisplayLabel(latestCard),
      cardIds: groupedCards.map((card) => card.id),
      terminalCount: groupedCards.length,
      terminalTypes: Array.from(new Set(groupedCards.map((card) => card.terminalType))),
      attentionCount: groupAttention.length,
      status: resolveGroupStatus(groupedCards, groupAttention),
      terminalStatuses: Array.from(new Set(groupedCards.map((card) => card.status))),
      lastActivity: latestCard.lastActivity,
      preview: latestMeaningfulPreview(groupedCards),
    } satisfies ExecutionContextGroup;
  });

  return groups.sort(
    (left, right) =>
      groupStatusRank(right.status) - groupStatusRank(left.status) ||
      right.lastActivity - left.lastActivity,
  );
}
export function executionContextGroupId(projectPath: string, worktreePath: string): string {
  return `${projectPath}\u001f${worktreePath}`;
}

function resolveGroupStatus(
  cards: readonly TerminalCard[],
  attentionItems: readonly AttentionItem[],
): ExecutionContextStatus {
  if (
    attentionItems.some((item) => item.kind === 'failed') ||
    cards.some((card) => card.status === 'failed')
  ) {
    return 'failed';
  }
  if (
    attentionItems.some(
      (item) => item.kind === 'approval' || item.kind === 'waiting_input',
    ) ||
    cards.some((card) => card.status === 'waiting')
  ) {
    return 'attention';
  }
  if (attentionItems.some((item) => item.kind === 'stalled')) return 'stalled';
  if (cards.some((card) => card.status === 'running')) return 'running';
  if (
    attentionItems.some((item) => item.kind === 'review') ||
    cards.some((card) => card.status === 'completed')
  ) {
    return 'review';
  }
  return 'idle';
}

function latestMeaningfulPreview(cards: readonly TerminalCard[]): string | undefined {
  const ordered = [...cards].sort((a, b) => b.lastActivity - a.lastActivity);
  for (const card of ordered) {
    const preview = card.lastReplyPreview.replace(/\s+/g, ' ').trim();
    if (preview) return preview.length > 180 ? `${preview.slice(0, 179).trimEnd()}…` : preview;
    const latestEvent = [...card.events].sort((a, b) => b.at - a.at)[0];
    const summary = latestEvent?.summary.replace(/\s+/g, ' ').trim();
    if (summary) return summary.length > 180 ? `${summary.slice(0, 179).trimEnd()}…` : summary;
  }
  return undefined;
}

function groupStatusRank(status: ExecutionContextStatus): number {
  switch (status) {
    case 'failed':
      return 6;
    case 'attention':
      return 5;
    case 'stalled':
      return 4;
    case 'running':
      return 3;
    case 'review':
      return 2;
    case 'idle':
      return 1;
  }
}
