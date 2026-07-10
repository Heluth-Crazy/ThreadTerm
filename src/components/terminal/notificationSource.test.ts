import { describe, expect, it } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import {
  describeCardSource,
  formatCardSourceLabel,
  type CardSource,
} from './notificationSource';

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'repo',
    terminalType: 'codex',
    status: 'idle',
    createdAt: 0,
    lastActivity: 0,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  } as TerminalCard;
}

// A translate stub that echoes the key so we can assert which keys are used
// and how the parts are joined, independent of the real locale bundle.
const echo = (key: string, fallback?: string) => fallback ?? key;
const keyOnly = (key: string) => key;

describe('describeCardSource', () => {
  it('extracts the fields that identify a card as a notification source', () => {
    const source = describeCardSource(
      makeCard({ projectName: 'acme', terminalType: 'claude', aiIntent: 'fix' }),
    );
    expect(source).toEqual<CardSource>({
      projectName: 'acme',
      terminalType: 'claude',
      aiIntent: 'fix',
      branchLabel: undefined,
    });
  });

  it('normalises a blank branch label to undefined', () => {
    const source = describeCardSource(makeCard({ branchLabel: '   ' }));
    expect(source.branchLabel).toBeUndefined();
  });

  it('keeps a real branch label', () => {
    const source = describeCardSource(makeCard({ branchLabel: 'feat/login' }));
    expect(source.branchLabel).toBe('feat/login');
  });
});

describe('formatCardSourceLabel', () => {
  it('joins project · type', () => {
    const label = formatCardSourceLabel(
      describeCardSource(makeCard({ projectName: 'repo', terminalType: 'codex' })),
      keyOnly,
    );
    expect(label).toBe('repo · types.codex');
  });

  it('prefers ai intent over branch when both exist', () => {
    const label = formatCardSourceLabel(
      describeCardSource(
        makeCard({
          projectName: 'repo',
          terminalType: 'claude',
          aiIntent: 'review',
          branchLabel: 'feat/x',
        }),
      ),
      keyOnly,
    );
    expect(label).toBe('repo · types.claude · aiIntent.review');
  });

  it('falls back to branch label when no ai intent', () => {
    const label = formatCardSourceLabel(
      describeCardSource(
        makeCard({ projectName: 'repo', terminalType: 'shell', branchLabel: 'main' }),
      ),
      keyOnly,
    );
    expect(label).toBe('repo · types.shell · main');
  });

  it('omits the third segment when neither intent nor branch exist', () => {
    const label = formatCardSourceLabel(
      describeCardSource(makeCard({ projectName: 'repo', terminalType: 'shell' })),
      keyOnly,
    );
    expect(label).toBe('repo · types.shell');
  });

  it('uses the translated type label when the translator resolves it', () => {
    const label = formatCardSourceLabel(
      describeCardSource(makeCard({ projectName: 'repo', terminalType: 'codex' })),
      echo,
    );
    // echo returns the fallback (the meta label) — proves we pass a sane default.
    expect(label).toBe('repo · Codex');
  });
});
