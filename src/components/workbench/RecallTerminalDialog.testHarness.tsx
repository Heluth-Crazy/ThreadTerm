import { render } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import type { BranchRow } from '../../lib/tauri-bridge';
import type { TerminalCard } from '../../types/terminal';
import { RecallTerminalDialog } from './RecallTerminalDialog';

export function TestRecallTerminalDialog(
  props: Parameters<typeof RecallTerminalDialog>[0],
) {
  return <RecallTerminalDialog {...props} />;
}

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
        options?: Record<string, string | number | undefined> & {
          defaultValue?: string;
        },
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

export function renderDialog(
  overrides: Partial<Parameters<typeof RecallTerminalDialog>[0]> = {},
) {
  const callbacks = {
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };
  const cards = [
    makeCard(),
    makeCard({
      id: 'card-2',
      ptyId: 'card-2',
      projectPath: '/other',
      projectName: 'Other',
      terminalType: 'claude',
      branchLabel: 'feature/other',
      lastOutput: 'second terminal output',
    }),
  ];
  const props: Parameters<typeof RecallTerminalDialog>[0] = {
    open: true,
    cards,
    followedCardIds: [],
    selectedProjectPath: null,
    selectedWorktreePath: null,
    ...callbacks,
    ...overrides,
  };
  const result = render(<RecallTerminalDialog {...props} />);
  return { ...result, callbacks, props };
}
