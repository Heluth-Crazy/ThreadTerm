// Desktop-1 real-app acceptance QA for F3 (quick messages + the `+` add menu).
//
// Builds the production app on an isolated profile/data/pipe with a fake Codex
// app-server (no real agent CLI is reachable), then exercises the `+` menu, a
// quick-message insert at the caret, attaching files through the stubbed native
// dialog, and the Settings add/edit/delete/reorder flow. It never calls focus()
// and never touches the user's profile or clipboard.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/fake-codex-composer.cjs');
const out = join(root, 'qa/results/chat-parity/F3/quick-messages-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-quick-messages-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-requests.jsonl');
const report = { passed: false, checks: [], screenshots: [], consistency: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'quick-messages-qa', version: '0.1.0', main: 'main.cjs' })); }

// A 1x1 PNG so the picked image goes through the composer's image path.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(fixture), 'missing fake Codex composer fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(workspace, { recursive: true }); await writeFile(log, '');
  const textFile = join(workspace, 'notes.txt'); await writeFile(textFile, 'Attached notes for the agent.\n');
  const imageFile = join(workspace, 'pixel.png'); await writeFile(imageFile, PNG);
  await buildApp();
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nnode ${JSON.stringify(fixture)}\r\n`);
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-quick-messages-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_CODEX_COMPOSER_LOG: log,
    THREADTERM_QA_CODEX_COMPOSER_CWD: workspace,
    THREADTERM_V3_ATTACH_FILES_QA: `${textFile};${imageFile}`,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  await mkdir(env.CODEX_HOME, { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot');
  const messages = [
    { id: 'summarize', title: 'Summarize the diff', text: 'Summarize the current diff.' },
    { id: 'tests', title: 'Run the tests', text: 'Run the full test suite and fix failures.' },
  ];
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false }, quickMessages: messages }, expectedRevision: initial.settings.revision, operationId: randomUUID() });

  const project = await request('project.add', { path: workspace, name: 'Quick messages QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Quick messages QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  const composer = scope.locator('.chat-compose-shell textarea');
  await until(() => composer.isEnabled(), 'chat composer ready');

  // The `+` menu is the single add entry point and reflects the session capability.
  await scope.getByTestId('composer-plus').click();
  const plusMenu = scope.getByTestId('composer-plus-menu');
  await plusMenu.waitFor();
  for (const id of ['plus-attach-files', 'plus-quick-messages', 'plus-slash-commands', 'plus-live-feedback']) await scope.getByTestId(id).waitFor();
  assert.equal(await scope.getByTestId('plus-live-feedback').isDisabled(), true, 'Codex does not offer live feedback notes');
  report.consistency.push({ label: 'plus menu', ...(await checkControlConsistency(page, `[data-testid="session-chat-${chat.id}"] .chat-plus-menu`)) });
  assertNoControlViolations(report.consistency.at(-1), 'plus menu');
  await shot('plus-menu.png');
  await scope.getByTestId('plus-slash-commands').click();
  await scope.locator('.chat-slash').waitFor();
  assert.ok((await scope.locator('.chat-slash').innerText()).length > 0, 'Slash commands opens the existing slash panel');
  check('the real app opens the + menu and its Slash commands entry shows the existing slash panel');

  // A quick message inserts at the caret, after existing text.
  await composer.click();
  await composer.fill('hello ');
  await scope.getByTestId('composer-plus').click();
  await scope.getByTestId('plus-quick-messages').click();
  await scope.locator('[data-plus-panel="quick"]').waitFor();
  await scope.getByTestId('plus-quick-message').filter({ hasText: 'Run the tests' }).click();
  await until(async () => (await composer.inputValue()) === 'hello Run the full test suite and fix failures.', 'quick message inserted at the caret');
  await until(async () => await composer.evaluate(node => node.selectionStart === node.value.length && document.activeElement === node), 'caret follows the inserted snippet');
  check('a quick message inserts at the caret and the caret follows it');
  await composer.fill('');

  // Attach files: the stubbed native dialog returns a text file and an image.
  await scope.getByTestId('composer-plus').click();
  await scope.getByTestId('plus-attach-files').click();
  await until(async () => (await scope.locator('[data-testid="context-chip"]').allInnerTexts()).some(text => text.includes('notes.txt')), 'file context chip');
  await until(async () => (await scope.locator('.chat-image-draft img').count()) === 1, 'image attachment');
  assert.equal(await scope.locator('[data-testid="context-tray"]').count(), 1, 'the context tray holds the attached file');
  report.consistency.push({ label: 'attach', ...(await checkControlConsistency(page, `[data-testid="session-chat-${chat.id}"] .context-tray`)) });
  await shot('attached-files.png');
  check('attaching through the stubbed dialog adds the text file as a context chip and the image to the image path');

  // Settings -> Controls -> Quick messages: add, edit, reorder, delete.
  await page.locator('.user-row').click();
  await page.locator('.account-menu .menu-item').filter({ hasText: /settings|设置/i }).click();
  const settings = page.locator('.settings-panel'); await settings.waitFor();
  await settings.getByRole('tab', { name: /shortcuts|快捷键/i }).click();
  await until(async () => (await settings.locator('[data-testid="quick-message-row"]').count()) === 2, 'seeded quick messages');
  await settings.getByTestId('quick-message-add').click();
  await settings.getByTestId('quick-message-editor').locator('input').fill('Release notes');
  await settings.getByTestId('quick-message-editor').locator('textarea').fill('Draft the release notes for this change.');
  await settings.getByTestId('quick-message-save').click();
  await until(async () => (await settings.locator('[data-testid="quick-message-row"]').count()) === 3, 'added quick message');
  await settings.getByTestId('quick-message-edit').first().click();
  await settings.getByTestId('quick-message-editor').locator('input').fill('Summarize now');
  await settings.getByTestId('quick-message-save').click();
  await until(async () => (await settings.locator('[data-testid="quick-message-row"] strong').first().innerText()) === 'Summarize now', 'edited quick message');
  await settings.getByTestId('quick-message-down').first().click();
  await until(async () => (await settings.locator('[data-testid="quick-message-row"] strong').first().innerText()) === 'Run the tests', 'reordered quick message');
  await settings.getByTestId('quick-message-delete').first().click();
  await until(async () => (await settings.locator('[data-testid="quick-message-row"]').count()) === 2, 'deleted quick message');
  report.consistency.push({ label: 'settings quick messages', ...(await checkControlConsistency(page, '.settings-panel .quick-messages-list')) });
  assertNoControlViolations(report.consistency.at(-1), 'settings quick messages');
  await shot('settings-quick-messages.png');
  check('Settings add, edit, reorder and delete persist through settings.update');
  const saved = await request('runtime.snapshot');
  assert.equal(Array.isArray(saved.settings.quickMessages) && saved.settings.quickMessages.length, 2, 'the runtime stored the edited list');

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
  try { await page?.screenshot({ path: join(out, 'failure.png') }); } catch { /* keep the original failure */ }
} finally {
  try { await request('runtime.shutdown', { operationId: randomUUID() }); } catch { /* the app may already be gone */ }
  try { await app?.close(); } catch { /* the app may already be gone */ }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
