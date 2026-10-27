// Pixel regression for fill-only pane-tab feet over window and region pictures.
// It uses an isolated profile and fake provider PATH, never the user's app/profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { connectPeer } from './pipe-client.mjs';

const root = resolve(import.meta.dirname, '..');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must point to tt-qa-temp'); })());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/pane-tabs-window-background');
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP is the approved QA scratch root');
assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
const scratch = await mkdtemp(join(scratchBase, 'tt-tb-window-tab-'));
const appDir = join(scratch, 'tb-qa-app'), bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const pipe = `\\\\.\\pipe\\tt-tb-window-tab-${randomUUID()}`;
const report = { passed: false, checks: [], screenshots: [], measurements: {}, errors: [] };
let app, page, runtimeProcess, qaApp, releaseLock;
const watchdog = setTimeout(() => { runtimeProcess?.kill(); void app?.close().finally(() => process.exit(124)); }, 20 * 60_000);
const pause = ms => new Promise(done => setTimeout(done, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { if (await probe()) return; if (Date.now() >= end) throw Error(`Timed out waiting for ${label}`); await pause(100); } }
async function settle() { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
  Object.assign(env, { TEMP: scratchBase, TMP: scratchBase, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'isolated environment has one PATH');
  return env;
}
async function startRuntime() {
  runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: 'ignore' });
  await until(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(scratch, 'data', 'runtime.credential'), 'utf8')).trim()); return true; } catch { return false; } finally { peer?.close(); } }, 'isolated runtime');
}
async function bundleFixture() {
  const built = await build({ entryPoints: [join(root, 'qa/fixtures/background-render-qa.ts')], bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'error' });
  await page.evaluate(built.outputFiles[0].text);
  await page.waitForFunction(() => Boolean(window.__ttBackgroundRenderQa));
}
async function waitBackgroundPaint(layers) {
  await page.locator('svg.appearance-backgrounds[data-ready="true"]').waitFor();
  await until(async () => (await page.locator('g[data-background-layer]').count()) >= layers, `${layers} background layers`);
  await page.waitForFunction(async () => { const hrefs = [...document.querySelectorAll('svg.appearance-backgrounds image')].map(node => node.getAttribute('href')).filter(Boolean); await Promise.all(hrefs.map(async href => { const image = new Image(); image.src = href; await image.decode().catch(() => {}); })); return true; });
  await settle();
}
async function waitBackgroundGeometry(label) {
  // Layout updates drive the background geometry; two frames let the SVG and
  // pane layout settle without adding a polling loop to the product.
  await settle();
  await settle();
}
async function captureWithoutSurfaceLift() {
  const lift = await page.evaluate(() => { const node = document.querySelector('[data-background-lift]'); if (!node) return null; const style = getComputedStyle(node); const previous = node.getAttribute('opacity') ?? '1', previousInline = node.style.opacity; node.setAttribute('data-tb-previous-opacity', previous); node.setAttribute('data-tb-previous-inline-opacity', previousInline); node.style.opacity = '0'; void node.getBoundingClientRect(); return { fill: style.fill, opacity: Number(previous), computedBefore: style.opacity }; });
  assert.ok(lift, 'pane picture layer has a surface lift rect');
  await settle(); await settle();
  const image = PNG.sync.read(await page.screenshot({ animations: 'disabled' }));
  await page.evaluate(() => { const node = document.querySelector('[data-background-lift]'); const previous = node?.getAttribute('data-tb-previous-opacity'), inline = node?.getAttribute('data-tb-previous-inline-opacity'); if (node && previous !== null && inline !== null) { node.setAttribute('opacity', previous); node.style.opacity = inline; node.removeAttribute('data-tb-previous-opacity'); node.removeAttribute('data-tb-previous-inline-opacity'); void node.getBoundingClientRect(); } });
  await settle(); await settle();
  return { image, restored: PNG.sync.read(await page.screenshot({ animations: 'disabled' })), lift };
}
async function show(sessionId) { await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), sessionId); await page.locator('.pane-workspace').waitFor(); }
async function patch(value) { const snapshot = await request('runtime.snapshot'); return request('settings.update', { patch: value, expectedRevision: snapshot.settings.revision, operationId: randomUUID() }); }
const layer = (image, extra = {}) => ({ image, opacity: 100, blur: 0, overlay: 0, fit: 'cover', focusX: 50, focusY: 50, scale: 100, ...extra });
async function installTheme(name, mode, backgrounds) {
  const colors = mode === 'dark' ? { background: '#101820', sidebar: '#0d151c', surface: '#172a36', editor: '#14212e', text: '#f1f7fb', muted: '#a9c0cd', accent: '#40c4ff', border: '#33586a', base: 'tokyo-night' } : { background: '#eef3f7', sidebar: '#e5edf3', surface: '#ffffff', editor: '#fbfdff', text: '#13212c', muted: '#4b6477', accent: '#176b99', border: '#a6b6c5', base: 'github-light' };
  await patch({ language: 'en', theme: mode, themeSelection: `custom:${name}`, customThemes: { [name]: { ...colors, backgrounds } }, notifications: { native: false, attention: false, completed: false, sound: false } });
  await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
  await waitBackgroundPaint(Object.keys(backgrounds).length);
}
async function importPictures() {
  const sources = await page.evaluate(async () => {
    const encode = async (name, paint) => { const canvas = new OffscreenCanvas(640, 400), c = canvas.getContext('2d'); paint(c, canvas); const blob = await canvas.convertToBlob({ type: 'image/png' }); return { bytes: [...new Uint8Array(await blob.arrayBuffer())], name }; };
    return Promise.all([
      encode('tb-picture-stripes.png', (c, canvas) => { c.fillStyle = '#061826'; c.fillRect(0, 0, canvas.width, canvas.height); c.strokeStyle = '#f7c948'; c.lineWidth = 1.5; for (let x = -canvas.height; x < canvas.width; x += 4) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + canvas.height, canvas.height); c.stroke(); } }),
      encode('tb-picture-checker.png', (c, canvas) => { for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) { c.fillStyle = (x / 2 + y / 2) % 2 ? '#eff6ff' : '#173a5e'; c.fillRect(x, y, 2, 2); } }),
      encode('tb-picture-photo-like.png', (c, canvas) => { const sky = c.createLinearGradient(0, 0, canvas.width, canvas.height); sky.addColorStop(0, '#134e5e'); sky.addColorStop(.42, '#71b280'); sky.addColorStop(1, '#f5d76e'); c.fillStyle = sky; c.fillRect(0, 0, canvas.width, canvas.height); for (let i = 0; i < 190; i++) { c.fillStyle = `hsla(${150 + (i * 29) % 150}, ${42 + i % 45}%, ${22 + (i * 17) % 58}%, ${.18 + (i % 5) * .09})`; c.beginPath(); c.arc((i * 83) % canvas.width, (i * 131) % canvas.height, 3 + i % 29, 0, Math.PI * 2); c.fill(); } }),
    ]);
  });
  const records = {};
  for (const source of sources) records[source.name] = await page.evaluate(({ bytes, name }) => window.__ttBackgroundRenderQa.importBackgroundFromBytes(new Uint8Array(bytes), 'image/png', name), source);
  return records;
}
const pixel = (image, x, y) => { const offset = (y * image.width + x) * 4; return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]; };
const distance = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
function parseRgba(value) { const parts = value.match(/[\d.]+/g)?.map(Number) ?? []; return parts.length >= 3 ? [...parts.slice(0, 3), parts[3] ?? 1] : undefined; }
const composite = (foreground, background) => foreground.slice(0, 3).map((value, index) => Math.round(value * foreground[3] + background[index] * (1 - foreground[3])));
const luminance = value => Math.round(value[0] * .2126 + value[1] * .7152 + value[2] * .0722);
async function assertFeetPicture(caseName, regionPicture) {
  await waitBackgroundGeometry(caseName);
  const geometry = await page.evaluate(regionPicture => { const pane = document.querySelector('.workspace-pane[data-background-region="chat"]') ?? document.querySelector('.workspace-pane[data-background-region]'); const tab = pane?.querySelector(':scope > .workspace-tabbar .workspace-tab.active'), card = pane?.querySelector(':scope > .pane-card'), layer = document.querySelector('[data-background-layer="chat"]'); const rect = node => { const value = node?.getBoundingClientRect(); return value && { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; }; const style = card && getComputedStyle(card); const background = node => node && getComputedStyle(node).backgroundColor; const stack = (x, y) => document.elementsFromPoint(x, y).slice(0, 8).map(node => ({ tag: node.tagName, className: node.className, background: background(node) })); const cardRect = rect(card), clip = layer?.querySelector('clipPath'), clipRect = clip?.querySelector('rect'), clipTab = clip?.querySelector('path'), svg = layer?.ownerSVGElement; const attrs = node => node && Object.fromEntries(['x','y','width','height'].map(name => [name, Number(node.getAttribute(name))])); const box = node => { try { const value = node?.getBBox(); return value && { x: value.x, y: value.y, width: value.width, height: value.height }; } catch { return undefined; } }; return { tab: rect(tab), card: cardRect, border: style?.borderTopColor, surface: style?.backgroundColor, source: layer?.getAttribute('data-source'), regionPicture, diagnostic: { viewport: { innerWidth, innerHeight, devicePixelRatio }, svg: rect(svg), clipRect: attrs(clipRect), clipTab: box(clipTab), tabBackground: background(tab), cardBackground: background(card), paneBackground: background(pane), tabParentBackground: background(tab?.parentElement), shellBackground: background(document.querySelector('.app-shell')), overlay: layer?.getAttribute('data-overlay'), panelBorderPath: layer?.querySelector('[data-background-border]')?.getAttribute('d'), tabBorderPath: layer?.querySelector('[data-background-tab-border]')?.getAttribute('d'), panelStack: cardRect && stack((cardRect.left + cardRect.right) / 2, cardRect.top + 5) } }; }, regionPicture);
  assert.ok(geometry.tab && geometry.card, `${caseName}: active pane tab and card exist`);
  assert.equal(geometry.source, regionPicture ? 'own' : 'window', `${caseName}: chat ${regionPicture ? 'uses its own picture' : 'inherits the window picture without an own region picture'}`);
  const image = PNG.sync.read(await page.screenshot({ animations: 'disabled' })); const scale = await page.evaluate(() => ({ x: devicePixelRatio, y: devicePixelRatio })); const border = parseRgba(geometry.border), surface = parseRgba(geometry.surface); assert.ok(border && surface, `${caseName}: computed card border and surface parse`); const borderComposite = composite(border, surface);
  assert.equal(geometry.diagnostic.tabBorderPath, undefined, `${caseName}: picture layer supplies no selected-tab outline path`);
  // These 8x9 boxes straddle the concave feet immediately outside the active tab.
  // A previous opaque pseudo-element painted these locations as solid dark squares.
  const boxes = [{ side: 'left', x: geometry.tab.left - 8 }, { side: 'right', x: geometry.tab.right }].map(box => ({ ...box, x: Math.round(box.x * scale.x), y: Math.round((geometry.card.top - 9) * scale.y), width: Math.max(8, Math.round(8 * scale.x)), height: Math.max(9, Math.round(9 * scale.y)) }));
  const samples = [];
  // The fixtures retain image variation through each 8x9 foot box. Checkerboard
  // additionally proves repeated transitions; stripe and photo-like images can
  // be locally smooth, so their non-modal coverage is the stable assertion.
  for (const box of boxes) { const values = []; let transitions = 0; for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) { const value = pixel(image, x, y); values.push(value); if (x > box.x && distance(value, pixel(image, x - 1, y)) >= 18) transitions += 1; if (y > box.y && distance(value, pixel(image, x, y - 1)) >= 18) transitions += 1; } const counts = new Map(); for (const value of values) { const key = value.join(','); counts.set(key, (counts.get(key) ?? 0) + 1); } const dominant = Math.max(...counts.values()), variedPixels = values.length - dominant, borderPixels = values.filter(value => distance(value, borderComposite) <= 12).length; assert.ok(variedPixels >= Math.max(12, Math.ceil(values.length * .15)), `${caseName}/${box.side}: foot area preserves picture variation (${variedPixels} non-modal pixels), not a solid or antialiased square`); if (caseName.includes('checker')) assert.ok(transitions >= 8, `${caseName}/${box.side}: checker foot area keeps repeated picture transitions (${transitions})`); assert.equal(borderPixels, 0, `${caseName}/${box.side}: 8x9 foot area has no border-coloured band`); samples.push({ ...box, variedPixels, transitions, borderPixels }); }
  const underTab = []; const y = Math.round((geometry.card.top + .5) * scale.y); for (let x = Math.round((geometry.tab.left + 12) * scale.x); x < Math.round((geometry.tab.right - 12) * scale.x); x += Math.max(1, Math.round(5 * scale.x))) underTab.push(pixel(image, x, y)); assert.equal(underTab.filter(value => distance(value, borderComposite) <= 12).length, 0, `${caseName}: no border seam under active tab`);
  const cardTopRow = Math.round((geometry.card.top + .5) * scale.y), topFill = [geometry.card.left + 14, geometry.tab.left - 14, geometry.tab.left + 14, geometry.tab.right - 14, geometry.tab.right + 14, geometry.card.right - 14].filter(x => x > geometry.card.left + 8 && x < geometry.card.right - 8).map(x => pixel(image, Math.round(x * scale.x), cardTopRow));
  assert.equal(topFill.filter(value => distance(value, borderComposite) <= 12).length, 0, `${caseName}: card top has no border-coloured band beside or beneath the selected tab`);
  const tabEdges = [[(geometry.tab.left + geometry.tab.right) / 2, geometry.tab.top + .5], [geometry.tab.left + .5, geometry.tab.top + 15], [geometry.tab.right - .5, geometry.tab.top + 15]].map(([x, y]) => pixel(image, Math.round(x * scale.x), Math.round(y * scale.y)));
  assert.equal(tabEdges.filter(value => distance(value, borderComposite) <= 12).length, 0, `${caseName}: selected tab edge has no border-coloured stroke`);
  const joinX = Math.round((geometry.tab.left + 20) * scale.x), tabBottom = Math.round(geometry.tab.bottom * scale.y), cardTop = Math.round(geometry.card.top * scale.y);
  const tabBand = [], panelBand = [], parityPoints = [];
  for (let x = joinX; x < Math.round((geometry.tab.right - 20) * scale.x); x += 2) for (let offset = 3; offset <= 8; offset++) { const tabY = tabBottom - offset, panelY = cardTop + offset, tabValue = luminance(pixel(image, x, tabY)), panelValue = luminance(pixel(image, x, panelY)); tabBand.push(tabValue); panelBand.push(panelValue); if (parityPoints.length < 12) parityPoints.push({ x, tabY, panelY, tab: tabValue, panel: panelValue }); }
  const range = values => Math.max(...values) - Math.min(...values);
  const overlay = { tabLuminanceRange: range(tabBand), panelLuminanceRange: range(panelBand), tabMean: Math.round(tabBand.reduce((total, value) => total + value, 0) / tabBand.length), panelMean: Math.round(panelBand.reduce((total, value) => total + value, 0) / panelBand.length), points: parityPoints };
  // Compare each shape against its own same-coordinate no-lift reference. This
  // proves equal rendered lift while remaining immune to the picture phase at
  // different tab/panel y coordinates, including fractional browser zoom.
  const withoutLift = await captureWithoutSurfaceLift(), liftColor = parseRgba(withoutLift.lift.fill); assert.ok(liftColor, `${caseName}: surface lift fill parses`);
  const liftPoints = [];
  for (let x = Math.round((geometry.tab.left + 20) * scale.x); x < Math.round((geometry.tab.right - 20) * scale.x); x += 2) for (let offset = 3; offset <= 8; offset++) { liftPoints.push({ x, y: Math.round((geometry.tab.top + offset) * scale.y), shape: 'tab' }, { x, y: Math.round((geometry.card.top + offset) * scale.y), shape: 'panel' }); }
  const liftErrors = liftPoints.map(point => { const before = pixel(withoutLift.image, point.x, point.y), actual = pixel(withoutLift.restored, point.x, point.y), expected = composite([...liftColor.slice(0, 3), withoutLift.lift.opacity], before); return { ...point, before, actual, expected, error: distance(actual, expected) }; });
  const worstLiftError = Math.max(...liftErrors.map(point => point.error));
  report.measurements[caseName] = { raster: { width: image.width, height: image.height, scale }, geometry, overlay, lift: { color: liftColor.slice(0, 3), opacity: withoutLift.lift.opacity, worstError: worstLiftError, samples: liftErrors.slice(0, 12) } };
  assert.ok(worstLiftError <= 4, `${caseName}: tab and panel pixels apply the same surface lift (worst expected-composite error ${worstLiftError})`);
  report.measurements[caseName] = { raster: { width: image.width, height: image.height, scale }, geometry, overlay, lift: { color: liftColor.slice(0, 3), opacity: withoutLift.lift.opacity, worstError: worstLiftError } };
  // The fill-only tab must read against the strip even without a border. Sample
  // the tab and the strip at the same height, clear of the curved feet.
  const tabFill = [], leftStrip = [], rightStrip = [];
  for (let y = Math.round((geometry.tab.top + 3) * scale.y); y <= Math.round((geometry.tab.top + 6) * scale.y); y += 1) {
    for (let x = Math.round((geometry.tab.left + 20) * scale.x); x < Math.round((geometry.tab.right - 20) * scale.x); x += Math.max(1, Math.round(4 * scale.x))) tabFill.push(luminance(pixel(image, x, y)));
    for (let x = Math.round((geometry.tab.left - 26) * scale.x); x <= Math.round((geometry.tab.left - 14) * scale.x); x += Math.max(1, Math.round(2 * scale.x))) leftStrip.push(luminance(pixel(image, x, y)));
    for (let x = Math.round((geometry.tab.right + 14) * scale.x); x <= Math.round((geometry.tab.right + 26) * scale.x); x += Math.max(1, Math.round(2 * scale.x))) rightStrip.push(luminance(pixel(image, x, y)));
  }
  const mean = values => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const distinction = { tabMean: mean(tabFill), leftStripMean: mean(leftStrip), rightStripMean: mean(rightStrip), panelRange: range(panelBand) };
  distinction.leftDelta = Math.abs(distinction.tabMean - distinction.leftStripMean);
  distinction.rightDelta = Math.abs(distinction.tabMean - distinction.rightStripMean);
  distinction.delta = Math.min(distinction.leftDelta, distinction.rightDelta);
  assert.ok(distinction.delta >= 12, `${caseName}: tab fill differs from each same-height strip side by at least 12 luminance (tab ${distinction.tabMean}; left ${distinction.leftStripMean}, delta ${distinction.leftDelta}; right ${distinction.rightStripMean}, delta ${distinction.rightDelta})`);
  assert.ok(distinction.panelRange > 0, `${caseName}: picture texture remains visible inside the lifted panel (luminance range ${distinction.panelRange})`);
  report.measurements[caseName] = { raster: { width: image.width, height: image.height, scale }, geometry, feet: samples, overlay, lift: { color: liftColor.slice(0, 3), opacity: withoutLift.lift.opacity, worstError: worstLiftError }, distinction, diagnostic: geometry.diagnostic };
  const filename = `${caseName}-tab-feet.png`; await page.screenshot({ path: join(out, filename), clip: { x: Math.max(0, geometry.tab.left - 40), y: Math.max(0, geometry.tab.top - 4), width: geometry.tab.right - geometry.tab.left + 80, height: geometry.card.top - geometry.tab.top + 18 }, animations: 'disabled' }); report.screenshots.push(filename);
  if (caseName === 'dark-100pct-stripes-window-only' || caseName === 'dark-100pct-photo-like-chat-region') { const full = `${caseName}-full-window.png`; await page.screenshot({ path: join(out, full), animations: 'disabled' }); report.screenshots.push(full); }
  check(`${caseName}: picture fills both tab feet; tab/panel join has one overlay with no top band or tab stroke, and fill distinguishes tab from strip`);
}

try {
  await Promise.all([mkdir(out, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(plugins, { recursive: true }), mkdir(work, { recursive: true })]);
  await writeFile(join(bin, 'codex.cmd'), '@echo off\r\necho fake-codex %*\r\n'); await writeFile(join(work, 'fixture.txt'), 'pane tab background fixture\n');
  qaApp = await buildQaApp({ root, outDir: appDir }); releaseLock = await acquireElectronQaLock({ directory: scratchBase, timeoutMs: 40 * 60_000 }); await startRuntime();
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: environment(), timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(30_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' }); await bundleFixture();
  const project = await request('project.add', { path: work, name: 'TB window picture QA', operationId: randomUUID() }); const session = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'chat', title: 'Window picture tab', operationId: randomUUID() }); await show(session.id); await page.locator('.workspace-tab.active').waitFor();
  const pictures = await importPictures(); assert.ok(Object.values(pictures).every(picture => picture?.id), 'imported stripe, checkerboard and photo-like pictures');
  for (const [fixture, picture] of Object.entries(pictures)) for (const mode of ['dark', 'light']) for (const zoom of [1, 1.25]) { await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value), zoom); await settle(); const suffix = `${mode}-${zoom === 1 ? '100' : '125'}pct-${fixture.slice('tb-picture-'.length, -4)}`; await installTheme(`TB ${suffix} window`, mode, { window: layer(picture.id) }); await assertFeetPicture(`${suffix}-window-only`, false); await installTheme(`TB ${suffix} chat`, mode, { window: layer(picture.id), chat: layer(picture.id, { focusX: 25 }) }); await assertFeetPicture(`${suffix}-chat-region`, true); }
  report.passed = true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); }
finally {
  clearTimeout(watchdog); await app?.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`)); if (runtimeProcess?.exitCode === null) runtimeProcess.kill(); await releaseLock?.().catch(error => report.errors.push(`Lock cleanup: ${error.message}`)); await qaApp?.cleanup?.().catch(() => {}); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(report.passed && report.errors.length === 0 ? 'PANE TABS WINDOW BACKGROUND VISUAL QA PASSED' : `PANE TABS WINDOW BACKGROUND VISUAL QA FAILED ${report.errors.join(' | ')}`); if (!report.passed || report.errors.length) process.exitCode = 1;
}
