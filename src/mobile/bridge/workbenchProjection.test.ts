import { describe, expect, it } from 'vitest';
import type { NotificationEntry as DesktopNotificationEntry } from '../../types/terminal';
import type {
  AttentionItem,
  ExecutionContextGroup,
  WorkbenchRules,
} from '../../lib/workbench/types';
import {
  buildMobileWorkbenchProjection,
  notificationsToMobile,
} from './workbenchProjection';

const rules: WorkbenchRules = {
  includeWaiting: true,
  includeFailed: true,
  includeCompletedReview: true,
  stalledEnabled: true,
  stalledThresholdMinutes: 15,
  stalledExcludedCardIds: ['card-excluded'],
};

const attention: AttentionItem = {
  id: 'attention-1',
  cardId: 'card-1',
  kind: 'approval',
  severity: 'warning',
  sourceKind: 'structured_request',
  sourceId: 'request-1',
  occurredAt: 100,
  projectPath: 'D:\\project\\ThreadTerm',
  projectName: 'ThreadTerm',
  worktreePath: 'D:\\project\\ThreadTerm\\.worktrees\\mobile',
  branchLabel: 'mobile',
  terminalType: 'codex',
  title: '需要确认权限',
  detail: 'Codex 请求写入工作区',
  reasonCode: 'structured_approval',
  capability: {
    openRequest: true,
    openTerminal: true,
    openNotification: false,
    openEvidence: true,
  },
};

const group: ExecutionContextGroup = {
  id: 'group-1',
  projectPath: attention.projectPath,
  projectName: attention.projectName,
  worktreePath: attention.worktreePath!,
  branchLabel: attention.branchLabel,
  cardIds: ['card-1'],
  terminalCount: 1,
  terminalTypes: ['codex'],
  attentionCount: 1,
  status: 'attention',
  terminalStatuses: ['waiting'],
  lastActivity: 90,
  preview: 'Waiting for confirmation',
};

describe('mobile workbench projection', () => {
  it('copies deterministic workbench output without adding inferred progress', () => {
    const projection = buildMobileWorkbenchProjection({
      generatedAt: 123,
      summary: { attention: 1, normalRunning: 2, review: 0, failed: 0 },
      attentionItems: [attention],
      groups: [group],
      rules,
    });

    expect(projection.generatedAt).toBe(123);
    expect(projection.summary).toEqual({
      attention: 1,
      normalRunning: 2,
      review: 0,
      failed: 0,
    });
    expect(projection.attentionItems[0]).toMatchObject({
      id: 'attention-1',
      sourceKind: 'structured_request',
      reasonCode: 'structured_approval',
      worktreePath: attention.worktreePath,
    });
    expect(projection.executionGroups[0]).toMatchObject({
      id: 'group-1',
      cardIds: ['card-1'],
      status: 'attention',
    });
    expect(projection.capabilities).toEqual({
      openTerminal: true,
      respondToStructuredRequest: false,
      updateRules: false,
      updateNotificationReadState: false,
    });
    expect(projection.rules.stalledExcludedCount).toBe(1);
    expect(projection).not.toHaveProperty('progress');
  });

  it('maps stable notification fields needed after reconnect', () => {
    const notification: DesktopNotificationEntry = {
      id: 'notification-1',
      cardId: 'card-1',
      at: 456,
      kind: 'waiting',
      title: '等待输入',
      body: '终端正在等待用户回答',
      read: false,
      routing: {
        origin: 'pty',
        family: 'interaction',
        episodeKey: 'episode-1',
        fingerprint: 'input-request',
      },
    };

    expect(notificationsToMobile([notification])).toEqual([
      {
        id: 'notification-1',
        cardId: 'card-1',
        kind: 'waiting',
        message: '终端正在等待用户回答',
        createdAt: 456,
        title: '等待输入',
        body: '终端正在等待用户回答',
        read: false,
        routing: {
          origin: 'pty',
          family: 'interaction',
          episodeKey: 'episode-1',
          fingerprint: 'input-request',
        },
      },
    ]);
  });
});
