// Isolated F3 QA for the composer's `+` add menu and the Quick messages
// settings section. It bundles the two production components with the real
// stylesheet and a deterministic host component; it never starts a runtime,
// provider, account or user profile. Screenshots cover 420/1100 px, light and
// dark, en and zh-CN, plus a custom theme, for the closed menu, the root menu
// and the quick-messages panel. Every cell asserts zero control-consistency
// violations.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-quick-messages-'));
const out = resolve('qa/results/chat-parity/F3/quick-messages');
await mkdir(out, { recursive: true });

const entry = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerPlusMenu } from './renderer/src/components/ComposerPlusMenu';
import { SettingsQuickMessages } from './renderer/src/components/SettingsQuickMessages';
import './renderer/src/styles.css';

const SEED = [
  { id: 'summarize', title: 'Summarize the diff', text: 'Summarize the current diff.' },
  { id: 'tests', title: 'Run the tests', text: 'Run the full test suite and fix failures.' },
  { id: 'explain', title: 'Explain the change', text: 'Explain the code you just changed.' },
];
const host = { locale: 'en', live: true, disabled: false, attaches: 0, slashes: 0, feedback: 0 };

function Harness() {
  const [messages, setMessages] = useState(SEED);
  const [text, setText] = useState('');
  const area = useRef(null);
  const copy = (en, zh) => host.locale === 'zh-CN' ? zh : en;
  const update = patch => { if (Array.isArray(patch.quickMessages)) setMessages(patch.quickMessages); return Promise.resolve(); };
  const insert = message => {
    const field = area.current;
    const start = field && field.selectionStart !== null ? field.selectionStart : text.length;
    const end = field && field.selectionEnd !== null ? field.selectionEnd : start;
    const next = text.slice(0, start) + message.text + text.slice(end);
    setText(next);
    const caret = start + message.text.length;
    requestAnimationFrame(() => { const node = area.current; if (node) { node.focus(); node.setSelectionRange(caret, caret); } });
  };
  return <div className="qa-page">
    <section className="qa-composer chat-compose-shell">
      <div className="chat-compose-bar">
        <ComposerPlusMenu quickMessages={messages} disabled={host.disabled} liveFeedbackEnabled={host.live}
          onAttachFiles={() => { host.attaches += 1; }} onPickQuickMessage={insert}
          onSlashCommands={() => { host.slashes += 1; }} onLiveFeedback={() => { host.feedback += 1; }} copy={copy} />
        <textarea ref={area} value={text} onChange={event => setText(event.target.value)} aria-label="Message" />
      </div>
    </section>
    <section className="qa-settings">
      <SettingsQuickMessages settings={{ revision: 1, quickMessages: messages }} zh={host.locale === 'zh-CN'} update={update} />
    </section>
  </div>;
}
const root = createRoot(document.getElementById('root'));
let renders = 0;
window.qaRender = options => { Object.assign(host, options); root.render(<Harness key={'render-' + (renders++)} />); };
window.qaHost = () => ({ ...host });
window.qaTheme = theme => {
  const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
  const style = document.documentElement.style;
  for (const [key, value] of Object.entries(custom)) style.setProperty('--custom-' + key, value);
  document.documentElement.dataset.theme = theme === 'custom' ? 'dark' : theme;
  document.documentElement.dataset.customTheme = theme === 'custom' ? 'true' : 'false';
};
document.documentElement.dataset.theme = 'light';
window.qaRender({ locale: 'en', live: true, disabled: false });
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{margin:0;min-height:100%}#root{background:var(--bg);color:var(--text)}.qa-page{display:flex;flex-direction:column;gap:16px;padding:16px;max-width:640px;min-height:100vh;box-sizing:border-box}.qa-composer{position:relative;border:1px solid var(--border);border-radius:var(--radius-card);background:var(--surface);padding:12px}.qa-composer .chat-plus-menu.is-anchored{top:calc(100% + 6px);bottom:auto}.qa-settings{border:1px solid var(--border);border-radius:var(--radius-card);background:var(--surface);padding:12px}.qa-composer textarea{width:100%;box-sizing:border-box;min-height:56px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font:inherit}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
env.Path = join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const report = { passed: false, scratch, checks: [], screenshots: [], consistency: [], errors: [] };
let app, page;
const plus = () => page.getByTestId('composer-plus');
const menu = () => page.getByTestId('composer-plus-menu');
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function render(options) {
  await page.evaluate(value => window.qaRender(value), options);
  await page.locator('.qa-composer').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function setTheme(theme) { await page.evaluate(value => window.qaTheme(value), theme); }
async function closeMenu() { if (await menu().count()) { await page.keyboard.press('Escape'); await menu().waitFor({ state: 'detached' }); } }

try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(scratch, 'main.cjs')], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.locator('.qa-composer').waitFor();

  // Interactions first (a later remount resets the seed list).
  await plus().click();
  await menu().waitFor();
  assert.equal(await menu().getAttribute('data-plus-panel'), 'root');
  for (const testId of ['plus-attach-files', 'plus-quick-messages', 'plus-slash-commands', 'plus-live-feedback']) await page.getByTestId(testId).waitFor();
  assert.equal(await page.getByTestId('plus-live-feedback').isDisabled(), false, 'live feedback is enabled while a note turn runs');
  await page.getByTestId('plus-attach-files').click();
  await page.waitForFunction(() => window.qaHost().attaches === 1);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'composer-plus', 'the menu returns focus to + after an action');
  report.checks.push('root menu lists Attach files, Quick messages, Slash commands and Live feedback; Attach runs once and restores focus');

  // F3-03: the enabled Live feedback action reaches the note path.
  await plus().click();
  await menu().waitFor();
  assert.equal(await page.getByTestId('plus-live-feedback').isDisabled(), false, 'live feedback is enabled while a note turn runs');
  await page.getByTestId('plus-live-feedback').click();
  await page.waitForFunction(() => window.qaHost().feedback === 1);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'composer-plus', 'Live feedback restores focus to +');
  report.checks.push('the enabled Live feedback action opens the note path exactly once');

  await plus().click();
  await page.getByTestId('plus-slash-commands').click();
  await page.waitForFunction(() => window.qaHost().slashes === 1);
  report.checks.push('Slash commands triggers the existing slash entry point');

  await plus().click();
  await page.getByTestId('plus-quick-messages').click();
  assert.equal(await menu().getAttribute('data-plus-panel'), 'quick');
  const quickRows = page.getByTestId('plus-quick-message');
  assert.equal(await quickRows.count(), 3);
  await page.locator('.qa-composer textarea').click();
  await page.keyboard.type('hello ');
  await plus().click();
  await page.getByTestId('plus-quick-messages').click();
  await quickRows.nth(1).click();
  const inserted = await page.locator('.qa-composer textarea').inputValue();
  report.checks.push('Quick messages panel inserts the chosen snippet at the caret');
  assert.equal(inserted, 'hello Run the full test suite and fix failures.');

  // Live feedback is disabled outside a note-capable running turn.
  await render({ locale: 'en', live: false, disabled: false, feedback: 0 });
  await plus().click();
  assert.equal(await page.getByTestId('plus-live-feedback').isDisabled(), true, 'live feedback stays disabled without a note turn');
  await page.getByTestId('plus-live-feedback').evaluate(node => node.click());
  assert.equal(await page.evaluate(() => window.qaHost().feedback), 0);
  await closeMenu();
  report.checks.push('Live feedback is disabled and inert without a running note turn');

  // Escape and arrow keys follow the composer menu behaviour.
  await render({ locale: 'en', live: true, disabled: false });
  await plus().focus();
  await page.keyboard.press('Enter');
  await menu().waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'plus-attach-files', 'the first item is focused on open');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'plus-quick-messages');
  await page.keyboard.press('Escape');
  await menu().waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'composer-plus', 'Escape restores focus to +');
  report.checks.push('Keyboard: first item focuses on open, ArrowDown moves, Escape closes and restores focus');

  // Settings: add, edit, reorder and delete.
  await render({ locale: 'en', live: true, disabled: false });
  await page.getByTestId('quick-message-add').click();
  await page.getByTestId('quick-message-editor').locator('input').fill('Release notes');
  await page.getByTestId('quick-message-editor').locator('textarea').fill('Draft the release notes for this change.');
  await page.getByTestId('quick-message-save').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="quick-message-row"]').length === 4);
  assert.equal(await page.getByTestId('quick-message-row').count(), 4);
  await page.getByTestId('quick-message-edit').first().click();
  await page.getByTestId('quick-message-editor').locator('input').fill('Summarize now');
  await page.getByTestId('quick-message-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="quick-message-row"] strong')?.textContent === 'Summarize now');
  await page.getByTestId('quick-message-down').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="quick-message-row"] strong')[0]?.textContent === 'Run the tests');
  await page.getByTestId('quick-message-delete').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="quick-message-row"]').length === 3);
  report.checks.push('Settings add, edit, reorder and delete update the list');

  // Full matrix: closed menu, root menu, quick panel; 3 themes x 2 locales x 2 widths.
  for (const theme of ['light', 'dark', 'custom']) {
    for (const locale of ['en', 'zh-CN']) {
      for (const width of [1100, 420]) {
        await page.setViewportSize({ width, height: 900 });
        for (const state of ['closed', 'root', 'quick']) {
          await render({ locale, live: true, disabled: false });
          await setTheme(theme);
          if (state === 'root') { await plus().click(); await menu().waitFor(); }
          if (state === 'quick') { await plus().click(); await page.getByTestId('plus-quick-messages').click(); await page.locator('[data-plus-panel="quick"]').waitFor(); }
          const label = `${state}/${theme}/${locale}/${width}`;
          report.consistency.push({ label, composer: await checkControlConsistency(page, '.qa-composer'), settings: await checkControlConsistency(page, '.qa-settings') });
          assertNoControlViolations(report.consistency.at(-1).composer, `${label} composer`);
          assertNoControlViolations(report.consistency.at(-1).settings, `${label} settings`);
          await shot(`quick-messages-${state}-${theme}-${locale}-${width}.png`);
          await closeMenu();
        }
      }
    }
  }
  report.checks.push('matrix: closed/root/quick x light/dark/custom x en/zh-CN x 1100/420 with zero control violations');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, [], report.errors.join('\n'));
console.log(`PASS quick messages QA — ${report.screenshots.length} screenshots, ${report.consistency.length} consistency cells`);
