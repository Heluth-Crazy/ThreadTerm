// Real runtime + production desktop/ChatView, on Desktop 1, using local fakes only.
// node qa/send-latency-breakdown.mjs --runtime <exe> --sends 5 [--provider-delay 1500] [--keep]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { aggregateTrace, assertCheckpointTargets, checkpointTargetReport, parseTrace, summarizeRuns } from './lib/send-latency-breakdown.mjs';
import { removeScratch } from './lib/qa-cleanup.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { PROTOCOL_CONTRACT } from '../protocol/index.ts';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
if (process.argv.includes('--help')) {
  console.log('node qa/send-latency-breakdown.mjs --runtime <exe> [--sends 5] [--provider-delay 0] [--providers codex,opencode,acp,claude] [--assert] [--assert-tolerance 75] [--keep]\n'
    + 'Builds into Temp; writes qa/results/send-latency-breakdown/<run-id>.json. No installed agent is used.\n'
    + '--ignore-build excludes only the Temp fixture build folder, for a matched checkpoint comparison.\n'
    + '--assert requires a ready review checkpoint for every send, excludes each project\'s first warm-up only from timing, then requires repeated checkpoint median <= 150 ms (small) / 600 ms (user-shaped), plus p90 <= target + tolerance.');
} else {
  await main();
}

async function main() {
  assert.equal(process.platform, 'win32', 'Desktop-1 QA requires Windows');
  const runtime = resolve(option('--runtime') ?? 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
  assert.ok(existsSync(runtime), `Missing runtime: ${runtime}`);
  const sends = Number(option('--sends') ?? 5), providerDelay = Number(option('--provider-delay') ?? 0);
  const assertTargets = process.argv.includes('--assert'), assertToleranceMs = Number(option('--assert-tolerance') ?? 75);
  assert.ok(Number.isInteger(sends) && sends > 0 && sends <= 100, '--sends must be 1..100');
  assert.ok(Number.isFinite(providerDelay) && providerDelay >= 0 && providerDelay <= 20000, '--provider-delay must be 0..20000 ms');
  assert.ok(Number.isFinite(assertToleranceMs) && assertToleranceMs >= 0 && assertToleranceMs <= 1000, '--assert-tolerance must be 0..1000 ms');
  if (assertTargets) assert.ok(sends >= 3, '--assert requires at least three sends: one warm-up and two repeated samples');
  const providers = (option('--providers') ?? 'codex,opencode,acp,claude').split(',');
  assert.ok(providers.every(provider => ['codex', 'opencode', 'acp', 'claude'].includes(provider)), 'Unknown fake provider');
  const root = resolve(import.meta.dirname, '..'), scratch = await mkdtemp(join(tmpdir(), 'tt-send-breakdown-'));
  const bin = join(scratch, 'bin'), appDir = join(scratch, 'app'), fixture = join(root, 'qa/fixtures/send-latency-provider.cjs');
  const out = join(root, 'qa/results/send-latency-breakdown'), runId = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const report = { schema: 1, runId, passed: false, runtime, sends, providerDelay, ignoreBuild: process.argv.includes('--ignore-build'), runs: [], summaries: [],
    note: 'Clock domains are joined by request/operation ID only. Handoff includes adapter/native acceptance. Delayed Codex reply or ACP completion must not extend Sending: those adapters return on stdin write. Claude sidecar/HTTP OpenCode replies are awaited.',
    projects: {}, ...(assertTargets ? { checkpointAssertion: { enabled: true, toleranceMs: assertToleranceMs,
      definition: 'Requires a ready review checkpoint for every send, including warm-up. Excludes each provider/project first send only from timing. Repeated checkpoint median must be <= 150 ms (small) or <= 600 ms (user-shaped); nearest-rank p90 must be <= target + tolerance.' } } : {}),
    scratch: process.argv.includes('--keep') ? scratch : undefined };
  let app, page, activeData, releaseLock;
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  let realGit;
  const safeBase = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path$|home$|userprofile$|appdata$|localappdata$|temp$|tmp$|threadterm_|tt_qa_|codex|claude|grok|kimi|pi_|gemini|opencode|openai_|anthropic_|node_options$|electron_|git_)/iu.test(key)));
  const environment = base => {
    const env = { ...safeBase, PATH: [bin, dirname(process.execPath), system32].join(';'),
      HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), APPDATA: join(base, 'appdata'), LOCALAPPDATA: join(base, 'localappdata'),
      TEMP: join(base, 'tmp'), TMP: join(base, 'tmp'), CODEX_HOME: join(base, 'codex-home'),
      KIMI_CODE_HOME: join(base, 'kimi-home'), XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'share'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0',
      TT_QA_REAL_GIT: realGit, TT_QA_PROVIDER_DELAY_MS: String(providerDelay), TT_QA_LATENCY_LOG: join(base, 'native.jsonl'),
      TT_QA_OPENCODE_STATE: join(base, 'opencode.json'), TT_QA_OPENCODE_PORT_FILE: join(base, 'opencode.port'),
      THREADTERM_CLAUDE_NODE: process.execPath, THREADTERM_CLAUDE_SDK_HOST: fixture,
      THREADTERM_CLAUDE_PATH: join(bin, 'claude.cmd'), TT_QA_LATENCY_MODE: 'claude',
      THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_DATA: join(base, 'data'), THREADTERM_V3_USER_DATA: join(base, 'profile'),
      THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'plugins'), THREADTERM_V3_SEND_TRACE: '1',
      THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-send-breakdown-${randomUUID()}` };
    assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['PATH']);
    assert.deepEqual(env.PATH.split(';'), [bin, dirname(process.execPath), system32]);
    return env;
  };
  const readTrace = async () => parseTrace(await readFile(join(activeData, 'runtime.log'), 'utf8').catch(() => ''));
  const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  const until = async (probe, label, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise(done => setTimeout(done, 40)); }
    throw Error(`Timed out: ${label}`);
  };
  const closeApp = async () => {
    if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
    if (app) { await app.evaluate(({ app: desktop }) => desktop.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
    app = undefined; page = undefined;
  };
  try {
    await Promise.all([bin, appDir, out].map(path => mkdir(path, { recursive: true })));
    realGit = execFileSync(join(system32, 'where.exe'), ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean);
    assert.ok(realGit, 'Git must be available to prepare isolated repositories');
    assert.ok(existsSync(fixture));
    // Git is a forwarding executable so PATH contains only the fixture bin,
    // Node and System32. No installed agent directories or Git hooks are used.
    await writeFile(join(scratch, 'git.rs'), String.raw`use std::{env,process::{Command,Stdio},os::windows::process::CommandExt};fn main(){let result=Command::new(env::var_os("TT_QA_REAL_GIT").unwrap()).args(env::args_os().skip(1)).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).creation_flags(0x08000000).status().unwrap();std::process::exit(result.code().unwrap_or(1));}`);
    execFileSync('rustc', [join(scratch, 'git.rs'), '-O', '-o', join(bin, 'git.exe')], { windowsHide: true, stdio: 'pipe' });
    for (const provider of ['codex', 'claude']) await writeFile(join(bin, `${provider}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fixture}" --mode=${provider} %*\r\n`);
    await writeFile(join(bin, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${join(root, 'qa/fixtures/send-latency-opencode.mjs')}" %*\r\n`);
    const plugin = join(scratch, 'plugins', 'send-latency-echo');
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>');
    await writeFile(join(plugin, 'threadterm-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'send-latency-echo', name: 'Send Latency Echo',
      version: '0.1.0', publisher: 'ThreadTerm QA', description: 'Local acceptance timing fixture', contributes: { agents: [{
        id: 'latency-echo', name: 'Latency Echo', icon: 'icon.svg', command: 'node', args: [fixture, '--mode=acp'], versionArgs: ['--version'],
        terminal: { args: [], resumeArgs: [] }, chat: { protocol: 'acp', args: ['--acp'] }, homepage: 'https://example.invalid/latency' }] } }));
    const setupBase = join(scratch, 'setup'), setupEnv = environment(setupBase);
    await Promise.all(['home', 'tmp'].map(name => mkdir(join(setupBase, name), { recursive: true })));
    for (const [name, tracked, untracked] of [['small', 12, 0], ['user-shaped', 3000, 5000]]) {
      const path = join(scratch, name);
      await mkdir(join(path, 'src'), { recursive: true });
      const git = args => execFileSync(realGit, ['-c', 'core.hooksPath=' + join(scratch, 'no-hooks'), ...args],
        { cwd: path, env: setupEnv, stdio: 'pipe', windowsHide: true });
      git(['init']); git(['config', 'user.email', 'qa@example.invalid']); git(['config', 'user.name', 'Latency QA']);
      // Batches bound open file handles while creating the large fixture.
      for (let i = 0; i < tracked; i += 64) await Promise.all(Array.from({ length: Math.min(64, tracked - i) }, (_, j) =>
        writeFile(join(path, 'src', `tracked-${i + j}.txt`), `tracked fixture ${i + j}\n`)));
      git(['add', '.']); git(['commit', '-m', 'isolated fixture baseline']);
      const dirty = Math.min(tracked, 24);
      for (let i = 0; i < dirty; i++) await writeFile(join(path, 'src', `tracked-${i}.txt`), `dirty ${i}\n`);
      if (untracked) {
        const build = join(path, 'untracked-build'); await mkdir(build);
        for (let i = 0; i < untracked; i += 64) await Promise.all(Array.from({ length: Math.min(64, untracked - i) }, (_, j) =>
          writeFile(join(build, `object-${i + j}.o`), Buffer.alloc(128, 1))));
        for (let i = 0; i < 8; i++) await writeFile(join(build, `large-${i}.bin`), Buffer.alloc(8 * 1024 * 1024, 1));
        if (report.ignoreBuild) await writeFile(join(path, '.git/info/exclude'), 'untracked-build/\n');
      }
      report.projects[name] = { path: process.argv.includes('--keep') ? path : undefined, tracked, dirty, untracked,
        largeBinaries: untracked ? 8 : 0, largeBinaryBytes: untracked ? 8 * 1024 * 1024 : 0 };
    }
    // Build all output into Temp. The working renderer and config stay untouched.
    const [{ build }, { build: viteBuild }, { default: react }, { electron }] = await Promise.all([
      import('esbuild'), import('vite'), import('@vitejs/plugin-react'), import('./lib/desktop1.mjs')]);
    for (const name of ['main', 'preload']) await build({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true,
      platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    await viteBuild({ configFile: false, root: join(root, 'renderer'), base: './', plugins: [react()],
      css: { postcss: { plugins: [] } }, logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-send-breakdown-qa', version: '0.1.0', main: 'main.cjs' }));
    process.env.TT_QA_DESKTOP = '1';
    releaseLock = await acquireElectronQaLock();
    for (const provider of providers) for (const project of ['small', 'user-shaped']) {
      const base = join(scratch, `${provider}-${project}`), env = environment(base);
      await Promise.all(['home', 'appdata', 'localappdata', 'tmp', 'data', 'profile', 'codex-home', 'kimi-home', 'config', 'share']
        .map(name => mkdir(join(base, name), { recursive: true })));
      activeData = env.THREADTERM_V3_DATA;
      app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: bin, env, timeout: 60000 });
      page = await app.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(45000);
      await page.waitForFunction(() => Boolean(window.threadterm));
      assert.equal((await rpc('runtime.health')).contract, PROTOCOL_CONTRACT, 'Must be the real runtime bridge');
      const initial = await rpc('runtime.snapshot');
      await rpc('settings.update', { patch: { language: 'en', notifications: { native: false, attention: false, completed: false, sound: false } },
        expectedRevision: initial.settings.revision, operationId: randomUUID() });
      if (provider === 'acp') {
        await until(async () => (await rpc('plugin.list')).plugins.find(value => value.id === 'send-latency-echo'), 'plugin discovery');
        await rpc('plugin.setEnabled', { pluginId: 'send-latency-echo', enabled: true, operationId: randomUUID() });
        await until(async () => (await rpc('provider.list')).find(value => value.id === 'latency-echo' && value.chat), 'fake ACP provider');
      }
      const cwd = join(scratch, project), projectRow = await rpc('project.add', { path: cwd, name: project, operationId: randomUUID() });
      const session = await rpc('session.create', { projectId: projectRow.id, cwd, provider: provider === 'acp' ? 'latency-echo' : provider,
        mode: 'chat', title: `${provider} ${project}`, operationId: randomUUID() });
      await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
      await app.evaluate(({ BrowserWindow }, sessionId) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId }), session.id);
      const chat = page.locator(`[data-testid="session-chat-${session.id}"]`), box = chat.locator('.chat-compose-shell textarea');
      await box.waitFor({ state: 'visible' });
      await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'native ready');
      for (let index = 0; index < sends; index++) {
        await until(() => box.isEnabled(), 'composer enabled');
        const baseline = await until(async () => {
          const [connection, snapshot] = await Promise.all([rpc('chat.connection', { sessionId: session.id }), rpc('runtime.snapshot')]);
          const sessionStatus = snapshot.sessions.find(value => value.id === session.id)?.status;
          return connection.phase === 'ready' && sessionStatus === 'idle' ? { connectionPhase: connection.phase, sessionStatus } : undefined;
        }, 'canonical ready connection and idle session baseline');
        const before = new Set((await readTrace()).filter(row => row.source === 'desktop' && row.stage === 'desktop.request.begin').map(row => row.requestId));
        const prompt = `latency fixture ${provider} ${project} ${index}`;
        await box.fill(prompt);
        await box.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        // A per-submit observer records DOM state changes on the renderer clock.
        // It is disconnected at settlement/timeout. No product instrumentation.
        await chat.evaluate(element => {
          const form = element.querySelector('.chat-compose-shell');
          window.__sendLatency = { done: false };
          form.addEventListener('submit', () => {
            const started = performance.now(), state = window.__sendLatency;
            state.timeline = []; state.sendingObserved = false; state.buttonSendingObserved = false; state.sendingAtAnimationFrame = false;
            let last, frame, timeout;
            const settle = reason => {
              if (state.done) return;
              state.done = true; state.reason = reason; state.submitToSettledMs = performance.now() - started;
              state.submitToLabelSwitchMs ??= null;
              state.submitToButtonSwitchMs ??= null;
              observer.disconnect(); clearTimeout(timeout); cancelAnimationFrame(frame);
            };
            const check = () => {
              const status = element.querySelector('.chat-first-response-wait'), input = form.querySelector('textarea');
              const label = status?.getAttribute('aria-label') ?? null;
              const buttonLabel = form.querySelector('.chat-compose-send[type="submit"]')?.getAttribute('aria-label') ?? null;
              const sending = label === 'Sending…';
              const buttonSending = buttonLabel === 'Sending…';
              const signature = JSON.stringify([label, buttonLabel, input?.disabled, input?.value === '']);
              if (last !== signature) { state.timeline.push({ ms: performance.now() - started, label, buttonLabel, disabled: input?.disabled, empty: input?.value === '' }); last = signature; }
              if (sending) { state.sendingObserved = true; state.sendingBeganMs ??= performance.now() - started; }
              else if (state.sendingObserved) state.submitToLabelSwitchMs ??= performance.now() - started;
              if (buttonSending) state.buttonSendingObserved = true;
              else if (state.buttonSendingObserved) state.submitToButtonSwitchMs ??= performance.now() - started;
              if (!sending && !buttonSending && input?.value === '' && !input.disabled) settle(state.sendingObserved ? 'label-and-button-settled' : 'settled-without-observed-sending');
            };
            const observer = new MutationObserver(check);
            observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });
            const paint = () => { if (state.done) return; if (element.querySelector('.chat-first-response-wait')?.getAttribute('aria-label') === 'Sending…') state.sendingAtAnimationFrame = true; frame = requestAnimationFrame(paint); };
            frame = requestAnimationFrame(paint);
            timeout = setTimeout(() => settle('timeout'), 45000);
          }, { capture: true, once: true });
        });
        await chat.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
        await page.waitForFunction(() => window.__sendLatency?.done, undefined, { timeout: 50000 });
        const ui = await page.evaluate(() => window.__sendLatency);
        assert.notEqual(ui.reason, 'timeout', 'renderer never settled');
        const correlation = await until(async () => (await readTrace()).find(row => row.source === 'desktop'
          && row.stage === 'desktop.request.begin' && row.method === 'chat.send' && row.sessionId === session.id && !before.has(row.requestId)), 'send correlation');
        await until(async () => (await readTrace()).some(row => row.requestId === correlation.requestId && row.stage === 'desktop.request.end'), 'trace flush');
        const trace = aggregateTrace(await readTrace(), { operationId: correlation.operationId, requestId: correlation.requestId,
          strictSend: true, expectStdin: provider !== 'opencode' });
        assert.deepEqual(trace.missing, [], 'trace incomplete; do not infer absent stages as zero');
        assert.equal(trace.rows.find(row => row.stage === 'desktop.request.end')?.outcome, 'ok', 'chat.send failed');
        const related = (await readTrace()).filter(row => row.source === 'desktop' && row.stage === 'desktop.request.begin'
          && row.sessionId === session.id && !before.has(row.requestId) && row.method === 'chat.draft.save');
        await until(async () => { const rows = await readTrace(); return related.every(begin => rows.some(row => row.requestId === begin.requestId && row.stage === 'desktop.request.end')); }, 'draft trace flush');
        const allRows = await readTrace();
        const draftRequests = related.map(begin => ({ requestId: begin.requestId, operationId: begin.operationId,
          trace: aggregateTrace(allRows, { requestId: begin.requestId, operationId: begin.operationId }) }));
        report.runs.push({ provider, project, index, sessionId: session.id, baseline, ui, trace, draftRequests });
        console.log(`${provider.padEnd(8)} ${project.padEnd(12)} #${index + 1}: UI ${ui.submitToLabelSwitchMs?.toFixed(1) ?? 'not observed'} ms, checkpoint ${trace.metrics.checkpointMs?.toFixed(1)} ms, handoff ${trace.metrics.handoffMs?.toFixed(1)} ms`);
        // Preserve partial measurements if a later provider cannot connect.
        await writeFile(join(out, `${runId}.json`), JSON.stringify(report, null, 2) + '\n');
        // Async adapters can acknowledge before native turn.started. Idle alone
        // would incorrectly admit the next send during that gap.
        await until(async () => {
          const items = await rpc('chat.read', { sessionId: session.id });
          const hasAnswer = items.some(item => item.turnId === correlation.operationId && item.role === 'assistant'
            && item.parts.some(part => part.type === 'text' && (part.text === 'QA latency result' || part.text?.startsWith('echo:latency fixture'))));
          return hasAnswer && (await rpc('runtime.snapshot')).sessions.find(value => value.id === session.id)?.status === 'idle';
        }, 'fake answer projected and turn idle');
        const checkpoint = await until(async () => {
          const review = await rpc('review.list', { sessionId: session.id });
          const found = review.checkpoints.find(value => value.label === prompt);
          return found ? { id: found.id, label: found.label, status: found.status, turnId: found.turnId ?? null,
            expectedTurnId: correlation.operationId, turnIdMatchesExpected: found.turnId === correlation.operationId } : undefined;
        }, 'review checkpoint for fixture prompt');
        report.runs.at(-1).checkpoint = checkpoint;
      }
      await until(async () => (await rpc('runtime.snapshot')).sessions.find(value => value.id === session.id)?.status === 'idle', 'final turn idle');
      const review = await rpc('review.list', { sessionId: session.id });
      (report.checkpoints ??= []).push({ provider, project, value: review });
      (report.nativeLogs ??= []).push({ provider, project, jsonl: await readFile(env.TT_QA_LATENCY_LOG, 'utf8').catch(() => '') });
      await closeApp();
    }
    if (assertTargets) {
      report.checkpointAssertion = { ...report.checkpointAssertion,
        ...checkpointTargetReport(report.runs, { toleranceMs: assertToleranceMs, requireReadyCheckpoints: true }) };
      assertCheckpointTargets(report.runs, { toleranceMs: assertToleranceMs, requireReadyCheckpoints: true });
    }
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
    if (page) await page.screenshot({ path: join(out, `${runId}-failure.png`) }).catch(() => {});
  } finally {
    await closeApp();
    await releaseLock?.();
    report.summaries = summarizeRuns(report.runs);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `${runId}.json`), JSON.stringify(report, null, 2) + '\n');
    const fmt = value => value == null ? '?' : value.toFixed(1);
    console.table(report.summaries.map(value => ({ group: value.group, n: value.n,
      'UI med/p90 ms': `${fmt(value.ui.median)}/${fmt(value.ui.p90)}`, 'no Sending sample': value.sendingNotObserved,
      'button med/p90 ms': `${fmt(value.button.median)}/${fmt(value.button.p90)}`,
      'queue med ms': fmt(value.metrics.orderedQueueMs?.median), 'checkpoint med ms': fmt(value.metrics.checkpointMs?.median),
      'worker lock med ms': fmt(value.metrics.workerLockMs?.median), 'record med ms': fmt(value.metrics.recordMs?.median),
      'handoff med ms': fmt(value.metrics.handoffMs?.median), 'complete med ms': fmt(value.metrics.completeMs?.median),
      'stdin med ms': fmt(value.metrics.stdinWriteMs?.median), 'service med ms': fmt(value.metrics.serviceMs?.median),
      'runtime med ms': fmt(value.metrics.runtimeDispatchMs?.median),
      'other runtime med ms': fmt(value.metrics.runtimeOtherMs?.median),
      'desktop pre-write med ms': fmt(value.metrics.desktopBeforeWriteMs?.median),
      'desktop round-trip med ms': fmt(value.metrics.desktopRoundTripMs?.median),
      'desktop total med ms': fmt(value.metrics.desktopTotalMs?.median) })));
    if (Array.isArray(report.checkpointAssertion?.checks)) console.table(report.checkpointAssertion.checks.map(value => ({ group: value.group,
      'warm-up excluded': value.excludedWarmup, 'repeated n': value.samples.n,
      'ready checkpoints': `${value.checkpoints.ready}/${value.checkpoints.ready + value.checkpoints.invalid}`,
      'checkpoint turn-ID mismatches': value.checkpoints.turnIdMismatches,
      'checkpoint med/p90 ms': `${fmt(value.samples.median)}/${fmt(value.samples.p90)}`,
      'target/p90 limit ms': `${value.targetMs.toFixed(1)}/${value.p90LimitMs.toFixed(1)}`,
      pass: value.passed, failures: value.failures.join('; ') })));
    console.log(`Report: ${join(out, `${runId}.json`)}; passed=${report.passed}`);
    if (report.error) console.error(report.error);
    if (!process.argv.includes('--keep')) {
      const safe = resolve(scratch), tempRoot = resolve(tmpdir());
      assert.ok(safe.toLowerCase().startsWith((tempRoot + '\\tt-send-breakdown-').toLowerCase()), 'Refusing cleanup outside owned Temp fixture');
      await removeScratch(safe).catch(error => console.error(`Retained fixture after cleanup failure: ${error.message}`));
    }
  }
}
