/**
 * commandRegistry — pure builder that turns store state into a flat list of
 * command-palette entries grouped by purpose. No side effects at build time.
 *
 * Stage 5.2 spec: "仅复用现有 store action，不新增可执行项".  Each entry's
 * `run()` only invokes pre-existing terminalStore actions; we don't add new
 * surface area through the palette.
 */
import type { TerminalCard, Block, TerminalAiIntent } from '../../types/terminal';
import type { SettingsTab } from '../../lib/settingsWindow';

export type CommandGroup =
  | 'jump-card'
  | 'jump-block'
  | 'switch-project'
  | 'change-intent'
  | 'toggle-overlay'
  | 'settings';

export interface CommandEntry {
  id: string;
  label: string;
  /** Lowercased haystack used by `fuzzyFilter`; usually `${label} ${detail}`. */
  searchText: string;
  /** Optional secondary line (cwd, project, etc.). */
  detail?: string;
  group: CommandGroup;
  run: () => void;
}

export interface CommandRegistryActions {
  focusCard: (id: string) => void;
  selectProject: (path: string | null) => void;
  selectBlock: (cardId: string, blockId: string | null) => void;
  toggleNotificationCentre: (open?: boolean) => void;
  openSettings: (tab?: SettingsTab) => void;
  /** Stage 5.2 — focused-card AI intent change. Optional so legacy
   *  callers without intent plumbing still compile. */
  updateCardAiIntent?: (cardId: string, intent: TerminalAiIntent | null) => void;
}

export interface CommandRegistryInput {
  cards: TerminalCard[];
  blocks: Record<string, Block[]>;
  projects: string[];
  /** Currently focused card id; gates `change-intent` entries. */
  focusedCardId?: string | null;
  actions: CommandRegistryActions;
}

/** All AI intent values plus a synthetic `null` slot for "Clear intent". */
const INTENT_OPTIONS: Array<TerminalAiIntent | null> = [
  'review',
  'fix',
  'research',
  'test',
  'docs',
  null,
];

export function buildCommandRegistry(input: CommandRegistryInput): CommandEntry[] {
  const out: CommandEntry[] = [];

  // Jump-to-card
  for (const c of input.cards) {
    out.push({
      id: `card:${c.id}`,
      label: c.projectName,
      detail: c.projectPath,
      searchText: `${c.projectName} ${c.projectPath}`.toLowerCase(),
      group: 'jump-card',
      run: () => input.actions.focusCard(c.id),
    });
  }

  // Jump-to-block
  for (const c of input.cards) {
    const list = input.blocks[c.id] ?? [];
    for (const b of list) {
      out.push({
        id: `block:${b.id}`,
        label: b.command,
        detail: `${c.projectName} · ${b.cwd}`,
        searchText: `${b.command} ${b.cwd} ${c.projectName}`.toLowerCase(),
        group: 'jump-block',
        run: () => {
          input.actions.focusCard(c.id);
          input.actions.selectBlock(c.id, b.id);
        },
      });
    }
  }

  // Switch project
  for (const p of input.projects) {
    out.push({
      id: `project:${p}`,
      label: p,
      searchText: p.toLowerCase(),
      group: 'switch-project',
      run: () => input.actions.selectProject(p),
    });
  }

  // Toggle / Settings
  out.push(
    {
      id: 'overlay:toggle-notifications',
      label: 'Toggle notification centre',
      searchText: 'toggle notification centre',
      group: 'toggle-overlay',
      run: () => input.actions.toggleNotificationCentre(),
    },
    {
      id: 'settings:appearance',
      label: 'Settings · Appearance',
      searchText: 'settings appearance',
      group: 'settings',
      run: () => input.actions.openSettings('appearance'),
    },
    {
      id: 'settings:shortcuts',
      label: 'Settings · Shortcuts',
      searchText: 'settings shortcuts',
      group: 'settings',
      run: () => input.actions.openSettings('shortcuts'),
    },
  );

  // Change card intent — only when a card is focused and the host has
  // wired `updateCardAiIntent`. Each intent (plus a "Clear" entry) gets
  // its own palette row so users can fuzzy-find by intent name.
  if (input.focusedCardId && input.actions.updateCardAiIntent) {
    const cardId = input.focusedCardId;
    const update = input.actions.updateCardAiIntent;
    for (const intent of INTENT_OPTIONS) {
      const id = intent ?? 'none';
      out.push({
        id: `intent:${id}`,
        label: intent ? `Set intent: ${intent}` : 'Clear intent',
        searchText: intent
          ? `set intent ${intent} change`.toLowerCase()
          : 'clear intent none change',
        group: 'change-intent',
        run: () => update(cardId, intent),
      });
    }
  }

  return out;
}

/**
 * Subsequence fuzzy matcher with a small consecutive-bonus.
 *
 * Score = matches * 10 + consecutive * 5 - (text.length - matches).
 * Higher is better. Items pass the filter if every character in the
 * lowercased query appears in order in `searchText`. Empty queries pass
 * everything through unsorted.
 */
export function fuzzyFilter<T extends CommandEntry>(entries: T[], query: string): T[] {
  if (!query.trim()) return entries.slice();
  const q = query.toLowerCase();
  const scored: Array<{ e: T; score: number }> = [];

  for (const e of entries) {
    const text = e.searchText;
    let qi = 0;
    let lastMatch = -2;
    let consecutive = 0;
    let matches = 0;
    for (let i = 0; i < text.length && qi < q.length; i++) {
      if (text[i] === q[qi]) {
        matches += 1;
        if (i === lastMatch + 1) consecutive += 1;
        lastMatch = i;
        qi += 1;
      }
    }
    if (qi === q.length) {
      const score = matches * 10 + consecutive * 5 - (text.length - matches);
      scored.push({ e, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.e);
}
