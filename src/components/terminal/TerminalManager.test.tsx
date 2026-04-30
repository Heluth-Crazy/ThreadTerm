import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalManager } from './TerminalManager';

vi.mock('../Shell', () => ({
  default: () => <div data-testid="mock-shell" />,
}));

vi.mock('./CardGrid', () => ({
  CardGrid: () => <div data-testid="mock-card-grid" />,
}));

vi.mock('./CreateTerminalDialog', () => ({
  CreateTerminalDialog: () => null,
}));

vi.mock('./ProjectSidebar', () => ({
  ProjectSidebar: () => <aside data-testid="mock-project-sidebar" />,
}));

vi.mock('../Settings', () => ({
  default: () => null,
}));

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    blocks: {},
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
  });
}

describe('TerminalManager shortcut hint layout', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps the shortcut hint above the focused terminal footer', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    useTerminalStore.getState().focusCard(id);

    render(<TerminalManager />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    });

    const hint = screen.getByText(/Ctrl\+Tab/).closest('div');
    expect(hint).toHaveClass('bottom-10');
    expect(hint).not.toHaveClass('bottom-3');
  });
});
