// Desktop-1 real-app transition probe. Fake Codex only; no product changes.
// Run against a fresh production build: node qa/chat-connect-transition-visual.mjs --theme light [--narrow]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { fixtureConnectStarted, selectWorkerOwner, summarizeFrames, waitForNonReadyConnection } from './lib/chat-connect-transition.mjs';
import { checkControlConsistency } from './lib/visual-consistency.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const theme = option('--theme') ?? 'light';
assert.ok(['light', 'dark'].includes(theme), '--theme must be light or dark');
const narrow = args.includes('--narrow');
const baselineCss = args.includes('--baseline-css');
process.env.TT_QA_DESKTOP = '1';
const runtime = resolve(option('--runtime') ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
const out = join(root, 'qa/results/chat-connect-transition', `${theme}-${narrow ? 'narrow' : 'wide'}${baselineCss ? '-baseline' : ''}`);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-connect-transition-'));
const bin = join(scratch, 'bin'), workspace = join(scratch, 'workspace'), control = join(scratch, 'control');
const fixture = join(root, 'qa/fixtures/fake-codex-connect-transition.cjs');
const log = join(scratch, 'fake-codex.jsonl');
const blocked = new Set(['path', 'codex_home', 'openai_api_key', 'openai_base_url', 'electron_run_as_node', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toLowerCase())));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-connect-transition-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RELOCATION_QA: '1', CODEX_HOME: join(scratch, 'codex-home'),
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: fixture,
  THREADTERM_QA_TRANSITION_CONTROL: control, THREADTERM_QA_TRANSITION_LOG: log, THREADTERM_QA_TRANSITION_CWD: workspace,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
assert.deepEqual(env.Path.split(';'), [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]);
const delay = ms => new Promise(done => setTimeout(done, ms));
let app, appProcess, page, cdp, project;
const report = { passed: false, phase: 3, theme, narrow, baselineCss, runtime, scratch, scenarios: [], errors: [] };
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chat = session => page.getByTestId(`session-chat-${session.id}`);
async function until(check, label, timeout = 35_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
const present = session => rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
const create = title => rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title, operationId: randomUUID() });
const fixtureRows = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function waitForFixtureConnect(afterIndex, nativeId) {
  let started;
  await until(async () => { started = fixtureConnectStarted(await fixtureRows(), afterIndex, nativeId); return Boolean(started); }, 'fixture received a new thread/start or thread/resume');
  console.log(JSON.stringify({ fixtureConnect: { pid: started.pid, at: started.at, method: started.method, threadId: started.params?.threadId } }));
  return started;
}
async function ready(session) {
  await until(async () => {
    const state = await rpc('chat.connection', { sessionId: session.id });
    // Some exits fail rather than auto-retry. Exercise the real overlay recovery action.
    if (state.phase === 'failed') {
      const retry = chat(session).getByRole('button', { name: 'Retry connection', exact: true });
      if (await retry.isVisible() && await retry.isEnabled()) await retry.click();
    }
    return state.phase === 'ready';
  }, `${session.title}: connection ready`);
  await until(() => chat(session).locator('textarea').isEnabled(), `${session.title}: composer ready`);
}
async function crash(session) {
  const rows = await fixtureRows();
  const snapshot = await rpc('runtime.snapshot');
  const nativeId = snapshot.sessions.find(row => row.id === session.id)?.nativeId;
  // Verification readers never own the worker. Do not retarget an already dead PID.
  const owner = selectWorkerOwner(rows, nativeId);
  assert.ok(owner?.pid, `Live fixture owner for ${session.id} (${nativeId})`);
  await writeFile(join(control, `crash-${owner.pid}`), 'fixture only\n');
  await until(async () => (await fixtureRows()).some(row => row.pid === owner.pid && row.direction === 'fixture' && row.method === 'crashed'), 'fake provider process exited');
  // The fixture logs just before exit; the supervised process may still be alive
  // at the first health check. Retry only here, with a bounded attempt count.
  const healthChecks = [];
  let health;
  try {
    health = await waitForNonReadyConnection(async () => {
      const state = await rpc('chat.connection', { sessionId: session.id });
      healthChecks.push({ at: Date.now(), phase: state.phase, connectionGeneration: state.connectionGeneration });
      return state;
    }, delay);
  } finally {
    console.log(JSON.stringify({ crash: { sessionId: session.id, nativeId, pid: owner.pid, at: Date.now(), health, healthChecks } }));
  }
  return { nativeId, pid: owner.pid, health };
}

// This runs entirely in the page, once per rAF. It does not poll RPC or change product state.
function installSampler({ sessionId, expectsTranscript }) {
  const state = { frames: [], events: [], done: false, raf: 0 };
  window.__connectTransition = state;
  const selectors = new WeakMap();
  let styles, boxes, opacities, styleReads;
  let trackedPane, descendants = [];
  const styleOf = node => {
    if (!styles.has(node)) { styles.set(node, getComputedStyle(node)); styleReads++; }
    return styles.get(node);
  };
  const boxOf = node => {
    if (!boxes.has(node)) boxes.set(node, node.getBoundingClientRect());
    return boxes.get(node);
  };
  const effectiveOpacity = node => {
    if (!(node instanceof Element)) return 1;
    if (opacities.has(node)) return opacities.get(node);
    const style = styleOf(node);
    const opacity = style.display === 'none' || style.contentVisibility === 'hidden' ? 0 : Number(style.opacity) * effectiveOpacity(node.parentElement);
    opacities.set(node, opacity);
    return opacity;
  };
  const visible = node => {
    if (!node) return false;
    const style = styleOf(node);
    if (style.visibility !== 'visible' || style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)' || effectiveOpacity(node) <= 0) return false;
    const rect = boxOf(node);
    // Visibility can be overridden by descendants: do not reject a hidden ancestor.
    return rect.width > 0 && rect.height > 0;
  };
  const selector = node => {
    if (selectors.has(node)) return selectors.get(node);
    const parts = [];
    for (let item = node; item instanceof Element; item = item.parentElement) {
      const testid = item.getAttribute('data-testid');
      if (testid) { parts.unshift(`[data-testid="${CSS.escape(testid)}"]`); break; }
      const siblings = item.parentElement ? [...item.parentElement.children].filter(other => other.tagName === item.tagName) : [];
      parts.unshift(`${item.tagName.toLowerCase()}${[...item.classList].filter(name => !name.startsWith('is-')).map(name => `.${CSS.escape(name)}`).join('')}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(item) + 1})` : ''}`);
      if (parts.length === 6) break;
    }
    const value = parts.join(' > '); selectors.set(node, value); return value;
  };
  const describe = (node, pane) => {
    const rect = boxOf(node);
    return { selector: selector(node), tag: node.tagName.toLowerCase(), testid: node.getAttribute('data-testid'), classes: [...node.classList],
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      structural: node === pane || node.contains(pane), effectiveOpacity: effectiveOpacity(node), inert: Boolean(node.closest('[inert]')) };
  };
  const sample = timestamp => {
    if (state.done) return;
    const started = performance.now();
    // Refresh style/geometry once per element per frame. Selector paths are stable
    // across frames; current class lists are still captured in every descriptor.
    styles = new WeakMap(); boxes = new WeakMap(); opacities = new WeakMap(); styleReads = 0;
    const pane = document.querySelector(`[data-testid="session-chat-${sessionId}"]`);
    // A cached live collection follows React inserts/removals without rebuilding
    // a whole-pane querySelectorAll result on every animation frame or an observer.
    if (pane !== trackedPane) { trackedPane = pane; descendants = pane?.getElementsByTagName('*') ?? []; }
    const panePresent = visible(pane);
    const mask = panePresent ? pane.querySelector('.chat-connect-mask') : null;
    const banner = panePresent ? pane.querySelector('.chat-reconnect-banner') : null;
    const overlay = mask ?? banner;
    const rect = pane ? boxOf(pane) : null;
    const frame = { time: performance.timeOrigin + timestamp, rafTime: timestamp, panePresent, expectsTranscript,
      fullOverlay: Boolean(mask), overlayPresent: Boolean(overlay), overlayKind: mask ? 'full' : banner ? 'banner' : 'none',
      overlayOpacity: overlay ? Number(styleOf(overlay).opacity) : null, overlayEffectiveOpacity: overlay ? effectiveOpacity(overlay) : null,
      gridTop: [], renderedOutside: [], composerReady: false, transcriptReady: false,
      paneRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null };
    if (panePresent) {
      const input = pane.querySelector('textarea');
      const chip = pane.querySelector('.chat-connection-chip');
      frame.chipClasses = chip ? [...chip.classList] : [];
      frame.connectionLabel = pane.querySelector('.chat-connection-label')?.textContent ?? '';
      frame.overlayStatus = overlay?.getAttribute('aria-label') ?? overlay?.textContent?.slice(0, 160) ?? '';
      frame.failedFull = Boolean(mask?.classList.contains('is-failed'));
      const retry = mask?.querySelector('.chat-connect-retry');
      frame.retryReady = visible(retry) && !retry.disabled;
      frame.composerReady = visible(input) && !input.disabled && !input.closest('[inert]');
      frame.transcriptReady = [...pane.querySelectorAll('.v3-message-text')].some(node => visible(node) && node.textContent.includes('TRANSITION-SAVED-ANSWER'));
      frame.emptyStateVisible = [...pane.querySelectorAll('.v3-empty')].some(visible);
      frame.inputDisabled = input?.disabled ?? true;
      if (mask) {
        const tops = new Map();
        const at = (x, y) => {
          const top = document.elementsFromPoint(x, y)[0];
          // Most of the grid hits the mask. Do not recompute its full ancestor
          // chain at every grid point. Inert-but-painted controls are found by the scan.
          if (top && !mask.contains(top) && visible(top)) { const descriptor = describe(top, pane); tops.set(descriptor.selector, descriptor); }
        };
        const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
        const gridStart = performance.now();
        // Run 48 spatial probes instead of 384 (run 4 measured 17–29 ms in
        // this loop alone). The exhaustive painted scan and offender-center
        // probes below still catch small/inert controls between grid points.
        frame.gridColumns = 8; frame.gridRows = 6;
        for (let x = 0; x < frame.gridColumns; x++) for (let y = 0; y < frame.gridRows; y++) at(left + (x + 0.5) * (right - left) / frame.gridColumns, top + (y + 0.5) * (bottom - top) / frame.gridRows);
        frame.gridMs = performance.now() - gridStart;
        const scanStart = performance.now();
        // Supplement the grid at small controls' centers so an 8 px dot cannot evade it.
        for (const node of descendants) {
          if (mask.contains(node) || !visible(node)) continue;
          const box = boxOf(node);
          if (box.right <= left || box.bottom <= top || box.left >= right || box.top >= bottom) continue;
          frame.renderedOutside.push(describe(node, pane));
          at(Math.max(left + 0.1, Math.min(right - 0.1, box.left + box.width / 2)), Math.max(top + 0.1, Math.min(bottom - 0.1, box.top + box.height / 2)));
        }
        frame.scanMs = performance.now() - scanStart;
        frame.gridTop = [...tops.values()];
      }
    }
    frame.samplingMs = performance.now() - started;
    frame.styleReads = styleReads;
    state.frames.push(frame);
    state.raf = requestAnimationFrame(sample);
  };
  state.unsubscribe = window.threadterm.onEvent(event => {
    if (['runtime.transport', 'chat.connection'].includes(event.event)) state.events.push({ time: Date.now(), event: event.event, data: event.data });
  });
  state.raf = requestAnimationFrame(sample);
}

async function sizeNarrow(session) {
  await chat(session).locator('textarea').click();
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
  await page.getByRole('button', { name: 'Split right', exact: true }).click();
  await page.keyboard.press('Escape');
  await until(async () => await page.locator('[data-pane-id]').count() === 2, 'split created');
  const divider = page.locator('[data-split-id] > .pane-divider');
  const target = await divider.evaluate(node => {
    const box = node.parentElement.getBoundingClientRect(), rect = node.getBoundingClientRect();
    if (!node.parentElement.classList.contains('horizontal')) throw new Error('Split stacked; Chat width would be invalid');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      endX: box.left + 400 + (parseFloat(getComputedStyle(node.parentElement).columnGap) || 0) + rect.width / 2 };
  });
  await page.mouse.move(target.x, target.y); await page.mouse.down();
  await page.mouse.move(target.endX, target.y, { steps: 8 }); await page.mouse.up();
  await until(() => chat(session).evaluate(node => { const width = node.getBoundingClientRect().width; return width >= 380 && width <= 420; }), 'real Chat pane resized to 380–420 px');
  // Split focuses the empty leaf. Select the original tab before opening subsequent chats.
  await page.getByRole('tab', { name: session.title, exact: true }).click();
}

async function probe(name, session, action, { expectsTranscript = false, expected = 'full', minimumOverlayMs = 0, requireFailedRetry = false } = {}) {
  const fixtureStart = (await fixtureRows()).length;
  const row = { name, sessionId: session.id, expected, screenshots: [], startedAt: Date.now() };
  report.scenarios.push(row);
  const casts = [];
  const onCast = event => {
    // CDP's ScreencastFrameMetadata.timestamp is Network.TimeSinceEpoch.
    // rAF timeOrigin + timestamp below uses the same epoch (not CDP MonotonicTime).
    if (Number.isFinite(event.metadata.timestamp)) casts.push({ time: event.metadata.timestamp * 1000, data: event.data, metadata: event.metadata });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onCast);
  let samplerInstalled = false;
  try {
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    // Explicit compositor images bracket the entire sampled transition. Capture
    // outside the rAF loop so image encoding cannot consume its frame budget.
    const beforeAction = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const beforePath = join(out, `${name}-before-action.png`);
    await writeFile(beforePath, Buffer.from(beforeAction.data, 'base64'));
    row.screenshots.push({ path: beforePath, capturedAt: Date.now(), role: 'before-action' });
    await page.evaluate(installSampler, { sessionId: session.id, expectsTranscript });
    samplerInstalled = true;
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await action();
    await until(() => page.evaluate(() => window.__connectTransition.frames.some(frame => frame.overlayPresent)), 'at least one sampled overlay frame');
    await ready(session);
    await until(() => chat(session).locator('.chat-connect-mask, .chat-reconnect-banner').count().then(count => count === 0), 'overlay removed');
    // Use page time, so at least 500 ms worth of animation frames are sampled after removal.
    await page.evaluate(() => new Promise(done => {
      const start = performance.now();
      const step = now => now - start >= 550 ? done() : requestAnimationFrame(step);
      requestAnimationFrame(step);
    }));
  } catch (error) { row.error = error.stack ?? String(error); }
  finally {
    let data = { frames: [], events: [] };
    try {
      if (samplerInstalled) data = await page.evaluate(() => {
        const state = window.__connectTransition; state.done = true; cancelAnimationFrame(state.raf); state.unsubscribe();
        return { frames: state.frames, events: state.events };
      });
      const finalState = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const finalPath = join(out, `${name}-final-state.png`);
      await writeFile(finalPath, Buffer.from(finalState.data, 'base64'));
      const finalFrame = data.frames.at(-1);
      row.screenshots.push({ path: finalPath, capturedAt: Date.now(), role: 'after-sampling', lastFrameTime: finalFrame?.time });
      row.settledCapture = Boolean(finalFrame?.panePresent && !finalFrame.overlayPresent && finalFrame.composerReady && (!expectsTranscript || finalFrame.transcriptReady));
      if (!row.settledCapture) row.captureError = 'Final compositor capture did not have a settled overlay-free Chat frame';
    } catch (error) { row.captureError = `Compositor capture failed: ${error.stack ?? String(error)}`; }
    finally {
      await cdp.send('Page.stopScreencast').catch(error => { row.captureError ??= `Could not stop screencast: ${String(error)}`; });
      cdp.off('Page.screencastFrame', onCast);
    }
    data.fixture = (await fixtureRows()).slice(fixtureStart);
    row.finishedAt = Date.now();
    row.fixture = data.fixture.filter(item => item.direction === 'fixture' || item.direction === 'in' && ['thread/start', 'thread/resume'].includes(item.method));
    row.connectionEvents = data.events.filter(item => item.data?.sessionId === session.id || item.event === 'runtime.transport');
    row.summary = summarizeFrames(data.frames);
    const overlayFrames = data.frames.filter(frame => frame.overlayPresent);
    row.coverage = { frames: data.frames.length, screencastFrames: casts.length,
      fullFrames: data.frames.filter(frame => frame.fullOverlay).length, bannerFrames: data.frames.filter(frame => frame.overlayKind === 'banner').length,
      overlayMs: overlayFrames.length ? overlayFrames.at(-1).time - overlayFrames[0].time : 0,
      maxRafGapMs: Math.max(0, ...data.frames.slice(1).map((frame, i) => frame.time - data.frames[i].time)),
      maxSamplingMs: Math.max(0, ...data.frames.map(frame => frame.samplingMs)), paneWidths: [...new Set(data.frames.filter(frame => frame.panePresent).map(frame => Math.round(frame.paneRect.width)))] };
    row.coverage.maxGridMs = Math.max(0, ...data.frames.map(frame => frame.gridMs ?? 0));
    row.coverage.maxScanMs = Math.max(0, ...data.frames.map(frame => frame.scanMs ?? 0));
    row.coverage.maxStyleReads = Math.max(0, ...data.frames.map(frame => frame.styleReads ?? 0));
    row.coverage.grid = { columns: 8, rows: 6 };
    row.coverage.compositorBracket = row.settledCapture;
    row.coverage.failedRetryFrames = data.frames.filter(frame => frame.failedFull && frame.retryReady).length;
    if (requireFailedRetry && !row.coverage.failedRetryFrames) row.coverageError = 'Failed full overlay never exposed its enabled Retry action';
    if (data.frames.some(frame => frame.overlayKind === 'banner' && frame.chipClasses.includes('is-idle'))) row.feedbackError = 'Reconnect banner exposed an idle connection chip';
    if (!overlayFrames.length || (expected === 'full' && !row.coverage.fullFrames) || (expected === 'banner' && !row.coverage.bannerFrames)
      || row.coverage.overlayMs < minimumOverlayMs) row.coverageError = `Required ${expected} overlay for >=${minimumOverlayMs} ms was not observed`;
    if (narrow && row.coverage.paneWidths.some(width => width < 380 || width > 420)) row.coverageError = `Chat must stay 380–420 px: ${row.coverage.paneWidths}`;
    // Keep the callback within one 60 Hz frame; allow up to three frames (50 ms)
    // between rAF samples (a busy QA host) — the leaks this guards against last hundreds of ms — with compositor
    // images at both transition ends.
    if (row.coverage.maxRafGapMs > 50 || row.coverage.maxSamplingMs > 16.7) row.samplingError = `Incomplete frame coverage: max rAF gap ${row.coverage.maxRafGapMs.toFixed(1)} ms, sample ${row.coverage.maxSamplingMs.toFixed(1)} ms`;
    await writeFile(join(out, `${name}.frames.json`), `${JSON.stringify(data)}\n`);
    // CDP screencasts are compositor evidence. Preserve the image nearest the first
    // leaking rAF, plus the first full/banner and the exit. Report timing skew explicitly.
    const firstOverlay = overlayFrames[0];
    const findings = [...row.summary.leaks, ...row.summary.fadeCandidates].sort((a, b) => a.firstMs - b.firstMs);
    const targets = [findings[0] && firstOverlay && { label: 'first-leak', time: firstOverlay.time + findings[0].firstMs, lastTime: firstOverlay.time + findings[0].lastMs },
      firstOverlay && { label: 'first-overlay', time: firstOverlay.time },
      overlayFrames.length && { label: 'overlay-exit', time: overlayFrames.at(-1).time + 17 }].filter(Boolean);
    for (const target of targets) {
      const matching = target.label === 'first-leak' ? casts.filter(item => item.time >= target.time && item.time <= target.lastTime + 17) : [];
      const cast = matching[0] ?? casts.reduce((best, item) => !best || Math.abs(item.time - target.time) < Math.abs(best.time - target.time) ? item : best, undefined);
      if (!cast) { row.captureError = 'No CDP compositor frames received'; continue; }
      const path = join(out, `${name}-${target.label}.png`);
      await writeFile(path, Buffer.from(cast.data, 'base64'));
      row.screenshots.push({ path, targetTime: target.time, captureTime: cast.time, skewMs: cast.time - target.time, metadata: cast.metadata });
      if (Math.abs(cast.time - target.time) > 50 || target.label === 'first-leak' && !matching.length) row.captureError = `${target.label} compositor capture is ${Math.round(cast.time - target.time)} ms from the sampled frame (budget: 50 ms, three frames on a busy QA host); rerun for usable evidence`;
    }
    row.passed = !row.error && !row.coverageError && !row.samplingError && !row.captureError && !row.feedbackError && !row.summary.leaks.length && !row.summary.fadeCandidates.length;
    console.log(JSON.stringify({ scenario: name, passed: row.passed, coverage: row.coverage, error: row.error, coverageError: row.coverageError, samplingError: row.samplingError, captureError: row.captureError, feedbackError: row.feedbackError, fixture: row.fixture, connectionEvents: row.connectionEvents, ...row.summary }));
  }
}

try {
  await Promise.all([bin, workspace, control, env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME, out].map(path => mkdir(path, { recursive: true })));
  await writeFile(log, ''); await writeFile(join(control, 'connect-delay-ms'), '2200');
  const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
  await writeFile(join(bin, 'shim.rs'), shim);
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  appProcess = app.process();
  report.electronPid = appProcess.pid;
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    globalThis.__transitionFocusEvents = [];
    electronApp.on('browser-window-focus', (_event, window) => globalThis.__transitionFocusEvents.push({ at: Date.now(), id: window.id }));
    if (BrowserWindow.getAllWindows().some(window => window.isFocused())) globalThis.__transitionFocusEvents.push({ initiallyFocused: true });
  });
  page = await app.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  if (baselineCss) await page.addStyleTag({ content: `
    /* QA-only reproduction of the old exception, including inert descendants. */
    .chat-view.v3-session-chat.is-connecting > .chat-compose-shell { z-index:21; }
    .chat-view.v3-session-chat.is-connecting > .chat-compose-shell .chat-status-anchor,
    .chat-view.v3-session-chat.is-connecting > .chat-compose-shell .chat-status-anchor * { visibility:visible; pointer-events:auto; }
  ` });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.webContents.setBackgroundThrottling(false); });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  cdp = await page.context().newCDPSession(page);
  const initial = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'en', theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  project = await rpc('project.add', { path: workspace, name: 'Connect transition QA', operationId: randomUUID() });
  const warmup = await create('Transition warmup'); await present(warmup); await ready(warmup);
  if (narrow) await sizeNarrow(warmup);

  const empty = await create('Transition empty chat');
  await probe('01-new-empty', empty, () => present(empty), { minimumOverlayMs: 1500 });
  await probe('02-empty-provider-crash', empty, async () => {
    const nativeId = (await rpc('runtime.snapshot')).sessions.find(row => row.id === empty.id).nativeId;
    await writeFile(join(control, `fail-${nativeId}`), 'exercise full-overlay Retry\n');
    await crash(empty);
    await until(async () => (await rpc('chat.connection', { sessionId: empty.id })).phase === 'failed', 'empty reconnect failed once');
    const retry = chat(empty).locator('.chat-connect-mask.is-failed .chat-connect-retry');
    await retry.waitFor(); assert.equal(await retry.isEnabled(), true, 'full-overlay Retry remains usable while the chip is hidden');
    await delay(350); // Capture failed status and Retry past the entrance animation.
    await retry.click();
  }, { minimumOverlayMs: 1500, requireFailedRetry: true });

  // Seed transcript through the normal composer, preserving its real lease and send path.
  await ready(empty); await chat(empty).locator('textarea').fill('transition transcript seed');
  await chat(empty).locator('textarea').press('Enter');
  await chat(empty).locator('.v3-message-text').filter({ hasText: 'TRANSITION-SAVED-ANSWER' }).waitFor();
  await until(async () => (await rpc('runtime.snapshot')).sessions.find(row => row.id === empty.id)?.status === 'idle', 'seed completed');
  await probe('03-transcript-provider-crash', empty, () => crash(empty), { expectsTranscript: true, expected: 'banner', minimumOverlayMs: 1500 });

  // Close the actual tab to dispose its retained ChatView; reopening genuinely loads history.
  await present(warmup); await ready(warmup);
  await page.locator('.workspace-tab').filter({ has: page.getByRole('tab', { name: empty.title, exact: true }) }).locator('.workspace-tab-close').click();
  await until(() => chat(empty).count().then(count => count === 0), 'transcript view unmounted');
  await crash(empty);
  // Defer only this isolated session's authentic snapshot reply. No synthetic data or events.
  await app.evaluate(({ ipcMain }, sessionId) => {
    const handlers = ipcMain._invokeHandlers, original = handlers?.get('threadterm:request');
    if (typeof original !== 'function') throw new Error('Electron invoke handler unavailable for loading-history probe');
    globalThis.__transitionSnapshotGate = { original, calls: 0 };
    handlers.set('threadterm:request', async (event, method, params) => {
      const value = await original(event, method, params);
      if (method === 'chat.snapshot' && params?.sessionId === sessionId) {
        globalThis.__transitionSnapshotGate.calls++;
        await new Promise(done => setTimeout(done, 900));
      }
      return value;
    });
  }, empty.id);
  try {
    await probe('03b-reopen-loading-transcript', empty, () => present(empty), { expectsTranscript: true, expected: 'full', minimumOverlayMs: 700 });
    report.snapshotDelayCalls = await app.evaluate(() => globalThis.__transitionSnapshotGate.calls);
    assert.ok(report.snapshotDelayCalls > 0, 'loading-history reply was actually delayed');
  } finally {
    await app.evaluate(({ ipcMain }) => { if (globalThis.__transitionSnapshotGate) { ipcMain._invokeHandlers.set('threadterm:request', globalThis.__transitionSnapshotGate.original); delete globalThis.__transitionSnapshotGate; } });
  }

  // Leave a failed worker to make chip Reconnect open a real slow replacement,
  // rather than the runtime's ready-worker fast path. The one-shot failure is fake-only.
  const nativeId = (await rpc('runtime.snapshot')).sessions.find(row => row.id === empty.id).nativeId;
  await writeFile(join(control, `fail-${nativeId}`), 'fail next fixture resume\n');
  await crash(empty);
  await until(async () => (await rpc('chat.connection', { sessionId: empty.id })).phase === 'failed', 'one-shot failed reconnect');
  // Exercise the chip's actual Reconnect control, including its open popover.
  await probe('04-connection-chip-reconnect', empty, async () => {
    const afterIndex = (await fixtureRows()).length - 1;
    await chat(empty).getByRole('button', { name: /^Connection:/ }).click();
    await chat(empty).getByRole('button', { name: 'Reconnect', exact: true }).click();
    await waitForFixtureConnect(afterIndex, nativeId);
  }, { expectsTranscript: true, expected: 'banner', minimumOverlayMs: 1500 });

  await probe('05-runtime-transport', empty, async () => {
    await page.evaluate(() => { if (!window.threadtermQa) throw new Error('Missing QA transport bridge'); return window.threadtermQa.dropControl(); });
    try {
      await until(() => chat(empty).locator('.chat-reconnect-banner').count().then(Boolean), 'transport loss banner');
      await delay(1800);
    } finally { await page.evaluate(() => window.threadtermQa.resumeControl()); }
  }, { expectsTranscript: true, expected: 'banner', minimumOverlayMs: 1500 });

  // A never-visited tab is connected by an isolated QA lease while another tab is visible.
  await present(warmup); await ready(warmup);
  const switching = await create('Transition connecting tab');
  const switchingRow = page.locator(`.project-catalog button.sess-row[data-session-id="${switching.id}"]`);
  await switchingRow.waitFor();
  const lease = await rpc('session.claim', { sessionId: switching.id, clientId: 'chat-connect-transition-visual' });
  const afterIndex = (await fixtureRows()).length - 1;
  let connectError;
  const connecting = rpc('chat.connect', { sessionId: switching.id, leaseEpoch: lease.leaseEpoch, operationId: randomUUID() }).catch(error => { connectError = String(error); });
  await waitForFixtureConnect(afterIndex);
  // session.present shares the ordered connect lane too. Local sidebar navigation
  // opens the chat immediately while the real fake-provider handshake is pending.
  await probe('06-open-connecting-tab', switching, () => switchingRow.click(), { minimumOverlayMs: 1000 });
  await connecting; assert.equal(connectError, undefined, connectError);

  // Run shared control checks after sampling, so helper hovers cannot contaminate frame evidence.
  report.controls = await checkControlConsistency(page, `[data-testid="session-chat-${switching.id}"]`);
  report.passed = report.scenarios.length === 7 && report.scenarios.every(row => row.passed) && !report.controls.error && report.controls.checked > 0 && report.controls.violations.length === 0;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'harness-failure.png') }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => { const state = window.__connectTransition; if (state) { state.done = true; cancelAnimationFrame(state.raf); state.unsubscribe?.(); } }).catch(() => {});
  if (cdp) await cdp.detach().catch(() => {});
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) {
    report.focusEvents = await app.evaluate(() => globalThis.__transitionFocusEvents ?? []).catch(() => []);
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {});
    report.appClosed = appProcess.exitCode !== null || appProcess.signalCode !== null;
    if (report.focusEvents.length || !report.appClosed) { report.passed = false; process.exitCode = 1; }
  }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, report: join(out, 'report.json'), errors: report.errors }));
  await cleanupApp();
}
