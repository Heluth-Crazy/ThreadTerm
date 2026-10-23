// Desktop-1 production-path visual QA for OpenCode's next-turn options.
// It starts only the isolated runtime and qa/fixtures/mock-opencode.mjs; PATH
// isolation prevents the adapter from discovering a real provider CLI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { sendChatPrompt } from './lib/chat-send.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const out = join(root, 'qa/results/browser-chat-followups/OC1/opencode-options-visual');
const scratchRoot = resolve(process.env.THREADTERM_QA_SCRATCH ?? 'D:/project/ThreadTerm/tt-qa-temp');
await mkdir(scratchRoot, { recursive: true });
process.env.TMP = scratchRoot; process.env.TEMP = scratchRoot;
const scratch = await mkdtemp(join(scratchRoot, 'threadterm-opencode-options-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const data = join(scratch, 'data');
const workspace = join(scratch, 'workspace');
const stateFile = join(scratch, 'mock-state.json');
const portFile = join(scratch, 'mock-port.txt');
const requestsFile = join(scratch, 'mock-requests.jsonl');
const report = { passed: false, checks: [], screenshots: [], paneWidths: [], sendDiagnostics: [], observations: [], timeouts: [], step: 'setup', layout: [], errors: [] };
const delay = ms => new Promise(done => setTimeout(done, ms));
const valueFor = (providerID, modelID) => JSON.stringify({ providerID, modelID });
let app, page, revision = 0;
let observeConnection = async () => ({ phase: 'not-observed', overlay: 'none' });
function step(label) { report.step = label; console.log(`[OC1] ${label}`); }
// Displayed state only: chat.connection shares the ordered lane with chat.connect
// and cannot observe an in-flight attach. Never issue an RPC from this probe.
function connectionInPane(node) {
  const chip = node.querySelector('.chat-connection-chip');
  const full = node.querySelector('.chat-connect-mask');
  const banner = node.querySelector('.chat-reconnect-banner');
  const overlay = full ?? banner;
  const phase = !chip ? 'unknown' : chip.classList.contains('is-busy') ? 'connecting' : chip.classList.contains('is-ok') ? 'ready' : chip.classList.contains('is-error') ? 'failed' : chip.classList.contains('is-idle') ? 'disconnected' : 'unavailable';
  return { phase, phaseSource: 'displayed-chip', overlay: full ? 'full' : banner ? 'banner' : 'none', failed: overlay?.classList.contains('is-failed') ?? false,
    label: chip?.getAttribute('aria-label'), message: overlay?.querySelector('span')?.textContent, retryVisible: Boolean(overlay?.querySelector('button')) };
}

async function until(probe, label, timeout = 30_000) {
  step(`wait: ${label}`);
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await probe(); if (value) return value; } catch (error) { last = error; } await delay(100); }
  const observed = await observeConnection().catch(error => ({ observationError: String(error) }));
  const diagnostic = { step: report.step, cell: report.cell, timeout, observed, ...(last ? { probeError: String(last) } : {}) };
  report.timeouts.push(diagnostic); console.error(`[OC1] timeout ${JSON.stringify(diagnostic)}`);
  throw new Error(`Timed out waiting for ${label}; observed ${JSON.stringify(observed)}${last ? `: ${last.message}` : ''}`);
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'opencode-options-visual-qa', version: '1.0.0', main: 'main.cjs' }));
}
function option(ui, id) { const row = ui.options.find(entry => entry.id === id); assert.ok(row, `missing ${id} option`); return row; }
async function sizeChatPane(scope, width) {
  const actions = () => page.getByRole('button', { name: /^(Workspace actions|工作区操作)$/ });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.waitForFunction(() => window.innerWidth === 1440);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  if (width === 1440) {
    const empty = page.locator('[data-pane-id]').filter({ has: page.locator('.pane-empty') });
    if (await empty.count()) {
      await empty.locator('.pane-empty > strong').click(); await actions().click();
      await page.getByRole('button', { name: /^(Close pane|关闭窗格)$/ }).click(); await page.keyboard.press('Escape');
      await page.locator('.workspace-action-menu').waitFor({ state: 'hidden' });
      await until(async () => (await page.locator('[data-pane-id]').count()) === 1, 'restore wide single pane');
    }
    return;
  }
  if (await page.locator('[data-pane-id]').count() === 2) {
    await until(() => scope.evaluate(node => { const measured = node.getBoundingClientRect().width; return measured >= 380 && measured <= 420; }), 'retain real narrow Chat pane');
    return;
  }
  assert.equal(await page.locator('[data-pane-id]').count(), 1, 'narrow cell starts with one Chat pane');
  await scope.locator('textarea').click(); await actions().click();
  await page.getByRole('button', { name: /^(Split right|左右拆分)$/ }).click(); await page.keyboard.press('Escape');
  await page.locator('.workspace-action-menu').waitFor({ state: 'hidden' });
  await until(async () => (await page.locator('[data-pane-id]').count()) === 2, 'real two-pane workspace');
  const divider = page.locator('[data-split-id] > .pane-divider');
  await until(() => divider.evaluate(node => node.parentElement.classList.contains('horizontal')), 'horizontal split');
  const point = await divider.evaluate(node => { const split = node.parentElement, box = split.getBoundingClientRect(), rect = node.getBoundingClientRect(); const gap = parseFloat(getComputedStyle(split).columnGap) || 0; return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, endX: box.left + 400 + gap + rect.width / 2 }; });
  assert.equal(await divider.evaluate((node, target) => node.contains(document.elementFromPoint(target.x, target.y)), point), true, 'divider is the real pointer target');
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.endX, point.y, { steps: 8 }); await page.mouse.up();
  await until(() => scope.evaluate(node => { const measured = node.getBoundingClientRect().width; return measured >= 380 && measured <= 420; }), 'Chat resized to a real 380–420 px pane');
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(resolve(out).startsWith(`${resolve(root, 'qa', 'results')}\\`), `refuse to remove results outside QA output: ${out}`);
  await rm(out, { recursive: true, force: true });
  await Promise.all([mkdir(out, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(data, { recursive: true }), writeFile(requestsFile, '')]);
  step('build isolated app');
  await buildApp();
  const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
  await writeFile(join(bin, 'shim.rs'), shim);
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'opencode.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  await copyFile(runtime, join(appDir, 'threadterm-v3-runtime.exe'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-opencode-options-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: join(appDir, 'threadterm-v3-runtime.exe'), TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(root, 'qa/fixtures/mock-opencode.mjs'),
    TT_QA_OPENCODE_STATE: stateFile, TT_QA_OPENCODE_PORT_FILE: portFile, TT_QA_OPENCODE_REQUESTS: requestsFile,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  step('launch isolated Electron app');
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  assert.notEqual(await page.evaluate(() => window.threadterm.platform), 'browser', 'production preload bridge is in use');
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  const initial = await request('runtime.snapshot'); revision = initial.settings.revision;
  const project = await request('project.add', { path: workspace, name: 'OpenCode options QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'OpenCode options', provider: 'opencode', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  observeConnection = () => scope.evaluate(connectionInPane);
  await until(() => scope.locator('.chat-compose-shell textarea').isEnabled(), 'OpenCode composer');
  await until(async () => (await request('chat.connection', { sessionId: chat.id })).phase === 'ready', 'OpenCode connection');
  const options = await until(async () => { const ui = await request('chat.options', { sessionId: chat.id }); return ui.options?.length ? ui : undefined; }, 'option catalogue');
  const model = option(options, 'next-model'); const agent = option(options, 'agent');
  assert.equal(model.value, '', 'the default is the OpenCode server default');
  assert.equal(options.options.some(row => row.id === 'variant'), false, 'Variant is absent until a concrete model is selected');
  const precise = valueFor('openai', 'gpt-5.2'); const slash = valueFor('slash/provider', 'family/model/with/slash');
  assert.ok(model.choices.some(choice => choice.value === precise), 'model picker has gpt-5.2');
  assert.ok(model.choices.some(choice => choice.value === slash), 'model picker keeps slash-bearing provider and model IDs structured');
  assert.deepEqual(agent.choices.map(choice => choice.value), ['', 'build', 'plan', 'custom'], 'only the server default and primary visible agents are exposed');
  async function appearance(theme, locale, width) {
    const custom = theme === 'custom';
    const patch = { theme: custom ? 'dark' : theme, language: locale, themeSelection: custom ? 'custom:oc1' : theme, ...(custom ? { customThemes: { oc1: { background: '#07111f', surface: '#10233c', text: '#ffffff', muted: '#91a4bf', accent: '#3b82f6', border: '#274768' } } } : {}), notifications: { native: false, attention: false, completed: false, sound: false } };
    const updated = await request('settings.update', { patch, expectedRevision: revision, operationId: randomUUID() });
    revision = updated.revision ?? (await request('runtime.snapshot')).settings.revision;
    await sizeChatPane(scope, width);
    await page.waitForFunction(([language, theme, custom]) => document.documentElement.lang === language && document.documentElement.dataset.theme === theme && (!custom || document.documentElement.dataset.customTheme === 'true'), [locale, custom ? 'dark' : theme, custom]);
  }
  async function capture(state, theme, locale, width) {
    const name = `${state}-${theme}-${locale}-${width}.png`;
    step(`capture: ${name}`);
    // Capture the transient banner before control/layout checks consume its
    // bounded header-wait window. Populated chips are verified in idle cells.
    if (state === 'reconnecting-populated') {
      const observed = await observeConnection();
      assert.equal(observed.phase, 'connecting', `${name} connecting before screenshot: ${JSON.stringify(observed)}`);
      assert.equal(observed.overlay, 'banner', `${name} preserves the existing transcript beneath a banner`);
      assert.equal(observed.failed, false, `${name} has not already timed out`);
      report.observations.push({ name, ...observed });
      await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name);
      assert.equal((await observeConnection()).phase, 'connecting', `${name} stays connecting through screenshot completion`);
    }
    if (state === 'running-populated') {
      const session = (await request('runtime.snapshot')).sessions.find(row => row.id === chat.id);
      assert.equal(session?.status, 'waiting', `${name} retains the native permission-waiting turn`);
      assert.equal(await scope.locator('.chat-compose-send.is-stop').isEnabled(), true, `${name} has an enabled Stop control`);
    }
    const composer = `[data-testid="session-chat-${chat.id}"] .chat-compose-shell`;
    assertNoControlViolations(await checkControlConsistency(page, composer), `${name} composer`);
    const metrics = await scope.evaluate(node => {
      const composer = node.querySelector('.chat-compose-bar');
      return { chatWidth: node.getBoundingClientRect().width, paneWidth: node.closest('[data-pane-id]').getBoundingClientRect().width, composerWidth: composer.getBoundingClientRect().width, overflow: composer.scrollWidth - composer.clientWidth, viewportWidth: window.innerWidth };
    });
    report.paneWidths.push({ name, requestedWidth: width, ...metrics });
    assert.ok(metrics.overflow <= 1, `${name} composer has no horizontal overflow`);
    if (width === 400) {
      assert.ok(metrics.chatWidth >= 380 && metrics.chatWidth <= 420, `${name} Chat itself is 380–420 px (${metrics.chatWidth}px)`);
      assert.ok(metrics.paneWidth >= 380 && metrics.paneWidth <= 420, `${name} containing pane is 380–420 px (${metrics.paneWidth}px)`);
    }
    if (state !== 'reconnecting-populated') {
      await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name);
    }
  }
  async function matrix(state) { for (const theme of ['light', 'dark', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 400]) { report.cell = { state, theme, locale, width }; step(`${state}: ${theme}/${locale}/${width}`); await appearance(theme, locale, width); await capture(state, theme, locale, width); } }
  async function applyPopulatedSelections() {
    let ui = await request('chat.options', { sessionId: chat.id });
    if (option(ui, 'next-model').value !== precise) {
      await scope.locator('.chat-model-chip').click();
      await scope.locator('.chat-menu-model').getByRole('menuitemradio', { name: /OpenAI.*GPT 5\.2/i }).click();
      await until(async () => option(await request('chat.options', { sessionId: chat.id }), 'next-model').value === precise, 'model selection');
    }
    ui = await request('chat.options', { sessionId: chat.id });
    if (option(ui, 'agent').value !== 'plan') {
      await scope.locator('.chat-option-chip[data-option-id="agent"]').click();
      await scope.getByRole('menu', { name: 'Agent', exact: true }).getByRole('menuitemradio').nth(option(ui, 'agent').choices.findIndex(choice => choice.value === 'plan')).click();
      await until(async () => option(await request('chat.options', { sessionId: chat.id }), 'agent').value === 'plan', 'agent selection');
    }
    ui = await request('chat.options', { sessionId: chat.id });
    if (option(ui, 'variant').value !== 'precise') {
      await scope.locator('.chat-option-chip[data-option-id="variant"]').click();
      await scope.getByRole('menu', { name: 'Variant', exact: true }).getByRole('menuitemradio').nth(option(ui, 'variant').choices.findIndex(choice => choice.value === 'precise')).click();
      await until(async () => option(await request('chat.options', { sessionId: chat.id }), 'variant').value === 'precise', 'variant selection');
    }
    // Runtime confirmation can precede the renderer's chat.ui commit. Wait for
    // the visible chips before asserting or capturing the populated composer.
    await until(async () => {
      const text = await scope.locator('.chat-compose-bar').innerText();
      return [/GPT 5\.2/i, /Plan/i, /Precise/i].every(label => label.test(text));
    }, 'rendered populated composer');
  }
  await matrix('idle-default');
  // Choose a variant-capable model before capturing populated chips. The menus
  // route through the UI, so this checks the renderer's real option contract.
  await appearance('light', 'en', 1440);
  await applyPopulatedSelections();
  const populatedText = await scope.locator('.chat-compose-bar').innerText();
  for (const label of [/GPT 5\.2/i, /Plan/i, /Precise/i]) assert.match(populatedText, label, 'idle composer shows populated model, agent, and variant values');
  assert.equal(await scope.locator('.chat-option-chip[data-option-id="agent"]').getAttribute('title'), 'Agent', 'agent uses the generic Agent label');
  assert.equal(await scope.locator('.chat-option-chip[data-option-id="variant"]').getAttribute('title'), 'Variant', 'variant uses the generic Variant label');
  await matrix('idle-populated');
  const promptRequests = async () => (await readFile(requestsFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.method === 'POST' && /\/prompt_async$/.test(row.path));
  assert.equal((await promptRequests()).length, 0, 'idle matrices and option changes do not submit a model request');
  // A successful click is not proof of submission. Wait for committed input and
  // confirm composer clearing or a new user item before probing native status.
  step('submit permission fixture once');
  await sendChatPrompt({ composer: scope.locator('.chat-compose-shell textarea'), sendButton: scope.locator('.chat-compose-send[type=submit]'), text: 'fixture-permission',
    readSnapshot: () => request('chat.snapshot', { sessionId: chat.id }), readConnection: () => request('chat.connection', { sessionId: chat.id }),
    onDiagnostic: diagnostic => report.sendDiagnostics.push({ sessionId: chat.id, ...diagnostic }) });
  const submitted = await until(async () => { const rows = await promptRequests(); return rows.length ? rows : undefined; }, 'submitted prompt reaching the OpenCode mock');
  assert.equal(submitted.length, 1, 'the UI sends exactly one prompt');
  assert.deepEqual(submitted[0].body, { parts: [{ type: 'text', text: 'fixture-permission' }], model: { providerID: 'openai', modelID: 'gpt-5.2' }, agent: 'plan', variant: 'precise' }, 'the running fixture receives the selected next-turn options');
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === chat.id)?.status === 'waiting', 'native permission-waiting OpenCode turn');
  await matrix('running-populated');
  assert.equal((await promptRequests()).length, 1, 'running captures do not resubmit the prompt');
  report.checks.push('confirmed UI submission reaches the mock exactly once with the populated model, agent, and variant; every running capture retains waiting status and an enabled Stop control');
  step('stop permission fixture');
  await scope.locator('.chat-compose-send.is-stop').click();
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === chat.id)?.status === 'idle', 'stopped OpenCode turn');
  const setStalledHeaders = async enabled => {
    // A failed attach shuts down the fake server.  Clear its persisted state
    // directly so the Retry-created replacement server starts normally.
    if (!enabled) {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      state.stallEventHeaders = false;
      await writeFile(stateFile, JSON.stringify(state));
      return;
    }
    let last;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const port = Number(await readFile(portFile, 'utf8'));
        const response = await fetch(`http://127.0.0.1:${port}/qa/stall-event-headers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(500) });
        if (response.ok) return;
        last = new Error(`HTTP ${response.status}`);
      } catch (error) { last = error; }
      await delay(100);
    }
    throw new Error(`stall event headers endpoint unavailable: ${last instanceof Error ? last.message : String(last)}`);
  };
  const dropEvents = async () => {
    const port = Number(await readFile(portFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/qa/drop-events`, { method: 'POST' });
    assert.equal(response.ok, true, `drop events: ${response.status}`);
  };
  for (const theme of ['light', 'dark', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 400]) {
    report.cell = { state: 'reconnecting-populated', theme, locale, width };
    step(`reconnecting-populated: ${theme}/${locale}/${width}`);
    await appearance(theme, locale, 1440);
    await appearance(theme, locale, width);
    await setStalledHeaders(true);
    await dropEvents();
    // Dropping SSE starts the renderer's automatic reconnect. Let that failed
    // attach settle before exercising the explicit chip action, so it cannot
    // race that action. The fixture intentionally withholds headers for 5 s.
    await until(async () => (await observeConnection()).failed, 'automatic reconnect failure after dropped OpenCode stream', 12_000);
    assert.equal((await request('chat.connection', { sessionId: chat.id })).phase, 'failed', 'automatic reconnect settled before explicit action');
    step(`explicit reconnect: ${theme}/${locale}/${width}`);
    await scope.locator('.chat-connection-chip').click();
    await scope.getByRole('button', { name: /^(Reconnect|重新连接)$/ }).click();
    await page.keyboard.press('Escape');
    await until(async () => { const observed = await observeConnection(); return observed.phase === 'connecting' && observed.overlay === 'banner' && !observed.failed; }, 'explicit reconnect state', 4_000);
    await capture('reconnecting-populated', theme, locale, width);
    await until(async () => (await observeConnection()).failed, 'bounded stalled reconnect failure', 12_000);
    await setStalledHeaders(false);
    step(`retry failed banner: ${theme}/${locale}/${width}`);
    await scope.locator('.chat-reconnect-banner.is-failed').getByRole('button').click();
    await until(async () => (await request('chat.connection', { sessionId: chat.id })).phase === 'ready', 'retry after stalled reconnect');
    const restored = await request('chat.options', { sessionId: chat.id });
    assert.equal(option(restored, 'next-model').value, precise, 'reconnect restores the model selection');
    assert.equal(option(restored, 'agent').value, 'plan', 'reconnect restores the agent selection');
    assert.equal(option(restored, 'variant').value, 'precise', 'reconnect restores the variant selection');
  }
  report.checks.push('runtime catalogue has an empty OpenCode default, structured model values including a slash ID, primary agents, and variants only after a concrete model');
  report.checks.push('real production Chat pane captures populated chips while idle, waiting/running, and explicitly reconnecting across light, dark, custom, wide, and real approximately-400px split panes');
  report.layout.push('checked control sizes, state styling, token-driven custom theme, overflow, alignment, and readable populated chips; screenshots also expose duplicate content, empty boxes, uneven padding, dead space, isolated wrapping, and overlays for review.');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  const observed = await observeConnection().catch(caught => ({ observationError: String(caught) }));
  report.failure = { step: report.step, cell: report.cell, observed }; console.error(`[OC1] failure ${JSON.stringify(report.failure)}`);
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report.passed ? 'OPENCODE OPTIONS VISUAL QA PASSED' : `OPENCODE OPTIONS VISUAL QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
