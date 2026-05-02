import { describe, expect, it, vi } from 'vitest';
import { buildCommandRegistry, fuzzyFilter } from './commandRegistry';
import type { TerminalCard, Block } from '../../types/terminal';

function card(id: string, name: string): TerminalCard {
  return {
    id,
    projectName: name,
    projectPath: `/proj/${name}`,
    terminalType: 'shell',
    status: 'idle',
    createdAt: 0,
    lastActivity: 0,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    unread: false,
    events: [],
  } as unknown as TerminalCard;
}

function emptyActions() {
  return {
    focusCard: vi.fn(),
    selectProject: vi.fn(),
    selectBlock: vi.fn(),
    toggleNotificationCentre: vi.fn(),
    openSettings: vi.fn(),
  };
}

describe('buildCommandRegistry', () => {
  it('produces grouped entries from a store snapshot', () => {
    const cards = [card('c1', 'foo'), card('c2', 'bar')];
    const blocks: Record<string, Block[]> = {
      c1: [
        { id: 'b1', cardId: 'c1', cwd: '/foo', command: 'npm test', startedAt: 0, bufferStart: 0, state: 'success' },
      ],
    };

    const reg = buildCommandRegistry({
      cards,
      blocks,
      projects: ['/proj/foo', '/proj/bar'],
      actions: emptyActions(),
    });

    const groups = new Set(reg.map((e) => e.group));
    expect(groups.has('jump-card')).toBe(true);
    expect(groups.has('jump-block')).toBe(true);
    expect(groups.has('switch-project')).toBe(true);
    expect(groups.has('toggle-overlay')).toBe(true);
    expect(groups.has('open-settings')).toBe(true);
  });

  it('jump-card entry runs focusCard with the matching id', () => {
    const actions = emptyActions();
    const reg = buildCommandRegistry({
      cards: [card('c1', 'foo')],
      blocks: {},
      projects: [],
      actions,
    });
    const entry = reg.find((e) => e.group === 'jump-card');
    expect(entry).toBeTruthy();
    entry!.run();
    expect(actions.focusCard).toHaveBeenCalledWith('c1');
  });

  it('always emits a run-workflow placeholder entry', () => {
    const reg = buildCommandRegistry({
      cards: [],
      blocks: {},
      projects: [],
      actions: emptyActions(),
    });
    const entry = reg.find((e) => e.group === 'run-workflow');
    expect(entry).toBeTruthy();
    expect(entry!.label).toMatch(/workflow/i);
    // Click is a no-op until Stage 7; must not throw.
    expect(() => entry!.run()).not.toThrow();
  });

  it('emits change-intent entries when a card is focused and updateCardAiIntent is wired', () => {
    const actions = { ...emptyActions(), updateCardAiIntent: vi.fn() };
    const reg = buildCommandRegistry({
      cards: [card('c1', 'foo')],
      blocks: {},
      projects: [],
      focusedCardId: 'c1',
      actions,
    });
    const intentEntries = reg.filter((e) => e.group === 'change-intent');
    // 5 named intents + 1 "Clear intent" = 6 rows
    expect(intentEntries).toHaveLength(6);
    intentEntries[0].run();
    expect(actions.updateCardAiIntent).toHaveBeenCalledWith('c1', expect.any(String));
  });

  it('emits a "Clear intent" entry that passes null', () => {
    const actions = { ...emptyActions(), updateCardAiIntent: vi.fn() };
    const reg = buildCommandRegistry({
      cards: [card('c1', 'foo')],
      blocks: {},
      projects: [],
      focusedCardId: 'c1',
      actions,
    });
    const clear = reg.find((e) => e.id === 'intent:none');
    expect(clear).toBeTruthy();
    clear!.run();
    expect(actions.updateCardAiIntent).toHaveBeenCalledWith('c1', null);
  });

  it('omits change-intent entries when no card is focused', () => {
    const reg = buildCommandRegistry({
      cards: [card('c1', 'foo')],
      blocks: {},
      projects: [],
      focusedCardId: null,
      actions: { ...emptyActions(), updateCardAiIntent: vi.fn() },
    });
    expect(reg.filter((e) => e.group === 'change-intent')).toHaveLength(0);
  });

  it('omits change-intent entries when updateCardAiIntent is not provided', () => {
    const reg = buildCommandRegistry({
      cards: [card('c1', 'foo')],
      blocks: {},
      projects: [],
      focusedCardId: 'c1',
      actions: emptyActions(),
    });
    expect(reg.filter((e) => e.group === 'change-intent')).toHaveLength(0);
  });

  it('jump-block entry calls focusCard then selectBlock', () => {
    const actions = emptyActions();
    const cards = [card('c1', 'foo')];
    const blocks: Record<string, Block[]> = {
      c1: [{ id: 'b1', cardId: 'c1', cwd: '/x', command: 'ls', startedAt: 0, bufferStart: 0, state: 'success' }],
    };
    const reg = buildCommandRegistry({ cards, blocks, projects: [], actions });
    const entry = reg.find((e) => e.group === 'jump-block');
    entry!.run();
    expect(actions.focusCard).toHaveBeenCalledWith('c1');
    expect(actions.selectBlock).toHaveBeenCalledWith('c1', 'b1');
  });
});

describe('fuzzyFilter', () => {
  function entry(id: string, label: string) {
    return {
      id,
      label,
      searchText: label.toLowerCase(),
      group: 'jump-block' as const,
      run: vi.fn(),
    };
  }

  it('returns all entries for empty query', () => {
    const entries = [entry('1', 'npm test'), entry('2', 'git push')];
    expect(fuzzyFilter(entries, '')).toHaveLength(2);
  });

  it('returns subsequence matches', () => {
    const entries = [entry('1', 'npm test'), entry('2', 'git push')];
    expect(fuzzyFilter(entries, 'npm').map((e) => e.id)).toEqual(['1']);
    expect(fuzzyFilter(entries, 'gp').map((e) => e.id)).toEqual(['2']);
  });

  it('is case-insensitive', () => {
    const entries = [entry('1', 'NPM Test')];
    expect(fuzzyFilter(entries, 'npm')).toHaveLength(1);
  });

  it('ranks consecutive matches higher', () => {
    const entries = [entry('far', 'n.p.m'), entry('near', 'npm')];
    expect(fuzzyFilter(entries, 'npm')[0].id).toBe('near');
  });

  it('drops entries that do not contain the subsequence', () => {
    const entries = [entry('1', 'abc')];
    expect(fuzzyFilter(entries, 'xyz')).toEqual([]);
  });
});
