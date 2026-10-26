// Background-image rendering matrix. Runs only against a throwaway app/profile,
// fake providers and Desktop 1; it never launches the user's development app.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { PNG } from 'pngjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must be the approved tt-qa-temp directory'); })());
// D2a deliberately uses the shared appearance runtime.  It is built by the
// owning job; this harness never builds or touches the user's development runtime.
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/appearance-backgrounds');
const runLogPath = join(scratchBase, 'd2a-backgrounds-resume.log');
const scratch = await mkdtemp(join(scratchBase, 'tt-bg-render-d2a-'));
const pipe = `\\\\.\\pipe\\tt-bg-render-d2a-${randomUUID()}`;
const lock = join(scratchBase, 'qa-electron.lock');
const appDir = join(scratch, 'app'), bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const backgrounds = join(scratch, 'profile', 'backgrounds'), cache = join(backgrounds, 'Cache');
const report = { passed: false, checks: [], screenshots: [], measurements: {}, contrast: {}, errors: [], limitations: [] };
let app, page, runtimeProcess, qaApp, server, baseUrl, releaseLock, runtimeLog;
const runLog = createWriteStream(runLogPath, { flags: 'a' });
const step = text => { const line = `[${new Date().toISOString()}] ${text}`; console.log(line); runLog.write(`${line}\n`); };
const watchdog = setTimeout(() => { step('WATCHDOG timeout'); runtimeProcess?.kill(); void app?.close().finally(() => process.exit(124)); }, 90 * 60_000);

const pause = ms => new Promise(done => setTimeout(done, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { if (await probe()) return; if (Date.now() >= end) throw Error(`Timed out waiting for ${label}`); await pause(100); } }

function environment() {
  // Remove every PATH spelling before supplying only Node, System32 and our fake
  // provider directory. This makes accidentally starting a real CLI impossible.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
  Object.assign(env, {
    TEMP: scratchBase, TMP: scratchBase,
    PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
    THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: baseUrl,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'isolated environment has exactly one PATH');
  return env;
}
async function startRuntime() {
  step('runtime spawn'); runtimeLog = createWriteStream(runLogPath, { flags: 'a' });
  runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimeProcess.stdout.pipe(runtimeLog, { end: false }); runtimeProcess.stderr.pipe(runtimeLog, { end: false });
  await until(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(scratch, 'data', 'runtime.credential'), 'utf8')).trim()); return true; } catch { return false; } finally { peer?.close(); } }, 'isolated runtime'); step('runtime ready');
}
async function settle() { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
async function waitBackgroundPaint(minimumLayers = 1) {
  await page.locator('svg.appearance-backgrounds[data-ready="true"]').waitFor();
  await until(async () => (await page.locator('g[data-background-layer]').count()) >= minimumLayers, `${minimumLayers} background layers`);
  await page.waitForFunction(async () => {
    const hrefs = [...document.querySelectorAll('svg.appearance-backgrounds image')].map(image => image.getAttribute('href')).filter(Boolean);
    await Promise.all(hrefs.map(async href => { const image = new Image(); image.src = href; try { await image.decode(); } catch { /* the later pixel check makes a failed asset visible */ } }));
    return true;
  });
  await settle();
}
async function resize(width, height) { await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height }); await page.setViewportSize({ width, height }); await settle(); }
async function shot(name) { await page.mouse.move(0, 0); await settle(); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function bundleFixture() { const built = await esbuild({ entryPoints: [join(root, 'qa/fixtures/background-render-qa.ts')], bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'error' }); await page.evaluate(built.outputFiles[0].text); await page.waitForFunction(() => Boolean(window.__ttBackgroundRenderQa)); }
async function show(sessionId) { await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), sessionId); await page.locator('.pane-workspace').waitFor(); }
async function openFiles() { const button = page.locator('.wb-switcher').getByRole('button', { name: /^(Files|文件)$/, exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); }
async function workspaceAction(name) {
  const pane = page.locator('.workspace-pane.selected');
  // The fixture's completed-session toast can cover this header while it is
  // fading. Remove that transient notification, then dispatch directly on the
  // exact control so this layout setup does not depend on screen coordinates.
  await page.evaluate(() => document.querySelectorAll('.attention-toast').forEach(node => node.remove()));
  const trigger = pane.getByRole('button', { name: 'Workspace actions', exact: true });
  await trigger.waitFor();
  await trigger.evaluate(node => node.click());
  await page.waitForFunction(button => button.getAttribute('aria-expanded') === 'true', await trigger.elementHandle());
  const action = page.getByRole('button', { name, exact: true });
  await action.waitFor({ state: 'visible' });
  await action.click();
}
async function selectPaneSession(title) { const pane = page.locator('.workspace-pane.selected'); await pane.getByRole('button', { name: 'Choose session', exact: true }).click(); await page.locator('.switcher-row').filter({ hasText: title }).click(); }
async function arrangeWorkspace(project, chat, terminal, compact = false) {
  const state = await request('runtime.snapshot'), saved = state.workspaces.find(item => item.projectId === project.id);
  const leaves = node => node.kind === 'pane' ? [node] : [...leaves(node.first), ...leaves(node.second)]; const panes = leaves(saved.layout);
  const has = (pane, kind, id) => pane.tabs.some(tab => tab.kind === kind && (!id || tab.sessionId === id));
  const chatPane = panes.find(pane => has(pane, 'session', chat.id)), terminalPane = panes.find(pane => has(pane, 'session', terminal.id)), filePane = panes.find(pane => has(pane, 'file')), browserPane = panes.find(pane => has(pane, 'web'));
  assert.ok(chatPane && terminalPane && filePane && browserPane, 'fixture has chat, editor, terminal and browser panes');
  const file = filePane.tabs.find(tab => tab.kind === 'file'), scope = { projectId: file.projectId, worktreePath: file.worktreePath, path: file.path };
  const doc = await request('filesystem.read', scope);
  if (!(await request('draft.list', { projectId: file.projectId, worktreePath: file.worktreePath })).some(draft => draft.path === file.path)) await request('draft.put', { ...scope, content: `${doc.content}\n// Keep the background QA file pane open.\n`, baseFingerprint: doc.fingerprint, expectedRevision: 0, operationId: randomUUID() });
  const split = (direction, ratio, first, second) => ({ kind: 'split', id: randomUUID(), direction, ratio, first, second });
  const layout = split('horizontal', compact ? .25 : .58, chatPane, split('vertical', compact ? 1 / 3 : .24, browserPane, split('vertical', .5, filePane, terminalPane)));
  await request('workspace.save', { id: saved.id, name: saved.name, projectId: project.id, worktreePath: saved.worktreePath, layout, expectedRevision: saved.revision, operationId: randomUUID() });
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' }); await show(chat.id);
  await page.locator('.tt-editor-shell:visible').waitFor(); await page.locator('.xterm:visible').waitFor(); await page.locator('.wb-web-preview:visible').waitFor(); await openFiles();
  const activity = page.locator('.chat-tool-activity:visible'); if (await activity.getAttribute('open') === null) { await activity.locator(':scope > summary').focus(); await page.keyboard.press('Enter'); }
}

async function patch(patch) { const snapshot = await request('runtime.snapshot'); return request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() }); }
const layer = (image, extra = {}) => ({ image, opacity: 100, blur: 0, overlay: 5, fit: 'cover', focusX: 50, focusY: 50, scale: 100, ...extra });
async function installTheme(name, mode, backgroundsValue) {
  const colors = mode === 'dark'
    ? { background: '#101820', sidebar: '#0d151c', surface: '#172a36', editor: '#14212e', text: '#f1f7fb', muted: '#a9c0cd', accent: '#40c4ff', border: '#33586a', base: 'tokyo-night' }
    : { background: '#eef3f7', sidebar: '#e5edf3', surface: '#ffffff', editor: '#fbfdff', text: '#13212c', muted: '#4b6477', accent: '#176b99', border: '#a6b6c5', base: 'github-light' };
  await patch({ language: 'en', theme: mode, themeSelection: `custom:${name}`, customThemes: { [name]: { ...colors, backgrounds: backgroundsValue } }, notifications: { native: false, attention: false, completed: false, sound: false } });
  await page.waitForFunction(key => document.documentElement.dataset.customTheme === 'true' && getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().length > 0, name);
  if (backgroundsValue) await waitBackgroundPaint();
  else await page.locator('svg.appearance-backgrounds').waitFor({ state: 'detached' });
}

async function importStressImages() {
  const images = await page.evaluate(async () => {
    const encode = async (paint, name) => {
      const canvas = new OffscreenCanvas(640, 400), context = canvas.getContext('2d'); paint(context, canvas); const blob = await canvas.convertToBlob({ type: 'image/png' }); const bytes = new Uint8Array(await blob.arrayBuffer()); return { name, bytes: [...bytes] };
    };
    return Promise.all([
      encode((c, x) => { c.fillStyle = '#000'; c.fillRect(0, 0, x.width, x.height); c.strokeStyle = '#fff'; c.lineWidth = 20; for (let i = -x.height; i < x.width; i += 40) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + x.height, x.height); c.stroke(); } }, 'stripes.png'),
      encode((c, x) => { const g = c.createLinearGradient(0, 0, x.width, x.height); g.addColorStop(0, '#ffe86a'); g.addColorStop(.45, '#ff6c4a'); g.addColorStop(1, '#3c7ed8'); c.fillStyle = g; c.fillRect(0, 0, x.width, x.height); for (let i = 0; i < 40; i++) { c.fillStyle = `hsla(${i * 19}, 85%, 88%, .5)`; c.beginPath(); c.arc((i * 83) % x.width, (i * 47) % x.height, 18 + i % 40, 0, Math.PI * 2); c.fill(); } }, 'bright-gradient.png'),
      encode((c, x) => { c.fillStyle = '#07101d'; c.fillRect(0, 0, x.width, x.height); for (let i = 0; i < 100; i++) { c.fillStyle = i % 3 ? '#d7f2ff' : '#ffdb6a'; c.fillRect((i * 137) % x.width, (i * 73) % x.height, 2 + i % 5, 2 + i % 5); } }, 'dark-points.png'),
    ]);
  });
  const records = {};
  for (const image of images) records[image.name] = await page.evaluate(async ({ bytes, name }) => window.__ttBackgroundRenderQa.importBackgroundFromBytes(new Uint8Array(bytes), 'image/png', name), image);
  return records;
}

function rgba(value) {
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return [1, 3, 5].map(offset => Number.parseInt(value.trim().slice(offset, offset + 2), 16));
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? []; return parts.length >= 3 ? parts.slice(0, 3) : null;
}
function luminance(rgb) { return rgb.map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, x, index) => sum + x * [0.2126, .7152, .0722][index], 0); }
function ratio(one, two) { const [a, b] = [luminance(one), luminance(two)].sort((x, y) => y - x); return (a + .05) / (b + .05); }
async function textContrast(scenario, mode, region, selector, minimum) {
  const candidates = page.locator(selector); let target;
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (let index = 0; index < await candidates.count(); index += 1) { const candidate = candidates.nth(index); await candidate.scrollIntoViewIfNeeded(); const box = await candidate.boundingBox(); if (box && box.width > 1 && box.height > 1 && box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0) { target = candidate; break; } }
  assert.ok(target, `${region}: a visible text target exists`);
  const value = await target.evaluate((node, region) => {
    const layer = document.querySelector(`[data-background-layer="${region}"]`); const host = document.querySelector(`[data-background-region="${region}"]`);
    const color = getComputedStyle(node).color, overlay = layer?.getAttribute('data-overlay'), floor = layer?.getAttribute('data-floor');
    const rect = node.getBoundingClientRect(), hostRect = host?.getBoundingClientRect();
    return { color, text: node.textContent?.trim(), overlay, floor, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hostRect: hostRect && { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height } };
  }, region);
  assert.ok(value.text, `${region}: target contains visible text`); assert.ok(value.hostRect && Number(value.overlay) >= Number(value.floor), `${region}: rendered layer has a readability-floor overlay`);
  const clipped = { x: Math.max(value.rect.x, value.hostRect.x, 0), y: Math.max(value.rect.y, value.hostRect.y, 0), right: Math.min(value.rect.x + value.rect.width, value.hostRect.x + value.hostRect.width, viewport.width), bottom: Math.min(value.rect.y + value.rect.height, value.hostRect.y + value.hostRect.height, viewport.height) };
  assert.ok(clipped.right > clipped.x + 1 && clipped.bottom > clipped.y + 1, `${scenario}/${region}: default foreground target intersects its visible region host`);
  // The visual sample validates a rendered glyph pixel against the nearest non-glyph
  // pixel in the same text line; the computed foreground guards anti-aliasing edges.
  const png = PNG.sync.read(await page.screenshot({ animations: 'disabled' })), expected = rgba(value.color); assert.ok(expected, `${scenario}/${region}: parses text color`);
  const scaleX = png.width / (await page.evaluate(() => innerWidth)), scaleY = png.height / (await page.evaluate(() => innerHeight));
  const rect = { x: clipped.x, y: clipped.y, width: clipped.right - clipped.x, height: clipped.bottom - clipped.y }, pixels = [];
  for (let y = Math.max(1, Math.floor(rect.y * scaleY)); y < Math.min(png.height - 1, Math.ceil((rect.y + rect.height) * scaleY)); y++) for (let x = Math.max(1, Math.floor(rect.x * scaleX)); x < Math.min(png.width - 1, Math.ceil((rect.x + rect.width) * scaleX)); x++) { const o = (y * png.width + x) * 4, pixel = [png.data[o], png.data[o + 1], png.data[o + 2]], distance = Math.hypot(...pixel.map((v, i) => v - expected[i])); if (distance <= 12) pixels.push({ pixel, x, y, distance }); }
  assert.ok(pixels.length, `${scenario}/${region}: screenshot contains a full-strength default-foreground glyph`);
  // On light surfaces the actual darkest foreground pixel is the conservative
  // glyph; on dark surfaces use the brightest. Only full-strength foreground
  // candidates qualify, so image pixels cannot be mistaken for text.
  const glyph = pixels.sort((a, b) => mode === 'light' ? luminance(a.pixel) - luminance(b.pixel) : luminance(b.pixel) - luminance(a.pixel))[0];
  const surroundings = new Map();
  for (let y = glyph.y - 5; y <= glyph.y + 5; y++) for (let x = glyph.x - 5; x <= glyph.x + 5; x++) { if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue; const o = (y * png.width + x) * 4, pixel = [png.data[o], png.data[o + 1], png.data[o + 2]], distance = Math.hypot(...pixel.map((v, i) => v - expected[i])); if (distance > 24) { const key = pixel.join(','); const entry = surroundings.get(key) ?? { pixel, count: 0 }; entry.count += 1; surroundings.set(key, entry); } }
  const background = [...surroundings.values()].sort((a, b) => b.count - a.count)[0]?.pixel;
  assert.ok(background, `${scenario}/${region}: screenshot contains modal surrounding background pixels`);
  const sampled = ratio(glyph.pixel, background), key = `${scenario}/${mode}/${region}`; assert.ok(sampled >= minimum, `${key}: actual glyph contrast ${sampled.toFixed(2)} meets ${minimum}:1 target`);
  report.contrast[key] = { backgroundMode: scenario, themeMode: mode, ratio: sampled, target: minimum, expectedForegroundRGB: expected, glyphRGB: glyph.pixel, backgroundRGB: background, glyphPoint: { x: glyph.x, y: glyph.y }, text: value.text };
  const crop = `${scenario}-${mode}-${region}-contrast-crop.png`; await page.screenshot({ path: join(out, crop), clip: { x: Math.max(0, rect.x - 4), y: Math.max(0, rect.y - 4), width: Math.max(1, Math.min((await page.evaluate(() => innerWidth)) - Math.max(0, rect.x - 4), rect.width + 8)), height: Math.max(1, Math.min((await page.evaluate(() => innerHeight)) - Math.max(0, rect.y - 4), rect.height + 8)) }, animations: 'disabled' }); report.screenshots.push(crop);
}
async function assertContrastMatrix(scenario, mode) {
  await textContrast(scenario, mode, 'chat', 'text=Chat visual fixture complete.', 4.5);
  await textContrast(scenario, mode, 'editor', '.tt-editor-shell .cm-line', 7);
  await textContrast(scenario, mode, 'terminal', '.xterm-rows > div', 7);
}

async function assertTabJoin() {
  const geometry = await page.evaluate(() => {
    const pane = document.querySelector('.workspace-pane[data-background-region="editor"]') ?? document.querySelector('.workspace-pane[data-background-region]'); const tab = pane?.querySelector('.workspace-tab.active'); const card = pane?.querySelector(':scope > .pane-card'); const r = node => { const x = node?.getBoundingClientRect(); return x && { left: x.left, right: x.right, top: x.top, bottom: x.bottom }; }; return { tab: r(tab), card: r(card), border: getComputedStyle(document.documentElement).getPropertyValue('--border') };
  });
  assert.ok(geometry.tab && geometry.card, 'selected workspace tab and pane card exist');
  const png = PNG.sync.read(await page.screenshot({ animations: 'disabled' })), border = rgba(geometry.border); assert.ok(border, 'parses border token');
  const sx = png.width / (await page.evaluate(() => innerWidth)), sy = png.height / (await page.evaluate(() => innerHeight));
  const at = (x, y) => { const o = (Math.round(y * sy) * png.width + Math.round(x * sx)) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]]; };
  const borderLike = pixel => Math.max(...pixel.map((v, i) => Math.abs(v - border[i]))) < 12;
  const row = geometry.card.top + 0.5;
  for (let x = geometry.tab.left + 12; x < geometry.tab.right - 12; x += 5) assert.equal(borderLike(at(x, row)), false, 'panel border is cut beneath selected tab');
  const feet = await page.evaluate(() => {
    const group = document.querySelector('g[data-background-layer="editor"]') ?? document.querySelector('g[data-background-layer]'); const path = group?.querySelector('path[data-background-tab-border]');
    if (!path) return []; const matrix = path.getScreenCTM(), length = path.getTotalLength(); if (!matrix || !length) return [];
    return [2, 6, 10, length - 10, length - 6, length - 2].map(distance => { const point = path.getPointAtLength(distance); const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: screen.x, y: screen.y }; });
  });
  assert.equal(feet.length, 6, 'selected-tab SVG supplies both concave feet');
  for (const foot of feet) { let found = false; for (let y = foot.y - 2; y <= foot.y + 2; y++) for (let x = foot.x - 2; x <= foot.x + 2; x++) found ||= borderLike(at(x, y)); assert.ok(found, 'a small neighborhood on each concave foot contains the border stroke'); }
  await page.screenshot({ path: join(out, 'tab-join-crop.png'), clip: { x: Math.max(0, geometry.tab.left - 14), y: Math.max(0, geometry.tab.top - 3), width: Math.min((await page.evaluate(() => innerWidth)) - Math.max(0, geometry.tab.left - 14), geometry.tab.right - geometry.tab.left + 28), height: Math.max(1, geometry.card.top - geometry.tab.top + 22) }, animations: 'disabled' }); report.screenshots.push('tab-join-crop.png');
}

async function assertSolid(selector, label) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  const result = await target.evaluate(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { expected: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(), className: node.className, background: style.backgroundColor, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; });
  const expected = rgba(result.expected), png = PNG.sync.read(await page.screenshot({ animations: 'disabled' })); assert.ok(expected, `${label}: solid token parses`);
  const sx = png.width / (await page.evaluate(() => innerWidth)), sy = png.height / (await page.evaluate(() => innerHeight));
  // Rounded corners and one-pixel outlines are intentionally not surface-color
  // samples. Search only the element's inset padding for an opaque surface pixel.
  let solid = false, nearest = Infinity, nearestPoint;
  for (let y = result.rect.y + 16; y < result.rect.y + result.rect.height - 16 && !solid; y += 12) for (let x = result.rect.x + 16; x < result.rect.x + result.rect.width - 16; x += 12) {
    const offset = (Math.round(y * sy) * png.width + Math.round(x * sx)) * 4;
    const actual = [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
    const difference = Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
    if (difference < nearest) { nearest = difference; nearestPoint = { x, y, actual }; }
    solid ||= difference <= 4;
  }
  assert.ok(solid, `${label}: an inset padding screenshot pixel equals the solid surface token (${JSON.stringify({ ...result, nearest, nearestPoint })})`);
}
async function assertTerminalViewportColor(expected, label) {
  const viewport = page.locator('.xterm-scrollable-element:visible');
  await viewport.waitFor();
  await page.waitForFunction(([node, color]) => getComputedStyle(node).backgroundColor === color, [await viewport.elementHandle(), expected]);
  await settle();
  assert.equal(await viewport.evaluate(node => getComputedStyle(node).backgroundColor), expected, label);
}
async function pngEquals(left, right, label) { const a = PNG.sync.read(left), b = PNG.sync.read(right); assert.equal(a.width, b.width, `${label}: same image width`); assert.equal(a.height, b.height, `${label}: same image height`); assert.deepEqual(a.data, b.data, `${label}: removal restores exact no-image pixels`); }
async function idleCpu30(label) {
  const session = await page.context().newCDPSession(page); await session.send('Performance.enable'); const metric = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const before = await metric(); await pause(30_000); const after = await metric(); const value = Math.round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000); report.measurements[label] = value; await session.detach(); return value;
}
async function dragFrames() {
  const divider = page.locator('.pane-divider').first(); if (await divider.count()) { const box = await divider.boundingBox(); if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.evaluate(() => { window.__ttBgFrames = []; let last = performance.now(); const tick = now => { window.__ttBgFrames.push(now - last); last = now; if (window.__ttBgFrames.length < 90) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }); for (let step = 1; step <= 30; step += 1) { await page.mouse.move(box.x + box.width / 2 + step * 4, box.y + box.height / 2); await pause(30); } await page.mouse.up(); const frames = await page.evaluate(() => window.__ttBgFrames); frames.sort((a, b) => a - b); report.measurements.dividerDragP95Ms = frames[Math.floor(frames.length * .95)]; } }
}

try {
  assert.ok(existsSync(runtime), `missing required shared QA runtime: ${runtime}`); assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP is the approved QA scratch root');
  await Promise.all([out, bin, plugins, work].map(path => mkdir(path, { recursive: true }))); await writeFile(join(work, 'background-qa.ts'), 'export const backgroundQa = true;\n'); server = createServer((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Background browser</title><main>Browser chrome background fixture</main>'); }); await new Promise(done => server.listen(0, '127.0.0.1', done)); baseUrl = `http://127.0.0.1:${server.address().port}`;
  cpSync(join(root, 'qa/fixtures/chat-visual-echo-acp'), join(plugins, 'chat-visual-echo-acp'), { recursive: true });
  cpSync(join(root, 'qa/fixtures/browser-plugins'), join(plugins, 'browser-preview-acp-qa'), { recursive: true });
  await writeFile(join(bin, 'fake-terminal.cjs'), "process.stdout.write('Background terminal fixture ready\\r\\n');process.stdin.resume();\n");
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nif "%~1"=="--help" (echo codex-background-qa --no-alt-screen& exit /b 0)\r\necho %*|findstr /C:"resume" >nul && (@"${process.execPath}" "%~dp0fake-terminal.cjs"& exit /b 0)\r\n@"${process.execPath}" "${join(root, 'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
  step('build QA app'); qaApp = await buildQaApp({ root, outDir: appDir }); step('wait shared Electron lock'); releaseLock = await acquireElectronQaLock({ directory: scratchBase, timeoutMs: 40 * 60_000 }); step('shared Electron lock acquired'); await startRuntime();
  step('launch Electron'); app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: environment(), timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(30_000); page.on('pageerror', error => report.errors.push(error.message)); await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' }); await patch({ language: 'en', notifications: { native: false, attention: false, completed: false, sound: false } }); await page.waitForFunction(() => document.documentElement.lang === 'en'); await bundleFixture(); step('bridge and fixture ready');
  step('wait providers'); await until(async () => (await request('provider.list')).some(item => item.id === 'codex' && item.chat), 'fake Codex provider'); await until(async () => (await request('plugin.list')).plugins.some(item => item.id === 'chat-visual-echo-acp'), 'chat fixture plugin'); await request('plugin.setEnabled', { pluginId: 'chat-visual-echo-acp', enabled: true, operationId: randomUUID() }); await until(async () => (await request('provider.list')).some(item => item.id === 'chat-visual-echo' && item.chat), 'chat fixture provider'); step('providers ready');
  step('create workspace fixture'); const project = await request('project.add', { path: work, name: 'Background render QA', operationId: randomUUID() }); const chat = await request('session.create', { projectId: project.id, cwd: work, provider: 'chat-visual-echo', mode: 'chat', title: 'Background chat', operationId: randomUUID() }); const terminal = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'terminal', title: 'Background terminal', operationId: randomUUID() }); const browser = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'chat', title: 'Background browser', operationId: randomUUID() });
  await show(browser.id); await page.locator('.chat-compose-shell textarea').fill('open preview'); await page.locator('.chat-compose-send[type=submit]').click(); await page.locator('.wb-web-preview:visible').waitFor(); await show(chat.id); await page.locator('.chat-compose-shell textarea:visible').fill('Emit the plan, tools and a final answer.'); await page.locator('.chat-compose-send[type=submit]:visible').click(); await page.locator('.chat-tool-activity:visible').waitFor({ timeout: 30_000 }); await page.getByText('Chat visual fixture complete.', { exact: true }).waitFor();
  await openFiles(); await page.locator('.wb-tree [data-path="background-qa.ts"]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Open beside session', exact: true }).click(); await page.locator('.tt-editor-shell:visible').waitFor(); await workspaceAction('Split down'); await selectPaneSession('Background terminal'); await page.locator('.xterm:visible').waitFor(); await page.getByText('Background terminal fixture ready', { exact: true }).waitFor(); await arrangeWorkspace(project, chat, terminal); await bundleFixture(); step('workspace arranged and fixture reloaded');
  const records = await importStressImages(); const stripe = records['stripes.png'], bright = records['bright-gradient.png'], points = records['dark-points.png']; assert.ok(stripe && bright && points, 'three D1 stress images imported'); check('D1 imported stripe, bright-gradient and dark-points stress images');
  // The app's regular startup creates a visible chat; the engine's region hosts are
  // asserted before any screenshot, so a missing fixture fails with a clear contract.
  await resize(1440, 900);
  const windowOnly = { window: layer(stripe.id, { overlay: 1 }) };
  await installTheme('Background QA dark window', 'dark', windowOnly); await page.locator('[data-background-layer="window"]').waitFor(); await assertContrastMatrix('window-only', 'dark'); await shot('en-dark-1440-window.png');
  await installTheme('Background QA light window', 'light', windowOnly); await assertContrastMatrix('window-only', 'light'); await shot('en-light-1440-window.png');
  await patch({ language: 'zh-CN' }); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN'); await shot('zh-light-1440-window.png');
  await installTheme('Background QA dark window', 'dark', windowOnly); await patch({ language: 'zh-CN' }); await shot('zh-dark-1440-window.png');
  await resize(960, 640); await arrangeWorkspace(project, chat, terminal, true); await bundleFixture(); for (const [locale, mode] of [['en', 'light'], ['zh-CN', 'light'], ['en', 'dark'], ['zh-CN', 'dark']]) { await installTheme(`Background QA ${mode} window`, mode, windowOnly); await patch({ language: locale }); await shot(`${locale === 'zh-CN' ? 'zh' : 'en'}-${mode}-960-window.png`); }
  const regions = { window: layer(stripe.id, { overlay: 2 }), sidebar: layer(bright.id, { overlay: 2, fit: 'contain' }), sidebar2: layer(points.id, { overlay: 2 }), chat: layer('inherit', { overlay: 2 }), editor: layer(bright.id, { blur: 12, overlay: 2, focusX: 30 }), terminal: layer(points.id, { overlay: 2 }), browser: layer('inherit', { overlay: 2 }) };
  await resize(1440, 900); await arrangeWorkspace(project, chat, terminal); await bundleFixture(); await installTheme('Background QA dark regions', 'dark', regions); await waitBackgroundPaint(5); await page.locator('[data-background-layer="editor"]').waitFor(); const bakePath = join(cache, `${bright.id}-b12.webp`); const initialBake = await stat(bakePath); assert.ok(initialBake.size > 0, 'renderer baked the required blur variant after theme activation'); await shot('en-dark-1440-regions.png'); await assertTabJoin();
  let terminalIdentity = await page.locator('.xterm:visible').elementHandle(); await assertTerminalViewportColor('rgba(0, 0, 0, 0)', 'terminal background is transparent only while a terminal/window image is active');
  await assertContrastMatrix('per-region', 'dark'); await assertSolid('.chat-compose-shell:visible', 'composer'); await assertSolid('.chat-tool-activity:visible', 'tool card/diff region');
  for (const [locale, mode] of [['en', 'light'], ['zh-CN', 'light'], ['en', 'dark'], ['zh-CN', 'dark']]) { await installTheme(`Background QA ${mode} regions`, mode, regions); if (locale === 'en') await assertContrastMatrix('per-region', mode); await patch({ language: locale }); await shot(`${locale === 'zh-CN' ? 'zh' : 'en'}-${mode}-1440-regions.png`); }
  const repeatedBake = await stat(bakePath); assert.equal(repeatedBake.mtimeMs, initialBake.mtimeMs, 're-activating the background reuses its baked blur without rewriting it'); assert.equal(repeatedBake.size, initialBake.size, 'reused blur variant keeps its original bytes'); assert.deepEqual((await readdir(cache)).filter(name => name === `${bright.id}-b12.webp`), [`${bright.id}-b12.webp`], 'one Cache file exists per image and blur'); check('renderer bake-on-demand created one blur variant and repeated activation reused it unchanged');
  await resize(960, 640); await arrangeWorkspace(project, chat, terminal, true); await bundleFixture(); terminalIdentity = await page.locator('.xterm:visible').elementHandle(); for (const [locale, mode] of [['en', 'light'], ['zh-CN', 'light'], ['en', 'dark'], ['zh-CN', 'dark']]) { await installTheme(`Background QA ${mode} regions`, mode, regions); await patch({ language: locale }); await shot(`${locale === 'zh-CN' ? 'zh' : 'en'}-${mode}-960-regions.png`); }
  // Baseline equality is intentionally byte-for-byte. The same static page is used
  // on both sides, with only the custom theme backgrounds removed.
  await installTheme('Background QA baseline', 'dark', undefined); await patch({ language: 'en' }); const editorColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--editor').trim()); const editorRgb = rgba(editorColor); assert.ok(editorRgb, 'terminal opaque renderer: editor token parses'); await assertTerminalViewportColor(`rgb(${editorRgb.join(', ')})`, 'terminal returns to an opaque editor-colour renderer without an image'); const baseline = await page.screenshot({ animations: 'disabled' }); assert.equal(await terminalIdentity.evaluate(node => node.isConnected), true, 'removing backgrounds keeps the terminal instance'); await installTheme('Background QA dark regions', 'dark', regions); await settle(); assert.equal(await terminalIdentity.evaluate(node => node.isConnected), true, 're-enabling backgrounds keeps the terminal instance'); await installTheme('Background QA baseline', 'dark', undefined); await assertTerminalViewportColor(`rgb(${editorRgb.join(', ')})`, 'terminal remains opaque after re-removing images'); const restored = await page.screenshot({ animations: 'disabled' }); await pngEquals(baseline, restored, 'background removal');
  const noBackgroundCpu = await idleCpu30('idleNoBackground30sMs'); await installTheme('Background QA dark regions', 'dark', regions); const backgroundCpu = await idleCpu30('idleBackground30sMs'); await dragFrames(); check(`background removal equals baseline; idle CPU no-image/background ${noBackgroundCpu}/${backgroundCpu} ms; divider p95 ${report.measurements.dividerDragP95Ms ?? 'n/a'} ms`);
  report.passed = true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); }
finally {
  clearTimeout(watchdog); await app?.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`)); if (runtimeProcess?.exitCode === null) runtimeProcess.kill(); runtimeLog?.end(); if (server) await new Promise(done => server.close(done)); await releaseLock?.().catch(error => report.errors.push(`lock cleanup: ${error.message}`)); await qaApp?.cleanup?.().catch(() => {}); await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); step(report.passed && report.errors.length === 0 ? 'APPEARANCE BACKGROUNDS VISUAL QA PASSED' : `APPEARANCE BACKGROUNDS VISUAL QA FAILED ${report.errors.join(' | ')}`); runLog.end(); if (!report.passed || report.errors.length) process.exitCode = 1;
}
