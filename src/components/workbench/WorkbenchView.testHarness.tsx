import { render } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import type {
  AttentionItem,
  WorkbenchSummary,
} from '../../lib/workbench/types';
import type { BranchRow } from '../../lib/tauri-bridge';
import type { TerminalCard } from '../../types/terminal';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import { WorkbenchView } from './WorkbenchView';

const projectBranchesMock = vi.hoisted(() => ({
  branches: [] as BranchRow[],
}));

export function getProjectBranchesMock() {
  return projectBranchesMock;
}

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (
        key: string,
        options?: Record<string, string | number | undefined> & { defaultValue?: string },
      ) => {
        let value = options?.defaultValue ?? key;
        for (const [name, replacement] of Object.entries(options ?? {})) {
          value = value.split(`{{${name}}}`).join(String(replacement));
        }
        return value;
      },
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../terminal/useProjectBranches', () => ({
  useProjectBranches: () => ({
    branches: projectBranchesMock.branches,
    loading: false,
    error: null,
    refresh: async () => undefined,
  }),
}));

export const NOW = 1_000_000;

beforeEach(() => {
  projectBranchesMock.branches = [];
  useWorkbenchStore.setState({ pinnedProjects: [] });
});

export function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'Repo',
    terminalType: 'codex',
    status: 'waiting',
    createdAt: NOW - 10_000,
    lastActivity: NOW - 5_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 1,
    events: [],
    unread: true,
    ...overrides,
  };
}

export const approvalItem: AttentionItem = {
  id: 'structured_request:req-1',
  cardId: 'card-1',
  kind: 'approval',
  severity: 'critical',
  sourceKind: 'structured_request',
  sourceId: 'req-1',
  occurredAt: NOW - 3_000,
  projectPath: '/repo',
  projectName: 'Repo',
  terminalType: 'codex',
  title: 'Approval needed',
  detail: 'Run a repository command',
  reasonCode: 'structured_approval',
  capability: {
    openRequest: true,
    openTerminal: true,
    openNotification: true,
    openEvidence: false,
  },
};

export const failedItem: AttentionItem = {
  id: 'terminal_state:card-2',
  cardId: 'card-2',
  kind: 'failed',
  severity: 'critical',
  sourceKind: 'terminal_state',
  sourceId: 'card-2',
  occurredAt: NOW - 2_000,
  projectPath: '/other',
  projectName: 'Other',
  terminalType: 'claude',
  title: 'Build failed',
  detail: 'Command exited with code 1',
  reasonCode: 'failed_state',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: false,
    openEvidence: false,
  },
};

export const reviewItem: AttentionItem = {
  id: 'notification:completed-1',
  cardId: 'card-1',
  kind: 'review',
  severity: 'info',
  sourceKind: 'notification',
  sourceId: 'completed-1',
  occurredAt: NOW - 1_000,
  projectPath: '/repo',
  projectName: 'Repo',
  terminalType: 'codex',
  title: 'Result ready',
  detail: 'Agent finished the task',
  reasonCode: 'completed_unread',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: true,
    openEvidence: true,
  },
};

export const stalledItem: AttentionItem = {
  id: 'terminal_state:card-9',
  cardId: 'card-9',
  kind: 'stalled',
  severity: 'warning',
  sourceKind: 'terminal_state',
  sourceId: 'card-9',
  occurredAt: NOW - 40 * 60_000,
  projectPath: '/quiet',
  projectName: 'Quiet',
  terminalType: 'npm',
  title: 'Quiet dev server',
  detail: 'No new output for 40 minutes',
  reasonCode: 'stalled_running',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: false,
    openEvidence: false,
  },
};

export const summary: WorkbenchSummary = {
  attention: 2,
  normalRunning: 0,
  review: 0,
  failed: 1,
};

export function renderWorkbench(overrides: Partial<Parameters<typeof WorkbenchView>[0]> = {}) {
  const callbacks = {
    onOpenTerminal: vi.fn(),
    onAcknowledgeAttention: vi.fn(),
    onOpenAttention: vi.fn(),
    onIgnoreAttention: vi.fn(),
    onOpenRules: vi.fn(),
    onCreateTerminal: vi.fn(),
    onFollowCards: vi.fn(),
    onUnfollowCard: vi.fn(),
    onSelectProject: vi.fn(),
    onShowAllProjects: vi.fn(),
  };
  const cards = [
    makeCard(),
    makeCard({
      id: 'card-2',
      ptyId: 'card-2',
      projectPath: '/other',
      projectName: 'Other',
      terminalType: 'claude',
      status: 'failed',
    }),
  ];
  const props: Parameters<typeof WorkbenchView>[0] = {
    cards,
    allCards: cards,
    attentionItems: [approvalItem, failedItem],
    stalledItems: [],
    followedCards: [],
    followedCardIds: [],
    projectOverviews: [],
    summary,
    now: NOW,
    scopeLabel: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    ...callbacks,
    ...overrides,
  };
  render(<WorkbenchView {...props} />);
  return { props, callbacks };
}
