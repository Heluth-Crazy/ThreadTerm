import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalEvent } from '../types/terminal';
import { resolveTerminalEventSummary } from './terminalEventSummary';

const event = (overrides: Partial<TerminalEvent> = {}): TerminalEvent => ({
  at: 1,
  kind: 'user-input',
  summary: 'Sent input',
  ...overrides,
});

const fallbackT = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as TFunction<'terminal'>;

describe('resolveTerminalEventSummary', () => {
  it('translates the restricted startup key', () => {
    const t = vi.fn(() => '已发送输入') as unknown as TFunction<'terminal'>;
    expect(resolveTerminalEventSummary(event({ summaryKey: 'terminal:view.sentInput' }), t)).toBe(
      '已发送输入',
    );
    expect(t).toHaveBeenCalledWith('view.sentInput', { defaultValue: 'Sent input' });
  });

  it('keeps persisted text when no key is present', () => {
    const t = vi.fn(fallbackT);
    expect(resolveTerminalEventSummary(event({ summary: 'legacy event' }), t)).toBe('legacy event');
    expect(t).not.toHaveBeenCalled();
  });

  it('rejects forged runtime keys instead of treating them as i18n keys', () => {
    const t = vi.fn(fallbackT);
    const forged = { ...event(), summaryKey: 'terminal:view.secret' } as unknown as TerminalEvent;
    expect(resolveTerminalEventSummary(forged, t)).toBe('Sent input');
    expect(t).not.toHaveBeenCalled();
  });

  it('uses persisted text when the translator falls back', () => {
    expect(
      resolveTerminalEventSummary(event({ summary: 'old startup text', summaryKey: 'terminal:view.sentInput' }), fallbackT),
    ).toBe('old startup text');

    const missingT = (() => 'view.sentInput') as unknown as TFunction<'terminal'>;
    expect(
      resolveTerminalEventSummary(
        event({ summary: 'missing translation', summaryKey: 'terminal:view.sentInput' }),
        missingT,
      ),
    ).toBe('missing translation');
  });
});
