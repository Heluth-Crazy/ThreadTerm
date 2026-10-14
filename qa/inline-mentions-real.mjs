// Desktop-1 real-app acceptance QA for inline @mentions (M2). It builds and
// starts the production app on an isolated profile/data/pipe with two fake ACP
// plugins only. It never starts a real agent CLI, never calls focus(), and
// never touches the user's profile.
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
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixtures = join(root, 'qa/fixtures');
const plugins = ['context-tray-echo-acp', 'chat-tools-echo-acp'];
const out = join(root, 'qa/results/inline-mentions');
const scratch = await mkdtemp(join(tmpdir(), 'tt-inline-mentions-'));
const appDir = process.env.TT_INLINE_QA_APP ? resolve(process.env.TT_INLINE_QA_APP) : join(scratch, 'app');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page; let cdp; let chat; let other;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chatScope = id => page.locator(`[data-testid="session-chat-${id}"]`);
const composer = id => chatScope(id).locator('.chat-compose-shell textarea');
const popup = id => chatScope(id).locator('.chat-mentions');
const tray = id => chatScope(id).locator('[data-testid="context-tray"]');
const readout = id => chatScope(id).locator('[data-testid="context-tray"] .context-budget');
const sendButton = id => chatScope(id).locator('.chat-compose-send[aria-label="Send"]');
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }

async function buildApp() {
  if (process.env.TT_INLINE_QA_APP && existsSync(join(process.env.TT_INLINE_QA_APP, 'main.cjs'))) return;
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-inline-mentions-qa', version: '0.1.0', main: 'main.cjs' }));
}
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function enablePlugin(pluginId, providerId) {
  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === pluginId), `${pluginId} discovered`);
  await request('plugin.setEnabled', { pluginId, enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === providerId && row.chat), `${providerId} chat enabled`);
}
async function openPopup(id, query = '') { await composer(id).click(); await page.keyboard.type(`@${query}`); await popup(id).waitFor(); }
async function closePopup(id) { await composer(id).fill(''); await popup(id).waitFor({ state: 'detached' }); }
async function pickQuery(id, query, group, key = 'Enter') {
  await composer(id).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(`@${query}`);
  await popup(id).waitFor();
  await until(async () => (await popup(id).locator(`[data-testid="mention-option"][data-mention-group="${group}"]`).count()) > 0, `${group} row for ${query}`);
  await page.keyboard.press(key);
}
/** Picks at the current caret without clearing the draft. */
async function pickAtCaret(id, query, group, key = 'Enter') {
  await composer(id).focus();
  await page.keyboard.type(`@${query}`);
  await popup(id).waitFor();
  await until(async () => (await popup(id).locator(`[data-testid="mention-option"][data-mention-group="${group}"]`).count()) > 0, `${group} row for ${query}`);
  await page.keyboard.press(key);
  await delay(150);
}
async function userTexts(sessionId) {
  const snapshot = await request('chat.snapshot', { sessionId });
  return snapshot.items.filter(item => item.role === 'user').flatMap(item => (item.parts || []).filter(part => part.type === 'text').map(part => part.text || ''));
}
async function sentUserText(sessionId, needle) {
  return until(async () => (await userTexts(sessionId)).find(text => text.includes(needle)), `user text containing ${needle}`);
}
async function sendAndWait(id, needle) {
  await composer(id).click();
  await page.keyboard.press('Enter');
  return sentUserText(id, needle);
}
async function waitIdle(id) { await until(async () => !(await chatScope(id).locator('.chat-compose-send.is-stop').count()), 'turn finished'); }
async function setCaret(id, position) { await composer(id).evaluate((node, value) => { node.focus(); node.setSelectionRange(value, value); }, position); await delay(80); }
/** Reloads the renderer so the composer/tray reload from the runtime draft and localStorage. */
async function reloadApp() {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }).catch(() => undefined);
  await until(() => composer(chat.id).isEnabled(), 'composer ready after reload');
  cdp = await page.context().newCDPSession(page);
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  for (const plugin of plugins) assert.ok(existsSync(join(fixtures, plugin, 'threadterm-plugin.json')), `missing ${plugin} fixture`);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await buildApp();
  const pluginDir = join(scratch, 'plugins'); for (const plugin of plugins) cpSync(join(fixtures, plugin), join(pluginDir, plugin), { recursive: true });
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-inline-mentions-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: pluginDir });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor(); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  cdp = await page.context().newCDPSession(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  for (const [pluginId, providerId] of [['context-tray-echo-acp', 'context-tray-echo'], ['chat-tools-echo-acp', 'chat-tools-echo']]) await enablePlugin(pluginId, providerId);

  // A workspace with two colliding README-less index.ts files plus cart/checkout.
  const work = join(scratch, 'repo'); await mkdir(join(work, 'src'), { recursive: true }); await mkdir(join(work, 'a'), { recursive: true }); await mkdir(join(work, 'b'), { recursive: true }); await mkdir(join(work, 'c'), { recursive: true });
  await writeFile(join(work, 'src/cart.ts'), 'export const cart = 1;\n'); await writeFile(join(work, 'src/checkout.ts'), 'export const checkout = 1;\n');
  await writeFile(join(work, 'a/index.ts'), 'export const a = 1;\n'); await writeFile(join(work, 'b/index.ts'), 'export const b = 1;\n'); await writeFile(join(work, 'c/index.ts'), 'export const c = 1;\n');
  await writeFile(join(work, 'README.md'), '# Inline mentions QA\n');
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'Initial workspace');
  const project = await request('project.add', { path: work, name: 'Inline Mentions QA', operationId: randomUUID() });
  chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Inline Echo', provider: 'context-tray-echo', mode: 'chat', operationId: randomUUID() });
  other = await request('session.create', { projectId: project.id, cwd: work, title: 'Other chat', provider: 'chat-tools-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => composer(chat.id).isEnabled(), 'chat composer ready');
  const ws = work;

  // 1. Type @query, pick a file, insertion leaves a token (no tray chip).
  await composer(chat.id).click();
  await page.keyboard.type('Please check @car');
  await popup(chat.id).waitFor();
  await until(async () => (await popup(chat.id).locator('[data-testid="mention-option"][data-mention-group="files"]').count()) === 1, 'cart.ts row');
  await page.keyboard.press('Enter');
  await until(async () => (await composer(chat.id).inputValue()) === 'Please check @cart.ts ', 'token inserted');
  assert.equal(await tray(chat.id).getByTestId('context-chip').count(), 0, 'no tray chip for a mention');
  assert.match(await readout(chat.id).innerText(), /1\/12/, 'usage readout counts the mention');
  const caret = await composer(chat.id).evaluate(node => node.selectionStart);
  assert.equal(caret, 'Please check @cart.ts '.length, 'caret after the trailing space');
  await shot('01-pick-token.png');
  check('picking a file keeps the token in the sentence, adds no chip, and shows 1/12');

  // 2. Undo/redo keep React state and the DOM in lockstep.
  await page.keyboard.press('Control+z');
  await until(async () => (await composer(chat.id).inputValue()) === 'Please check @car', 'Ctrl+Z restores the query');
  await page.keyboard.press('Control+y');
  await until(async () => (await composer(chat.id).inputValue()) === 'Please check @cart.ts ', 'Ctrl+Y re-applies the token');
  await page.keyboard.press('Control+z');
  await until(async () => (await composer(chat.id).inputValue()) === 'Please check @car', 'undo again');
  await page.keyboard.press('Control+Shift+z');
  await until(async () => (await composer(chat.id).inputValue()) === 'Please check @cart.ts ', 'Ctrl+Shift+Z re-applies the token');
  check('undo and redo restore the query and re-apply the token');

  // 3. Backspace removes the whole token; undo makes it active again (send proves it).
  await setCaret(chat.id, 'Please check @cart.ts'.length);
  await page.keyboard.press('Backspace');
  await until(async () => (await composer(chat.id).inputValue()).trim() === 'Please check', 'Backspace removes the whole token');
  await page.keyboard.press('Control+z');
  await until(async () => (await composer(chat.id).inputValue()) === 'Please check @cart.ts ', 'undo restores the token');
  check('Backspace deletes the whole token and undo restores it');

  // 6. Send the mention and inspect the serialized envelope.
  const sent = await sendAndWait(chat.id, 'Please check @cart.ts');
  assert.match(sent, /\[ThreadTerm context 1\/1\] File: src\/cart\.ts/);
  assert.match(sent, /\[ThreadTerm message; mentions v1 \{"@cart\.ts":1\}\]\nPlease check @cart\.ts$/);
  await until(async () => (await composer(chat.id).inputValue()) === '', 'composer cleared after send');
  assert.equal(await tray(chat.id).getByTestId('context-chip').count(), 0, 'no live token after send');
  await waitIdle(chat.id);
  await shot('02-sent-envelope.png');
  check('the provider receives the mention map, the item header, and the token in place');

  // 7. Three colliding index.ts files get distinct tokens (relative path fallback).
  await pickQuery(chat.id, 'index', 'files');
  await until(async () => /@index\.ts /.test(await composer(chat.id).inputValue()), 'first index.ts token');
  await composer(chat.id).focus(); await page.keyboard.press('End'); await page.keyboard.type(' plus @index');
  await popup(chat.id).waitFor();
  await until(async () => (await popup(chat.id).locator('[data-testid="mention-option"][data-mention-group="files"]').count()) >= 2, 'two index.ts rows');
  const secondRow = popup(chat.id).locator('[data-testid="mention-option"][data-mention-group="files"]').nth(1);
  await secondRow.click();
  const twoTokens = await composer(chat.id).inputValue();
  const tokens = twoTokens.match(/@[^\s]+/g) || [];
  assert.equal(tokens.length, 2, `two tokens: ${twoTokens}`);
  assert.notEqual(tokens[0], tokens[1], 'the second index.ts uses a distinct token');
  assert.ok(tokens.some(token => /index\.ts$/.test(token) && token.includes('/')), `one token is a relative path: ${twoTokens}`);
  await composer(chat.id).fill('');
  check('colliding index.ts files get base and relative-path tokens');

  // 9. A pick over the 12-identity budget shows the error and leaves @query.
  await composer(chat.id).fill('');
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`threadterm.compose.context.${chat.id}`, JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ kind: 'file', id: `budget-${index}`, path: `budget/f${index}.ts` })))]);
  await reloadApp();
  await until(async () => (await readout(chat.id).innerText()).includes('12/12'), 'twelve tray identities loaded');
  await composer(chat.id).click(); await page.keyboard.type('@car');
  await popup(chat.id).waitFor();
  await until(async () => (await popup(chat.id).locator('[data-testid="mention-option"][data-mention-group="files"]').count()) > 0, 'cart row for over-budget');
  await page.keyboard.press('Enter');
  await until(async () => /Attach at most 12 context items/.test(await chatScope(chat.id).innerText()), 'budget error shown');
  assert.equal(await composer(chat.id).inputValue(), '@car', 'the rejected pick leaves @query in the text');
  await composer(chat.id).fill('');
  check('a pick over the identity budget shows the error and leaves @query');

  // 8. A tray file is one block when mentioned; deleting the token keeps its chip.
  await page.evaluate(([key]) => localStorage.setItem(key, JSON.stringify([{ kind: 'file', id: 'attach-cart', path: 'src/cart.ts' }])), [`threadterm.compose.context.${chat.id}`]);
  await reloadApp();
  await until(async () => (await tray(chat.id).getByTestId('context-chip').count()) === 1, 'tray chip present');
  await pickQuery(chat.id, 'cart', 'files');
  await until(async () => /@cart\.ts /.test(await composer(chat.id).inputValue()), 'token for the attached file');
  assert.equal(await tray(chat.id).getByTestId('context-chip').count(), 1, 'mention does not duplicate the chip');
  await setCaret(chat.id, '@cart.ts'.length);
  await page.keyboard.press('Backspace');
  await until(async () => (await composer(chat.id).inputValue()).trim() === '', 'token deleted');
  assert.equal(await tray(chat.id).getByTestId('context-chip').count(), 1, 'chip stays after the token is deleted');
  await composer(chat.id).fill('');
  check('an already-attached file stays one block and its chip survives token deletion');
  const leftoverChip = tray(chat.id).getByTestId('context-chip-remove').first();
  if (await leftoverChip.count()) await leftoverChip.click();
  await until(async () => (await tray(chat.id).count()) === 0, 'tray cleared before the queue scenario');

  // 11. Queue two mentions, edit one out, and keep the accepted envelope.
  await composer(chat.id).click();
  await page.keyboard.type('slow:8000 hold');
  await page.keyboard.press('Enter');
  await until(async () => (await chatScope(chat.id).locator('.chat-compose-send.is-stop').count()) === 1, 'slow turn started');
  await composer(chat.id).click();
  await page.keyboard.type('review ');
  await pickAtCaret(chat.id, 'cart', 'files');
  await composer(chat.id).focus();
  await page.keyboard.type(' and ');
  await pickAtCaret(chat.id, 'checkout', 'files');
  const queuedText = await composer(chat.id).inputValue();
  assert.match(queuedText, /review @cart\.ts\s+and @checkout\.ts/);
  await composer(chat.id).click(); await page.keyboard.press('Enter');
  await until(async () => (await page.locator('[data-testid="chat-queue-item"]').count()) === 1, 'queued item present');
  await page.locator('[data-testid="chat-queue-item"] .btn-subtle', { hasText: 'Edit' }).click();
  const queueField = page.locator('[data-testid="chat-queue-item"] textarea');
  await queueField.waitFor(); await queueField.fill('review @cart.ts only');
  await page.locator('[data-testid="chat-queue-item"] .btn-subtle', { hasText: 'Save' }).click();
  await until(async () => (await chatScope(chat.id).locator('.chat-compose-send.is-stop').count()) === 0, 'slow turn finished and queue drained', 30_000);
  const queuedEnvelope = await sentUserText(chat.id, 'review @cart.ts only');
  assert.match(queuedEnvelope, /\[ThreadTerm context 1\/2\] File: src\/cart\.ts/);
  assert.match(queuedEnvelope, /\[ThreadTerm context 2\/2\] File: src\/checkout\.ts/);
  assert.match(queuedEnvelope, /\[ThreadTerm message; mentions v1 \{"@cart\.ts":1,"@checkout\.ts":2\}\]/);
  await shot('03-queue-envelope.png');
  check('a queue edit keeps both accepted blocks and the mentions line, changing only the text');

  // 5. Restore: switch away and back; the runtime v2 draft restores text + mentions.
  await composer(chat.id).fill('');
  await pickQuery(chat.id, 'cart', 'files');
  await until(async () => (await composer(chat.id).inputValue()).startsWith('@cart.ts'), 'draft has a live token');
  await delay(700);
  await reloadApp();
  await until(async () => (await composer(chat.id).inputValue()).startsWith('@cart.ts'), 'runtime draft restored');
  await until(async () => (await readout(chat.id).innerText()).includes('1/12'), 'restored mention is active');
  // A differing local recovery pair surfaces the banner; Recover text swaps both parts.
  await page.evaluate(([key]) => localStorage.setItem(key, JSON.stringify({ v: 2, text: 'local draft', mentions: [] })), [`threadterm.compose.${chat.id}`]);
  await reloadApp();
  await page.getByText('An unsaved draft is available on this device.').waitFor();
  await shot('04-recovery-banner.png');
  await page.getByRole('button', { name: 'Recover text' }).click();
  await until(async () => (await composer(chat.id).inputValue()) === 'local draft', 'Recover text swaps in the local text');
  assert.equal(await readout(chat.id).count(), 0, 'the local pair had no mentions');
  // Keep saved draft keeps the runtime pair.
  await composer(chat.id).fill('');
  await pickQuery(chat.id, 'cart', 'files');
  await delay(700);
  await page.evaluate(([key]) => localStorage.setItem(key, JSON.stringify({ v: 2, text: 'other local', mentions: [] })), [`threadterm.compose.${chat.id}`]);
  await reloadApp();
  await page.getByText('An unsaved draft is available on this device.').waitFor();
  await page.getByRole('button', { name: 'Keep saved draft' }).click();
  await until(async () => (await composer(chat.id).inputValue()).startsWith('@cart.ts'), 'Keep saved draft keeps the runtime pair');
  await composer(chat.id).fill('');
  check('the runtime v2 draft restores text+mentions and the recovery banner honors both choices');

  // 4. IME composition through CDP. Directly before, after and inside a token.
  await composer(chat.id).fill('');
  await pickQuery(chat.id, 'cart', 'files');
  await until(async () => (await composer(chat.id).inputValue()).startsWith('@cart.ts'), 'token for IME');
  await composer(chat.id).click();
  await page.keyboard.press('End');
  const beforeImeUsers = (await userTexts(chat.id)).length;
  await cdp.send('Input.insertText', { text: '你好' });
  await until(async () => (await composer(chat.id).inputValue()).includes('你好'), 'IME text committed after the token');
  const afterIme = await composer(chat.id).inputValue();
  assert.ok(afterIme.startsWith('@cart.ts '), `token intact after CJK insertion: ${afterIme}`);
  await until(async () => (await readout(chat.id).innerText()).includes('1/12'), 'CJK text after the token keeps the mention active');
  // Composition directly before the token (CJK adjacency also keeps it active).
  await composer(chat.id).fill('');
  await pickQuery(chat.id, 'cart', 'files');
  await setCaret(chat.id, 0);
  await cdp.send('Input.insertText', { text: '请看' });
  await until(async () => (await composer(chat.id).inputValue()).startsWith('请看@cart.ts'), 'CJK text inserted directly before the token');
  await until(async () => (await readout(chat.id).innerText()).includes('1/12'), 'CJK text before the token keeps the mention active');
  // A session switch during composition is a no-op with a consistent state.
  await page.evaluate(id => { document.querySelector(`#chat-message-${id}`).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); }, chat.id);
  await request('session.present', { sessionId: other.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => composer(chat.id).isEnabled(), 'composer ready after switching during composition');
  assert.equal(await composer(chat.id).inputValue(), '请看@cart.ts ', 'state stays consistent after switching during composition');
  await page.evaluate(id => { document.querySelector(`#chat-message-${id}`).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); }, chat.id);
  // Composition directly inside the token breaks the mention (still no exception).
  await composer(chat.id).fill('');
  await pickQuery(chat.id, 'cart', 'files');
  await setCaret(chat.id, 1);
  await page.evaluate(() => { const area = document.activeElement; area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); area.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ni' })); });
  await page.keyboard.type('ni');
  await page.evaluate(() => { const area = document.activeElement; area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ni' })); });
  await until(async () => /@nicart\.ts/.test(await composer(chat.id).inputValue()), 'composition inside the token edits it');
  await composer(chat.id).fill('');
  // Enter during composition never sends.
  await composer(chat.id).click();
  await page.evaluate(id => { const area = document.querySelector(`#chat-message-${id}`); area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })); }, chat.id);
  await delay(250);
  assert.equal((await userTexts(chat.id)).length, beforeImeUsers, 'Enter during composition does not send');
  await page.evaluate(id => { document.querySelector(`#chat-message-${id}`).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); }, chat.id);
  await composer(chat.id).fill('');
  check('CDP/CJK composition keeps the token active and composing Enter never sends');

  // Visual consistency on the mention-only tray row and the composer.
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await composer(chat.id).fill('');
  await pickQuery(chat.id, 'cart', 'files');
  await until(() => readout(chat.id).isVisible(), 'readout visible for consistency check');
  assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${chat.id}"]`), 'composer with a mention');
  await shot('05-mention-tray.png');
  check('the mention-only tray row and composer keep zero control-consistency violations');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  report.completedAt = new Date().toISOString(); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'INLINE MENTIONS REAL-APP QA PASSED' : `INLINE MENTIONS REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
