// Opt-in real-agent acceptance. Each scenario owns a scratch repository and profile.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { removeAgentHistory } from './agent-history.mjs';
import { collectGroupLayout } from './lib/group-layout-check.mjs';

const scenarios = { independent: ['claude', 'codex', 'kimi'], sequence: ['codex', 'claude', 'grok'], recovery: ['codex'], extras: ['pi', 'opencode'] };
const scenario = process.argv[2];
const claudeMode = process.argv.find(arg => arg.startsWith('--claude-mode='))?.split('=')[1] || 'dontAsk';
const codexSandbox = process.argv.find(arg => arg.startsWith('--codex-sandbox='))?.split('=')[1] || 'workspace-write';
const resultsName = process.argv.find(arg => arg.startsWith('--results='))?.split('=')[1] || 'group-chat-live';
assert.match(resultsName, /^group-chat-[a-z0-9-]+$/);
if (!scenarios[scenario]) throw Error(`Usage: node qa/group-chat-live.mjs ${Object.keys(scenarios).join('|')} [--prepare]`);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = resolve(process.env.TEMP || process.env.TMP || tmpdir());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.match(runtime.replaceAll('\\', '/'), /\/runtime\/target-qa\/debug\/threadterm-v3-runtime\.exe$/i);
assert.ok(existsSync(runtime), 'Build runtime/target-qa first');
const scratch = await mkdtemp(join(temp, 'tt-group-live-'));
const slug = scratch.split(/[\\/]/).at(-1).toLowerCase();
const work = join(scratch, 'work'), appDir = join(scratch, 'app'), bin = join(scratch, 'bin');
const out = join(root, 'qa/results', resultsName, `${scenario}-${slug}`);
const lock = join(temp, 'qa-electron.lock');
const report = { scenario, slug, scratch, preparedOnly: process.argv.includes('--prepare'), passed: false, checks: [], providers: {}, turns: [], errors: [], screenshots: [], privacy: [], approvals: [], layout: [] };
let app, page, held = false, groupId, launchEnv;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const group = () => page.locator('[data-testid=group-view]:visible');
const box = () => group().getByTestId('group-message');
const read = () => request('group.read', { id: groupId });
const textOf = item => (item.parts ?? []).filter(part => part.type === 'text').map(part => part.text || '').join('');
const terminal = ['replied', 'failed', 'stopped'];
async function until(fn, label, ms = 180000) {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(400); }
}
function executable(name, optional = false) {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  const path = probe.status === 0 && probe.stdout.split(/\r?\n/).find(path => process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(path));
  if (!path && !optional) throw Error(`Missing prerequisite: install ${name} and add it to PATH`);
  return path && resolve(path);
}
async function wrapper(name, path) {
  assert.ok(!/["%\r\n]/.test(path), 'Safe resolved executable path');
  const file = join(bin, `${name}.cmd`), gate = join(bin, `disable-${name}`);
  await writeFile(file, `@echo off\r\nif exist "${gate}" exit /b 87\r\n${/\.(cmd|bat)$/i.test(path) ? 'call ' : ''}"${path}" %*\r\n`);
  return file;
}
async function environment() {
  await mkdir(bin, { recursive: true });
  const commands = {};
  for (const name of [...scenarios[scenario], 'git', 'pwsh']) {
    const path = executable(name, name === 'pwsh');
    if (path) { commands[name] = path; await wrapper(name, path); }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && !/^(THREADTERM_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|ELECTRON_RUN_AS_NODE)/i.test(key)));
  env.PATH = [bin, dirname(process.execPath), dirname(commands.git), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')] : [])].join(delimiter);
  Object.assign(env, { TEMP: temp, TMP: temp, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-group-live-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'plugins'), THREADTERM_CLAUDE_SDK_HOST: join(root, 'providers/claude-sdk/src/main.mjs'), PI_CODING_AGENT_SESSION_DIR: join(scratch, 'pi-sessions') });
  report.pathCommands = Object.keys(commands);
  return { env, git: commands.git };
}
async function acquire() {
  const end = Date.now() + 2400000;
  for (;;) { try { await mkdir(lock); held = true; await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, scratch })); return; } catch (error) { if (error.code !== 'EEXIST') throw error; if (Date.now() > end) throw Error('Electron QA lock timeout'); console.log('WAIT Electron QA lock'); await delay(15000); } }
}
async function build() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'group-chat-live-qa', version: '0.0.0', main: 'main.cjs' }));
}
async function launch() {
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: work, env: launchEnv, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(15000);
  await page.addLocatorHandler(page.locator('body:not(:has(.overlay)) .attention-toast'), async () => { await page.getByRole('button', { name: /Dismiss notification|关闭通知/, exact: true }).click({ timeout: 2000 }).catch(() => {}); }, { noWaitAfter: true });
  page.on('pageerror', error => report.errors.push(`renderer: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
}
async function close() {
  if (page) await Promise.race([request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}), delay(5000)]);
  if (app) { await Promise.race([app.evaluate(({ app }) => app.exit(0)).catch(() => {}), delay(2000)]); await Promise.race([app.close().catch(() => {}), delay(3000)]); try { app.process()?.kill(); } catch {} }
  app = page = undefined;
}
async function take(name) {
  const dismiss = page.getByRole('button', { name: /Dismiss notification|关闭通知/, exact: true });
  if (await dismiss.count()) await dismiss.first().click().catch(() => {});
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); report.screenshots.push(`${name}.png`);
  if (await group().count()) report.layout.push(await collectGroupLayout(page, name));
}
async function openRoom() {
  await page.locator(`.group-row[data-group-id="${groupId}"]`).click();
  await group().waitFor(); await until(() => group().getAttribute('data-group-id').then(id => id === groupId), 'room opens');
}
async function configure(member) {
  const { sessionId, provider, mode } = member;
  const started = Date.now();
  let leaseEpoch = (await request('session.claim', { sessionId, clientId: `group-live-${slug}` })).leaseEpoch;
  const state = await request('chat.connect', { sessionId, leaseEpoch, operationId: randomUUID() });
  assert.equal(state.phase, 'ready', `${provider} connects: ${JSON.stringify(state)}`);
  const get = () => request('chat.options', { sessionId });
  const set = async (id, value) => {
    const option = (await get()).options.find(option => option.id === id);
    if (!option?.choices?.some(choice => choice.value === value)) return false;
    leaseEpoch = (await request('session.renew', { sessionId, leaseEpoch })).leaseEpoch;
    await request('chat.option.set', { sessionId, leaseEpoch, optionId: id, value, operationId: randomUUID() }); return true;
  };
  const before = await get();
  if (mode !== 'read_only') {
    if (provider === 'codex') { assert.ok(await set('mode', 'never')); assert.ok(await set('sandbox', codexSandbox)); assert.ok(await set('model', 'gpt-6-luna')); await set('thinking', 'low'); }
    if (provider === 'claude') { const model = before.options.find(option => option.id === 'model')?.choices.find(choice => /haiku/i.test(`${choice.value} ${choice.name}`)); assert.ok(model, 'Haiku is offered'); await set('model', model.value); assert.ok(await set('mode', claudeMode)); }
    if (provider === 'kimi') { assert.ok(await set('mode', 'yolo') || await set('mode', 'auto')); await set('model', 'kimi-code/k3'); }
    if (provider === 'grok') assert.ok(await set('mode', 'bypassPermissions') || await set('mode', 'auto'));
    if (provider === 'pi') {
      const model = before.options.find(option => option.id === 'model')?.choices.find(choice => /command-copy/.test(choice.value) && /deepseek-v4.1-flash-fast/.test(choice.value));
      if (model) await set('model', model.value);
      await request('chat.projectTrust.set', { sessionId, leaseEpoch, decision: 'trusted', operationId: randomUUID() });
    }
  }
  report.providers[provider] = { ...(report.providers[provider] || {}), connectMs: Date.now() - started, optionsBefore: before, options: await get(), nativeId: state.nativeId, memberMode: mode };
  await request('session.release', { sessionId, leaseEpoch });
  console.log(`READY ${provider} ${JSON.stringify(report.providers[provider].options.options.map(({ id, value }) => ({ id, value })))}`);
}
async function create() {
  const project = await request('project.add', { path: work, name: `Group live ${scenario}`, operationId: randomUUID() });
  report.prerequisites = await request('group.prerequisites', { cwd: work, providers: scenarios[scenario] });
  await writeFile(join(out, 'prerequisites.json'), JSON.stringify(report.prerequisites, null, 2));
  const state = await request('group.create', { cwd: work, projectId: project.id, title: `Live ${scenario}`, members: scenarios[scenario].map(provider => ({ provider, handle: provider, mode: scenario === 'sequence' && provider === 'grok' ? 'read_only' : 'default' })), operationId: randomUUID() });
  groupId = state.id; report.groupId = groupId;
  for (const member of state.members) {
    try { await configure(member); }
    catch (error) { if (scenario !== 'extras') throw error; report.providers[member.provider] = { configurationError: error.message }; }
  }
  await openRoom();
}
async function send(text, { wait = true } = {}) {
  await box().fill(text); await until(() => group().getByTestId('group-send').isEnabled(), 'send enabled');
  let retries = 0;
  await group().getByTestId('group-send').click();
  await until(async () => {
    if ((await box().inputValue()) === '') return true;
    const alert = group().getByRole('alert');
    if (await alert.count() && (await alert.innerText()).includes('The group changed.') && await group().getByTestId('group-send').isEnabled()) { assert.ok(retries++ < 4); await group().getByTestId('group-send').click(); }
    return false;
  }, 'message accepted');
  const message = [...(await read()).messages].reverse().find(message => message.author === 'user' && message.body === text);
  assert.ok(message); report.turns.push({ messageId: message.id, text, acceptedAt: Date.now() });
  if (wait) await settled(message.id);
  return message.id;
}
async function settled(id) {
  const seen = new Set(), answered = new Set();
  const message = await until(async () => {
    const state = await read(), message = state.messages.find(message => message.id === id);
    const turn = report.turns.find(turn => turn.messageId === id);
    for (const delivery of message?.deliveries ?? []) {
      const key = `${delivery.handle}:${delivery.state}`;
      if (!seen.has(key)) { seen.add(key); (turn.states ??= []).push({ handle: delivery.handle, state: delivery.state, at: Date.now(), error: delivery.error }); console.log(`STATE ${delivery.handle} ${delivery.state} ${delivery.error || ''}`); }
      if (delivery.state === 'needs_user') {
        const items = await request('chat.read', { sessionId: delivery.sessionId });
        const pending = items.flatMap(item => item.parts.filter(part => part.type === 'approval' && part.status === 'pending' && !answered.has(part.approvalId)));
        if (!pending.length) return false;
        report.approvals.push({ messageId: id, handle: delivery.handle, pending });
        const testOnly = scenario === 'sequence' && delivery.handle === 'claude' && pending.length && pending.every(part => part.data?.details?.toolName === 'Bash' && /node\s+--test\s+test\/slugify\.test\.cjs/.test(part.data?.details?.input?.command || ''));
        if (!testOnly) throw Error(`Unexpected approval interruption: @${delivery.handle}; recorded without auto-approval`);
        await group().getByTestId(`group-live-${id}-${delivery.handle}`).getByRole('button', { name: 'Respond in Chat', exact: true }).click();
        await page.getByRole('button', { name: /^Allow once\b/ }).first().click();
        for (const part of pending) answered.add(part.approvalId);
        await openRoom();
        check('Group needs-you opens the native Chat; the requested scratch-only Node test receives Allow once');
      }
    }
    return message?.deliveries?.every(delivery => terminal.includes(delivery.state)) && message;
  }, `deliveries ${id}`, 300000);
  const turn = report.turns.find(turn => turn.messageId === id); turn.settledAt = Date.now(); turn.deliveries = message.deliveries;
  console.log(`SETTLED ${id} ${message.deliveries.map(delivery => `${delivery.handle}:${delivery.state}`).join(',')}`);
  await evidence(); return message;
}
const reply = async (handle, parentId) => [...(await read()).messages].reverse().find(message => message.author === 'member' && message.handle === handle && (!parentId || message.replyTo === parentId));
async function requireReplies(id, handles) {
  const state = await read(), message = state.messages.find(message => message.id === id);
  for (const handle of handles) { const delivery = message.deliveries.find(delivery => delivery.handle === handle); assert.equal(delivery?.state, 'replied', `${handle}: ${delivery?.error || delivery?.state}`); assert.ok(await reply(handle), `${handle} reply captured`); }
}
async function handoff(from, to, text) {
  const picker = group().locator(`[data-message-id="${from.id}"]`).getByRole('combobox', { name: 'Hand off to' });
  await picker.click(); await page.locator(`[role=option][data-value="${to}"]`).click();
  await until(() => box().inputValue().then(value => value.startsWith(`@${to} `)), 'handoff prefill');
  await group().getByTestId('group-includes').waitFor();
  return send(`@${to} ${text}`);
}
async function independent() {
  const first = await send('@All Write a one-page HTML landing page for Lantern Notes, a simple offline notebook. Create pages/<your handle>/index.html, replacing <your handle> with your own handle. Make each page self-contained, with no network assets, links or services. Only write your own page, do not read other members files, and do not delegate or open a browser. Include a hero, three benefits, a short pricing comparison table, and a Chinese tagline. Reply in Markdown with the path, a short summary and a Markdown table.', { wait: false });
  await until(async () => (await read()).messages.find(message => message.id === first)?.deliveries.filter(delivery => delivery.state === 'working').length === 3, 'three agents working');
  await take('run1-working-1280'); await settled(first);
  await requireReplies(first, scenarios.independent);
  for (const handle of scenarios.independent) {
    assert.ok(existsSync(join(work, 'pages', handle, 'index.html')), `${handle} actual page exists`);
    const value = await reply(handle); assert.ok(value.outputs.files.some(file => file.replaceAll('\\', '/').endsWith(`pages/${handle}/index.html`)), `${handle} output extracted`);
    assert.ok(value.outputs.changed.includes(`pages/${handle}/index.html`), `${handle} own successful edit attributed`);
    assert.ok(value.outputs.changed.every(path => path.startsWith(`pages/${handle}/`)), `${handle} changed attribution stays private to its own turn`);
  }
  check('real Claude, Codex and Kimi independent pages exist and all final replies/file outputs are captured');
  await take('run1-independent-1280');
  const codex = await reply('codex');
  await group().locator(`[data-message-id="${codex.id}"] [data-output-path]`).first().click();
  const file = page.locator('.file-workspace:visible').last(); await file.waitFor();
  if (!await page.locator('.file-preview:visible').count()) await file.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('.file-preview:visible').waitFor();
  await file.frameLocator('iframe').getByRole('heading', { level: 1 }).waitFor({ state: 'visible' });
  await take('run1-output-preview-1280');
  check('real HTML output opens in the app file preview'); await openRoom();
  const critique = await send("@claude critique @codex's page. Read the explicitly referenced page and suggest two concrete improvements. Do not edit files, read the Kimi page, delegate or open a browser. End with one actionable request line starting exactly @codex please add followed by the concrete improvement to make.");
  await requireReplies(critique, ['claude']);
  const critiqueReply = await reply('claude');
  assert.equal(critiqueReply.suggestions.filter(suggestion => suggestion.handle === 'codex').length, 1, 'one user-controlled routing suggestion per target');
  const suggestion = group().locator(`[data-message-id="${critiqueReply.id}"]`).getByRole('button', { name: 'Suggested next: @codex', exact: true });
  await suggestion.scrollIntoViewIfNeeded(); await take('run1-suggestion-1280');
  const beforeSuggestion = (await read()).messages.length;
  await suggestion.click();
  await until(async () => await box().inputValue() === '' && (await group().getByTestId('group-to').innerText()).includes('@codex'), 'suggestion empty draft retains its explicit recipient');
  assert.match(await group().getByTestId('group-includes').innerText(), /@claude['’]s reply/);
  assert.doesNotMatch(await group().getByTestId('group-includes').innerText(), /\(to:/);
  assert.equal((await read()).messages.length, beforeSuggestion, 'suggestion never sends automatically');
  check('one quiet actionable suggestion prefills an empty draft with the reply reference and never sends');
  const revisionText = "Revise your page using @claude's critique. Apply both improvements to your own page. Do not read other pages, delegate or open a browser. Reply with the file path and a concise change summary.";
  await box().fill(revisionText);
  await until(async () => (await group().getByTestId('group-to').innerText()).includes('@codex'), 'plain revision instruction retains the suggested Codex target');
  const revised = await send(revisionText);
  await requireReplies(revised, ['codex']);
  check('real cross-reference critique and revision complete through visible reference chips');
  await group().locator(`[data-message-id="${(await reply('codex')).id}"]`).scrollIntoViewIfNeeded();
  await take('run1-final-1280');
}
async function sequence() {
  const design = await send('@codex Write a short design doc for a dependency-free JavaScript slugify feature in docs/design.md. Specify a CommonJS function exported from src/slugify.cjs: lowercase ASCII, trim whitespace, replace runs of non-alphanumeric characters with one hyphen and strip leading/trailing hyphens. Tests in test/slugify.test.cjs using node:test should cover punctuation, blank input and repeated spaces. Only create the design doc. Do not delegate or open a browser. Reply with its path.');
  await requireReplies(design, ['codex']);
  assert.deepEqual((await reply('codex')).outputs.changed, ['docs/design.md'], 'design attribution excludes files merely mentioned by the design');
  const implemented = await handoff(await reply('codex'), 'claude', 'Implement the referenced design in src/slugify.cjs and test/slugify.test.cjs. Run node --test test/slugify.test.cjs from the existing current directory (do not use cd /d), fix any errors and reply with paths and the exact test result. Use no dependencies, no delegation and no browser.');
  await requireReplies(implemented, ['claude']);
  assert.ok(existsSync(join(work, 'src/slugify.cjs'))); assert.ok(existsSync(join(work, 'test/slugify.test.cjs')));
  const implementation = await reply('claude');
  for (const path of ['src/slugify.cjs', 'test/slugify.test.cjs']) {
    assert.ok(implementation.outputs.files.includes(path), `implementation output ${path}`);
    assert.ok(implementation.outputs.changed.includes(path), `implementation edit attribution ${path}`);
  }
  const before = await fileInventory();
  const reviewed = await handoff(await reply('claude'), 'grok', 'Review the referenced implementation and run node --test test/slugify.test.cjs if your read-only mode permits. Do not write any files, install dependencies, change git state, delegate or open a browser. Report findings and the actual test output; clearly say if tests could not run.');
  await requireReplies(reviewed, ['grok']);
  assert.deepEqual((await reply('grok')).outputs.changed, [], 'reviewer read/test paths are not edits');
  assert.deepEqual(await fileInventory(), before, 'reviewer did not change workspace files');
  report.testResult = execFileSync(process.execPath, ['--test', 'test/slugify.test.cjs'], { cwd: work, encoding: 'utf8', windowsHide: true });
  check('real Codex design → Claude implementation → read-only Grok review handoffs capture replies and preserve files');
  await group().locator(`[data-message-id="${(await reply('grok')).id}"]`).scrollIntoViewIfNeeded();
  await take('run2-final-1280');
}
async function recovery() {
  const first = await send('@codex Run node -e "setTimeout(()=>console.log(\'BUSY-DONE\'),15000)" once, wait for it to finish, then reply BUSY-DONE. Do not use any other tools.', { wait: false });
  await until(async () => (await read()).messages.find(message => message.id === first)?.deliveries.some(delivery => delivery.state === 'working'), 'real busy member');
  const queued = await send('@codex Reply QUEUE-DELIVERED. Do not use tools.', { wait: false });
  assert.equal((await read()).messages.find(message => message.id === queued).deliveries[0].state, 'queued');
  await take('run3-queued-1280'); await settled(first); await settled(queued); await requireReplies(queued, ['codex']); check('real busy delivery queues then completes');
  const stopped = await send('@codex Run node -e "setTimeout(()=>console.log(\'STOP-LATE\'),60000)" once and wait. Do not use other tools.', { wait: false });
  await until(async () => (await read()).messages.find(message => message.id === stopped)?.deliveries[0].state === 'working', 'stoppable delivery');
  await group().getByTestId(`group-live-${stopped}-codex`).getByRole('button', { name: 'Stop', exact: true }).click();
  const result = await settled(stopped); assert.equal(result.deliveries[0].state, 'stopped'); check('real working delivery stops');
  const added = await request('group.member.add', { id: groupId, provider: 'codex', handle: 'fault', model: 'gpt-6-luna', mode: 'default', operationId: randomUUID() });
  const member = added.members.find(member => member.handle === 'fault');
  await writeFile(join(bin, 'disable-codex'), 'QA-owned shim failure only');
  let failed;
  try { failed = await send('@fault Reply RESEND-RECOVERED. Do not use tools.'); }
  finally { await rm(join(bin, 'disable-codex'), { force: true }); }
  assert.equal((await read()).messages.find(message => message.id === failed).deliveries[0].state, 'failed');
  await take('run3-failed-1280');
  await configure(member);
  await group().getByTestId(`group-live-${failed}-fault`).getByRole('button', { name: 'Resend', exact: true }).click();
  await until(async () => (await read()).messages.find(message => message.id === failed).deliveries[0].state !== 'failed', 'resend accepted');
  await settled(failed); await requireReplies(failed, ['fault']); check('isolated CLI failure surfaces and explicit Resend recovers after restoring the shim');
}
async function extras() {
  const errors = [];
  for (const handle of scenarios.extras) {
    try {
    if (report.providers[handle]?.configurationError) throw Error(report.providers[handle].configurationError);
    const id = await send(`@${handle} Create outputs/${handle}.md containing a heading, one English sentence and one Chinese sentence about offline notes. Use only native file-writing tools, do not delegate or open a browser. Reply with the path and a Markdown table with two rows.`);
    await requireReplies(id, [handle]); assert.ok(existsSync(join(work, `outputs/${handle}.md`)));
    assert.ok((await reply(handle)).outputs.files.includes(`outputs/${handle}.md`), `${handle} file output is extracted`);
    check(`real ${handle} member captures its reply and creates a file output`);
    } catch (error) { errors.push(`${handle}: ${error.message}`); report.errors.push(`${handle}: ${error.stack || error}`); await evidence(); }
  }
  await take('run4-final-1280');
  assert.deepEqual(errors, [], 'both additional providers complete');
}
async function fileInventory() {
  const files = {};
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.name === '.git') continue; const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files[relative(work, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex'); } }
  await walk(work); return files;
}
async function evidence() {
  if (!page || !groupId) return;
  report.group = await read(); report.files = await fileInventory();
  for (const path of Object.keys(report.files)) { const destination = join(out, 'artifacts', path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, await readFile(join(work, path))); }
  const snapshot = await request('runtime.snapshot'); report.sessions = snapshot.sessions;
  for (const member of report.group.members) {
    const transcript = await request('chat.read', { sessionId: member.sessionId });
    report.providers[member.provider] ??= {};
    report.providers[member.provider].finalOptions = await request('chat.options', { sessionId: member.sessionId }).catch(error => ({ error: error.message }));
    await writeFile(join(out, `${member.handle}-chat.json`), JSON.stringify(transcript, null, 2));
    const nativeId = snapshot.sessions.find(session => session.id === member.sessionId)?.nativeId;
    if (nativeId) {
      try { const history = await request('history.read', { provider: member.provider, nativeId }); await writeFile(join(out, `${member.handle}-native.json`), JSON.stringify(history, null, 2)); }
      catch (error) { report.providers[member.provider].nativeHistoryError = error.message; }
    }
    const turns = transcript.filter(item => item.role === 'user').map(item => ({ turnId: item.turnId, text: textOf(item) }));
    report.providers[member.provider].turns = transcript.filter(item => item.turnId).map(item => ({ turnId: item.turnId, role: item.role, turnUsage: item.turnUsage, usage: item.parts.filter(part => part.type === 'usage').map(part => part.data) }));
    await writeFile(join(out, `${member.handle}-prompts.json`), JSON.stringify(turns, null, 2));
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
async function cleanupNative() {
  report.historyLeftovers = removeAgentHistory(slug);
  if (scenarios[scenario].includes('pi')) {
    const sessions = resolve(scratch, 'pi-sessions');
    assert.ok(relative(temp, sessions) && !relative(temp, sessions).startsWith('..'));
    await rm(sessions, { recursive: true, force: true }); report.piHistoryIsolatedAndRemoved = true;
  }
  if (scenarios[scenario].includes('opencode')) {
    const run = args => {
      assert.ok(args.every(arg => /^[\w-]+$/.test(arg)), 'safe fixed CLI command and native ID');
      const result = process.platform === 'win32'
        ? spawnSync(`opencode ${args.join(' ')}`, { shell: true, env: launchEnv, cwd: work, encoding: 'utf8', windowsHide: true })
        : spawnSync('opencode', args, { env: launchEnv, cwd: work, encoding: 'utf8' });
      assert.equal(result.status, 0, `OpenCode cleanup command: ${result.stderr || result.error || ''}`);
      return `${result.stdout || ''}\n${result.stderr || ''}`;
    };
    const help = run(['session', '--help']);
    assert.match(help, /session delete/);
    report.opencodeCleanup = [];
    for (const session of report.sessions?.filter(session => session.provider === 'opencode' && session.nativeId) || []) {
      const output = run(['session', 'delete', session.nativeId, '--pure']); report.opencodeCleanup.push({ nativeId: session.nativeId, output });
    }
  }
}
async function privacy() {
  await evidence();
  for (const member of report.group.members) {
    const path = join(out, `${member.handle}-native.json`);
    if (!existsSync(path)) { report.privacy.push({ handle: member.handle, status: 'unverified: native transcript unavailable' }); continue; }
    const native = JSON.parse(await readFile(path, 'utf8'));
    const prompts = native.filter(item => item.role === 'user').map(textOf).filter(Boolean);
    const addressed = report.group.messages.filter(message => message.author === 'user' && message.deliveries?.some(delivery => delivery.sessionId === member.sessionId));
    for (const prompt of prompts) assert.ok(addressed.some(message => prompt.includes(message.body)), `${member.handle} native transcript has no unaddressed user messages`);
    for (const message of addressed) {
      const prompt = prompts.find(text => text.includes(message.body)); assert.ok(prompt, `${member.handle} native prompt contains its addressed message`);
      assert.doesNotMatch(prompt, /Shared folder:\s*\\\\\?\\/i, 'normal path in native header');
      const referenced = new Set((message.references ?? []).map(reference => reference.messageId));
      for (const other of report.group.messages.filter(other => other.author === 'member' && other.sessionId !== member.sessionId && !referenced.has(other.id))) {
        if (other.body?.length >= 40) assert.ok(!prompt.includes(other.body), `${member.handle} prompt excludes unreferenced ${other.handle} reply`);
      }
      for (const reference of message.references ?? []) { assert.ok(reference.bytes <= 8192); assert.ok(prompt.includes('## Referenced:'), 'explicit reference delivered'); }
    }
    report.privacy.push({ handle: member.handle, status: 'pass', nativePrompts: prompts.length, addressedMessages: addressed.length });
  }
  assert.ok(report.privacy.every(result => result.status === 'pass'), 'all native privacy checks available');
  check('native transcripts contain addressed messages and only explicit cross-member reply references; header paths are normal');
  if (resultsName === 'group-chat-gc4') await finalAnswers();
}
async function finalAnswers() {
  report.finalAnswers = [];
  for (const member of report.group.members) {
    const captured = [...report.group.messages].reverse().find(message => message.author === 'member' && message.sessionId === member.sessionId);
    if (!captured) continue;
    const addressed = report.group.messages.find(message => message.id === captured.replyTo);
    const native = JSON.parse(await readFile(join(out, `${member.handle}-native.json`), 'utf8'));
    const start = native.findLastIndex(item => item.role === 'user' && textOf(item).includes(addressed.body));
    assert.ok(start >= 0);
    const rows = native.slice(start + 1);
    const all = [], tail = [], phased = [];
    for (const item of rows) for (const part of item.parts || []) {
      if (['tool', 'tool_use', 'tool_result'].includes(part.type)) tail.length = 0;
      if (item.role !== 'assistant' || part.type !== 'text' || !part.text?.trim()) continue;
      const text = part.text.trim(); all.push(text);
      if (part.phase === 'final_answer') phased.push(text);
      if (part.phase !== 'commentary') tail.push(text);
    }
    const expected = (phased.length ? phased : tail.length ? tail : all).join('\n\n');
    assert.equal(captured.body, expected, `${member.handle} captured final answer matches chronological native history`);
    const chat = JSON.parse(await readFile(join(out, `${member.handle}-chat.json`), 'utf8'));
    const ownTurn = addressed.deliveries.find(delivery => delivery.sessionId === member.sessionId)?.replyId;
    report.finalAnswers.push({ handle: member.handle, replyId: ownTurn, strategy: phased.length ? 'native final_answer phase' : tail.length ? 'after last native tool' : 'whole text fallback', nativeTextParts: all.length, omittedTextParts: all.filter(text => !expected.includes(text)).length, body: captured.body, chatTextParts: chat.filter(item => item.role === 'assistant').flatMap(item => item.parts.filter(part => part.type === 'text')).length });
  }
  check('captured final answers exactly match native phase or text after the last chronological tool; full Chat retained');
}
try {
  await mkdir(out, { recursive: true }); await mkdir(work); await writeFile(join(work, 'README.md'), `# Isolated group live QA\n${slug}\nScenario: ${scenario}. Only this folder may be changed. No network assets, browser, installs or delegation.\n`);
  const { env, git } = await environment(); launchEnv = env;
  execFileSync(git, ['init', '-q'], { cwd: work, windowsHide: true });
  await acquire(); await build(); await launch(); await create();
  if (report.preparedOnly) check('isolated app discovers providers and configures offered QA settings without model turns');
  else { await ({ independent, sequence, recovery, extras })[scenario](); await privacy(); }
  report.passed = true;
} catch (error) {
  report.errors.push(String(error.stack || error)); console.log(`FAIL ${scenario}: ${error.stack || error}`);
  if (page) await take('failure').catch(() => {});
} finally {
  await evidence().catch(error => report.errors.push(`evidence: ${error.message}`));
  await close(); await delay(3000);
  await cleanupNative().catch(error => { report.passed = false; report.errors.push(`native cleanup: ${error.message}`); });
  if (report.historyLeftovers.length) { report.passed = false; report.errors.push('Native history cleanup left matching rows'); }
  if (held) await rm(lock, { recursive: true, force: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.passed ? 'PASS' : 'FAIL'} GROUP CHAT LIVE ${scenario}: ${out}`);
  // Retain scratch for failure diagnosis and independently checking actual artifacts.
  if (!report.passed) process.exitCode = 1;
}
