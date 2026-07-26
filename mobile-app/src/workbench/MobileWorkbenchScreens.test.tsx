import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CardMeta,
  MobileWorkbenchProjection,
  NotificationEntry,
} from '@shared/mobile/bridge/protocol';
import { I18nProvider } from '../i18n';
import {
  AttentionDetailScreen,
  NotificationsScreen,
  RulesScreen,
  WorkbenchScreen,
} from './MobileWorkbenchScreens';

function ChineseWrapper({ children }: { children: ReactNode }) {
  return <I18nProvider search="?lang=zh-CN">{children}</I18nProvider>;
}

const cards: CardMeta[] = [
  {
    id: 'card-main',
    status: 'waiting_for_input',
    projectPath: 'D:\\repo',
    projectName: 'Repo',
    worktreePath: 'D:\\repo',
    branchLabel: 'main',
    terminalType: 'codex',
    lastReplyPreview: 'Waiting',
    summaryLine: 'Waiting',
    hiddenLineCount: 0,
    recentOutputBytes: 10,
  },
  {
    id: 'card-mobile',
    status: 'running',
    projectPath: 'D:\\repo',
    projectName: 'Repo',
    worktreePath: 'D:\\repo\\.worktrees\\mobile',
    branchLabel: 'mobile',
    terminalType: 'claude',
    lastReplyPreview: 'Running',
    summaryLine: 'Running',
    hiddenLineCount: 0,
    recentOutputBytes: 12,
  },
];

const projection: MobileWorkbenchProjection = {
  generatedAt: Date.now(),
  summary: { attention: 1, normalRunning: 1, review: 0, failed: 0 },
  attentionItems: [
    {
      id: 'attention-main',
      cardId: 'card-main',
      kind: 'approval',
      severity: 'warning',
      sourceKind: 'structured_request',
      sourceId: 'request-1',
      occurredAt: Date.now() - 60_000,
      projectPath: 'D:\\repo',
      projectName: 'Repo',
      worktreePath: 'D:\\repo',
      branchLabel: 'main',
      terminalType: 'codex',
      title: '确认工作区写入',
      detail: 'Codex 请求写入文件',
      reasonCode: 'structured_approval',
      capability: {
        openRequest: true,
        openTerminal: true,
        openNotification: false,
        openEvidence: true,
      },
    },
  ],
  executionGroups: [
    {
      id: 'group-main',
      projectPath: 'D:\\repo',
      projectName: 'Repo',
      worktreePath: 'D:\\repo',
      branchLabel: 'main',
      cardIds: ['card-main'],
      terminalCount: 1,
      terminalTypes: ['codex'],
      attentionCount: 1,
      status: 'attention',
      terminalStatuses: ['waiting'],
      lastActivity: Date.now() - 60_000,
      preview: 'Waiting',
    },
    {
      id: 'group-mobile',
      projectPath: 'D:\\repo',
      projectName: 'Repo',
      worktreePath: 'D:\\repo\\.worktrees\\mobile',
      branchLabel: 'mobile',
      cardIds: ['card-mobile'],
      terminalCount: 1,
      terminalTypes: ['claude'],
      attentionCount: 0,
      status: 'running',
      terminalStatuses: ['running'],
      lastActivity: Date.now(),
      preview: 'Running',
    },
  ],
  rules: {
    includeWaiting: true,
    includeFailed: true,
    includeCompletedReview: true,
    stalledEnabled: true,
    stalledThresholdMinutes: 15,
    stalledExcludedCount: 0,
  },
  capabilities: {
    openTerminal: true,
    respondToStructuredRequest: false,
    updateRules: false,
    updateNotificationReadState: false,
  },
};

const notifications: NotificationEntry[] = [
  {
    id: 'notification-1',
    cardId: 'card-main',
    kind: 'waiting',
    message: '等待输入',
    title: '终端等待输入',
    body: '请查看对应终端',
    createdAt: Date.now(),
    read: false,
  },
];

describe('mobile Workbench screens', () => {
  afterEach(() => cleanup());

  it('renders the authoritative projection and keeps same-project worktrees separate', () => {
    render(
      <WorkbenchScreen
        cards={cards}
        notifications={notifications}
        onOpenAttention={vi.fn()}
        onOpenGroup={vi.fn()}
        onOpenNewTerminal={vi.fn()}
        onOpenNotifications={vi.fn()}
        onOpenRules={vi.fn()}
        projection={projection}
        warmingUp={false}
        wsStatus="open"
      />,
      { wrapper: ChineseWrapper },
    );

    expect(screen.getByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.getByText('确认工作区写入')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Repo · main' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Repo · mobile' })).toBeInTheDocument();
    expect(document.querySelector('.terminal-xterm-host')).toBeNull();

    fireEvent.change(screen.getByLabelText('项目与 Worktree 范围'), {
      target: { value: 'group-mobile' },
    });

    expect(screen.queryByText('确认工作区写入')).not.toBeInTheDocument();
    expect(screen.getAllByText('正常运行').length).toBeGreaterThan(0);
  });

  it('keeps structured approval handling on desktop and only navigates to terminal', () => {
    const onOpenTerminal = vi.fn();
    render(
      <AttentionDetailScreen
        item={projection.attentionItems[0]}
        onBack={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        terminalAvailable
        wsStatus="open"
      />,
      { wrapper: ChineseWrapper },
    );

    expect(screen.getByText('需要桌面端确认')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开终端处理' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('card-main');
    expect(screen.queryByRole('button', { name: /批准|拒绝/ })).not.toBeInTheDocument();
  });

  it('shows notifications and rules as recoverable read-only state', () => {
    const { rerender } = render(
      <NotificationsScreen
        notifications={notifications}
        onBack={vi.fn()}
        onOpenTerminal={vi.fn()}
      />,
      { wrapper: ChineseWrapper },
    );
    expect(screen.getByText('终端等待输入')).toBeInTheDocument();
    expect(screen.getByText(/已读状态由桌面端管理/)).toBeInTheDocument();

    rerender(
      <ChineseWrapper>
        <RulesScreen onBack={vi.fn()} projection={projection} />
      </ChineseWrapper>,
    );
    expect(screen.getByText('由桌面端同步')).toBeInTheDocument();
    expect(screen.getByText('15 分钟')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存|完成/ })).not.toBeInTheDocument();
  });
});
