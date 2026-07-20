import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardMeta } from '@shared/mobile/bridge/protocol';
import { SettingsScreen } from './App';
import { I18nProvider } from './i18n';

function I18nWrapper({ children }: { children: ReactNode }) {
  return <I18nProvider search="">{children}</I18nProvider>;
}

const openWorkCard: CardMeta = {
  id: 'openwork-card',
  status: 'running',
  projectPath: 'D:\\OpenWork',
  projectName: 'OpenWork',
  lastReplyPreview: '',
  summaryLine: null,
  hiddenLineCount: 0,
  recentOutputBytes: 0,
};

describe('SettingsScreen', () => {
  afterEach(() => cleanup());

  it('keeps the product identity independent from the active project name', () => {
    render(
      <SettingsScreen
        activeCard={openWorkCard}
        bridgeAddress="192.168.1.2:5174"
        lastError={null}
        notifications={[]}
        onThemePreferenceChange={vi.fn()}
        permission="read_only"
        themePreference="auto"
        wsStatus="open"
      />,
      { wrapper: I18nWrapper },
    );

    expect(screen.getByRole('heading', { name: 'ThreadTerm' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'OpenWork' })).not.toBeInTheDocument();
  });
});
