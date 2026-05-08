import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardPreviewPanel } from './CardPreviewPanel';
import type { CardPreview } from './cardPreview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | { count?: number }) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions;
      if (fallbackOrOptions?.count !== undefined) return `+${fallbackOrOptions.count} filtered`;
      return key;
    },
  }),
}));

function preview(overrides: Partial<CardPreview> = {}): CardPreview {
  return {
    kind: 'shell',
    bodyLines: [],
    summaryLine: null,
    hiddenLineCount: 0,
    source: 'output',
    ...overrides,
  };
}

describe('CardPreviewPanel', () => {
  it('renders a terminal thumbnail layer and one-line latest summary', () => {
    render(
      <CardPreviewPanel
        preview={preview({
          bodyLines: [
            '$ npm install',
            'added 214 packages',
            '$ npm test',
            'running vitest',
            'Test Files 54 passed',
            'Tests 423 passed',
          ],
          summaryLine: 'Tests 423 passed',
          hiddenLineCount: 8,
        })}
        activeFor="2m"
        messageCount={3}
      />,
    );

    expect(screen.getByTestId('card-preview-thumbnail').textContent).toContain(
      '$ npm install',
    );
    expect(screen.getByTestId('card-preview-summary').textContent).toContain(
      'Tests 423 passed',
    );
    expect(screen.getByTestId('card-preview-summary').textContent).not.toContain(
      'Test Files 54 passed',
    );
    expect(screen.getByText('+8 filtered')).toBeTruthy();
  });

  it('uses the dedicated summary line while keeping composer text in the thumbnail', () => {
    render(
      <CardPreviewPanel
        preview={preview({
          bodyLines: [
            'I updated the tests.',
            'Run npm test next.',
            '› Summarize recent commits',
          ],
          summaryLine: 'Run npm test next.',
        })}
        activeFor="10s"
        messageCount={1}
      />,
    );

    expect(screen.getByTestId('card-preview-thumbnail').textContent).toContain(
      '› Summarize recent commits',
    );
    expect(screen.getByTestId('card-preview-summary').textContent).toBe('Run npm test next.');
  });

  it('omits the summary strip when no semantic summary is available', () => {
    render(
      <CardPreviewPanel
        preview={preview({
          bodyLines: [
            '> _',
            'Type your message...',
            '⏎ send · Esc cancel · ? shortcuts',
          ],
        })}
        activeFor="10s"
        messageCount={1}
      />,
    );

    expect(screen.queryByTestId('card-preview-summary')).toBeNull();
  });

  it('renders empty output as a terminal-shaped preview surface', () => {
    render(
      <CardPreviewPanel
        preview={preview({ kind: 'empty', source: 'none' })}
        activeFor="0s"
        messageCount={0}
      />,
    );

    expect(screen.getByTestId('card-preview-empty').textContent).toBe('card.noOutput');
  });
});
