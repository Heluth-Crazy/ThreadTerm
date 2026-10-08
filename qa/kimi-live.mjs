// Windows / Git Bash: node qa/kimi-live.mjs <probe|question|chat|terminal|resume|delegation|history> [--rebuild] [--keep]
// Live Kimi only. Normal Kimi credentials/home are inherited, never copied/read/logged.
// Sessions remain in the user's Kimi history. --keep retains only the isolated QA fixture/profile.
// This file must be syntax-checked without launching it during implementation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const scenarios = ['probe', 'question', 'chat', 'terminal', 'resume', 'delegation', 'history', 'queue', 'subagent'];
const [scenario, ...flags] = process.argv.slice(2);
assert.ok(scenarios.includes(scenario) && flags.every(flag => ['--rebuild', '--keep'].includes(flag)),
  `usage: node qa/kimi-live.mjs <${scenarios.join('|')}> [--rebuild] [--keep]`);
assert.equal(process.platform, 'win32', 'This harness requires Windows');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const appDir = join(root, 'runtime/target-qa/kimi-live-qa-app');
const out = join(root, 'qa/results/kimi-live', scenario);
const scratch = await mkdtemp(join(tmpdir(), 'tt-kimi-live-'));
// One fixed folder: the user allowed Kimi's TUI to trust exactly this path (2026-10-06), so their Kimi config gains a
// single trusted entry. It is emptied and recreated on every run.
const work = join(tmpdir(), 'threadterm-kimi-qa');
const keep = flags.includes('--keep');
const startedAt = Date.now(), budgetMs = 10 * 60_000;
const deadline = startedAt + budgetMs;
const marker = prefix => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const markerA = marker('KIMI-OK'), markerB = marker('KIMI-OK'), delegateMarker = marker('DELEGATE');
const fixtureName = `kimi-${randomUUID().slice(0, 8)}.txt`;
const fixtureFile = join(work, fixtureName);
const report = { scenario, passed: false, startedAt: new Date(startedAt).toISOString(), budgetMs,
  scratch, fixture: work, checks: [], timings: [], shots: [], approvals: [], errors: [],
  kimi: { version: null, auth: 'unknown' }, notes: [
    "Uses the user's normal Kimi home and credentials; sessions appear in the user's Kimi history and are not removed.",
    'Never approves native trust, update, or login prompts. A blocked TUI is a failure, not a passed test.',
  ] };
let app, page, env, project, finalizing = false, watchdog;
let database = 'primary';
const owned = new Set();
const seenApprovals = new Set();
const delay = ms => new Promise(done => setTimeout(done, ms));
const errorText = error => error instanceof Error ? error.stack ?? error.message : String(error);
const check = text => { report.checks.push({ text, ms: Date.now() - startedAt }); console.log(`PASS ${text}`); };
const canonical = value => String(value ?? '').replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const samePath = (a, b) => canonical(a) === canonical(b);
const inside = path => { const rel = relative(work, resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`); };

// Promise races also bound a single stalled IPC call/poll, not just the polling loop.
async function bounded(action, label, ms = 15_000, cleanup = false) {
  const available = cleanup ? ms : Math.min(ms, deadline - Date.now());
  if (available <= 0 || (!cleanup && finalizing)) throw Error(`Total budget exhausted: ${label}`);
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), available);
  })]); } finally { clearTimeout(timer); }
}
const request = (method, params = {}, ms = 15_000, cleanup = false) => bounded(
  () => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]), method, ms, cleanup);
const snapshot = () => request('runtime.snapshot');
const session = async id => (await snapshot()).sessions.find(item => item.id === id);
const chatItems = id => request('chat.read', { sessionId: id });
const assistantText = item => item.role === 'assistant' ? item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';
const host = id => page.getByTestId(`session-chat-${id}`);
async function shot(name) {
  if (!page || page.isClosed()) return;
  await bounded(() => page.screenshot({ path: join(out, name), timeout: 5000 }), `screenshot ${name}`, 6000, true);
  report.shots.push(name);
}
async function until(test, label, ms = 45_000) {
  const start = Date.now(), end = Math.min(deadline, start + ms);
  try {
    while (Date.now() < end && !finalizing) {
      const value = await bounded(test, label, Math.min(15_000, end - Date.now()));
      if (value) return value;
      await delay(250);
    }
    throw Error(`Timed out: ${label}`);
  } finally { report.timings.push({ label, ms: Date.now() - start, limitMs: ms }); }
}

async function prepare() {
  assert.ok(existsSync(runtime), `missing ${runtime}; Claude must build the QA runtime first`);
  assert.ok(existsSync(join(dirname(runtime), 'threadterm-v3-mcp.exe')), 'QA MCP executable must be next to the runtime');
  await mkdir(out, { recursive: true });
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await mkdir(work);
  await mkdir(join(scratch, 'plugins'));
  if (scenario === 'subagent') {
    await writeFile(join(work, 'alpha.txt'), 'alpha\n');
    await writeFile(join(work, 'beta.txt'), 'beta\n');
    await writeFile(join(work, 'notes.md'), '# Notes\n');
  } else {
    await writeFile(join(work, 'README.md'), '# Isolated Kimi live QA\nOnly operate in this fixture. No commits, extra agents, trust, login or update actions.\n');
  }
  // A real fixture Git repository, without touching or committing the user's repository.
  const found = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).split(/\r?\n/).filter(Boolean);
  const git = found.find(path => /\\cmd\\git\.exe$/i.test(path)) ?? found[0];
  assert.ok(git, 'git was not found');
  execFileSync(git, ['init', '-q'], { cwd: work, windowsHide: true, timeout: 10_000, stdio: 'pipe' });
  // Kimi's own launcher directory (it holds only `kimi`); override with THREADTERM_QA_KIMI_BIN.
  const kimiBin = process.env.THREADTERM_QA_KIMI_BIN || join(homedir(), '.kimi-code', 'bin');
  const dirs = [kimiBin, dirname(process.execPath), dirname(git), join(process.env.SystemRoot || 'C:\\Windows', 'System32')];
  for (const directory of dirs) {
    const entries = await readdir(directory, { withFileTypes: true });
    assert.ok(!entries.some(entry => /^(codex|claude|gemini|opencode|grok)/i.test(entry.name)),
      `Refusing PATH directory containing a forbidden agent filename: ${directory}`);
  }
  assert.ok(existsSync(join(dirs[0], 'kimi.exe')), 'Expected isolated kimi.exe directory is missing');
  report.path = dirs;
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  // Preserve HOME/USERPROFILE/KIMI_CODE_HOME unchanged. Never read a Kimi config or credential file.
  // ClaudeAdapter probes its SDK sidecar even without a CLI on PATH. This inert fixture exits
  // immediately, preventing the real Claude SDK host (and its bundled CLI) from running.
  const inertHost = join(scratch, 'disabled-provider-host.mjs');
  await writeFile(inertHost, 'process.exit(1);\n');
  Object.assign(env, { PATH: dirs.join(';'), THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'plugins'), THREADTERM_CLAUDE_SDK_HOST: inertHost, THREADTERM_CLAUDE_NODE: process.execPath,
    KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_DISABLE_TELEMETRY: '1' });
  report.notes.push('Claude SDK capability worker overridden with an inert fixture; no Claude code or CLI executes.');
  check('PATH contains only the four allowed directories, with no forbidden agent filenames');
  if (flags.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'))) {
    await mkdir(appDir, { recursive: true });
    for (const name of ['main', 'preload']) await bounded(() => esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)],
      bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'],
      outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }), `build ${name}`, 60_000);
    await bounded(() => viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn',
      build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }), 'build renderer', 90_000);
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-kimi-live-qa', version: '0.1.0', main: 'main.cjs' }));
  } else report.notes.push(`Reused ${appDir}; use --rebuild after desktop/renderer changes. Runtime is never rebuilt by this script.`);
}

async function launch(name = database) {
  database = name;
  Object.assign(env, { THREADTERM_V3_DATA: join(scratch, name, 'data'), THREADTERM_V3_USER_DATA: join(scratch, name, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-kimi-live-${randomUUID()}` });
  // Recheck immediately before every launch, including restarts.
  for (const directory of report.path) assert.ok(!(await readdir(directory)).some(name => /^(codex|claude|gemini|opencode|grok)/i.test(name)), `Unsafe PATH: ${directory}`);
  app = await bounded(() => electron.launch({ args: [appDir], cwd: work, env, timeout: 60_000 }), 'Electron launch', 65_000);
  page = await bounded(() => app.firstWindow({ timeout: 45_000 }), 'first window', 50_000);
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`renderer: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm), null, { timeout: 30_000 });
  await page.locator('.app-shell').waitFor({ timeout: 45_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await request('settings.update', { patch: { theme: 'light', language: 'en', notifications: {
    native: false, attention: false, completed: false, sound: false } }, expectedRevision: (await snapshot()).settings.revision, operationId: randomUUID() });
  const providers = await request('provider.list', {}, 45_000);
  const kimi = providers.find(item => item.id === 'kimi');
  assert.ok(kimi?.installed && kimi.chat, 'Kimi must be installed and Chat capable');
  assert.ok(providers.filter(item => ['codex', 'claude', 'gemini', 'opencode', 'grok'].includes(item.id)).every(item => !item.installed), 'No forbidden provider may be installed in the app environment');
  report.kimi = { version: kimi.version ?? null, auth: kimi.auth ?? 'unknown', chat: kimi.chat, terminal: kimi.terminal, history: kimi.history, resume: kimi.resume };
  if (!kimi.version) report.notes.push('Kimi version unavailable from provider.list; no extra CLI version process was started.');
  check(`App ready; native notifications disabled; Kimi installed (auth: ${report.kimi.auth}, version: ${report.kimi.version ?? 'unavailable'})`);
  project = (await snapshot()).projects.find(item => samePath(item.path, work)) ?? await request('project.add', { path: work, name: 'Kimi live QA', operationId: randomUUID() });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
}
async function navigate(id) {
  await bounded(() => app.evaluate(({ BrowserWindow }, sessionId) => BrowserWindow.getAllWindows()[0].webContents.send(
    'threadterm:desktop-navigate', { sessionId }), id), 'desktop session navigation');
}
async function validateSessions() {
  const rows = (await snapshot()).sessions;
  for (const row of rows) {
    owned.add(row.id);
    assert.equal(row.provider, 'kimi', `Unexpected provider session ${row.id}`);
    assert.ok(samePath(row.worktreePath, work), `Session escaped fixture: ${row.id}`);
  }
  return rows;
}
async function create(mode) {
  const before = new Set((await snapshot()).sessions.map(item => item.id));
  await page.locator('.nav-item.new').click();
  const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true });
  await dialog.waitFor();
  await dialog.locator('.create-chip').filter({ hasText: 'Kimi live QA' }).click();
  await dialog.getByLabel('Local path', { exact: true }).fill(work);
  await dialog.getByPlaceholder('Development session', { exact: true }).fill(`Kimi ${scenario} ${randomUUID().slice(0, 6)}`);
  // Chat is disabled for the default Shell provider, so select Kimi before mode.
  await dialog.locator('.create-type').filter({ hasText: /^Kimi$/ }).click();
  await dialog.getByRole('button', { name: mode === 'chat' ? 'Chat' : 'Terminal', exact: true }).click();
  assert.equal(await dialog.locator('.create-type.is-on').innerText(), 'Kimi');
  assert.ok(samePath(await dialog.getByLabel('Local path', { exact: true }).inputValue(), work));
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const created = await until(async () => (await validateSessions()).find(item => !before.has(item.id)), `UI creates Kimi ${mode}`, 90_000);
  assert.equal(created.mode, mode);
  await navigate(created.id);
  check(`New terminal dialog creates a Kimi ${mode} in the fixture`);
  return created;
}
async function ready(id) {
  await host(id).waitFor();
  await until(async () => {
    const connection = await request('chat.connection', { sessionId: id });
    if (['failed', 'unavailable'].includes(connection.phase)) throw Error(`Kimi connection ${connection.phase}: ${connection.error?.category ?? 'unknown'}`);
    return connection.phase === 'ready' && !await host(id).locator('.chat-compose-shell textarea').isDisabled();
  }, 'chat.connection ready and composer writable', 90_000);
}

// Read actual visible approval text, including expanded details; use only a once-only
// permission choice. Never fall back to choices[0], persistent/session allow, or native prompts.
async function approvals(returnTo, expectedFile, delegation = false) {
  for (const row of await validateSessions()) {
    if (row.mode !== 'chat') continue;
    for (const item of await chatItems(row.id)) for (const part of item.parts) {
      if (part.type !== 'approval' || part.status !== 'pending') continue;
      const key = `${row.id}:${part.approvalId}`;
      if (seenApprovals.has(key)) continue;
      await navigate(row.id);
      const card = host(row.id).locator('.chat-approval-card.pending').filter({ hasText: part.data?.title || 'Approval required' }).first();
      await card.waitFor();
      const details = card.locator('details');
      if (await details.count() && !await details.evaluate(element => element.open)) await details.locator('summary').click();
      const visible = await card.innerText();
      const forbidden = /\b(trust|login|log in|sign in|update|upgrade)\b|信任|登录|更新/i.test(visible);
      const config = await request('session.config.read', { sessionId: row.id });
      // A matching basename in an OUTSIDE absolute path must never grant permission.
      // Require an exact file argument or the full fixture path, and refuse shell commands.
      const detailsText = typeof part.data?.details === 'string' ? part.data.details : JSON.stringify(part.data?.details ?? {});
      const outsideNamedPaths = [...visible.matchAll(/(?:[a-z]:[\\/]|\\\\)[^\n"'<>]*?kimi-[a-z0-9-]+\.txt/gi)]
        .some(match => !samePath(match[0], expectedFile));
      const pathArguments = [];
      const collectPaths = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (/^(path|file|filePath|file_path|filename|cwd|directory)$/i.test(key) && typeof child === 'string') pathArguments.push(child);
          else if (child && typeof child === 'object') collectPaths(child);
        }
      };
      collectPaths(part.data?.details);
      const fileArgumentsSafe = pathArguments.every(path => samePath(resolve(work, path), expectedFile) || samePath(resolve(work, path), work));
      const exactFileMention = visible.includes(fixtureFile) || visible.includes(fixtureFile.replace(/\\/g, '/'))
        || new RegExp(`(?:^|[\\s"'/\\\\])${fixtureName.replace(/\./g, '\\.')}(?=$|[\\s"',:])`).test(visible);
      const shellRequest = /\b(shell|bash|powershell|cmd\.exe|runcommand|run command|command execution)\b/i.test(`${part.data?.requestType ?? ''} ${part.data?.title ?? ''}`)
        || /"(?:command|cmd)"\s*:/.test(detailsText);
      const namedFile = expectedFile && exactFileMention && samePath(config.cwd, work)
        && !outsideNamedPaths && fileArgumentsSafe && !shellRequest;
      // Explicitly scoped MCP tool names only, and never authorize a different agent.
      const delegationTool = delegation && /\bthreadterm\b/i.test(visible)
        && /\bdelegate_(start|status|wait|result|cancel)\b/.test(visible)
        && !/\b(codex|claude|gemini|opencode|grok)\b/i.test(visible);
      const allow = !forbidden && Boolean(namedFile || delegationTool);
      const choices = part.data?.choices ?? [];
      const choice = allow ? choices.find(value => value.kind === 'allow' && value.scope === 'once')
        : choices.find(value => value.kind === 'deny') ?? choices.find(value => value.kind === 'cancel');
      report.approvals.push({ sessionId: row.id, approvalId: part.approvalId, decision: allow ? 'allow-once' : 'reject',
        reason: forbidden ? 'native trust/login/update' : namedFile ? 'expected fixture filename in fixture cwd' : delegationTool ? 'explicit ThreadTerm delegation tool' : 'outside allowlist' });
      await shot(`approval-${report.approvals.length}.png`);
      if (!choice) throw Error('Approval has no safe choice; stopping without granting permission');
      const buttons = card.locator(`.chat-approval-choice.kind-${choice.kind}`);
      const button = buttons.filter({ hasText: choice.label }).first();
      // Match by native choice order if translated labels differ (semantic kind/scope already verified).
      const selected = await button.count() ? button : card.locator('.chat-approval-choice').nth(choices.indexOf(choice));
      await selected.click();
      seenApprovals.add(key);
      if (!allow) { report.errors.push(`Rejected unexpected approval in ${row.id}`); console.log('FAIL unexpected approval rejected'); }
    }
  }
  await navigate(returnTo);
}
async function send(id, prompt, expected, { file = false, delegation = false } = {}) {
  await ready(id);
  const before = new Set((await chatItems(id)).map(item => item.id));
  await host(id).locator('.chat-compose-shell textarea').fill(prompt);
  await host(id).locator('.chat-compose-send[type=submit]').click();
  const result = await until(async () => {
    await approvals(id, file ? fixtureFile : undefined, delegation);
    const items = await chatItems(id);
    const fresh = items.filter(item => !before.has(item.id));
    const answer = fresh.filter(item => assistantText(item).includes(expected));
    const state = await session(id);
    const turnId = fresh.find(item => item.role === 'user')?.turnId;
    return answer.length && turnId && state?.activity?.turnId === turnId
      && ['idle', 'awaiting_input'].includes(state.activity.state) && { items: fresh, turnId };
  }, `new completed assistant reply for ${expected}`, delegation ? 180_000 : 120_000);
  await until(async () => (await host(id).locator('.v3-chat-message.assistant').allInnerTexts()).some(text => text.includes(expected)), 'assistant reply renders', 15_000);
  check(`New completed Kimi assistant reply contains ${expected}`);
  return result;
}

const stripAnsi = value => value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-2AB]/g, '').replace(/\r/g, '');
async function terminalOutput(id, cursor = 0) {
  const value = await request('terminal.read', { sessionId: id, cursor, limit: 1048576 });
  return { ...value, text: stripAnsi(Buffer.from(value.data, 'base64').toString('utf8')) };
}
// Output already answered (the trust prompt stays in the raw stream): later checks start after it.
const nativeFrom = new Map();
const trustPrompt = text => /Trust this folder\?/i.test(text) && text.includes(work) && /Trust this folder\s*\n?\s*Enable project MCP/i.test(text);
async function answerTrust(id) {
  const lease = await request('session.claim', { sessionId: id, clientId: 'qa-kimi-live' });
  try { await request('terminal.input', { sessionId: id, leaseEpoch: lease.leaseEpoch, data: '\r' }); }
  finally { await request('session.release', { sessionId: id, leaseEpoch: lease.leaseEpoch }).catch(() => {}); }
  nativeFrom.set(id, (await terminalOutput(id)).nextCursor);
  report.approvals.push({ sessionId: id, decision: 'trust-fixed-qa-folder', folder: work, reason: 'user-approved single trusted QA folder' });
  console.log(`NOTE answered Kimi "Trust this folder?" for ${work} only`);
}
function nativeBlock(text) {
  if (/trust this (folder|directory)|trust.*\?|sign in.*(required|continue)|log ?in.*(required|continue)|update (available|now)|upgrade.*\?|Yes, continue/i.test(text))
    throw Error('Native trust/login/update prompt blocked; no input or approval sent');
}
async function terminalReady(id) {
  let last = '', stableSince = Date.now();
  await until(async () => {
    const output = await terminalOutput(id);
    const fresh = (await terminalOutput(id, nativeFrom.get(id) ?? 0)).text.slice(-6000);
    if (!nativeFrom.has(id) && trustPrompt(fresh)) { await answerTrust(id); return false; }
    nativeBlock(fresh);
    const state = await session(id);
    assert.equal(state?.status, 'running', 'Kimi terminal must remain running');
    if (output.text !== last) { last = output.text; stableSince = Date.now(); }
    return last.trim().length > 0 && Date.now() - stableSince >= 1500;
  }, 'Kimi terminal output is nonempty and stable', 60_000);
  await page.locator('.pane-tab-surface:not([hidden]) .xterm').first().waitFor();
}
async function terminalPrompt(row, token) {
  nativeBlock((await terminalOutput(row.id, nativeFrom.get(row.id) ?? 0)).text.slice(-6000));
  const before = new Set((await request('history.read', { provider: 'kimi', nativeId: row.nativeId })).map(item => item.id));
  const boundary = (await terminalOutput(row.id)).nextCursor;
  // Reliable no-focus terminal input through the protocol's session lease. Never retry a send.
  const lease = await request('session.claim', { sessionId: row.id, clientId: 'qa-kimi-live' });
  try {
    await request('terminal.input', { sessionId: row.id, leaseEpoch: lease.leaseEpoch, data: `Reply with exactly ${token} and nothing else. Do not use tools.` });
    await delay(500);
    await request('terminal.input', { sessionId: row.id, leaseEpoch: lease.leaseEpoch, data: '\r' });
  } finally { await request('session.release', { sessionId: row.id, leaseEpoch: lease.leaseEpoch }).catch(() => {}); }
  await until(async () => {
    const output = await terminalOutput(row.id, boundary);
    nativeBlock(output.text);
    const native = await request('history.read', { provider: 'kimi', nativeId: row.nativeId });
    // Output alone also contains the echoed prompt. Require a NEW native assistant answer.
    return output.text.includes(token) && native.some(item => !before.has(item.id) && assistantText(item).includes(token));
  }, `terminal output and new native assistant answer contain ${token}`, 120_000);
  check(`Terminal answers ${token}; native assistant history rules out prompt echo`);
}
async function selectValue(scope, label, value) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator(`[role=option][data-value="${value}"]`).click();
}
async function openHistory(nativeId, title) {
  // Native auto-titles can differ from ThreadTerm's session title. Bind the UI row
  // to the exact nativeId through the cwd-filtered API before matching its title.
  const native = await until(async () => (await request('history.list', { provider: 'kimi', cwd: work, limit: 100 })).items
    .find(item => item.nativeId === nativeId && samePath(item.cwd, work)), 'exact fixture history entry available', 60_000);
  title = native.title || title;
  await page.locator('.nav-item').filter({ hasText: /^All terminals$/ }).click();
  const options = page.getByRole('button', { name: 'Terminal page options', exact: true });
  try { await options.waitFor({ state: 'visible', timeout: 3000 }); } catch { return undefined; }
  await options.click();
  const entry = page.getByRole('button', { name: 'Native session history', exact: true });
  if (!await entry.count()) { await page.keyboard.press('Escape'); return undefined; }
  await entry.click();
  const rail = page.locator('.history-rail-native');
  await rail.waitFor();
  await until(async () => await rail.getByRole('button', { name: 'Scan native history', exact: true }).isEnabled(), 'initial history scan finishes', 60_000);
  await selectValue(rail, 'History provider', 'kimi');
  await rail.getByRole('textbox', { name: 'Search history', exact: true }).fill(work);
  const record = rail.locator('.history-native-list article').filter({ hasText: title });
  await until(async () => await record.count() === 1, `history UI lists fixture native session ${nativeId}`);
  await record.getByRole('button', { name: 'Read', exact: true }).click();
  await rail.locator('.history-detail').waitFor();
  return rail;
}

async function stopAll(cleanup = false) {
  if (!page || page.isClosed()) return;
  let rows = [];
  try { rows = (await request('runtime.snapshot', {}, 5000, cleanup)).sessions; } catch { /* stop known sessions too */ }
  for (const row of rows) owned.add(row.id);
  for (const id of owned) {
    try { await request('session.stop', { sessionId: id, force: true, operationId: randomUUID() }, 5000, cleanup); }
    catch (error) { report.notes.push(`session stop ${id}: ${errorText(error)}`); }
  }
}
async function closeApp(cleanup = false) {
  // Recover a renderer handle if startup failed between launch and firstWindow.
  if (!page && app) page = app.windows().find(window => !window.isClosed());
  await stopAll(cleanup);
  if (page && !page.isClosed()) await request('runtime.shutdown', { operationId: randomUUID() }, 6000, cleanup).catch(error => report.errors.push(`runtime.shutdown: ${errorText(error)}`));
  if (app) {
    await bounded(() => app.evaluate(({ app: electronApp }) => electronApp.exit(0)), 'Electron exit', 3000, true).catch(() => {});
    await bounded(() => app.close(), 'Electron close', 5000, true).catch(() => {});
    try { app.process()?.kill(); } catch { /* already exited */ }
  }
  page = undefined; app = undefined; owned.clear();
}
async function finalize(fatal) {
  if (finalizing) return;
  finalizing = true; clearTimeout(watchdog);
  if (fatal) { report.errors.push(errorText(fatal)); console.error(`FAIL ${errorText(fatal)}`); }
  await mkdir(out, { recursive: true });
  if (report.errors.length) await shot('failure.png').catch(() => {});
  await closeApp(true).catch(error => report.errors.push(`cleanup: ${errorText(error)}`));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(error => report.notes.push(`Scratch retained: ${error.message}`));
  report.elapsedMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  report.passed = report.passed && report.errors.length === 0;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.passed ? 'PASS' : 'FAIL'} KIMI LIVE ${scenario}; report: ${join(out, 'report.json')}`);
  process.exitCode = report.passed ? 0 : 1;
  // A budget expiry can leave a stalled Electron/build promise; cleanup has completed.
  if (fatal?.code === 'TOTAL_BUDGET') process.exit(1);
}
process.on('uncaughtException', error => { void finalize(error); });
process.on('unhandledRejection', error => { void finalize(error); });
process.on('SIGINT', () => { void finalize(Error('Interrupted')); });
process.on('SIGTERM', () => { void finalize(Error('Terminated')); });

try {
  watchdog = setTimeout(() => { const error = Error('Total QA budget exhausted'); error.code = 'TOTAL_BUDGET'; void finalize(error); }, budgetMs);
  await prepare();
  await launch();
  if (scenario === 'terminal') {
    const row = await create('terminal');
    assert.ok(row.nativeId, 'terminal identity must be preassigned');
    await terminalReady(row.id);
    await terminalPrompt(row, markerA);
    await shot('01-terminal-answer.png');
    await request('session.stop', { sessionId: row.id, force: true, operationId: randomUUID() });
    await until(async () => ['exited', 'interrupted'].includes((await session(row.id))?.status), 'terminal stopped');
    await page.locator('.pane-tab-surface:not([hidden])').getByRole('button', { name: 'Resume', exact: true }).click();
    await until(async () => (await session(row.id))?.status === 'running', 'terminal UI Resume');
    assert.equal((await session(row.id)).nativeId, row.nativeId);
    await terminalReady(row.id);
    await terminalPrompt(row, markerB);
    await shot('02-terminal-resumed.png');
    check('UI Resume retains the same sessionId/nativeId and answers a second marker');
  } else {
    const row = await create('chat');
    await ready(row.id);
    check('Real Kimi Chat connection is ready');
    if (scenario === 'probe') {
      assert.equal((await chatItems(row.id)).filter(item => item.role === 'user').length, 0);
      await shot('01-probe-connected.png');
      check('Probe submitted no prompts');
    } else if (scenario === 'question') {
      const before = new Set((await chatItems(row.id)).map(item => item.id));
      const expectedQuestion = 'Which gemstone should be selected: Sapphire or Amber?';
      const requested = `Use your AskUserQuestion tool exactly once to ask this exact question text, with no changes: "${expectedQuestion}". Offer only the choices Sapphire and Amber. Use no other tools and do not answer it yourself. After I answer, reply with exactly the selected choice.`;
      await host(row.id).locator('.chat-compose-shell textarea').fill(requested);
      await host(row.id).locator('.chat-compose-send[type=submit]').click();
      const pending = await until(async () => {
        const items = await chatItems(row.id);
        const part = items.filter(item => !before.has(item.id)).flatMap(item => item.parts)
          .find(candidate => candidate.type === 'approval' && candidate.status === 'pending' && candidate.data?.interaction === 'question');
        return part && { items, part };
      }, 'Kimi AskUserQuestion bridge surfaces a pending question', 120_000);
      const question = pending.part.data?.form?.questions?.[0];
      assert.equal(question?.question, expectedQuestion, 'question card preserves Kimi AskUserQuestion text instead of its tool title');
      assert.equal(question.multiSelect, false);
      assert.equal(question.allowOther, false);
      const native = pending.part.data?.details ?? {};
      report.question = {
        expectedQuestion, cardQuestion: question.question,
        nativeTitle: native.toolCall?.title ?? native.title ?? null,
        nativeRawInput: native.toolCall?.rawInput ?? native.rawInput ?? null,
      };
      const label = question.options?.find(option => option.label === 'Sapphire')?.label ?? question.options?.[0]?.label;
      assert.ok(label, 'Kimi question has an offered option');
      await host(row.id).locator('form.chat-question-card').filter({ hasText: question.question }).waitFor();
      await shot('01-question-pending.png');
      const lease = await request('session.claim', { sessionId: row.id, clientId: 'qa-kimi-live-question' });
      try {
        await request('chat.answer', { sessionId: row.id, turnId: pending.part.data.turnId, approvalId: pending.part.approvalId,
          leaseEpoch: lease.leaseEpoch, operationId: randomUUID(), response: { action: 'submit', values: { q0: [label] } } });
      } finally { await request('session.release', { sessionId: row.id, leaseEpoch: lease.leaseEpoch }).catch(() => {}); }
      await until(async () => (await chatItems(row.id)).some(item => assistantText(item).trim() === label), 'Kimi confirms the selected label', 120_000);
      await shot('02-question-answered.png');
      check('Kimi AskUserQuestion renders its text as a question card; the selected label reaches Kimi');
    } else if (scenario === 'subagent') {
      const before = new Set((await chatItems(row.id)).map(item => item.id));
      const prompt = 'Use an explore subagent (your Agent tool) to list the files in this folder and report how many there are. Do not edit anything. Then reply with just the number.';
      const composer = host(row.id).locator('.chat-compose-shell textarea');
      await composer.fill(prompt);
      await host(row.id).locator('.chat-compose-send[type=submit]').click();
      const started = Date.now();
      let runningShot = false;
      const completed = await until(async () => {
        await approvals(row.id, undefined);
        const items = await chatItems(row.id);
        const user = items.find(item => !before.has(item.id) && item.role === 'user');
        const state = await session(row.id);
        const cards = items.flatMap(item => item.parts.filter(part => part.type === 'subagent'));
        if (!runningShot && cards.some(part => part.data?.status === 'running')) {
          await shot('subagent-running.png');
          runningShot = true;
        }
        if (!user?.turnId || state?.activity?.turnId !== user.turnId || !['idle', 'awaiting_input'].includes(state.activity.state)) return false;
        return { items, cards, durationMs: Date.now() - started };
      }, 'Kimi subagent turn completes', 360_000);
      report.subagent = { durationMs: completed.durationMs, cardCount: completed.cards.length,
        status: completed.cards.map(part => part.data?.status), transcriptItems: 0, transcriptTools: 0 };
      assert.equal(completed.cards.length, 1, 'exactly one chat item part has type subagent');
      const data = completed.cards[0].data;
      assert.equal(data.status, 'completed');
      assert.ok(typeof data.summary === 'string' && data.summary.trim().length > 0, 'subagent summary is non-empty');
      assert.equal(data.native?.kind, 'kimi-agent');
      assert.match(data.native?.id ?? '', /^agent-\d+$/);
      assert.equal(data.transcript, 'native');
      assert.equal(completed.items.flatMap(item => item.parts).filter(part => part.type === 'tool'
        && String(part.toolName ?? '').startsWith('Launching ')).length, 0, 'no Launching tool parts remain');
      const transcript = await request('chat.subagent.read', { sessionId: row.id, key: data.key });
      assert.ok(!transcript.error, transcript.error ?? 'native transcript has no error');
      assert.ok(transcript.items.length > 0, 'native transcript contains items');
      const toolCount = transcript.items.flatMap(item => item.parts).filter(part => part.type === 'tool').length;
      assert.ok(toolCount > 0, 'native transcript contains at least one tool part');
      report.subagent.transcriptItems = transcript.items.length;
      report.subagent.transcriptTools = toolCount;
      const card = host(row.id).locator('article.chat-subagent-card');
      await card.waitFor();
      await until(async () => (await card.locator('details').evaluate(element => element.open)) === false, 'subagent card is collapsed');
      await shot('subagent-card.png');
      await card.locator('details > summary').click();
      await card.locator('.chat-subagent-transcript').waitFor();
      await until(async () => await card.locator('.chat-subagent-transcript .chat-tool-entry').count() > 0,
        'expanded subagent transcript renders its tool part', 30_000);
      await shot('subagent-expanded.png');
      report.subagent.status = data.status;
      report.subagent.key = data.key;
      check('Native Kimi subagent card completes with a readable tool transcript');
    } else if (scenario === 'delegation') {
      const parentSource = await readFile(join(root, 'runtime/src/delegation.rs'), 'utf8');
      // The list literal after `=`; the Rust type `[&str; N]` before it contains a `;`.
      assert.match(parentSource, /PARENT_PROVIDERS\s*:[^=]*=\s*\[[^\]]*"kimi"/);
      check('Kimi is in the delegation parent allowlist in runtime source');
      const turn = await send(row.id, `Use threadterm MCP delegate_start once with agent "kimi", workspace "shared", title "${delegateMarker}", prompt "Reply with exactly ${delegateMarker} and nothing else. Do not use tools." Wait using delegate_wait, read delegate_result, and reply with the delegate's answer. Never start other agents. Reject all delegate approvals.`, delegateMarker, { delegation: true });
      const children = (await validateSessions()).filter(item => item.delegation?.parentSessionId === row.id);
      assert.equal(children.length, 1, 'exactly one delegated child');
      const child = children[0];
      assert.equal(child.delegation.workspace, 'shared');
      assert.equal(child.delegation.state, 'completed');
      assert.ok((await chatItems(child.id)).some(item => assistantText(item).includes(delegateMarker)));
      assert.ok(turn.items.some(item => assistantText(item).includes(delegateMarker)));
      await host(row.id).locator(`.delegate-card[data-session-id="${child.id}"]`).waitFor();
      await shot('01-delegation-parent.png');
      await navigate(child.id);
      await until(async () => (await host(child.id).locator('.v3-chat-message.assistant').allInnerTexts()).some(text => text.includes(delegateMarker)), 'child transcript renders');
      await shot('02-delegation-child.png');
      report.delegation = { parent: row.id, child: child.id, state: child.delegation.state };
      check('Shared Kimi child appears in delegation panel/snapshot; child and parent assistant replies contain the marker');
    } else {
      await send(row.id, `Reply with exactly ${markerA} and nothing else. Do not use tools.`, markerA);
      await shot('01-chat-answer.png');
      if (scenario === 'chat') {
        const result = await send(row.id, `Create only ${fixtureName} in the current directory containing exactly ${markerB}. Then reply with exactly ${markerB}.`, markerB, { file: true });
        await until(async () => {
          if (!existsSync(fixtureFile)) return false;
          assert.ok(inside(await realpath(fixtureFile)), 'fixture output must not be a symlink outside the repo');
          return (await readFile(fixtureFile, 'utf8')).trim() === markerB;
        }, 'expected fixture file contains marker', 15_000);
        assert.ok(result.items.some(item => item.parts.some(part => part.type === 'tool')), 'runtime transcript records tool activity');
        const drawer = host(row.id).locator('.chat-tool-activity').last();
        await drawer.waitFor();
        if (!await drawer.evaluate(element => element.open)) await drawer.locator('summary').click();
        await host(row.id).locator('.chat-tool-entry').first().waitFor();
        await shot('02-chat-file-tool-activity.png');
        check('Fixture file has the marker; native tool parts and rendered tool activity rows exist');
      } else if (scenario === 'resume') {
        const nativeId = (await session(row.id)).nativeId;
        assert.ok(nativeId);
        // Shutdown while Chat is still live, before app exit. Do not pre-stop this scenario.
        await request('runtime.shutdown', { operationId: randomUUID() }, 15_000);
        await bounded(() => app.evaluate(({ app: electronApp }) => electronApp.exit(0)), 'restart app exit');
        await bounded(() => app.close(), 'restart app close', 5000).catch(() => {});
        try { app.process()?.kill(); } catch { /* gone */ }
        app = undefined; page = undefined;
        await launch('primary');
        assert.equal((await session(row.id)).nativeId, nativeId);
        // ThreadTerm still owns this conversation after the restart (history shows "Existing native owner"): the real
        // path back is opening the session; its Chat reconnects to the same Kimi session.
        report.notes.push(`after restart the owned Chat reads status=${(await session(row.id)).status} before reconnecting`);
        await navigate(row.id);
        // Regression (found 2026-10-06): the previous window's 30 s control lease used to survive the restart, and the
        // new window never retried, so the user had to press "Reclaim control". The runtime now adopts the previous
        // runtime's leases, so the restarted window takes control by itself; ChatView never retries a lease_held.
        await ready(row.id);
        const reclaim = host(row.id).getByRole('button', { name: /^(Reclaim control|重新取得控制)/ });
        assert.equal(await reclaim.count(), 0, 'restarted app still shows "Reclaim control"');
        check('Restarted app takes Chat control without a manual reclaim');
        await send(row.id, 'What exact marker did I ask you to reply with earlier? Reply with just it.', markerA);
        assert.equal((await session(row.id)).nativeId, nativeId);
        await shot('02-chat-resumed-memory.png');
        check('Same profile/data and nativeId; explicit UI resume returns marker A in a NEW answer without including it in the recall prompt');
      } else if (scenario === 'queue') {
        // Prompt queue against a real ACP agent: follow-ups typed during a real Kimi turn wait in the runtime queue and
        // are sent once each, in order, after the turn ends.
        const textOf = item => item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
        const markerOf = text => (text.match(/KIMI-Q\d-[0-9a-f]{8}/) ?? [])[0];
        const [q0, q1, q2] = [0, 1, 2].map(index => `KIMI-Q${index}-${randomUUID().slice(0, 8)}`);
        const composer = host(row.id).locator('.chat-compose-shell textarea'), submit = host(row.id).locator('.chat-compose-send[type=submit]');
        await composer.fill(`Count from one to thirty in English words, one per line, then write ${q0} on the last line. Do not use tools.`);
        await submit.click();
        await until(async () => /queue|队列/i.test(await submit.innerText()) ? true : undefined, 'composer switches to Queue during the real Kimi turn', 60_000);
        for (const marker of [q1, q2]) { await composer.fill(`Reply with exactly ${marker} and nothing else. Do not use tools.`); await submit.click(); }
        const waiting = await until(async () => { const value = await request('chat.queue.read', { sessionId: row.id }); return value.items.length === 2 ? value : undefined; }, 'both follow-ups wait in the runtime queue', 20_000);
        assert.deepEqual(waiting.items.map(item => markerOf(item.text)), [q1, q2]);
        await shot('02-queue-waiting.png');
        await until(async () => { const answers = (await chatItems(row.id)).map(assistantText).join('\n'); return [q0, q1, q2].every(marker => answers.includes(marker)) ? true : undefined; }, 'Kimi answered the turn and both queued follow-ups', 300_000);
        const sent = (await chatItems(row.id)).filter(item => item.role === 'user').map(item => markerOf(textOf(item))).filter(Boolean);
        assert.deepEqual(sent.slice(-3), [q0, q1, q2], 'queued messages were sent once each, in order');
        assert.equal((await request('chat.queue.read', { sessionId: row.id })).items.length, 0, 'queue drained');
        await shot('03-queue-drained.png');
        check('Real Kimi turn: two follow-ups queued during it were sent once each, in order, after it finished');
      } else if (scenario === 'history') {
        const nativeId = (await session(row.id)).nativeId;
        assert.ok(nativeId);
        await request('session.stop', { sessionId: row.id, force: true, operationId: randomUUID() });
        const native = await until(async () => {
          const listed = await request('history.list', { provider: 'kimi', cwd: work, limit: 100 });
          return listed.items.find(item => item.nativeId === nativeId && samePath(item.cwd, work));
        }, 'cwd-filtered Kimi history contains exact nativeId', 60_000);
        check('history.list(kimi, fixture cwd) returns the exact native identity');
        // A new isolated DB removes the original owner conflict without deleting any user history.
        await closeApp();
        await launch('history-import');
        report.notes.push('History import uses a second scratch profile/data DB so the native ID has no existing ThreadTerm owner.');
        const before = new Set((await snapshot()).sessions.map(item => item.id));
        const rail = await openHistory(nativeId, native.title);
        let imported;
        if (rail) {
          await until(async () => (await rail.locator('.history-detail').innerText()).includes(markerA), 'native history transcript renders');
          await selectValue(rail.locator('.history-import'), 'Mode', 'chat');
          await rail.getByRole('button', { name: 'Import card', exact: true }).click();
          imported = await until(async () => (await validateSessions()).find(item => !before.has(item.id) && item.nativeId === nativeId), 'UI imports read-only history card');
          await shot('02-history-import-ui.png');
          report.historyImport = 'UI';
        } else {
          imported = await request('history.import', { projectId: project.id, provider: 'kimi', nativeId, cwd: work,
            mode: 'chat', title: native.title, operationId: randomUUID() });
          owned.add(imported.id); report.historyImport = 'history.import';
          report.notes.push('Native history menu is absent in this app bundle; used the allowed history.import fallback.');
        }
        assert.equal(imported.provider, 'kimi'); assert.equal(imported.readOnly, true);
        assert.ok((await chatItems(imported.id)).some(item => assistantText(item).includes(markerA)));
        await navigate(imported.id);
        await until(async () => (await page.locator('.pane-tab-surface:not([hidden])').innerText()).includes(markerA), 'imported read-only transcript loads');
        await shot('03-history-transcript.png');
        check('Exact Kimi history imports read-only and its assistant transcript loads');
      }
    }
  }
  await validateSessions();
  report.passed = true;
} catch (error) { await finalize(error); }
finally { await finalize(); }
