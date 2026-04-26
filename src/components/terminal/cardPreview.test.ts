import { describe, expect, it } from 'vitest';
import { buildCardPreview, isTechnicalPreviewLine } from './cardPreview';
import type { TerminalCard } from '../../types/terminal';

function card(overrides: Partial<TerminalCard>): Pick<TerminalCard, 'lastReplyPreview' | 'lastOutput' | 'status' | 'terminalType'> {
  return {
    lastReplyPreview: '',
    lastOutput: '',
    status: 'idle',
    terminalType: 'shell',
    ...overrides,
  };
}

describe('buildCardPreview', () => {
  it('removes TUI borders while keeping meaningful content', () => {
    const preview = buildCardPreview(
      card({
        terminalType: 'codex',
        lastReplyPreview: [
          '╭────────────────────────╮',
          '│  I updated the tests.  │',
          '│  Run npm test next.    │',
          '╰────────────────────────╯',
        ].join('\n'),
      }),
    );

    expect(preview.kind).toBe('reply');
    expect(preview.bodyLines).toEqual(['I updated the tests.', 'Run npm test next.']);
  });

  it('collapses spinner redraw frames into stable content', () => {
    const preview = buildCardPreview(
      card({
        status: 'running',
        terminalType: 'claude',
        lastReplyPreview: [
          '⠋ loading project context',
          '⠙ loading project context',
          '⠹ loading project context',
          'Reading src/components/terminal/TerminalCard.tsx',
        ].join('\n'),
      }),
    );

    expect(preview.kind).toBe('thinking');
    expect(preview.bodyLines).toEqual([
      'loading project context',
      'Reading src/components/terminal/TerminalCard.tsx',
    ]);
  });

  it('filters keyboard help/status bars', () => {
    const preview = buildCardPreview(
      card({
        terminalType: 'codex',
        lastReplyPreview: [
          'Model: gpt-5.5',
          'Esc cancel · Enter send · Tab switch',
          'Here is the implementation plan.',
        ].join('\n'),
      }),
    );

    expect(preview.bodyLines).toEqual(['Here is the implementation plan.']);
  });

  it('filters shell startup completion noise', () => {
    const preview = buildCardPreview(
      card({
        terminalType: 'shell',
        lastOutput: [
          '/Users/me/.openclaw/completions/openclaw.zsh:3685: command not found: compdef',
          '$ pwd',
          'custom-ok',
        ].join('\n'),
      }),
    );

    expect(preview.bodyLines).toEqual(['$ pwd', 'custom-ok']);
  });

  it('returns empty when the preview is only decoration', () => {
    const preview = buildCardPreview(
      card({
        lastReplyPreview: ['╭────────╮', '│        │', '╰────────╯'].join('\n'),
      }),
    );

    expect(preview.kind).toBe('empty');
    expect(preview.bodyLines).toEqual([]);
  });

  it('preserves shell output and marks technical lines', () => {
    const preview = buildCardPreview(
      card({
        terminalType: 'shell',
        lastOutput: ['$ npm run build', 'Error: build failed'].join('\n'),
      }),
    );

    expect(preview.kind).toBe('shell');
    expect(preview.bodyLines).toEqual(['$ npm run build', 'Error: build failed']);
    expect(isTechnicalPreviewLine(preview.bodyLines[0])).toBe(true);
    expect(isTechnicalPreviewLine(preview.bodyLines[1])).toBe(true);
  });
});
