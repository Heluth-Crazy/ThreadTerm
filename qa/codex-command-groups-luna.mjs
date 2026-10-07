// Real, isolated Codex ChatView acceptance test for command grouping.
// Run only after the QA runtime and production UI are rebuilt:
//   node qa/codex-command-groups-luna.mjs --rebuild
// `--prepare` discovers and selects Luna but intentionally sends no model turn.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const appDir = join(root, 'runtime/target-qa/codex-command-groups-luna-app');
const reportDir = join(root, 'qa/results/codex-command-groups-luna');
const prepareOnly = process.argv.includes('--prepare');
const rebuild = process.argv.includes('--rebuild');
const keep = process.argv.includes('--keep');
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

assert.match(runtime.replace(/\\/gu, '/'), /runtime\/target-qa\/debug\/threadterm-v3-runtime\.exe$/iu, 'refusing a non-target-qa runtime');
assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-command-groups-luna-'));
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const codexHome = join(scratch, 'codex-home');
const pipe = `\\\\.\\pipe\\threadterm-codex-command-groups-luna-${randomUUID()}`;
const report = { passed: false, startedAt: new Date().toISOString(), runtime, appDir, scratch, checks: [], observations: {}, errors: [] };
let app;
let page;

function failureText(error) { return error instanceof Error ? error.stack ?? error.message : String(error); }
function redact(value, key = '') {
  if (/(?:auth|token|secret|account|email|cookie)/iu.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
function check(value) { report.checks.push(value); console.log(`PASS ${value}`); }
async function until(test, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch (error) { last = error; }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${failureText(last)}` : ''}`);
}
async function prepareApp() {
  if (!rebuild && existsSync(join(appDir, 'renderer/index.html'))) return;
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-codex-command-groups-luna-qa', version: '0.1.0', main: 'main.cjs' }));
}
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
function option(ui, id) { const result = ui.options.find(candidate => candidate.id === id); assert.ok(result, `missing ${id} option`); return result; }
async function activeOptions(sessionId) {
  return until(async () => {
    const ui = await request('chat.options', { sessionId });
    return ui.options?.find(candidate => candidate.id === 'model')?.choices?.length ? ui : undefined;
  }, 'Codex option catalog');
}
async function selectThroughChatView(ui, sessionId, optionId, value) {
  const target = option(ui, optionId);
  const choice = target.choices.find(candidate => candidate.value === value);
  assert.ok(choice, `${optionId} lacks ${value}`);
  const chip = optionId === 'mode' ? page.locator('.chat-mode-chip') : optionId === 'sandbox' ? page.locator('.chat-model-chip') : page.locator('.chat-model-chip');
  await chip.click();
  const menu = optionId === 'mode' ? page.locator('.chat-menu-mode') : page.locator('.chat-menu-model');
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitemradio').filter({ hasText: choice.name }).first().click();
  return until(async () => {
    const next = await request('chat.options', { sessionId });
    return option(next, optionId).value === value ? next : undefined;
  }, `${optionId}=${value}`);
}
async function transcript(sessionId) { return request('chat.read', { sessionId }); }
async function sessionState(sessionId) { return (await request('runtime.snapshot')).sessions.find(session => session.id === sessionId); }
async function send(prompt) {
  const textarea = page.locator('.chat-compose-shell textarea');
  await textarea.fill(prompt);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
}
async function waitForTurn(sessionId, prompt) {
  return until(async () => [...await transcript(sessionId)].reverse().find(item => item.role === 'user' && item.parts.some(part => part.text === prompt)), 'user turn persisted');
}
async function waitForIdle(sessionId, turnId, timeout = 240_000) {
  return until(async () => {
    const [items, session] = await Promise.all([transcript(sessionId), sessionState(sessionId)]);
    if (session?.status === 'error') throw new Error(`session entered error: ${JSON.stringify(items.filter(item => item.turnId === turnId)).slice(-3000)}`);
    const turnItems = items.filter(item => item.turnId === turnId);
    return session?.status === 'idle' && turnItems.some(item => item.elapsedMs != null) ? turnItems : undefined;
  }, `turn ${turnId} completion`, timeout);
}

try {
  await mkdir(reportDir, { recursive: true });
  await Promise.all([mkdir(workspace), mkdir(data), mkdir(profile), mkdir(codexHome)]);
  await copyFile(join(process.env.USERPROFILE ?? '', '.codex', 'auth.json'), join(codexHome, 'auth.json'));
  await prepareApp();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(threadterm_|codex_home$|electron_run_as_node$)/iu.test(name)));
  const env = { ...inherited, CODEX_HOME: codexHome, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime };
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 60_000 });
  await page.evaluate(() => { globalThis.__commandGroupEvents = []; return window.threadterm.onEvent(event => globalThis.__commandGroupEvents.push(event)); });
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en' }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await request('project.add', { path: workspace, name: 'Codex command group Luna QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Codex command group Luna QA', operationId: randomUUID() });
  report.observations.sessionId = session.id;
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-compose-shell textarea').waitFor({ state: 'visible', timeout: 90_000 });
  let ui = await activeOptions(session.id);
  const luna = option(ui, 'model').choices.find(choice => /luna/iu.test(`${choice.value} ${choice.name ?? ''}`));
  assert.ok(luna, `No Luna in live catalog: ${option(ui, 'model').choices.map(choice => choice.value).join(', ')}`);
  report.observations.luna = { value: luna.value, name: luna.name };
  ui = await selectThroughChatView(ui, session.id, 'model', luna.value);
  assert.equal(option(ui, 'model').value, luna.value);
  check(`ChatView selected discovered Luna model ${luna.value}`);
  ui = await selectThroughChatView(ui, session.id, 'mode', 'never');
  assert.equal(option(ui, 'mode').value, 'never');
  ui = await selectThroughChatView(ui, session.id, 'sandbox', 'danger-full-access');
  assert.equal(option(ui, 'sandbox').value, 'danger-full-access');
  check('ChatView selected approval=never and isolated scratch workspace permissions');
  if (prepareOnly) {
    report.passed = true;
    check('prepare-only discovered Luna without sending a model turn');
  } else {
    const marker = 'TT_COMMAND_GROUP_LUNA_THREE_COMMANDS_OK';
    const prompt = `Use exactly three separate PowerShell commands in this workspace, in this exact order: Write-Output 'TT_COMMAND_GROUP_ONE'; Write-Output 'TT_COMMAND_GROUP_TWO'; Write-Output '${marker}'. Do not combine commands, do not read files, and do not use other tools. After all three commands complete, reply with exactly ${marker}.`;
    await send(prompt);
    const firstTurn = await waitForTurn(session.id, prompt);
    const firstItems = await waitForIdle(session.id, firstTurn.turnId);
    const commands = firstItems.flatMap(item => item.parts).filter(part => part.type === 'tool' && /command/i.test(String(part.toolName ?? '')));
    assert.equal(commands.length, 3, `expected three command parts, got ${commands.length}`);
    assert.ok(commands.every(part => part.data?.exitCode === 0), 'all three real commands must exit successfully');
    const outputs = commands.map(part => String(part.data?.aggregatedOutput ?? '').trim());
    assert.deepEqual(outputs, ['TT_COMMAND_GROUP_ONE', 'TT_COMMAND_GROUP_TWO', marker], 'native command outputs preserve marker order');
    for (const value of ['TT_COMMAND_GROUP_ONE', 'TT_COMMAND_GROUP_TWO', marker]) {
      assert.ok(commands.some(part => JSON.stringify(part).includes(value)), `native command part omitted ${value}`);
    }
    assert.ok(firstItems.flatMap(item => item.parts).some(part => String(part.text ?? '').includes(marker)), 'final assistant marker missing');
    const activity = page.locator('.chat-tool-activity');
    await activity.waitFor({ state: 'visible' });
    assert.equal(await activity.count(), 1, 'one UI tool activity group for the first turn');
    const entries = activity.locator('.chat-tool-entry[data-tool-kind="command"]');
    assert.equal(await entries.count(), 3, 'all three command bodies remain available');
    if (!await activity.evaluate(node => node.open)) await activity.locator(':scope > summary').click();
    for (const value of ['TT_COMMAND_GROUP_ONE', 'TT_COMMAND_GROUP_TWO', marker]) {
      await entries.filter({ hasText: value }).first().waitFor({ state: 'visible' });
    }
    report.observations.firstTurn = { nativeCommandParts: commands.length, domToolActivities: await activity.count(), domCommandEntries: await entries.count() };
    report.observations.nativeVerification = { commandCount: commands.length, exitCodes: commands.map(part => part.data.exitCode), outputMarkers: outputs };
    check('one real Luna turn produced three command entries in one expanded tool activity group');
    const nextMarker = 'TT_COMMAND_GROUP_LUNA_NEXT_TURN_OK';
    await send(`Reply with exactly ${nextMarker}; do not use tools.`);
    const secondTurn = await waitForTurn(session.id, `Reply with exactly ${nextMarker}; do not use tools.`);
    const secondItems = await waitForIdle(session.id, secondTurn.turnId);
    assert.ok(secondItems.flatMap(item => item.parts).some(part => String(part.text ?? '').includes(nextMarker)), 'second turn marker missing');
    const degraded = await page.evaluate(id => globalThis.__commandGroupEvents.filter(event => event.event === 'runtime.degraded' && (!event.data?.sessionId || event.data.sessionId === id)), session.id);
    assert.equal(degraded.length, 0, 'no native degradation event');
    check('second Luna turn completed normally with no error or degradation');
    await page.screenshot({ path: join(reportDir, 'luna-command-group-expanded.png'), animations: 'disabled' });
    report.passed = true;
  }
} catch (error) {
  report.error = failureText(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(reportDir, { recursive: true }).catch(() => undefined);
  await writeFile(join(reportDir, 'report.json'), `${JSON.stringify(redact(report), null, 2)}\n`).catch(() => undefined);
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => undefined);
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); }
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => undefined);
  console.log(`${report.passed && !report.errors.length ? 'CODEX COMMAND GROUP LUNA QA PASSED' : 'CODEX COMMAND GROUP LUNA QA FAILED'}; report: ${join(reportDir, 'report.json')}`);
}
