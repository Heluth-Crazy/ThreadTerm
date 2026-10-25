// Desktop-1 permission recovery acceptance. Only the isolated fake launcher is available.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { connectPeer } from './pipe-client.mjs';
import { electron } from './lib/desktop1.mjs';
import { checkControlConsistency } from './lib/visual-consistency.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });
const args = process.argv.slice(2);
const theme = args.includes('--theme') ? args[args.indexOf('--theme') + 1] : 'light';
assert.ok(['light', 'dark'].includes(theme));
const narrow = args.includes('--narrow');
const qaTemp = process.env.TEMP ?? process.env.TMP ?? tmpdir();
process.env.TEMP = process.env.TMP = qaTemp;
process.env.TT_QA_DESKTOP = '1';
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime));
const scratch = await mkdtemp(join(qaTemp, 'tt-permission-visual-'));
const out = join(root, 'qa/results/permission-recovery', `${theme}-${narrow ? 'narrow' : 'wide'}`);
const bin = join(scratch, 'bin'), workspace = join(scratch, 'workspace'), data = join(scratch, 'data');
const log = join(scratch, 'fake-codex.jsonl');
const database = join(data, 'threadterm-v3.sqlite3');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(path$|codex|claude|kimi|grok|gemini|opencode|openai_|anthropic_|electron_run_as_node$|threadterm_|tt_qa_)/i.test(key)));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  TEMP: qaTemp, TMP: qaTemp, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RELOCATION_QA: '1', CODEX_HOME: join(scratch, 'codex-home'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-permission-visual-${randomUUID()}`,
  THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'plugins'),
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(root, 'qa/fixtures/fake-codex-permission-restore.cjs'),
  TT_QA_PERMISSION_LOG: log, TT_QA_PERMISSION_CWD: workspace,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
const delay = ms => new Promise(done => setTimeout(done, ms));
const report = { passed: false, theme, narrow, scratch, runtime, screenshots: [], checks: [], controls: [], errors: [], focusEvents: [], appClosed: false };
let app, appProcess, page, daemon, peer, sessions;
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chat = session => page.getByTestId(`session-chat-${session.id}`);
const note = text => { report.checks.push(text); console.log(`PASS ${text}`); };
async function until(probe, label, timeout = 35_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
function selections(session) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT data FROM chat_option_selections WHERE session_id=?').get(session.id).data); }
  finally { db.close(); }
}
async function screenshot(name, meaning) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push({ path, meaning });
}
async function seed() {
  daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', bytes => { stderr += bytes; });
  await until(async () => {
    assert.equal(daemon.exitCode, null, `seed runtime exited: ${stderr}`);
    try {
      peer = await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      return true;
    } catch { peer?.close(); peer = undefined; return false; }
  }, 'seed runtime started');
  const initial = await peer.request('runtime.snapshot');
  await peer.request('settings.update', { patch: { language: 'en', theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  await peer.request('plugin.setEnabled', { pluginId: 'permission-qa', enabled: true, operationId: randomUUID() });
  const project = await peer.request('project.add', { path: workspace, name: 'Permission recovery QA', operationId: randomUUID() });
  sessions = [];
  for (const title of ['Saved sandbox recovery', 'Vanished permission recovery', 'Layout warmup']) {
    sessions.push(await peer.request('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title, operationId: randomUUID() }));
  }
  await peer.request('runtime.shutdown', { operationId: randomUUID() });
  peer.close(); peer = undefined;
  await until(() => daemon.exitCode !== null, 'seed runtime exited');
  daemon = undefined;
  const db = new DatabaseSync(database);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const [index, nativeId, provider, saved] of [
      [0, 'qa-permission-restore-mismatch', 'codex', [{ id: 'mode', value: 'never' }, { id: 'sandbox', value: 'danger-full-access' }, { id: 'unrelated', value: 'keep' }]],
      [1, 'qa-permission-acp-reset', 'permission-qa', [{ id: 'vanished-permissions', category: 'mode', value: 'old' }, { id: 'unrelated', value: 'keep' }]],
    ]) {
      const session = sessions[index];
      db.prepare("UPDATE sessions SET native_id=?, provider=?, status='starting' WHERE id=?").run(nativeId, provider, session.id);
      db.prepare('INSERT INTO chat_option_selections(session_id,provider,data) VALUES(?,?,?)').run(session.id, provider, JSON.stringify(saved));
      const createdAt = new Date().toISOString();
      const item = { id: `${session.id}:qa-history`, role: 'user', parts: [{ type: 'text', text: 'Saved transcript remains readable during permission recovery.' }], createdAt };
      db.prepare("INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES(?,?,NULL,'message',?,?)").run(item.id, session.id, JSON.stringify(item), createdAt);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  note('Saved permissions seeded only while the isolated runtime was stopped');
}
async function present(session) {
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
}
async function waitPhase(session, phase) {
  return until(async () => {
    const state = await rpc('chat.connection', { sessionId: session.id });
    return state.phase === phase ? state : false;
  }, `${session.title}: ${phase}`);
}
async function sizeNarrow(session) {
  await chat(session).locator('textarea').click();
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
  await page.getByRole('button', { name: 'Split right', exact: true }).click();
  await page.keyboard.press('Escape');
  await until(async () => await page.locator('[data-pane-id]').count() === 2, 'split created');
  const target = await page.locator('[data-split-id] > .pane-divider').evaluate(node => {
    const box = node.parentElement.getBoundingClientRect(), rect = node.getBoundingClientRect();
    if (!node.parentElement.classList.contains('horizontal')) throw new Error('Expected horizontal split');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, endX: box.left + 400 + (parseFloat(getComputedStyle(node.parentElement).columnGap) || 0) + rect.width / 2 };
  });
  await page.mouse.move(target.x, target.y); await page.mouse.down();
  await page.mouse.move(target.endX, target.y, { steps: 8 }); await page.mouse.up();
  await page.getByRole('tab', { name: session.title, exact: true }).click();
  await until(() => chat(session).evaluate(node => node.getBoundingClientRect().width >= 380 && node.getBoundingClientRect().width <= 420), '400px Chat pane');
}
async function assertRecovery(session, prefix) {
  const state = await waitPhase(session, 'failed');
  assert.equal(state.error?.code, 'chat_permission_restore_failed');
  const pane = chat(session), banner = pane.locator('.chat-reconnect-banner.is-failed');
  const width = await pane.evaluate(node => node.getBoundingClientRect().width);
  if (narrow) assert.ok(width >= 380 && width <= 420, `Narrow pane width: ${width}`);
  await banner.waitFor();
  assert.ok((await banner.innerText()).includes('Saved permissions could not be restored. Choose permissions below, then retry.'));
  const detail = banner.locator('.chat-permission-detail');
  await detail.waitFor();
  const detailText = await detail.innerText();
  if (prefix === '01-saved-sandbox') {
    assert.deepEqual(state.error.permissionRestore && { optionId: state.error.permissionRestore.optionId, savedValue: state.error.permissionRestore.savedValue, reportedValue: state.error.permissionRestore.reportedValue, reason: state.error.permissionRestore.reason },
      { optionId: 'sandbox', savedValue: 'danger-full-access', reportedValue: 'read-only', reason: 'mismatch' });
    assert.equal(detailText, 'Sandbox: saved Full access; Codex reported Read only.');
  } else {
    assert.equal(state.error.permissionRestore?.reason, 'missing');
    assert.equal(detailText, 'Saved setting “vanished-permissions” is no longer offered by Permission QA.');
  }
  assert.ok(detailText.length < 240 && !/[{}]/.test(detailText));
  const detailStyle = await detail.evaluate(node => ({ color: getComputedStyle(node).color, primaryColor: getComputedStyle(node.parentElement).color, width: node.clientWidth, scrollWidth: node.scrollWidth }));
  assert.notEqual(detailStyle.color, detailStyle.primaryColor, 'Specific restore detail uses the muted secondary color');
  assert.ok(detailStyle.width >= detailStyle.scrollWidth, 'Specific restore detail does not overflow the banner');
  report.checks.push(`${prefix}: visible specific reason: ${detailText}`);
  assert.equal(await pane.getByRole('button', { name: 'Retry options', exact: true }).count(), 0);
  assert.equal(await pane.locator('.chat-connect-mask').count(), 0);
  assert.equal(await pane.locator('textarea').isDisabled(), true);
  assert.equal(await pane.locator('.chat-compose-send').first().isDisabled(), true);
  assert.equal(await pane.locator('.chat-compose-leading button').first().isDisabled(), true);
  assert.equal(await pane.locator('.chat-model-chip').count(), 0);
  const options = (await rpc('chat.options', { sessionId: session.id })).options;
  assert.ok(options.some(row => row.id === 'threadterm-permission-recovery'));
  const enabled = await pane.locator('.chat-compose-left button:enabled').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.optionId, trigger: node.dataset.menuTrigger })));
  for (const button of enabled) assert.ok(button.trigger === 'mode' || button.trigger === 'more' || options.some(row => row.category === 'mode' && row.id === button.id));
  assert.ok(enabled.length > 0, 'permission controls are enabled');
  assert.ok(await pane.getByText('Saved transcript remains readable during permission recovery.', { exact: true }).isVisible());
  report.checks.push(`${prefix}: ${await banner.innerText()}`);
  await delay(300);
  await screenshot(`${prefix}-failed`, `Visible restore reason: ${detailText} Transcript readable; permission controls enabled; composer and writes disabled`);
  for (const selector of ['.chat-reconnect-banner', '.chat-compose-bar']) {
    const result = await checkControlConsistency(page, `[data-testid="session-chat-${session.id}"] ${selector}`, { checkStates: true });
    report.controls.push({ scenario: prefix, selector, ...result });
    assert.ok(!result.error && result.checked > 0, JSON.stringify(result));
    assert.deepEqual(result.violations, [], JSON.stringify(result.violations));
  }
  note(`${prefix}: recovery fences and banner/picker consistency pass`);
}
async function pick(session, id, value, screenshotName) {
  const pane = chat(session);
  const options = (await rpc('chat.options', { sessionId: session.id })).options;
  const option = options.find(row => row.id === id);
  assert.ok(option?.choices.some(row => row.value === value));
  let trigger = pane.locator(`[data-menu-trigger="${id}"]`);
  if (!await trigger.count() && id === options.find(row => row.category === 'mode')?.id) trigger = pane.locator('[data-menu-trigger="mode"]');
  if (await trigger.count()) await trigger.click();
  else await pane.getByRole('button', { name: 'More settings', exact: true }).click();
  const name = value === 'read-only' ? 'Read only' : option.choices.find(row => row.value === value).name;
  const choice = pane.getByRole('menuitemradio', { name, exact: true });
  await choice.waitFor(); assert.equal(await choice.isEnabled(), true);
  await screenshot(screenshotName, `Enabled permission choice: ${name}`);
  await choice.click();
  await until(async () => (await rpc('chat.options', { sessionId: session.id })).options.find(row => row.id === id)?.value === value, 'permission choice staged');
}

try {
  await Promise.all([bin, workspace, data, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME, out, join(scratch, 'plugins/permission-qa')].map(path => mkdir(path, { recursive: true })));
  await writeFile(log, '');
  await writeFile(join(workspace, 'README.md'), 'Isolated fake-provider permission recovery QA.\n');
  const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
  await writeFile(join(bin, 'shim.rs'), shim);
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  await writeFile(join(scratch, 'plugins/permission-qa/threadterm-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'permission-qa', name: 'Permission QA', version: '1.0.0', publisher: 'QA', contributes: { agents: [{ id: 'permission-qa', name: 'Permission QA', command: 'codex', args: ['--qa-acp'], versionArgs: ['--version'], chat: { protocol: 'acp', args: [] } }] } }));
  await seed();
  env.THREADTERM_V3_PIPE = `\\\\.\\pipe\\tt-permission-visual-${randomUUID()}`;
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  appProcess = app.process();
  report.electronPid = appProcess.pid;
  appProcess.stderr.on('data', bytes => { const text = bytes.toString(); if (text.includes('[desktop1]')) report.errors.push(text); });
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    globalThis.__permissionFocusEvents = [];
    electronApp.on('browser-window-focus', (_event, window) => globalThis.__permissionFocusEvents.push({ at: Date.now(), id: window.id }));
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isFocused()) globalThis.__permissionFocusEvents.push({ at: Date.now(), id: window.id, initiallyFocused: true });
    if (window) { window.setContentSize(1440, 900); window.webContents.setBackgroundThrottling(false); }
  });
  page = await app.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  note('Boot splash detached before the first click; notifications disabled in the seeded profile');
  if (narrow) { await present(sessions[2]); await waitPhase(sessions[2], 'ready'); await until(() => chat(sessions[2]).locator('textarea').isEnabled(), 'warmup composer'); await sizeNarrow(sessions[2]); }
  const [change, reset] = sessions;
  await present(change);
  await assertRecovery(change, '01-saved-sandbox');
  const original = selections(change);
  await pick(change, 'sandbox', 'read-only', '02-valid-permission-picker');
  assert.deepEqual(selections(change), original, 'staging must not overwrite the durable selection');
  assert.equal(await chat(change).locator('textarea').isDisabled(), true);
  await screenshot('03-choice-staged', 'Read-only permission staged; writes remain disabled until Retry confirms it');
  await chat(change).getByRole('button', { name: 'Retry connection', exact: true }).click();
  await waitPhase(change, 'ready');
  await until(() => chat(change).locator('textarea').isEnabled(), 'recovered composer enabled');
  assert.equal(selections(change).find(row => row.id === 'sandbox')?.value, 'read-only');
  assert.equal(selections(change).find(row => row.id === 'unrelated')?.value, 'keep');
  await screenshot('04-valid-permission-ready', 'Retry confirmed read-only, enabled the composer, and saved the new choice');
  note('Valid replacement connects and saves only after provider confirmation');
  await present(reset);
  await assertRecovery(reset, '05-vanished-option');
  const old = selections(reset);
  await pick(reset, 'threadterm-permission-recovery', 'defaults', '06-discard-defaults-picker');
  assert.deepEqual(selections(reset), old, 'reset is staged until confirmed');
  await chat(reset).getByRole('button', { name: 'Retry connection', exact: true }).click();
  await waitPhase(reset, 'ready');
  await until(() => chat(reset).locator('textarea').isEnabled(), 'default composer enabled');
  const saved = selections(reset);
  assert.ok(!saved.some(row => row.id === 'vanished-permissions'));
  assert.equal(saved.find(row => row.id === 'current-permissions')?.value, 'default');
  assert.equal(saved.find(row => row.id === 'unrelated')?.value, 'keep');
  await screenshot('07-provider-defaults-ready', 'Vanished permission discarded; provider default confirmed and unrelated setting retained');
  note('Discard connects with provider defaults, removes the vanished permission ID, and preserves unrelated IDs');
  const rows = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.method === 'thread/resume' && row.params.sandbox === 'danger-full-access'));
  assert.ok(rows.some(row => row.method === 'thread/resume' && row.params.sandbox === 'read-only'));
  assert.ok(rows.some(row => row.protocol === 'acp' && row.method === 'session/load' && row.params.sessionId === 'qa-permission-acp-reset'));
  report.fixtureRequests = rows.filter(row => row.direction === 'in').map(row => ({ protocol: row.protocol, pid: row.pid, method: row.method, sandbox: row.params?.sandbox, configId: row.params?.configId, value: row.params?.value, threadId: row.params?.threadId }));
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  if (page && !page.isClosed()) await screenshot('harness-failure', 'Harness stopped at the recorded assertion or error').catch(() => {});
} finally {
  peer?.close();
  if (daemon?.exitCode === null) { daemon.kill(); await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 'seed runtime stopped').catch(error => report.errors.push(error.message)); }
  if (app) {
    report.focusEvents = await app.evaluate(() => globalThis.__permissionFocusEvents ?? []).catch(() => []);
    if (page && !page.isClosed()) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    report.appClosed = appProcess.exitCode !== null || appProcess.signalCode !== null;
  }
  if (report.focusEvents.length || report.errors.length || !report.appClosed) report.passed = false;
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, appClosed: report.appClosed, focusEvents: report.focusEvents, report: join(out, 'report.json'), errors: report.errors }));
  if (!report.passed) process.exitCode = 1;
  await cleanupApp();
}
