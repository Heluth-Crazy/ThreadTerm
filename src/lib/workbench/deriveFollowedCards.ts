import type { TerminalCard } from '../../types/terminal';
import { filterWorkbenchCards } from './deriveAttentionItems';

export function deriveFollowedCards(
  cards: readonly TerminalCard[],
  followedCardIds: readonly string[],
  selectedProjectPath?: string | null,
  selectedWorktreePath?: string | null,
): TerminalCard[] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const followedCards = followedCardIds
    .map((cardId) => cardsById.get(cardId))
    .filter((card): card is TerminalCard => Boolean(card));
  return filterWorkbenchCards(
    followedCards,
    selectedProjectPath,
    selectedWorktreePath,
  );
}
