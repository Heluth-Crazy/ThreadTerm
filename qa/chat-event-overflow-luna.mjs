// Real isolated Electron/Codex regression for chat event overflow.
// Run after the target-qa runtime is built:
//   node qa/chat-event-overflow-luna.mjs --rebuild
// `--prepare` only verifies the isolated app and discovers a Luna catalog entry;
// it deliberately sends no model turn.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const appDir = join(root, 'runtime/target-qa/chat-overflow-live-app');
const reportDir = join(root, 'qa/results/chat-event-overflow-luna');
const prepareOnly = process.argv.includes('--prepare');
const rebuild = process.argv.includes('--rebuild');
const keep = process.argv.includes('--keep');
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const commandMarker = 'TT_OVERFLOW_QA_COMMAND_COMPLETE';
const firstMarker = 'TT_OVERFLOW_QA_FIRST_TURN_OK';
const secondMarker = 'TT_OVERFLOW_QA_SECOND_TURN_OK';
const oneMiB = 1024 * 1024;

assert.match(runtime.replace(/\\/gu, '/'), /runtime\/target-qa\/debug\/threadterm-v3-runtime\.exe$/iu, 'refusing a non-target-qa runtime');
assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-overflow-luna-'));
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const codexHome = join(scratch, 'codex-home');
const pipe = `\\\\.\\pipe\\threadterm-chat-overflow-luna-${randomUUID()}`;
const report = { passed: false, startedAt: new Date().toISOString(), runtime, appDir, scratch, checks: [], timingsMs: {}, observations: {}, errors: [] };
let app, releaseLock;
let page;

function failureText(error) { return error instanceof Error ? error.stack ?? error.message : String(error); }
function redact(value, key = '') {
  if (/(?:auth|token|secret|account|email|cookie)/iu.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
function check(text) { report.checks.push(text); console.log(`PASS ${text}`); }
async function prepareApp() {
  if (!rebuild && existsSync(join(appDir, 'renderer/index.html'))) return;
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-chat-overflow-luna-qa', version: '0.1.0', main: 'main.cjs' }));
}
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(test, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${failureText(lastError)}` : ''}`);
}
async function activeOptions(sessionId) {
  return until(async () => {
    const ui = await request('chat.options', { sessionId });
    return ui.options?.find(option => option.id === 'model')?.choices?.length ? ui : undefined;
  }, 'Codex option catalog', 90_000);
}
function option(ui, id) {
  const result = ui.options.find(candidate => candidate.id === id);
  assert.ok(result, `missing ${id} option`);
  return result;
}
async function selectThroughChatView(ui, optionId, value) {
  const target = option(ui, optionId);
  const choice = target.choices.find(candidate => candidate.value === value);
  assert.ok(choice, `${optionId} lacks ${value}; choices: ${target.choices.map(candidate => candidate.value).join(', ')}`);
  const menu = optionId === 'mode' ? page.locator('.chat-menu-mode') : page.locator('.chat-menu-model');
  await (optionId === 'mode' ? page.locator('.chat-mode-chip') : page.locator('.chat-model-chip')).click();
  await menu.waitFor({ state: 'visible' });
  const candidates = menu.getByRole('menuitemradio');
  const button = candidates.filter({ hasText: choice.name }).first();
  await button.waitFor({ state: 'visible' });
  await button.click();
  const updated = await until(async () => {
    const next = await request('chat.options', { sessionId: report.observations.sessionId });
    return option(next, optionId).value === value ? next : undefined;
  }, `${optionId}=${value}`);
  return updated;
}
async function sendFromComposer(text) {
  const textarea = page.locator('.chat-compose-shell textarea');
  await textarea.fill(text);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
}
async function transcript(sessionId) { return request('chat.read', { sessionId }); }
async function sessionState(sessionId) {
  const snapshot = await request('runtime.snapshot');
  return snapshot.sessions.find(session => session.id === sessionId);
}
async function waitForUserTurn(sessionId, priorUserIds, prompt, timeout = 30_000) {
  return until(async () => (await transcript(sessionId)).slice().reverse().find(item => !priorUserIds.has(item.id) && item.role === 'user' && item.parts.some(part => part.text === prompt)), 'persisted user turn', timeout);
}
async function waitForCompletion(sessionId, turnId, timeout = 240_000) {
  return until(async () => {
    const [items, state] = await Promise.all([transcript(sessionId), sessionState(sessionId)]);
    if (state?.status === 'error') throw new Error(`session entered error: ${JSON.stringify(items.filter(item => item.turnId === turnId)).slice(-3000)}`);
    if (state?.status === 'idle') return { items: items.filter(item => item.turnId === turnId), state };
    return undefined;
  }, `turn ${turnId} completion`, timeout);
}
async function degradedEvents(sessionId) {
  return page.evaluate(id => globalThis.__chatOverflowEvents.filter(event => event.event === 'runtime.degraded' && (!event.data?.sessionId || event.data.sessionId === id)), sessionId);
}
function toolOutput(items) {
  return items
    .flatMap(item => item.parts)
    .filter(part => part.type === 'tool' && /command/i.test(String(part.toolName ?? '')))
    .map(part => JSON.stringify(part.data ?? part));
}
function nativeCommandOutput(items) {
  return items
    .flatMap(item => item.parts)
    .filter(part => part.type === 'tool' && /command/i.test(String(part.toolName ?? '')))
    .map(part => part.data?.aggregatedOutput)
    .filter(output => typeof output === 'string');
}
async function jsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? jsonlFiles(join(directory, entry.name))
    : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : []));
  return nested.flat();
}
async function inspectNativeHistory() {
  const files = await jsonlFiles(join(codexHome, 'sessions'));
  for (const file of files) {
    const rows = (await readFile(file, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const item = rows.map(row => row.payload?.item).find(candidate => typeof candidate?.aggregated_output === 'string' && candidate.aggregated_output.includes(commandMarker));
    if (!item) continue;
    return {
      file,
      commandObserved: Array.isArray(item.command) && item.command.some(value => String(value).includes(commandMarker)),
      stdoutBytes: Buffer.byteLength(item.stdout, 'utf8'),
      aggregatedOutputBytes: Buffer.byteLength(item.aggregated_output, 'utf8'),
      finalCommandMarker: item.aggregated_output.includes(commandMarker),
      formattedOutputTruncated: /truncated output/iu.test(String(item.formatted_output ?? '')),
      exitCode: item.exit_code ?? item.exitCode ?? null,
    };
  }
  return undefined;
}

try {
  await rm(reportDir, { recursive: true, force: true });
  await mkdir(reportDir, { recursive: true });
  await Promise.all([mkdir(workspace), mkdir(data), mkdir(profile), mkdir(codexHome)]);
  await copyFile(join(process.env.USERPROFILE ?? '', '.codex', 'auth.json'), join(codexHome, 'auth.json'));
  await prepareApp();

  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(threadterm_|codex_home$|electron_run_as_node$)/iu.test(name)));
  const env = { ...inherited, CODEX_HOME: codexHome, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime };
  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 60_000 });
  await page.evaluate(() => { globalThis.__chatOverflowEvents = []; return window.threadterm.onEvent(event => globalThis.__chatOverflowEvents.push(event)); });
  await request('settings.update', { patch: { language: 'en' }, expectedRevision: (await request('runtime.snapshot')).settings.revision, operationId: randomUUID() });
  await request('project.add', { path: workspace, name: 'Chat overflow Luna QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Chat overflow Luna QA', operationId: randomUUID() });
  report.observations.sessionId = session.id;
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-compose-shell textarea').waitFor({ state: 'visible', timeout: 90_000 });
  let ui = await activeOptions(session.id);
  const luna = option(ui, 'model').choices.find(choice => /luna/iu.test(`${choice.value} ${choice.name ?? ''}`));
  assert.ok(luna, `No Luna model in live catalog: ${option(ui, 'model').choices.map(choice => choice.value).join(', ')}`);
  report.observations.lunaCatalogChoice = { value: luna.value, name: luna.name };
  ui = await selectThroughChatView(ui, 'model', luna.value);
  assert.equal(option(ui, 'model').value, luna.value, 'Luna selection did not read back');
  check(`actual ChatView selected discovered Luna model ${luna.value}`);

  ui = await selectThroughChatView(ui, 'mode', 'never');
  assert.equal(option(ui, 'mode').value, 'never', 'approval policy did not read back as never');
  ui = await selectThroughChatView(ui, 'sandbox', 'danger-full-access');
  assert.equal(option(ui, 'sandbox').value, 'danger-full-access', 'isolated scratch sandbox did not read back as full access');
  check('actual ChatView selected approval=never and sandbox=full access for its isolated scratch workspace');

  if (prepareOnly) {
    report.passed = true;
    check('prepare-only mode discovered Luna without starting a model turn');
  } else {
    const firstPrompt = `Use exactly one PowerShell command in the current workspace. It must write exactly 1048576 deterministic repetitive ASCII bytes to stdout, then a newline and ${commandMarker}. Do not read files or use any other tools. After the command finishes, reply with exactly ${firstMarker}.`;
    const existing = await transcript(session.id);
    const priorUsers = new Set(existing.filter(item => item.role === 'user').map(item => item.id));
    const sentAt = Date.now();
    await sendFromComposer(firstPrompt);
    const firstUser = await waitForUserTurn(session.id, priorUsers, firstPrompt);
    report.timingsMs.firstUserPersisted = Date.now() - sentAt;
    await until(async () => {
      const state = await sessionState(session.id);
      const stop = page.getByRole('button', { name: 'Stop', exact: true });
      return state?.status === 'running' && await stop.count() === 1 ? true : undefined;
    }, 'running session with its ChatView Stop target', 90_000);
    report.observations.stopTarget = { turnId: firstUser.turnId, observedWhileRunning: true };
    check('first Luna turn exposed its own ChatView Stop target while running');
    const first = await waitForCompletion(session.id, firstUser.turnId);
    report.timingsMs.firstTurnCompleted = Date.now() - sentAt;
    const output = toolOutput(first.items);
    const nativeOutput = nativeCommandOutput(first.items);
    const combinedOutput = output.join('\n');
    const retainedNativeBytes = Math.max(0, ...nativeOutput.map(value => Buffer.byteLength(value, 'utf8')));
    const firstReply = first.items.flatMap(item => item.parts).map(part => part.text ?? '').join('\n');
    assert.ok(output.length > 0, 'the 1 MiB command did not retain a command tool item');
    assert.ok(combinedOutput.includes(commandMarker), `final command marker missing from retained command output (tool bytes=${combinedOutput.length})`);
    assert.match(firstReply, new RegExp(firstMarker), 'first model completion marker missing');
    assert.equal((await degradedEvents(session.id)).length, 0, 'runtime.degraded fired during the heavy command turn');
    report.observations.firstTurn = { status: first.state.status, commandToolParts: output.length, nativeAggregatedOutputParts: nativeOutput.length, retainedNativeBytes, nativeOutputTruncated: retainedNativeBytes < oneMiB, finalCommandMarker: true, expectedNativeOutput: `${oneMiB} generated bytes; transcript asserts the retained final marker rather than assuming every delta is persisted` };
    check('1 MiB real PowerShell output retained the authoritative completed command item and final marker without degradation');

    const secondPrompt = `Reply with exactly ${secondMarker}. Do not use tools.`;
    const beforeSecond = new Set((await transcript(session.id)).filter(item => item.role === 'user').map(item => item.id));
    const secondSentAt = Date.now();
    await sendFromComposer(secondPrompt);
    const secondUser = await waitForUserTurn(session.id, beforeSecond, secondPrompt);
    const second = await waitForCompletion(session.id, secondUser.turnId);
    report.timingsMs.secondTurnCompleted = Date.now() - secondSentAt;
    const secondReply = second.items.flatMap(item => item.parts).map(part => part.text ?? '').join('\n');
    assert.match(secondReply, new RegExp(secondMarker), 'second turn did not complete after the output-heavy turn');
    assert.equal((await degradedEvents(session.id)).length, 0, 'runtime.degraded fired before or during the follow-up turn');
    assert.equal((await sessionState(session.id))?.status, 'idle', 'follow-up turn did not return the session to idle');
    check('after the first real turn completed, ChatView accepted and completed the second Luna turn without an active-turn mismatch');
    report.passed = true;
  }
} catch (error) {
  report.errors.push(failureText(error));
  if (page) await page.screenshot({ path: join(reportDir, 'failure.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  try { if (page) await request('runtime.shutdown', { operationId: randomUUID() }); } catch (error) { report.observations.shutdown = failureText(error); }
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
    await Promise.race([app.close(), delay(5_000)]).catch(() => undefined);
    try { app.process()?.kill(); } catch { /* already closed */ }
  }
  await releaseLock?.();
  if (!prepareOnly) {
    try {
      const nativeHistory = await inspectNativeHistory();
      report.observations.nativeHistory = nativeHistory;
      assert.ok(nativeHistory?.commandObserved, 'native history did not retain the executed PowerShell command');
      assert.ok(nativeHistory?.finalCommandMarker, 'native history did not retain the command completion marker');
      assert.ok((nativeHistory?.aggregatedOutputBytes ?? 0) >= oneMiB, 'native history retained less than the requested 1 MiB output');
    } catch (error) {
      report.passed = false;
      report.errors.push(`native history verification: ${failureText(error)}`);
      process.exitCode = 1;
    }
  }
  await writeFile(join(reportDir, 'report.json'), `${JSON.stringify(redact(report), null, 2)}\n`).catch(() => undefined);
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => undefined);
  console.log(`${report.passed && report.errors.length === 0 ? 'CHAT EVENT OVERFLOW LUNA QA PASSED' : 'CHAT EVENT OVERFLOW LUNA QA FAILED'}; report: ${join(reportDir, 'report.json')}`);
}
