/**
 * Regression guard for the "dead breakpoint" bug class.
 *
 * TerminalView used `hidden xs:block` / `hidden xs:inline` while no `xs`
 * screen was configured in tailwind.config.js — Tailwind silently skips
 * unknown variants, so those elements were permanently invisible (audit P0
 * #2/#3). This test walks the component sources and HTML entries and fails
 * whenever a responsive screen variant is referenced that Tailwind would not
 * generate.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../tailwind.config.js';

// Screens that always exist (Tailwind defaults) plus whatever the config
// defines or overrides under theme.extend.screens / theme.screens.
const DEFAULT_SCREENS = ['sm', 'md', 'lg', 'xl', '2xl'];
const configuredScreens = new Set([
  ...DEFAULT_SCREENS,
  ...Object.keys(tailwindConfig.theme?.extend?.screens ?? {}),
  ...Object.keys(
    (tailwindConfig.theme as { screens?: Record<string, unknown> } | undefined)?.screens ?? {},
  ),
]);

function collectFiles(dir: string, extensions: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectFiles(full, extensions, out);
    } else if (extensions.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const sourceRoots = [join(__dirname, 'components'), join(__dirname, 'windows')];
const htmlEntries = [
  'index.html',
  'selector.html',
  'float.html',
  'settings.html',
  'terminal-host.html',
].map(
  (name) => join(__dirname, '..', name),
);

// Only match tokens that look like responsive screen variants: a known-ish
// screen name directly followed by a variant separator. Other variants
// (hover:, group-hover:, aria-*, data-*) are intentionally out of scope.
const SCREEN_TOKEN = /\b(xs|sm|md|lg|xl|2xl|3xl):(?=[a-z])/g;

describe('tailwind screen variant guard', () => {
  it('every referenced screen variant is configured', () => {
    const offenders: string[] = [];

    for (const file of [
      ...sourceRoots.flatMap((root) => collectFiles(root, /\.(tsx|ts|css)$/)),
      ...htmlEntries,
    ]) {
      if (file.includes('.test.')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SCREEN_TOKEN)) {
        const screen = match[1];
        if (!configuredScreens.has(screen)) {
          const relative = file.slice(__dirname.length + 1);
          offenders.push(`${relative}: unknown screen "${screen}:"`);
        }
      }
    }

    expect(
      offenders,
      'Found breakpoint utilities that Tailwind will never generate — either add\n' +
        'the screen to tailwind.config.js or switch to an existing one. These\n' +
        'classes silently do nothing and hide UI.',
    ).toEqual([]);
  });
});
