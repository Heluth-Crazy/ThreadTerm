import { describe, expect, it } from 'vitest';
import type { SupervisorAlert } from '../supervisor/supervisorStore';
import type { PendingCodexRequest } from '../codexApp/pendingRequest';
import type { NotificationEntry, TerminalCard } from '../../types/terminal';
import {
  deriveAttentionItems,
  deriveWorkbenchSummary,
  filterWorkbenchCards,
} from './deriveAttentionItems';
import { deriveExecutionGroups } from './deriveExecutionGroups';
import { DEFAULT_WORKBENCH_RULES } from '../../stores/workbenchStore';

const NOW = 1_800_000_000_000;

function card(id: string, patch: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id,
    ptyId: id,
    projectPath: '/repo/app',
    projectName: 'app',
    terminalType: 'codex',
    status: 'running',
    createdAt: NOW - 120_000,
    lastActivity: NOW - 60_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...patch,
  };
}

function notification(
  id: string,
  cardId: string,
  kind: NotificationEntry['kind'],
  at = NOW - 10_000,
): NotificationEntry {
  return {
    id,
    cardId,
    kind,
    at,
    title: `${kind} title`,
    body: `${kind} body`,
    read: false,
  };
}

function request(id: string, cardId: string, method: string): PendingCodexRequest {
  return {
    key: id,
    requestId: id,
    cardId,
    threadId: `thread-${cardId}`,
    method,
    params: { command: `echo ${id}` },
    raw: null,
    createdAt: NOW - 5_000,
    notificationId: `notification-${id}`,
  };
}

function alert(id: string, cardId: string): SupervisorAlert {
  return {
    id,
    cardId,
    ruleId: 'yes-no-bracket',
    sampleText: 'Continue? [Y/n]',
    ts: NOW - 6_000,
    clicked: false,
    clickedAt: null,
    acted: false,
    actedAt: null,
    notificationId: `notification-${id}`,
  };
}

function derive(input: {
  cards: TerminalCard[];
  notifications?: NotificationEntry[];
  requests?: PendingCodexRequest[];
  alerts?: SupervisorAlert[];
  rules?: Partial<typeof DEFAULT_WORKBENCH_RULES>;
}) {
  return deriveAttentionItems({
    cards: input.cards,
    notifications: input.notifications ?? [],
    supervisorAlerts: input.alerts ?? [],
    codexRequests: input.requests ?? [],
    rules: { ...DEFAULT_WORKBENCH_RULES, ...input.rules },
    now: NOW,
  });
}

describe('deriveAttentionItems', () => {
  it('keeps every structured request and suppresses weaker waiting sources for that card', () => {
    const cards = [card('card-a', { status: 'waiting' })];
    const items = derive({
      cards,
      requests: [
        request('approval-a', 'card-a', 'item/commandExecution/requestApproval'),
        request('input-a', 'card-a', 'item/tool/requestUserInput'),
      ],
      alerts: [alert('alert-a', 'card-a')],
      notifications: [notification('waiting-a', 'card-a', 'waiting')],
    });

    expect(items.map((item) => [item.kind, item.sourceKind])).toEqual([
      ['approval', 'structured_request'],
      ['waiting_input', 'structured_request'],
    ]);
    expect(items.every((item) => item.capability.openRequest)).toBe(true);
  });

  it('projects waiting, failed, and unread completed cards without inventing capabilities', () => {
    const items = derive({
      cards: [
        card('waiting', { status: 'waiting' }),
        card('failed', { status: 'failed' }),
        card('review', { status: 'completed', unread: true }),
      ],
      notifications: [
        notification('waiting-note', 'waiting', 'waiting'),
        notification('failed-note', 'failed', 'failed'),
        notification('review-note', 'review', 'completed'),
      ],
    });

    expect(items.map((item) => item.kind).sort()).toEqual([
      'failed',
      'review',
      'waiting_input',
    ]);
    expect(items.every((item) => !item.capability.openRequest)).toBe(true);
    expect(items.every((item) => !item.capability.openEvidence)).toBe(true);
  });

  it('switches a finished running terminal into review while its completion is unread', () => {
    const running = card('task');
    const runningItems = derive({ cards: [running] });

    expect(deriveWorkbenchSummary([running], runningItems)).toEqual({
      attention: 0,
      normalRunning: 1,
      review: 0,
      failed: 0,
    });

    const finished = card('task', {
      status: 'idle',
      lastActivity: NOW - 1_000,
      lastReplyPreview: 'task result',
    });
    const finishedItems = derive({
      cards: [finished],
      notifications: [notification('completed-task', 'task', 'completed')],
    });

    expect(finishedItems).toEqual([
      expect.objectContaining({
        cardId: 'task',
        kind: 'review',
        sourceKind: 'notification',
        sourceId: 'completed-task',
      }),
    ]);
    expect(deriveWorkbenchSummary([finished], finishedItems)).toEqual({
      attention: 1,
      normalRunning: 0,
      review: 1,
      failed: 0,
    });
    expect(deriveExecutionGroups([finished], finishedItems)).toEqual([
      expect.objectContaining({
        cardIds: ['task'],
        status: 'review',
        attentionCount: 1,
      }),
    ]);
  });

  it('uses completed card state as review evidence and drops acknowledged idle completions', () => {
    const completed = card('completed', { status: 'completed' });

    expect(derive({ cards: [completed] })).toEqual([
      expect.objectContaining({
        cardId: 'completed',
        kind: 'review',
        sourceKind: 'terminal_state',
      }),
    ]);

    const acknowledgedIdle = card('acknowledged', { status: 'idle' });
    expect(
      derive({
        cards: [acknowledgedIdle],
        notifications: [
          {
            ...notification('completed-acknowledged', 'acknowledged', 'completed'),
            read: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it('suppresses failed while an auto-restart attempt is pending', () => {
    const failed = card('failed', {
      status: 'failed',
      autoRestart: {
        enabled: true,
        maxRetries: 3,
        retryCount: 1,
        history: [
          {
            attempt: 1,
            failedAt: NOW - 2_000,
            scheduledAt: NOW - 1_500,
            delayMs: 2_000,
            runAt: NOW + 500,
            status: 'pending',
          },
        ],
      },
    });

    expect(derive({ cards: [failed] })).toEqual([]);
  });

  it('keeps stalled opt-in, thresholded, provider-neutral, and excludable', () => {
    const oldAgent = card('agent', { lastActivity: NOW - 31 * 60_000 });
    const oldServer = card('server', {
      terminalType: 'npm',
      lastActivity: NOW - 90 * 60_000,
    });

    expect(derive({ cards: [oldAgent], rules: { stalledEnabled: false } })).toEqual([]);
    expect(
      derive({
        cards: [oldAgent, oldServer],
        rules: { stalledEnabled: true, stalledThresholdMinutes: 30 },
      }).map((item) => item.cardId).sort(),
    ).toEqual(['agent', 'server']);
    expect(
      derive({
        cards: [oldAgent, oldServer],
        rules: {
          stalledEnabled: true,
          stalledThresholdMinutes: 30,
          stalledExcludedCardIds: ['server'],
        },
      }).map((item) => item.cardId),
    ).toEqual(['agent']);
  });

  it('filters exact project paths and reuses worktree matching', () => {
    const cards = [
      card('root', { projectPath: 'C:\\repo\\app' }),
      card('feature', {
        projectPath: 'C:\\repo\\app',
        worktreePath: 'C:\\repo\\app-feature',
      }),
      card('other', { projectPath: 'C:\\repo\\other' }),
    ];

    expect(filterWorkbenchCards(cards, 'C:\\repo\\app', 'c:/repo/app-feature')).toEqual([
      expect.objectContaining({ id: 'feature' }),
    ]);
  });

  it('counts running cards only when they have no attention', () => {
    const cards = [
      card('normal'),
      card('approval'),
      card('failed', { status: 'failed' }),
      card('review', { status: 'completed', unread: true }),
    ];
    const items = derive({
      cards,
      requests: [
        request('approval-a', 'approval', 'item/commandExecution/requestApproval'),
      ],
    });

    expect(deriveWorkbenchSummary(cards, items)).toEqual({
      attention: 3,
      normalRunning: 1,
      review: 1,
      failed: 1,
    });
  });
});
