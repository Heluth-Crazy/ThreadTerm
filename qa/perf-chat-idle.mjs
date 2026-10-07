// Desktop 1 performance regression QA for an idle, maximized Chat with a Markdown preview. It records, over each idle
// phase: running CSS/Web animations, style/layout/task time from
// CDP Performance metrics, per-process CPU from app.getAppMetrics(), and a trace summary (frames, paints, GPU work).
// During a mouse drag over a Markdown editor it also records frame intervals.
//   node qa/perf-chat-idle.mjs [--chrome=native|transparent] [--no-occlusion]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/context-tray-echo-acp');
const chrome = process.argv.find(arg => arg.startsWith('--chrome='))?.slice(9);
const label = chrome ?? 'default';
const out = join(root, 'qa/results/perf-chat-idle');
const scratch = await mkdtemp(join(tmpdir(), 'tt-perf-'));
const appDir = join(root, 'runtime/target-qa/perf-qa-app');
const report = { chrome: label, phases: {}, errors: [] };
let app, page, cdp;
const delay = ms => new Promise(done => setTimeout(done, ms));
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, what, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { try { const value = await probe(); if (value) return value; } catch {} if (Date.now() > end) throw Error(`Timed out: ${what}`); await delay(150); } }
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true, minify: false } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-perf-qa', version: '0.1.0', main: 'main.cjs' }));
}

function runtimeCpu() {
  const runtimePath = runtime.replace(/'/g, "''");
  const command = `$process = Get-Process -Name threadterm-v3-runtime -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${runtimePath}' }; if ($null -eq $process) { exit 3 }; ($process | Measure-Object -Property CPU -Sum).Sum`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const value = Number(result.stdout.trim()); return Number.isFinite(value) ? value : null;
}

async function metrics() { const { metrics: rows } = await cdp.send('Performance.getMetrics'); return Object.fromEntries(rows.map(row => [row.name, row.value])); }
async function cpu() { return app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(row => ({ type: row.type, name: row.name ?? '', cpu: row.cpu.percentCPUUsage }))); }

async function trace(action, ms) {
  const chunks = [];
  const done = new Promise(resolveDone => cdp.once('Tracing.tracingComplete', resolveDone));
  const onData = event => chunks.push(...event.value);
  cdp.on('Tracing.dataCollected', onData);
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'viz', 'gpu', 'cc', 'blink', 'toplevel'] } });
  const started = Date.now();
  await action();
  const rest = ms - (Date.now() - started); if (rest > 0) await delay(rest);
  await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', onData);
  const seconds = Math.max(ms, Date.now() - started) / 1000;
  const totals = new Map();
  const count = name => chunks.filter(event => event.name === name && event.ph !== 'E').length;
  for (const event of chunks) {
    if (event.ph !== 'X' || typeof event.dur !== 'number') continue;
    const row = totals.get(event.name) ?? { ms: 0, n: 0 }; row.ms += event.dur / 1000; row.n += 1; totals.set(event.name, row);
  }
  const top = [...totals].sort((a, b) => b[1].ms - a[1].ms).slice(0, 18).map(([name, row]) => `${name}: ${row.ms.toFixed(0)} ms / ${row.n}`);
  return { seconds, framesPerSecond: { drawFrame: +(count('DrawFrame') / seconds).toFixed(1), beginFrame: +(count('BeginFrame') / seconds).toFixed(1), paint: +(count('Paint') / seconds).toFixed(1), updateLayerTree: +(count('UpdateLayerTree') / seconds).toFixed(1) }, topDurations: top };
}

async function profile(name, ms) {
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
  await delay(ms);
  const { profile: data } = await cdp.send('Profiler.stop');
  const byId = new Map(data.nodes.map(node => [node.id, node])); const parent = new Map();
  for (const node of data.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const label = node => `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
  const self = new Map(), components = new Map(), chains = new Map();
  const counts = new Map(); for (const id of data.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
  let total = 0, idle = 0;
  for (const [id, n] of counts) {
    const node = byId.get(id); total += n;
    if (['(idle)', '(program)', '(garbage collector)'].includes(node.callFrame.functionName)) { if (node.callFrame.functionName === '(idle)') idle += n; continue; }
    self.set(label(node), (self.get(label(node)) ?? 0) + n);
    const stack = []; for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) stack.push(byId.get(cursor));
    const named = stack.filter(frame => /^[A-Z][A-Za-z0-9]+$/.test(frame.callFrame.functionName) && frame.callFrame.url.includes('assets'));
    const component = named[0] ? label(named[0]) : '(no component)';
    components.set(component, (components.get(component) ?? 0) + n);
    const chain = stack.slice(0, 14).map(label).reverse().join(' > ');
    chains.set(chain, (chains.get(chain) ?? 0) + n);
  }
  const top = (map, k) => [...map].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, n]) => `${(100 * n / total).toFixed(1)}% ${key}`);
  const result = { busyPct: +(100 * (total - idle) / total).toFixed(1), selfTop: top(self, 25), componentTop: top(components, 15), stackTop: top(chains, 12) };
  report.phases[name] = result; console.log(`
=== ${name}
${JSON.stringify(result, null, 1)}`);
}

async function measure(name, { action = async () => {}, ms = 3000 } = {}) {
  await delay(800);
  const animations = await page.evaluate(() => document.getAnimations().filter(item => item.playState === 'running').map(item => {
    const target = item.effect?.target; const describe = node => node ? `${node.tagName?.toLowerCase()}${node.id ? `#${node.id}` : ''}${typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : ''}` : '?';
    let visible = false; if (target?.getBoundingClientRect) { const box = target.getBoundingClientRect(); const style = getComputedStyle(target); visible = box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && !target.closest('[hidden]'); }
    return { name: item.animationName ?? item.transitionProperty ?? item.constructor.name, target: `${describe(target?.parentElement)} > ${describe(target)}`, visible };
  }));
  const visibility = await page.evaluate(() => document.visibilityState);
  const size = await app.evaluate(({ BrowserWindow, screen }) => { const window = BrowserWindow.getAllWindows()[0]; const [w, h] = window.getContentSize(); return { w, h, maximized: window.isMaximized(), scale: screen.getDisplayMatching(window.getBounds()).scaleFactor }; });
  await cpu(); const runtimeBefore = runtimeCpu();
  const before = await metrics();
  const traced = await trace(action, ms);
  const after = await metrics();
  const processes = await cpu(); const runtimeAfter = runtimeCpu();
  const delta = key => +((after[key] ?? 0) - (before[key] ?? 0)).toFixed(3);
  const phase = { visibility, size, animations, perSecond: { recalcStyle: +(delta('RecalcStyleCount') / traced.seconds).toFixed(1), layout: +(delta('LayoutCount') / traced.seconds).toFixed(1) },
    mainThreadBusyPct: +(100 * delta('TaskDuration') / traced.seconds).toFixed(1), styleMs: +(1000 * delta('RecalcStyleDuration')).toFixed(0), layoutMs: +(1000 * delta('LayoutDuration')).toFixed(0), scriptMs: +(1000 * delta('ScriptDuration')).toFixed(0),
    runtimeCpuPct: runtimeBefore != null && runtimeAfter != null ? +(100 * (runtimeAfter - runtimeBefore) / traced.seconds).toFixed(1) : null,
    cpuPct: processes.filter(row => row.cpu >= 0.5).map(row => `${row.type}${row.name ? `(${row.name})` : ''}: ${row.cpu.toFixed(1)}%`), trace: traced };
  report.phases[name] = phase;
  console.log(`\n=== ${name}\n${JSON.stringify(phase, null, 1)}`);
}

function assertIdlePhase(name, { maximized, contentSize } = {}) {
  const phase = report.phases[name];
  assert.equal(phase.size.maximized, maximized, `${name} maximized state`);
  if (contentSize) assert.deepEqual([phase.size.w, phase.size.h], contentSize, `${name} content size`);
  assert.ok(phase.mainThreadBusyPct < 5, `${name} renderer main-thread busy ${phase.mainThreadBusyPct}% must be below 5%`);
  assert.ok(phase.runtimeCpuPct != null && phase.runtimeCpuPct < 2, `${name} runtime CPU ${phase.runtimeCpuPct}% must be below 2%`);
  assert.equal(phase.animations.length, 0, `${name} expected no running animations after attention pulse, found ${JSON.stringify(phase.animations)}`);
}

try {
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  assert.ok(existsSync(runtime), `missing ${runtime}`);
  await buildApp();
  const plugins = join(scratch, 'plugins'); cpSync(fixture, join(plugins, 'context-tray-echo-acp'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  Object.assign(env, { PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-perf-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins });
  if (chrome) env.THREADTERM_V3_WINDOW_CHROME = chrome;
  // The QA window lives on another virtual desktop; Windows reports it cloaked, which Chromium treats as occluded and
  // stops drawing. The user's window is visible, so draw as if it were.
  const args = [appDir, ...(process.argv.includes('--no-occlusion') ? ['--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] : [])];
  app = await electron.launch({ args, cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await until(() => app.evaluate(({ BrowserWindow }) => { const [w, h] = BrowserWindow.getAllWindows()[0].getContentSize(); return w === 1440 && h === 900; }), '1440x900 content size');
  cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'context-tray-echo-acp'), 'Echo discovered');
  await request('plugin.setEnabled', { pluginId: 'context-tray-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === 'context-tray-echo' && row.chat), 'Echo enabled');
  const work = join(scratch, 'repo'); await mkdir(join(work, 'docs'), { recursive: true });
  const markdown = Array.from({ length: 60 }, (_, section) => `## Section ${section + 1}\n\nSome **bold** text, a [link](https://example.invalid) and \`code\`.\n\n- item one\n- item two\n\n\`\`\`ts\nconst value${section} = ${section};\n\`\`\`\n`).join('\n');
  await writeFile(join(work, 'docs/plan.md'), `# Plan\n\n${markdown}`); git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'QA'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'init');
  const project = await request('project.add', { path: work, name: 'Perf QA', operationId: randomUUID() });
  await measure('1-home-1440x900');

  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Perf Echo', provider: 'context-tray-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const composer = page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-shell textarea`);
  await until(() => composer.isEnabled(), 'chat composer ready');
  const turns = Number(process.env.PERF_TURNS || 20);
  assert.ok(Number.isInteger(turns) && turns > 0, 'PERF_TURNS must be a positive integer');
  const body = turn => turns === 1 ? 'hello there' : `Turn ${turn}: please review

## Notes

- **first** point with \`code\`
- second point with a [link](https://example.invalid)

\`\`\`ts
export function f${turn}(value: number) { return value * ${turn}; }
\`\`\`

${'Some longer paragraph text that wraps across the transcript width. '.repeat(6)}`;
  for (let turn = 1; turn <= turns; turn += 1) {
    await composer.fill(body(turn)); await page.locator('.chat-compose-send[aria-label="Send"]').click();
    await until(async () => (await request('chat.snapshot', { sessionId: chat.id })).items.filter(item => item.role === 'assistant').length >= turn, `echo reply ${turn}`, 60_000);
  }
  await page.screenshot({ path: join(out, '2-chat.png') });
  await delay(8_000);
  await measure('2-chat-1440x900');
  assertIdlePhase('2-chat-1440x900', { maximized: false, contentSize: [1440, 900] });
  await profile('2-chat-profile', 3000);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await until(() => page.locator('.app-shell.is-maximized').count(), 'maximized shell');
  await measure('3-chat-maximized');
  assertIdlePhase('3-chat-maximized', { maximized: true });
  await page.mouse.move(400, 300);
  await measure('3b-chat-maximized-mouse-moving', { action: async () => { for (let step = 0; step < 60; step += 1) { await page.mouse.move(300 + (step % 30) * 30, 200 + (step % 7) * 60); await delay(30); } } });

  await page.locator('.wb-switcher').getByRole('button', { name: 'Files', exact: true }).click().catch(() => {});
  await page.locator('.wb-tree-row[data-path="docs"]').click(); await page.locator('.wb-tree-row[data-path="docs/plan.md"]').click();
  const preview = page.locator('.markdown-preview:visible').first(); await preview.waitFor();
  const chatPane = page.locator(`[data-testid="session-chat-${chat.id}"]:visible`); await chatPane.waitFor();
  const [chatBox, previewBox, viewport] = await Promise.all([chatPane.boundingBox(), preview.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
  assert.ok(chatBox && previewBox, 'Chat and Markdown preview panes must have geometry');
  assert.ok(chatBox.x >= 0 && chatBox.y >= 0 && chatBox.x + chatBox.width <= viewport.width && chatBox.y + chatBox.height <= viewport.height, 'Chat pane must be visible in the viewport');
  assert.ok(previewBox.x >= 0 && previewBox.y >= 0 && previewBox.x + previewBox.width <= viewport.width && previewBox.y + previewBox.height <= viewport.height, 'Markdown preview must be visible in the viewport');
  assert.ok(chatBox.x + chatBox.width <= previewBox.x || previewBox.x + previewBox.width <= chatBox.x, 'Chat and Markdown preview must be side by side without overlap');
  assert.ok(chatBox.y < previewBox.y + previewBox.height && previewBox.y < chatBox.y + chatBox.height, 'Chat and Markdown preview must share vertical space');
  await page.screenshot({ path: join(out, '4-markdown.png') });
  await delay(8_000);
  await measure('4-markdown-maximized-idle');
  assertIdlePhase('4-markdown-maximized-idle', { maximized: true });
  const lines = preview.locator('p, li, h2');
  const first = await lines.nth(2).boundingBox(), last = await lines.nth(14).boundingBox();
  assert.ok(first && last, 'Markdown drag-select needs text endpoints');
  const startX = first.x + 20, startY = first.y + first.height / 2;
  const endX = Math.min(startX + 160, previewBox.x + previewBox.width - 24);
  const endY = Math.min(last.y, previewBox.y + previewBox.height - 24);
  assert.ok(startX > previewBox.x && startX < previewBox.x + previewBox.width && startY > previewBox.y && startY < endY, 'Markdown drag-select endpoints must stay in the visible preview');
  await measure('5-markdown-maximized-drag-select', { action: async () => {
    await page.mouse.move(startX, startY);
    await page.evaluate(() => { window.__dragRafFrames = []; window.__dragRafActive = true; const loop = time => { if (!window.__dragRafActive) return; window.__dragRafFrames.push(time); requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
    await page.mouse.down();
    for (let step = 1; step <= 40; step += 1) { await page.mouse.move(startX + (endX - startX) * step / 40, startY + (endY - startY) * step / 40, { steps: 1 }); await delay(16); }
    await page.mouse.up(); await page.evaluate(() => { window.__dragRafActive = false; });
  } });
  const frames = await page.evaluate(() => { const times = window.__dragRafFrames; const gaps = times.slice(1).map((time, index) => time - times[index]); gaps.sort((a, b) => a - b); const selection = getSelection(); const preview = [...document.querySelectorAll('.markdown-preview')].find(element => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden'; }); const selectedText = selection?.toString() ?? ''; return { count: times.length, medianMs: gaps[Math.floor(gaps.length / 2)], p95Ms: gaps[Math.floor(gaps.length * 0.95)], maxMs: gaps.at(-1), selectedTextLength: selectedText.length, selectionInPreview: Boolean(preview && selection?.anchorNode && selection?.focusNode && preview.contains(selection.anchorNode) && preview.contains(selection.focusNode)) }; });
  report.phases['5-markdown-maximized-drag-select'].rafFrames = frames; console.log('rAF frames during drag', frames);
  await page.screenshot({ path: join(out, '5-selected.png') });
  assert.ok(frames.count >= 10, `Markdown drag-select must capture at least 10 rAF samples, got ${frames.count}`);
  assert.ok(frames.selectedTextLength > 0 && frames.selectionInPreview, 'Markdown drag-select must select text inside the preview');
  assert.ok(Number.isFinite(frames.medianMs) && frames.medianMs <= 20, `Markdown drag-select median rAF interval ${frames.medianMs} ms must be at most 20 ms`);
  assert.equal(report.errors.length, 0, `renderer page errors: ${report.errors.join('\n')}`);
  report.assertions = { idleMainThreadBusyPct: report.phases['4-markdown-maximized-idle'].mainThreadBusyPct, idleRuntimeCpuPct: report.phases['4-markdown-maximized-idle'].runtimeCpuPct, runningAnimations: report.phases['4-markdown-maximized-idle'].animations.length, dragSelectMedianRafMs: frames.medianMs, dragSelectRafSamples: frames.count, selectedTextLength: frames.selectedTextLength };
  console.log(`\nPERF ASSERTIONS PASSED\n${JSON.stringify(report.assertions, null, 2)}`);
} catch (error) { report.errors.push(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); }
finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  if (report.errors.length) process.exitCode = 1;
  console.log(report.errors.length ? `PERF QA ERRORS\n${report.errors.join('\n')}` : `PERF QA DONE → ${out}`);
}
