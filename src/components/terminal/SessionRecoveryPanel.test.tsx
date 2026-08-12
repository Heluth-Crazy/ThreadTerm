import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentSessionCatalogStore } from '../../stores/agentSessionCatalogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { SessionRecoveryPanel } from './SessionRecoveryPanel';

const bridgeMocks = vi.hoisted(() => ({
  cancelAgentSessionScan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    listAgentSessions: vi.fn(),
    cancelAgentSessionScan: (...args: unknown[]) =>
      bridgeMocks.cancelAgentSessionScan(...args),
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const translations: Record<string, string> = {
          'sessionRecovery.scanPhase.scanning': 'Scanning sessions',
          'sessionRecovery.scanElapsed': `${options?.seconds ?? 0}s`,
          'sessionRecovery.stalled': 'Scan stalled. Retry to continue.',
          'sessionRecovery.retry': 'Retry',
          'sessionRecovery.title': 'Recover sessions',
        };
        return translations[key] ?? String(options?.defaultValue ?? key);
      },
    }),
  };
});

describe('SessionRecoveryPanel scan progress', () => {
  beforeEach(() => {
    bridgeMocks.cancelAgentSessionScan.mockClear();
    useAgentSessionCatalogStore.getState().reset();
    useTerminalStore.setState({ cards: [], archivedCards: [] });
  });

  afterEach(() => {
    useAgentSessionCatalogStore.getState().reset();
  });

  it('keeps existing rows visible while rendering determinate load-more progress', () => {
    const state = useAgentSessionCatalogStore.getState();
    useAgentSessionCatalogStore.setState({
      providers: {
        ...state.providers,
        claude: {
          ...state.providers.claude,
          loadState: 'loading',
          availability: 'available',
          items: [
            {
              provider: 'claude',
              id: 'existing-session',
              projectPath: 'C:\\repo',
              nativeTitle: 'Existing session',
              titleKind: 'explicit',
              resumable: true,
            },
          ],
          nextCursor: 'next',
          activeRequestId: 41,
          progress: {
            requestId: 41,
            provider: 'claude',
            phase: 'scanning',
            completed: 5,
            total: 10,
            elapsedMs: 2_500,
          },
        },
      },
    });

    render(<SessionRecoveryPanel onClose={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'Existing session' })).toBeVisible();
    expect(screen.getByText('5 / 10 · 50%')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('uses indeterminate progress when the backend does not know a total', () => {
    const state = useAgentSessionCatalogStore.getState();
    useAgentSessionCatalogStore.setState({
      providers: {
        ...state.providers,
        claude: {
          ...state.providers.claude,
          loadState: 'loading',
          activeRequestId: 42,
          progress: {
            requestId: 42,
            provider: 'claude',
            phase: 'scanning',
            completed: 12,
            total: null,
            elapsedMs: 3_000,
          },
        },
      },
    });

    render(<SessionRecoveryPanel onClose={vi.fn()} />);

    expect(screen.getByText('Scanning sessions')).toBeVisible();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders the watchdog failure as a localized retryable error', () => {
    const state = useAgentSessionCatalogStore.getState();
    useAgentSessionCatalogStore.setState({
      providers: {
        ...state.providers,
        claude: {
          ...state.providers.claude,
          loadState: 'error',
          availability: 'error',
          errorMessage: 'agent_session_catalog_stalled',
        },
      },
    });

    render(<SessionRecoveryPanel onClose={vi.fn()} />);

    expect(screen.getByText('Scan stalled. Retry to continue.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('cancels an active scan when the panel unmounts', () => {
    const state = useAgentSessionCatalogStore.getState();
    useAgentSessionCatalogStore.setState({
      providers: {
        ...state.providers,
        claude: {
          ...state.providers.claude,
          loadState: 'loading',
          activeRequestId: 43,
        },
      },
    });

    const { unmount } = render(<SessionRecoveryPanel onClose={vi.fn()} />);
    unmount();

    expect(bridgeMocks.cancelAgentSessionScan).toHaveBeenCalledWith(43);
  });
});
