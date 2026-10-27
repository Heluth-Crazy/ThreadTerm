// Isolated UI QA for the quick-launch prototype. It never runs a configured command.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const source = join(root, 'prototypes', 'quick-launch');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-quick-launch-qa-'));
const out = join(root, 'qa', 'results', 'quick-launch-prototype');
await mkdir(out, { recursive: true });
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], screenshots: [], browserErrors: [] };
let app;
let page;

async function shot(name) {
  await page.screenshot({ path: join(out, name), animations: 'disabled', fullPage: true });
  report.screenshots.push(name);
}
async function waitText(selector, text) {
  await page.locator(selector).filter({ hasText: text }).waitFor();
}
async function openQuick() {
  const button = page.locator('#quickToggle');
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await page.locator('#quickMenu:not(.hidden)').waitFor();
}
async function runNamed(name) {
  await openQuick();
  await page.locator('[data-run]').filter({ hasText: name }).click();
}
async function ensureNodeScenario() {
  await page.locator('#scenario').selectOption('node');
  await page.waitForTimeout(50);
}

try {
  await writeFile(join(scratch, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
    app.whenReady().then(() => {
      const w = new BrowserWindow({width: 1280, height: 900, show: false, webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
      w.loadFile(${JSON.stringify(join(source, 'index.html'))});
    });
  `);
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], timeout: 15000 });
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('dialog', async dialog => { report.browserErrors.push(`unexpected dialog: ${dialog.message()}`); await dialog.dismiss(); });

  await page.locator('#quickToggle').waitFor();
  assert.equal(await page.locator('#closedTerminal').isVisible(), false, 'idle state has no closed-terminal placeholder');
  assert.equal(await page.locator('#navDot').evaluate(el => el.classList.contains('running')), false, 'idle sidebar LED is not green');
  await ensureNodeScenario();
  await runNamed('Web development service');
  await waitText('#terminalStatus', 'Starting');
  assert.equal(await page.locator('#navDot').evaluate(el => el.classList.contains('running')), true, 'active service lights the sidebar LED');
  await waitText('#terminalStatus', 'Port not ready');
  await waitText('#terminalStatus', 'Listening port detected');
  assert.equal(await page.locator('#openPreview').isDisabled(), false, 'preview enables only after a port proof');
  await page.locator('#openPreview').click();
  await page.locator('[data-qa="preview-frame"], .preview-frame:not(.hidden), iframe[title]').waitFor();
  assert.equal(report.browserErrors.some(item => item.startsWith('unexpected dialog:')), false, 'preview must use the preview area, never alert');
  await openQuick();
  await shot('active-node-menu-preview.png');
  await page.keyboard.press('Escape');
  report.checks.push('Node service shows starting, running-before-port, port-ready, then renders an in-app preview');

  const beforeOutput = await page.locator('#terminalOutput').textContent();
  await runNamed('Web development service');
  assert.match(await page.locator('#terminalOutput').textContent(), /VITE|LISTENING/i);
  assert.equal(await page.locator('#terminalOutput').textContent(), beforeOutput, 'running command is reused for the active worktree');
  report.checks.push('re-running an active command reopens its existing instance without a second launch');

  await openQuick();
  await page.locator('[data-edit][aria-label="Edit Web development service"]').click();
  await page.locator('#commandDialog').waitFor();
  assert.equal(await page.locator('#fShell').inputValue(), 'PowerShell');
  assert.equal(await page.locator('#fCwd').inputValue(), '.');
  assert.equal(await page.locator('#fType').inputValue(), 'custom');
  assert.equal(await page.locator('#fFavorite').isChecked(), true);
  await page.locator('#fName').fill('Edited web service');
  await page.locator('#fCommand').fill('npm run dev -- --host 0.0.0.0');
  await page.locator('#fShell').selectOption('CMD');
  await page.locator('#fCwd').fill('apps\\web');
  await page.locator('#fFavorite').uncheck();
  await page.getByRole('button', { name: 'Save command' }).click();
  assert.equal(await page.locator('#terminalTitle').textContent(), 'Web development service', 'editing a definition cannot change an active run snapshot');
  assert.equal(await page.locator('#terminalOutput').textContent(), beforeOutput, 'active run retains original command, shell, and cwd after edit');
  await openQuick();
  const editedRow = page.locator('.command-row').filter({ hasText: 'Edited web service' });
  assert.equal(await editedRow.count(), 1);
  assert.doesNotMatch(await editedRow.textContent(), /★/);
  await page.locator('[data-edit][aria-label="Edit Edited web service"]').click();
  assert.equal(await page.locator('#fShell').inputValue(), 'CMD');
  assert.equal(await page.locator('#fCwd').inputValue(), 'apps\\web');
  assert.equal(await page.locator('#fType').inputValue(), 'custom');
  assert.equal(await page.locator('#fFavorite').isChecked(), false);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Escape');
  report.checks.push('editing an active service preserves its run snapshot; future definition persists command, CMD shell, cwd, service type, and favorite');

  await runNamed('Edited web service');
  await page.locator('[data-worktree="feature"]').click();
  const featureOutput = await page.locator('#terminalOutput').textContent();
  assert.match(featureOutput, /Choose a quick command|PS .*feature/i);
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#treeLabel').textContent(), 'feature', 'delayed main run must not move UI back to another worktree');
  assert.equal(await page.locator('#terminalOutput').textContent(), featureOutput, 'delayed main run must not overwrite the selected worktree view');
  report.checks.push('worktree changes isolate delayed lifecycle updates and terminal instances');

  await page.locator('[data-worktree="main"]').click();
  await page.locator('#closeTerminal').click();
  assert.match(await page.locator('#stripTitle').textContent(), /is still running|Run/, 'closing hides only the view');
  assert.equal(await page.locator('#closedTerminal').isVisible(), true, 'closed placeholder is visible only after closing its terminal view');
  assert.equal(await page.locator('.terminal-panel').isVisible(), false, 'closed view hides the original terminal panel');
  assert.equal(await page.locator('#openPreview').isDisabled(), false, 'closing a terminal view does not hide a ready service preview');
  await page.locator('#stripOpen').click();
  assert.equal(await page.locator('#closedTerminal').isVisible(), false, 'reopening removes the closed placeholder');
  assert.equal(await page.locator('#stopRun').isDisabled(), false, 'reopened view preserves running process controls');
  await page.locator('#stopRun').click();
  await waitText('#terminalStatus', 'Stopped');
  assert.equal(await page.locator('#navDot').evaluate(el => el.classList.contains('running')), false, 'stopped run has no green sidebar LED');
  assert.match(await page.locator('#terminalOutput').textContent(), /stopped|\^C/i);
  report.checks.push('close terminal view does not stop process; Stop applies only to the displayed run');

  await runNamed('Edited web service');
  await waitText('#terminalStatus', 'Starting');
  const editedLaunch = await page.locator('#terminalOutput').textContent();
  assert.match(editedLaunch, /Microsoft Windows/);
  assert.match(editedLaunch, /ThreadTerm-v3\\apps\\web> npm run dev -- --host 0\.0\.0\.0/);
  await page.locator('#stopRun').click();
  await waitText('#terminalStatus', 'Stopped');
  report.checks.push('the next launch uses the edited CMD shell and worktree-relative cwd while retaining service lifecycle behavior');

  await runNamed('Run unit tests');
  await waitText('#terminalStatus', 'Completed');
  assert.match(await page.locator('#terminalOutput').textContent(), /exit(?:ed)? (?:with )?code 0/i);
  report.checks.push('one-shot task ends with explicit success and exit code');

  await page.locator('#scenario').selectOption('script');
  await waitText('#terminalStatus', 'Launch failed');
  assert.equal(await page.locator('#navDot').evaluate(el => el.classList.contains('running')), false, 'failed run has no green sidebar LED');
  assert.match(await page.locator('#terminalOutput').textContent(), /Missing script/i);
  assert.match(await page.locator('.activity-strip').textContent(), /npm run|edit/i, 'missing Node script gives an actionable next step');
  await page.locator('#scenario').selectOption('java');
  await waitText('#terminalStatus', 'Launch failed');
  assert.match(await page.locator('#terminalOutput').textContent(), /PATH|JAVA_HOME/i);
  await page.locator('#mockFix:not(.hidden)').click();
  await waitText('#terminalStatus', 'Port not ready');
  await waitText('#portProof', '8080');
  report.checks.push('Node missing-script and Java PATH/JAVA_HOME failures expose actionable recovery; mock repair can retry');

  await openQuick();
  await page.locator('#newCommand').click();
  await page.locator('#commandDialog').waitFor();
  const savedRunTitle = await page.locator('#terminalTitle').textContent();
  const savedRunOutput = await page.locator('#terminalOutput').textContent();
  await page.locator('#fName').fill('QA persistent command');
  await page.locator('#fCommand').fill('echo prototype-only');
  await page.locator('#fScope').selectOption('global');
  await page.getByRole('button', { name: 'Save command' }).click();
  await page.locator('#commandDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#terminalTitle').textContent(), savedRunTitle, 'saving a command must not execute it');
  assert.equal(await page.locator('#terminalOutput').textContent(), savedRunOutput, 'save leaves the current run untouched');
  await openQuick();
  assert.equal(await page.locator('.command-row').filter({hasText:'QA persistent command'}).count(), 1);
  const beforeEnterSaveTitle = await page.locator('#terminalTitle').textContent();
  await page.locator('#newCommand').click();
  await page.locator('#fName').fill('QA Enter saves only');
  await page.locator('#fCommand').fill('echo save-only');
  await page.locator('#fName').press('Enter');
  await page.locator('#commandDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#terminalTitle').textContent(), beforeEnterSaveTitle, 'Enter in a filled New form saves but does not run');
  await openQuick();
  assert.equal(await page.locator('.command-row').filter({hasText:'QA Enter saves only'}).count(), 1, 'implicit form submit persists the new definition');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('#quickToggle').waitFor();
  await openQuick();
  assert.equal(await page.locator('.command-row').filter({hasText:'QA persistent command'}).count(), 1, 'saved command survives isolated-app reload');
  await page.locator('#commandSearch').fill('persistent');
  assert.equal(await page.locator('.command-row').count(), 1, 'search reduces rows');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#quickMenu').evaluate(el => el.classList.contains('hidden')), true, 'Escape closes quick menu');
  report.checks.push('new global command persists without executing; search works, and Escape restores focusable menu state');

  await page.locator('#quickToggle').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#commandSearch').evaluate(el => document.activeElement === el), true, 'keyboard opening moves focus to search');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#quickToggle').evaluate(el => document.activeElement === el), true, 'Escape returns focus to trigger');
  await page.locator('#quickToggle').click();
  await page.locator('#newCommand').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.locator('#commandDialog').evaluate(el => !el.open), true, 'blank New form Cancel closes despite required fields');
  await openQuick();
  await page.locator('#newCommand').click();
  await page.getByRole('button', { name: 'Close' }).click();
  assert.equal(await page.locator('#commandDialog').evaluate(el => !el.open), true, 'blank New form header close closes despite required fields');
  await openQuick();
  await page.locator('#newCommand').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#commandDialog').evaluate(el => !el.open), true, 'Escape closes editor dialog');
  report.checks.push('quick menu and editor dialog satisfy keyboard Escape and focus-return behavior');

  for (const theme of ['light', 'dark']) {
    const shouldDark = theme === 'dark';
    const isDark = await page.locator('body').evaluate(el => el.classList.contains('dark'));
    if (isDark !== shouldDark) await page.locator('#theme').click();
    for (const width of [1280, 1440, 1920, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await openQuick();
      const overflow = await page.evaluate(() => ({ viewport: innerWidth, doc: document.documentElement.scrollWidth }));
      assert.ok(overflow.doc <= overflow.viewport + 1, `${theme} ${width}px has horizontal overflow ${JSON.stringify(overflow)}`);
      await shot(`${theme}-${width}.png`);
      await page.keyboard.press('Escape');
    }
  }
  assert.deepEqual(report.browserErrors, [], `browser errors: ${report.browserErrors.join('; ')}`);
  report.checks.push('light/dark screenshots at 1280, 1440, 1920, and 320 have no document horizontal overflow or browser errors');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (app) {
    await app.evaluate(({app: electronApp}) => electronApp.exit(0)).catch(() => undefined);
    await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 5000))]).catch(() => undefined);
    try { app.process()?.kill(); } catch { /* already exited */ }
  }
  console.log(JSON.stringify(report));
}
