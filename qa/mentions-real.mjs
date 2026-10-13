// Desktop-1 real-app acceptance QA for Chat `@` mentions. It builds and starts
// the production app on an isolated profile/data/pipe with two fake ACP plugins
// only: a chat provider that echoes the serialized prompt, and a second chat
// provider so the Agents group has a candidate. It never starts a real agent
// CLI, never calls focus(), and never touches the user's profile.
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
const out = join(root, 'qa/results/chat-parity/E3/mentions-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-mentions-real-'));
const appDir = join(scratch, 'app');
const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chatScope = id => page.locator(`[data-testid="session-chat-${id}"]`);
const composer = id => chatScope(id).locator('.chat-compose-shell textarea');
const popup = id => chatScope(id).locator('.chat-mentions');
const tray = id => chatScope(id).locator('[data-testid="context-tray"]');
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-mentions-real-qa', version: '0.1.0', main: 'main.cjs' })); }
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function enablePlugin(pluginId, providerId) {
  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === pluginId), `${pluginId} discovered`);
  await request('plugin.setEnabled', { pluginId, enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === providerId && row.chat), `${providerId} chat enabled`);
}
async function groupIds(id) { return popup(id).locator('.mention-group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label'))); }
async function openPopup(id, query = '') { await composer(id).fill(`@${query}`); await popup(id).waitFor(); }
async function closePopup(id) { await composer(id).fill(''); await popup(id).waitFor({ state: 'detached' }); }
async function pickEnter(id) { await page.keyboard.press('Enter'); }
async function pickQuery(id, query, group, key = 'Enter') { await openPopup(id, query); await until(async () => (await popup(id).locator(`[data-testid="mention-option"][data-mention-group="${group}"]`).count()) > 0, `${group} row for ${query}`); await page.keyboard.press(key); }
// The agent's label words all appear in the other session's provider detail, so
// click its row directly instead of filtering (Sessions would match first).
async function pickAgentRow(id) { await openPopup(id, ''); await until(async () => (await popup(id).locator('[data-testid="mention-option"][data-mention-group="agents"]').count()) > 0, 'agent row'); await popup(id).locator('[data-testid="mention-option"][data-mention-group="agents"]').first().click(); }
async function attachFourChips(id) { await pickQuery(id, 'cart', 'files'); await pickQuery(id, 'Fix', 'commits', 'Tab'); await pickQuery(id, 'Other', 'sessions'); await pickAgentRow(id); await until(async () => (await tray(id).getByTestId('context-chip').count()) === 4, 'four mention chips'); }
async function waitForAllGroups(id) { await until(async () => (await popup(id).locator('.mention-group').count()) === 4, 'all four default groups loaded'); }

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  for (const plugin of plugins) assert.ok(existsSync(join(fixtures, plugin, 'threadterm-plugin.json')), `missing ${plugin} fixture`);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await buildApp();
  const pluginDir = join(scratch, 'plugins'); for (const plugin of plugins) cpSync(join(fixtures, plugin), join(pluginDir, plugin), { recursive: true });
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-mentions-real-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: pluginDir });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`)); page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor(); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  for (const [pluginId, providerId] of [['context-tray-echo-acp', 'context-tray-echo'], ['chat-tools-echo-acp', 'chat-tools-echo']]) await enablePlugin(pluginId, providerId);

  const work = join(scratch, 'repo'); await mkdir(join(work, 'src'), { recursive: true }); await writeFile(join(work, 'src/cart.ts'), 'export const cart = 1;\n'); await writeFile(join(work, 'README.md'), '# Mentions QA\n');
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'Fix cart'); await writeFile(join(work, 'src/cart.ts'), 'export const cart = 2;\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'Add checkout');
  const project = await request('project.add', { path: work, name: 'Mentions QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Mentions Echo', provider: 'context-tray-echo', mode: 'chat', operationId: randomUUID() });
  const other = await request('session.create', { projectId: project.id, cwd: work, title: 'Other chat', provider: 'chat-tools-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => composer(chat.id).isEnabled(), 'chat composer ready');

  // Typing @ opens the popup above the composer; the query filters it and the
  // provider that publishes no skills hides the Skills group.
  await openPopup(chat.id, '');
  await waitForAllGroups(chat.id);
  let labels = await groupIds(chat.id);
  assert.deepEqual(labels, ['Files', 'Sessions', 'Commits', 'Agents'], `default groups: ${labels.join(', ')}`);
  const popupBox = await popup(chat.id).boundingBox(); const composerBox = await composer(chat.id).boundingBox();
  assert.ok(popupBox && composerBox && popupBox.y + popupBox.height <= composerBox.y + 4, 'popup renders above the composer');
  await openPopup(chat.id, 'cart');
  await until(async () => (await popup(chat.id).locator('[data-testid="mention-option"][data-mention-group="files"]').count()) === 1, 'files filtered to cart.ts');
  assert.equal((await groupIds(chat.id)).includes('Skills'), false, 'Skills group hidden for a provider without skills');
  await shot('01-popup-open.png');
  check('typing @ opens the popup above the composer, the query filters it, and Skills is hidden');

  // Escape closes without touching the text.
  await page.keyboard.press('Escape');
  await popup(chat.id).waitFor({ state: 'detached' });
  assert.equal(await composer(chat.id).inputValue(), '@cart', 'Escape leaves the typed query in place');

  // IME: while composing, Enter neither picks nor sends.
  const beforeIme = await request('chat.snapshot', { sessionId: chat.id });
  const beforeImeUsers = beforeIme.items.filter(item => item.role === 'user').length;
  await composer(chat.id).focus();
  await page.evaluate(id => { document.querySelector(`#chat-message-${id}`).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); }, chat.id);
  await page.keyboard.type('@cart');
  await page.evaluate(id => { document.querySelector(`#chat-message-${id}`).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })); }, chat.id);
  await delay(250);
  assert.equal(await tray(chat.id).count(), 0, 'IME Enter does not add a chip');
  assert.equal((await request('chat.snapshot', { sessionId: chat.id })).items.filter(item => item.role === 'user').length, beforeImeUsers, 'IME Enter does not send');
  await page.evaluate(id => { document.querySelector(`#chat-message-${id}`).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); }, chat.id);
  await composer(chat.id).fill('');
  check('arrows/Tab/Enter pick and Escape closes; an open IME never picks or sends');

  // Pick a file, a commit, a session and an agent; each removes the @query and
  // adds the matching tray chip. ArrowDown first proves the active row moves.
  await openPopup(chat.id, '');
  await until(async () => (await popup(chat.id).locator('[data-testid="mention-option"]').count()) >= 2, 'two mention rows');
  const firstActive = await popup(chat.id).locator('[aria-selected="true"]').innerText();
  await page.keyboard.press('ArrowDown');
  await until(async () => (await popup(chat.id).locator('[aria-selected="true"]').innerText()) !== firstActive, 'ArrowDown moves the active row');
  await page.keyboard.press('Escape');
  await attachFourChips(chat.id);
  assert.equal(await composer(chat.id).inputValue(), '', 'every @query is removed from the draft');
  const chipLabels = await tray(chat.id).getByTestId('context-chip').allInnerTexts();
  assert.ok(chipLabels.some(label => label.includes('cart.ts')), `file chip: ${chipLabels.join(' | ')}`);
  assert.ok(chipLabels.some(label => label.includes('Commit')), `commit chip: ${chipLabels.join(' | ')}`);
  assert.ok(chipLabels.some(label => label.includes('Session · Other chat')), `session chip: ${chipLabels.join(' | ')}`);
  assert.ok(chipLabels.some(label => label.includes('Agent · chat-tools-echo')), `agent chip: ${chipLabels.join(' | ')}`);
  await shot('02-tray-chips.png');
  await tray(chat.id).getByTestId('context-chip').first().click(); const preview = page.getByTestId('context-preview'); await preview.waitFor();
  assert.match(await preview.innerText(), /\[ThreadTerm context 1\/4\] File: /);
  await page.keyboard.press('Escape');
  check('file, commit, session and agent picks add the matching tray chips and remove the @query');

  // Sending serializes file, commit, session_info and delegate_start references.
  await composer(chat.id).fill('mentions please'); await chatScope(chat.id).locator('.chat-compose-send[aria-label="Send"]').click();
  const serialized = await until(async () => { const items = await request('chat.snapshot', { sessionId: chat.id }); return items.items.filter(item => item.role === 'user').flatMap(item => item.parts || []).find(part => part.type === 'text' && part.text?.includes('mentions please'))?.text; }, 'mention prompt serialized');
  assert.match(serialized, /File: src\/cart\.ts/);
  assert.match(serialized, /Commit [0-9a-f]+ — (Fix cart|Add checkout)/);
  assert.match(serialized, new RegExp(`Session ${other.id}: Other chat \\(chat-tools-echo\\)\\. Call session_info with this id\\.`));
  assert.match(serialized, /Agent: delegate the following task to chat-tools-echo with delegate_start\./);
  assert.match(serialized, /\[ThreadTerm message\]\nmentions please$/);
  await until(async () => /Echo: \[ThreadTerm context/.test(await chatScope(chat.id).innerText()), 'Echo reply with context');
  check('the fake provider receives file, commit, session_info and delegate_start references');

  // Agents group disappears when the delegation switch is off.
  const beforeOff = await request('runtime.snapshot'); await request('settings.update', { patch: { 'chatTools.delegation': false }, expectedRevision: beforeOff.settings.revision, operationId: randomUUID() });
  await until(async () => (await request('runtime.snapshot')).settings['chatTools.delegation'] === false, 'delegation setting off');
  await openPopup(chat.id, '');
  assert.equal((await groupIds(chat.id)).includes('Agents'), false, 'Agents hidden when delegation is off');
  await closePopup(chat.id);
  const beforeOn = await request('runtime.snapshot'); await request('settings.update', { patch: { 'chatTools.delegation': true }, expectedRevision: beforeOn.settings.revision, operationId: randomUUID() });
  await until(async () => (await request('runtime.snapshot')).settings['chatTools.delegation'] !== false, 'delegation setting on');
  check('the Agents group is hidden when the delegation switch is off');

  // Re-attach the four chips and run the visual matrix: popup and tray at
  // 1280/420 x light/dark/custom x en/zh-CN, zero consistency violations.
  await pickQuery(chat.id, 'cart', 'files');
  await pickQuery(chat.id, 'Fix', 'commits', 'Tab');
  await pickQuery(chat.id, 'Other', 'sessions');
  await pickAgentRow(chat.id);
  await until(async () => (await tray(chat.id).getByTestId('context-chip').count()) === 4, 'four chips for the matrix');
  const surface = chatScope(chat.id);
  for (const theme of ['light', 'dark', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1280, 420]) {
    const snapshot = await request('runtime.snapshot');
    const patch = theme === 'custom' ? { theme: 'dark', themeSelection: 'custom:qa', customThemes: { qa: custom }, language: locale, notifications: { native: false, attention: false, completed: false, sound: false } } : { theme, themeSelection: theme, language: locale, notifications: { native: false, attention: false, completed: false, sound: false } };
    await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    if (theme === 'custom') await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.customTheme === 'true');
    await surface.evaluate((node, size) => { node.style.width = `${size}px`; node.style.maxWidth = `${size}px`; node.style.flex = `0 0 ${size}px`; }, width);
    const actual = await surface.evaluate(node => node.getBoundingClientRect().width);
    assert.ok(width === 420 ? Math.abs(actual - 420) < 3 : actual >= 1100, `surface width ${actual} at ${theme}/${locale}/${width}`);
    await openPopup(chat.id, '');
    await waitForAllGroups(chat.id);
    const labelName = theme === 'custom' ? 'dark' : theme;
    assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${chat.id}"] .chat-mentions`), `mention popup ${theme}/${locale}/${width}`);
    assert.ok(await popup(chat.id).evaluate(node => node.scrollWidth <= node.clientWidth + 1), `popup has no horizontal clipping at ${theme}/${locale}/${width}`);
    await shot(`popup-${theme}-${locale}-${width}.png`);
    await closePopup(chat.id);
    assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${chat.id}"] [data-testid="context-tray"]`), `mention tray ${theme}/${locale}/${width}`);
    assert.ok(await tray(chat.id).evaluate(node => node.scrollWidth <= node.clientWidth + 1), `tray has no horizontal clipping at ${theme}/${locale}/${width}`);
    await shot(`tray-${theme}-${locale}-${width}.png`);
    assert.equal(await popup(chat.id).count(), 0, `popup closed for the tray shot (${labelName})`);
  }
  check('popup and tray matrix at 1280/420 x light/dark/custom x en/zh-CN has no clipping and zero consistency violations');

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
  console.log(report.passed ? 'MENTIONS REAL-APP QA PASSED' : `MENTIONS REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
