// Desktop-1 QA for Run 3: recent snapshots and human-only agent proposals through the real runtime/renderer/MCP boundary, an isolated app,
// PATH without agent binaries, the fake ACP provider `run-tools-acp`, the Settings switch, the Run view's Agent tag and
// the full command on the detected-entry approval card. Everything runs in a scratch directory removed in `finally`.
//   $env:THREADTERM_V3_RUNTIME_BIN='<abs path to the debug threadterm-v3-runtime.exe>'
//   $env:THREADTERM_TEST_GIT='D:\Git\mingw64\bin\git.exe'
//   node qa/run-recent-proposals.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cpSync, existsSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {build as esbuild} from 'esbuild'; import {build as viteBuild} from 'vite';
import {electron} from './lib/desktop1.mjs'; // virtual Desktop 1; never focuses the user's desktop
import {acquireElectronQaLock} from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe');
const gitExe = process.env.THREADTERM_TEST_GIT ?? onPath('git');
const delay = ms => new Promise(done => setTimeout(done, ms));
const isFile = path => typeof path === 'string' && isAbsolute(path) && existsSync(path) && statSync(path).isFile();
function onPath(name) {
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const extension of ['', ...extensions]) {
      const candidate = join(directory, name + extension);
      if (directory && isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// Prerequisites first: a missing runtime or Git must not leave scratch behind.
assert.ok(isFile(runtime), 'Set THREADTERM_V3_RUNTIME_BIN to an absolute existing runtime executable');
assert.ok(isFile(gitExe), 'Set THREADTERM_TEST_GIT to an absolute existing Git executable');

const RUN_TOOLS = ['run_list', 'run_start', 'run_status', 'run_logs', 'run_stop', 'run_restart', 'run_propose'];
const DEV_ENTRY = 'detected:node:package.json:dev';
const scratch = await mkdtemp(join(tmpdir(), 'tt-run-recent-proposals-'));
const work = join(scratch, 'work'), second = join(scratch, 'second');
const appDir = join(scratch, 'app'), bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins');
const out = join(scratch, 'screenshots');
// Fixture PATH: Node (the ACP fixture itself), Git's cmd folder and System32 only — no agent binary anywhere.
const fixturePath = [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].filter(Boolean).join(';');
const inherited = {...process.env, GIT_DIR: process.env.GIT_DIR ?? join(scratch, 'contaminating-git-dir')};
const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(path|home|userprofile|codex_home|appdata|localappdata|threadterm_v3_.*|threadterm_test_git|threadterm_qa_.*|git_.*|npm_config_.*|node_options)$/i.test(key)));
Object.assign(env, {
  Path: fixturePath, LANGUAGE: 'C',
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-run-recent-proposals-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins,
  THREADTERM_QA_E1_HOST_EXE: process.env.THREADTERM_QA_E1_HOST_EXE || '',
});
assert.equal(Object.keys(env).filter(key => /^git_/i.test(key)).length, 0, 'fixture strips inherited GIT_* variables');
assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'each PATH variant is removed before the isolated app starts');

const git = (...args) => execFileSync(gitExe, args, {cwd: work, windowsHide: true, encoding: 'utf8', env});
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
const snapshot = () => request('runtime.snapshot');
const sessions = async () => (await snapshot()).sessions;
const active = session => ['starting', 'running', 'idle', 'waiting'].includes(session?.status ?? '');
const samePath = (left, right) => String(left ?? '').replace(/^\\\\\?\\/i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(right ?? '').replace(/^\\\\\?\\/i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
async function until(test, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const value = await test(); if (value) return value; } catch {}
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await delay(200);
  }
}

const repliesDir = join(scratch, 'data', 'run-tools-replies');
const repliesSeen = new Set();
const passed = [];
const check = message => { passed.push(message); console.log(`PASS ${message}`); };
const report = {passed: false, checks: passed, errors: []};
let app, page, releaseLock, project, chat, offChat, completed = false;

// The fixture chat: one ACP session whose text drives the app-hosted MCP server.
async function present(sessionId) {
  await request('session.present', {sessionId, placement: 'workspace', presentation: 'focused', operationId: randomUUID()});
  await page.locator(`[data-testid="session-chat-${sessionId}"]`).waitFor();
}
async function openChat(title) {
  const session = await request('session.create', {projectId: project.id, cwd: work, provider: 'run-tools-echo', mode: 'chat', title, operationId: randomUUID()});
  await present(session.id);
  const scope = page.locator(`[data-testid="session-chat-${session.id}"]`);
  await until(() => scope.locator('textarea').isEnabled(), `${title} composer`);
  return {session, scope};
}
/** Diagnostics only: the chat's full text, independent of what is scrolled into view. */
const chatText = async scope => scope.evaluate(node => node.textContent ?? '').catch(() => '');
// The chat renderer re-serializes JSON-looking message text (key order and escaping change), so replies are read
// from the fixture's own files under $THREADTERM_V3_DATA/run-tools-replies, not from the transcript.
async function nextReply(row, label) {
  const value = await until(async () => {
    let names = [];
    try { names = (await readdir(repliesDir)).filter(name => name.endsWith('.json')).sort(); } catch { return undefined; }
    const fresh = names.filter(name => !repliesSeen.has(name));
    if (!fresh.length) return undefined;
    for (const name of names) repliesSeen.add(name);
    return JSON.parse(await readFile(join(repliesDir, fresh[0]), 'utf8'));
  }, label);
  if (value.kind === 'error') throw Error(`fixture error: ${value.payload}`);
  if (typeof value.marker !== 'string') throw Error(`fixture reply has no marker: ${label}`);
  // The side file alone is not enough: the visible reply (which carries this call's unique marker)
  // must reach the chat transcript this probe is asserting against.
  await until(async () => (await chatText(row.scope)).includes(value.marker), `${label} marker in the chat transcript`);
  return value.payload;
}
async function idle(row) { await until(async () => await row.scope.locator('.chat-compose-send.is-stop').count() === 0, 'turn finished'); }
async function send(row, text) { await row.scope.locator('textarea').fill(text); await row.scope.locator('.chat-compose-send').first().click(); }
async function toolNames(row) {
  await idle(row);
  await send(row, 'tools');
  return nextReply(row, `${row.session.title}: tools`);
}
/** One MCP tools/call through the fixture; the caller answers a card itself for the approval flows. */
async function callTool(row, tool, args) {
  await idle(row);
  await send(row, `call ${tool} ${JSON.stringify(args)}`);
  return nextReply(row, `${tool} result`);
}
const payloadOf = envelope => { const text = (envelope?.content ?? []).find(part => part.type === 'text')?.text; try { return JSON.parse(text); } catch { return text; } };
/** Sends one run tool call that must raise the approval card, and returns the card and the command it shows. */
async function callWithApproval(row, tool, args) {
  await idle(row);
  await send(row, `call ${tool} ${JSON.stringify(args)}`);
  const card = row.scope.locator('.chat-question-wrapper.pending');
  await card.waitFor();
  const command = card.getByTestId('chat-question-command');
  await command.waitFor();
  return {card, command};
}
async function choose(rows, card, label) {
  await card.getByRole('radio', {name: new RegExp(label)}).check();
  await card.getByRole('button', {name: /Submit/}).click();
  await until(async () => await rows.scope.locator('.chat-question-wrapper.pending').count() === 0, `approval ${label} settled`);
}
const runById = async id => (await sessions()).find(session => session.id === id);
const activeRunOf = async commandId => (await sessions()).find(session => session.run?.commandId === commandId && active(session) && samePath(session.worktreePath, work));

try {
  await rm(out, {recursive: true, force: true}); await mkdir(out, {recursive: true});
  await mkdir(work, {recursive: true}); await mkdir(bin, {recursive: true}); await mkdir(plugins, {recursive: true});
  // A saved service: an HTTP server that prints a line but no URL, so only port readiness can reveal it.
  await writeFile(join(work, 'server.mjs'), `import http from 'node:http';\n`
    + `const server=http.createServer((_q,res)=>res.end('saved'));\n`
    + `server.listen(0,'127.0.0.1',()=>console.log('saved server listening'));\n`
    + `process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
  // A second tiny server behind a package.json script, which is the detected entry.
  await writeFile(join(work, 'dev-server.mjs'), `import http from 'node:http';\n`
    + `const server=http.createServer((_q,res)=>res.end('dev'));\n`
    + `server.listen(0,'127.0.0.1',()=>console.log('dev server listening'));\n`
    + `process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
  await writeFile(join(work, 'package.json'), JSON.stringify({name: 'run-recent-proposals-fixture', private: true, scripts: {dev: 'node dev-server.mjs'}}, null, 2));
  git('init'); git('config', 'user.email', 'qa@threadterm.invalid'); git('config', 'user.name', 'Run recent proposals QA');
  git('add', '.'); git('commit', '-m', 'fixture');
  cpSync(join(root, 'qa/fixtures/run-tools-acp'), join(plugins, 'run-tools-acp'), {recursive: true});

  // The real app: the production renderer, main and preload.
  await mkdir(appDir, {recursive: true});
  for (const name of ['main', 'preload']) {
    await esbuild({entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error'});
  }
  await viteBuild({configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: {outDir: join(appDir, 'renderer'), emptyOutDir: true}});
  await writeFile(join(appDir, 'package.json'), '{"name":"run-recent-proposals-qa","version":"1.0.0","main":"main.cjs"}');

  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: root, env, timeout: 60_000});
  page = await app.firstWindow({timeout: 45_000});
  page.setDefaultTimeout(25_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({state: 'detached', timeout: 30_000});

  const first = await snapshot();
  await request('settings.update', {patch: {language: 'en', theme: 'light', notifications: {native: false, attention: false, completed: false, sound: false}, 'chatTools.ask': true, 'chatTools.sessionInfo': true, 'chatTools.feedback': true, 'chatTools.run': true, 'chatTools.delegation': true}, expectedRevision: first.settings.revision, operationId: randomUUID()});
  await until(async () => (await request('plugin.list')).plugins.some(plugin => plugin.id === 'run-tools-acp'), 'the run-tools ACP fixture is discovered');
  await request('plugin.setEnabled', {pluginId: 'run-tools-acp', enabled: true, operationId: randomUUID()});
  await until(async () => (await request('provider.list')).some(provider => provider.id === 'run-tools-echo' && provider.chat), 'the run-tools ACP provider is enabled');
  project = await request('project.add', {path: work, name: 'Run recent proposals QA', operationId: randomUUID()});
  const saved = await request('quickLaunch.save', {projectId: project.id, name: 'saved server', command: 'node server.mjs', shell: 'cmd', cwd: '', kind: 'service', env: [{name: 'CHANGE', value: 'old-value'}, {name: 'REMOVE', value: 'remove-value'}], operationId: randomUUID()});

  // 1. The seven run tools (including propose) with the switch on; none of them in a chat opened while it is off.
  chat = await openChat('Run proposals QA');
  const namesOn = await toolNames(chat);
  for (const tool of RUN_TOOLS) assert.ok(namesOn.includes(tool), `run tools on: ${tool} missing from ${JSON.stringify(namesOn)}`);
  const settings = (await snapshot()).settings;
  await request('settings.update', {patch: {'chatTools.run': false}, expectedRevision: settings.revision, operationId: randomUUID()});
  offChat = await openChat('Run tools off');
  const namesOff = await toolNames(offChat);
  assert.deepEqual(namesOff.filter(name => RUN_TOOLS.includes(name)), [], `a chat opened with chatTools.run=false lists no run tool: ${JSON.stringify(namesOff)}`);
  assert.ok(namesOff.includes('ask_user'), 'the composed server still carries the other app tools');
  const afterOff = (await snapshot()).settings;
  await request('settings.update', {patch: {'chatTools.run': true}, expectedRevision: afterOff.revision, operationId: randomUUID()});
  check('The seven run tools are listed with chatTools.run on and absent from a chat opened while it is off');
  await present(chat.session.id);

  // A second worktree with its own run: never visible through the first worktree's tools.
  const tree = await request('worktree.create', {projectId: project.id, path: second, branch: 'qa-run-agent-tools', createBranch: true, operationId: randomUUID()});
  assert.ok(samePath(tree.path, second));
  const other = await request('quickLaunch.run', {detectedKey: 'node:package.json:dev', projectId: project.id, cwd: second, operationId: randomUUID()});
  await until(async () => (await runById(other.session.id))?.run?.readiness === 'ready', 'the other worktree run is active');

  // 2. run_list sees this worktree's saved and detected entries, and not the other worktree's run.
  const listed = payloadOf(await callTool(chat, 'run_list', {}));
  const savedEntry = listed.entries.find(entry => entry.id === saved.id);
  const detectedEntry = listed.entries.find(entry => entry.id === DEV_ENTRY);
  assert.equal(savedEntry?.approved, true, 'the saved entry is approved');
  assert.equal(savedEntry?.source, 'saved');
  assert.equal(detectedEntry?.approved, false, 'the detected dev entry is not approved');
  assert.equal(detectedEntry?.source, 'detected');
  assert.equal(detectedEntry?.command, 'npm run dev');
  assert.ok(!listed.runs.some(run => run.runId === other.session.id), "the other worktree's run is not listed");
  check('run_list shows the saved entry as approved and the detected dev entry as unapproved, and hides the other worktree');

  // 3. A saved entry starts with no approval card; its Running row carries the Agent tag.
  const noCard = async () => { await delay(400); assert.equal(await chat.scope.locator('.chat-question-wrapper.pending').count(), 0, 'a saved entry asks nothing'); };
  const started = payloadOf(await callTool(chat, 'run_start', {id: saved.id, requestId: 'start-saved'}));
  await noCard();
  assert.equal(typeof started.runId, 'string');
  const savedRun = await until(async () => { const run = await runById(started.runId); return run && active(run) && run.run?.readiness === 'ready' ? run : undefined; }, 'the saved entry runs');
  assert.equal(savedRun.run.commandId, saved.id);
  assert.equal(savedRun.run.startedBy, chat.session.id, 'the run records the chat that started it');
  await page.locator('.wb-switch-btn[data-view="run"]').click();
  const view = page.getByTestId('run-view');
  await view.waitFor();
  const savedRow = view.locator(`[data-testid="run-running-row"][data-run-entry="${saved.id}"]`);
  await savedRow.waitFor();
  const tag = savedRow.getByTestId('run-agent-tag');
  await tag.waitFor();
  assert.equal(await tag.innerText(), 'Agent');
  assert.equal(await tag.getAttribute('title'), 'Started by Run proposals QA');
  // Clicking the tag focuses that chat through the existing session presentation path.
  await present(offChat.session.id);
  await until(async () => !(await chat.scope.isVisible().catch(() => false)), 'the other chat is active instead');
  await tag.click();
  await chat.scope.waitFor({state: 'visible'});
  check('run_start of the saved entry starts it without a card; the Running row shows the Agent tag and click focuses the chat');

  // 4. A detected entry shows the full command first; "Run once" starts exactly it.
  const detectedApproval = await callWithApproval(chat, 'run_start', {id: DEV_ENTRY, requestId: 'start-detected'});
  const shownCommand = await detectedApproval.command.innerText();
  const cardText = await detectedApproval.card.innerText();
  assert.match(cardText, /Run this detected command from/);
  assert.match(cardText, /package.json/, 'the card names the source file');
  assert.match(cardText, /Run once/);
  assert.match(cardText, /Don't run/);
  assert.equal(shownCommand, 'npm run dev', 'the card shows the full command text');
  const commandStyle = await detectedApproval.command.evaluate(node => { const style = getComputedStyle(node); return {whiteSpace: style.whiteSpace, overflowY: style.overflowY, textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp, fontFamily: style.fontFamily}; });
  assert.equal(commandStyle.whiteSpace, 'pre-wrap', 'the command keeps its newlines and wraps');
  assert.equal(commandStyle.textOverflow, 'clip', 'the command is never ellipsized');
  assert.ok(!commandStyle.lineClamp || commandStyle.lineClamp === 'none', 'the command is never line-clamped');
  assert.match(commandStyle.fontFamily, /mono/i, 'the command is monospaced');
  assert.ok(commandStyle.overflowY === 'auto' || commandStyle.overflowY === 'scroll', 'a long command scrolls instead of being cut');
  await choose(chat, detectedApproval.card, 'Run once');
  const detectedStarted = payloadOf(await nextReply(chat, 'approved detected start'));
  assert.equal(typeof detectedStarted.runId, 'string');
  const detected = await until(async () => { const run = await runById(detectedStarted.runId); return run && active(run) ? run : undefined; }, 'the approved detected entry runs');
  assert.equal(detected.run.commandId, DEV_ENTRY, 'the run records the detected commandId');
  assert.equal(detected.run.startedBy, chat.session.id);
  await view.locator(`[data-testid="run-running-row"][data-run-entry="${DEV_ENTRY}"]`).getByTestId('run-agent-tag').waitFor();
  check('A detected run_start shows the full command on the approval card; "Run once" starts it with the Agent tag and detected commandId');

  // 5. Stop it, ask again, choose "Don't run": run_declined and nothing starts.
  const stopped = payloadOf(await callTool(chat, 'run_stop', {runId: detectedStarted.runId}));
  assert.equal(stopped.stopRequested, true);
  await until(async () => !active(await runById(detectedStarted.runId)), 'the detected run stops');
  const declineApproval = await callWithApproval(chat, 'run_start', {id: DEV_ENTRY, requestId: 'start-detected-2'});
  await choose(chat, declineApproval.card, "Don't run");
  const declined = payloadOf(await nextReply(chat, 'declined detected start'));
  assert.equal(declined.error?.message ?? declined.error?.code, 'run_declined', `the decline returns run_declined: ${JSON.stringify(declined)}`);
  await delay(400);
  assert.equal(await activeRunOf(DEV_ENTRY), undefined, 'a declined detected start launches nothing');
  check('Stop ends the detected run; asking again and choosing "Don\'t run" returns run_declined and starts nothing');

  // 6. run_logs returns the saved server's output; run_status shows the readiness and port from 1e.
  const logs = payloadOf(await callTool(chat, 'run_logs', {runId: started.runId}));
  assert.match(String(logs.text), /saved server listening/);
  assert.equal(logs.name, 'saved server');
  const status = payloadOf(await callTool(chat, 'run_status', {runId: started.runId}));
  assert.equal(status.name, 'saved server');
  assert.equal(status.readiness, 'ready');
  assert.equal(typeof status.port, 'number');
  assert.ok(status.port > 0);
  assert.equal(status.entryId, saved.id);
  check('run_logs returns the server output and run_status reports the readiness and port fields');

  // 7. Restarting the saved run gives a new runId with no card; run_stop stops it.
  const restarted = payloadOf(await callTool(chat, 'run_restart', {runId: started.runId, requestId: 'restart-saved'}));
  await noCard();
  assert.equal(restarted.existing, false);
  assert.notEqual(restarted.runId, started.runId, 'a restart is a new run');
  await until(async () => active(await runById(restarted.runId)), 'the restarted saved run is active');
  const ended = payloadOf(await callTool(chat, 'run_stop', {runId: restarted.runId}));
  assert.equal(ended.stopRequested, true);
  assert.equal(ended.name, 'saved server');
  await until(async () => !active(await runById(restarted.runId)), 'the restarted saved run stops');
  check('run_restart of the saved run gives a new runId without a card, and run_stop stops it');

  // 8. Another worktree's runId is run_not_found, never "forbidden".
  const foreign = payloadOf(await callTool(chat, 'run_status', {runId: other.session.id}));
  assert.equal(foreign.error?.message ?? foreign.error?.code, 'run_not_found', `the foreign run is not found: ${JSON.stringify(foreign)}`);
  check("run_status with the other worktree's runId returns run_not_found");

  // 9. Recent is an audit of the immutable launch snapshots. A human-started detected run has no Agent pill;
  // an agent-started run does. Keeping the detected snapshot must create a normal saved command from that snapshot.
  const userStarted = await request('quickLaunch.run', {detectedKey: DEV_ENTRY.slice('detected:'.length), projectId: project.id, cwd: work, operationId: randomUUID()});
  await until(async () => active(await runById(userStarted.session.id)), 'the user detected run is active');
  await request('session.stop', {sessionId: userStarted.session.id, operationId: randomUUID()});
  await until(async () => !active(await runById(userStarted.session.id)), 'the user detected run stops');
  if (!await view.isVisible()) await page.locator('.wb-switch-btn[data-view="run"]').click();
  const recent = view.getByTestId('run-recent');
  await recent.waitFor();
  assert.equal(await recent.getAttribute('open'), null, 'Recent starts collapsed');
  await recent.locator('summary').click();
  const userRecent = recent.locator(`[data-testid="run-recent-row"][data-run-id="${userStarted.session.id}"]`);
  await userRecent.waitFor();
  assert.equal(await userRecent.getByTestId('run-agent-tag').count(), 0, 'a user recent run has no Agent tag');
  const agentRecent = recent.locator('[data-testid="run-recent-row"]:has([data-testid="run-agent-tag"])').first();
  await agentRecent.waitFor();
  assert.equal(await agentRecent.getByTestId('run-agent-tag').innerText(), 'Agent', 'an agent recent run has the Agent tag');
  await userRecent.getByTestId('run-recent-keep').click();
  const keepEditor = page.getByTestId('command-editor');
  await keepEditor.waitFor();
  assert.equal(await keepEditor.getByTestId('command-editor-name').inputValue(), 'dev');
  assert.equal(await keepEditor.getByTestId('command-editor-command').inputValue(), 'npm run dev');
  await page.getByTestId('command-editor-save').click();
  await keepEditor.waitFor({state: 'detached'});
  const afterKeep = await request('quickLaunch.list', {projectId: project.id});
  assert.ok(afterKeep.some(command => command.name === 'dev' && command.command === 'npm run dev'), 'Pin saves the detected launch snapshot as a normal command');
  check('Recent shows user and Agent attribution; Pin… opens the snapshot and saves it as a normal command');

  // Rejected disguised text must never reach the human's pending list.
  const beforeDisguised = await request('quickLaunch.proposals.list', {projectId: project.id, cwd: work});
  const disguised = payloadOf(await callTool(chat, 'run_propose', {name:'Disguised',command:'.\\build\u200B.cmd',reason:'Must be refused',requestId:'proposal-invisible'}));
  assert.equal(disguised.error?.message ?? disguised.error?.code, 'detected_command_unprintable');
  const afterDisguised = await request('quickLaunch.proposals.list', {projectId: project.id, cwd: work});
  assert.deepEqual(afterDisguised.pending.map(item=>item.id), beforeDisguised.pending.map(item=>item.id));
  check('run_propose rejects zero-width executable text with detected_command_unprintable and creates no pending suggestion');

  // 10. A new proposal must disclose every execution-affecting field before the human can accept it. The
  // NODE_OPTIONS fixture points at a deliberately absent file and is never run: it exists solely to make sure an
  // agent cannot hide an executable environment override in the collapsed Advanced area.
  const newProposal = payloadOf(await callTool(chat, 'run_propose', {name: 'proposed task', command: 'node app.mjs', reason: 'Run the generated task after install.', shell: 'powershell', cwd: 'scripts', kind: 'task', env: [{name: 'NODE_OPTIONS', value: '--require=./payload.cjs'}, {name: 'PROPOSAL_FLAG', value: 'visible'}], previewUrl: 'http://localhost:4317/', requestId: 'proposal-new'}));
  assert.equal(newProposal.state, 'pending');
  assert.equal((await request('quickLaunch.list', {projectId: project.id})).some(command => command.name === 'proposed task'), false, 'run_propose never saves');
  assert.equal((await sessions()).some(session => session.run?.name === 'proposed task'), false, 'run_propose never runs');
  const proposals = view.getByTestId('run-proposals');
  await proposals.waitFor();
  const newProposalRow = proposals.locator(`[data-testid="run-proposal-row"][data-proposal-id="${newProposal.proposalId}"]`);
  await newProposalRow.waitFor();
  await page.getByTestId('run-proposals-badge').waitFor();
  assert.equal(await page.getByTestId('run-proposals-badge').innerText(), '1');
  const newProposalText = await newProposalRow.innerText();
  for (const expected of ['node app.mjs', 'PowerShell', 'scripts', 'Task', 'NODE_OPTIONS', '--require=./payload.cjs', 'PROPOSAL_FLAG', 'visible', 'http://localhost:4317/']) assert.ok(newProposalText.includes(expected), `new proposal row visibly discloses ${expected}`);
  await newProposalRow.getByTestId('run-proposal-accept').click();
  const proposalEditor = page.getByTestId('command-editor');
  await proposalEditor.waitFor();
  assert.equal(await proposalEditor.getByTestId('command-editor-name').inputValue(), 'proposed task');
  assert.equal(await proposalEditor.getByTestId('command-editor-command').inputValue(), 'node app.mjs');
  assert.equal(await proposalEditor.getByLabel('Shell', {exact: true}).getAttribute('data-value'), 'powershell');
  assert.equal(await proposalEditor.getByLabel('Working directory').inputValue(), 'scripts');
  assert.equal(await proposalEditor.getByLabel('Type', {exact: true}).getAttribute('data-value'), 'task');
  const advanced = proposalEditor.locator('details.ql-advanced');
  assert.equal(await advanced.getAttribute('open'), '', 'proposal acceptance keeps populated advanced fields open');
  assert.equal(await proposalEditor.getByLabel('Environment name 1').inputValue(), 'NODE_OPTIONS');
  assert.equal(await proposalEditor.getByLabel('Environment value 1').inputValue(), '--require=./payload.cjs');
  assert.equal(await proposalEditor.getByLabel('Environment name 2').inputValue(), 'PROPOSAL_FLAG');
  assert.equal(await proposalEditor.getByLabel('Environment value 2').inputValue(), 'visible');
  assert.equal(await proposalEditor.getByLabel('Preview address').inputValue(), 'http://localhost:4317/');
  const reviewText = await proposalEditor.getByTestId('proposal-review').innerText();
  for (const expected of ['node app.mjs', 'PowerShell', 'scripts', 'Task', 'NODE_OPTIONS', '--require=./payload.cjs', 'PROPOSAL_FLAG', 'visible', 'http://localhost:4317/']) assert.ok(reviewText.includes(expected), `proposal accept review visibly discloses ${expected}`);
  await page.getByTestId('command-editor-save').click();
  await proposalEditor.waitFor({state: 'detached'});
  const acceptedList = payloadOf(await callTool(chat, 'run_list', {}));
  assert.equal(acceptedList.proposals.find(proposal => proposal.proposalId === newProposal.proposalId)?.state, 'accepted', 'run_list exposes the caller proposal decision');
  check('A new agent proposal visibly discloses command, shell, cwd, type, every environment override and preview URL in its row and accept review; it accepts only through the editor');

  // 11. Line terminators are executable command bytes. An update changing CRLF to LF must show both terminators
  // before acceptance, then retain the selected LF bytes when the human accepts it.
  const endings = await request('quickLaunch.save', {projectId: project.id, name: 'line endings', command: 'Write-Output alpha\r\nWrite-Output beta', shell: 'powershell', cwd: '', kind: 'task', env: [], operationId: randomUUID()});
  const endingsProposal = payloadOf(await callTool(chat, 'run_propose', {id: endings.id, name: 'line endings', command: 'Write-Output alpha\nWrite-Output beta', shell: 'powershell', kind: 'task', reason: 'Normalize the script line endings.', requestId: 'proposal-line-endings'}));
  const endingsRow = proposals.locator(`[data-testid="run-proposal-row"][data-proposal-id="${endingsProposal.proposalId}"]`);
  await endingsRow.waitFor();
  const endingsText = await endingsRow.innerText();
  assert.match(endingsText, /- .*\[CRLF\]/, 'the old CRLF terminator is visible as a removal');
  assert.match(endingsText, /\+ .*\[LF\]/, 'the proposed LF terminator is visible as an addition');
  await endingsRow.getByTestId('run-proposal-accept').click();
  const endingsEditor = page.getByTestId('command-editor');
  await endingsEditor.waitFor();
  assert.match(await endingsEditor.getByTestId('proposal-review').innerText(), /\[CRLF\]/, 'the accept review includes the old CRLF terminator');
  assert.match(await endingsEditor.getByTestId('proposal-review').innerText(), /\[LF\]/, 'the accept review includes the proposed LF terminator');
  await page.getByTestId('command-editor-save').click();
  await endingsEditor.waitFor({state: 'detached'});
  assert.equal((await request('quickLaunch.list', {projectId: project.id})).find(command => command.id === endings.id)?.command, 'Write-Output alpha\nWrite-Output beta', 'accepted line-ending proposal preserves LF bytes exactly');
  check('A CRLF-to-LF update visibly removes [CRLF], adds [LF], and saves the accepted LF bytes exactly');

  // 12. An update shows the proposed and current command. Rejecting it leaves the saved command byte-for-byte intact.
  const updateProposal = payloadOf(await callTool(chat, 'run_propose', {id: saved.id, name: 'saved server', command: 'node changed-server.mjs', env: [{name: 'CHANGE', value: 'new-value'}, {name: 'ADD', value: 'added-value'}], reason: 'Use the replacement server.', requestId: 'proposal-reject'}));
  const updateRow = proposals.locator(`[data-testid="run-proposal-row"][data-proposal-id="${updateProposal.proposalId}"]`);
  await updateRow.waitFor();
  assert.match(await updateRow.innerText(), /node server\.mjs/);
  assert.match(await updateRow.innerText(), /node changed-server\.mjs/);
  const updateText = await updateRow.innerText();
  for (const expected of ['Environment: ADD', 'added-value', 'Environment: CHANGE', 'old-value', 'new-value', 'Environment: REMOVE', 'remove-value']) assert.ok(updateText.includes(expected), `the update diff individually discloses ${expected}`);
  await updateRow.getByTestId('run-proposal-reject').click();
  await updateRow.waitFor({state: 'detached'});
  const unchanged = (await request('quickLaunch.list', {projectId: project.id})).find(command => command.id === saved.id);
  assert.equal(unchanged?.command, 'node server.mjs', 'Reject never changes the target saved command');
  check('An update proposal shows command and individually labeled added, changed and removed environment entries; Reject leaves the saved command unchanged');

  // 13. Acceptance is revision-fenced. Updating the target between proposal and the human Save shows the conflict
  // and preserves the human draft instead of applying a stale agent suggestion.
  const staleProposal = payloadOf(await callTool(chat, 'run_propose', {id: saved.id, name: 'saved server', command: 'node stale-server.mjs', reason: 'This should conflict.', requestId: 'proposal-stale'}));
  const current = (await request('quickLaunch.list', {projectId: project.id})).find(command => command.id === saved.id);
  assert.ok(current, 'the saved command still exists before the stale-update race');
  await request('quickLaunch.save', {projectId: current.projectId, id: current.id, expectedRevision: current.revision,
    name: current.name, command: 'node current-server.mjs', shell: current.shell, cwd: current.cwd,
    kind: current.kind, env: current.env, previewUrl: current.previewUrl, operationId: randomUUID()});
  const staleRow = proposals.locator(`[data-testid="run-proposal-row"][data-proposal-id="${staleProposal.proposalId}"]`);
  await staleRow.waitFor();
  await staleRow.getByTestId('run-proposal-accept').click();
  const staleEditor = page.getByTestId('command-editor');
  await page.getByTestId('command-editor-save').click();
  const conflict = staleEditor.getByRole('alert');
  await conflict.waitFor();
  assert.match(await conflict.innerText(), /revision_conflict|changed/i, 'a stale proposal acceptance reports revision_conflict');
  assert.equal((await request('quickLaunch.list', {projectId: project.id})).find(command => command.id === saved.id)?.command, 'node current-server.mjs');
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  check('Accepting a stale update reports revision_conflict and leaves the current saved command intact');

  assert.deepEqual(pageErrors, [], 'the probe page raised no error');
  await page.screenshot({path: join(out, 'run-recent-proposals.png')});
  report.screenshots = ['run-recent-proposals.png'];
  report.passed = true;
  completed = true;
  console.log(`PASS ${passed.length} checks`);
} catch (error) {
  report.errors.push(error.stack || String(error));
  try { report.lastChat = await chatText(chat?.scope); } catch {}
  process.exitCode = 1;
  try { await page?.screenshot({path: join(out, 'failure.png')}); } catch {}
} finally {
  try { for (const session of (await sessions()).filter(active)) await request('session.stop', {sessionId: session.id, operationId: randomUUID()}); } catch {}
  try { await Promise.race([request('runtime.shutdown', {operationId: randomUUID()}),delay(3000)]); } catch {}
  if (app) {
    await Promise.race([app.evaluate(({app: electronApp}) => electronApp.exit(0)), delay(2000)]).catch(() => {});
    await Promise.race([app.close(), delay(5000)]).catch(() => {});
    try { app.process()?.kill(); } catch {}
  }
  await releaseLock?.().catch(() => {});
  await rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 250}).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
  // The JSON above is the probe artifact. Screenshots are useful while the browser is alive, but this isolated
  // probe deliberately leaves no qa/results directory behind for a later run to mistake for fresh evidence.
  await rm(out, {recursive: true, force: true, maxRetries: 10, retryDelay: 250}).catch(() => {});
}
if (!completed) process.exitCode = 1;
