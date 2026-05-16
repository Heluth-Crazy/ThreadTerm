import { describe, expect, it } from 'vitest';
import { DEFAULT_PET_CONFIG } from '../lib/petConfig';
import type { NotificationEntry, TerminalCard } from '../types/terminal';
import { buildPetState } from './petState';

function card(overrides: Partial<TerminalCard>): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/tmp/project',
    projectName: 'project',
    terminalType: 'shell',
    status: 'idle',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

function notification(overrides: Partial<NotificationEntry>): NotificationEntry {
  return {
    id: 'n-1',
    cardId: 'card-1',
    at: 2,
    kind: 'waiting',
    title: 'Needs input',
    body: 'Continue?',
    read: false,
    ...overrides,
  };
}

describe('buildPetState', () => {
  it('summarizes unread and attention cards with latest notification previews', () => {
    const state = buildPetState({
      cards: [
        card({ id: 'card-1', unread: true, lastActivity: 10 }),
        card({ id: 'card-2', projectName: 'failed', status: 'failed', lastActivity: 20 }),
        card({ id: 'card-3', projectName: 'quiet', lastActivity: 30 }),
      ],
      notifications: [
        notification({ id: 'n-1', cardId: 'card-1', body: 'Line one\nLine two' }),
        notification({ id: 'n-2', cardId: 'card-1', read: true }),
      ],
      config: DEFAULT_PET_CONFIG,
      now: 123,
    });

    expect(state.unreadCount).toBe(1);
    expect(state.updatedAt).toBe(123);
    expect(state.cards.map((entry) => entry.id)).toEqual(['card-2', 'card-1']);
    expect(state.cards.find((entry) => entry.id === 'card-1')?.preview).toBe('Line one Line two');
    expect(state.cards.find((entry) => entry.id === 'card-1')?.unreadCount).toBe(1);
  });

  it('falls back to the latest card event when output and notifications are empty', () => {
    const state = buildPetState({
      cards: [
        card({
          unread: true,
          events: [{ at: 1, kind: 'status', summary: 'Waiting for approval' }],
        }),
      ],
      notifications: [],
      config: DEFAULT_PET_CONFIG,
    });

    expect(state.cards[0]?.preview).toBe('Waiting for approval');
  });
});
