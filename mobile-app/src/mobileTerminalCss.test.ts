import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const expectedStylesheetImports = [
  './styles/01-foundation.css',
  './styles/02-terminal.css',
  './styles/03-scanner-navigation.css',
  './styles/04-workbench.css',
  './styles/05-terminal-list.css',
  './styles/06-settings.css',
  './styles/07-detail-routes.css',
  './styles/08-responsive.css',
  './styles/09-workspace.css',
] as const;
const stylesheetEntry = readFileSync(
  resolve(__dirname, 'styles.css'),
  'utf8',
);
const stylesheetImportPattern = /^@import\s+['"]([^'"]+)['"];\s*$/gm;
const stylesheetImports = Array.from(
  stylesheetEntry.matchAll(stylesheetImportPattern),
  (match) => match[1],
);
const styles = stylesheetImports
  .map((stylesheetPath) =>
    readFileSync(resolve(__dirname, stylesheetPath), 'utf8'),
  )
  .join('');

function ruleBody(selector: string): string {
  const match = styles.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('mobile terminal CSS', () => {
  it('keeps the stylesheet cascade in its fixed import order', () => {
    expect(stylesheetImports).toEqual(expectedStylesheetImports);
    expect(stylesheetEntry.replace(stylesheetImportPattern, '').trim()).toBe('');
  });

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
