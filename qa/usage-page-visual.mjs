// Usage page visual QA (task 10-23-usage-accounting, UA2a + UA2a2).
// Desktop 1, isolated runtime + profile, fake providers only, provider histories as TEMP fixtures (never this PC's).
//   node qa/usage-page-visual.mjs
// Checks: the Usage workspace tab opens from the account menu, the first refresh shows a reading state, tiles/heatmap/
// trend render, the trend x-axis agrees with the data, the heatmap fills its card and keeps today in
// view, a zero-usage day says only "No usage", an empty range shows no fabricated $0, en/zh x light/dark x 900/1280/1920
// are captured, and the page makes zero RPCs while idle. UA2b adds the three breakdown lists (row click → page filter,
// unpriced-only range → no $0), the paged sessions list with search/sort and the drawer, the Sources panel and its
// rebuild confirmation, Settings → Usage (price override, outside switch) and a two-year month axis that names the year.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-ub/debug/threadterm-v3-runtime.exe');
const rendererRoot = process.env.THREADTERM_QA_RENDERER_ROOT ?? join(root, 'renderer');
const out = resolve(process.env.THREADTERM_QA_OUTPUT_DIR ?? join(root, 'qa/results/usage-page'));
const scratchBase = resolve('D:/project/ThreadTerm/tt-qa-temp');
await mkdir(scratchBase, { recursive: true });
const scratch = await mkdtemp(join(scratchBase, 'tt-usage-page-'));
const appDir = join(scratch, 'app'), work = join(scratch, 'work'), bin = join(scratch, 'bin');
const claudeHome = join(scratch, 'claude'), codexHome = join(scratch, 'codex'), piHome = join(scratch, 'pi');
const report = { passed: false, checks: [], screenshots: [], idle: {}, errors: [], limitations: [] };
let app, page, releaseLock;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([a, b]) => window.threadterm.request(a, b), [method, params]);
const counts = () => page.evaluate(() => window.threadtermQaCounts.snapshot());
const resetCounts = () => page.evaluate(() => window.threadtermQaCounts.reset());
const setUsageFault = value => page.evaluate(next => window.threadtermQaUsageFault.set(next), value);
const setUsageScenario = value => page.evaluate(next => window.threadtermQaUsageScenario.set(next), value);
async function until(probe, label, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* retry to the deadline */ }
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await sleep(100);
  }
}
function childEnv() {
  const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|temp|tmp|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|claude_config_dir|pi_coding_agent_dir|kimi_code_home|grok_home|xdg_data_home|xdg_config_home|threadterm_v3_.*|tt_qa_.*)$/i.test(key)));
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  Object.assign(value, {
    TEMP: scratchBase, TMP: scratchBase,
    // Only node and System32: no real agent CLI can be discovered by accident.
    PATH: [bin, dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: join(piHome, 'agent'),
    KIMI_CODE_HOME: join(scratch, 'kimi'), GROK_HOME: join(scratch, 'grok'),
    XDG_DATA_HOME: join(scratch, 'xdg', 'data'), XDG_CONFIG_HOME: join(scratch, 'xdg', 'config'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-usage-page-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
  });
  assert.equal(Object.keys(value).filter(key => key.toLowerCase() === 'path').length, 1, 'exactly one PATH variable');
  return value;
}
function preloadWrapper() {
  return `import { contextBridge, ipcRenderer } from 'electron';
import '${join(root, 'desktop/src/preload.ts').replaceAll('\\', '/')}';
const counts = new Map<string, number>();
let usageFault = false;
let usageScenario: 'normal' | 'empty' = 'normal';
const emptyTokens = { total: 0, input: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null, cacheWriteUnknown: null, output: null, reasoning: null };
const emptyCost = { reportedUsd: null, apiEquivalentUsd: null, pricedTokens: 0, unpricedTokens: 0, reportedRequests: 0, pricedRequests: 0, coverage: 0 };
const emptyQuality = { exactRequests: 0, derivedRequests: 0, estimatedRequests: 0, exactTokens: 0, derivedTokens: 0, estimatedTokens: 0, exactShare: 0, derivedShare: 0, estimatedShare: 0 };
const emptyCoverage = Object.fromEntries(['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown', 'output', 'reasoning'].map(key => [key, { reportedRequests: 0, requests: 0 }]));
const emptyAggregate = () => ({ tokens: emptyTokens, cost: emptyCost, requests: 0, sessions: 0, activeTimeMs: 0, activeTimeEstimated: false, quality: emptyQuality, bucketCoverage: emptyCoverage, pricingPending: false });
function emptyUsageFixture(method: string, params: any): any {
  if (usageScenario !== 'empty') return undefined;
  const filters = params?.filters ?? {};
  if (method === 'usage.ledger.summary') return { ...emptyAggregate(), from: filters.from ?? null, to: filters.to ?? null, scope: filters.scope ?? 'all', sessionsWithoutUsage: 0 };
  if (method === 'usage.ledger.series') return { from: filters.from ?? null, to: filters.to ?? null, granularity: params.granularity, stack: params.stack, points: [] };
  if (method === 'usage.ledger.breakdown') return { dimension: params.dimension, items: [] };
  if (method === 'usage.ledger.sessions') return { total: 0, offset: params.offset ?? 0, limit: params.limit ?? 25, items: [] };
  return undefined;
}
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = ((channel: string, ...args: unknown[]) => {
  if (channel === 'threadterm:request') { const method = String(args[0]); counts.set(method, (counts.get(method) ?? 0) + 1); if (usageFault && method.startsWith('usage.ledger.')) return Promise.reject(new Error('QA usage query fault')); const fixture = emptyUsageFixture(method, args[1]); if (fixture !== undefined) return Promise.resolve(fixture); }
  return invoke(channel, ...args);
}) as typeof ipcRenderer.invoke;
contextBridge.exposeInMainWorld('threadtermQaCounts', {
  snapshot: () => Object.fromEntries(counts),
  reset: () => counts.clear(),
});
contextBridge.exposeInMainWorld('threadtermQaUsageFault', { set: (value: boolean) => { usageFault = value; } });
contextBridge.exposeInMainWorld('threadtermQaUsageScenario', { set: (value: 'normal' | 'empty') => { usageScenario = value; } });
`;
}
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function shotFull(name) {
  // A document screenshot cannot see content inside the workspace's own scroller.
  await page.evaluate(() => {
    const source = document.querySelector('.usage-page');
    const clone = source.cloneNode(true);
    clone.id = 'usage-qa-capture';
    Object.assign(clone.style, { position: 'absolute', left: '0', top: '0', zIndex: '9999', width: `${source.clientWidth}px`, height: 'auto', minHeight: '0' });
    Object.assign(clone.querySelector('.usage-scroll').style, { overflow: 'visible', height: 'auto', flex: 'none', width: `${source.querySelector('.usage-scroll').clientWidth}px`, boxSizing: 'border-box' });
    clone.querySelectorAll('[role="tooltip"]').forEach(node => node.remove());
    document.body.append(clone);
    source.querySelectorAll('.usage-heat-scroll, .usage-table-wrap').forEach((node, index) => {
      const target = clone.querySelectorAll('.usage-heat-scroll, .usage-table-wrap')[index];
      if (target) target.scrollLeft = node.scrollLeft;
    });
  });
  try {
    assert.equal(await page.locator('#usage-qa-capture .usage-heat-scroll').evaluate(node => {
      const latest = [...node.querySelectorAll('button.usage-heat-cell')].at(-1).getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return latest.left >= box.left - 1 && latest.right <= box.right + 1;
    }), true, 'the full-page capture preserves the latest heatmap day in view');
    await page.locator('#usage-qa-capture').screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name);
  }
  finally { await page.evaluate(() => document.querySelector('#usage-qa-capture')?.remove()); }
}
async function shotElement(selector, name) { await page.locator(selector).screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
// The app's Select is a custom combobox: open the trigger, then pick the option by its visible label.
async function selectOption(scope, label) {
  await page.locator(`${scope} .tt-select-trigger`).first().click();
  await page.locator('.tt-select-menu .tt-select-option-label', { hasText: label }).first().click();
  await until(async () => (await page.locator('.tt-select-menu').count()) === 0, `select ${label} closed`, 10_000);
}

// --- provider history fixtures: realistic aggregate scale, synthetic metadata only ---
const day = offset => { const value = new Date(Date.UTC(2026, 9, 24)); value.setUTCDate(value.getUTCDate() - offset); return value.toISOString().slice(0, 10); };
async function fixtures() {
  await mkdir(join(claudeHome, 'projects', 'demo-project'), { recursive: true });
  await mkdir(join(codexHome, 'sessions', '2026', '10'), { recursive: true });
  await mkdir(join(piHome, 'agent', 'sessions', 'demo'), { recursive: true });
  await mkdir(join(scratch, 'kimi', 'sessions', 'usage-qa', 'kimi-session-1'), { recursive: true });
  await mkdir(join(scratch, 'grok', 'sessions', 'usage-qa', 'grok-session-1'), { recursive: true });
  await mkdir(join(scratch, 'xdg', 'data', 'opencode', 'storage', 'message'), { recursive: true });
  const longModels = Array.from({ length: 20 }, (_, index) => `fixture-provider-model-with-a-deliberately-long-identifier-${String(index + 1).padStart(2, '0')}-2026-usage-qa`);
  for (let index = 0; index < 1_500; index += 1) {
    const baseDay = index % 364;
    const offset = baseDay >= 12 ? baseDay + 1 : baseDay; // keep one zero day in the visible 30-day trend and year heatmap
    // 1,500 independently addressable sessions total about 35B tokens.  Only IDs, dates,
    // provider/model names and accounting buckets are present; there is no transcript content.
    const scale = 23_000_000 + (index % 17) * 180_000;
    const fact = JSON.stringify({
      sessionId: `claude-session-${index}`, requestId: `request-${index}`, cwd: work,
      timestamp: `${day(offset)}T08:${String(index % 60).padStart(2, '0')}:00Z`,
      message: { id: `message-${index}`, model: index % 5 === 0 ? 'claude-opus-4-5' : (index % 37 === 0 ? 'claude-unpriced-qa' : longModels[index % longModels.length]),
        usage: { input_tokens: Math.round(scale * 0.06), output_tokens: Math.round(scale * 0.05), cache_read_input_tokens: Math.round(scale * 0.88), cache_creation: { ephemeral_5m_input_tokens: Math.round(scale * 0.01), ephemeral_1h_input_tokens: 0 } } },
    });
    // One accepted native history file per fact makes the real scanner emit enough
    // progress to prove aggregates refresh before its full first pass completes.
    await writeFile(join(claudeHome, 'projects', 'demo-project', `usage-qa-${String(index).padStart(4, '0')}.jsonl`), `${fact}\n`);
  }
  const codex = [JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-1', cwd: work } }), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5', cwd: work } })];
  for (let offset = 300; offset >= 0; offset -= 2) {
    if (offset % 9 === 0) continue;
    codex.push(JSON.stringify({ timestamp: `${day(offset)}T12:00:00Z`, type: 'token_usage_record', payload: { response_id: `response-${offset}`, thread_id: 'codex-session-1', model: 'gpt-5', usage: { input_tokens: 90_000 + offset * 40, cached_input_tokens: 60_000, output_tokens: 9_000, reasoning_output_tokens: 2_000 } } }));
  }
  await writeFile(join(codexHome, 'sessions', '2026', '10', 'rollout-qa.jsonl'), `${codex.join('\n')}\n`);
  const pi = [JSON.stringify({ type: 'session', id: 'pi-session-1', cwd: work, timestamp: `${day(280)}T09:00:00Z` })];
  for (let offset = 280; offset >= 0; offset -= 4) {
    if (offset % 13 === 0) continue;
    pi.push(JSON.stringify({ id: `pi-entry-${offset}`, timestamp: `${day(offset)}T09:30:00Z`, message: { role: 'assistant', model: 'pi-unpriced-qa', usage: { input: 22_000 + offset * 10, cacheRead: 12_000, output: 3_400 } } }));
  }
  await writeFile(join(piHome, 'agent', 'sessions', 'demo', 'session.jsonl'), `${pi.join('\n')}\n`);
  await writeFile(join(scratch, 'kimi', 'sessions', 'usage-qa', 'kimi-session-1', 'state.json'), JSON.stringify({ version: 2, cwd: work, agents: { main: { type: 'main' } } }));
  await writeFile(join(scratch, 'kimi', 'sessions', 'usage-qa', 'kimi-session-1', 'wire.jsonl'), `${JSON.stringify({ type: 'usage.record', time: `${day(4)}T10:00:00Z`, model: longModels[3], usage: { inputOther: 480_000, inputCacheRead: 2_000_000, inputCacheCreation: 80_000, output: 310_000 } })}\n`);
  await writeFile(join(scratch, 'grok', 'sessions', 'usage-qa', 'grok-session-1', 'summary.json'), JSON.stringify({ current_model_id: longModels[4] }));
  await writeFile(join(scratch, 'grok', 'sessions', 'usage-qa', 'grok-session-1', 'updates.jsonl'), `${JSON.stringify({ timestamp: `${day(4)}T10:00:00Z`, params: { sessionId: 'grok-session-1', update: { sessionUpdate: 'turn_completed', prompt_id: 'grok-request-1', usage: { inputTokens: 3_000_000, cachedReadTokens: 2_600_000, outputTokens: 190_000, reasoningTokens: 70_000, costUsdTicks: 125_000_000_000_000 } } } })}\n`);
  // The reader's documented legacy JSON fallback is still supported for old OpenCode history.
  // It intentionally exercises provider-recorded cost without creating a provider SQLite file.
  await writeFile(join(scratch, 'xdg', 'data', 'opencode', 'storage', 'message', 'usage-qa.json'), JSON.stringify({ id: 'opencode-message-1', sessionID: 'opencode-session-1', role: 'assistant', model: { id: longModels[5] }, path: { cwd: work }, time: { completed: `${day(4)}T11:00:00Z` }, tokens: { input: 600_000, output: 240_000, reasoning: 40_000, cache: { read: 1_400_000, write: 50_000 } }, cost: 842.75 }));
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  await esbuild({ entryPoints: [join(root, 'desktop/src/main.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'main.cjs'), logLevel: 'error' });
  // Harness-only preload wrapper: it imports the product preload unmodified and counts request channels.
  await writeFile(join(scratch, 'preload-entry.ts'), preloadWrapper());
  await esbuild({ entryPoints: [join(scratch, 'preload-entry.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'preload.cjs'), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), root: rendererRoot, logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'usage-page-visual-qa', version: '1', main: 'main.cjs' }));
}
async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(w, h); win.show(); }, [width, height]);
  await page.setViewportSize({ width, height }).catch(() => undefined);
  await sleep(400);
}
async function setAppearance(language, theme) {
  const snapshot = await request('runtime.snapshot');
  const custom = { background: '#101820', surface: '#1b2a34', text: '#e5f2f7', muted: '#a3bcc7', accent: '#e68a3f', border: '#45616f' };
  await request('settings.update', { patch: { language, ...(theme === 'custom' ? { theme: 'dark', themeSelection: 'custom:usage-qa', customThemes: { 'usage-qa': custom } } : { theme, themeSelection: theme }), notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme === 'custom' ? 'dark' : theme);
  if (theme === 'custom') await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
  await page.waitForFunction(expected => document.documentElement.lang === expected, language);
  await sleep(250);
}
async function openUsage() {
  await page.locator('.user-row').click();
  await page.getByRole('button', { name: /^(Usage|用量)$/ }).click();
  await until(async () => (await page.locator('.usage-page').count()) > 0, 'usage page mounted');
}

try {
  releaseLock = await acquireElectronQaLock({ directory: scratchBase });
  await mkdir(out, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(work, { recursive: true });
  await fixtures();
  await buildApp();
  // The desktop main process spawns the runtime itself; fixture history roots travel in its environment.
  app = await electron.launch({ args: [appDir], cwd: root, env: childEnv(), timeout: 90_000 });
  page = await app.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.browserCommand));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  await until(() => page.evaluate(() => Boolean(window.threadtermQaCounts)), 'QA request counter');
  await setAppearance('en', 'light');
  await resize(1280, 800);
  const project = (await request('runtime.snapshot')).projects?.[0] ?? await request('project.add', { path: work, name: 'Usage QA', operationId: randomUUID() });
  const shell = await request('session.create', { projectId: project.id, cwd: work, provider: 'shell', mode: 'terminal', title: 'Usage QA', operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), shell.id);
  await page.locator('.workspace-pane').first().waitFor();
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  app.process().stderr?.on('data', chunk => { (report.mainLog ??= []).push(String(chunk).slice(0, 400)); });
  await openUsage();
  await page.locator('.usage-tiles').waitFor();
  const firstScanStarted = Date.now();
  await until(async () => (await request('usage.ledger.sources', {})).scan?.state === 'running', 'first native scan running', 30_000);
  await page.locator('.usage-scan-notice[role="status"]').waitFor();
  await page.locator('.usage-scan-title').waitFor();
  assert.match((await page.locator('.usage-scan-title').innerText()).trim(), /^Counting…/, 'running scan names the counting state');
  await until(async () => /Reading your agents' history for the first time/.test(await page.locator('.usage-scan-notice p').first().innerText()), 'first-history explanation', 30_000);
  assert.equal((await page.locator('.usage-progress').innerText().catch(() => '')).trim(), '', 'the header leaves scan progress to the tiles notice');
  const firstScan = {
    placeholders: await page.locator('.usage-skel').count(),
    reading: await page.locator('.usage-tiles[aria-busy="true"]').count(),
    tiles: await page.locator('.usage-tiles').innerText().catch(() => ''),
  };
  await shot('en-light-1280-first-scan.png');
  const firstTilesGeometry = await page.locator('.usage-tiles').boundingBox();
  report.firstScan = { placeholders: firstScan.placeholders, reading: firstScan.reading, tiles: firstScan.tiles.split('\n').slice(0, 8) };
  assert.ok(!/No usage/.test(firstScan.tiles), 'a first scan never claims the range is empty before it has read history');
  check('the first scan shows a Counting notice and a plain first-history explanation above the tiles');
  const firstRunningTotal = await until(async () => {
    const source = await request('usage.ledger.sources', {});
    const value = (await page.locator('.usage-tile-value').first().innerText()).trim();
    return source.scan?.state === 'running' && value !== '' && value !== '—' ? value : false;
  }, 'first live Tokens total while scan runs', 90_000);
  const secondRunningTotal = await until(async () => {
    if (Date.now() - firstScanStarted < 5_000) return false;
    const source = await request('usage.ledger.sources', {});
    const value = (await page.locator('.usage-tile-value').first().innerText()).trim();
    return source.scan?.state === 'running' && value !== firstRunningTotal && value !== '' && value !== '—' ? value : false;
  }, 'a second live Tokens total at least five seconds into the scan', 120_000);
  assert.notEqual(secondRunningTotal, firstRunningTotal, `Tokens totals grow while the scanner remains running (${firstRunningTotal} → ${secondRunningTotal})`);
  const growingTilesGeometry = await page.locator('.usage-tiles').boundingBox();
  assert.ok(Math.abs(firstTilesGeometry.y - growingTilesGeometry.y) <= 1 && Math.abs(firstTilesGeometry.height - growingTilesGeometry.height) <= 1, 'live totals keep the summary grid position and height stable');
  await shot('en-light-1280-running-growth.png');
  report.runningTotals = { first: firstRunningTotal, second: secondRunningTotal, elapsedMs: Date.now() - firstScanStarted };
  check(`Tokens refresh twice while the real first scan runs (${firstRunningTotal} → ${secondRunningTotal} after at least five seconds)`);
  const liveSearch = page.locator('.usage-search-input');
  await liveSearch.fill('fixture-provider-model');
  await sleep(800);
  const sessionsBeforeLive = (await counts())['usage.ledger.sessions'] ?? 0;
  const scrollBeforeLive = await page.locator('.usage-scroll').evaluate(node => node.scrollTop);
  await until(async () => (await request('usage.ledger.sources', {})).scan?.state === 'running'
    && (await page.locator('.usage-tile-value').first().innerText()).trim() !== secondRunningTotal, 'live totals continue during session search', 90_000);
  assert.equal(await liveSearch.inputValue(), 'fixture-provider-model', 'live totals preserve session search');
  assert.equal(await liveSearch.evaluate(node => node === document.activeElement), true, 'live totals preserve the focused search field');
  assert.equal((await counts())['usage.ledger.sessions'] ?? 0, sessionsBeforeLive, 'live updates do not reload sessions while the user searches');
  assert.ok(Math.abs((await page.locator('.usage-scroll').evaluate(node => node.scrollTop)) - scrollBeforeLive) <= 1, 'live updates preserve the page scroll position');
  await liveSearch.evaluate(node => node.blur());
  await page.mouse.move(600, 4);
  await until(async () => ((await counts())['usage.ledger.sessions'] ?? 0) > sessionsBeforeLive, 'visible idle sessions catch up after search focus leaves', 10_000);
  await liveSearch.fill('');
  await sleep(400);
  await liveSearch.evaluate(node => node.blur());
  await page.locator('.usage-scroll').evaluate(node => { node.scrollTop = 0; });
  check('live totals preserve search focus and scroll, defer busy session reads, and catch up when idle');
  const usageTab = page.locator('.workspace-tab', { hasText: /Usage/ }).first();
  await usageTab.waitFor();
  check('the account menu opens a Usage workspace tab');
  assert.equal(await page.locator('.usage-head .seg .seg-btn[aria-pressed="true"]').count() >= 1, true, 'scope uses shared .seg/.seg-btn controls with a pressed state');
  assert.equal(await page.locator('.usage-head .seg .seg-btn.active[aria-pressed="true"]').count() >= 1, true, 'the active scope segment is visually and semantically pressed');
  assert.equal(await page.locator('.usage-head svg').count() >= 1, true, 'Usage pane header includes the shared title icon');
  check('the Usage pane header has its icon and shared segmented controls');
  await until(async () => (await page.locator('.usage-tile').count()) >= 4, 'summary tiles');
  await until(async () => {
    const source = await request('usage.ledger.sources', {});
    const value = (await page.locator('.usage-tile-value').first().innerText()).trim();
    return source.scan?.state === 'idle' && (await page.locator('.usage-scan-notice').count()) === 0 && value !== secondRunningTotal
      && (await page.locator('.usage-skel').count()) === 0 && (await page.locator('.usage-chart-xaxis').count()) > 0 && (await page.locator('.usage-chart-seg').count()) > 3;
  }, 'first scan final totals, aggregates and chart are ready', 180_000);
  await until(async () => {
    const value = (await page.locator('.usage-tile-value').first().innerText()).trim();
    return value !== '' && value !== '—';
  }, 'real summary metric after scan', 60_000);
  const tileText = await page.locator('.usage-tiles').innerText();
  report.runningTotals.final = (await page.locator('.usage-tile-value').first().innerText()).trim();
  await shot('en-light-1280-scan-final.png');
  const typeScale = await page.evaluate(() => ['.usage-tile-value', '.usage-tile-label', '.usage-chart-xaxis'].map(selector => ({ selector, size: Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize) })));
  assert.equal(typeScale[0].size, 20, `hero metric value uses 20 px (${typeScale[0].size})`);
  assert.ok([11, 12, 13].includes(typeScale[1].size), `tile label uses the 11/12/13 px scale (${typeScale[1].size})`);
  assert.equal(typeScale[2].size, 11, `chart labels use 11 px (${typeScale[2].size})`);
  const cells = await page.locator('.usage-heat-grid button.usage-heat-cell').count();
  assert.ok(cells > 360, `one cell per day (${cells})`);
  const levelClasses = () => page.locator('.usage-heat-grid button.usage-heat-cell').evaluateAll(nodes => [...new Set(nodes.map(node => node.className.split(' ')[1]))]);
  await until(async () => (await levelClasses()).includes('is-4'), 'heatmap quantile levels', 60_000);
  const levels = await levelClasses();
  assert.ok(levels.includes('is-4') && levels.includes('is-empty'), `heatmap levels ${levels.join(',')}`);
  const heatPalette = await page.evaluate(() => ['is-1', 'is-2', 'is-3', 'is-4'].map(level => getComputedStyle(document.querySelector(`.usage-heat-cell.${level}`)).backgroundColor));
  for (const colour of heatPalette) {
    const channels = colour.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    assert.equal(channels.length, 3, `heatmap level has an RGB colour (${colour})`);
    assert.ok(channels[2] > channels[0] && channels[2] > channels[1], `heatmap level belongs to the blue sequential ramp (${colour})`);
  }
  const segments = await page.locator('.usage-chart-seg').count();
  assert.ok(segments > 3, `trend segments (${segments})`);
  assert.match(tileText, /Tokens/);
  assert.ok(/\$/.test(tileText), 'API-equivalent cost is shown');
  assert.ok((await page.locator('.usage-legend-trend > span').count()) >= 2, 'trend legend lists the providers');
  report.tiles = tileText.split('\n').slice(0, 14);
  report.typeScale = typeScale;
  report.heatPalette = heatPalette;
  check('Usage metric, label and chart typography use the shared 20 / 11–13 px scale');
  check('the heatmap uses the validated blue sequential palette rather than the primary accent');
  check(`summary tiles, a year of heatmap cells (${cells}) and a stacked trend render from fixture history`);

  // Project overview is another ledger consumer. Its Details target must agree with its own seven-day total.
  await page.locator('.proj-row', { hasText: 'Usage QA' }).first().click();
  await page.getByTestId('project-home').waitFor();
  await until(async () => (await page.locator('.ov-usage .tnum').count()) >= 2, 'project overview ledger metrics', 60_000);
  const overviewWeekTokens = (await page.locator('.ov-usage .tnum').nth(1).innerText()).trim();
  await shot('en-light-1280-project-overview-usage.png');
  await page.locator('.ov-usage .ov-metric-more').click();
  await page.locator('.usage-page').waitFor();
  await selectOption('.usage-range', 'Custom');
  const overviewEnd = new Date(); const overviewStart = new Date(overviewEnd); overviewStart.setDate(overviewEnd.getDate() - 6); overviewEnd.setDate(overviewEnd.getDate() + 1);
  const localDate = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  await page.locator('.usage-date').last().fill(localDate(overviewEnd));
  await page.locator('.usage-date').first().fill(localDate(overviewStart));
  await until(async () => (await page.locator('.usage-tile-value').first().innerText()).trim() === overviewWeekTokens, 'project overview and Usage ledger total agree', 60_000);
  report.projectOverview = { weekTokens: overviewWeekTokens };
  check('Project overview seven-day Tokens and its project-filtered Usage detail total agree');
  await page.locator('.usage-head .usage-filter').first().click();
  await until(async () => (await page.locator('.usage-head .usage-filter').count()) === 0, 'project Usage filter cleared', 30_000);
  await selectOption('.usage-range', 'Last 30 days');
  await until(async () => (await page.locator('.usage-chart-col').count()) === 30, 'project Usage dashboard reset', 60_000);

  // The scale fixture is deliberately large enough to expose compact-number, cost, legend and long-model overflow.
  await selectOption('.usage-range', 'Custom');
  await page.locator('.usage-date').last().fill('2026-10-24');
  await page.locator('.usage-date').first().fill('2025-10-25');
  await until(async () => /\b3\d(?:\.\d+)?B\b/.test(await page.locator('.usage-tile-value').first().innerText()), '35B scale summary', 60_000);
  const scaleTiles = await page.locator('.usage-tiles').innerText();
  assert.match(scaleTiles, /\$[\d,.KM]+/, `large fixture has API-equivalent cost: ${scaleTiles}`);
  assert.match(scaleTiles, /\$[1-9]\d,\d{3}/, `large fixture is at least $10k API-equivalent: ${scaleTiles}`);
  const evidenceText = await page.locator('.usage-tile').first().innerText();
  const costTileText = await page.locator('.usage-tile').nth(1).innerText();
  const activeTileText = await page.locator('.usage-tile').nth(3).innerText();
  const evidenceSecondary = [...evidenceText.matchAll(/(?:Derived|≈)\s+([\d.]+)%/g)].some(match => Number(match[1]) > 0);
  if (evidenceSecondary) assert.doesNotMatch(evidenceText, /Exact\s+100(?:\.0+)?%/, `evidence shares do not round past 100%: ${evidenceText}`);
  if (/tokens unpriced/.test(costTileText)) assert.doesNotMatch(costTileText, /100(?:\.0+)?% of tokens priced/, `priced share does not round past 100%: ${costTileText}`);
  assert.ok(/(?:[1-9]\d* days|Not measured|not measured)/.test(activeTileText), `active usage does not claim 0 days when the fixture has history: ${activeTileText}`);
  await shot('en-light-1280-scale-35b.png');
  report.scaleScenario = { tokens: (await page.locator('.usage-tile-value').first().innerText()).trim(), tiles: scaleTiles.split('\n').slice(0, 12), sessions: 1_500, providers: ['Claude', 'Codex', 'OpenCode', 'Pi', 'Kimi', 'Grok'], models: 20 };
  check('the 35B-token, 1,500-session, six-provider, 20-long-model scale fixture keeps compact totals and API-equivalent cost visible');
  await selectOption('.usage-range', 'Last 30 days');
  await until(async () => (await page.locator('.usage-chart-col').count()) === 30, '30-day dashboard restored', 60_000);
  await until(async () => /reported by providers/.test(await page.locator('.usage-tile').nth(1).innerText()), 'reported-cost fixture', 30_000);
  check('OpenCode legacy JSON contributes a lower-case provider-reported cost without a provider SQLite write');

  // Refresh icon: the workbench glyph, not the prototype set's `file` fallback.
  const refreshIcon = await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"] svg').innerHTML();
  assert.match(refreshIcon, /M19\.5 12a7\.5/, `refresh icon path: ${refreshIcon.slice(0, 80)}`);
  check('the header refresh button draws the workbench refresh glyph');

  // Trend x-axis: date labels under the plot, thinned so neighbours never collide.
  const xAxisEntries = () => page.locator('.usage-chart-xaxis > span').evaluateAll(nodes => nodes.map(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return { text: node.textContent ?? '', box: range.getBoundingClientRect().toJSON(), span: node.getBoundingClientRect().toJSON() };
  }));
  const assertAxis = async (context) => {
    const entries = await xAxisEntries();
    const labelled = entries.filter(entry => entry.text.trim());
    const columns = await page.locator('.usage-chart-col').count();
    report[`axis-${context}`] = { spans: entries.length, columns, labelled: labelled.map(entry => `${entry.text}@${Math.round(entry.box.left)}-${Math.round(entry.box.right)}/span ${Math.round(entry.span.left)}-${Math.round(entry.span.right)}`) };
    assert.ok(labelled.length >= 2, `${context}: x-axis labels (${labelled.length}) of ${entries.length} spans, ${columns} columns`);
    const plot = await page.locator('.usage-chart-main').boundingBox();
    assert.ok(plot, `${context}: chart plot bounds`);
    for (const entry of labelled) {
      assert.match(entry.text, /[A-Za-z\u4e00-\u9fff]/, `${context}: label text ${entry.text}`);
      assert.ok(entry.box.left >= plot.x - 1 && entry.box.right <= plot.x + plot.width + 1, `${context}: ${entry.text} stays inside the plot (${Math.round(entry.box.left)}-${Math.round(entry.box.right)} outside ${Math.round(plot.x)}-${Math.round(plot.x + plot.width)})`);
    }
    const sorted = [...labelled].sort((left, right) => left.box.left - right.box.left);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(sorted[index].box.left >= sorted[index - 1].box.right + 1, `${context}: labels ${sorted[index - 1].text}/${sorted[index].text} overlap (${Math.round(sorted[index].box.left)} < ${Math.round(sorted[index - 1].box.right)}), ${columns} columns, ${entries.length} spans`);
    }
    return labelled;
  };
  const dayLabels = await assertAxis('day');
  assert.ok(dayLabels.length < 30, 'day labels are thinned, not one per band');
  check(`the trend has ${dayLabels.length} non-overlapping x-axis date labels (${dayLabels.map(entry => entry.text).join(', ')})`);

  // Every granularity labels its own scale, still without collisions.
  const granularitySeg = page.locator('.usage-trend .seg').first();
  for (const [name, columns] of [['Week', 6], ['Month', 2]]) {
    await granularitySeg.getByRole('button', { name, exact: true }).click();
    await until(async () => (await page.locator('.usage-chart-col').count()) <= columns, `${name.toLowerCase()} trend`, 30_000);
    const labels = await assertAxis(name.toLowerCase());
    report[`${name.toLowerCase()}Labels`] = labels.map(entry => entry.text);
  }
  await granularitySeg.getByRole('button', { name: 'Day', exact: true }).click();
  await until(async () => (await page.locator('.usage-chart-col').count()) === 30, 'day trend restored', 30_000);
  check('week and month trends keep their own non-overlapping date ticks');

  assert.equal(await page.locator('.usage-chart-direct').count(), 0, 'the trend has no redundant direct bar-value label');
  check('the trend keeps axis labels and tooltips without a redundant direct bar-value label');

  // The shared chart tooltip follows the tallest stacked bar and is clamped to the plot,
  // never onto the trend header or legend.
  const tallestTrendIndex = await page.locator('.usage-chart-col').evaluateAll(columns => columns.reduce((tallest, column, index) => {
    const height = [...column.querySelectorAll('.usage-chart-seg')].reduce((total, segment) => total + segment.getBoundingClientRect().height, 0);
    return height > tallest.height ? { index, height } : tallest;
  }, { index: 0, height: -1 }).index);
  await page.locator('.usage-chart-col').nth(tallestTrendIndex).hover();
  await page.locator('.usage-tip-chart').waitFor();
  const trendTipGeometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    const tooltip = document.querySelector('.usage-tip-chart');
    return {
      tip: tooltip.getBoundingClientRect().toJSON(),
      plot: box('.usage-chart-plot'),
      header: box('.usage-trend .usage-section-head'),
      legend: box('.usage-legend-trend'),
      columns: getComputedStyle(tooltip).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length,
    };
  });
  const intersects = (a, b) => b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  // Half a pixel of slack: a tooltip clamped to the plot edge can land 1/64 px (layout rounding) past a fractional edge.
  const slack = 0.5;
  assert.ok(trendTipGeometry.tip.left >= trendTipGeometry.plot.left - slack && trendTipGeometry.tip.right <= trendTipGeometry.plot.right + slack && trendTipGeometry.tip.top >= trendTipGeometry.plot.top - slack && trendTipGeometry.tip.bottom <= trendTipGeometry.plot.bottom + slack, `trend tooltip stays wholly inside the plot: ${JSON.stringify(trendTipGeometry)}`);
  assert.equal(trendTipGeometry.columns, 2, `trend tooltip uses compact two-column layout (${trendTipGeometry.columns} columns)`);
  assert.ok(!intersects(trendTipGeometry.tip, trendTipGeometry.header), `trend tooltip clears the header: ${JSON.stringify(trendTipGeometry)}`);
  assert.ok(!intersects(trendTipGeometry.tip, trendTipGeometry.legend), `trend tooltip clears the legend: ${JSON.stringify(trendTipGeometry)}`);
  await shot('en-light-1280-trend-tooltip.png');
  await page.mouse.move(600, 4);
  await until(async () => (await page.locator('.usage-tip-chart').count()) === 0, 'trend tooltip dismissed', 10_000);
  check('the tallest trend bar tooltip stays inside its plot and clear of the header and legend');

  // The calendar fills its card; the legend sits under the grid, right-aligned to the grid.
  const heat = () => page.evaluate(() => {
    const scroll = document.querySelector('.usage-heat-scroll');
    const grid = document.querySelector('.usage-heat-grid').getBoundingClientRect();
    const foot = document.querySelector('.usage-heat-foot').getBoundingClientRect();
    const legend = document.querySelector('.usage-heat-foot .usage-legend').getBoundingClientRect();
    const cell = document.querySelector('.usage-heat-cell').getBoundingClientRect();
    return {
      box: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft,
      grid: grid.width, gridLeft: grid.left - scroll.getBoundingClientRect().left, cell: { width: cell.width, height: cell.height },
      gridRight: grid.right, footRight: foot.right, legendRight: legend.right,
      headerLegend: document.querySelectorAll('.usage-heat .usage-section-head .usage-legend').length,
    };
  });

  // Heatmap tooltip: date, buckets, cost and contributing sources.
  const sharedDay = page.locator(`.usage-heat-grid button.usage-heat-cell[data-heat-day="${day(4)}"]`);
  assert.equal(await sharedDay.count(), 1, 'the six-provider tooltip fixture has one shared heatmap day');
  const filled = sharedDay;
  await filled.scrollIntoViewIfNeeded();
  await filled.focus();
  await filled.hover();
  await page.locator('.usage-tip-heat').waitFor();
  const tipText = await page.locator('.usage-tip-heat').innerText();
  assert.match(tipText, /\d/, 'tooltip shows numbers');
  for (const provider of ['Claude', 'Codex', 'OpenCode', 'Pi', 'Kimi', 'Grok']) assert.match(tipText, new RegExp(provider), `shared-day tooltip names ${provider}`);
  const tipGeometry = await page.evaluate(() => {
    const grid = document.querySelector('.usage-heat-grid').getBoundingClientRect();
    const tooltip = document.querySelector('.usage-tip-heat');
    const tip = tooltip.getBoundingClientRect();
    return { grid, tip, columns: getComputedStyle(tooltip).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length };
  });
  assert.ok(tipGeometry.tip.left >= tipGeometry.grid.left - 1 && tipGeometry.tip.right <= tipGeometry.grid.right + 1 && tipGeometry.tip.top >= tipGeometry.grid.top && tipGeometry.tip.bottom <= tipGeometry.grid.bottom, `tooltip stays wholly inside heat grid: ${JSON.stringify(tipGeometry)}`);
  assert.ok(tipGeometry.tip.width <= 480, `compact tooltip is at most 480 px (${tipGeometry.tip.width})`);
  assert.equal(tipGeometry.columns, 2, `tooltip uses its compact two-column layout (${tipGeometry.columns} columns)`);
  const tooltipIntersections = await page.evaluate(() => {
    const tip = document.querySelector('.usage-tip-heat').getBoundingClientRect();
    return [...document.querySelectorAll('.usage-heat button:not(.usage-heat-cell), .usage-trend button, .usage-sessions button')].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && tip.left < box.right && tip.right > box.left && tip.top < box.bottom && tip.bottom > box.top;
    }).map(node => node.getAttribute('aria-label') || node.textContent?.trim());
  });
  assert.deepEqual(tooltipIntersections, [], `heatmap tooltip covers no controls: ${tooltipIntersections.join(', ')}`);
  await shot('en-light-1280-heatmap-tooltip.png');
  check('every heatmap cell has a tooltip with tokens, cost and sources');
  // Park the pointer outside the grid so the gallery screenshots are not covered by a tooltip.
  await page.mouse.move(600, 4);
  await until(async () => (await page.locator('.usage-tip-heat').count()) === 0, 'tooltip dismissed', 10_000);

  // A zero-usage day says only what it knows: the date and "No usage".
  await page.locator('.usage-heat-grid button.usage-heat-cell.is-empty').first().hover();
  await page.locator('.usage-tip-heat').waitFor();
  const emptyTip = await page.locator('.usage-tip-heat').innerText();
  assert.match(emptyTip, /No usage/);
  assert.match(emptyTip, /\d{4}/, 'the empty tooltip still names the date');
  assert.ok(!/\$|tokens|requests|Cost/.test(emptyTip.replace('No usage', '')), `empty tooltip says nothing else: ${emptyTip}`);
  // Tooltips remain inside the grid, avoiding the header and controls below it.
  const tipBox = await page.locator('.usage-tip-heat').evaluate(node => ({ ...node.getBoundingClientRect().toJSON() }));
  const gridBox = await page.locator('.usage-heat-grid').evaluate(node => ({ ...node.getBoundingClientRect().toJSON() }));
  assert.ok(tipBox.left >= gridBox.left - 1 && tipBox.right <= gridBox.right + 1 && tipBox.top >= gridBox.top && tipBox.bottom <= gridBox.bottom, `empty tooltip stays within the heat grid (${JSON.stringify({ tipBox, gridBox })})`);
  await shot('en-light-1280-heatmap-empty-tooltip.png');
  await page.mouse.move(600, 4);
  await until(async () => (await page.locator('.usage-tip-heat').count()) === 0, 'empty tooltip dismissed', 10_000);
  check('a zero-usage day tooltip shows its date and "No usage" only');

  await resize(1280, 800);
  const wide = await heat();
  assert.ok(Math.abs(wide.grid - wide.box) <= 2, `the calendar spans its card at 1280 (${wide.grid} vs ${wide.box})`);
  assert.equal(wide.headerLegend, 0, 'the Less/More legend left the card header');
  assert.ok(Math.abs(wide.footRight - wide.gridRight) <= 2, `the legend row is as wide as the grid (${wide.footRight} vs ${wide.gridRight})`);
  assert.ok(Math.abs(wide.legendRight - wide.gridRight) <= 2, `the legend sits at the grid's right edge (${wide.legendRight} vs ${wide.gridRight})`);
  report.heatmap1280 = wide;
  check(`the calendar fills the card at 1280 (${Math.round(wide.cell.width)} px-wide cells) with the Less/More legend under its right edge`);
  await shot('en-light-1280.png');
  await resize(1920, 1080);
  // Bands cover the whole plot width with empty days kept as empty bands, and a bar never exceeds 24 px.
  const spread = await page.evaluate(() => {
    const plot = document.querySelector('.usage-chart-plot').getBoundingClientRect();
    const columns = [...document.querySelectorAll('.usage-chart-col')];
    return {
      plotLeft: plot.left, plotRight: plot.right, columns: columns.length,
      firstLeft: columns[0].getBoundingClientRect().left, lastRight: columns.at(-1).getBoundingClientRect().right,
      maxBar: Math.max(...[...document.querySelectorAll('.usage-chart-stack')].map(node => node.getBoundingClientRect().width)),
      emptyBands: columns.filter(node => node.querySelectorAll('.usage-chart-seg').length === 0).length,
    };
  });
  assert.ok(Math.abs(spread.firstLeft - spread.plotLeft) <= 2 && Math.abs(spread.lastRight - spread.plotRight) <= 2, `bands spread over the plot (${spread.firstLeft}-${spread.lastRight} vs ${spread.plotLeft}-${spread.plotRight})`);
  assert.ok(spread.maxBar <= 24.5, `bar width capped at 24 px (${spread.maxBar})`);
  assert.ok(spread.emptyBands >= 1, 'empty days stay as empty bands');
  report.trendSpread = spread;
  check(`trend bands span the plot at 1920 (${spread.columns} bands, ${spread.emptyBands} empty) with bars capped at ${Math.round(spread.maxBar)} px`);
  const veryWide = await heat();
  assert.ok(veryWide.cell.width > 16, `wide heatmap cells grow with the grid (${veryWide.cell.width})`);
  assert.ok(veryWide.cell.height >= 20, `heatmap rows keep room for an in-grid tooltip (${veryWide.cell.height})`);
  assert.ok(Math.abs(veryWide.grid - veryWide.box) <= 2, `wide heatmap grid fills the card (${veryWide.grid} vs ${veryWide.box})`);
  report.heatmap1920 = veryWide;
  await shot('en-light-1920.png');
  await resize(900, 800);
  const narrow = await page.locator('.usage-scroll').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, heat: element.querySelector('.usage-heat-grid')?.getBoundingClientRect().width ?? 0 }));
  assert.ok(narrow.scroll <= narrow.client + 1, `no page overflow at 900 px (${narrow.scroll} > ${narrow.client})`);
  const narrowHeat = await heat();
  report.heatmap900 = narrowHeat;
  if (narrowHeat.scrollWidth > narrowHeat.box) {
    assert.ok(narrowHeat.scrollLeft + narrowHeat.box >= narrowHeat.scrollWidth - 2, `today is in view at 900 px (${narrowHeat.scrollLeft} + ${narrowHeat.box} of ${narrowHeat.scrollWidth})`);
    check('at 900 px the calendar scrolls inside its own box with today in view');
  } else {
    assert.ok(narrowHeat.grid <= narrowHeat.box + 1, `the whole year fits at 900 px (${narrowHeat.grid} of ${narrowHeat.box})`);
    check('at 900 px the calendar fits its card without a page-level scroll');
  }
  await shot('en-light-900.png');

  await resize(1280, 800);
  await setAppearance('zh-CN', 'dark');
  await sharedDay.hover();
  await page.locator('.usage-tip-heat').waitFor();
  const zhTipGeometry = await page.evaluate(() => {
    const tip = document.querySelector('.usage-tip-heat').getBoundingClientRect();
    const grid = document.querySelector('.usage-heat-grid').getBoundingClientRect();
    const legend = document.querySelector('.usage-heat-foot .usage-legend').getBoundingClientRect();
    return { tip, grid, legend };
  });
  assert.ok(zhTipGeometry.tip.left >= zhTipGeometry.grid.left - 1 && zhTipGeometry.tip.right <= zhTipGeometry.grid.right + 1 && zhTipGeometry.tip.top >= zhTipGeometry.grid.top && zhTipGeometry.tip.bottom <= zhTipGeometry.grid.bottom, `zh tooltip remains in the heat grid: ${JSON.stringify(zhTipGeometry)}`);
  assert.ok(zhTipGeometry.tip.bottom <= zhTipGeometry.legend.top || zhTipGeometry.tip.top >= zhTipGeometry.legend.bottom || zhTipGeometry.tip.right <= zhTipGeometry.legend.left || zhTipGeometry.tip.left >= zhTipGeometry.legend.right, `zh tooltip does not overlap the legend: ${JSON.stringify(zhTipGeometry)}`);
  await shot('zh-dark-1280-heatmap-tooltip.png');
  await page.mouse.move(600, 4);
  await until(async () => (await page.locator('.usage-tip-heat').count()) === 0, 'zh tooltip dismissed', 10_000);
  await shot('zh-dark-1280.png');
  const zhText = await page.locator('.usage-page').innerText();
  assert.match(zhText, /用量/, 'Chinese copy');
  await resize(1920, 1080);
  await shot('zh-dark-1920.png');
  await setAppearance('en', 'dark');
  await shot('en-dark-1280.png');
  await setAppearance('en', 'light');
  check('en/zh x light/dark screenshots captured');

  // Clicking a day narrows the range to that day (last, so the gallery shows the default range).
  await page.locator('.usage-heat-grid button.usage-heat-cell:not(.is-empty)').last().click();
  await until(async () => (await page.locator('.usage-range').innerText()).includes('Custom') || (await page.locator('.usage-date').count()) > 0, 'day click switches to a custom range');
  check('clicking a heatmap day sets the range to that day');

  // An empty range is not a zero bill: cost reads "—" and no coverage line claims "Exact 0%".
  await page.locator('.usage-date').first().fill('2020-01-01');
  await page.locator('.usage-date').last().fill('2020-01-31');
  await until(async () => (await page.locator('.usage-tiles').innerText()).includes('No usage'), 'empty range resolved', 60_000);
  const emptyTiles = await page.locator('.usage-tile').allInnerTexts();
  assert.equal((await page.locator('.usage-tile-value').nth(1).innerText()).trim(), '—', 'the empty range has no cost');
  assert.equal(await page.locator('.usage-coverage').count(), 0, 'no coverage line without usage');
  assert.ok(!/\$/.test(emptyTiles[1] ?? ''), `no fabricated cost: ${emptyTiles[1]}`);
  await shot('en-light-1280-empty.png');
  report.emptyTiles = emptyTiles;
  check('an empty range shows — for cost, "No usage" and no coverage line');

  // ---- UA2b: breakdowns, sessions, drawer, sources, settings ----
  // Back to a range with usage in it.
  await selectOption('.usage-range', 'Last 30 days');
  await until(async () => (await page.locator('.usage-skel').count()) === 0 && (await page.locator('.usage-sessions').count()) > 0, 'sections rendered', 60_000);
  await until(async () => (await page.locator('.usage-bd-rows .usage-bd-row').count()) >= 3, 'breakdown rows', 60_000);

  const lists = await page.locator('.usage-bd-list').evaluateAll(nodes => nodes.map(node => ({
    title: node.querySelector('h2')?.textContent ?? '',
    rows: node.querySelectorAll('.usage-bd-row').length,
    swatches: node.querySelectorAll('.usage-swatch').length,
    bars: [...node.querySelectorAll('.usage-bd-track > i')].map(bar => bar.getBoundingClientRect().width),
  })));
  assert.equal(lists.length, 3, 'three breakdown lists');
  assert.deepEqual(lists.map(list => list.title), ['By provider', 'By model', 'By project']);
  assert.ok(lists.every(list => list.rows > 0), `every list has rows: ${JSON.stringify(lists)}`);
  const breakdownProviders = await page.locator('.usage-bd-provider .usage-bd-row').allInnerTexts();
  for (const provider of ['Claude', 'Codex', 'OpenCode', 'Pi', 'Kimi', 'Grok']) assert.ok(breakdownProviders.some(text => text.includes(provider)), `fixture contributes ${provider} usage data`);
  assert.ok(lists[0].swatches > 0, 'providers carry their slot swatch');
  assert.equal(lists[1].swatches, 0, 'models are not coloured');
  const providerSeriesColours = await page.evaluate(() => {
    const row = document.querySelector('.usage-bd-provider .usage-bd-row');
    const swatch = row?.querySelector('.usage-swatch');
    const bar = row?.querySelector('.usage-bd-track > i');
    const legend = document.querySelector('.usage-legend-trend .usage-swatch, .usage-legend-trend i');
    return { swatch: swatch && getComputedStyle(swatch).backgroundColor, bar: bar && getComputedStyle(bar).backgroundColor, legend: legend && getComputedStyle(legend).backgroundColor };
  });
  assert.equal(providerSeriesColours.bar, providerSeriesColours.swatch, `provider breakdown bar matches its swatch: ${JSON.stringify(providerSeriesColours)}`);
  if (providerSeriesColours.legend) assert.equal(providerSeriesColours.legend, providerSeriesColours.swatch, `provider trend legend shares the provider swatch colour: ${JSON.stringify(providerSeriesColours)}`);
  for (const list of lists) {
    const max = Math.max(...list.bars);
    assert.ok(max > 0, 'bars are drawn');
    assert.ok(list.bars.every(width => width <= max + 0.5), 'no bar exceeds the list maximum');
  }
  // The largest row fills its track: a floor-only bar would make every row look the same size.
  const trackWidth = await page.locator('.usage-bd-track').first().evaluate(node => node.getBoundingClientRect().width);
  assert.ok(Math.max(...lists[0].bars) >= trackWidth * 0.9, `the largest provider bar fills its track (${Math.max(...lists[0].bars)} of ${trackWidth})`);
  // Long model ids keep the three lists stacked at 1280; all three have room at 1920.
  await resize(1920, 1080);
  const sideBySide = await page.locator('.usage-bd-list').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
  assert.equal(new Set(sideBySide).size, 1, `the three lists share one row at 1920: ${sideBySide}`);
  await resize(1280, 800);
  report.breakdowns = { lists, tops: sideBySide, providers: breakdownProviders };
  report.providerSeriesColours = providerSeriesColours;
  check('three breakdown lists render with swatches, values and bars scaled to each list maximum');

  // A row click filters the page; the chip clears it again.
  await page.locator('.usage-bd-provider .usage-bd-row').filter({ hasText: /pi/i }).first().click();
  await until(async () => (await page.locator('.usage-head .chip.chip-btn').count()) === 1, 'provider filter chip', 30_000);
  await until(async () => (await page.locator('.usage-bd-provider .usage-bd-row').count()) === 1, 'provider list narrowed to the filter', 30_000);
  assert.equal(await page.locator('.usage-bd-provider .usage-bd-row.is-selected').count(), 1, 'the pressed row is marked');
  // Every Pi fact in the fixture is unpriced: the cost tile must say so instead of inventing $0.00.
  await until(async () => (await page.locator('.usage-tile-sub').nth(1).innerText()).includes('No price known'), 'unpriced cost reason', 30_000);
  const unpricedCost = await page.locator('.usage-tile-value').nth(1).innerText();
  assert.equal(unpricedCost.trim(), '—', `an unpriced-only range has no amount (${unpricedCost})`);
  assert.ok(!/\$/.test(await page.locator('.usage-tile').nth(1).innerText()), 'no fabricated $0.00 for unpriced models');
  await shot('en-light-1280-unpriced.png');
  check('a row click filters the page and an unpriced-only range reads — with "No price known for these models"');
  await page.locator('.usage-head .chip.chip-btn').first().click();
  await until(async () => (await page.locator('.usage-head .chip.chip-btn').count()) === 0, 'filter cleared', 30_000);
  await until(async () => (await page.locator('.usage-bd-provider .usage-bd-row').count()) >= 3, 'breakdowns restored', 30_000);

  // Sessions: rows, search, sort, page 2 and the drawer.
  const sessionRows = await page.locator('.usage-session-row').count();
  assert.equal(sessionRows, 25, `a full first page of sessions (${sessionRows})`);
  const overflow = await page.locator('.usage-tile, .usage-session-row, .usage-bd-row').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => ({ className: node.className, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, text: (node.textContent ?? '').slice(0, 80) })));
  assert.deepEqual(overflow, [], `long fixture labels do not cause tile, session or breakdown overflow: ${JSON.stringify(overflow)}`);
  const outsideRow = page.locator('.usage-session-row').filter({ hasText: /Outside/ }).first();
  await outsideRow.locator('.usage-session-main').focus();
  const importAction = outsideRow.getByRole('button', { name: /^(Import|导入)$/ });
  assert.equal(await importAction.count(), 1, 'an outside session exposes one keyboard-reachable labelled Import action');
  assert.equal(await importAction.evaluate(node => node.classList.contains('btn') && node.classList.contains('btn-sm')), true, 'the Import action uses the compact shared button');
  await outsideRow.locator('.usage-session-main').press('Tab');
  assert.equal(await importAction.evaluate(node => node === document.activeElement), true, 'Tab reaches the row import action');
  assert.equal(await outsideRow.locator('.usage-session-actions').evaluate(node => getComputedStyle(node).opacity), '1', 'keyboard focus reveals the row action');
  await importAction.evaluate(node => (node instanceof HTMLElement ? node.blur() : undefined));
  await page.mouse.move(600, 4);
  const backgroundBeforeHover = await outsideRow.evaluate(node => getComputedStyle(node).backgroundColor);
  await outsideRow.hover();
  assert.equal(await importAction.isVisible(), true, 'the outside-session import action appears on hover or focus');
  const actionRowGeometry = await outsideRow.evaluate(node => {
    const row = node.getBoundingClientRect(), action = node.querySelector('.usage-session-actions')?.getBoundingClientRect();
    return { background: getComputedStyle(node).backgroundColor, row: row.toJSON(), action: action?.toJSON() };
  });
  assert.notEqual(actionRowGeometry.background, backgroundBeforeHover, `session hover background spans its action (${JSON.stringify(actionRowGeometry)})`);
  assert.ok(actionRowGeometry.action && actionRowGeometry.action.left >= actionRowGeometry.row.left && actionRowGeometry.action.right <= actionRowGeometry.row.right && actionRowGeometry.action.top >= actionRowGeometry.row.top && actionRowGeometry.action.bottom <= actionRowGeometry.row.bottom, `Import action stays inside the session hover row: ${JSON.stringify(actionRowGeometry)}`);
  await shot('en-light-1280-session-actions.png');
  check('outside sessions expose one labelled compact Import action inside the hover/focus row background');
  const pages = (await page.locator('.usage-page-meta').innerText()).match(/(\d+)\s*(?:\/|of)\s*(\d+)/);
  assert.ok(pages && Number(pages[2]) > 1, `paging is offered: ${await page.locator('.usage-page-meta').innerText()}`);
  const firstPageKeys = await page.locator('.usage-session-main').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  await page.getByRole('button', { name: /^(Next|下一页)$/ }).click();
  await until(async () => {
    const labels = await page.locator('.usage-session-main').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    return labels.length > 0 && labels[0] !== firstPageKeys[0];
  }, 'page 2 differs from page 1', 30_000);
  assert.equal(await page.getByRole('button', { name: /^(Previous|上一页)$/ }).isEnabled(), true);
  report.sessions = { rows: sessionRows, pages: pages?.[2] };
  check(`the sessions list pages (${sessionRows} rows, ${pages?.[2]} pages) with a stable order`);
  await page.getByRole('button', { name: /^(Previous|上一页)$/ }).click();
  await until(async () => (await page.locator('.usage-session-main').first().getAttribute('aria-label')) === firstPageKeys[0], 'back on page 1', 30_000);

  await page.locator('.usage-search-input').fill('claude-session-36');
  await sleep(150);
  assert.equal(await page.locator('.usage-session-row').count(), sessionRows, 'search does not filter before its debounce delay');
  await until(async () => (await page.locator('.usage-session-row').count()) < sessionRows, 'search narrowed the list', 30_000);
  assert.equal(await page.locator('.usage-page-meta').count(), 0, 'a narrowed list fits one page');
  await page.locator('.usage-search-input').fill('no-such-session-xyz');
  await until(async () => (await page.locator('.usage-sessions .usage-empty').count()) > 0, 'search empty state', 30_000);
  await page.getByRole('button', { name: /^(Clear search|清除搜索)$/ }).click();
  await until(async () => (await page.locator('.usage-session-row').count()) === sessionRows, 'search cleared', 30_000);
  check('session search waits for its debounce, then filters automatically, shows an empty state and clears');

  await selectOption('.usage-sort', 'Cost');
  await until(async () => (await page.locator('.usage-session-row').count()) === sessionRows, 'cost sort applied', 30_000);
  assert.equal(await page.locator('.usage-session-row .usage-session-meta').first().innerText().then(text => text.includes('API-equivalent')), true, 'cost sorting keeps the API-equivalent wording on the rows');
  await selectOption('.usage-sort', 'Tokens');
  check('sorting by cost and back keeps rows, wording and paging');

  // The drawer: models, days and sub-agents.
  await page.locator('.usage-session-main').first().click();
  await page.locator('.usage-drawer').waitFor();
  await until(async () => (await page.locator('.usage-drawer-stats .usage-drawer-stat').count()) === 4, 'drawer stats', 30_000);
  await until(async () => (await page.locator('.usage-drawer-section').count()) === 3, 'drawer sections', 30_000);
  const drawerSections = await page.locator('.usage-drawer-section h3').allInnerTexts();
  assert.deepEqual(drawerSections, ['Models', 'Days', 'Sub-agents']);
  const drawerDays = await page.locator('.usage-drawer-section .usage-table tbody tr').count();
  assert.ok(drawerDays > 0, 'the drawer lists the session days');
  await shot('en-light-1280-drawer.png');
  report.drawer = { sections: drawerSections, days: drawerDays };
  check(`the session drawer shows its models, days and sub-agents (${drawerDays} days)`);
  assert.equal(await page.getByRole('dialog').locator('.dlg-foot').getByRole('button', { name: /^(Close|关闭)$/ }).count(), 1, 'session drawer footer has one neutral Close action');
  await page.getByRole('button', { name: /^(Close|关闭)$/ }).click();
  await page.locator('.usage-drawer').waitFor({ state: 'detached' });

  await page.locator('.usage-breakdown').scrollIntoViewIfNeeded();
  await shot('en-light-1280-sections.png');

  // Sources: collapsed by default, one row per provider, a confirm dialog for the rebuild.
  assert.equal(await page.locator('.usage-sources-body').count(), 0, 'sources start collapsed');
  // Rebuild once from the native fixture files.  This proves a first full scan produces
  // positive product counts; later incremental scans may honestly report zero changed files.
  const sourceRebuild = await request('usage.ledger.rebuild', { operationId: randomUUID() });
  assert.equal(sourceRebuild.state, 'running', `Sources rebuild starts a real worker: ${JSON.stringify(sourceRebuild)}`);
  let scannedSources;
  await until(async () => {
    const sources = await request('usage.ledger.sources', {});
    const providers = sources.providers ?? [];
    const filesRead = providers.reduce((sum, provider) => sum + (provider.stats?.filesRead ?? 0), 0);
    const facts = providers.reduce((sum, provider) => sum + (provider.stats?.facts ?? 0), 0);
    const contributors = ['claude', 'codex', 'opencode', 'pi', 'kimi', 'grok'];
    const completed = sources.scan?.scanId === sourceRebuild.scanId && sources.scan?.state === 'idle';
    const sourceStats = providers.filter(provider => contributors.includes(provider.provider));
    if (!completed || filesRead !== 1_505 || sourceStats.length !== contributors.length || sourceStats.some(provider => (provider.stats?.filesRead ?? 0) <= 0 || (provider.stats?.facts ?? 0) <= 0)) return false;
    scannedSources = { scanId: sourceRebuild.scanId, state: sources.scan.state, filesRead, facts, providers: sourceStats.map(provider => ({ provider: provider.provider, filesRead: provider.stats?.filesRead ?? 0, facts: provider.stats?.facts ?? 0 })) };
    return true;
  }, 'completed full native scan for all six fixture providers', 180_000);
  await until(async () => (await request('usage.ledger.sources', {})).scan?.state === 'idle' && (await page.locator('.usage-scan-notice').count()) === 0
    && (await page.locator('.usage-tile-value').first().innerText()).trim() !== '—'
    && (await page.locator('.usage-sessions').count()) > 0, 'Usage aggregates settled after Sources rebuild', 90_000);
  await page.locator('.usage-disclosure').click();
  await page.locator('.usage-sources-body').waitFor();
  await until(async () => (await page.locator('.usage-source-row').count()) >= 6, 'source rows', 30_000);
  await until(async () => /^Latest scan:\s*\d+ files read\s*·\s*\d+ usage records$/.test((await page.locator('.usage-sources-total').innerText()).trim()), 'Sources latest-scan totals refreshed after native fixture scan', 30_000);
  const sourceRows = await page.locator('.usage-source-row').allInnerTexts();
  assert.ok(sourceRows.every(text => /Found|Partly read|Format not supported yet|Not installed|Not read/.test(text)), `every row names its state: ${sourceRows[0]}`);
  assert.ok(sourceRows.some(text => /Latest scan:\s*[1-9]\d*\s*\/\s*[1-9]\d* files read/.test(text)), `at least one source row reports positive first-scan files: ${sourceRows.join(' | ')}`);
  assert.ok(sourceRows.some(text => /Reports .*Reasoning/.test(text)), `reasoning bucket has a readable label: ${sourceRows.join(' | ')}`);
  for (const provider of ['Claude', 'Codex', 'OpenCode', 'Pi', 'Kimi', 'Grok']) assert.ok(sourceRows.some(text => text.includes(provider)), `realistic fixture reports ${provider}`);
  await page.locator('.usage-sources').scrollIntoViewIfNeeded();
  await shot('en-light-1280-sources.png');
  report.sources = { scanned: scannedSources, rows: sourceRows.map(text => text.split('\n').slice(0, 4).join(' | ')) };
  check(`the Sources captures honestly label the latest scan and show ${scannedSources.filesRead} first-scan files with ${scannedSources.facts} usage records`);
  // The matrix must exercise the realistic scale, not the small default 30-day slice.
  await selectOption('.usage-range', 'Custom');
  await page.locator('.usage-date').last().fill('2026-10-24');
  await page.locator('.usage-date').first().fill('2025-10-25');
  await until(async () => /\b3\d(?:\.\d+)?B\b/.test(await page.locator('.usage-tile-value').first().innerText()), '35B scale matrix', 60_000);
  // Capture whole Usage surfaces at the actual rendered width and record the resolved sequential palette for validation.
  const usageMatrix = [];
  for (const language of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'custom']) {
    await setAppearance(language, theme);
    for (const requestedWidth of [900, 1280, 1920]) {
      await resize(requestedWidth, 800);
      const viewportWidth = await page.evaluate(() => Math.round(document.documentElement.clientWidth));
      const suffix = `${language}-${theme}-viewport-${viewportWidth}`;
      await page.locator('.usage-trend').scrollIntoViewIfNeeded();
      if (requestedWidth === 900) await assertAxis(`${suffix}-trend`);
      await shotElement('.usage-trend', `${suffix}-trend.png`);
      await page.locator('.usage-sources').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.usage-source-row.is-unsupported .usage-source-problems .chip').count(), 0, 'an unsupported state is not repeated as a translated problem');
      await shotElement('.usage-sources', `${suffix}-sources.png`);
      await shotFull(`${suffix}-usage-full.png`);
      const palette = await page.evaluate(() => {
        const hex = (value) => {
          const context = document.createElement('canvas').getContext('2d'); context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return `#${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(part => part.toString(16).padStart(2, '0')).join('')}`;
        };
        const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
        const cell = level => getComputedStyle(document.querySelector(`.usage-heat-cell.${level}`)).backgroundColor;
        return { surface: hex(surface), seq0: hex(cell('is-empty')), seq1: hex(cell('is-1')), seq2: hex(cell('is-2')), seq3: hex(cell('is-3')), seq4: hex(cell('is-4')) };
      });
      usageMatrix.push({ language, theme, requestedWidth, viewportWidth, palette });
    }
  }
  report.usageMatrix = usageMatrix;
  assert.ok(usageMatrix.some(entry => entry.viewportWidth <= 900), `Usage narrow viewport was honored: ${JSON.stringify(usageMatrix)}`);
  for (const entry of usageMatrix) for (const level of ['seq1', 'seq2', 'seq3', 'seq4']) {
    const hex = entry.palette[level];
    const channels = [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
    assert.ok(channels[2] > channels[0] && channels[2] > channels[1], `${entry.language}/${entry.theme}/${entry.requestedWidth} ${level} remains blue (${hex})`);
  }
  check('Usage Sources and trend captures cover en/zh, light/dark/custom, and 900/1280/1920 viewports');
  await setAppearance('en', 'light');
  await resize(1280, 800);
  await selectOption('.usage-range', 'Last 30 days');
  await until(async () => (await page.locator('.usage-chart-col').count()) === 30, '30-day dashboard restored after matrix', 60_000);
  await page.getByRole('button', { name: /^(Rebuild usage index|重建用量索引)$/ }).click();
  await page.locator('.dlg-foot').waitFor();
  const rebuildTitle = await page.locator('.dlg-head h2').innerText();
  assert.match(rebuildTitle, /Rebuild the usage index\?|重建用量索引？/);
  await shot('en-light-1280-rebuild-confirm.png');
  await page.locator('.dlg-foot').getByRole('button', { name: /^(Cancel|取消)$/ }).click();
  await page.locator('.dlg-foot').waitFor({ state: 'detached' });
  check('"Rebuild usage index" asks for confirmation before dropping the rebuildable index');

  // Settings → Usage: the outside switch, provider toggles, week start and price overrides.
  await page.locator('.user-row').click();
  await page.locator('.account-menu').getByRole('button', { name: /^(Settings|设置)$/ }).click();
  await page.locator('.settings-panel').waitFor();
  await page.locator('.settings-panel').getByRole('tab', { name: /^(Usage|用量)$/ }).click();
  await page.locator('.settings-group.active .setting-switch').first().waitFor();
  const usageSettings = await page.locator('.settings-group.active').innerText();
  assert.match(usageSettings, /Include usage from outside ThreadTerm/);
  assert.match(usageSettings, /Read .* history/);
  assert.match(usageSettings, /Not installed/, 'Settings → Usage reuses the ledger\'s unavailable-provider state');
  assert.match(usageSettings, /Week starts on/);
  assert.match(usageSettings, /Model price overrides/);
  await shot('en-light-1280-settings-usage.png');  // A price override saves through usage.ledger.settings.update and shows up in the runtime's settings.
  await page.locator('.settings-price-model-input').fill('claude/claude-opus-4-5');
  await page.getByRole('button', { name: /^(Add a model price|添加模型价格)$/ }).click();
  await page.locator('.settings-price-row .settings-price-input').first().fill('7.5');
  await page.getByRole('button', { name: /^(Save|保存)$/ }).click();
  await until(async () => (await page.locator('.settings-price-note').innerText().catch(() => '')).includes('Saved'), 'price override saved', 30_000);
  const storedPrices = (await request('usage.ledger.settings', {})).value.priceOverrides;
  assert.equal(storedPrices['claude/claude-opus-4-5']?.input, 7.5, `the override reached the ledger settings: ${JSON.stringify(storedPrices['claude/claude-opus-4-5'])}`);
  report.priceOverride = storedPrices['claude/claude-opus-4-5'];
  assert.equal(await page.locator('.settings-usage-conflict').count(), 0, 'our own save must not raise a conflict banner');
  await page.locator('.settings-price-table').scrollIntoViewIfNeeded();
  await shot('en-light-1280-settings-usage-prices.png');
  check('Settings → Usage saves a per-model price override through usage.ledger.settings.update');
  // The outside switch disables the provider toggles and the page's scope switch.
  await page.locator('.settings-group.active .setting-switch').first().click();
  await until(async () => (await request('usage.ledger.settings', {})).value.includeOutside === false, 'outside switch saved', 30_000);
  assert.equal(await page.locator('.settings-provider-list .setting-switch input:disabled').count() > 0, true, 'provider toggles are disabled while outside usage is off');
  await until(async () => (await page.locator('.settings-provider-list').innerText()).includes('When off'), 'the provider rows explain the off state', 15_000);
  assert.equal(await page.locator('.settings-usage-conflict').count(), 0, 'no conflict banner for its own toggle');
  await shot('en-light-1280-settings-usage-off.png');
  await page.locator('.settings-group.active .setting-switch').first().click();
  await until(async () => (await request('usage.ledger.settings', {})).value.includeOutside === true, 'outside switch restored', 30_000);
  await until(async () => !(await page.locator('.settings-provider-list').innerText()).includes('When off'), 'the off note cleared', 15_000);
  assert.equal(await page.locator('.settings-usage-conflict').count(), 0, 'no conflict banner for its own toggles');
  await until(async () => (await page.locator('.settings-usage-note').count()) === 0, 'the off note cleared', 15_000);
  check('turning outside usage off saves and disables the per-provider switches, and turns back on');
  await page.getByRole('button', { name: /^(Close settings|关闭设置)$/ }).click();
  await page.locator('.settings-panel').waitFor({ state: 'detached' });
  // The page followed the settings events: outside usage is back and the forced In-ThreadTerm scope was released.
  await until(async () => (await page.locator('.usage-note').count()) === 0, 'page reflects the restored setting', 30_000);
  await until(async () => (await page.locator('.usage-head .seg-btn[aria-pressed="true"]').first().innerText()).match(/All usage|全部用量/) !== null, 'scope restored to all usage', 30_000);
  await until(async () => (await page.locator('.usage-tile-value').first().innerText()).trim() !== '—', 'usage visible again', 60_000);
  check('the page releases the forced In-ThreadTerm scope when outside usage is turned back on');
  // A settings change reprices the ledger; let that finish so the remaining screenshots are not all "Repricing…".
  await until(async () => (await request('usage.ledger.sources', {})).scan?.state === 'idle' && (await page.locator('.usage-scan-notice').count()) === 0, 'reprice finished', 150_000);

  // A multi-year range labels its month ticks with the year. The end goes first: each date input rejects a value
  // outside the other one's current bound, so widening has to happen from the right edge outwards.
  await selectOption('.usage-range', 'Custom');
  await page.locator('.usage-date').last().fill('2026-10-24');
  await page.locator('.usage-date').first().fill('2025-01-05');
  assert.deepEqual(await page.locator('.usage-date').evaluateAll(nodes => nodes.map(node => node.value)), ['2025-01-05', '2026-10-24'], 'the custom range took both dates');
  // Month granularity is automatic for a range this long; wait for that series (the day axis has no year).
  await until(async () => (await page.locator('.usage-chart-xaxis > span').allInnerTexts()).some(label => /\d{4}/.test(label)), 'two-year month axis', 90_000);
  assert.equal(await page.locator('.usage-trend .seg').first().getByRole('button', { name: 'Month' }).getAttribute('aria-pressed'), 'true', 'a two-year range switches the trend to months');
  const monthColumns = await page.locator('.usage-chart-col').count();
  assert.ok(monthColumns > 12 && monthColumns < 40, `month buckets for the whole range (${monthColumns})`);
  const multiYearLabels = await page.locator('.usage-chart-xaxis > span').allInnerTexts();
  assert.ok(multiYearLabels.some(label => /\d{4}/.test(label)), `a two-year month axis carries the year: ${multiYearLabels.join(', ')}`);
  report.multiYearLabels = multiYearLabels.filter(Boolean);
  check(`a multi-year month axis labels the year (${multiYearLabels.filter(Boolean).join(', ')})`);
  // Narrow layout: the breakdowns stack and the page keeps one scroll axis.
  await resize(900, 800);
  const stacked = await page.locator('.usage-bd-list').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
  assert.equal(new Set(stacked).size, 1, `the three lists stack at 900 px: ${stacked}`);
  const narrowSections = await page.locator('.usage-scroll').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(narrowSections.scroll <= narrowSections.client + 1, `no page overflow at 900 px (${narrowSections.scroll} > ${narrowSections.client})`);
  await page.locator('.usage-breakdown').scrollIntoViewIfNeeded();
  await shot('en-light-900-sections.png');
  check('at 900 px the breakdowns stack and the page keeps a single scroll axis');
  await resize(1280, 800);
  await selectOption('.usage-range', 'Last 30 days');
  await until(async () => (await page.locator('.usage-heat-grid button.usage-heat-cell').count()) > 360, 'dashboard restored', 60_000);

  // Chinese copy of the new sections.
  await setAppearance('zh-CN', 'dark');
  await page.locator('.usage-breakdown').scrollIntoViewIfNeeded();
  const zhSections = await page.locator('.usage-page').innerText();
  assert.match(zhSections, /按提供商/);
  assert.match(zhSections, /按 API 价格估算/);
  await shot('zh-dark-1280-sections.png');
  report.zhSections = zhSections.split('\n').filter(line => /按提供商|按模型|按项目|会话|数据来源|按 API 价格估算/.test(line)).slice(0, 8);
  check('the new sections are translated (zh-CN) and keep the 按 API 价格估算 wording');
  await setAppearance('en', 'light');

  // Refresh is a user action and the only thing that starts another scan.
  await resetCounts();
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await until(async () => (await counts())['usage.ledger.refresh'], 'refresh RPC');
  await until(async () => (await request('usage.ledger.sources', {})).scan?.state === 'idle' && (await page.locator('.usage-scan-notice').count()) === 0, 'refresh finished', 120_000);

  // Zero idle cost: ten seconds on the open page must not ask the runtime anything. A terminal session in the same
  // workspace renews its lease on its own schedule, so only usage.ledger.* counts against this page.
  await sleep(1500);
  await resetCounts();
  await sleep(10_000);
  const seen = await counts();
  const idle = Object.fromEntries(Object.entries(seen).filter(([method]) => method.startsWith('usage.ledger.')));
  report.idle = { windowMs: 10_000, usage: idle, other: seen };
  assert.deepEqual(idle, {}, `idle usage.ledger RPCs: ${JSON.stringify(idle)}`);
  check('zero renderer→runtime RPCs while the Usage page sits idle for 10 s');

  // This is a ledger-query transport error, distinct from a native scan failure. It
  // preserves the generic error-state regression coverage without faking scan progress.
  await setUsageFault(true);
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await page.locator('.surface-error').waitFor();
  await setUsageFault(false);
  check('a rejected ledger query renders the generic Usage error state');
  // A fixture cannot safely create a genuine native scan failure on this machine; the
  // failed/cancelled notice states are covered by renderer unit tests rather than a fake scan failure.
  report.limitations.push('No genuine native scanner-failure fixture: failed and cancelled scan notices are covered by renderer unit tests.');

  // A separate harness-only response fixture represents a genuinely empty ledger, rather than an empty date range.
  await setUsageScenario('empty');
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await until(async () => (await page.locator('.usage-tiles').innerText()).includes('No usage'), 'empty ledger state', 30_000);
  await until(async () => {
    const reading = await page.locator('.usage-tiles').getAttribute('aria-busy');
    return reading !== 'true' && (await request('usage.ledger.sources', {})).scan?.state === 'idle' && (await page.locator('.usage-scan-notice').count()) === 0;
  }, 'empty-ledger status settled', 30_000);
  assert.equal(await page.locator('.usage-session-row').count(), 0, 'empty ledger has no session rows');
  await shot('en-light-1280-nohistory.png');
  check('a genuinely empty ledger renders the no-history state');
  await setUsageScenario('normal');
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await until(async () => (await page.locator('.usage-session-row').count()) > 0, 'ledger fixture restored after no-history state', 120_000);

  // Last: a native session imported into ThreadTerm becomes an In-ThreadTerm row, and that row opens its session.
  // Runs last because opening it navigates away from the Usage page, which nothing below depends on.
  const imported = await request('history.import', { cwd: work, provider: 'claude', nativeId: 'claude-session-16', mode: 'chat', operationId: randomUUID() });
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await until(async () => (await request('usage.ledger.sources', {})).scan?.state === 'idle' && (await page.locator('.usage-scan-notice').count()) === 0, 'refresh after import finished', 180_000);
  await until(async () => (await page.locator('.usage-session-row').allInnerTexts()).some(text => /In ThreadTerm/.test(text)), 'an In-ThreadTerm session row', 120_000);
  const inThreadTerm = page.locator('.usage-session-row').filter({ hasText: 'In ThreadTerm' }).first();
  const openChatAction = inThreadTerm.getByRole('button', { name: /^(Open chat|打开对话)$/ });
  assert.equal(await openChatAction.count(), 1, 'an In-ThreadTerm row offers one labelled Open chat action');
  assert.equal(await openChatAction.evaluate(node => node.classList.contains('btn') && node.classList.contains('btn-sm')), true, 'the Open chat action uses the compact shared button');
  await page.mouse.move(600, 4);
  const inThreadTermBackground = await inThreadTerm.evaluate(node => getComputedStyle(node).backgroundColor);
  await inThreadTerm.hover();
  const openChatGeometry = await inThreadTerm.evaluate(node => {
    const row = node.getBoundingClientRect();
    const actions = node.querySelector('.usage-session-actions')?.getBoundingClientRect();
    const open = [...node.querySelectorAll('button')].find(button => /^(Open chat|打开对话)$/.test(button.textContent?.trim() ?? ''))?.getBoundingClientRect();
    return { background: getComputedStyle(node).backgroundColor, row: row.toJSON(), actions: actions?.toJSON(), open: open?.toJSON() };
  });
  assert.notEqual(openChatGeometry.background, inThreadTermBackground, `imported row hover background encloses the Open chat action: ${JSON.stringify(openChatGeometry)}`);
  assert.ok(openChatGeometry.actions && openChatGeometry.open && openChatGeometry.actions.left >= openChatGeometry.row.left && openChatGeometry.actions.right <= openChatGeometry.row.right && openChatGeometry.open.right <= openChatGeometry.row.right && openChatGeometry.open.right >= openChatGeometry.row.right - 20, `Open chat action remains inside the row's right edge: ${JSON.stringify(openChatGeometry)}`);
  await shot('en-light-1280-open-chat-action.png');
  await inThreadTerm.locator('.usage-session-main').click();
  await until(async () => (await page.locator('.imported-history-view').first().isVisible().catch(() => false))
    || (await page.locator('[data-chat-log]').first().isVisible().catch(() => false)), 'the session view opened', 30_000);
  assert.equal(await page.locator('.usage-page').first().isVisible().catch(() => false), false, 'the row navigated away from the Usage page');
  report.importedSession = imported.id;
  check('an imported native session becomes an In-ThreadTerm row that opens its session view');

  assert.deepEqual(report.errors, []);
  report.passed = true;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS usage page QA (${report.screenshots.length} screenshots in qa/results/usage-page)`);
} catch (error) {
  report.errors.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
  try {
    report.pageText = await page?.locator('.usage-page').innerText({ timeout: 2000 });
    report.pageTextError = await page?.locator('.surface-error').innerText({ timeout: 2000 }).catch(() => undefined);
    await page?.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' });
  } catch { /* the page may already be gone */ }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)).catch(() => undefined);
  console.error(`FAIL ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  try { await app?.close(); } catch { /* already gone */ }
  if (releaseLock) await releaseLock();
}
