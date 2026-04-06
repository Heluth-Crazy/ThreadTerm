import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStatusStore } from '../../stores/sessionStatusStore';
import { SessionStatusBadge } from './SessionStatusBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

beforeEach(() => {
  useSessionStatusStore.setState({ statuses: {} });
});

describe('SessionStatusBadge — UI rendering', () => {
  it('D1: processing shows blue pulse dot and text', () => {
    useSessionStatusStore.setState({
      statuses: {
        s1: { status: 'processing', updatedAt: Date.now(), provider: 'claude' },
      },
    });

    const { container } = render(<SessionStatusBadge sessionId="s1" />);

    // Outer badge has blue text
    const badge = container.querySelector('span');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('text-blue-400');

    // Pulsing dot
    const dot = container.querySelector('.animate-pulse');
    expect(dot).toBeTruthy();
    expect(dot!.className).toContain('bg-blue-400');

    // Text (non-compact)
    expect(badge!.textContent).toContain('sessionStatus.processing');
  });

  it('D2: needs_attention(error) shows red element', () => {
    useSessionStatusStore.setState({
      statuses: {
        s1: { status: 'needs_attention', attentionReason: 'error', updatedAt: Date.now() },
      },
    });

    const { container } = render(<SessionStatusBadge sessionId="s1" />);
    const badge = container.querySelector('span');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('text-red-400');

    const dot = container.querySelector('.bg-red-400');
    expect(dot).toBeTruthy();

    expect(badge!.textContent).toContain('sessionStatus.needs_attention_error');
  });

  it('D3: needs_attention(permission) shows permission label', () => {
    useSessionStatusStore.setState({
      statuses: {
        s1: { status: 'needs_attention', attentionReason: 'permission', updatedAt: Date.now() },
      },
    });

    const { container } = render(<SessionStatusBadge sessionId="s1" />);
    const badge = container.querySelector('span');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toContain('sessionStatus.needs_attention_permission');
  });

  it('D4: completed shows green element and text', () => {
    useSessionStatusStore.setState({
      statuses: {
        s1: { status: 'completed', updatedAt: Date.now() },
      },
    });

    const { container } = render(<SessionStatusBadge sessionId="s1" />);
    const badge = container.querySelector('span');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('text-green-400');

    const dot = container.querySelector('.bg-green-400');
    expect(dot).toBeTruthy();

    expect(badge!.textContent).toContain('sessionStatus.completed');
  });

  it('D5: idle renders nothing', () => {
    // No entry in store → idle default → null
    const { container } = render(<SessionStatusBadge sessionId="s1" />);
    expect(container.innerHTML).toBe('');
  });
});
