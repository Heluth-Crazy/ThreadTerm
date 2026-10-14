// LIVE chat-parity validation (task 10-11-chat-parity). Spends real model quota: run only with the user's approval.
// Real Electron on virtual Desktop 1 (never focused), the target-qa runtime on isolated ThreadTerm data, and the
// user's own agent CLIs and credentials. Every workspace is a temporary git repo; Claude, Grok and Pi history for
// those workspaces is removed afterwards (Codex, Kimi and OpenCode keep their sessions in their own history).
//   node qa/chat-parity-live.mjs probe                      connect each provider, dump options (no model turn)
//   node qa/chat-parity-live.mjs claude:turn codex:steer    run named scenarios in one app launch
//   add --reuse-app to skip rebuilding the app bundle.
// Never starts Gemini. Never runs commands that open a browser.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';
import { scenarios } from './chat-parity-live-scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const appDir = join(root, 'runtime/target-qa/parity-live-app');
const resultsRoot = join(root, 'qa/results/chat-parity-live');
const args = process.argv.slice(2);
const reuseApp = args.includes('--reuse-app');
const wanted = args.filter(arg => !arg.startsWith('--'));
if (!wanted.length) throw new Error('name at least one scenario (probe, <provider>:<scenario>)');
for (const name of wanted) if (!scenarios[name]) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(', ')}`);
if (wanted.some(name => /gemini/i.test(name))) throw new Error('Gemini is never started by this harness');

const scratch = await mkdtemp(join(tmpdir(), 'tt-parity-live-'));
const delay = ms => new Promise(done => setTimeout(done, ms));
const workspaces = [];
let app;
let page;
let settingsRevision = 0;

async function buildApp() {
  if (reuseApp && existsSync(join(appDir, 'renderer/index.html'))) return;
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'parity-live-qa', version: '0.1.0', main: 'main.cjs' }));
}

const git = (cwd, ...rest) => execFileSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@example.invalid', ...rest], { cwd, encoding: 'utf8', windowsHide: true });

async function makeWorkspace(name) {
  const dir = join(scratch, name);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# Parity sandbox\n\nA tiny project used by ThreadTerm live QA.\nThe magic number is 4817.\n');
  await writeFile(join(dir, 'src/math.js'), 'export function add(a, b) {\n  return a + b;\n}\n\n// TODO: add a subtract function\n');
  await writeFile(join(dir, 'src/greet.js'), "export const greet = name => `Hello, ${name}!`;\n// TODO: support a custom greeting\n");
  await writeFile(join(dir, 'package.json'), '{\n  "name": "parity-sandbox",\n  "version": "1.0.0",\n  "type": "module"\n}\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Initial sandbox');
  workspaces.push(dir);
  return dir;
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);

async function until(probe, label, timeout = 60_000, interval = 400) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() <= end) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(interval);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}

async function appearance({ theme = 'light', locale = 'en', width = 1100 } = {}) {
  const updated = await request('settings.update', {
    patch: { theme, language: locale, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } },
    expectedRevision: settingsRevision,
    operationId: randomUUID(),
  });
  settingsRevision = updated.revision ?? (await request('runtime.snapshot')).settings.revision;
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(lang => document.documentElement.lang === lang, locale);
}

async function setSettings(patch) {
  const updated = await request('settings.update', { patch, expectedRevision: settingsRevision, operationId: randomUUID() });
  settingsRevision = updated.revision ?? (await request('runtime.snapshot')).settings.revision;
}

// One Chat session presented in the workspace, with helpers bound to it.
async function openChat(provider, title, { workspace, dir } = {}) {
  const cwd = workspace ?? await makeWorkspace(`${provider}-${randomUUID().slice(0, 8)}`);
  const project = await request('project.add', { path: cwd, name: `${provider} live`, operationId: randomUUID() });
  const session = await request('session.create', { projectId: project.id, cwd, title, provider, mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  return attachChat(session, { dir, cwd });
}

// Helpers bound to an existing Chat session (for example a fork the runtime created).
async function attachChat(session, { dir, cwd }) {
  const provider = session.provider;
  const scope = page.locator(`[data-testid="session-chat-${session.id}"]`);
  const ctx = {
    provider, session, cwd, scope, dir, page, request,
    lease: async () => (await request('session.claim', { sessionId: session.id, clientId: 'threadterm-renderer' })).leaseEpoch,
    snapshot: async () => (await request('chat.snapshot', { sessionId: session.id })).items,
    status: async () => (await request('runtime.snapshot')).sessions.find(row => row.id === session.id)?.status,
    async connect(timeout = 120_000) {
      return until(async () => {
        const state = await request('chat.connection', { sessionId: session.id });
        if (state.phase === 'failed' || state.phase === 'unavailable') throw Object.assign(new Error(`connection ${state.phase}: ${JSON.stringify(state.error)}`), { fatal: true });
        return state.phase === 'ready' && state;
      }, `${provider} connection ready`, timeout);
    },
    async send(text, images) {
      const params = { sessionId: session.id, text, operationId: randomUUID(), leaseEpoch: await ctx.lease() };
      if (images) params.images = images;
      try { return await request('chat.send', params); } catch (error) {
        // The renderer shares this lease and can move its epoch between our claim and the send (the known
        // stale_lease race); the rejected send never ran, so claim again and retry once as a new operation.
        if (!/stale_lease/.test(error.message)) throw error;
        ctx.staleLeaseRetries = (ctx.staleLeaseRetries ?? 0) + 1;
        await delay(500);
        return request('chat.send', { ...params, operationId: randomUUID(), leaseEpoch: await ctx.lease() });
      }
    },
    // Same stale_lease race and single retry as send.
    async steer(turnId, text) {
      const params = { sessionId: session.id, turnId, text, operationId: randomUUID(), leaseEpoch: await ctx.lease() };
      try { return await request('chat.steer', params); } catch (error) {
        if (!/stale_lease/.test(error.message)) throw error;
        ctx.staleLeaseRetries = (ctx.staleLeaseRetries ?? 0) + 1;
        await delay(500);
        return request('chat.steer', { ...params, operationId: randomUUID(), leaseEpoch: await ctx.lease() });
      }
    },
    // Waits until the session is idle (or a predicate over the items holds), auto-failing on error status.
    async wait({ until: predicate, timeout = 300_000, label = 'turn' } = {}) {
      const end = Date.now() + timeout;
      let lastLease = 0;
      for (;;) {
        if (Date.now() > end) throw new Error(`${provider} ${label} timed out`);
        if (Date.now() - lastLease > 15_000) { await ctx.lease(); lastLease = Date.now(); }
        const items = await ctx.snapshot();
        const status = await ctx.status();
        if (predicate) {
          const hit = await predicate(items, status);
          if (hit) return { items, status, hit };
        } else if (status === 'idle' || status === 'awaiting_input') {
          const last = items.at(-1);
          if (last && last.role !== 'user') return { items, status };
        }
        if (status === 'error' || status === 'exited') return { items, status, ended: status };
        await delay(1000);
      }
    },
    async shot(name, { widths = [1100], theme = 'light', container } = {}) {
      const files = [];
      const selector = container ?? `[data-testid="session-chat-${session.id}"]`;
      for (const width of widths) {
        await appearance({ theme, width });
        await delay(400);
        const file = join(dir, `${name}-${theme}-${width}.png`);
        await page.screenshot({ path: file, animations: 'disabled' });
        // Every captured state must satisfy the shared VC rules before the presentation resets.
        assertNoControlViolations(await checkControlConsistency(page, selector), `${name} ${theme}/${width}`);
        files.push(file);
      }
      await appearance({ theme: 'light', width: 1100 });
      return files;
    },
    async stop() { try { await request('session.stop', { sessionId: session.id, operationId: randomUUID() }); } catch {} },
  };
  return ctx;
}

// Removes the Claude, Grok and Pi history this run created for its temporary workspaces.
async function cleanHistory() {
  const removed = [];
  const encodeClaude = path => path.replace(/[^a-zA-Z0-9]/g, '-');
  const claudeProjects = join(homedir(), '.claude/projects');
  for (const dir of workspaces) {
    const target = join(claudeProjects, encodeClaude(dir));
    if (existsSync(target)) { await rm(target, { recursive: true, force: true }); removed.push(target); }
  }
  const scrub = async (base, match) => {
    if (!existsSync(base)) return;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() && match(entry.name)) { const target = join(base, entry.name); await rm(target, { recursive: true, force: true }); removed.push(target); }
    }
  };
  const marker = scratch.split(/[\\/]/).at(-1);
  await scrub(join(homedir(), '.grok/sessions'), name => name.includes(marker));
  await scrub(join(homedir(), '.pi/agent/sessions'), name => name.includes(marker));
  return removed;
}

const summary = [];
try {
  if (!existsSync(runtime)) throw new Error(`missing ${runtime}; build runtime/target-qa first`);
  await buildApp();
  // The desktop starts the runtime outside any Claude Code session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)/.test(key)));
  Object.assign(env, {
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-parity-live-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
  });
  app = await electron.launch({ args: [appDir], cwd: scratch, env, timeout: 90_000 });
  page = await app.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  settingsRevision = (await request('runtime.snapshot')).settings.revision;
  await appearance({ theme: 'light', width: 1100 });
  const helpers = { request, until, delay, openChat, attachChat, makeWorkspace, setSettings, appearance, git, scratch };
  for (const name of wanted) {
    const dir = join(resultsRoot, name.replace(/[:]/g, '-'));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const report = { scenario: name, startedAt: new Date().toISOString(), checks: [], findings: [], data: {} };
    const pass = text => { report.checks.push(`PASS ${text}`); console.log(`[${name}] PASS ${text}`); };
    const fail = text => { report.checks.push(`FAIL ${text}`); console.log(`[${name}] FAIL ${text}`); };
    const note = text => { report.findings.push(text); console.log(`[${name}] NOTE ${text}`); };
    const expect = (ok, text, detail) => (ok ? pass(text) : fail(detail ? `${text} -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}` : text));
    try {
      await scenarios[name]({ ...helpers, dir, report, pass, fail, note, expect });
    } catch (error) {
      fail(`scenario aborted: ${error.stack ?? error.message}`);
    }
    report.endedAt = new Date().toISOString();
    report.pageErrors = pageErrors.splice(0);
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    summary.push({ name, failed: report.checks.filter(line => line.startsWith('FAIL')).length, passed: report.checks.filter(line => line.startsWith('PASS')).length });
  }
} finally {
  try { await app?.close(); } catch {}
  await delay(1500);
  const removed = await cleanHistory().catch(error => [`cleanup error: ${error.message}`]);
  console.log(`history cleanup: ${removed.length ? removed.join(', ') : 'nothing to remove'}`);
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(error => console.log(`scratch left at ${scratch}: ${error.message}`));
  console.log(JSON.stringify(summary));
}
if (summary.some(row => row.failed)) process.exitCode = 1;
