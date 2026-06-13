import { describe, expect, it } from 'vitest';

import {
  compareCardsByActivity,
  isDesktopCardLive,
  type CardActivitySortFields,
} from './cardSort';

function sorted(cards: (CardActivitySortFields & { id: string })[]) {
  return [...cards].sort(compareCardsByActivity).map((c) => c.id);
}

describe('isDesktopCardLive', () => {
  it('treats running and waiting (desktop) plus waiting_for_input (mobile) as live', () => {
    expect(isDesktopCardLive('running')).toBe(true);
    expect(isDesktopCardLive('waiting')).toBe(true);
    expect(isDesktopCardLive('waiting_for_input')).toBe(true);
  });

  it('treats idle/completed/failed and nullish as not live', () => {
    expect(isDesktopCardLive('idle')).toBe(false);
    expect(isDesktopCardLive('completed')).toBe(false);
    expect(isDesktopCardLive('failed')).toBe(false);
    expect(isDesktopCardLive(null)).toBe(false);
    expect(isDesktopCardLive(undefined)).toBe(false);
  });
});

describe('compareCardsByActivity', () => {
  it('puts live cards before non-live regardless of unread/recency', () => {
    expect(
      sorted([
        { id: 'idle-new-unread', status: 'idle', unread: true, lastActivity: 100 },
        { id: 'live-old-read', status: 'running', unread: false, lastActivity: 1 },
      ]),
    ).toEqual(['live-old-read', 'idle-new-unread']);
  });

  it('orders unread before read once liveness ties', () => {
    expect(
      sorted([
        { id: 'read', status: 'idle', unread: false, lastActivity: 50 },
        { id: 'unread', status: 'idle', unread: true, lastActivity: 10 },
      ]),
    ).toEqual(['unread', 'read']);
  });

  it('falls back to most-recent lastActivity when live + unread tie', () => {
    expect(
      sorted([
        { id: 'older', status: 'running', unread: true, lastActivity: 10 },
        { id: 'newer', status: 'running', unread: true, lastActivity: 99 },
      ]),
    ).toEqual(['newer', 'older']);
  });

  it('uses createdAt when lastActivity is missing', () => {
    expect(
      sorted([
        { id: 'older', status: 'idle', createdAt: 5 },
        { id: 'newer', status: 'idle', createdAt: 7 },
      ]),
    ).toEqual(['newer', 'older']);
  });

  it('prefers explicit ptyLive over status for mobile cards', () => {
    expect(
      sorted([
        { id: 'status-running-but-dead', status: 'running', ptyLive: false, lastActivity: 100 },
        { id: 'status-idle-but-live', status: 'idle', ptyLive: true, lastActivity: 1 },
      ]),
    ).toEqual(['status-idle-but-live', 'status-running-but-dead']);
  });

  it('is stable for fully-equal cards (preserves input order)', () => {
    expect(
      sorted([
        { id: 'first', status: 'idle', unread: false, lastActivity: 10 },
        { id: 'second', status: 'idle', unread: false, lastActivity: 10 },
        { id: 'third', status: 'idle', unread: false, lastActivity: 10 },
      ]),
    ).toEqual(['first', 'second', 'third']);
  });
});
