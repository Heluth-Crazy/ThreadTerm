// Visual matrix for the per-pane tab-strip design. `--phase=before` retains the
// checkpoint baseline; the default `after` verifies the delivered per-pane contract.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { PNG } from 'pngjs';
import { attachedNativeBrowserPages } from './lib/native-browser.mjs';

const root = resolve(import.meta.dirname, '..');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must point to the approved tt-qa-temp directory'); })());
const phase = process.argv.find(value => value.startsWith('--phase='))?.slice('--phase='.length) ?? 'after';
assert.ok(['before', 'after'].includes(phase), '--phase must be before or after');
const outSuffix = process.argv.find(value => value.startsWith('--out='))?.slice('--out='.length);
const out = join(root, 'qa/results/pane-tabs', phase, ...(outSuffix ? [outSuffix] : []));
const pixelEvidenceDir = join(out, 'pixel-evidence');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
await mkdir(scratchBase, { recursive: true });
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP must be the approved tt-qa-temp directory');
assert.ok(!/\/runtime\/target\/(debug|release)\/threadterm-v3-runtime\.exe$/i.test(runtime.replaceAll('\\', '/')), 'never launch the user runtime build');
const scratch = await mkdtemp(join(scratchBase, 'tt-pane-tabs-'));
assert.equal(dirname(scratch).toLowerCase(), scratchBase.toLowerCase(), 'scratch stays in tt-qa-temp');
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const pipe = `\\\\.\\pipe\\tt-pane-tabs-${randomUUID()}`, lock = join(scratchBase, 'qa-electron.lock');
const segment = process.argv.find(value => value.startsWith('--segment='))?.slice('--segment='.length) ?? 'all';
const acceptanceOnly = segment === 'acceptance';
const requiredSegments = ['core', 'browser-terminal', 'layout-inspector'];
const report = { passed: false, segmentPassed: false, phase, segment, outSuffix, completedSegments: [], scenarios: [], screenshots: [], auxiliary: [], pixelEvidence: [], checks: [], errors: [], limitations: [] };
function finalizeManifest(prior, current) {
 const covered = current.segment === 'all' ? requiredSegments : [current.segment];
 const completed = new Set(prior?.completedSegments ?? []);
 for (const name of covered) { if (current.segmentPassed) completed.add(name); else completed.delete(name); }
 current.completedSegments = [...completed];
 if (current.segment === 'all') {
  current.screenshots = current.scenarios.map(item => item.filename);
 } else if (prior?.scenarios) {
  const names = new Set(current.screenshots);
  current.scenarios = [...prior.scenarios.filter(item => !names.has(item.filename)), ...current.scenarios];
  current.screenshots = current.scenarios.map(item => item.filename);
  current.checks = [...new Set([...(prior.checks ?? []), ...current.checks])];
  current.limitations = [...new Set([...(prior.limitations ?? []), ...current.limitations])];
 }
 current.passed = current.segmentPassed && current.errors.length === 0 && requiredSegments.every(name => completed.has(name)) && current.screenshots.length === 64 && new Set(current.screenshots).size === 64;
 return current;
}
let app, page, runtimeProcess, qaApp, server, baseUrl, locked = false;
const watchdog = setTimeout(() => { console.error(`PANE TABS ${phase.toUpperCase()} VISUAL QA WATCHDOG EXPIRED`); runtimeProcess?.kill(); void app?.close().finally(() => process.exit(124)); }, 20 * 60_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { if (await probe()) return; if (Date.now() >= end) throw Error(`Timed out: ${label}`); await pause(100); } }
function environment() {
 const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
 Object.assign(value, { TEMP: scratchBase, TMP: scratchBase, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: baseUrl });
 assert.equal(Object.keys(value).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation has one spelling');
 return value;
}
async function settings(language, theme) {
 const snapshot = await request('runtime.snapshot');
 await request('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
 await page.waitForFunction(({ language, theme }) => document.documentElement.lang === (language === 'zh-CN' ? 'zh-CN' : 'en') && document.documentElement.dataset.theme === theme, { language, theme });
}
async function acquireLock() {
 const deadline = Date.now() + 40 * 60_000;
 for (;;) { try { await mkdir(lock); locked = true; return; } catch (error) { if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error; console.log('Waiting for shared Electron QA lock'); await pause(15_000); } }
}
async function startRuntime() {
 runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: 'ignore' });
 await until(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(scratch, 'data', 'runtime.credential'), 'utf8')).trim()); return true; } catch { return false; } finally { peer?.close(); } }, 'isolated runtime control pipe');
}
async function show(sessionId) {
 await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), sessionId);
 await page.locator('.pane-workspace').waitFor();
}
async function resize(width, height) { await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height }); await page.setViewportSize({ width, height }); await pause(150); }
const rgba = value => {
 const match = String(value).match(/rgba?\(([^)]+)/i);
 if (match) {
  const parts = match[1].split(',').map(part => Number(part.trim()));
  return [...parts.slice(0, 3).map(Math.round), parts[3] ?? 1];
 }
 const hex = String(value).trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
 if (!hex) return undefined;
 const expanded = hex.length === 3 ? [...hex].map(part => part + part).join('') : hex;
 return [[0, 2, 4].map(index => Number.parseInt(expanded.slice(index, index + 2), 16)), 1].flat();
};
const composite = (foreground, background) => foreground.slice(0, 3).map((value, index) => Math.round(value * foreground[3] + background[index] * (1 - foreground[3])));
const distance = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
const device = (value, scale, max) => Math.max(0, Math.min(max - 1, Math.round(value * scale)));
const pixel = (image, x, y) => {
 const offset = (y * image.width + x) * 4;
 return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
};
function crop(image, left, top, width, height) {
 const x = Math.max(0, Math.min(image.width - 1, left)), y = Math.max(0, Math.min(image.height - 1, top));
 const result = new PNG({ width: Math.max(1, Math.min(width, image.width - x)), height: Math.max(1, Math.min(height, image.height - y)) });
 for (let row = 0; row < result.height; row++) for (let column = 0; column < result.width; column++) {
  const source = ((y + row) * image.width + x + column) * 4, target = (row * result.width + column) * 4;
  image.data.copy(result.data, target, source, source + 4);
 }
 return result;
}
async function panePixelGeometry() {
 return page.evaluate(() => {
  const rect = element => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }; };
  const visible = element => { const value = element.getBoundingClientRect(); return value.width > 0 && value.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
  return {
   viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
   frame: getComputedStyle(document.querySelector('.pane-workspace') ?? document.body).backgroundColor,
   content: (() => { const element = document.querySelector('.content.main'); return element ? rect(element) : undefined; })(),
   footer: (() => { const element = document.querySelector('.workspace-status-footer'); return element ? { ...rect(element), background: getComputedStyle(element).backgroundColor } : undefined; })(),
   panes: [...document.querySelectorAll('.workspace-pane[data-pane-id]:not([hidden])')].flatMap(pane => {
    const strip = pane.querySelector(':scope > .workspace-tabbar.ws-strip'), card = pane.querySelector(':scope > .pane-card'), tabs = strip?.querySelector('.workspace-tabs'), selected = tabs?.querySelector('.workspace-tab.active');
    if (!strip || !card || !tabs || !selected) return [];
    const title = selected.querySelector('.workspace-tab-select span, .browser-page-tab-title'), close = selected.querySelector('.workspace-tab-close'), prefix = strip.querySelector('.workspace-tab-prefix'), add = strip.querySelector('.workspace-tab-add-slot'), actions = strip.querySelector('.workspace-tab-actions');
    const style = getComputedStyle(card), focused = document.activeElement?.closest?.('.workspace-tab');
    const titleStyle = title && getComputedStyle(title), measure = document.createElement('canvas').getContext('2d');
    if (measure && titleStyle) measure.font = titleStyle.font;
    const titleMetrics = title ? { ...rect(title), text: title.textContent?.trim() ?? '', color: titleStyle?.color, scrollWidth: title.scrollWidth, clientWidth: title.clientWidth, sixCharacterWidth: measure?.measureText((title.textContent?.trim() ?? '').slice(0, 6)).width ?? 0 } : undefined;
    return [{ id: pane.dataset.paneId ?? 'pane', strip: rect(strip), card: rect(card), tabs: rect(tabs), selected: { ...rect(selected), offsetWidth: selected.offsetWidth }, isFirstTab: selected === tabs.querySelector(':scope > .workspace-tab'), title: titleMetrics, close: close ? rect(close) : undefined, prefix: prefix ? rect(prefix) : undefined, add: add ? rect(add) : undefined, actions: actions ? rect(actions) : undefined, expectedSurface: style.backgroundColor, expectedBorder: style.borderTopColor, focused: focused === selected, overflow: [strip, ...strip.querySelectorAll('*')].filter(visible).map(element => ({ tag: element.tagName, className: String(element.className), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: getComputedStyle(element).overflowY })) }];
   }),
   panels: [...document.querySelectorAll('.workspace-pane[data-pane-id]:not([hidden]) > .pane-card, .wb-sidebar, .inspector')].filter(visible).map(panel => ({ className: String(panel.className), ...rect(panel) }))
  };
 });
}
function referencePixel(image, target, candidates) {
 let best;
 for (const [x, y] of candidates) {
  const value = pixel(image, x, y), delta = distance(value, target);
  if (!best || delta < best.delta) best = { x, y, value, delta };
 }
 assert.ok(best && best.delta <= 3, `screenshot reference pixel differs from its computed baseline: ${JSON.stringify(best)}`);
 return best;
}
// A translucent CSS hairline is anti-aliased against the rendered backing
// layer. Use the horizontal top-edge raster as the reference for its matching
// horizontal continuation beside a tab foot. This deliberately does not
// compare a vertical edge's anti-aliasing to the horizontal edge.
function horizontalBorderReference(image, candidates, surface) {
 const samples = candidates.map(([x, y]) => ({ x, y, value: pixel(image, x, y) }));
 assert.ok(samples.length > 0, 'a pane has a horizontal top-border reference outside its tab feet');
 const groups = new Map();
 for (const sample of samples) { const key = sample.value.join(','); const group = groups.get(key) ?? []; group.push(sample); groups.set(key, group); }
 const flat = [...groups.values()].sort((left, right) => right.length - left.length)[0];
 const selected = flat[0];
 return { ...selected, deltaFromSurface: distance(selected.value, surface), candidateCount: samples.length, flatSampleCount: flat.length };
}
function candidateGrid(bounds, scale, image, insetX, startY, endY, stepX = 7) {
 const result = [];
 for (let y = startY; y <= endY; y += 3) for (let x = bounds.left + insetX; x <= bounds.right - insetX; x += stepX) result.push([device(x, scale.x, image.width), device(y, scale.y, image.height)]);
 return result;
}
function thumbRuns(image, box, scale) {
 const left = device(box.right - 8, scale.x, image.width), right = device(box.right - 1, scale.x, image.width);
 const top = device(box.top + 2, scale.y, image.height), bottom = device(box.bottom - 2, scale.y, image.height), runs = [];
 for (let x = left; x <= right; x++) {
  let start;
  for (let y = top; y <= bottom; y++) {
   const value = pixel(image, x, y), beside = pixel(image, Math.max(0, x - 10), y);
   const neutral = Math.max(...value) - Math.min(...value) <= 12;
   const raised = distance(value, beside) >= 16;
   if (neutral && raised) { start ??= y; continue; }
   if (start !== undefined && y - start >= 12 && start > top && y < bottom) runs.push({ x, start, end: y - 1, length: y - start });
   start = undefined;
  }
 }
 return runs;
}
async function assertPanelBottomGap(name, image, geometry, scale) {
 const content = geometry.content;
 assert.ok(content, 'content main bounds are available for panel-bottom measurements');
 const panels = geometry.panels.filter(panel => panel.bottom <= content.bottom + 1 && panel.top >= content.top - 1);
 assert.ok(panels.length > 0, 'visible panels participate in bottom-gap measurements');
 const panelEvidence = [];
 for (const panel of panels) {
  const lowerStrip = geometry.panes.filter(pane => pane.strip.top >= panel.bottom - 1 && Math.min(panel.right, pane.strip.right) - Math.max(panel.left, pane.strip.left) > 8).sort((left, right) => left.strip.top - right.strip.top)[0];
  const gap = lowerStrip ? lowerStrip.strip.top - panel.bottom : content.bottom - panel.bottom;
  assert.ok(Math.abs(gap - 12) <= 1, `${panel.className}: ${lowerStrip ? 'vertical split internal' : 'content bottom'} gap is 12px ±1 (${gap})`);
  panelEvidence.push({ panel, kind: lowerStrip ? 'internal' : 'content-bottom', gap, nextStripTop: lowerStrip?.strip.top });
 }
 const lower = panelEvidence.filter(item => item.kind === 'content-bottom');
 const rightmost = lower.sort((left, right) => right.panel.right - left.panel.right)[0];
 const lowest = panels.filter(panel => !panels.some(other => other !== panel && other.top >= panel.bottom - 1 && Math.min(other.right, panel.right) - Math.max(other.left, panel.left) > 8));
 const rightmostPanel = lowest.sort((left, right) => right.right - left.right)[0] ?? panels[0];
 const bottomPanel = lowest[0] ?? panels[0];
 const frame = {
  corner: { x: device(content.right - 3, scale.x, image.width), y: device(content.bottom - 3, scale.y, image.height), value: pixel(image, device(content.right - 3, scale.x, image.width), device(content.bottom - 3, scale.y, image.height)) },
  bottom: { x: device(bottomPanel.left + bottomPanel.width / 2, scale.x, image.width), y: device(content.bottom - 3, scale.y, image.height) },
  right: { x: device(content.right - 3, scale.x, image.width), y: device(rightmostPanel.top + rightmostPanel.height / 2, scale.y, image.height) }
 };
 frame.bottom.value = pixel(image, frame.bottom.x, frame.bottom.y);
 frame.right.value = pixel(image, frame.right.x, frame.right.y);
 const bottomPixels = lowest.map(panel => {
  const x = device(panel.left + panel.width / 2, scale.x, image.width), startY = device(content.bottom - 1, scale.y, image.height);
  let boundaryY;
  for (let y = startY; y >= device(Math.max(content.top, panel.bottom - 4), scale.y, image.height); y--) if (distance(pixel(image, x, y), frame.bottom.value) > 3) { boundaryY = y; break; }
  assert.notEqual(boundaryY, undefined, `${panel.className}: raster scan finds its bottom edge against the frame`);
  const measuredPixels = startY - boundaryY, expectedPixels = Math.round((content.bottom - panel.bottom) * scale.y);
  assert.ok(Math.abs(measuredPixels - expectedPixels) <= 1 && Math.abs(measuredPixels / scale.y - 12) <= 1, `${panel.className}: screenshot bottom gap is 12px ±1 (${(measuredPixels / scale.y).toFixed(2)} CSS px; ${measuredPixels} raster px)`);
  return { className: panel.className, x, startY, boundaryY, measuredPixels, cssPixels: measuredPixels / scale.y, expectedPixels, frame: frame.bottom.value, boundary: pixel(image, x, boundaryY) };
 });
 let rightPixel;
 if (rightmost) {
  const sideGap = content.right - rightmost.panel.right;
  assert.ok(Math.abs(sideGap - rightmost.gap) <= 1, `rightmost panel side gap (${sideGap}) equals its bottom gap (${rightmost.gap})`);
  assert.ok(Math.abs(sideGap - 12) <= 1, `rightmost panel side gap is 12px ±1 (${sideGap})`);
  const y = device(rightmost.panel.top + rightmost.panel.height / 2, scale.y, image.height), startX = device(content.right - 1, scale.x, image.width);
  let boundaryX;
  for (let x = startX; x >= device(Math.max(content.left, rightmost.panel.right - 4), scale.x, image.width); x--) if (distance(pixel(image, x, y), frame.right.value) > 3) { boundaryX = x; break; }
  assert.notEqual(boundaryX, undefined, `${rightmost.panel.className}: raster scan finds its right edge against the frame`);
  const measuredPixels = startX - boundaryX, expectedPixels = Math.round(sideGap * scale.x);
  assert.ok(Math.abs(measuredPixels - expectedPixels) <= 1 && Math.abs(measuredPixels / scale.x - 12) <= 1, `${rightmost.panel.className}: screenshot right gap is 12px ±1 (${(measuredPixels / scale.x).toFixed(2)} CSS px; ${measuredPixels} raster px)`);
  rightPixel = { className: rightmost.panel.className, y, startX, boundaryX, measuredPixels, cssPixels: measuredPixels / scale.x, expectedPixels, frame: frame.right.value, boundary: pixel(image, boundaryX, y) };
 }
 let cropPath;
 if (name.includes('chat-sidebar-closed-en-light-1440') || name.includes('chat-sidebar-closed-en-dark-1440') || name.includes('four-panes-vertical-split') && name.endsWith('-960')) {
  const target = rightmost?.panel ?? panels[0], filename = `${name}-bottom-gap.png`;
  const left = device(Math.max(content.left, target.left - 4), scale.x, image.width), top = device(Math.max(content.top, target.bottom - 8), scale.y, image.height);
  const right = device(Math.min(content.right, target.right + 16), scale.x, image.width), bottom = device(Math.min(content.bottom, target.bottom + 18), scale.y, image.height);
  await writeFile(join(pixelEvidenceDir, filename), PNG.sync.write(crop(image, left, top, right - left + 1, bottom - top + 1)));
  cropPath = `pixel-evidence/${filename}`;
 }
 return { panels: panelEvidence, frame, bottomPixels, rightmost: rightmost ? { className: rightmost.panel.className, sideGap: content.right - rightmost.panel.right, bottomGap: rightmost.gap } : undefined, rightPixel, crop: cropPath };
}
async function assertScreenshotPixels(name, screenshot, keyboardFocus = false) {
 const geometry = await panePixelGeometry(), image = PNG.sync.read(screenshot), scale = { x: image.width / geometry.viewport.width, y: image.height / geometry.viewport.height };
 await writeFile(join(pixelEvidenceDir, `${name}-geometry.json`), JSON.stringify({ geometry, image: { width: image.width, height: image.height }, scale }, null, 2));
 const evidence = { screenshot: `${name}.png`, image: { width: image.width, height: image.height }, viewport: geometry.viewport, scale, panes: [] };
 for (const pane of geometry.panes) {
  const surfaceRaw = rgba(pane.expectedSurface), borderRaw = rgba(pane.expectedBorder);
  assert.ok(surfaceRaw && borderRaw, `CSS colors are RGB/RGBA for pane ${pane.id}`);
  const surfaceTarget = surfaceRaw.slice(0, 3), borderTarget = composite(borderRaw, surfaceTarget);
  const referenceTop = Math.max(pane.card.top + 2, Math.min(pane.card.top + 7, pane.card.bottom - 6)), referenceBottom = Math.max(referenceTop + 1, Math.min(pane.card.top + 26, pane.card.bottom - 2));
  const surface = referencePixel(image, surfaceTarget, candidateGrid(pane.card, scale, image, 14, referenceTop, referenceBottom));
  const seamY = device(pane.card.top, scale.y, image.height), insideLeft = device(pane.selected.left + 10, scale.x, image.width), insideRight = device(pane.selected.right - 10, scale.x, image.width);
  const horizontalLeft = device(pane.card.left + 8, scale.x, image.width), horizontalRight = device(pane.card.right - 8, scale.x, image.width);
  const referenceXs = [
   ...Array.from({ length: Math.max(0, device(pane.selected.left - 12, scale.x, image.width) - horizontalLeft + 1) }, (_, index) => horizontalLeft + index),
   ...Array.from({ length: Math.max(0, horizontalRight - device(pane.selected.right + 12, scale.x, image.width) + 1) }, (_, index) => device(pane.selected.right + 12, scale.x, image.width) + index)
  ];
  const border = horizontalBorderReference(image, referenceXs.map(x => [x, seamY]), surface.value);
  assert.ok(insideRight - insideLeft >= 16, `selected tab has room for a continuous seam column for pane ${pane.id}`);
  const seamX = device(pane.selected.left + 10, scale.x, image.width), seamValue = pixel(image, seamX, seamY), seamSamples = [{ x: seamX, y: seamY, value: seamValue, delta: distance(seamValue, surface.value) }];
  assert.ok(distance(seamValue, surface.value) <= 3, `selected tab surface continues across the panel border at x=${seamX}, y=${seamY} for ${pane.id}`);
  // Skip the one-pixel card border itself; the eight samples begin in the
  // panel's filled interior after that edge row.
  const panelRows = Array.from({ length: 8 }, (_, offset) => seamY + offset + 2), centerX = Math.round((insideLeft + insideRight) / 2);
  const columnCandidates = Array.from({ length: Math.max(0, insideRight - insideLeft + 1) }, (_, offset) => insideLeft + offset).sort((left, right) => Math.abs(left - centerX) - Math.abs(right - centerX));
  const blankColumn = columnCandidates.map(x => ({ x, seam: pixel(image, x, seamY), samples: panelRows.map(y => { const value = pixel(image, x, y); return { x, y, value, delta: distance(value, surface.value) }; }) })).find(candidate => distance(candidate.seam, surface.value) <= 3 && candidate.samples.every(sample => sample.delta <= 3));
  const panelSurfaceSkip = pane.card.height < 90;
  if (!keyboardFocus && !panelSurfaceSkip) assert.ok(blankColumn, `an empty selected-tab column continues from its seam into the panel for eight pixels for ${pane.id}`);
  if (panelSurfaceSkip) report.limitations.push(`Eight-pixel interior column omitted for ${name} / ${pane.id}: the existing 960px four-pane compact projection leaves less than 90px of card height, so child controls overlap every candidate column. The seam row and outside feet remain pixel-checked.`);
  const outside = [{ side: 'left', x: device(pane.selected.left - 10, scale.x, image.width) }, { side: 'right', x: device(pane.selected.right + 10, scale.x, image.width) }];
  const outsideSamples = outside.map(sample => ({ ...sample, y: seamY, value: pixel(image, sample.x, seamY), delta: distance(pixel(image, sample.x, seamY), border.value) }));
  assert.ok(outsideSamples.every(sample => sample.x >= horizontalLeft && sample.x <= horizontalRight), `both tab feet have horizontal top-border paint room for ${pane.id}: ${JSON.stringify({ outsideSamples, horizontalLeft, horizontalRight })}`);
  assert.ok(outsideSamples.every(sample => sample.delta <= 3), `card border continues outside both tab feet at device row ${seamY} for ${pane.id}: ${JSON.stringify(outsideSamples)}`);
  const seams = [];
  for (const [side, x] of [['left', pane.selected.left - 10], ['right', pane.selected.right - 10]]) {
   const left = device(x, scale.x, image.width), top = device(pane.card.top - 9, scale.y, image.height), filename = `${name}-${pane.id}-${side}-foot.png`;
   const arc = crop(image, left, top, 20, 18), values = [];
   for (let row = 0; row < arc.height; row++) for (let column = 0; column < arc.width; column++) values.push(pixel(arc, column, row));
   const surfacePixels = values.filter(value => distance(value, surface.value) <= 3).length, borderPixels = values.filter(value => distance(value, border.value) <= 3).length;
   assert.ok(surfacePixels > 0 && borderPixels > 0, `${side} foot crop has both surface and border pixels for ${pane.id}`);
   await writeFile(join(pixelEvidenceDir, filename), PNG.sync.write(arc)); seams.push({ side, crop: `pixel-evidence/${filename}`, surfacePixels, borderPixels });
  }
  const joinCropName = name === 'chat-sidebar-closed-en-light-1440' ? 'selected-tab-join-light.png' : name === 'chat-sidebar-closed-en-dark-1440' ? 'selected-tab-join-dark.png' : name === 'chat-custom-theme-en' ? 'selected-tab-join-custom.png' : name === 'chat-125-en-light' ? 'selected-tab-join-125.png' : undefined;
  let joinCrop;
  if (joinCropName && pane === geometry.panes[0]) {
   const left = device(pane.selected.left - 14, scale.x, image.width), top = device(pane.selected.top - 3, scale.y, image.height), right = device(pane.selected.right + 14, scale.x, image.width), bottom = device(pane.card.top + 8, scale.y, image.height);
   await writeFile(join(pixelEvidenceDir, joinCropName), PNG.sync.write(crop(image, left, top, right - left + 1, bottom - top + 1)));
   joinCrop = `pixel-evidence/${joinCropName}`;
  }
  const overflowFailures = pane.overflow.filter(item => item.scrollHeight > item.clientHeight && !['hidden', 'clip'].includes(item.overflowY));
  assert.deepEqual(overflowFailures, [], `strip has no vertical overflow: ${pane.id} ${JSON.stringify(overflowFailures)}`);
  // The old regression was the inherited .ws-strip scrollbar at the strip's
  // outer right edge. The tab viewport's right edge may coincide with an
  // active-tab border or keyboard focus outline, so scanning it creates a
  // false scrollbar positive without improving coverage of that defect.
  const scrollThumbs = thumbRuns(image, pane.strip, scale);
  assert.deepEqual(scrollThumbs, [], `no vertical scrollbar thumb at strip outer edge: ${pane.id} ${JSON.stringify(scrollThumbs)}`);
  const available = pane.strip.width - (pane.prefix?.width ?? 0) - (pane.add?.width ?? 0) - (pane.actions?.width ?? 0) - 8;
  const effectiveZoom = pane.selected.offsetWidth ? pane.selected.width / pane.selected.offsetWidth : 1, minimumWidth = 120 * effectiveZoom;
  if (available >= minimumWidth) {
   assert.ok(pane.selected.width >= minimumWidth - 1, `selected tab remains at its 120 CSS-pixel readable width (${Math.round(minimumWidth)} rendered px) when available (${Math.round(available)}px) in ${pane.id}`);
   if (pane.title) assert.ok(pane.title.width + 1 >= Math.min(pane.title.sixCharacterWidth, pane.title.scrollWidth), `selected tab shows six readable title characters in ${pane.id}: ${JSON.stringify(pane.title)}`);
  }
  const paneEvidence = { id: pane.id, seamY, expected: { surfaceRaw, borderRaw, surface: surfaceTarget, border: borderTarget }, references: { surface, border }, seamSamples, panelSurfaceColumn: blankColumn, panelSurfaceSkip, blankColumnFocusException: keyboardFocus, outsideSamples, footCrops: seams, joinCrop, verticalOverflow: overflowFailures, scrollThumbs, active: { width: pane.selected.width, offsetWidth: pane.selected.offsetWidth, effectiveZoom, minimumWidth, available, title: pane.title } };
  if (keyboardFocus && pane.focused) {
   const primary = rgba(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary')))?.slice(0, 3);
   assert.ok(primary, `primary is RGB for focused pane ${pane.id}`);
   const focusPixels = [];
   for (let y = device(pane.selected.top, scale.y, image.height); y <= device(pane.selected.top + 5, scale.y, image.height); y++) for (let x = device(pane.selected.left + 3, scale.x, image.width); x <= device(pane.selected.right - 3, scale.x, image.width); x++) if (distance(pixel(image, x, y), primary) <= 36) focusPixels.push({ x, y });
   const closeStart = device((pane.close?.left ?? pane.selected.right) - 3, scale.x, image.width), closePixels = focusPixels.filter(sample => sample.x >= closeStart);
   const seamFocusPixels = seamSamples.filter(sample => distance(sample.value, primary) <= 36);
   assert.ok(focusPixels.length >= 6 && closePixels.length >= 1, `keyboard focus ring reaches the tab close region for ${pane.id}`);
   assert.equal(seamFocusPixels.length, 0, `keyboard focus ring does not cross the merged seam for ${pane.id}`);
   const filename = `${name}-${pane.id}-focus.png`;
   await writeFile(join(pixelEvidenceDir, filename), PNG.sync.write(crop(image, device(pane.selected.left - 3, scale.x, image.width), device(pane.selected.top - 3, scale.y, image.height), device(pane.selected.width + 6, scale.x, image.width), device(pane.selected.height + 7, scale.y, image.height))));
   paneEvidence.focus = { crop: `pixel-evidence/${filename}`, primary, focusPixels: focusPixels.length, closePixels: closePixels.length, seamFocusPixels: seamFocusPixels.length };
  }
  if (name.includes('task-map-inspector-zh-dark-960') || name.includes('four-panes-vertical-split') && name.endsWith('-960')) {
   const filename = `${name}-${pane.id}-title.png`, title = pane.title ?? pane.selected;
   await writeFile(join(pixelEvidenceDir, filename), PNG.sync.write(crop(image, device(title.left - 3, scale.x, image.width), device(title.top - 3, scale.y, image.height), device(title.width + 6, scale.x, image.width), device(title.height + 6, scale.y, image.height))));
   const titleColor = pane.title && rgba(pane.title.color)?.slice(0, 3), glyphPixels = titleColor ? (() => { let count = 0; for (let y = device(title.top, scale.y, image.height); y <= device(title.bottom, scale.y, image.height); y++) for (let x = device(title.left, scale.x, image.width); x <= device(title.right, scale.x, image.width); x++) if (distance(pixel(image, x, y), titleColor) <= 48) count++; return count; })() : undefined;
   assert.ok(glyphPixels === undefined || glyphPixels >= 3, `title crop has visible glyph pixels for ${pane.id}`);
   paneEvidence.titleCrop = { path: `pixel-evidence/${filename}`, glyphPixels };
  }
 evidence.panes.push(paneEvidence);
 }
 evidence.bottomGaps = await assertPanelBottomGap(name, image, geometry, scale);
 report.pixelEvidence.push(evidence);
 await writeFile(join(pixelEvidenceDir, `${name}.json`), JSON.stringify(evidence, null, 2));
}
async function capture(name, metadata) {
 if (phase === 'after') await assertPaneTabContract();
 if (!metadata.keyboardFocus) await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
 await page.mouse.move(0, 0); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 const filename = `${name}.png`, screenshot = await page.screenshot({ path: join(out, filename), animations: 'disabled' });
 if (phase === 'after') await assertScreenshotPixels(name, screenshot, Boolean(metadata.keyboardFocus));
 const layout = await page.evaluate(() => ({ panes: document.querySelectorAll('[data-pane-id]').length, splits: document.querySelectorAll('[data-split-id]').length, compact: document.querySelector('.pane-grid')?.className.includes('compact') ?? false }));
 report.screenshots.push(filename); report.scenarios.push({ filename, ...metadata, ...layout });
}
async function captureAuxiliary(name, metadata) {
 if (phase === 'after') await assertPaneTabContract();
 if (!metadata.keyboardFocus) await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
 await page.mouse.move(0, 0); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 const filename=`${name}.png`, screenshot=await page.screenshot({path:join(out,filename),animations:'disabled'}); if (phase === 'after') await assertScreenshotPixels(name,screenshot,Boolean(metadata.keyboardFocus)); report.auxiliary.push({filename,...metadata});
}
async function captureNativePainted(name, metadata) {
 const box=await page.locator('.workspace-pane.selected').boundingBox(), scale=await page.evaluate(()=>devicePixelRatio), native=(await attachedNativeBrowserPages(app,page)).filter(item=>item.url.includes('/second'))[0]; assert.ok(box&&native,`loaded attached native page for ${name}`); const bounds=await app.evaluate(({BrowserWindow,webContents},id)=>{const window=BrowserWindow.getAllWindows().find(item=>item.contentView.children.some(view=>view.webContents?.id===id));return window?.contentView.children.find(view=>view.webContents?.id===id)?.getBounds();},native.id); assert.ok(bounds,`native view bounds for ${name}`);
 const base=PNG.sync.read(await page.screenshot({clip:box,animations:'disabled'})); const encoded=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'),native.id); const image=PNG.sync.read(Buffer.from(encoded,'base64'));
 const left=Math.round((bounds.x-box.x)*scale),top=Math.round((bounds.y-box.y)*scale); for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){const tx=left+x,ty=top+y;if(tx<0||ty<0||tx>=base.width||ty>=base.height)continue;const from=(y*image.width+x)*4,to=(ty*base.width+tx)*4;base.data[to]=image.data[from];base.data[to+1]=image.data[from+1];base.data[to+2]=image.data[from+2];base.data[to+3]=255}
 const filename=`${name}.png`; await writeFile(join(out,filename),PNG.sync.write(base)); report.auxiliary.push({filename,nativePainted:true,...metadata});
}
async function assertPaneTabContract() {
 const result = await page.evaluate(() => {
  const panes = [...document.querySelectorAll('.workspace-pane[data-pane-id]:not([hidden])')];
  const forbidden = document.querySelectorAll('.pane-identity,.wb-tabrow,.workspace-toolbar-host').length;
  const failures = [];
  for (const pane of panes) {
   const strip = pane.querySelector(':scope > .workspace-tabbar.ws-strip');
   const card = pane.querySelector(':scope > .pane-card');
   const lists = pane.querySelectorAll(':scope > .workspace-tabbar.ws-strip > .workspace-tabs[role="tablist"]');
   if (!strip || !card || lists.length !== 1) { failures.push(`${pane.dataset.paneId}: strip/card/tablist`); continue; }
   const selected = lists[0].querySelectorAll('.workspace-tab.active > [role="tab"][aria-selected="true"]');
   if (selected.length !== 1) { failures.push(`${pane.dataset.paneId}: selected=${selected.length}`); continue; }
   const selectedContainer = selected[0].closest('.workspace-tab');
   if (!selectedContainer) { failures.push(`${pane.dataset.paneId}: selected container`); continue; }
   const tabRect = selectedContainer.getBoundingClientRect(), cardRect = card.getBoundingClientRect();
   if (Math.abs(tabRect.bottom-cardRect.top)>1) failures.push(`${pane.dataset.paneId}: tab/card seam ${tabRect.bottom-cardRect.top}`);
   const tabStyle=getComputedStyle(selectedContainer), cardStyle=getComputedStyle(card);
   if (tabStyle.backgroundColor !== cardStyle.backgroundColor) failures.push(`${pane.dataset.paneId}: selected/card background mismatch`);
   const inactive=[...lists[0].querySelectorAll('.workspace-tab:not(.active)')];
   if (inactive.length && inactive.every(tab=>getComputedStyle(tab).color===tabStyle.color && getComputedStyle(tab).backgroundColor===tabStyle.backgroundColor)) failures.push(`${pane.dataset.paneId}: inactive tabs indistinguishable`);
   const activeTitle = selectedContainer.querySelector('.workspace-tab-select span');
   if (panes.length === 1 && !document.querySelector('.inspector') && !selectedContainer.classList.contains('browser-page-tab') && activeTitle && activeTitle.getBoundingClientRect().width < 12) failures.push(`${pane.dataset.paneId}: active title is collapsed`);
   const browserTitles = [...lists[0].querySelectorAll('.browser-page-tab-title')], browserOverflow = lists[0].scrollWidth > lists[0].clientWidth + 1;
   if (innerWidth >= 1200 && browserTitles.length >= 2 && !browserOverflow && browserTitles.some(title => getComputedStyle(title).display === 'none' || title.getBoundingClientRect().width < 12)) failures.push(`${pane.dataset.paneId}: fitting browser titles are collapsed`);
   const add = strip.querySelector('.workspace-tab-add');
   const last = [...lists[0].querySelectorAll('.workspace-tab')].at(-1);
   if (add && last && add.getBoundingClientRect().left - last.getBoundingClientRect().right > 56) failures.push(`${pane.dataset.paneId}: add control detached from tabs`);
  }
  return { paneCount: panes.length, forbidden, failures };
 });
 assert.ok(result.paneCount > 0, 'at least one visible pane');
 assert.equal(result.forbidden, 0, 'legacy global strip hosts are absent');
 assert.deepEqual(result.failures, [], result.failures.join('; '));
}
async function captureMatrix(stem, scenario) {
 for (const [language, theme] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) for (const [width, height] of [[1440, 900], [960, 640]]) {
  await resize(width, height); await settings(language, theme); await capture(`${stem}-${language === 'zh-CN' ? 'zh' : 'en'}-${theme}-${width}`, { scenario, language, theme, viewport: `${width}x${height}` });
 }
 await resize(1440, 900); await settings('en', 'light');
}
async function openFiles() { const button = page.locator('.wb-switcher').getByRole('button', { name: 'Files', exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); }
async function openCompanion(file) { await openFiles(); await page.locator(`.wb-tree [data-path="${file}"]`).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Open beside session', exact: true }).click(); await page.locator('.file-workspace.embedded').waitFor(); }
const focusedPane = () => page.locator('.workspace-pane.selected');
async function workspaceAction(name) { await focusedPane().getByRole('button', { name: 'Workspace actions', exact: true }).click(); await page.getByRole('button', { name, exact: true }).click(); }
async function fillFocusedPane(title) { await focusedPane().getByRole('button', { name: 'Choose session', exact: true }).click(); await page.locator('.switcher-row').filter({ hasText: title }).click(); }
async function afterAcceptance(chat, browser) {
 if (phase !== 'after') return;
 await show(chat.id); await resize(1440,900); await settings('en','light');
 if (await page.locator('.wb-sidebar').count()) await page.locator('.wb-switcher [aria-pressed="true"]').click();
 await page.locator('.wb-sidebar').waitFor({state:'detached'});
 const placement=await page.evaluate(()=>{
  const pane=document.querySelector('.workspace-pane.selected'), strip=pane?.querySelector(':scope > .workspace-tabbar.ws-strip'),card=pane?.querySelector(':scope > .pane-card'),switcher=pane?.querySelector('.wb-switcher');
  const switcherButton=switcher?.querySelector('button'); if(!pane||!strip||!card||!switcherButton) return {ok:false,found:{pane:Boolean(pane),strip:Boolean(strip),card:Boolean(card),switcher:Boolean(switcher),switcherButton:Boolean(switcherButton)}}; const sr=strip.getBoundingClientRect(),cr=card.getBoundingClientRect(),wr=switcherButton.getBoundingClientRect();
  const controls=[...strip.querySelectorAll('button:not(.workspace-tab-select)')].filter(button=>button.offsetParent!==null).map(button=>button.getBoundingClientRect().height);
  return {ok:Math.abs(sr.bottom-cr.top)<=1&&wr.top>=sr.top-1&&wr.bottom<=sr.bottom+1&&controls.every(height=>Math.abs(height-28)<=1),controls,seam:sr.bottom-cr.top,switcher:[wr.top-sr.top,wr.bottom-sr.bottom]};
 });
 assert.ok(placement.ok,`strip/card/switcher/control geometry ${JSON.stringify(placement)}`);
 await page.locator('.workspace-pane.selected .workspace-tab-prefix button').first().focus(); for(let step=0;step<8&&await page.evaluate(()=>document.activeElement?.getAttribute('role')!=='tab');step++) await page.keyboard.press('Tab'); const entered=await page.evaluate(()=>({role:document.activeElement?.getAttribute('role'),id:document.activeElement?.id})); assert.equal(entered.role,'tab','Tab enters the pane tab strip');
 await captureAuxiliary('tab-keyboard-focus-en-light',{scenario:'keyboard focus follows selected tab wrapper including close control',keyboardFocus:true});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25)); await captureAuxiliary('chat-125-en-light',{scenario:'single chat at 125% zoom'}); await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
 const snapshot=await request('runtime.snapshot'); await request('settings.update',{patch:{themeSelection:'custom:qa',customThemes:{qa:{background:'#101820',sidebar:'#0d151c',surface:'#172a36',editor:'#14212e',text:'#f1f7fb',muted:'#a9c0cd',accent:'#40c4ff',border:'#33586a'},qaNoEdge:{background:'#101820',sidebar:'#0d151c',surface:'#172a36',editor:'#14212e',text:'#f1f7fb',muted:'#a9c0cd',accent:'#40c4ff',border:'#172a36'}}},expectedRevision:snapshot.settings.revision,operationId:randomUUID()}); await page.waitForFunction(()=>document.documentElement.dataset.customTheme==='true'); await captureAuxiliary('chat-custom-theme-en',{scenario:'single chat ordinary custom theme'}); const noEdge=await request('runtime.snapshot'); await request('settings.update',{patch:{themeSelection:'custom:qaNoEdge'},expectedRevision:noEdge.settings.revision,operationId:randomUUID()}); await page.waitForFunction(()=>document.documentElement.dataset.customTheme==='true'); await captureAuxiliary('chat-custom-no-edges-en',{scenario:'single chat custom theme with border equal to surface'}); await settings('en','light');
 await show(browser.id); await resize(1440,900);
 if(!await page.locator('.wb-web-preview:visible').count()){const composer=page.locator('.chat-compose-shell textarea:visible');await composer.fill('open preview');await page.locator('.chat-compose-send[type=submit]:visible').click();await page.locator('.wb-web-preview:visible').waitFor({timeout:30_000});}
 const browserPane=page.locator('.workspace-pane', {has:page.locator('.wb-web-preview:visible')}); while(await browserPane.getByRole('tab').count()<12) await browserPane.getByRole('button',{name:'New tab',exact:true}).click();
 const address=browserPane.locator('.wb-web-preview:visible').getByLabel('Address',{exact:true}); await address.fill(`${baseUrl}/second`); await address.press('Enter'); await until(async()=>{const pages=await attachedNativeBrowserPages(app,page);return pages.some(item=>item.url===`${baseUrl}/second`);},'loaded native loopback second page');
 const overflow=await page.evaluate(()=>{const pane=document.querySelector('.workspace-pane.selected'),strip=pane?.querySelector('.workspace-tabs'),row=pane?.querySelector('.workspace-tabbar'),add=pane?.querySelector('.workspace-tab-add'),tabs=strip?.querySelectorAll('.workspace-tab')??[];if(!strip||!row||!add)return {ok:false};const active=strip.querySelector('.workspace-tab.active')?.getBoundingClientRect(),box=strip.getBoundingClientRect(),rowBox=row.getBoundingClientRect(),plus=add.getBoundingClientRect();return {ok:tabs.length>=12&&strip.scrollWidth>strip.clientWidth&&Boolean(active&&active.left>=box.left-1&&active.right<=box.right+1&&plus.left>=rowBox.left&&plus.right<=rowBox.right),count:tabs.length};});
 assert.ok(overflow.ok,`overflow/reveal/add visibility ${JSON.stringify(overflow)}`); await captureAuxiliary('browser-overflow-en-light',{scenario:'twelve browser tabs overflow with active tab revealed and add control visible'});
 await browserPane.locator('[role=tab][aria-selected=true]').focus(); const browserEntered=await page.evaluate(()=>({role:document.activeElement?.getAttribute('role'),id:document.activeElement?.id})); await page.keyboard.press('ArrowLeft'); const moved=await page.evaluate(()=>({role:document.activeElement?.getAttribute('role'),id:document.activeElement?.id})); assert.equal(moved.role,'tab','ArrowLeft keeps multi-tab focus in the strip'); assert.notEqual(moved.id,browserEntered.id,'ArrowLeft moves multi-tab focus'); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem',{name:'Close page',exact:true}).waitFor(); await page.keyboard.press('Escape'); const restored=await page.evaluate(()=>({role:document.activeElement?.getAttribute('role'),id:document.activeElement?.id})); assert.deepEqual(restored,{role:'tab',id:moved.id},'Escape restores focus to the invoked multi-tab item'); await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(()=>document.activeElement?.id),browserEntered.id,'ArrowRight restores the painted browser tab'); await until(async()=>(await attachedNativeBrowserPages(app,page)).some(item=>item.url===`${baseUrl}/second`),'painted tab restored after keyboard check');
 const nativeBounds=await browserPane.locator('.wb-web-preview:visible').evaluate(element=>{const serialize=rect=>rect&&({x:rect.x,y:rect.y,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height});const rect=element.getBoundingClientRect(),host=serialize(element.querySelector('.tt-browser-view')?.getBoundingClientRect()),card=serialize(element.closest('.pane-card')?.getBoundingClientRect()),toolbar=serialize(element.querySelector('.wb-browser-toolbar')?.getBoundingClientRect());return{preview:serialize(rect),host,card,toolbar,insideWindow:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,insideCard:Boolean(host&&card&&host.left>=card.left&&host.right<=card.right&&host.top>=card.top&&host.bottom<=card.bottom),belowToolbar:Boolean(host&&toolbar&&host.top>=toolbar.bottom)};}); const attached=(await attachedNativeBrowserPages(app,page)).find(item=>item.url===`${baseUrl}/second`); const actualBounds=attached&&await app.evaluate(({BrowserWindow},id)=>{const window=BrowserWindow.getAllWindows().find(item=>item.contentView.children.some(view=>view.webContents?.id===id));return window?.contentView.children.find(view=>view.webContents?.id===id)?.getBounds();},attached.id); assert.ok(attached&&actualBounds&&nativeBounds.host&&nativeBounds.insideWindow&&nativeBounds.insideCard&&nativeBounds.belowToolbar&&nativeBounds.preview.width>100&&nativeBounds.preview.height>100,`native browser bounds ${JSON.stringify(nativeBounds)}`); assert.ok(Math.abs(actualBounds.x-nativeBounds.host.x)<=1&&Math.abs(actualBounds.y-nativeBounds.host.y)<=1&&Math.abs(actualBounds.width-nativeBounds.host.width)<=1&&Math.abs(actualBounds.height-nativeBounds.host.height)<=1,`native/Dom browser view bounds ${JSON.stringify({native:actualBounds,dom:nativeBounds.host})}`); await captureNativePainted('browser-native-painted-composite',{scenario:'native-painted browser capture with explicit DOM/card/toolbar bounds',nativeBounds,actualBounds});
 check('after acceptance: strip geometry, keyboard context menu, 125% chat, and twelve-tab overflow captured');
}
const runs = name => segment === 'all' || segment === name;

try {
 assert.ok(existsSync(runtime), `missing QA runtime: ${runtime}`);
 await Promise.all([out, pixelEvidenceDir, bin, plugins, work].map(path => mkdir(path, { recursive: true })));
 await writeFile(join(work, 'plan.md'), '# Pane tabs baseline\n\nA companion file preview.\n');
 await writeFile(join(work, 'notes.ts'), 'export const paneTabs = true;\n');
 cpSync(join(root, 'qa/fixtures/browser-plugins'), join(plugins, 'browser-preview-acp-qa'), { recursive: true });
 await writeFile(join(bin, 'fake-terminal.cjs'), "process.stdout.write('Pane tabs terminal fixture ready\\r\\nSynthetic terminal output for visual baseline\\r\\n');process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));\n");
 await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nif "%~1"=="--help" (echo codex-browser-qa 1.0.0 --no-alt-screen& exit /b 0)\r\necho %*|findstr /C:"resume" >nul && (@"${process.execPath}" "%~dp0fake-terminal.cjs"& exit /b 0)\r\n@"${process.execPath}" "${join(root, 'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
 server = createServer((request_, response) => { const path = new URL(request_.url, 'http://127.0.0.1').pathname; response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><title>${path === '/second' ? 'Second browser page' : 'Pane tabs browser page'}</title><main><h1>${path === '/second' ? 'Second page' : 'Pane tabs QA'}</h1><p>Loopback-only browser baseline.</p></main>`); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`;
 qaApp = await buildQaApp({ outDir: join(scratch, 'app') });
 await acquireLock(); await startRuntime();
 app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
 page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(15_000); page.on('pageerror', error => report.errors.push(error.message));
 await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' });
 await until(async () => (await request('provider.list')).some(provider => provider.id === 'codex' && provider.chat), 'fake Codex discovery');
 for (const name of ['task', 'browser', 'terminal', 'layout', 'inspector']) await mkdir(join(work, name), { recursive: true });
 const project = await request('project.add', { path: work, name: 'Pane tabs QA', operationId: randomUUID() });
 const taskProject = await request('project.add', { path: join(work, 'task'), name: 'Pane tabs task QA', operationId: randomUUID() });
 const browserProject = await request('project.add', { path: join(work, 'browser'), name: 'Pane tabs browser QA', operationId: randomUUID() });
 const terminalProject = await request('project.add', { path: join(work, 'terminal'), name: 'Pane tabs terminal QA', operationId: randomUUID() });
 const layoutProject = await request('project.add', { path: join(work, 'layout'), name: 'Pane tabs layout QA', operationId: randomUUID() });
 const inspectorProject = await request('project.add', { path: join(work, 'inspector'), name: 'Pane tabs inspector QA', operationId: randomUUID() });
 const create = (projectId, cwd, title, mode = 'chat') => request('session.create', { projectId, cwd, provider: 'codex', mode, title, operationId: randomUUID() });
 const chat = await create(project.id, work, 'Pane tabs Chat');
 const task = await create(taskProject.id, join(work, 'task'), 'Pane tabs Task');
 const browser = await create(browserProject.id, join(work, 'browser'), 'Pane tabs Browser');
 const second = await create(layoutProject.id, join(work, 'layout'), 'Pane Two'), third = await create(layoutProject.id, join(work, 'layout'), 'Pane Three'), fourth = await create(layoutProject.id, join(work, 'layout'), 'Pane Four'), layoutChat = await create(layoutProject.id, join(work, 'layout'), 'Pane layout Chat');
 const terminal = await create(terminalProject.id, join(work, 'terminal'), 'Pane tabs Terminal', 'terminal');
 const inspector = await create(inspectorProject.id, join(work, 'inspector'), 'Pane tabs Inspector');

 if (runs('core')) { await resize(1440, 900); await settings('en', 'light'); await show(chat.id); await page.locator('.chat-compose-shell textarea').waitFor(); await openFiles(); await captureMatrix('chat-sidebar-open', 'single chat pane with Files side bar open'); await page.locator('.wb-switcher').getByRole('button', { name: 'Files', exact: true }).click(); await captureMatrix('chat-sidebar-closed', 'single chat pane with side bar closed'); await openCompanion('plan.md'); await captureMatrix('chat-companion-split', 'chat plus companion file split'); check('single chat, open/closed side bar, and chat plus companion-file split captured'); await show(task.id); await page.getByRole('button', { name: 'Session details', exact: true }).click(); await page.locator('.inspector').getByRole('button', { name: 'Task map', exact: true }).click(); await page.locator('.task-map').waitFor(); await captureMatrix('task-map-inspector', 'Task map with inspector open'); check('Task map and inspector captured'); }
 if (runs('browser-terminal')) { await resize(1440, 900); await settings('en', 'light'); await show(browser.id); const composer = page.locator('.chat-compose-shell textarea:visible'); await composer.fill('open preview'); await page.locator('.chat-compose-send[type=submit]:visible').click(); await page.locator('.wb-web-preview:visible').waitFor({ timeout: 30_000 }); await page.getByRole('button', { name: 'New tab', exact: true }).click(); const address = page.locator('.wb-web-preview:visible').getByLabel('Address', { exact: true }); await address.fill(`${baseUrl}/second`); await address.press('Enter'); await until(async () => (await page.locator('.browser-page-tab').count()) === 2, 'second browser page'); report.limitations.push('Canonical browser matrix screenshots are DOM-only; the separate native-painted composite captures active loopback page pixels and records native/DOM bounds.'); await captureMatrix('browser-two-pages', 'browser pane with two loaded pages'); check('browser pane with two browser pages captured'); await show(terminal.id); await page.locator('.xterm').waitFor(); await page.getByText('Pane tabs terminal fixture ready', { exact: true }).waitFor(); await captureMatrix('terminal', 'terminal pane'); check('terminal pane captured without browser/sidebar contamination'); }
 if (runs('layout-inspector')) { console.log('Building four-pane baseline'); await resize(1440, 900); await settings('en', 'light'); await show(second.id); await workspaceAction('Split right'); await fillFocusedPane('Pane Three'); await workspaceAction('Split down'); await fillFocusedPane('Pane Four'); await page.locator('[data-pane-id]').nth(2).click(); await workspaceAction('Split right'); await fillFocusedPane('Pane layout Chat'); await until(async () => (await page.locator('[data-pane-id]').count()) === 4, 'four panes'); await captureMatrix('four-panes-vertical-split', 'four panes including a vertical split'); check('three-to-four pane layout including a vertical split captured'); await show(inspector.id); const details = page.getByRole('button', { name: 'Session details', exact: true }); if ((await details.getAttribute('aria-pressed')) !== 'true') await details.click(); await page.locator('.inspector').waitFor(); await captureMatrix('chat-inspector', 'single chat pane with inspector open'); check('inspector baseline captured'); }
 await afterAcceptance(chat,browser);
 assert.deepEqual(report.errors, [], report.errors.join('\n')); report.segmentPassed = true;
} catch (error) {
 report.errors.push(error?.stack ?? String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
 if (app) await app.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
 if (runtimeProcess && runtimeProcess.exitCode === null) runtimeProcess.kill();
 if (server) await new Promise(resolve => server.close(resolve));
 if (locked) await rm(lock, { recursive: true, force: true }).catch(error => report.errors.push(`Lock cleanup: ${error.message}`));
 await qaApp?.cleanup?.().catch(() => {}); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
 report.segmentPassed = report.errors.length === 0 && report.segmentPassed; await mkdir(out, { recursive: true }); if (acceptanceOnly) { report.passed = report.segmentPassed; await writeFile(join(out, 'acceptance.json'), JSON.stringify(report, null, 2)); } else { const prior = await readFile(join(out, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => undefined); finalizeManifest(prior, report); await writeFile(join(out, 'manifest.json'), JSON.stringify(report, null, 2)); }
 clearTimeout(watchdog);
 console.log(report.segmentPassed ? `PANE TABS ${phase.toUpperCase()} VISUAL QA SEGMENT PASSED (${segment})` : `PANE TABS ${phase.toUpperCase()} VISUAL QA FAILED\n${report.errors.join('\n')}`);
}
if (!report.segmentPassed) process.exit(1);
