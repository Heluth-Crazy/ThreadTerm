import { describe, expect, it } from 'vitest';
import { gracefulShutdownProfileForCard } from './terminalShutdown';

describe('gracefulShutdownProfileForCard', () => {
  it.each(['claude', 'codex', 'opencode', 'gemini', 'kimi', 'grok'] as const)(
    'maps the built-in %s command to its provider profile',
    (terminalType) => {
      expect(gracefulShutdownProfileForCard({ terminalType })).toBe(terminalType);
    },
  );

  it('uses generic for shells and non-Agent terminal types', () => {
    expect(gracefulShutdownProfileForCard({ terminalType: 'shell' })).toBe('generic');
    expect(gracefulShutdownProfileForCard({ terminalType: 'npm' })).toBe('generic');
  });

  it('never guesses a provider protocol for a custom command', () => {
    expect(
      gracefulShutdownProfileForCard({
        terminalType: 'codex',
        command: 'codex --dangerously-bypass-approvals-and-sandbox',
      }),
    ).toBe('generic');
  });
});
