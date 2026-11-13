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
assert.ok(Boolean(process.env.THREADTERM_V3_RUNTIME_BIN) || !/\/runtime\/target\/(debug|release)\/threadterm-v3-runtime\.exe$/i.test(runtime.replaceAll('\\', '/')), 'never launch the user runtime build unless THREADTERM_V3_RUNTIME_BIN explicitly authorizes it');
const scratch = await mkdtemp(join(scratchBase, 'tt-x1c-pane-tabs-'));
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
 Object.assign(value, { TEMP: scratchBase, TMP: scratchBase, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_QA_PROVIDER_BIN: bin, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: baseUrl });
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
    const title = selected.querySelector('.workspace-tab-label'), close = selected.querySelector('.workspace-tab-close'), prefix = strip.querySelector('.workspace-tab-prefix'), add = strip.querySelector('.workspace-tab-add-slot'), actions = strip.querySelector('.workspace-tab-actions');
    const style = getComputedStyle(card), selectedStyle = getComputedStyle(selected), focused = document.activeElement?.closest?.('.workspace-tab');
    const titleStyle = title && getComputedStyle(title), measure = document.createElement('canvas').getContext('2d');
    if (measure && titleStyle) measure.font = titleStyle.font;
    const titleMetrics = title ? { ...rect(title), text: title.textContent?.trim() ?? '', color: titleStyle?.color, scrollWidth: title.scrollWidth, clientWidth: title.clientWidth, overflow:titleStyle?.overflow, textOverflow:titleStyle?.textOverflow } : undefined;
    // Pane content (e.g. a chat's clipped empty state in a short stacked pane) can sit right under the card's top edge.
    const textAt = (x, y) => { const hit = document.elementFromPoint(x, y); if (!hit || hit === card || !card.contains(hit)) return false; const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT); for (let node = walker.nextNode(); node; node = walker.nextNode()) { const range = document.createRange(); range.selectNodeContents(node); if ([...range.getClientRects()].some(box => x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1)) return true; } return false; };
    const footText = [selected.getBoundingClientRect().left - 10, selected.getBoundingClientRect().right + 10].map(x => textAt(x, card.getBoundingClientRect().top + 1));
    const addButton=add?.querySelector('.workspace-tab-add');
    return [{ id: pane.dataset.paneId ?? 'pane', footText, strip: rect(strip), card: rect(card), tabs: {...rect(tabs),scrollWidth:tabs.scrollWidth}, selected: { ...rect(selected), offsetWidth: selected.offsetWidth, radius: selectedStyle.borderTopLeftRadius }, tabMetrics:[...tabs.querySelectorAll('.workspace-tab')].map(tab=>({ ...rect(tab), radius:getComputedStyle(tab).borderTopLeftRadius })), isFirstTab: selected === tabs.querySelector(':scope > .workspace-tab'), title: titleMetrics, close: close ? rect(close) : undefined, prefix: prefix ? rect(prefix) : undefined, add: add ? rect(add) : undefined, addButton: addButton ? rect(addButton) : undefined, actions: actions ? rect(actions) : undefined, expectedSurface: style.backgroundColor, expectedBorder: getComputedStyle(strip).borderBottomColor, stripColor:getComputedStyle(strip).backgroundColor, focusColor:getComputedStyle(selected.querySelector('.workspace-tab-select'),'::after').borderTopColor, cardBorders:[style.borderTopWidth,style.borderRightWidth,style.borderBottomWidth,style.borderLeftWidth].map(value=>parseFloat(value)||0), cardRadii:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius].map(value=>parseFloat(value)||0), focused: focused === selected, overflow: [strip, ...strip.querySelectorAll('*')].filter(visible).map(element => ({ tag: element.tagName, className: String(element.className), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: getComputedStyle(element).overflowY })) }];
   }),
    border: getComputedStyle(document.documentElement).getPropertyValue('--border'),
    panels: [...document.querySelectorAll('.workspace-pane[data-pane-id]:not([hidden]) > .pane-card, .wb-sidebar, .inspector')].filter(visible).filter(panel => !(panel.matches('.inspector') && panel.closest('.wb-sidebar'))).map(panel => ({ className: String(panel.className), surface:getComputedStyle(panel).backgroundColor, ...rect(panel) }))
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
// Use the most common raster colour away from the feet as the strip reference.
function horizontalBorderReference(image, candidates, surface) {
 const samples = candidates.map(([x, y]) => ({ x, y, value: pixel(image, x, y) }));
 assert.ok(samples.length > 0, 'a pane has a strip reference outside its tab feet');
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
 const content=geometry.content;assert.ok(content,'content main bounds are available for flush-edge measurements');
 const panels=geometry.panels.filter(panel=>panel.bottom<=content.bottom+1&&panel.top>=content.top-1);assert.ok(panels.length>0,'visible panels participate in flush-edge measurements');
 const border=rgba(geometry.border),evidence=[];
 for(const panel of panels){
  const lowerStrip=geometry.panes.filter(pane=>pane.strip.top>=panel.bottom-1&&Math.min(panel.right,pane.strip.right)-Math.max(panel.left,pane.strip.left)>8).sort((a,b)=>a.strip.top-b.strip.top)[0];
  const gap=lowerStrip?lowerStrip.strip.top-panel.bottom:content.bottom-panel.bottom,expectedGap=lowerStrip?1:0;
  assert.ok(Math.abs(gap-expectedGap)<=1,`${panel.className}: ${lowerStrip?'flush divider':'content edge'} is ${expectedGap}px ±1 (${gap})`);
  const surface=rgba(panel.surface)?.slice(0,3);assert.ok(surface,`${panel.className}: pane surface is RGB`);
  const x=device(Math.max(panel.left+2,Math.min(panel.right-2,panel.left+panel.width/2)),scale.x,image.width),y=device(Math.max(panel.top+2,panel.bottom-1),scale.y,image.height);
  const edge=pixel(image,x,y);assert.ok(distance(edge,surface)<=4,`${panel.className}: bottom flush edge retains pane surface pixels`);
  if(!lowerStrip&&Math.abs(content.right-panel.right)<=1){const right=pixel(image,device(panel.right-1,scale.x,image.width),device(panel.top+panel.height/2,scale.y,image.height));assert.ok(distance(right,surface)<=4,`${panel.className}: right flush edge retains pane surface pixels`);}
  let divider;
  if(lowerStrip&&border){divider=pixel(image,x,device(panel.bottom+.5,scale.y,image.height));assert.ok(distance(divider,composite(border,surface))<=8,`${panel.className}: internal divider is a one-pixel border`);}
  evidence.push({className:panel.className,gap,edge,divider});
 }
 const filename=`${name}-flush-edges.png`,target=panels[0],left=device(target.left,scale.x,image.width),top=device(Math.max(content.top,target.bottom-4),scale.y,image.height),right=device(target.right,scale.x,image.width),bottom=device(Math.min(content.bottom,target.bottom+4),scale.y,image.height);
 await writeFile(join(pixelEvidenceDir,filename),PNG.sync.write(crop(image,left,top,right-left+1,bottom-top+1)));
 return {panels:evidence,flush:true,crop:`pixel-evidence/${filename}`};
}
async function assertScreenshotPixels(name, screenshot, keyboardFocus = false) {
 const geometry=await panePixelGeometry(),image=PNG.sync.read(screenshot),scale={x:image.width/geometry.viewport.width,y:image.height/geometry.viewport.height};
 await writeFile(join(pixelEvidenceDir,`${name}-geometry.json`),JSON.stringify({geometry,image:{width:image.width,height:image.height},scale},null,2));
 const evidence={screenshot:`${name}.png`,image:{width:image.width,height:image.height},viewport:geometry.viewport,scale,panes:[]};
 for(const pane of geometry.panes){
  assert.ok(Math.abs(pane.strip.height-30)<=1&&Math.abs(pane.selected.height-30)<=1,`30px flush strip/tab for ${pane.id}`);
  assert.ok(pane.tabMetrics.every(tab=>(parseFloat(tab.radius)||0)===0),`square tab corners for ${pane.id}`);
  assert.ok(pane.cardBorders.every(value=>value===0)&&pane.cardRadii.every(value=>value===0),`flat borderless pane for ${pane.id}`);
  if(pane.close)assert.ok(Math.abs(pane.close.width-18)<=1&&Math.abs(pane.close.height-18)<=1&&pane.close.left<pane.selected.left+8,`18px left close for ${pane.id}`);
  if(pane.addButton)assert.ok(Math.abs(pane.addButton.width-28)<=1&&Math.abs(pane.addButton.height-28)<=1,`28px add target for ${pane.id}`);
  const surfaceRaw=rgba(pane.expectedSurface),stripRaw=rgba(pane.stripColor),borderRaw=rgba(pane.expectedBorder);assert.ok(surfaceRaw&&stripRaw&&borderRaw,`resolved RGB surfaces for ${pane.id}`);
  const surfaceTarget=surfaceRaw.slice(0,3),stripTarget=stripRaw.slice(0,3),borderTarget=composite(borderRaw,stripTarget);
  const surface=referencePixel(image,surfaceTarget,candidateGrid(pane.card,scale,image,14,pane.card.top+2,Math.min(pane.card.top+26,pane.card.bottom-2)));
  const seamY=device(pane.card.top+.5,scale.y,image.height),seamSamples=[];
  const start=Math.max(pane.selected.left+4,pane.tabs.left+1),end=Math.min(pane.selected.right-4,pane.tabs.right-1);
  for(let x=start;x<=end;x+=Math.max(1,(end-start)/12)){const px=device(x,scale.x,image.width),value=pixel(image,px,seamY);seamSamples.push({x:px,y:seamY,value,delta:distance(value,surface.value)});}
  assert.ok(seamSamples.length&&seamSamples.every(sample=>sample.delta<=4),`active tab merges into pane without a seam band for ${pane.id}`);
  // Outside the active tab, a flat join may contain only tabbar/surface/hairline paint.
  const outsideSamples=[];
  for(const x of [pane.selected.left-6,pane.selected.right+6])if(x>pane.strip.left+1&&x<pane.strip.right-1){for(const y of [pane.card.top-1,pane.card.top]){const value=pixel(image,device(x,scale.x,image.width),device(y,scale.y,image.height));const allowed=value.every((channel,index)=>channel>=Math.min(surfaceTarget[index],stripTarget[index],borderTarget[index])-4&&channel<=Math.max(surfaceTarget[index],stripTarget[index],borderTarget[index])+4);assert.ok(allowed,`flat join has no third-colour band for ${pane.id}`);outsideSamples.push({x,y,value});}}
  const seams=[];
  for(const [side,x] of [['left',pane.selected.left],['right',pane.selected.right]]){const left=device(Math.max(pane.strip.left,x-8),scale.x,image.width),right=device(Math.min(pane.strip.right-1,x+8),scale.x,image.width),top=device(pane.card.top-8,scale.y,image.height),bottom=device(pane.card.top+7,scale.y,image.height),filename=`${name}-${pane.id}-${side}-join.png`;await writeFile(join(pixelEvidenceDir,filename),PNG.sync.write(crop(image,left,top,Math.max(1,right-left+1),Math.max(1,bottom-top+1))));seams.push({side,crop:`pixel-evidence/${filename}`});}
  const overflowFailures=pane.overflow.filter(item=>item.scrollHeight>item.clientHeight&&!['hidden','clip'].includes(item.overflowY));assert.deepEqual(overflowFailures,[],`no vertical strip overflow for ${pane.id}`);
  const scrollThumbs=thumbRuns(image,pane.strip,scale);assert.deepEqual(scrollThumbs,[],`no vertical strip scrollbar for ${pane.id}`);
  const equalWidth=pane.tabMetrics.length<2||pane.tabs.scrollWidth>pane.tabs.width+1||pane.tabMetrics.every(tab=>Math.abs(tab.width-pane.tabMetrics[0].width)<=1);assert.ok(equalWidth,`equal width tabs for ${pane.id}`);
  const zoom=pane.selected.offsetWidth?pane.selected.width/pane.selected.offsetWidth:1;
  if(pane.title){assert.ok(pane.title.text.length>0&&pane.title.width>0&&pane.selected.width>=72*zoom-1,`visible nonblank active label for ${pane.id}`);if(pane.title.scrollWidth>pane.title.clientWidth+1)assert.equal(pane.title.textOverflow,'ellipsis',`clipped title ellipsizes for ${pane.id}`);}
  const paneEvidence={id:pane.id,seamY,expected:{surface:surfaceTarget,strip:stripTarget,border:borderTarget},references:{surface},seamSamples,outsideSamples,footCrops:seams,verticalOverflow:overflowFailures,scrollThumbs,active:{width:pane.selected.width,equalWidth,title:pane.title}};
  if (keyboardFocus && pane.focused) {
   const primary = composite(rgba(pane.focusColor), surface.value);
   assert.ok(primary, `primary is RGB for focused pane ${pane.id}`);
   const focusPixels = [];
   for (let y = device(pane.selected.top, scale.y, image.height); y <= device(pane.selected.top + 5, scale.y, image.height); y++) for (let x = device(pane.selected.left + 3, scale.x, image.width); x <= device(pane.selected.right - 3, scale.x, image.width); x++) if (distance(pixel(image, x, y), primary) <= 36) focusPixels.push({ x, y });
   const closeStart = device((pane.close?.left ?? pane.selected.right) - 3, scale.x, image.width), closePixels = focusPixels.filter(sample => sample.x >= closeStart && sample.x <= device((pane.close?.right ?? pane.selected.right)+3,scale.x,image.width));
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
 evidence.bottomGaps=await assertPanelBottomGap(name,image,geometry,scale);report.pixelEvidence.push(evidence);await writeFile(join(pixelEvidenceDir,`${name}.json`),JSON.stringify(evidence,null,2));
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
   const activeTitle = selectedContainer.querySelector('.workspace-tab-label');
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
async function openFiles() { const button = page.locator('.ws-top .wb-switcher').getByRole('button', { name: 'Files', exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); }
async function openCompanion(file) { await openFiles(); await page.locator(`.wb-tree [data-path="${file}"]`).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Open beside session', exact: true }).click(); await page.locator('.file-workspace.embedded').waitFor(); }
const focusedPane = () => page.locator('.workspace-pane.selected');
async function workspaceAction(name) { await focusedPane().getByRole('button', { name: 'Workspace actions', exact: true }).click(); await page.getByRole('button', { name, exact: true }).click(); }
async function fillFocusedPane(title) { await focusedPane().getByRole('button', { name: 'Choose session', exact: true }).click(); await page.locator('.switcher-row').filter({ hasText: title }).click(); }
async function afterAcceptance(chat, browser) {
 if (phase !== 'after') return;
 await show(chat.id); await resize(1440,900); await settings('en','light');
 if (await page.locator('.wb-sidebar').count()) await page.locator('.ws-top .wb-switcher [aria-pressed="true"]').click();
 await page.locator('.wb-sidebar').waitFor({state:'detached'});
 const placement=await page.evaluate(()=>{
  const pane=document.querySelector('.workspace-pane.selected'), strip=pane?.querySelector(':scope > .workspace-tabbar.ws-strip'),card=pane?.querySelector(':scope > .pane-card'),switcher=document.querySelector('.ws-top .wb-switcher');
  const switcherButton=switcher?.querySelector('button'); if(!pane||!strip||!card||!switcherButton) return {ok:false,found:{pane:Boolean(pane),strip:Boolean(strip),card:Boolean(card),headerSwitcher:Boolean(switcher),switcherButton:Boolean(switcherButton)}}; const sr=strip.getBoundingClientRect(),cr=card.getBoundingClientRect(),wr=switcherButton.getBoundingClientRect();
  const controls=[...strip.querySelectorAll('button:not(.workspace-tab-select)')].filter(button=>button.offsetParent!==null).map(button=>button.getBoundingClientRect().height);
  return {ok:Math.abs(sr.bottom-cr.top)<=1&&!pane.querySelector('.wb-switcher')&&wr.width>=28&&wr.height>=28&&controls.every(height=>Math.abs(height-28)<=1),controls,seam:sr.bottom-cr.top,switcher:{inHeader:!pane.contains(switcher),width:wr.width,height:wr.height}};
 });
 assert.ok(placement.ok,`strip/card/switcher/control geometry ${JSON.stringify(placement)}`);
 await page.locator('.ws-top .wb-switcher button').last().focus(); /* the header tools come right before the pane strips in Tab order */ for(let step=0;step<8&&await page.evaluate(()=>document.activeElement?.getAttribute('role')!=='tab');step++) await page.keyboard.press('Tab'); const entered=await page.evaluate(()=>({role:document.activeElement?.getAttribute('role'),id:document.activeElement?.id})); assert.equal(entered.role,'tab','Tab enters the pane tab strip');
 await captureAuxiliary('tab-keyboard-focus-en-light',{scenario:'keyboard focus follows selected tab wrapper including close control',keyboardFocus:true});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25)); await captureAuxiliary('chat-125-en-light',{scenario:'single chat at 125% zoom'}); await settings('en','dark'); await captureAuxiliary('chat-125-en-dark',{scenario:'single dark chat at 125% zoom'}); await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)); await settings('en','light');
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

 if (runs('core')) { await resize(1440, 900); await settings('en', 'light'); await show(chat.id); await page.locator('.chat-compose-shell textarea').waitFor(); await openFiles(); await captureMatrix('chat-sidebar-open', 'single chat pane with Files right panel open'); await page.locator('.ws-top .wb-switcher').getByRole('button', { name: 'Files', exact: true }).click(); await captureMatrix('chat-sidebar-closed', 'single chat pane with right panel closed'); await openCompanion('plan.md'); await captureMatrix('chat-companion-split', 'chat plus companion file split'); check('single chat, open/closed right panel, and chat plus companion-file split captured'); await show(task.id); await page.getByRole('button', { name: 'Session details', exact: true }).click(); await page.locator('.inspector').getByRole('button', { name: 'Task map', exact: true }).click(); await page.locator('.task-map').waitFor(); await captureMatrix('task-map-inspector', 'Task map from shared Session details panel'); check('Task map and Session details panel captured'); }
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
