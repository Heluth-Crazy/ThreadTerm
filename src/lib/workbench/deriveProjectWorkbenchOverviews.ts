import type { TerminalCard } from '../../types/terminal';
import { projectDisplayName } from '../worktreePaths';
import { deriveWorkbenchSummary } from './deriveAttentionItems';
import type {
  AttentionItem,
  ProjectWorkbenchOverview,
} from './types';

export function deriveProjectWorkbenchOverviews(
  cards: readonly TerminalCard[],
  attentionItems: readonly AttentionItem[],
  followedCardIds: readonly string[],
): ProjectWorkbenchOverview[] {
  const cardsByProject = new Map<string, TerminalCard[]>();
  for (const card of cards) {
    const groupedCards = cardsByProject.get(card.projectPath);
    if (groupedCards) groupedCards.push(card);
    else cardsByProject.set(card.projectPath, [card]);
  }
  const followedIds = new Set(followedCardIds);
  const attentionByProject = new Map<string, AttentionItem[]>();
  for (const item of attentionItems) {
    const projectAttention = attentionByProject.get(item.projectPath);
    if (projectAttention) projectAttention.push(item);
    else attentionByProject.set(item.projectPath, [item]);
  }

  return Array.from(cardsByProject, ([projectPath, projectCards]) => {
    const projectAttention = attentionByProject.get(projectPath) ?? [];
    const summary = deriveWorkbenchSummary(projectCards, projectAttention);
    return {
      projectPath,
      projectName: projectCards[0] ? projectDisplayName(projectCards[0]) : projectPath,
      followedCount: projectCards.filter((card) => followedIds.has(card.id))
        .length,
      runningCount: projectCards.filter((card) => card.status === 'running')
        .length,
      attentionCount: summary.attention,
      reviewCount: summary.review,
      failedCount: summary.failed,
    };
  }).sort(
    (left, right) =>
      compareCaseInsensitive(left.projectName, right.projectName) ||
      compareCaseInsensitive(left.projectPath, right.projectPath),
  );
}

function compareCaseInsensitive(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase();
  const normalizedRight = right.toLocaleLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
