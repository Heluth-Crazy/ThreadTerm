// Real Kimi delegation + production-app acceptance on Desktop 1, without activation.
// Usage: node qa/task-map-live.mjs [label] [--keep]
// Requires the QA runtime/MCP pair, Kimi authentication, Git, and two virtual desktops.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { connectPeer } from './pipe-client.mjs';
import { removeAgentHistory } from './agent-history.mjs';
import { electron } from './lib/desktop1.mjs';
import { checkControlConsistency } from './lib/visual-consistency.mjs';

const args = process.argv.slice(2);
assert.ok(args.filter(arg => !arg.startsWith('--')).length <= 1 && args.every(arg => !arg.startsWith('--') || arg === '--keep'), 'usage: node qa/task-map-live.mjs [label] [--keep]');
const label = args.find(arg => !arg.startsWith('--')) || 'current';
assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'label must be a single safe directory name');
const keep = args.includes('--keep');
const root = resolve(import.meta.dirname, '..');
const qaTemp = resolve('D:/project/ThreadTerm/tt-qa-temp');
const out = join(root, 'qa/results/task-map-live', label);
const expectedRuntime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? expectedRuntime);
const prompt = '1) Create the file notes.md containing exactly the line: parent-ok\n2) Call the ThreadTerm tool delegate_start with agent "kimi", title "QA map delegate" and prompt "Create the file child.md containing exactly the line: child-ok. Then reply with exactly CHILD-OK and nothing else."\n3) Call delegate_wait for that delegate until it has finished, then delegate_result.\n4) Reply with exactly PARENT-OK and nothing else.';
const secondPrompt = 'Reply with exactly SECOND-OK and nothing else.';
const notifications = { native: false, attention: false, completed: false, sound: false };
const report = { passed: false, label, startedAt: new Date().toISOString(), checks: [], findings: [], timings: [], screenshots: [], recordedItems: {}, visualConsistency: [], geometry: [], errors: [], cleanup: [] };
const started = performance.now();
let scratch, slug, work, data, appDir, env, gitExe, activePipe, daemon, daemonError, peer, app, page, parent, delegate;
let parentItems = [], delegateItems = [];
const sessionIds = new Set();
const lease = { sessionId: undefined, epoch: 0, renewed: 0 };
const oldDesktop = process.env.TT_QA_DESKTOP;
const delay = ms => new Promise(done => setTimeout(done, ms));
const errorText = error => error instanceof Error ? error.stack || error.message : String(error);
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const textOf = item => (item.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
const chat = id => page.locator(`[data-testid="session-chat-${id}"]`);
const map = () => page.locator(`.task-map[data-session-id="${parent.id}"][data-visible="true"]`);
const mapTabs = () => page.locator('.workspace-tab').filter({ has: page.locator('.workspace-tab-select[title^="Task map ·"], .workspace-tab-select[title^="任务图 ·"]') });
const tabFor = title => page.locator('.workspace-tab-select').filter({ hasText: title });

async function within(promise, ms, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out after ${ms} ms: ${description}`)), Math.max(1, ms)); })]);
  } finally { clearTimeout(timer); }
}
async function until(probe, description, timeout = 30_000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await within(Promise.resolve().then(probe), end - Date.now(), description); if (value) return value; }
    catch (error) { if (error.code === 'ERR_ASSERTION' || error.fatal) throw error; lastError = error; }
    if (Date.now() < end) await delay(Math.min(200, end - Date.now()));
  }
  throw Error(`Timed out after ${timeout} ms: ${description}${lastError ? `; last error: ${lastError.message}` : ''}`);
}
async function timed(name, action) {
  const at = performance.now();
  try { return await action(); }
  finally { report.timings.push({ name, ms: Math.round(performance.now() - at) }); }
}
function summary(value, depth = 0) {
  if (typeof value === 'string') return value.length > 4_000 ? `${value.slice(0, 4_000)}… [${value.length} characters]` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 12) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => summary(item, depth + 1)).concat(value.length > 200 ? [`[${value.length - 200} more entries]`] : []);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summary(item, depth + 1)]));
}
function assertScratch(path) {
  const absolute = resolve(path);
  assert.ok(scratch && resolve(scratch).startsWith(qaTemp + sep) && slug.startsWith('tt-task-map-live-'), 'scratch must be a run-specific directory under tt-qa-temp');
  assert.ok(absolute === resolve(scratch) || absolute.startsWith(resolve(scratch) + sep), `path must stay in this run's scratch directory: ${absolute}`);
}
function runGit(...gitArgs) {
  assertScratch(work);
  const result = spawnSync(gitExe, gitArgs, { cwd: work, env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, `scratch Git ${gitArgs[0]}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
function isolatedEnvironment() {
  writeFileSync(join(scratch, 'gitconfig'), ['[user]', '\tname = ThreadTerm QA', '\temail = qa@example.invalid', ''].join('\n'));
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const where = join(system32, 'where.exe');
  const locate = name => {
    const result = spawnSync(where, [name], { cwd: scratch, env: { ...process.env, TEMP: qaTemp, TMP: qaTemp }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, `where ${name}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  };
  gitExe = locate('git').find(path => /[\\/]cmd[\\/]git\.exe$/i.test(path));
  assert.ok(gitExe, 'Git cmd/git.exe must be installed');
  const kimiExe = locate('kimi').find(path => /[\\/]kimi\.exe$/i.test(path));
  assert.ok(kimiExe, 'where kimi must resolve kimi.exe');
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path|temp|tmp|git_.*|node_options|electron_run_as_node|threadterm_.*|claudecode|claude_code_.*|claude_pid)$/i.test(key)));
  Object.assign(isolated, {
    PATH: [dirname(process.execPath), dirname(gitExe), system32, dirname(kimiExe)].join(';'),
    TEMP: qaTemp, TMP: qaTemp, TT_QA_DESKTOP: '1',
    // A real (scratch) global config: the runtime's review checkpoints hash the file GIT_CONFIG_GLOBAL names, and
    // reading the NUL device fails with "Incorrect function (os error 1)", which disables every turn review.
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
    ...(process.env.THREADTERM_V3_SEND_TRACE === '1' ? { THREADTERM_V3_SEND_TRACE: '1' } : {}),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'plugins'),
  });
  assert.equal(Object.keys(isolated).filter(key => key.toLowerCase() === 'path').length, 1, 'exactly one spelling of PATH');
  for (const name of ['codex', 'claude', 'opencode', 'grok', 'gemini', 'pi', 'kimi']) {
    const result = spawnSync(where, [name], { cwd: scratch, env: isolated, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ok(!result.error, `isolated where ${name}: ${result.error?.message}`);
    if (name === 'kimi') {
      assert.equal(result.status, 0, 'Kimi resolves on the isolated PATH');
      assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(path => resolve(path).toLowerCase()), [resolve(kimiExe).toLowerCase()], 'only the selected kimi.exe resolves');
    } else {
      assert.equal(result.status, 1, `${name} must not resolve on the isolated PATH: ${result.stdout}`);
      assert.equal(result.stdout.trim(), '', `no executable found for ${name}`);
    }
  }
  report.isolation = { runtime, mcp: join(dirname(runtime), 'threadterm-v3-mcp.exe'), PATH: isolated.PATH, pathSpellings: Object.keys(isolated).filter(key => key.toLowerCase() === 'path'), desktop: 1 };
  return isolated;
}
async function control(pipe, timeout = 20_000) {
  let connection;
  let expired = false;
  try {
    const connecting = connectPeer(`${pipe}-control`);
    connecting.then(value => { if (expired) value.close(); }, () => {});
    try { connection = await within(connecting, timeout, 'connect QA control pipe'); }
    finally { expired = true; }
    await within(connection.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()), Math.min(timeout, 10_000), 'authenticate QA control pipe');
    return connection;
  } catch (error) { connection?.close(); throw error; }
}
async function pipeRequest(method, params = {}, timeout = 20_000) {
  assert.ok(peer && !peer.closed, `QA control peer is connected for ${method}`);
  return within(peer.request(method, params, timeout), timeout, `runtime ${method}`);
}
const request = (method, params = {}, timeout = 20_000) => within(page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]), timeout, `app bridge ${method}`);
async function settings(send, patch) {
  const snapshot = await send('runtime.snapshot');
  await send('settings.update', { patch: { ...patch, notifications }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
}
async function startRuntime() {
  activePipe = `\\\\.\\pipe\\tt-task-map-live-A-${randomUUID()}`;
  const log = openSync(join(scratch, 'runtime.log'), 'a');
  try { daemon = spawn(runtime, [], { cwd: scratch, env: { ...env, THREADTERM_V3_PIPE: activePipe }, windowsHide: true, stdio: ['ignore', 'ignore', log] }); }
  finally { closeSync(log); }
  daemon.on('error', error => { daemonError = error; });
  await until(async () => {
    if (daemonError || daemon.exitCode !== null) throw Object.assign(Error(`QA runtime startup failed: ${daemonError?.message ?? daemon.exitCode}`), { fatal: true });
    try { peer = await control(activePipe, 2_000); return true; } catch { return false; }
  }, 'QA runtime is running and authenticated (see runtime.log)', 30_000);
}
async function waitForExit(child, timeout, description) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await within(new Promise(done => child.once('exit', done)), timeout, description);
}
async function stopRuntime() {
  // Graceful first: the runtime ends its supervised Kimi workers; a hard kill could orphan them.
  if (peer && !peer.closed && daemon && daemon.exitCode === null) {
    await within(peer.request('runtime.shutdown', { operationId: randomUUID() }, 15_000), 15_000, 'Phase A runtime.shutdown').catch(error => report.errors.push(`phase A shutdown: ${error.message}`));
    await waitForExit(daemon, 15_000, 'Phase A runtime exits after shutdown').catch(() => {});
  }
  peer?.close(); peer = undefined;
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  await waitForExit(daemon, 10_000, 'Phase A runtime exits and releases its data directory');
  daemon = undefined;
}
async function renew(force = false) {
  if (!force && Date.now() - lease.renewed < 8_000) return;
  lease.epoch = (await pipeRequest('session.renew', { sessionId: lease.sessionId, leaseEpoch: lease.epoch })).leaseEpoch;
  lease.renewed = Date.now();
}
async function open() {
  await until(async () => (await pipeRequest('provider.list')).find(row => row.id === 'kimi' && row.chat && row.installed), 'real Kimi Chat provider is installed', 45_000);
  const project = await pipeRequest('project.add', { path: work, name: 'Task map live QA', operationId: randomUUID() });
  parent = await pipeRequest('session.create', { projectId: project.id, cwd: work, title: 'Task map live QA', provider: 'kimi', mode: 'chat', operationId: randomUUID() });
  sessionIds.add(parent.id); lease.sessionId = parent.id;
  lease.epoch = (await pipeRequest('session.claim', { sessionId: parent.id, clientId: 'qa-task-map-live' })).leaseEpoch;
  lease.renewed = Date.now();
  const state = await pipeRequest('chat.connect', { sessionId: parent.id, leaseEpoch: lease.epoch, operationId: randomUUID() }, 60_000);
  assert.equal(state.phase, 'ready', `Kimi Chat connects: ${JSON.stringify(state)}`);
}
async function set() {
  await renew(true);
  await pipeRequest('chat.option.set', { sessionId: parent.id, leaseEpoch: lease.epoch, optionId: 'mode', value: 'yolo', operationId: randomUUID() }, 30_000);
  const options = await pipeRequest('chat.options', { sessionId: parent.id });
  assert.equal(options.options.find(option => option.id === 'mode')?.value, 'yolo', 'Kimi confirms yolo mode');
}
function assertNoTurnErrors(items, description) {
  const errors = items.flatMap(item => (item.parts ?? []).filter(part => part.type === 'error' || (part.type === 'approval' && part.status === 'pending')));
  assert.equal(errors.length, 0, `${description}: no provider errors or pending approvals: ${JSON.stringify(summary(errors))}`);
}
async function oneTurn() {
  const deadline = Date.now() + 360_000;
  await renew(true);
  const { turnId } = await pipeRequest('chat.send', { sessionId: parent.id, text: prompt, leaseEpoch: lease.epoch, operationId: randomUUID() });
  report.firstTurnId = turnId;
  await until(async () => {
    await renew();
    const snapshot = await pipeRequest('runtime.snapshot');
    const children = snapshot.sessions.filter(row => row.delegation?.parentSessionId === parent.id);
    for (const child of children) { sessionIds.add(child.id); assert.equal(child.provider, 'kimi', 'all delegates use real Kimi only'); }
    assert.ok(children.length <= 1, `one delegate requested, found ${children.length}`);
    delegate = children[0];
    parentItems = await pipeRequest('chat.read', { sessionId: parent.id });
    assertNoTurnErrors(parentItems, 'parent turn');
    if (delegate && ['failed', 'cancelled', 'awaiting_user'].includes(delegate.delegation.state)) throw Object.assign(Error(`Kimi delegate ${delegate.title}: ${delegate.delegation.state}`), { fatal: true });
    const row = snapshot.sessions.find(candidate => candidate.id === parent.id);
    return row?.activity?.turnId === turnId && ['idle', 'awaiting_input'].includes(row.activity.state) && delegate?.delegation.state === 'completed';
  }, 'parent turn and Kimi delegation both complete within six minutes', Math.max(1, deadline - Date.now()));
  assert.equal(delegate.title, 'QA map delegate', 'delegate uses the requested title');
  // The after-turn review tree is captured on a runtime worker after completion; stopping the runtime earlier drops
  // `turnReview` (the map's "files changed" source). Wait for both turns, then record a finding if one never arrives.
  for (const [label, id] of [['parent', parent.id], ['delegate', delegate.id]]) {
    try {
      await until(async () => { await renew(); return (await pipeRequest('chat.read', { sessionId: id })).some(item => item.turnReview); }, `${label} turn review attached`, 60_000);
    } catch (error) { report.findings.push(`${label}: no turnReview within 60 s after completion (${error.message})`); }
  }
  parentItems = await pipeRequest('chat.read', { sessionId: parent.id });
  delegateItems = await pipeRequest('chat.read', { sessionId: delegate.id });
  report.recordedItems = { parent: summary(parentItems), delegate: summary(delegateItems) };
  report.sessions = { parent: summary(parent), delegate: summary(delegate) };
  assertNoTurnErrors(delegateItems, 'delegate turn');
  assert.ok(parentItems.some(item => item.role === 'assistant' && textOf(item).trim().startsWith('PARENT-OK')), 'parent reply starts with PARENT-OK');
  // Models sometimes add a sentence after the token; the files on disk are the hard evidence.
  assert.ok(delegateItems.some(item => item.role === 'assistant' && textOf(item).trim().startsWith('CHILD-OK')), 'delegate reply starts with CHILD-OK');
  for (const name of ['delegate_start', 'delegate_wait', 'delegate_result']) {
    assert.ok(parentItems.some(item => (item.parts ?? []).some(part => part.type === 'tool' && JSON.stringify(part).includes(name))), `parent recorded the real ${name} tool call`);
  }
  for (const [file, expected] of [['notes.md', 'parent-ok'], ['child.md', 'child-ok']]) {
    assert.equal((await readFile(join(work, file), 'utf8')).replace(/\r\n/g, '\n').replace(/\n$/, ''), expected, `${file} contains exactly its expected line`);
  }
  await pipeRequest('session.release', { sessionId: parent.id, leaseEpoch: lease.epoch });
  check('Phase A: real Kimi parent/delegate complete and create notes.md + child.md');
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'task-map-live-qa', version: '0.1.0', main: 'main.cjs' }));
}
async function screenshot(name) {
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(out, name), animations: 'disabled', timeout: 15_000 });
  report.screenshots.push(name);
}
async function evidence(name, description) { await screenshot(`${name}.png`); check(description); }
async function present(session) {
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => chat(session.id).isVisible(), `session ${session.title} is shown in the workspace`);
  await until(async () => (await tabFor(session.title).getAttribute('aria-selected')) === 'true', `${session.title} workspace tab is active`);
}
const rows = () => map().locator('.task-map-row');
function steps(kind, sessionId) {
  const prefix = sessionId ? (kind === 'files' ? `outputs:files:agent:${sessionId}:` : `agent:${sessionId}:`) : '';
  return map().locator(`.task-map-row[data-row-kind="step"][data-node-kind="${kind}"]${prefix ? `[data-node-id^="${prefix}"]` : ''}`);
}
async function frames(count = 2) {
  await within(page.evaluate(n => new Promise(done => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : done(); step(n); }), count), 5_000, `${count} animation frames`);
}
async function expandAll() {
  const button = map().locator('.task-map-expand');
  if (/^(Expand all|展开全部|全部展开)$/.test((await button.innerText()).trim())) await button.click();
  await frames();
}
async function setSync(on) {
  const toggle = map().locator('.task-map-sync');
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
  await until(async () => (await map().getAttribute('data-sync')) === (on ? 'on' : 'off'), `Sync is ${on ? 'on' : 'off'}`);
}
async function openMap() {
  if (!(await mapTabs().count())) {
    await present(parent);
    await page.locator('.workspace-primary-actions').getByRole('button', { name: 'Task map', exact: true }).click();
  } else await mapTabs().locator('.workspace-tab-select').click();
  await until(async () => Number(await map().getAttribute('data-node-count')) > 0, 'visible task map loads real persisted items');
  await expandAll();
  await until(async () => await steps('reply', delegate.id).count() > 0, 'delegate snapshot loads its reply into the flow');
  assert.equal(await mapTabs().count(), 1, 'exactly one task map tab for the parent task');
}
async function closeDetails() {
  const details = map().locator('.task-map-details');
  if (await details.count()) { await details.first().press('Escape').catch(() => {}); await frames(); }
  if (await map().locator('.task-map-details').count()) {
    const open = map().locator('.task-map-row.is-selected .task-map-row-details');
    if (await open.count()) await open.click();
  }
}
async function openDetails(kind, sessionId) {
  await closeDetails();
  const row = steps(kind, sessionId).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const id = await row.getAttribute('data-node-id');
  await row.locator('.task-map-row-details').click();
  const details = map().locator('.task-map-details');
  await details.waitFor({ state: 'visible' });
  await until(async () => (await map().locator('.task-map-row.is-selected').first().getAttribute('data-node-id')) === id, `${kind} row is selected`);
  return details;
}
async function assertSideBySide(description) {
  const rects = await page.evaluate(id => {
    const rect = node => { if (!node || node.closest('[hidden]')) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return { chat: rect(document.querySelector(`[data-testid="session-chat-${id}"]`)), map: rect(document.querySelector(`.task-map[data-session-id="${id}"][data-visible="true"]`)) };
  }, parent.id);
  assert.ok(rects.chat?.width > 0 && rects.map?.width > 0, `${description}: Chat and map are visible`);
  assert.ok(rects.chat.right <= rects.map.left + 1 || rects.map.right <= rects.chat.left + 1, `${description}: Chat and map occupy separate horizontal panes`);
  assert.ok(Math.min(rects.chat.bottom, rects.map.bottom) - Math.max(rects.chat.top, rects.map.top) > 100, `${description}: panes share the visible vertical area`);
  report.geometry.push({ label: description, ...rects });
}
async function checkRows() {
  await expandAll();
  const turns = await rows().evaluateAll(list => list.filter(row => row.dataset.rowKind === 'turn').map(row => row.textContent));
  report.turnRows = turns;
  assert.equal(turns.length, 1, 'one turn row after the first turn');
  for (const kind of ['delegate', 'tools', 'reply']) assert.ok(await steps(kind, parent.id).count(), `root agent has a ${kind} row`);
  assert.equal(await steps('prompt', parent.id).count(), 0, 'the turn row stands for the root prompt (no separate prompt row)');
  const delegateRow = steps('delegate', parent.id).first();
  assert.equal(await delegateRow.getAttribute('data-depth'), '0', 'the delegate row belongs to the root agent');
  assert.ok((await delegateRow.innerText()).includes('QA map delegate') || (await delegateRow.getAttribute('title') ?? '').includes('QA map delegate'), 'the delegate row names the delegate');
  assert.ok(await delegateRow.evaluate(row => row.classList.contains('is-open')), 'Expand all opens the delegate row');
  const childReply = steps('reply', delegate.id).first();
  assert.equal(await childReply.getAttribute('data-depth'), '1', 'the delegate reply is nested one level under its start row');
  const order = await rows().evaluateAll(list => list.map(row => row.dataset.nodeId ?? row.dataset.rowKey));
  const start = order.indexOf(await delegateRow.getAttribute('data-node-id')), nested = order.indexOf(await childReply.getAttribute('data-node-id'));
  assert.ok(start >= 0 && nested > start, 'delegate steps follow the step that started the delegate');
  const hasReview = parentItems.some(item => item.turnReview);
  report.rootHasTurnReview = hasReview;
  if (hasReview) assert.ok(await steps('files', parent.id).count(), 'the turn shows its root files-changed row');
  else report.findings.push({ check: 'files/review', message: 'Kimi produced no root turnReview. Diff navigation cannot be required without checkpoints; recordedItems contains the raw chat.read items with long fields truncated.', items: summary(parentItems) });
  await evidence('02-rows', 'turn row, root steps, nested delegate steps and files row');
}
async function checkDetails() {
  await expandAll(); await setSync(false);
  const kinds = await map().locator('.task-map-row[data-row-kind="step"]').evaluateAll(list => [...new Set(list.map(row => row.dataset.nodeKind))]);
  report.detailKinds = kinds;
  for (const kind of kinds) {
    const details = await openDetails(kind, ['delegate'].includes(kind) ? parent.id : undefined);
    if (kind === 'delegate') await details.getByRole('button', { name: 'Open session', exact: true }).waitFor();
    await evidence(`details-${kind}`, `${kind} row opens its inline details`);
  }
  if (await steps('files', parent.id).count()) {
    const notes = () => map().locator('.task-map-details div').filter({ has: page.locator('code', { hasText: /(^|[\\/])notes\.md$/ }) }).last();
    await openDetails('files', parent.id);
    await notes().waitFor({ state: 'visible' });
    if (report.rootHasTurnReview) {
      await notes().getByRole('button', { name: 'Open diff', exact: true }).click();
      const reviewTab = page.locator('.workspace-tab-select[title^="Changes since checkpoint ·"][title*="notes.md"]');
      await reviewTab.waitFor({ state: 'visible' });
      assert.equal(await reviewTab.getAttribute('aria-selected'), 'true', 'Open diff activates the notes.md review tab');
      await evidence('03-open-diff', 'files details open the notes.md review tab');
      await openMap(); await setSync(false);
    } else report.findings.push({ check: 'Open diff', message: 'Root files have edit paths only, without turnReview; Open diff is unavailable.' });
    await openDetails('files', parent.id);
    await notes().getByRole('button', { name: 'Open file', exact: true }).click();
    await until(async () => await page.locator('.workspace-tab-select[aria-selected="true"][title="notes.md"]').count() === 1, 'Open file activates the notes.md file tab');
    await evidence('03-open-file', 'files details open notes.md as a file');
    await openMap();
  }
  await closeDetails(); await setSync(true);
}
async function chatLog() { return chat(parent.id).locator('.v3-chat-log'); }
// A settled turn renders an item twice (activity copy inside "Activity", response copy): the response copy must be on screen.
async function inLog(locator) {
  return locator.evaluateAll(nodes => nodes.some(node => {
    const log = node.closest('.v3-chat-log'); if (!log || !node.getClientRects().length || node.closest('details.codex-work')) return false;
    const r = node.getBoundingClientRect(), v = log.getBoundingClientRect();
    return Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) > 8;
  })).catch(() => false);
}
async function checkSync() {
  await assertSideBySide('sync: Chat beside the flow');
  await expandAll(); await setSync(true); await closeDetails();
  // Flow -> Chat: a tools row opens the Chat's tools drawer at that call.
  // A file/command step (delegation follow-ups render as delegate cards, not drawer tool cards).
  const toolsRow = steps('tools', parent.id).filter({ hasNotText: /delegate|委派/i }).first();
  const toolNode = await toolsRow.getAttribute('data-node-id');
  const toolPart = (() => {
    const [, , itemId, partIndex] = toolNode.match(/^agent:([^:]+):(.+):(\d+)$/) ?? [];
    const item = parentItems.find(row => row.id === itemId); const part = item?.parts?.[Number(partIndex)];
    return part ? part.toolId || `${itemId}:part:${partIndex}` : undefined;
  })();
  assert.ok(toolPart, `the tools row ${toolNode} maps to a recorded tool part`);
  const listTop = await map().locator('.task-map-list').evaluate(list => list.scrollTop);
  const log = await chatLog();
  await log.evaluate(node => { node.scrollTop = 0; });
  await toolsRow.click();
  const card = chat(parent.id).locator(`[data-tool-id="${toolPart}"]:not(details.codex-work [data-tool-id])`).first();
  await until(() => inLog(card), 'clicking a tools row scrolls the Chat to that tool card');
  assert.ok(await card.evaluate(node => Boolean(node.closest('details')?.open)), 'the Chat tools drawer containing the call is open');
  assert.ok(await toolsRow.evaluate(row => row.classList.contains('is-selected')), 'the clicked row is selected');
  await frames(4);
  assert.equal(await map().locator('.task-map-list').evaluate(list => list.scrollTop), listTop, 'the reveal does not scroll the flow back (no loop)');
  await until(async () => await map().locator(`.task-map-row.is-in-view[data-node-id="${toolNode}"]`).count() === 1, 'the revealed tools row is marked as on screen in the Chat');
  await evidence('04-sync-row-to-chat', 'tools row → Chat tools drawer opens at that call; row marked in view');
  // Chat -> flow: the bottom of the Chat marks the last reply.
  await log.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  const lastReply = steps('reply', parent.id).last();
  await until(() => lastReply.evaluate(row => row.classList.contains('is-in-view')), 'scrolling the Chat to the bottom marks the latest reply row');
  await evidence('05-sync-chat-to-row', 'Chat at the bottom → latest reply row marked');
  // Sync off: a click opens details and leaves the Chat alone.
  await setSync(false);
  const before = await log.evaluate(node => node.scrollTop);
  await toolsRow.click();
  await map().locator('.task-map-details').waitFor({ state: 'visible' });
  assert.equal(await log.evaluate(node => node.scrollTop), before, 'with Sync off a click does not move the Chat');
  assert.equal(await map().locator('.task-map-row.is-in-view').count(), 0, 'with Sync off no row is marked');
  await closeDetails(); await setSync(true);
  await evidence('06-sync-off', 'Sync off: inline details, Chat unchanged');
}
async function checkNavigation() {
  const promptItem = parentItems.find(item => item.role === 'user' && textOf(item).includes('notes.md'));
  assert.ok(promptItem, 'parent prompt was recorded');
  await setSync(false);
  const replyRow = steps('reply', parent.id).last();
  const replyItem = (await replyRow.getAttribute('data-node-id')).match(/^agent:[^:]+:(.+):\d+$/)?.[1];
  await chat(parent.id).locator('.v3-chat-log').evaluate(node => { node.scrollTop = 0; });
  const details = await openDetails('reply', parent.id);
  await details.getByRole('button', { name: 'Show in Chat', exact: true }).click();
  // The Chat is already on screen beside the map: it scrolls there without switching tabs.
  await until(() => inLog(chat(parent.id).locator(`[data-chat-item="${replyItem}"]`)), 'Show in Chat scrolls the visible parent Chat to the reply');
  await evidence('07-show-in-chat', 'Show in Chat reveals the reply in the parent Chat');
  await setSync(true); await closeDetails();
  const delegateDetails = await openDetails('delegate', parent.id);
  await delegateDetails.getByRole('button', { name: 'Open session', exact: true }).click();
  await until(() => chat(delegate.id).isVisible(), 'Open session shows the delegate Chat');
  await until(async () => (await tabFor('QA map delegate').getAttribute('aria-selected')) === 'true', 'delegate workspace title QA map delegate is selected');
  await evidence('08-open-session', 'Open session shows the QA map delegate Chat');
  // The delegate's own Task map button opens the same map focused on the delegate row.
  await page.locator('.workspace-primary-actions').getByRole('button', { name: 'Task map', exact: true }).click();
  await until(async () => (await mapTabs().locator('.workspace-tab-select').getAttribute('aria-selected')) === 'true', 'the delegate Chat opens the existing map tab');
  assert.equal(await mapTabs().count(), 1, 'the delegate reuses the parent task map tab');
  await until(() => steps('delegate', parent.id).first().evaluate(row => row.classList.contains('is-selected') && row.classList.contains('is-open')), 'the map selects and opens the delegate row');
  await evidence('09-focus-delegate', 'opening the map from the delegate selects its row');
  await present(parent); await openMap(); await closeDetails();
  const detailsToggle = page.getByRole('button', { name: 'Session details', exact: true });
  if (await detailsToggle.getAttribute('aria-pressed') !== 'true') await detailsToggle.click();
  const sessionDetails = page.locator('aside.inspector[aria-label="Session details"]');
  await sessionDetails.getByRole('button', { name: 'Task map', exact: true }).click();
  assert.equal(await mapTabs().count(), 1, 'Session details reuses the existing map tab');
  assert.equal(await mapTabs().locator('.workspace-tab-select').getAttribute('aria-selected'), 'true', 'Session details activates the map tab');
  await evidence('10-details-entry', 'Session details focuses the one existing task map tab');
  await detailsToggle.click();
}
async function checkLive() {
  await assertSideBySide('before live second turn');
  const identity = randomUUID();
  await map().evaluate((node, value) => node.setAttribute('data-qa-live-identity', value), identity);
  await evidence('11-live-before', 'Chat and map are side by side before the second turn');
  const composer = chat(parent.id).locator('.chat-compose-shell textarea');
  await until(() => composer.isEnabled(), 'parent Chat composer is ready after native resume', 60_000);
  const deadline = Date.now() + 180_000;
  await composer.fill(secondPrompt); await composer.press('Enter');
  let latest;
  await until(async () => {
    assert.equal(await map().getAttribute('data-qa-live-identity'), identity, 'the same map stays mounted throughout the live turn');
    latest = await request('chat.snapshot', { sessionId: parent.id }, Math.min(15_000, Math.max(1, deadline - Date.now())));
    const reply = latest.items.find(item => item.role === 'assistant' && textOf(item).trim().startsWith('SECOND-OK'));
    const completed = reply && latest.items.some(item => item.turnId === reply.turnId && item.turnStatus === 'completed');
    const turn2 = map().locator('.task-map-row[data-row-kind="turn"]').filter({ hasText: /Turn 2/ });
    return completed && await turn2.count() > 0 && await steps('reply', parent.id).evaluateAll(list => list.filter(row => row.dataset.phase === '1').length) > 0;
  }, 'Turn 2 and its reply row appear live without reopening the map', Math.max(1, deadline - Date.now()));
  report.recordedItems.secondTurn = summary(latest.items.filter(item => item.turnId === latest.items.find(row => row.role === 'user' && textOf(row).trim() === secondPrompt)?.turnId));
  assertNoTurnErrors(latest.items, 'live second turn');
  await assertSideBySide('after live second turn');
  await evidence('11-live-after', 'Turn 2 and its reply appear without reopening the map');
}
async function fullscreenMap(fullscreen) {
  const pane = map().locator('xpath=ancestor::section[@data-pane-id][1]');
  const current = await pane.evaluate(node => node.classList.contains('fullscreen'));
  if (current === fullscreen) return;
  await page.getByRole('button', { name: /^(Workspace actions|工作区操作)$/ }).click();
  await page.getByRole('button', { name: fullscreen ? /^(Fullscreen pane|全屏窗格)$/ : /^(Restore pane|退出窗格全屏)$/ }).click();
  await page.locator('.workspace-action-menu').waitFor({ state: 'hidden' });
  await until(async () => (await pane.evaluate(node => node.classList.contains('fullscreen'))) === fullscreen, 'map pane fullscreen state settles');
}
async function checkChatHidden() {
  // The Chat is not on screen (map pane fullscreen): with Sync on, a root row brings the Chat back at that step.
  await fullscreenMap(true); await setSync(true); await closeDetails();
  const reply = steps('reply', parent.id).first();
  const replyItem = (await reply.getAttribute('data-node-id')).match(/^agent:[^:]+:(.+):\d+$/)?.[1];
  await reply.click();
  await until(async () => await chat(parent.id).isVisible() && await inLog(chat(parent.id).locator(`[data-chat-item="${replyItem}"]`)), 'a root row click shows the Chat at that reply when the Chat was not on screen', 10_000);
  await evidence('12-chat-hidden-click', 'Chat not on screen: clicking a root row shows the Chat at that step');
  if (await mapTabs().count()) await openMap();
  await fullscreenMap(false).catch(error => report.findings.push({ check: 'restore pane', message: error.message }));
}
async function sizeMapPane() {
  await fullscreenMap(false);
  const divider = page.locator('[data-split-id] > .pane-divider:visible');
  assert.equal(await divider.count(), 1, 'one real workspace split divider for the map');
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await map().boundingBox();
    if (box.width >= 680 && box.width <= 720) return;
    const handle = await divider.boundingBox();
    assert.ok(handle, 'split divider has visible geometry');
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    const endX = x + (box.x > x ? box.width - 700 : 700 - box.width);
    await page.mouse.move(x, y); await page.mouse.down();
    try { await page.mouse.move(endX, y, { steps: 8 }); } finally { await page.mouse.up(); }
    await delay(150);
  }
  const box = await map().boundingBox();
  assert.ok(box.width >= 680 && box.width <= 720, `real map pane must be approximately 700 px; measured ${box.width}`);
}
async function mapGeometry(description) {
  const geometry = await map().evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const list = element.querySelector('.task-map-list');
    const boxes = [...element.querySelectorAll('.task-map-row')].map(node => ({ key: node.dataset.rowKey, ...rect(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    const controls = [...element.querySelectorAll('.task-map-toolbar button, .task-map-toolbar .chip')].filter(node => node.getClientRects().length).map(node => ({ text: node.getAttribute('aria-label') || node.textContent, ...rect(node) }));
    return { viewportWidth: innerWidth, map: rect(element), list: { ...rect(list), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth }, boxes, controls };
  });
  assert.equal(geometry.viewportWidth, 1440, `${description}: desktop viewport is 1440 px`);
  assert.ok(geometry.boxes.length > 0, `${description}: measured flow rows`);
  assert.ok(geometry.list.scrollWidth <= geometry.list.clientWidth + 1, `${description}: the list does not overflow horizontally`);
  const sorted = [...geometry.boxes].sort((a, b) => a.top - b.top);
  for (let index = 1; index < sorted.length; index++) assert.ok(sorted[index].top >= sorted[index - 1].bottom - 1 || sorted[index].key === sorted[index - 1].key, `${description}: ${sorted[index - 1].key} overlaps ${sorted[index].key}`);
  for (const box of geometry.boxes) assert.ok(box.right <= geometry.list.right + 1, `${description}: row ${box.key} stays inside the list`);
  const heights = geometry.controls.map(control => control.height);
  assert.ok(heights.length >= 3, `${description}: toolbar controls were collected`);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 0.5, `${description}: toolbar controls share one height: ${JSON.stringify(geometry.controls)}`);
  report.geometry.push({ label: description, ...geometry });
  const consistency = await checkControlConsistency(page, `.task-map[data-session-id="${parent.id}"][data-visible="true"] .task-map-toolbar`, { checkStates: true, checkDisabledRows: true });
  report.visualConsistency.push({ label: description, ...consistency });
  assert.ok(!consistency.error, `${description}: ${consistency.error ?? ''}`);
  assert.ok(consistency.checked >= 3, `${description}: visual helper saw toolbar controls`);
  assert.deepEqual(consistency.violations, [], `${description}: ${JSON.stringify(consistency.violations)}`);
}
async function checkMatrix() {
  await closeDetails();
  for (const width of ['wide', '700']) {
    if (width === 'wide') await fullscreenMap(true); else await sizeMapPane();
    for (const theme of ['dark', 'light']) for (const language of ['en', 'zh-CN']) {
      const cell = `${theme}-${language}-${width}`;
      await settings(request, { theme, themeSelection: theme, language });
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme, { timeout: 10_000 });
      await until(async () => (await map().locator('.task-map-toolbar').innerText()).includes(language === 'en' ? 'Task map' : '任务图'), `${cell}: map language updates`);
      await frames();
      if (width === '700') {
        const box = await map().boundingBox();
        assert.ok(box.width >= 680 && box.width <= 720, `${cell}: map pane remains approximately 700 px (${box.width})`);
      }
      await mapGeometry(cell);
      await evidence(`13-matrix-${cell}`, `${cell}: rows stacked, no horizontal overflow, consistent toolbar controls`);
    }
  }
}
async function cleanup() {
  page?.removeAllListeners('pageerror'); page?.removeAllListeners('console');
  // Use an independent control peer even if the renderer or its transport failed.
  peer?.close(); peer = undefined;
  let cleanupPeer;
  if (activePipe && existsSync(join(data, 'runtime.credential'))) {
    try {
      cleanupPeer = await control(activePipe, 5_000);
      const send = (method, params = {}) => within(cleanupPeer.request(method, params, 10_000), 10_000, `cleanup ${method}`);
      try { for (const row of (await send('runtime.snapshot')).sessions) sessionIds.add(row.id); }
      catch (error) { report.cleanup.push(`snapshot unavailable: ${error.message}`); }
      for (const sessionId of sessionIds) {
        try { await send('session.stop', { sessionId, force: true, operationId: randomUUID() }); report.cleanup.push(`stopped ${sessionId}`); }
        catch (error) { report.errors.push(`cleanup session.stop ${sessionId}: ${error.message}`); }
      }
      try { await send('runtime.shutdown', { operationId: randomUUID() }); report.cleanup.push('runtime.shutdown sent'); }
      catch (error) { report.errors.push(`cleanup runtime.shutdown: ${error.message}`); }
    } catch (error) {
      if (app || (daemon && daemon.exitCode === null)) report.errors.push(`cleanup control connection: ${error.message}`);
      else report.cleanup.push(`runtime already stopped: ${error.message}`);
    } finally { cleanupPeer?.close(); }
  }
  if (app) {
    // Playwright disposes the application channel on close; app.process() afterwards throws ("reading '_object'").
    const child = app.process();
    try { await within(app.evaluate(({ app: electronApp }) => electronApp.exit(0)), 5_000, 'Electron exit'); }
    catch (error) { report.cleanup.push(`Electron exit: ${error.message}`); }
    try { await within(app.close(), 10_000, 'Electron close'); }
    catch (error) { child.kill(); report.errors.push(`cleanup Electron close: ${error.message}`); }
    try { await waitForExit(child, 5_000, 'Electron process exits'); }
    catch (error) { report.errors.push(`cleanup: ${error.message}`); }
  }
  try { await stopRuntime(); } catch (error) { report.errors.push(`cleanup runtime process: ${error.message}`); }
  if (slug) {
    // Providers may flush their history just after the supervised process exits.
    await delay(2_000);
    try {
      let leftovers = removeAgentHistory(slug);
      if (leftovers.length) { await delay(2_000); leftovers = removeAgentHistory(slug); }
      report.cleanup.push({ historySlug: slug, leftovers });
      if (leftovers.length) report.errors.push(`agent history remains: ${leftovers.join(' | ')}`);
    } catch (error) { report.errors.push(`cleanup agent history: ${error.message}`); }
  }
  if (scratch) {
    for (const [source, target] of [[join(scratch, 'runtime.log'), 'runtime-A.log'], [join(data, 'runtime.log'), 'runtime-B.log']]) if (existsSync(source)) {
      try { await writeFile(join(out, target), await readFile(source)); }
      catch (error) { report.errors.push(`preserve ${target}: ${error.message}`); }
    }
    if (keep) report.cleanup.push(`--keep: retained ${scratch}`);
    else {
      try { assertScratch(scratch); await within(rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }), 20_000, 'delete this run scratch directory'); report.cleanup.push('scratch removed'); }
      catch (error) { report.errors.push(`cleanup scratch ${scratch}: ${error.message}`); }
    }
  }
}

try {
  assert.equal(process.platform, 'win32', 'this harness requires Windows and Desktop 1');
  process.env.TEMP = qaTemp; process.env.TMP = qaTemp;
  process.env.TT_QA_DESKTOP = '1';
  assert.equal(runtime.toLowerCase(), resolve(expectedRuntime).toLowerCase(), `Refusing non-QA runtime: ${runtime}`);
  assert.match(runtime, /runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/i, 'QA debug runtime only');
  assert.ok(existsSync(runtime), `build the QA runtime first: ${runtime}`);
  assert.ok(existsSync(join(dirname(runtime), 'threadterm-v3-mcp.exe')), 'build the QA MCP beside the QA runtime');
  await mkdir(out, { recursive: true }); await mkdir(qaTemp, { recursive: true });
  scratch = await mkdtemp(join(qaTemp, 'tt-task-map-live-'));
  slug = scratch.split(/[\\/]/).at(-1).toLowerCase();
  work = join(scratch, 'repo'); data = join(scratch, 'data'); appDir = join(scratch, 'app');
  report.scratch = scratch;
  assertScratch(scratch);
  await mkdir(work); await mkdir(data); await mkdir(join(scratch, 'plugins'));
  env = isolatedEnvironment();
  check('only real Kimi resolves on the four-directory PATH; QA debug runtime/MCP and D: scratch are isolated');
  await writeFile(join(work, 'README.md'), 'Task map live QA scratch repository.\n');
  runGit('init', '-q'); runGit('config', 'user.email', 'qa@example.invalid'); runGit('config', 'user.name', 'ThreadTerm QA');
  runGit('add', 'README.md'); runGit('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', 'commit', '-qm', 'initial');
  await timed('Phase A', async () => {
    await startRuntime();
    await settings(pipeRequest, { language: 'en', theme: 'dark', themeSelection: 'dark' });
    await open(); await set(); await oneTurn(); await stopRuntime();
  });
  await timed('build production app', () => within(buildApp(), 180_000, 'Vite renderer and esbuild desktop build'));
  activePipe = `\\\\.\\pipe\\tt-task-map-live-B-${randomUUID()}`;
  app = await electron.launch({ args: [appDir], cwd: root, env: { ...env, THREADTERM_V3_PIPE: activePipe }, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  app.process().stderr?.on('data', chunk => { report.desktopLog = `${report.desktopLog ?? ''}${chunk}`.slice(-20_000); });
  await page.waitForFunction(() => Boolean(window.threadterm), undefined, { timeout: 30_000 });
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await within(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)), 10_000, 'size Desktop 1 app to 1440 by 900');
  await settings(request, { language: 'en', theme: 'dark', themeSelection: 'dark' });
  await timed('01 open map', async () => {
    await present(parent); await openMap(); await assertSideBySide('initial wide companion placement');
    await evidence('01-open-map', 'Chat toolbar opens one Task map companion tab beside Chat');
  });
  await timed('02 rows', checkRows);
  await timed('03 details and diff', checkDetails);
  await timed('04 sync with Chat', checkSync);
  await timed('05 navigation and entry points', checkNavigation);
  await timed('06 live second turn', checkLive);
  await timed('07 Chat not on screen', checkChatHidden);
  await timed('08 visual matrix', checkMatrix);
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  await evidence('09-no-errors', 'no renderer page errors or console errors');
  report.acceptance = { exercised: ['A1 real Kimi root + nested delegate steps + files row', 'A2 inline details of every row kind in this real turn; Show in Chat, Open session, Open file, Open diff when checkpoints exist', 'Sync: row click opens the Chat tools drawer at that call, Chat scroll marks rows, Sync off, Chat not on screen', 'A3 visible live second turn without reopening', 'A5 dark/light × en/zh-CN × wide/~700 map pane'], notCovered: ['native subagents and nested delegation (fixture harness covers them)', 'hidden-map request/render inactivity (fixture harness covers it)', 'custom theme (fixture harness covers it)'] };
} catch (error) {
  report.errors.push(errorText(error));
  try {
    const send = peer && !peer.closed ? pipeRequest : page && !page.isClosed() ? request : undefined;
    if (send) {
      report.failureSnapshot = summary(await send('runtime.snapshot', {}, 5_000));
      for (const row of report.failureSnapshot.sessions ?? []) if (row.delegation?.parentSessionId === parent?.id) { delegate ??= row; sessionIds.add(row.id); }
      if (parent) parentItems = await send('chat.read', { sessionId: parent.id }, 5_000);
      if (delegate) delegateItems = await send('chat.read', { sessionId: delegate.id }, 5_000);
    }
  } catch (diagnosticError) { report.findings.push({ check: 'failure evidence', message: diagnosticError.message }); }
  if (!report.recordedItems.parent && parentItems.length) report.recordedItems.parent = summary(parentItems);
  if (!report.recordedItems.delegate && delegateItems.length) report.recordedItems.delegate = summary(delegateItems);
  if (page) await screenshot('failure.png').catch(() => {});
} finally {
  await cleanup().catch(error => report.errors.push(`cleanup: ${errorText(error)}`));
  if (oldDesktop === undefined) delete process.env.TT_QA_DESKTOP; else process.env.TT_QA_DESKTOP = oldDesktop;
  report.passed = report.errors.length === 0;
  report.finishedAt = new Date().toISOString(); report.timings.push({ name: 'total including cleanup', ms: Math.round(performance.now() - started) });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed ? 'TASK MAP LIVE QA PASSED' : 'TASK MAP LIVE QA FAILED'}; ${join(out, 'report.json')}`);
  if (!report.passed) { console.error(report.errors.join('\n')); process.exitCode = 1; }
}
