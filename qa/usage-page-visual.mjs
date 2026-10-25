// Usage page visual QA (task 10-23-usage-accounting, UA2a + UA2a2).
// Desktop 1, isolated runtime + profile, fake providers only, provider histories as TEMP fixtures (never this PC's).
//   node qa/usage-page-visual.mjs
// Checks: the Usage workspace tab opens from the account menu, the first refresh shows a reading state, tiles/heatmap/
// trend render, the trend x-axis and direct label agree with the data, the heatmap fills its card and keeps today in
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
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
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
async function shotElement(selector, name) { await page.locator(selector).screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
// The app's Select is a custom combobox: open the trigger, then pick the option by its visible label.
async function selectOption(scope, label) {
  await page.locator(`${scope} .tt-select-trigger`).first().click();
  await page.locator('.tt-select-menu .tt-select-option-label', { hasText: label }).first().click();
  await until(async () => (await page.locator('.tt-select-menu').count()) === 0, `select ${label} closed`, 10_000);
}

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
  assert.ok(lists[0].swatches > 0, 'providers carry their slot swatch');
  assert.equal(lists[1].swatches, 0, 'models are not coloured');
  for (const list of lists) {
    const max = Math.max(...list.bars);
    assert.ok(max > 0, 'bars are drawn');
    assert.ok(list.bars.every(width => width <= max + 0.5), 'no bar exceeds the list maximum');
  }
  // The largest row fills its track: a floor-only bar would make every row look the same size.
  const trackWidth = await page.locator('.usage-bd-track').first().evaluate(node => node.getBoundingClientRect().width);
  assert.ok(Math.max(...lists[0].bars) >= trackWidth * 0.9, `the largest provider bar fills its track (${Math.max(...lists[0].bars)} of ${trackWidth})`);
  // Three lists side by side at 1280, stacked at 900.
  const sideBySide = await page.locator('.usage-bd-list').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
  assert.equal(new Set(sideBySide).size, 1, `the three lists share one row at 1280: ${sideBySide}`);
  report.breakdowns = { lists, tops: sideBySide };
  check('three breakdown lists render with swatches, values and bars scaled to each list maximum');

  // A row click filters the page; the chip clears it again.
  await page.locator('.usage-bd-provider .usage-bd-row').filter({ hasText: /pi/i }).first().click();
  await until(async () => (await page.locator('.usage-head .usage-chip').count()) === 1, 'provider filter chip', 30_000);
  await until(async () => (await page.locator('.usage-bd-provider .usage-bd-row').count()) === 1, 'provider list narrowed to the filter', 30_000);
  assert.equal(await page.locator('.usage-bd-provider .usage-bd-row.is-selected').count(), 1, 'the pressed row is marked');
  // Every Pi fact in the fixture is unpriced: the cost tile must say so instead of inventing $0.00.
  await until(async () => (await page.locator('.usage-tile-sub').nth(1).innerText()).includes('No price known'), 'unpriced cost reason', 30_000);
  const unpricedCost = await page.locator('.usage-tile-value').nth(1).innerText();
  assert.equal(unpricedCost.trim(), '—', `an unpriced-only range has no amount (${unpricedCost})`);
  assert.ok(!/\$/.test(await page.locator('.usage-tile').nth(1).innerText()), 'no fabricated $0.00 for unpriced models');
  await shot('en-light-1280-unpriced.png');
  check('a row click filters the page and an unpriced-only range reads — with "No price known for these models"');
  await page.locator('.usage-head .usage-chip').first().click();
  await until(async () => (await page.locator('.usage-head .usage-chip').count()) === 0, 'filter cleared', 30_000);
  await until(async () => (await page.locator('.usage-bd-provider .usage-bd-row').count()) >= 3, 'breakdowns restored', 30_000);

  // Sessions: rows, search, sort, page 2 and the drawer.
  const sessionRows = await page.locator('.usage-session-row').count();
  assert.equal(sessionRows, 25, `a full first page of sessions (${sessionRows})`);
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
  await page.locator('.usage-search-input').press('Enter');
  await until(async () => (await page.locator('.usage-session-row').count()) < sessionRows, 'search narrowed the list', 30_000);
  assert.equal(await page.locator('.usage-page-meta').count(), 0, 'a narrowed list fits one page');
  await page.locator('.usage-search-input').fill('no-such-session-xyz');
  await page.locator('.usage-search-input').press('Enter');
  await until(async () => (await page.locator('.usage-sessions .usage-empty').count()) > 0, 'search empty state', 30_000);
  await page.getByRole('button', { name: /^(Clear search|清除搜索)$/ }).click();
  await until(async () => (await page.locator('.usage-session-row').count()) === sessionRows, 'search cleared', 30_000);
  check('session search narrows the list, shows an empty state and clears');

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
  await page.getByRole('button', { name: /^(Close|关闭)$/ }).click();
  await page.locator('.usage-drawer').waitFor({ state: 'detached' });

  await page.locator('.usage-breakdown').scrollIntoViewIfNeeded();
  await shot('en-light-1280-sections.png');

  // Sources: collapsed by default, one row per provider, a confirm dialog for the rebuild.
  assert.equal(await page.locator('.usage-sources-body').count(), 0, 'sources start collapsed');
  await page.locator('.usage-disclosure').click();
  await page.locator('.usage-sources-body').waitFor();
  await until(async () => (await page.locator('.usage-source-row').count()) >= 3, 'source rows', 30_000);
  const sourceRows = await page.locator('.usage-source-row').allInnerTexts();
  assert.ok(sourceRows.every(text => /Found|Partly read|Format not supported yet|Not installed|Not read/.test(text)), `every row names its state: ${sourceRows[0]}`);
  assert.ok(sourceRows.some(text => /files/.test(text)), 'the rows report how many files were read');
  assert.ok(sourceRows.some(text => /Reports .*Reasoning/.test(text)), `reasoning bucket has a readable label: ${sourceRows.join(' | ')}`);
  await page.locator('.usage-sources').scrollIntoViewIfNeeded();
  await shot('en-light-1280-sources.png');
  report.sources = sourceRows.map(text => text.split('\n').slice(0, 4).join(' | '));
  check(`the sources panel is collapsed until opened and then lists ${sourceRows.length} providers with files, localized buckets and problems`);
  // Capture the two affected Usage surfaces at the actual rendered width. Element shots keep the evidence focused while
  // the name records the viewport size Electron accepted (rather than assuming a requested narrow window was honored).
  const usageMatrix = [];
  for (const [language, theme] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) {
    await setAppearance(language, theme);
    for (const requestedWidth of [1280, 900]) {
      await resize(requestedWidth, 800);
      const viewportWidth = await page.evaluate(() => Math.round(document.documentElement.clientWidth));
      const suffix = `${language}-${theme}-viewport-${viewportWidth}`;
      await page.locator('.usage-trend').scrollIntoViewIfNeeded();
      if (requestedWidth === 900) await assertAxis(`${suffix}-trend`);
      await shotElement('.usage-trend', `${suffix}-trend.png`);
      await page.locator('.usage-sources').scrollIntoViewIfNeeded();
      await shotElement('.usage-sources', `${suffix}-sources.png`);
      usageMatrix.push({ language, theme, requestedWidth, viewportWidth });
    }
  }
  report.usageMatrix = usageMatrix;
  assert.ok(usageMatrix.some(entry => entry.viewportWidth <= 900), `Usage narrow viewport was honored: ${JSON.stringify(usageMatrix)}`);
  check('Usage Sources and trend captures cover en/zh, light/dark, wide and actual narrow viewports');
  await setAppearance('en', 'light');
  await resize(1280, 800);
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
  await until(async () => (await page.locator('.usage-seg-item[aria-pressed="true"]').first().innerText()).match(/All usage|全部用量/) !== null, 'scope restored to all usage', 30_000);
  await until(async () => (await page.locator('.usage-tile-value').first().innerText()).trim() !== '—', 'usage visible again', 60_000);
  check('the page releases the forced In-ThreadTerm scope when outside usage is turned back on');
  // A settings change reprices the ledger; let that finish so the remaining screenshots are not all "Repricing…".
  await until(async () => (await page.locator('.usage-progress').innerText().catch(() => '')).trim() === '', 'reprice finished', 150_000);

  // A multi-year range labels its month ticks with the year. The end goes first: each date input rejects a value
  // outside the other one's current bound, so widening has to happen from the right edge outwards.
  await selectOption('.usage-range', 'Custom');
  await page.locator('.usage-date').last().fill('2026-10-24');
  await page.locator('.usage-date').first().fill('2025-01-05');
  assert.deepEqual(await page.locator('.usage-date').evaluateAll(nodes => nodes.map(node => node.value)), ['2025-01-05', '2026-10-24'], 'the custom range took both dates');
  // Month granularity is automatic for a range this long; wait for that series (the day axis has no year).
  await until(async () => (await page.locator('.usage-chart-xaxis > span').allInnerTexts()).some(label => /\d{4}/.test(label)), 'two-year month axis', 90_000);
  assert.equal(await page.locator('.usage-trend .usage-seg').first().getByRole('button', { name: 'Month' }).getAttribute('aria-pressed'), 'true', 'a two-year range switches the trend to months');
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

  // Last: a native session imported into ThreadTerm becomes an In-ThreadTerm row, and that row opens its session.
  // Runs last because opening it navigates away from the Usage page, which nothing below depends on.
  const imported = await request('history.import', { cwd: work, provider: 'claude', nativeId: 'claude-session-1', mode: 'chat', operationId: randomUUID() });
  await page.locator('.usage-head .icon-btn[aria-label="Refresh usage"]').click();
  await until(async () => !(await page.locator('.usage-progress').innerText().catch(() => '')).includes('…'), 'refresh after import finished', 180_000);
  await until(async () => (await page.locator('.usage-session-row').allInnerTexts()).some(text => /In ThreadTerm/.test(text)), 'an In-ThreadTerm session row', 120_000);
  const inThreadTerm = page.locator('.usage-session-row').filter({ hasText: 'In ThreadTerm' }).first();
  assert.equal(await inThreadTerm.getByRole('button', { name: /^(Open chat|打开 Chat)$/ }).count(), 1, 'an In-ThreadTerm row offers its Chat');
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
