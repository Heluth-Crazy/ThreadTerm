// Isolated Electron visual QA for xterm colour handling. It uses a fake output
// subscription and never starts a provider or attaches to an existing session.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-terminal-colours-'));
const out = resolve('qa/results/terminal-colors');
await mkdir(out, { recursive: true });

// The first colour is emitted by the installed Codex CLI 0.153.4 at startup:
// CSI 38;5;6;49m. The remaining rows protect the renderer against arbitrary
// TUI indexed and truecolour output without altering the bytes in transit.
const stream = [
  'default foreground',
  '\x1b[2mdim default foreground\x1b[22m',
  '\x1b[1mbold default foreground\x1b[22m',
  '\x1b[38;5;6mCodex indexed cyan (38;5;6)\x1b[39m',
  '\x1b[30mANSI 0 foreground on terminal background\x1b[39m',
  '\x1b[48;5;0m\x1b[38;5;15mindexed menu foreground/background\x1b[39;49m',
  '\x1b[48;5;235m\x1b[38;5;255mextended indexed foreground/background\x1b[39;49m',
  '\x1b[48;2;242;242;242m\x1b[38;2;245;245;245mtruecolour pale foreground/background\x1b[39;49m',
  '\x1b[48;2;35;35;35m\x1b[38;2;20;20;20mtruecolour dark foreground/background\x1b[39;49m',
].join('\r\n') + '\r\n';

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalSurface } from './renderer/src/components/TerminalSurface';
import { I18nProvider } from './renderer/src/i18n';
import './renderer/src/styles.css';
const bytes = new TextEncoder().encode(${JSON.stringify(stream)});
window.threadterm = {
  onEvent: () => () => {},
  subscribeOutput: async (_sessionId, _cursor, listener) => {
    queueMicrotask(() => void listener({ data: bytes, gap: false }));
    return () => {};
  },
  request: async () => ({}),
  openExternal: async () => {},
} ;
function Fixture() {
  const [theme, setTheme] = useState('light');
  window.qaSetTheme = setTheme;
  return <I18nProvider locale="zh-CN"><div className="qa-terminal"><TerminalSurface
    sessionId="qa-terminal-colours" provider="codex" theme={theme}
    terminalCompatibility={false}
    session={{id:'qa-terminal-colours', provider:'codex', mode:'terminal', status:'idle', readOnly:true, title:'Terminal colour QA', createdAt:'now', updatedAt:'now'}}
  /></div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

await build({
  stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
html,body,#root,.qa-terminal{height:100%;margin:0}.qa-terminal{display:flex;min-height:0}.qa-terminal>.terminal-wrap{flex:1;min-height:0}.term{display:flex;flex-direction:column}.term-head,.v3-session-controls{flex:0 0 auto;padding:8px}.term-output{flex:1;min-height:0}
</style><link rel="stylesheet" href="qa.css"><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 840, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
});
`);

function relativeLuminance([red, green, blue]) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}
function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForTimeout(500);
  assert.equal(errors.length, 0, errors.join('\n'));
  const hostMarkup = await page.locator('.terminal-host').innerHTML();
  assert.match(hostMarkup, /xterm/, 'TerminalSurface must mount xterm before colour assertions');
  await page.locator('.terminal-host .xterm-rows').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('truecolour dark foreground/background'));

  async function capture(theme) {
    const width = page.viewportSize()?.width;
    await page.screenshot({ path: join(out, `${theme}-${width}.png`) });
    if (width === 1280) await page.screenshot({ path: join(out, `${theme}.png`) });
    const sample = await page.evaluate(() => {
      const rgba = (value) => {
        const channels = (value.match(/[\d.]+/g) ?? []).map(Number);
        return [...channels.slice(0, 3), channels[3] ?? 1];
      };
      const terminal = document.querySelector('.terminal-host .xterm-scrollable-element');
      const background = getComputedStyle(terminal).backgroundColor;
      const labels = [
        ['default foreground', 4.5], ['dim default foreground', 3], ['bold default foreground', 4.5],
        ['Codex indexed cyan (38;5;6)', 4.5], ['ANSI 0 foreground on terminal background', 4.5],
        ['indexed menu foreground/background', 4.5],
        ['extended indexed foreground/background', 4.5], ['truecolour pale foreground/background', 4.5],
        ['truecolour dark foreground/background', 4.5],
      ];
      return {
        rows: document.querySelector('.xterm-rows')?.innerText, background: rgba(background),
        rowsByLabel: labels.map(([label, minimum]) => {
          const span = [...document.querySelectorAll('.terminal-host .xterm-rows span')].find((candidate) => candidate.textContent?.includes(label));
          if (!span) throw Error('missing xterm span for ' + label);
          const style = getComputedStyle(span);
          const localBackground = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? background : style.backgroundColor;
          return { label, minimum, foreground: rgba(style.color), background: rgba(localBackground) };
        }),
      };
    });
    assert.match(sample.rows ?? '', /Codex indexed cyan \(38;5;6\)/);
    assert.match(sample.rows ?? '', /truecolour pale foreground\/background/);
    const rows = sample.rowsByLabel.map((row) => {
      const visibleForeground = row.foreground.slice(0, 3).map((channel, index) => Math.round(channel * row.foreground[3] + row.background[index] * (1 - row.foreground[3])));
      return { ...row, visibleForeground, contrast: contrastRatio(visibleForeground, row.background) };
    });
    for (const row of rows) assert.ok(row.contrast >= row.minimum, `${theme} ${row.label} contrast ${row.contrast} is below ${row.minimum}`);
    if (theme === 'light') {
      const ansiZeroForeground = rows.find((row) => row.label === 'ANSI 0 foreground on terminal background');
      const indexedMenu = rows.find((row) => row.label === 'indexed menu foreground/background');
      assert.deepEqual(indexedMenu?.background.slice(0, 3), [242, 242, 242], 'ANSI index 0 background is the neutral light surface');
      assert.ok(ansiZeroForeground?.visibleForeground.every((channel) => channel < 128), 'ANSI index 0 foreground is contrast-corrected to a dark readable colour');
    }
    assert.equal(await page.evaluate(() => {
      const rows = document.querySelector('.terminal-host .xterm-rows');
      return rows?.scrollWidth <= rows?.clientWidth;
    }), true, `${theme} ${width}px terminal rows must not overflow horizontally`);
    return { width, background: sample.background, rows };
  }

  const widths = [1280, 1440, 1920];
  const light = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 840 });
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('truecolour dark foreground/background'));
    light.push(await capture('light'));
  }
  await page.evaluate(() => window.qaSetTheme('dark'));
  await page.waitForTimeout(100);
  const dark = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 840 });
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('truecolour dark foreground/background'));
    dark.push(await capture('dark'));
  }
  assert.notDeepEqual(light[0].background, dark[0].background, 'late terminal theme change must repaint the existing xterm surface');
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'report.json'), JSON.stringify({
    passed: true,
    fixtures: ['normal', 'dim', 'bold', 'Codex 38;5;6', 'ANSI 0 foreground/background', 'indexed fg/bg', 'truecolour fg/bg'],
    light: light[0],
    dark: dark[0],
    widths: { light, dark },
  }, null, 2));
  console.log(JSON.stringify({ passed: true, out }));
} finally {
  if (app) await app.close();
}
