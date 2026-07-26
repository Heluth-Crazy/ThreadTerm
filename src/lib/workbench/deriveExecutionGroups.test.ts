import { describe, expect, it } from 'vitest';
import type { AttentionItem } from './types';
import type { TerminalCard } from '../../types/terminal';
import { deriveExecutionGroups } from './deriveExecutionGroups';

function card(id: string, patch: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id,
    ptyId: id,
    projectPath: '/repo/app',
    projectName: 'app',
    terminalType: 'codex',
    status: 'running',
    createdAt: 1,
    lastActivity: 100,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...patch,
  };
}

function attention(cardId: string, kind: AttentionItem['kind']): AttentionItem {
  return {
    id: `attention-${cardId}-${kind}`,
    cardId,
    kind,
    severity: kind === 'failed' ? 'critical' : 'warning',
    sourceKind: 'terminal_state',
    sourceId: cardId,
    occurredAt: 100,
    projectPath: '/repo/app',
    projectName: 'app',
    terminalType: 'codex',
    title: 'app',
    reasonCode: kind === 'failed' ? 'failed_state' : 'waiting_state',
    capability: {
      openRequest: false,
      openTerminal: true,
      openNotification: false,
      openEvidence: false,
    },
  };
}

describe('deriveExecutionGroups', () => {
  it('groups by exact project and effective worktree path', () => {
    const groups = deriveExecutionGroups(
      [
        card('root-a'),
        card('root-b', { terminalType: 'claude', lastActivity: 200 }),
        card('feature', {
          worktreePath: '/repo/app-feature',
          branchLabel: 'feature/workbench',
        }),
      ],
      [],
    );

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.worktreePath === '/repo/app')).toMatchObject({
      terminalCount: 2,
      terminalTypes: ['codex', 'claude'],
      lastActivity: 200,
    });
    expect(groups.find((group) => group.worktreePath === '/repo/app-feature')).toMatchObject({
      terminalCount: 1,
      branchLabel: 'feature/workbench',
    });
  });

  it('uses deterministic severity priority and omits inactive idle-only contexts', () => {
    const groups = deriveExecutionGroups(
      [
        card('idle', { projectPath: '/repo/idle', status: 'idle' }),
        card('running'),
        card('failed', { status: 'failed' }),
      ],
      [attention('failed', 'failed')],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('failed');
    expect(groups[0].attentionCount).toBe(1);
  });

  it('uses only real preview or event text', () => {
    const [group] = deriveExecutionGroups(
      [
        card('older', { lastActivity: 100, lastReplyPreview: 'real assistant output' }),
        card('newer', {
          lastActivity: 200,
          events: [{ at: 190, kind: 'status', summary: 'real status event' }],
        }),
      ],
      [],
    );

    expect(group.preview).toBe('real status event');
    expect(group).not.toHaveProperty('progress');
    expect(group).not.toHaveProperty('cost');
    expect(group).not.toHaveProperty('verified');
  });
});
