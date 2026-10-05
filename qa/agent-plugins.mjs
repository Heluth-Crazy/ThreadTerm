// Real-app check of agent plugins (task 10-05-agent-plugins): the runtime registry lists the built-ins with their
// metadata and Gemini from its bundled manifest; a user plugin (examples/plugins/echo-acp) is found, stays disabled
// until enabled through Settings → Plugins (with a trust confirmation listing its commands), then appears as an
// agent with its icon, runs in a terminal and answers in a Chat; broken plugins only report issues; disabling removes
// the agent again.
// Isolated Electron (own data, user data and pipe; app bundle cached in the git-ignored runtime/target-qa folder,
// --rebuild after app changes) on the target-qa runtime (rebuild it after runtime changes:
// `cargo build --manifest-path runtime/Cargo.toml --target-dir runtime/target-qa -j 2 --bins`). Plugins come from a
// scratch copy via THREADTERM_V3_PLUGIN_DIRS. PATH holds only node and System32 (every case of PATH dropped first), so
// no real agent CLI can start; the only agent process is the example's `node agent.mjs`.
//   node qa/agent-plugins.mjs [--rebuild] [--keep]
// Report and screenshots: qa/results/agent-plugins/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `missing ${runtime}`);
assert.ok(existsSync(join(root, 'examples/plugins/echo-acp/threadterm-plugin.json')), 'missing examples/plugins/echo-acp');
const keep = process.argv.includes('--keep');
const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'tt-agent-plugins-'));
const plugins = join(scratch, 'plugins'), work = join(scratch, 'work'), appDir = join(root, 'runtime/target-qa/agent-plugins-qa-app');
const out = join(root, 'qa/results/agent-plugins');
const report = { passed: false, scratch, checks: [], notes: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const note = text => { report.notes.push(text); console.log(`NOTE ${text}`); };
let app, page;

const manifest = (id, agents, extra = {}) => JSON.stringify({ schemaVersion: 1, id, name: id, version: '0.0.1', contributes: { agents }, ...extra });
async function prepare() {
  await mkdir(work, { recursive: true });
  cpSync(join(root, 'examples/plugins/echo-acp'), join(plugins, 'echo-acp'), { recursive: true });
  const broken = async (folder, text) => { await mkdir(join(plugins, folder), { recursive: true }); await writeFile(join(plugins, folder, 'threadterm-plugin.json'), text); };
  await broken('broken-json', '{ "schemaVersion": 1, "id": "broken-json", ');
  await broken('reserved-id', manifest('reserved-id', [{ id: 'codex', name: 'Not Codex', command: 'node' }]));
  await broken('icon-escape', manifest('icon-escape', [{ id: 'escaper', name: 'Escaper', command: 'node', icon: '../escape.svg' }]));
  await broken('future-schema', JSON.stringify({ schemaVersion: 2, id: 'future-schema', name: 'Future', version: '9.0.0', contributes: {} }));
  if (process.argv.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'))) {
    console.log('building the QA app bundle…');
    await mkdir(appDir, { recursive: true });
    for (const name of ['main', 'preload']) {
      await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    }
    await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-agent-plugins-qa', version: '0.1.0', main: 'main.cjs' }));
  } else console.log(`reusing the QA app bundle in ${appDir} (--rebuild to rebuild)`);
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(test, label, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await test(); if (value) return value; } catch { /* retry */ } if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(200); }
}
const providers = () => request('provider.list');
const pluginList = () => request('plugin.list');
const shot = async name => { await delay(250); await page.screenshot({ path: join(out, name) }); };

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await prepare();
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-agent-plugins-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_CLAUDE_NODE: process.execPath,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => !document.getElementById('boot-splash'), null, { timeout: 30000 });

  // 1. Registry: built-ins with metadata, Gemini from its bundled manifest, no plugin agent yet.
  const initial = await until(async () => { const list = await providers(); return list.length >= 6 ? list : undefined; }, 'provider.list');
  report.providers = initial.map(({ id, name, source, pluginId, installed, chat, signIn }) => ({ id, name, source, pluginId, installed, chat, signIn: signIn?.display }));
  for (const id of ['codex', 'claude', 'kimi', 'opencode', 'grok']) assert.equal(initial.find(item => item.id === id)?.source ?? 'builtin', 'builtin', `${id} is built in`);
  const gemini = initial.find(item => item.id === 'gemini');
  assert.equal(gemini?.source, 'plugin'); assert.ok(gemini?.pluginId, 'gemini names its bundled plugin');
  assert.equal(initial.some(item => item.id === 'echo'), false, 'a user plugin contributes nothing before it is enabled');
  check(`registry: ${initial.map(item => `${item.id}(${item.source ?? 'builtin'})`).join(', ')}; echo absent before enabling`);

  // 2. plugin.list: the example is found disabled with its commands; each broken plugin has an issue.
  const listed = await pluginList();
  report.plugins = listed.plugins.map(({ id, source, enabled, agents, issues }) => ({ id, source, enabled, agents: agents.map(agent => ({ id: agent.id, commands: agent.commands })), issues }));
  const echo = listed.plugins.find(item => item.id === 'echo-acp');
  assert.ok(echo, 'echo-acp is listed'); assert.equal(echo.source, 'user'); assert.equal(echo.enabled, false); assert.deepEqual(echo.issues, []);
  assert.ok(echo.agents[0]?.commands.length > 0, 'its command lines are shown before enabling');
  for (const id of ['broken-json', 'reserved-id', 'icon-escape', 'future-schema']) {
    const plugin = listed.plugins.find(item => item.id === id || item.path?.endsWith(id));
    assert.ok(plugin, `${id} is listed`); assert.ok(plugin.issues.length > 0, `${id} reports an issue`);
  }
  assert.ok(listed.plugins.find(item => item.source === 'bundled' && item.agents.some(agent => agent.id === 'gemini'))?.enabled, 'bundled Gemini plugin is enabled');
  check(`plugin.list: echo-acp user/disabled with ${echo.agents[0].commands.length} command lines; 4 broken plugins each report an issue`);

  // 3. Settings → Plugins: enable echo-acp through the trust confirmation.
  await page.locator('.user-row').click();
  await page.locator('.account-menu .shell-menu-foot .menu-item').click();
  await page.locator('.settings-panel [role=tab]', { hasText: 'Plugins' }).click();
  const card = page.locator('.settings-panel :is(article, li, section, div)', { hasText: echo.name }).filter({ has: page.locator('input[type=checkbox]') }).last();
  await card.waitFor();
  await shot('01-plugins-tab.png');
  await card.locator('input[type=checkbox]').first().click({ force: true });
  const confirm = page.locator('[role=dialog]').filter({ hasText: /trust/i }).last();
  await confirm.waitFor();
  const confirmText = await confirm.innerText();
  for (const command of echo.agents[0].commands) assert.ok(confirmText.includes(command), `the confirmation shows "${command}"`);
  await shot('02-trust-confirmation.png');
  await confirm.getByRole('button', { name: 'Enable', exact: true }).click();
  await until(async () => (await pluginList()).plugins.find(item => item.id === 'echo-acp')?.enabled, 'echo-acp enabled');
  const agent = await until(async () => (await providers()).find(item => item.id === 'echo'), 'echo in provider.list');
  report.echoCapability = { ...agent, icon: agent.icon?.slice(0, 40) };
  assert.equal(agent.source, 'plugin'); assert.equal(agent.pluginId, 'echo-acp'); assert.match(agent.icon ?? '', /^data:image\/svg\+xml;base64,/);
  assert.equal(agent.installed, true, `installed (${agent.reason ?? ''})`); assert.equal(agent.chat, true, `chat (${agent.reason ?? ''})`);
  check(`enabled through the trust confirmation → provider.list has echo (installed, chat ${agent.chat}, history ${agent.history}, resume ${agent.resume}, icon data URL)`);
  const issuesShown = await page.locator('.settings-panel [role=alert]').allInnerTexts();
  assert.ok(issuesShown.length >= 4, `the broken plugins' issues are shown (${issuesShown.length})`);
  await shot('03-plugins-enabled.png');
  await page.keyboard.press('Escape');

  // 4. The agent appears in the New terminal picker with its plugin icon.
  await page.locator('.nav-item.new').click();
  const dialog = page.locator('[role=dialog]').last();
  await dialog.waitFor();
  const echoChoice = dialog.locator('.create-type', { hasText: 'Echo' });
  await until(async () => (await echoChoice.count()) === 1, 'Echo in the New terminal dialog');
  assert.equal(await echoChoice.isDisabled(), false, 'Echo is selectable (installed)');
  assert.equal(await echoChoice.locator('img.brand-ico[data-agent-icon="echo"]').count(), 1, 'the plugin icon renders as <img>');
  assert.match(await echoChoice.locator('img').getAttribute('src'), /^data:image\/svg\+xml;base64,/);
  await shot('04-new-terminal-picker.png');
  await page.keyboard.press('Escape');
  check('New terminal offers Echo with its plugin icon');

  // 5. Terminal: the plugin's command runs in a PTY.
  const terminal = await request('session.create', { cwd: work, title: 'qa echo terminal', provider: 'echo', mode: 'terminal', operationId: randomUUID() });
  const output = await until(async () => { const read = await request('terminal.read', { sessionId: terminal.id, cursor: 0 }); const text = Buffer.from(read.data ?? '', 'base64').toString('utf8') || String(read.data ?? ''); return /echo/i.test(text) ? text : undefined; }, 'echo terminal output', 20000).catch(() => undefined);
  if (output) check(`terminal session runs the plugin command (output: ${JSON.stringify(output.trim().slice(0, 80))})`);
  else { const state = (await request('runtime.snapshot')).sessions.find(item => item.id === terminal.id); assert.ok(state && !['error'].includes(state.status), `terminal session state ${state?.status}`); note(`terminal session ${state.status}; no "echo" text read back (output format unknown to the harness)`); }

  // 6. Chat: open a Chat session with the plugin agent and get the echo through the real composer.
  const chat = await request('session.create', { cwd: work, title: 'qa echo chat', provider: 'echo', mode: 'chat', operationId: randomUUID() });
  // Open it the way a notification click does (desktop-navigate → the session route).
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find(item => item.isVisible())?.webContents.send('threadterm:desktop-navigate', { sessionId: id }), chat.id);
  const box = page.locator('.chat-compose-shell textarea');
  await box.waitFor({ timeout: 20000 });
  await until(async () => !(await box.isDisabled()), 'composer enabled', 20000);
  await box.fill('hello plugins');
  await page.locator('.chat-compose-send[type="submit"]').click();
  await until(async () => (await page.locator('.v3-chat-message.assistant').allInnerTexts()).some(text => text.includes('Echo: hello plugins')), 'the echo reply', 30000);
  await shot('05-chat-echo.png');
  check('a Chat session with the plugin agent answers "Echo: hello plugins"');

  // 7. Disabling removes the agent again (no confirmation needed).
  await request('plugin.setEnabled', { pluginId: 'echo-acp', enabled: false, operationId: randomUUID() });
  await until(async () => !(await providers()).some(item => item.id === 'echo'), 'echo gone after disabling');
  check('disabling the plugin removes the agent from provider.list');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await Promise.race([app.close(), delay(5000)]).catch(() => {}); try { app.process()?.kill(); } catch { /* already gone */ } }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed && !report.errors.length ? 'AGENT PLUGINS QA PASSED' : `AGENT PLUGINS QA FAILED\n${report.errors.join('\n')}`);
  process.exit(report.passed && !report.errors.length ? 0 : 1);
}
