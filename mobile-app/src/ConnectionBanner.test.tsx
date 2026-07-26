import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionBanner } from './ConnectionBanner';
import { I18nProvider } from './i18n';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';

function renderBanner(wsStatus: BridgeConnectionState, search = '') {
  function Wrapper({ children }: { children: ReactNode }) {
    return <I18nProvider search={search}>{children}</I18nProvider>;
  }
  return render(<ConnectionBanner wsStatus={wsStatus} />, { wrapper: Wrapper });
}

describe('ConnectionBanner', () => {
  afterEach(() => cleanup());

  it('renders nothing when the bridge is open', () => {
    const { container } = renderBanner('open');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the bridge is idle', () => {
    const { container } = renderBanner('idle');
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a reconnecting banner while connecting', () => {
    renderBanner('connecting');
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
  });

  it('shows a reconnecting banner during retry backoff', () => {
    renderBanner('reconnecting');
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
  });

  it('shows an offline banner when the bridge is closed', () => {
    renderBanner('closed');
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
  });

  it('shows an offline banner on error', () => {
    renderBanner('error');
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
  });

  it('explains that a revoked device must be paired again', () => {
    renderBanner('revoked');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Device access ended. Reopen the desktop QR link to pair again.',
    );
  });

  it('uses Chinese copy when the desktop language is Chinese', () => {
    renderBanner('connecting', '?lang=zh-CN');
    expect(screen.getByRole('status')).toHaveTextContent('重连中…');
  });
});
