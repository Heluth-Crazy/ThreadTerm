// Usage page visual QA (task 10-23-usage-accounting, UA2a + UA2a2).
// Desktop 1, isolated runtime + profile, fake providers only, provider histories as TEMP fixtures (never this PC's).
//   node qa/usage-page-visual.mjs
// Checks: the Usage workspace tab opens from the account menu, the first refresh shows a reading state, tiles/heatmap/
// trend render, the trend x-axis and direct label agree with the data, the heatmap fills its card and keeps today in
// view, a zero-usage day says only "No usage", an empty range shows no fabricated $0, en/zh x light/dark x 900/1280/1920
// are captured, and the page makes zero RPCs while idle.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const out = join(root, 'qa/results/usage-page');
const scratchBase = resolve('D:/project/ThreadTerm/tt-qa-temp');
await mkdir(scratchBase, { recursive: true });
const scratch = await mkdtemp(join(scratchBase, 'tt-usage-page-'));
const appDir = join(scratch, 'app'), work = join(scratch, 'work'), bin = join(scratch, 'bin');
const claudeHome = join(scratch, 'claude'), codexHome = join(scratch, 'codex'), piHome = join(scratch, 'pi');
const lock = join(scratchBase, 'qa-electron.lock');
const report = { passed: false, checks: [], screenshots: [], idle: {}, errors: [], limitations: [] };
let app, page, locked = false;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([a, b]) => window.threadterm.request(a, b), [method, params]);
const counts = () => page.evaluate(() => window.threadtermQaCounts.snapshot());
const resetCounts = () => page.evaluate(() => window.threadtermQaCounts.reset());
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
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = ((channel: string, ...args: unknown[]) => {
  if (channel === 'threadterm:request') { const method = String(args[0]); counts.set(method, (counts.get(method) ?? 0) + 1); }
  return invoke(channel, ...args);
}) as typeof ipcRenderer.invoke;
contextBridge.exposeInMainWorld('threadtermQaCounts', {
  snapshot: () => Object.fromEntries(counts),
  reset: () => counts.clear(),
});
`;
}
async function shot(name) { await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }

// --- provider history fixtures (a year of varied days, one outlier, priced and unpriced models) ---
const day = offset => { const value = new Date(Date.UTC(2026, 9, 24)); value.setUTCDate(value.getUTCDate() - offset); return value.toISOString().slice(0, 10); };
async function fixtures() {
  await mkdir(join(claudeHome, 'projects', 'demo-project'), { recursive: true });
  await mkdir(join(codexHome, 'sessions', '2026', '10'), { recursive: true });
  await mkdir(join(piHome, 'agent', 'sessions', 'demo'), { recursive: true });
  const claude = [];
  for (let offset = 364; offset >= 0; offset -= 1) {
    if ((offset * 7) % 11 === 0) continue; // zero days stay empty
    const count = 1 + (offset % 3);
    for (let index = 0; index < count; index += 1) {
      const outlier = offset === 200;
      const scale = outlier ? 4_000_000 : 40_000 + (offset % 23) * 3_000;
      claude.push(JSON.stringify({
        sessionId: `claude-session-${offset}`, requestId: `request-${offset}-${index}`, cwd: work,
        timestamp: `${day(offset)}T08:${String(index * 4).padStart(2, '0')}:00Z`,
        message: { id: `message-${offset}-${index}`, model: index === 2 ? 'claude-unpriced-qa' : 'claude-opus-4-5',
          usage: { input_tokens: Math.round(scale * 0.06), output_tokens: Math.round(scale * 0.05), cache_read_input_tokens: Math.round(scale * 0.88), cache_creation: { ephemeral_5m_input_tokens: Math.round(scale * 0.01), ephemeral_1h_input_tokens: 0 } } },
      }));
    }
  }
  await writeFile(join(claudeHome, 'projects', 'demo-project', 'session.jsonl'), `${claude.join('\n')}\n`);
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
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  await esbuild({ entryPoints: [join(root, 'desktop/src/main.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'main.cjs'), logLevel: 'error' });
  // Harness-only preload wrapper: it imports the product preload unmodified and counts request channels.
  await writeFile(join(scratch, 'preload-entry.ts'), preloadWrapper());
  await esbuild({ entryPoints: [join(scratch, 'preload-entry.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, 'preload.cjs'), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'usage-page-visual-qa', version: '1', main: 'main.cjs' }));
}
async function takeLock() {
  const deadline = Date.now() + 40 * 60_000;
  for (;;) {
    try { await mkdir(lock); locked = true; return; } catch { /* another harness holds it */ }
    if (Date.now() > deadline) throw Error('Timed out waiting for the Electron QA lock');
    await sleep(15_000);
  }
}
async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(w, h); win.show(); }, [width, height]);
  await page.setViewportSize({ width, height }).catch(() => undefined);
  await sleep(400);
}
async function setAppearance(language, theme) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
  await page.waitForFunction(expected => document.documentElement.lang === expected, language);
  await sleep(250);
}
async function openUsage() {
  await page.locator('.user-row').click();
  await page.getByRole('button', { name: /^(Usage|用量)$/ }).click();
  await until(async () => (await page.locator('.usage-page').count()) > 0, 'usage page mounted');
}

try {
  await takeLock();
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
  const project = (await request('runtime.snapshot')).projects?.[0] ?? await request('project.add', { path: work, name: 'Usage QA', operationId: randomUUID() });
  const shell = await request('session.create', { projectId: project.id, cwd: work, provider: 'shell', mode: 'terminal', title: 'Usage QA', operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), shell.id);
  await page.locator('.workspace-pane').first().waitFor();
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  app.process().stderr?.on('data', chunk => { (report.mainLog ??= []).push(String(chunk).slice(0, 400)); });
  // Probe the ledger reads before the UI uses them, so a hanging RPC is reported with its method name.
  const probes = {};
  for (const [method, params] of [
    ['usage.ledger.settings', {}],
    ['usage.ledger.sources', {}],
    ['usage.ledger.summary', { filters: { from: '2026-09-25', to: '2026-10-25', scope: 'all', includeOutside: true } }],
    ['usage.ledger.series', { filters: { from: '2026-09-25', to: '2026-10-25', scope: 'all', includeOutside: true }, granularity: 'day', stack: 'provider', weekStart: 'auto' }],
    ['usage.ledger.series', { filters: { from: '2025-10-25', to: '2026-10-25', scope: 'all', includeOutside: true }, granularity: 'day', stack: 'provider', weekStart: 'auto' }],
  ]) {
    const started = Date.now();
    try {
      const result = await Promise.race([request(method, params), sleep(20_000).then(() => 'TIMEOUT')]);
      probes[method] = result === 'TIMEOUT' ? 'TIMEOUT' : `${Date.now() - started}ms ${Array.isArray(result) ? 'array' : result && typeof result === 'object' ? Object.keys(result).slice(0, 6).join(',') : String(result)}`;
    } catch (error) { probes[method] = `ERR ${error instanceof Error ? error.message : String(error)}`; }
  }
  report.probes = probes;
  console.log(`probes ${JSON.stringify(probes)}`);

  await openUsage();
  // The first capture happens while the opening refresh is still reading history: the tiles must hold a placeholder
  // instead of claiming "No usage" before anything has been read.
  const firstScan = {
    placeholders: await page.locator('.usage-skel').count(),
    reading: await page.locator('.usage-tiles[aria-busy="true"]').count(),
    tiles: await page.locator('.usage-tiles').innerText().catch(() => ''),
  };
  await shot('en-light-1280-progress.png');
  report.firstScan = { placeholders: firstScan.placeholders, reading: firstScan.reading, tiles: firstScan.tiles.split('\n').slice(0, 8) };
  if (firstScan.placeholders > 0) {
    assert.equal(firstScan.placeholders, 4, 'every tile holds a placeholder while reading');
    assert.ok(!/No usage/.test(firstScan.tiles), 'a reading page does not claim the range is empty');
    assert.match(firstScan.tiles, /Reading history/);
    check('the first refresh shows a reading state instead of "No usage in this range"');
  } else {
    report.limitations.push('the opening refresh finished before the first capture; the reading state was only covered by unit tests');
  }
  const usageTab = page.locator('.workspace-tab', { hasText: /Usage/ }).first();
  await usageTab.waitFor();
  check('the account menu opens a Usage workspace tab');
  await until(async () => (await page.locator('.usage-tile').count()) >= 4, 'summary tiles');
  await until(async () => !(await page.locator('.usage-progress').innerText().catch(() => '')).includes('…'), 'history read finished', 120_000);
  await until(async () => (await page.locator('.usage-skel').count()) === 0, 'tiles leave the reading state', 30_000);
  const tileText = await page.locator('.usage-tiles').innerText();
  const cells = await page.locator('.usage-heat-grid button.usage-heat-cell').count();
  assert.ok(cells > 360, `one cell per day (${cells})`);
  const levelClasses = () => page.locator('.usage-heat-grid button.usage-heat-cell').evaluateAll(nodes => [...new Set(nodes.map(node => node.className.split(' ')[1]))]);
  await until(async () => (await levelClasses()).includes('is-4'), 'heatmap quantile levels', 60_000);
  const levels = await levelClasses();
  assert.ok(levels.includes('is-4') && levels.includes('is-empty'), `heatmap levels ${levels.join(',')}`);
  const segments = await page.locator('.usage-chart-seg').count();
  assert.ok(segments > 3, `trend segments (${segments})`);
  assert.match(tileText, /Tokens/);
  assert.ok(/\$/.test(tileText), 'API-equivalent cost is shown');
  assert.ok((await page.locator('.usage-legend-trend > span').count()) >= 2, 'trend legend lists the providers');
  report.tiles = tileText.split('\n').slice(0, 14);
  check(`summary tiles, a year of heatmap cells (${cells}) and a stacked trend render from fixture history`);

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
    for (const entry of labelled) assert.match(entry.text, /[A-Za-z\u4e00-\u9fff]/, `${context}: label text ${entry.text}`);
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
  const granularitySeg = page.locator('.usage-trend .usage-seg').first();
  for (const [name, columns] of [['Week', 6], ['Month', 2]]) {
    await granularitySeg.getByRole('button', { name, exact: true }).click();
    await until(async () => (await page.locator('.usage-chart-col').count()) <= columns, `${name.toLowerCase()} trend`, 30_000);
    const labels = await assertAxis(name.toLowerCase());
    report[`${name.toLowerCase()}Labels`] = labels.map(entry => entry.text);
  }
  await granularitySeg.getByRole('button', { name: 'Day', exact: true }).click();
  await until(async () => (await page.locator('.usage-chart-col').count()) === 30, 'day trend restored', 30_000);
  check('week and month trends keep their own non-overlapping date ticks');


  // The one direct label is the tallest column's total (not its top segment) and stays inside the chart band.
  const direct = (await page.locator('.usage-chart-direct').innerText()).trim();
  const columnLabels = await page.locator('.usage-chart-col').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? ''));
  const numeric = text => { const match = /^([\d.]+)([KMB])?$/.exec(text); return match ? Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]] ?? 1) : 0; };
  const totals = columnLabels.map(label => label.trim().split(/\s+/).at(-1));
  const tallest = totals.reduce((best, total) => numeric(total) > numeric(best) ? total : best, '0');
  assert.equal(direct, tallest, `direct label ${direct} is the tallest column total`);
  const directBox = await page.locator('.usage-chart-direct').evaluate(node => ({ ...node.getBoundingClientRect().toJSON() }));
  const plotBox = await page.locator('.usage-chart-plot').evaluate(node => ({ ...node.getBoundingClientRect().toJSON() }));
  report.directBox = { directBox, plotBox };
  assert.ok(directBox.top >= plotBox.top - 15 && directBox.bottom <= plotBox.bottom, `direct label inside the chart band (${directBox.top}/${plotBox.top})`);
  report.directLabel = { text: direct, tallest, columns: columnLabels.length };
  check(`the trend direct label shows the tallest column total (${direct})`);

  // The calendar fills its card; the legend sits under the grid, right-aligned to the grid.
  const heat = () => page.evaluate(() => {
    const scroll = document.querySelector('.usage-heat-scroll');
    const grid = document.querySelector('.usage-heat-grid').getBoundingClientRect();
    const foot = document.querySelector('.usage-heat-foot').getBoundingClientRect();
    const legend = document.querySelector('.usage-heat-foot .usage-legend').getBoundingClientRect();
    const cell = document.querySelector('.usage-heat-cell').getBoundingClientRect().width;
    return {
      box: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft,
      grid: grid.width, gridLeft: grid.left - scroll.getBoundingClientRect().left, cell,
      gridRight: grid.right, footRight: foot.right, legendRight: legend.right,
      headerLegend: document.querySelectorAll('.usage-heat .usage-section-head .usage-legend').length,
    };
  });

  // Heatmap tooltip: date, buckets, cost and contributing sources.
  const filled = page.locator('.usage-heat-grid button.usage-heat-cell:not(.is-empty)').last();
  await filled.hover();
  await page.locator('.usage-tip').waitFor();
  const tipText = await page.locator('.usage-tip').innerText();
  assert.match(tipText, /\d/, 'tooltip shows numbers');
  await shot('en-light-1280-heatmap-tooltip.png');
  check('every heatmap cell has a tooltip with tokens, cost and sources');
  // Park the pointer outside the grid so the gallery screenshots are not covered by a tooltip.
  await page.mouse.move(600, 4);
  await until(async () => (await page.locator('.usage-tip').count()) === 0, 'tooltip dismissed', 10_000);

  // A zero-usage day says only what it knows: the date and "No usage".
  await page.locator('.usage-heat-grid button.usage-heat-cell.is-empty').first().hover();
  await page.locator('.usage-tip').waitFor();
  const emptyTip = await page.locator('.usage-tip').innerText();
  assert.match(emptyTip, /No usage/);
  assert.match(emptyTip, /\d{4}/, 'the empty tooltip still names the date');
  assert.ok(!/\$|tokens|requests|Cost/.test(emptyTip.replace('No usage', '')), `empty tooltip says nothing else: ${emptyTip}`);
  // A first-row cell flips its tooltip below itself instead of covering the card header.
  const tipBox = await page.locator('.usage-tip').evaluate(node => ({ ...node.getBoundingClientRect().toJSON() }));
  const headBox = await page.locator('.usage-heat .usage-section-head').first().evaluate(node => ({ ...node.getBoundingClientRect().toJSON() }));
  assert.ok(tipBox.top >= headBox.bottom, `the tooltip stays out of the card header (${tipBox.top} vs ${headBox.bottom})`);
  await shot('en-light-1280-heatmap-empty-tooltip.png');
  await page.mouse.move(600, 4);
  await until(async () => (await page.locator('.usage-tip').count()) === 0, 'empty tooltip dismissed', 10_000);
  check('a zero-usage day tooltip shows its date and "No usage" only');

  await resize(1280, 800);
  const wide = await heat();
  assert.ok(Math.abs(wide.grid - wide.box) <= 2, `the calendar spans its card at 1280 (${wide.grid} vs ${wide.box})`);
  assert.equal(wide.headerLegend, 0, 'the Less/More legend left the card header');
  assert.ok(Math.abs(wide.footRight - wide.gridRight) <= 2, `the legend row is as wide as the grid (${wide.footRight} vs ${wide.gridRight})`);
  assert.ok(Math.abs(wide.legendRight - wide.gridRight) <= 2, `the legend sits at the grid's right edge (${wide.legendRight} vs ${wide.gridRight})`);
  report.heatmap1280 = wide;
  check(`the calendar fills the card at 1280 (${Math.round(wide.cell)} px cells) with the Less/More legend under its right edge`);
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
  assert.ok(veryWide.cell <= 16.5, `cells are capped at 16 px (${veryWide.cell})`);
  assert.ok(Math.abs(veryWide.gridLeft) <= 1, `the capped grid stays left-aligned (${veryWide.gridLeft})`);
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

  // Refresh is a user action and the only thing that starts another scan.
  await resetCounts();
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await until(async () => (await counts())['usage.ledger.refresh'], 'refresh RPC');
  await until(async () => !(await page.locator('.usage-progress').innerText().catch(() => '')).includes('…'), 'refresh finished', 120_000);

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
  if (locked) { await rm(lock, { recursive: true, force: true }).catch(() => undefined); }
}
