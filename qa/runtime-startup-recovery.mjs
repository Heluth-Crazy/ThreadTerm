// Desktop-1 regression QA for issue 13: an initially unavailable runtime must
// recover after its pipes bind, without replaying the failed request or asking
// the user to click Retry connection.  This uses the built production Electron
// main/renderer and a deliberately minimal authenticated named-pipe runtime.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'qa/results/runtime-startup-recovery');
const credential = `startup-recovery-${randomUUID()}`;
const pipe = `\\\\.\\pipe\\tt-startup-recovery-${randomUUID()}`;
const report = { passed: false, checks: [], timings: {}, requests: [], screenshots: [], errors: [] };
const startedAt = Date.now();
let app;
let page;
let control;
let output;
let scratch;

const elapsed = () => Date.now() - startedAt;
const note = value => { report.checks.push(value); process.stdout.write(`PASS ${value}\n`); };

function framed(socket) {
  let incoming = Buffer.alloc(0);
  const listeners = new Set();
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = incoming.readUInt32LE(0);
      if (incoming.length < 4 + length) return;
      const frame = incoming.subarray(4, 4 + length);
      incoming = incoming.subarray(4 + length);
      for (const listener of listeners) listener(frame);
    }
  });
  return {
    on: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    send: value => {
      const body = Buffer.from(JSON.stringify(value), 'utf8');
      const frame = Buffer.allocUnsafe(4 + body.length);
      frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
    },
  };
}

function snapshot() {
  return {
    epoch: 'startup-recovery-epoch', revision: 0, projects: [], sessions: [], workspaces: [], presets: [], inbox: [], providers: [],
    settings: { revision: 0, theme: 'system', language: 'en', notifications: { native: false, attention: false, completed: false, sound: false } },
  };
}

function fakePipe(name, kind) {
  return new Promise((resolveServer, rejectServer) => {
    const server = net.createServer(socket => {
      const peer = framed(socket);
      const nonce = randomUUID();
      let authenticated = false;
      peer.send({ kind: 'challenge', nonce, protocol: 1, contract: 11 });
      peer.on(frame => {
        const value = JSON.parse(frame.toString('utf8'));
        if (!authenticated) {
          assert.equal(value.kind, 'auth', `${kind}: first client frame must authenticate`);
          const expected = createHmac('sha256', credential).update(`1:${value.clientId}:${nonce}`).digest('hex');
          assert.equal(value.hmac, expected, `${kind}: client HMAC must verify`);
          authenticated = true;
          peer.send({ kind: 'authenticated', principal: value.clientId, epoch: 'startup-recovery-epoch', contract: 11, hmac: createHmac('sha256', credential).update(`server:1:${value.clientId}:${nonce}`).digest('hex') });
          return;
        }
        if (kind !== 'control' || !value?.method) return;
        report.requests.push({ method: value.method, atMs: elapsed() });
        if (value.method === 'runtime.snapshot') peer.send({ v: 1, id: value.id, result: snapshot() });
        else if (['catalog.visibility.list', 'project.catalog.list'].includes(value.method)) peer.send({ v: 1, id: value.id, result: [] });
        else peer.send({ v: 1, id: value.id, error: { code: 'qa_unexpected_request', message: `QA fake runtime does not implement ${value.method}` } });
      });
    });
    server.once('error', rejectServer);
    server.listen(name, () => resolveServer(server));
  });
}

async function buildApp(appDir) {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'runtime-startup-recovery-qa', version: '0.1.0', main: 'main.cjs' }));
}

function isolatedEnvironment() {
  const dropped = /^(path|codex_home|home|userprofile|appdata|localappdata|openai_api_key|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|threadterm_v3_runtime|threadterm_claude_node|threadterm_claude_electron_node)$/iu;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  const home = join(scratch, 'home');
  Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CODEX_HOME: join(home, '.codex'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'user-data'),
    THREADTERM_V3_PIPE: pipe,
    // Normal auto-launch remains enabled. Node receives no script/stdin and exits;
    // it cannot run the real runtime or a provider.
    THREADTERM_V3_RUNTIME: process.execPath,
    THREADTERM_CLAUDE_NODE: process.execPath,
  });
  return env;
}

try {
  assert.ok(process.platform === 'win32', 'runtime startup recovery QA requires Windows named pipes');
  assert.ok(existsSync(join(root, 'renderer/public/brand-mark.png')), 'built boot screen needs renderer/public/brand-mark.png');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  scratch = await mkdtemp(join(tmpdir(), 'tt-startup-recovery-'));
  await mkdir(join(scratch, 'data'), { recursive: true });
  await writeFile(join(scratch, 'data', 'runtime.credential'), credential);
  const appDir = join(out, 'app');
  await buildApp(appDir);
  app = await electron.launch({ args: [appDir], cwd: scratch, env: isolatedEnvironment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  const bootMark = page.locator('#boot-splash .bs-mark');
  await bootMark.waitFor();
  assert.equal(await bootMark.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0), true, 'actual built boot screen loads the product mark');
  await page.screenshot({ path: join(out, 'built-boot-before-runtime.png'), animations: 'disabled' });
  report.screenshots.push(join(out, 'built-boot-before-runtime.png'));
  note('built production boot screen loaded the product mark before the delayed runtime became available');

  // The unavailable page appears only after the 1.5s first probe and 12s
  // auto-launch readiness budget have failed. Bind no fake pipe before this.
  await page.getByRole('heading', { name: 'Runtime unavailable' }).waitFor({ timeout: 22_000 });
  report.timings.unavailableAtMs = elapsed();
  assert.ok(report.timings.unavailableAtMs >= 12_500, `initial unavailable state arrived before the expected startup budgets (${report.timings.unavailableAtMs}ms)`);
  assert.equal(await page.getByRole('button', { name: 'Retry connection' }).count(), 1, 'initial failure exposed its ordinary retry affordance');
  assert.equal(report.requests.length, 0, 'no authenticated request was sent before either pipe bound');
  note('initial caller failed after the normal startup budget; the harness did not click Retry connection');

  control = await fakePipe(`${pipe}-control`, 'control');
  output = await fakePipe(`${pipe}-output`, 'output');
  report.timings.pipesBoundAtMs = elapsed();
  assert.ok(report.timings.pipesBoundAtMs > report.timings.unavailableAtMs, 'fake pipes bound only after the initial request had failed');

  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 15_000 });
  await page.getByRole('heading', { name: 'Where do you want to start?' }).waitFor({ timeout: 15_000 });
  await page.getByText('Runtime connected', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('No projects yet. Add a directory to get started.', { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.project-catalog [role="alert"]').count(), 0, 'sidebar cleared its initial connection error');
  report.timings.recoveredAtMs = elapsed();
  await page.screenshot({ path: join(out, 'built-app-recovered-without-retry.png'), animations: 'disabled' });
  report.screenshots.push(join(out, 'built-app-recovered-without-retry.png'));
  assert.equal(await page.getByRole('button', { name: 'Retry connection' }).count(), 0, 'renderer refreshed automatically and no unavailable action remained');
  assert.ok(report.requests.some(request => request.method === 'runtime.snapshot'), 'automatic reconnection refreshed the authoritative snapshot');
  assert.ok(report.requests.some(request => request.method === 'catalog.visibility.list'), 'automatic reconnection refreshed renderer catalog visibility');
  assert.ok(report.requests.some(request => request.method === 'project.catalog.list'), 'automatic reconnection refreshed the project sidebar');
  const mutations = report.requests.filter(request => !['runtime.snapshot', 'catalog.visibility.list', 'project.catalog.list'].includes(request.method));
  assert.deepEqual(mutations, [], `automatic recovery must not replay or invent mutation requests (${mutations.map(request => request.method).join(', ')})`);
  assert.equal(report.requests.some(request => /^(session\.create|agent\.|chat\.)/.test(request.method)), false, 'recovery did not create a session or invoke an agent/provider turn');
  note('existing renderer connection recovered automatically after pipe readiness and refreshed the app without replaying a mutation');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true }).catch(() => undefined);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  await Promise.all([control, output].filter(Boolean).map(server => new Promise(resolveClose => server.close(() => resolveClose()))));
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  process.stdout.write(`${report.passed ? 'RUNTIME STARTUP RECOVERY QA PASSED' : 'RUNTIME STARTUP RECOVERY QA FAILED'} ${join(out, 'report.json')}\n`);
}
