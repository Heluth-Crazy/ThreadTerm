import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

function ruleBody(selector: string): string {
  const match = styles.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('mobile terminal CSS', () => {
  it('keeps xterm DOM renderer rows out of WebKit compositing hacks', () => {
    const viewport = ruleBody('.terminal-xterm-host .xterm-viewport');
    const screen = ruleBody('.terminal-xterm-host .xterm-screen');
    const rows = ruleBody('.terminal-xterm-host .xterm-rows');

    expect(viewport).not.toMatch(/transform\s*:/);
    expect(viewport).not.toMatch(/will-change\s*:/);
    expect(viewport).not.toMatch(/touch-action\s*:/);
    expect(screen).not.toMatch(/contain\s*:/);
    expect(rows).not.toMatch(/contain\s*:/);
  });

  it('lets terminal text-layer touches reach the scroll viewport', () => {
    const viewport = ruleBody('.terminal-xterm-host .xterm-viewport');
    const screen = ruleBody('.terminal-xterm-host .xterm-screen');
    const rows = ruleBody('.terminal-xterm-host .xterm-rows');

    expect(viewport).toMatch(/overflow-y\s*:\s*auto/);
    expect(viewport).not.toMatch(/pointer-events\s*:\s*none/);
    expect(screen).toMatch(/pointer-events\s*:\s*none/);
    expect(rows).toMatch(/pointer-events\s*:\s*none/);
  });
});
