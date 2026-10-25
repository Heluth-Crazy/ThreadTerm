// Real isolated ChatView QA for mixed command/MCP tool activity.
// The MCP browser is a local stdio fixture only; it does not automate a browser.
// Run the model turn only after the target-qa runtime and UI are rebuilt:
//   node qa/tool-activity-luna.mjs --rebuild
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const appDir = join(root, 'runtime/target-qa/tool-activity-luna-app');
const reportDir = join(root, 'qa/results/tool-activity-luna');
const fixture = join(root, 'qa/fixtures/tool-activity-browser-mcp.cjs');
const prepareOnly = process.argv.includes('--prepare');
const rebuild = process.argv.includes('--rebuild');
const keep = process.argv.includes('--keep');
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

assert.match(runtime.replace(/\\/gu, '/'), /runtime\/target-qa\/debug\/threadterm-v3-runtime\.exe$/iu, 'refusing a non-target-qa runtime');
assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
assert.ok(existsSync(fixture), `missing local QA browser MCP fixture: ${fixture}`);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-tool-activity-luna-'));
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const codexHome = join(scratch, 'codex-home');
const pipe = `\\\\.\\pipe\\threadterm-tool-activity-luna-${randomUUID()}`;
const report = { passed: false, startedAt: new Date().toISOString(), runtime, appDir, scratch, checks: [], observations: {}, errors: [] };
let app, releaseLock;
let page;
let fixtureServer;

function failureText(error) { return error instanceof Error ? error.stack ?? error.message : String(error); }
function redact(value, key = '') {
  if (/(?:auth|token|secret|account|email|cookie)/iu.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
function check(text) { report.checks.push(text); console.log(`PASS ${text}`); }
async function until(test, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${failureText(last)}` : ''}`);
}
async function prepareApp() {
  if (!rebuild && existsSync(join(appDir, 'renderer/index.html'))) return;
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-tool-activity-luna-qa', version: '0.1.0', main: 'main.cjs' }));
}
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
function option(ui, id) { const found = ui.options.find(candidate => candidate.id === id); assert.ok(found, `missing ${id} option`); return found; }
async function options(sessionId) { return until(async () => { const ui = await request('chat.options', { sessionId }); return option(ui, 'model').choices?.length ? ui : undefined; }, 'Codex option catalog'); }
async function choose(ui, sessionId, optionId, value) {
  const choice = option(ui, optionId).choices.find(candidate => candidate.value === value);
  assert.ok(choice, `${optionId} has no ${value}`);
  const menu = optionId === 'mode' ? page.locator('.chat-menu-mode') : page.locator('.chat-menu-model');
  await (optionId === 'mode' ? page.locator('.chat-mode-chip') : page.locator('.chat-model-chip')).click();
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitemradio').filter({ hasText: choice.name }).first().click();
  return until(async () => { const next = await request('chat.options', { sessionId }); return option(next, optionId).value === value ? next : undefined; }, `${optionId}=${value}`);
}
async function transcript(sessionId) { return request('chat.read', { sessionId }); }
async function state(sessionId) { return (await request('runtime.snapshot')).sessions.find(session => session.id === sessionId); }
async function send(prompt) { await page.locator('.chat-compose-shell textarea').fill(prompt); await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit()); }
async function turn(sessionId, prompt, known) { return until(async () => [...await transcript(sessionId)].reverse().find(item => item.role === 'user' && !known.has(item.id) && item.parts.some(part => part.text === prompt)), 'persisted user turn'); }
function toolText(part) { return `${part.toolName ?? ''}\n${JSON.stringify(part.data ?? {})}\n${part.text ?? ''}`; }
function isCommand(part) { return part.type === 'tool' && /commandexecution|exec_command|shell/i.test(String(part.toolName ?? '')); }
function isBrowser(part) { return part.type === 'tool' && /browser_(?:navigate|snapshot)|qa fake browser/i.test(toolText(part)); }
async function activitySample() {
  const activity = page.locator('.chat-tool-activity');
  if (!await activity.count()) return undefined;
  const entries = activity.locator('.chat-tool-entry');
  const current = activity.locator('.chat-tool-current-action, .chat-tool-current, [data-tool-current="true"], .chat-tool-entry.is-current, .chat-tool-entry.current');
  return { entryCount: await entries.count(), text: await activity.innerText(), currentText: (await current.allInnerTexts()).join('\n') };
}
async function waitForIdle(sessionId, turnId, samples, timeout = 240_000) {
  return until(async () => {
    const [items, session, sample] = await Promise.all([transcript(sessionId), state(sessionId), activitySample()]);
    if (sample && session?.status === 'running') samples.push(sample);
    if (session?.status === 'error') throw new Error(`session entered error: ${JSON.stringify(items.filter(item => item.turnId === turnId)).slice(-3000)}`);
    return session?.status === 'idle' ? items.filter(item => item.turnId === turnId) : undefined;
  }, `turn ${turnId} completion`, timeout);
}
async function startLocalFixture() {
  fixtureServer = createServer((request, response) => {
    if (!request.url?.startsWith('/tool-activity-qa/')) { response.writeHead(404); response.end('local QA fixture only'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>ThreadTerm local QA browser fixture</title><p>QA fake browser fixture</p>');
  });
  await new Promise((resolveListen, rejectListen) => { fixtureServer.once('error', rejectListen); fixtureServer.listen(0, '127.0.0.1', resolveListen); });
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== 'string', 'local browser fixture did not bind a TCP port');
  return `http://127.0.0.1:${address.port}/tool-activity-qa`;
}
function safeScratch() {
  const base = resolve(tmpdir());
  const target = resolve(scratch);
  assert.ok(target.startsWith(`${base}${sep}`) && target.includes('threadterm-tool-activity-luna-'), `refusing cleanup outside owned scratch: ${target}`);
}

try {
  await rm(reportDir, { recursive: true, force: true });
  await mkdir(reportDir, { recursive: true });
  await Promise.all([mkdir(workspace), mkdir(data), mkdir(profile), mkdir(codexHome)]);
  await copyFile(join(process.env.USERPROFILE ?? '', '.codex', 'auth.json'), join(codexHome, 'auth.json'));
  await writeFile(join(codexHome, 'config.toml'), `[mcp_servers.qa_fake_browser]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\n`);
  const fixtureBase = await startLocalFixture();
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
  await page.evaluate(() => { globalThis.__toolActivityEvents = []; return window.threadterm.onEvent(event => globalThis.__toolActivityEvents.push(event)); });
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en' }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await request('project.add', { path: workspace, name: 'Tool activity Luna QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Tool activity Luna QA', operationId: randomUUID() });
  report.observations.sessionId = session.id;
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.chat-compose-shell textarea').waitFor({ state: 'visible', timeout: 90_000 });
  let ui = await options(session.id);
  const luna = option(ui, 'model').choices.find(choice => /luna/iu.test(`${choice.value} ${choice.name ?? ''}`));
  assert.ok(luna, `No Luna model in live catalog: ${option(ui, 'model').choices.map(choice => choice.value).join(', ')}`);
  ui = await choose(ui, session.id, 'model', luna.value);
  assert.equal(option(ui, 'model').value, luna.value);
  ui = await choose(ui, session.id, 'mode', 'never');
  ui = await choose(ui, session.id, 'sandbox', 'danger-full-access');
  assert.equal(option(ui, 'mode').value, 'never');
  assert.equal(option(ui, 'sandbox').value, 'danger-full-access');
  report.observations.model = luna.value;
  check(`ChatView selected discovered Luna ${luna.value}, approval never, and full access only for isolated scratch`);
  if (prepareOnly) { report.passed = true; check('prepare-only completed without a model turn'); }
  else {
    const firstUrl = `${fixtureBase}/first`;
    const secondUrl = `${fixtureBase}/second`;
    const commandOne = 'TT_TOOL_ACTIVITY_COMMAND_ONE';
    const commandTwo = 'TT_TOOL_ACTIVITY_COMMAND_TWO';
    const finalMarker = 'TT_TOOL_ACTIVITY_LUNA_DONE';
    const prompt = `Use exactly these four tools sequentially, waiting for each result before the next: (1) run one PowerShell command: Start-Sleep -Milliseconds 800; Write-Output '${commandOne}'; (2) call qa_fake_browser browser_navigate with URL ${firstUrl}; (3) run one separate PowerShell command: Start-Sleep -Milliseconds 800; Write-Output '${commandTwo}'; (4) call qa_fake_browser browser_snapshot with URL ${secondUrl}. The browser MCP is a QA fake browser fixture, not real browser automation. Do not read or write files and do not use any other tools. After all four tools succeed, reply with exactly ${finalMarker}.`;
    const before = new Set((await transcript(session.id)).filter(item => item.role === 'user').map(item => item.id));
    await send(prompt);
    const firstTurn = await turn(session.id, prompt, before);
    const samples = [];
    const firstItems = await waitForIdle(session.id, firstTurn.turnId, samples);
    const tools = firstItems.flatMap(item => item.parts).filter(part => part.type === 'tool');
    const selected = tools.filter(part => isCommand(part) || isBrowser(part));
    assert.equal(selected.length, 4, `expected exactly four command/browser tools, got ${selected.map(part => part.toolName).join(', ')}`);
    assert.ok(isCommand(selected[0]) && toolText(selected[0]).includes(commandOne), 'first native tool is not command one');
    assert.ok(isBrowser(selected[1]) && toolText(selected[1]).includes(firstUrl), 'second native tool is not browser navigate one');
    assert.ok(isCommand(selected[2]) && toolText(selected[2]).includes(commandTwo), 'third native tool is not command two');
    assert.ok(isBrowser(selected[3]) && toolText(selected[3]).includes(secondUrl), 'fourth native tool is not browser snapshot two');
    assert.ok([selected[0], selected[2]].every(part => part.data?.exitCode === 0), 'both native commands must exit zero');
    assert.ok(firstItems.flatMap(item => item.parts).some(part => String(part.text ?? '').includes(finalMarker)), 'first turn final marker missing');
    const activity = page.locator('.chat-tool-activity');
    await activity.waitFor({ state: 'visible' });
    assert.equal(await activity.count(), 1, 'one activity container per mixed-tool turn');
    assert.equal(await activity.locator('.chat-tool-entry').count(), 4, 'activity container retains four entries');
    assert.equal(await activity.locator('.chat-tool-entry details details').count(), 0, 'tool activity must not nest per-tool drawers');
    const latestWhileRunning = samples.find(sample => sample.entryCount === 4 && /browser_snapshot|snapshot|second/iu.test(`${sample.currentText}\n${sample.text}`));
    assert.ok(latestWhileRunning, 'latest browser snapshot summary was not observed in the current header while the turn was active');
    report.observations.firstTurn = {
      nativeOrder: selected.map(part => part.toolName),
      entryCount: await activity.locator('.chat-tool-entry').count(),
      activeSamples: samples.length,
      currentHeader: latestWhileRunning.currentText || latestWhileRunning.text.slice(-300),
      commandExitCodes: [selected[0].data.exitCode, selected[2].data.exitCode],
      nativeEvidence: selected.map(part => ({
        toolName: part.toolName,
        status: part.status,
        exitCode: typeof part.data?.exitCode === 'number' ? part.data.exitCode : undefined,
        commandOne: toolText(part).includes(commandOne),
        commandTwo: toolText(part).includes(commandTwo),
        firstFixtureUrl: toolText(part).includes(firstUrl),
        secondFixtureUrl: toolText(part).includes(secondUrl),
      })),
    };
    check('one active tool header retained command/browser/command/browser order, four flat entries, and the latest browser summary');
    const followUp = 'TT_TOOL_ACTIVITY_LUNA_FOLLOW_UP_OK';
    const followPrompt = `Reply with exactly ${followUp}. Do not use tools.`;
    const nextBefore = new Set((await transcript(session.id)).filter(item => item.role === 'user').map(item => item.id));
    await send(followPrompt);
    const secondTurn = await turn(session.id, followPrompt, nextBefore);
    const secondItems = await waitForIdle(session.id, secondTurn.turnId, []);
    assert.ok(secondItems.flatMap(item => item.parts).some(part => String(part.text ?? '').includes(followUp)), 'follow-up marker missing');
    const degraded = await page.evaluate(id => globalThis.__toolActivityEvents.filter(event => event.event === 'runtime.degraded' && (!event.data?.sessionId || event.data.sessionId === id)), session.id);
    assert.equal(degraded.length, 0, 'runtime.degraded fired during mixed-tool activity');
    check('follow-up Luna turn succeeded with no degraded transcript or active-turn mismatch');
    await page.screenshot({ path: join(reportDir, 'tool-activity.png'), animations: 'disabled' });
    report.passed = true;
  }
} catch (error) {
  report.errors.push(failureText(error));
  if (page) await page.screenshot({ path: join(reportDir, 'failure.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try { if (page) await request('runtime.shutdown', { operationId: randomUUID() }); } catch { /* owned QA runtime only */ }
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); try { app.process()?.kill(); } catch {} }
  await releaseLock?.();
  if (fixtureServer) await new Promise(done => fixtureServer.close(done));
  report.finishedAt = new Date().toISOString();
  await mkdir(reportDir, { recursive: true }).catch(() => undefined);
  await writeFile(join(reportDir, 'report.json'), `${JSON.stringify(redact(report), null, 2)}\n`).catch(() => undefined);
  if (!keep) { safeScratch(); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => undefined); }
  console.log(`${report.passed && report.errors.length === 0 ? 'TOOL ACTIVITY LUNA QA PASSED' : 'TOOL ACTIVITY LUNA QA FAILED'}; report: ${join(reportDir, 'report.json')}`);
}
