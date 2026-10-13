// Real-app acceptance QA for context attachments. Do not run this script while
// developing: it launches Desktop 1 and only the isolated Echo ACP fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/context-tray-echo-acp');
const out = join(root, 'qa/results/context-tray');
const scratch = await mkdtemp(join(tmpdir(), 'tt-context-tray-'));
const appDir = join(scratch, 'app');
const report = { passed: false, scratch, checks: [], screenshots: [], errors: [] };
let app, page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const composer = id => page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
const rail = name => page.locator('.wb-switcher').getByRole('button', { name, exact: true });
async function openView(name) { if (await rail(name).getAttribute('aria-pressed') !== 'true') await rail(name).click(); }
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { try { const value = await probe(); if (value) return value; } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-context-tray-qa', version: '0.1.0', main: 'main.cjs' })); }
async function enableFixture() { await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'context-tray-echo-acp'), 'Context tray Echo discovered'); await request('plugin.setEnabled', { pluginId: 'context-tray-echo-acp', enabled: true, operationId: randomUUID() }); await until(async () => (await request('provider.list')).some(row => row.id === 'context-tray-echo' && row.chat), 'Context tray Echo enabled'); }
async function attachFrom(action, expected) {
  await action.click();
  const dialog = page.getByRole('dialog', { name: 'Send to agent' }); await dialog.waitFor();
  // The app's Select is a custom combobox + listbox, not a native <select>.
  const receiver = dialog.getByRole('combobox', { name: 'Send to session' });
  if (!(await receiver.innerText()).includes('Context Echo')) { await receiver.click(); await page.getByRole('listbox').getByRole('option', { name: /Context Echo/ }).click(); }
  await dialog.getByRole('button', { name: 'Add context' }).click();
  await until(expected, 'context attachment appears');
}
async function inputTerminal(sessionId, data) {
  const lease = await request('session.claim', { sessionId, clientId: 'context-tray-qa' });
  // Same principal as the window: this is the terminal view's own lease (same epoch), so never release it here — that
  // would revoke the view's control mid-test.
  await request('terminal.input', { sessionId, data, leaseEpoch: lease.leaseEpoch });
}
async function selectTerminalLines(first, last) {
  // Exact rows ("context line 1" must not match line 10-12); Shift forces xterm's own selection even when the
  // console host has mouse reporting on.
  const row = text => page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) }).last();
  const start = row(first), end = row(last);
  await start.waitFor(); await end.waitFor();
  const [a, b] = await Promise.all([start.boundingBox(), end.boundingBox()]);
  assert.ok(a && b, 'printed xterm rows must have visible bounds for selection');
  // A synthetic drag (or Shift+click extension) does not select in the unfocused Desktop 1 window; xterm's
  // triple-click line selection does, and gives the same terminal selection path a user's drag would.
  await page.mouse.click(a.x + 30, a.y + a.height / 2, { clickCount: 3 });
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing Context tray Echo fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await buildApp();
  const plugins = join(scratch, 'plugins'); cpSync(fixture, join(plugins, 'context-tray-echo-acp'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(path => /\\cmd\\git\.exe$/i.test(path)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  assert.ok(gitExe, 'git was not found');
  Object.assign(env, { PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-context-tray-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_ECHO_STORE_DIR: join(scratch, 'echo-store') });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(`page: ${error.message}`)); page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor(); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 }); // the launch screen covers the shell until it has faded out await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() }); await enableFixture();
  const work = join(scratch, 'repo'); await mkdir(join(work, 'src'), { recursive: true }); await writeFile(join(work, 'src/cart.ts'), 'export const cart = 1;\n'); git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'initial'); await writeFile(join(work, 'src/cart.ts'), 'export const cart = 2;\n');
  const project = await request('project.add', { path: work, name: 'Context tray QA', operationId: randomUUID() });
  const shell = await request('session.create', { projectId: project.id, cwd: work, title: 'Context shell', provider: 'shell', mode: 'terminal', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Context Echo', provider: 'context-tray-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: shell.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.xterm-helper-textarea').waitFor(); await inputTerminal(shell.id, 'for /L %i in (1,1,12) do @echo context line %i\r'); // the shell provider runs cmd.exe
  await until(async () => (await page.locator('.xterm-rows').innerText()).includes('context line 12'), 'numbered terminal output');
  await selectTerminalLines('context line 1', 'context line 12');
  await page.getByTestId('terminal-selection-send-to-agent').waitFor(); await attachFrom(page.getByTestId('terminal-selection-send-to-agent'), async () => true);
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await until(() => composer(chat.id).isEnabled(), 'chat composer ready');
  const tray = page.getByTestId('context-tray'); await until(() => tray.getByTestId('context-chip').count(), 'terminal context chip');
  await request('session.present', { sessionId: shell.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await openView('Files'); await page.locator('.wb-tree-row[data-path="src"]').click(); await page.locator('.wb-tree-row[data-path="src/cart.ts"]').click();
  const editor = page.locator('.pane-tab-surface:visible .cm-content'); await editor.waitFor(); await editor.click(); await page.keyboard.press('Control+a');
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await openView('Files'); await page.locator('.wb-tree-row[data-path="src/cart.ts"]').click(); const chatEditor = page.locator('.pane-tab-surface:visible .cm-content'); await chatEditor.waitFor(); await chatEditor.click(); await page.keyboard.press('Control+a'); await page.getByRole('button', { name: 'Send to agent', exact: true }).first().click(); await until(async () => (await tray.getByTestId('context-chip').count()) >= 2, 'file context chip'); await request('session.present', { sessionId: shell.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  // With the shell as the target, the same editor shortcut retains the existing
  // inline-insertion behavior and must not create another Chat tray item.
  const beforeInline = await tray.getByTestId('context-chip').count(); await editor.click(); await page.keyboard.press('Control+L');
  await until(async () => (await page.locator('.xterm-rows').innerText()).includes('src/cart.ts:'), 'file reference inserted into terminal input'); assert.equal(await tray.getByTestId('context-chip').count(), beforeInline);
  await openView('Source Control'); await page.locator('.wb-change-open', { hasText: 'cart.ts' }).first().click(); await page.getByTestId('source-control-send-diff').waitFor();
  await attachFrom(page.getByTestId('source-control-send-diff'), async () => true); await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await until(async () => (await tray.getByTestId('context-chip').count()) >= 3, 'diff context chip'); await request('session.present', { sessionId: shell.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await openView('Files'); await page.locator('.wb-tree-row[data-path="src/cart.ts"]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'File history', exact: true }).click(); await page.locator('.wb-commit-row').first().click(); await page.getByTestId('history-send-to-agent').waitFor(); await attachFrom(page.getByTestId('history-send-to-agent'), async () => true); await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await until(async () => (await tray.getByTestId('context-chip').count()) >= 4, 'commit context chip'); await shot('01-tray-chips.png');
  await tray.getByTestId('context-chip').first().click(); const preview = page.getByTestId('context-preview'); await preview.waitFor(); assert.match(await preview.innerText(), /^\[ThreadTerm context 1\//); await shot('02-preview.png'); await page.keyboard.press('Escape'); await tray.getByTestId('context-chip-remove').first().click(); await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await until(async () => (await tray.getByTestId('context-chip').count()) >= 3, 'persisted tray after reload'); await tray.getByTestId('context-chip').first().click(); await preview.waitFor(); const previewText = await preview.innerText(); await page.keyboard.press('Escape');
  await composer(chat.id).fill('user text comes last'); await page.locator('.chat-compose-send[aria-label="Send"]').click(); const snapshot = await until(async () => { const items = await request('chat.snapshot', { sessionId: chat.id }); const user = items.items.filter(item => item.role === 'user').flatMap(item => item.parts || []).find(part => part.type === 'text' && part.text?.endsWith('user text comes last'))?.text; const assistant = items.items.filter(item => item.role === 'assistant').flatMap(item => item.parts || []).find(part => part.type === 'text' && part.text === `Echo: ${user}`); return user && assistant ? { items: items.items, user } : undefined; }, 'full Echo reply'); assert.ok(snapshot.user.startsWith(previewText), 'echo receives the exact preview block first'); assert.ok(snapshot.user.endsWith('user text comes last'), 'user text is serialized last'); await page.getByTestId('context-transcript-row').waitFor(); assert.doesNotMatch(await page.getByTestId('context-transcript-row').locator('xpath=ancestor::*[contains(@class,"chat-message")]').innerText(), /\[ThreadTerm context/); await shot('03-sent-bubble.png');
  // @-mention chip kinds: session, agent and skill render, preview, remove and serialize.
  await page.evaluate(({ id, items }) => { localStorage.setItem(`threadterm.compose.context.${id}`, JSON.stringify(items)); }, { id: chat.id, items: [
    { kind: 'session', id: 'session:ctx', sessionId: shell.id, title: 'Context shell', provider: 'shell' },
    { kind: 'agent', id: 'agent:codex', provider: 'codex' },
    { kind: 'skill', id: 'skill:demo', name: 'demo', invocation: '/skill:demo' },
  ] });
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => (await tray.getByTestId('context-chip').count()) >= 3, 'mention chips after reload');
  const mentionLabels = await tray.getByTestId('context-chip').allInnerTexts();
  assert.ok(mentionLabels.some(label => label.includes('Session · Context shell')), `session chip: ${mentionLabels.join(' | ')}`);
  assert.ok(mentionLabels.some(label => label.includes('Agent · codex')), `agent chip: ${mentionLabels.join(' | ')}`);
  assert.ok(mentionLabels.some(label => label.includes('Skill · demo')), `skill chip: ${mentionLabels.join(' | ')}`);
  await shot('05-mention-chips.png');
  const mentionPreview = page.getByTestId('context-preview');
  for (const [index, pattern] of [
    [0, /\[ThreadTerm context 1\/3\] Session [A-Za-z0-9._:-]+: Context shell \(shell\)\. Call session_info with this id\./],
    [1, /Agent: delegate the following task to codex with delegate_start\./],
    [2, /Skill: demo \(invoke: \/skill:demo\)/],
  ]) {
    await tray.getByTestId('context-chip').nth(index).click(); await mentionPreview.waitFor();
    assert.match(await mentionPreview.innerText(), pattern);
    await page.keyboard.press('Escape');
    await mentionPreview.waitFor({ state: 'detached' });
  }
  await tray.getByTestId('context-chip-remove').last().click();
  await until(async () => (await tray.getByTestId('context-chip').count()) === 2, 'skill chip removed');
  await page.locator('.chat-compose-send[aria-label="Send"]').click();
  const mentionPrompt = await until(async () => { const items = await request('chat.snapshot', { sessionId: chat.id }); return items.items.filter(item => item.role === 'user').flatMap(item => item.parts || []).find(part => part.type === 'text' && part.text?.includes('Call session_info with this id.'))?.text; }, 'mention prompt serialized');
  assert.match(mentionPrompt, /Agent: delegate the following task to codex with delegate_start\./);
  assert.match(mentionPrompt, /\[ThreadTerm message\]/);
  check('session, agent and skill mention chips render, preview, remove and serialize into the prompt');
  await composer(chat.id).fill('slow:10000'); await page.locator('.chat-compose-send[aria-label="Send"]').click(); await page.locator('.chat-compose-send[aria-label="Queue"]').waitFor(); await request('session.present', { sessionId: shell.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await selectTerminalLines('context line 1', 'context line 12'); await attachFrom(page.getByTestId('terminal-selection-send-to-agent'), async () => true); await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await until(() => tray.getByTestId('context-chip').count(), 'queued terminal context'); await composer(chat.id).fill('queued text'); await page.locator('.chat-compose-send[aria-label="Queue"]').click(); await page.getByTestId('chat-queue-context-badge').waitFor(); await shot('04-queue-badge.png'); check('terminal selection, editor selection, Source Control diff, and history commit create Chat chips; terminal receivers retain inline references; preview, transcript, echo ordering, persistence, and contextual queue badge pass');
  assert.deepEqual(report.errors, [], report.errors.join('\n')); report.passed = true;
} catch (error) { report.errors.push(error instanceof Error ? error.stack || error.message : String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); }
finally { if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {}); if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); } report.completedAt = new Date().toISOString(); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {}); console.log(report.passed ? 'CONTEXT TRAY QA PASSED' : `CONTEXT TRAY QA FAILED\n${report.errors.join('\n')}`); process.exitCode = report.passed ? 0 : 1; }
