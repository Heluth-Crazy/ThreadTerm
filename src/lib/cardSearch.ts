/**
 * Card search — substring matcher for filtering cards by name / path.
 *
 * Plain case-insensitive substring match (not fuzzy) so results stay
 * predictable and consistent with the mobile drawer's filter behaviour.
 */

/** Minimal shape needed to match a card — satisfied by both the desktop
 *  `TerminalCard` and the mobile bridge `CardMeta`. */
export interface CardSearchFields {
  projectName: string;
  projectPath: string;
  worktreePath?: string | null;
  terminalType?: string | null;
}

export function matchesCardQuery(card: CardSearchFields, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    card.projectName,
    card.projectPath,
    card.worktreePath ?? '',
    card.terminalType ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}
