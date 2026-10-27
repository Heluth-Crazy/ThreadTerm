// Settings → Appearance background-image QA.  This intentionally drives the
// public controls, while using the isolated-profile store only to prove cache
// and pruning effects that a user cannot see.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, cpSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.env.TEMP ?? (() => { throw new Error('TEMP must be tt-qa-temp'); })());
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/appearance-backgrounds-settings');
const scratch = await mkdtemp(join(base, 'tt-bg-settings-d2b-'));
const source = join(scratch, 'settings-background.png');
const exported = join(scratch, 'appearance-backgrounds.json');
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const profile = join(scratch, 'profile'), freshProfile = join(scratch, 'profile-fresh'), backgrounds = join(profile, 'backgrounds'), cache = join(backgrounds, 'Cache');
let activeProfile = profile, activeData = join(scratch, 'data'), pipe = `\\\\.\\pipe\\tt-bg-settings-d2b-${randomUUID()}`;
const report = { passed: false, checks: [], screenshots: [], errors: [], measurements: {} };
let app, page, runtimeProcess, releaseLock, qaApp, runtimeLog;
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const exists = async path => { try { await stat(path); return true; } catch { return false; } };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const wait = async (probe, label, timeout = 30_000) => { const end = Date.now() + timeout; for (;;) { if (await probe()) return; if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`); await new Promise(done => setTimeout(done, 100)); } };

function environment(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_runtime_bin', 'threadterm_v3_pick_background_qa', 'threadterm_v3_export_theme_qa'].includes(key.toLowerCase())));
  Object.assign(env, {
    TEMP: base, TMP: base, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: activeData, THREADTERM_V3_USER_DATA: activeProfile, THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
    THREADTERM_V3_PICK_BACKGROUND_QA: source, THREADTERM_V3_EXPORT_THEME_QA: exported,
  }, overrides);
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'isolated environment has one PATH');
  return env;
}
async function startRuntime() {
  runtimeLog = createWriteStream(join(scratch, 'runtime.log'));
  runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runtimeProcess.stdout.pipe(runtimeLog); runtimeProcess.stderr.pipe(runtimeLog);
  await wait(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(activeData, 'runtime.credential'), 'utf8')).trim()); return true; } catch { return false; } finally { peer?.close(); } }, 'isolated runtime');
}
async function resize(width, height) { await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height }); await page.setViewportSize({ width, height }); await settle(); }
async function shot(name, anchor = bg()) { if(await anchor.count())await anchor.evaluate(node => node.scrollIntoView({ block: 'start' })); await page.mouse.move(0, 0); await settle(); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function shotLower(name) { await bg().locator('.background-library').scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await settle(); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
const bg = () => page.getByTestId('settings-backgrounds');
const region = name => bg().locator(`[data-bg-region="${name}"]`);
async function inputRange(name, value) { await bg().getByTestId(`background-${name}`).evaluate((node, next) => { node.value = String(next); node.dispatchEvent(new Event('input', { bubbles: true })); }, value); await settle(); }
async function releaseRange(name) { await bg().getByTestId(`background-${name}`).evaluate(node => { node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); node.blur(); }); await settle(); }
async function setRange(name, value) { await inputRange(name, value); await releaseRange(name); }
async function openAppearance(language = 'en') {
  if (await bg().count()) await closeSettings(language);
  await page.waitForFunction(language=>document.documentElement.lang===language,language); const user = page.getByRole('button', { name: language === 'zh-CN' ? '本地用户' : 'Local user', exact: true }); await user.click(); await page.getByRole('button', { name: language === 'zh-CN' ? '更多主题…' : 'More themes…', exact: true }).click();
  await page.locator('.settings-panel').waitFor();
  await page.getByRole('tab', { name: language === 'zh-CN' ? '外观' : 'Appearance', exact: true }).click();
  await bg().waitFor();
}
async function closeSettings(language = 'en') { await page.keyboard.press('Escape'); await page.locator('.settings-panel').waitFor({ state: 'detached' }); if (language === 'zh-CN') await page.waitForFunction(() => document.documentElement.lang === 'zh-CN'); }
async function chooseRegion(name) { await region(name).getByTestId(`background-region-${name}`).click(); }
async function selectPreset() { await page.getByRole('button', { name: 'Tokyo Night', exact: true }).click(); await wait(async () => (await request('runtime.snapshot')).settings.themeSelection === 'preset:tokyo-night', 'Tokyo Night preset'); }
async function sourceFixture(colour) { const base64 = await page.evaluate(async paint => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200; const context = canvas.getContext('2d'); context.fillStyle = paint; context.fillRect(0, 0, 320, 200); context.fillStyle = '#fff'; context.fillRect(0, 0, 80, 50); context.fillStyle = '#000'; context.fillRect(240, 150, 80, 50); const blob = await new Promise(done => canvas.toBlob(done, 'image/png')); const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }, colour); await writeFile(source, Buffer.from(base64, 'base64')); }
async function selectImage(colour) { await sourceFixture(colour); await bg().getByTestId('background-choose').click(); await wait(async () => await bg().getAttribute('aria-busy') === 'false', 'image import and settings save'); assert.ok((await request('runtime.snapshot')).settings.themeSelection.startsWith('custom:'), 'picture selects a custom theme'); }
async function dropCurrentSource() { await sourceFixture('#9b4ec4'); await page.evaluate(() => { const input = document.createElement('input'); input.id = 'd2b-native-drop'; input.type = 'file'; input.hidden = true; document.body.append(input); }); await page.locator('#d2b-native-drop').setInputFiles(source); const accepted = await page.evaluate(() => Boolean((window.threadterm).getPathForFile?.(document.querySelector('#d2b-native-drop').files?.[0]))); assert.ok(accepted, 'Electron preserves the native source path for the dropped fixture'); await page.evaluate(() => { const input = document.querySelector('#d2b-native-drop'), transfer = new DataTransfer(); transfer.items.add(input.files[0]); document.querySelector('[data-testid="settings-backgrounds"]').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer })); input.remove(); }); }
async function layerGeometry(name) { return page.locator(`g[data-background-layer="${name}"] image`).evaluate(node => ({ x: node.getAttribute('x'), y: node.getAttribute('y'), width: node.getAttribute('width'), height: node.getAttribute('height'), transform: node.getAttribute('transform') })); }
async function show(sessionId) { await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), sessionId); await page.locator('.pane-workspace').waitFor(); }
async function windowPixels(name) {
 const current=(await request('runtime.snapshot')).settings,layer=current.customThemes[current.themeSelection.slice(7)].backgrounds.window;
 await wait(async()=>{const href=await page.locator('svg.appearance-backgrounds g[data-background-layer="window"] image').getAttribute('href').catch(()=>undefined);return href===`threadterm-bg://image/${layer.image}${layer.blur?`/b${layer.blur}`:''}`;},'painted window variant');
 await page.evaluate(async()=>{const picture=new Image();picture.src=document.querySelector('svg.appearance-backgrounds g[data-background-layer="window"] image').getAttribute('href');await picture.decode();});await settle();
 await page.evaluate(() => { const source = document.querySelector('svg.appearance-backgrounds'), box = source.getBoundingClientRect(), clone = source.cloneNode(true); clone.id = 'd2b-window-pixels'; clone.querySelectorAll('g[data-background-layer]:not([data-background-layer="window"])').forEach(node => node.remove()); Object.assign(clone.style, { position: 'fixed', left: '0', top: '0', width: `${box.width}px`, height: `${box.height}px`, zIndex: '2147483647', pointerEvents: 'none' }); document.body.append(clone); });
 try { await settle(); const full=PNG.sync.read(await page.locator('#d2b-window-pixels').screenshot({ animations: 'disabled' })),region=new PNG({width:full.width-8,height:full.height-8});for(let y=0;y<region.height;y++)full.data.copy(region.data,y*region.width*4,((y+4)*full.width+4)*4,((y+4)*full.width+4+region.width)*4);await writeFile(join(out,name),PNG.sync.write(region));report.screenshots.push(name);return region; } finally { await page.evaluate(() => document.querySelector('#d2b-window-pixels')?.remove()); }
}
async function selectCustom(name) { await page.locator('.theme-pack-main').filter({ hasText: name }).click(); await wait(async () => (await request('runtime.snapshot')).settings.themeSelection === `custom:${name}`, 'custom theme selection'); }
async function deleteCustom(name) { const row = page.locator('.theme-pack-main').filter({ hasText: name }).locator('..'); await row.getByRole('button', { name: 'Delete', exact: true }).click(); await row.getByRole('button', { name: 'Confirm delete', exact: true }).click(); await wait(async () => !(await request('runtime.snapshot')).settings.customThemes[name], 'custom theme deletion'); }

try {
  await mkdir(out, { recursive: true });
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(plugins, { recursive: true }), mkdir(work, { recursive: true })]);
  cpSync(join(root, 'qa/fixtures/chat-visual-echo-acp'), join(plugins, 'chat-visual-echo-acp'), { recursive: true });
  await writeFile(join(bin, 'fake-terminal.cjs'), "process.stdout.write('Background settings terminal ready\\r\\n');process.stdin.resume();\n");
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nif "%~1"=="--help" (echo codex-background-qa --no-alt-screen& exit /b 0)\r\necho %*|findstr /C:"resume" >nul && (@"${process.execPath}" "%~dp0fake-terminal.cjs"& exit /b 0)\r\n@"${process.execPath}" "${join(root, 'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
  // A tiny opaque PNG, accepted by D1 and deliberately asymmetric so focus and scale move visible pixels.
  await writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAg0lEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNi9HvhvADQwGg0Go9FgMBoNBqPRYDAajUaDwWg0GI1Gg8FoNBiMRoPBaDQYjUaDwWg0GI1Gg8FoNBiMRoPBaDQYjUaDwWg0GI1Gg8FoNBiMRoPBaDQYjUaDwWg0GI1Gg8FoNBiMRoPBaDQYjUaDwWg0GI1Gg8FoNBiMRoPBaDQYjUaDwWg0GIzGAY4AAe9rpxAAAAAASUVORK5CYII=', 'base64'));
  assert.ok(await exists(runtime), `missing QA runtime: ${runtime}`);
  qaApp = await buildQaApp({ root, outDir: join(scratch, 'app') });
  releaseLock = await acquireElectronQaLock({ directory: base, timeoutMs: 40 * 60_000 });
  await startRuntime();
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => typeof navigator.locks?.request), 'function', 'Electron exposes Web Locks for serialized background mutations');
  let boot = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: boot.settings.revision, operationId: randomUUID() });
  await wait(async () => (await request('provider.list')).some(item => item.id === 'codex' && item.chat), 'fake Codex app-server discovery');
  await wait(async () => (await request('plugin.list')).plugins.some(item => item.id === 'chat-visual-echo-acp'), 'fake chat plugin discovery'); await request('plugin.setEnabled', { pluginId: 'chat-visual-echo-acp', enabled: true, operationId: randomUUID() }); await wait(async () => (await request('provider.list')).some(item => item.id === 'chat-visual-echo' && item.chat), 'fake chat provider discovery');
  const project = await request('project.add', { path: work, name: 'Background settings QA', operationId: randomUUID() }); const chat = await request('session.create', { projectId: project.id, cwd: work, provider: 'chat-visual-echo', mode: 'chat', title: 'Background settings chat', operationId: randomUUID() }); const terminal = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'terminal', title: 'Background settings terminal', operationId: randomUUID() }); await show(chat.id); await page.locator('.chat-compose-shell').waitFor();
  await page.locator('.workspace-pane.selected').getByRole('button', { name: 'Workspace actions', exact: true }).click(); await page.getByRole('button', { name: 'Split right', exact: true }).click(); await page.locator('.workspace-pane.selected').getByRole('button', { name: 'Choose session', exact: true }).click(); await page.locator('.switcher-row').filter({ hasText: 'Background settings terminal' }).click(); await page.locator('.xterm:visible').waitFor(); await page.locator('.chat-compose-shell:visible').waitFor();
  await resize(1440, 900); await openAppearance(); await selectPreset(); await chooseRegion('window'); await selectImage('#c42f4d');
  for (const selector of ['[data-testid="background-choose"]','[data-testid="background-fit-fill"]','[data-testid="background-focus-center"]']) { const metrics = await bg().locator(selector).evaluate(node => { const style = getComputedStyle(node); return { height: Math.round(node.getBoundingClientRect().height), radius: Math.round(parseFloat(style.borderRadius)) }; }); assert.deepEqual(metrics, { height: 32, radius: 6 }, `${selector} follows the shared compact control geometry`); }
  const sliderMetrics = await bg().getByTestId('background-opacity').evaluate(node => { const style = getComputedStyle(node), label = getComputedStyle(document.querySelector(`label[for="${node.id}"]`)); return { height: node.getBoundingClientRect().height, radius: style.borderRadius, top: label.marginTop, bottom: label.marginBottom }; }); assert.deepEqual(sliderMetrics, { height: 32, radius: '6px', top: '0px', bottom: '0px' });
  await bg().getByTestId('background-custom-copy-notice').waitFor();
  await shot('created-custom-copy-notice.png');
  let state = await request('runtime.snapshot'); const custom = state.settings.themeSelection.slice('custom:'.length);
  assert.match(custom, /^Tokyo Night \(custom\)/, 'picture creates a named preset copy'); assert.ok(state.settings.customThemes[custom]?.backgrounds?.window, 'copy owns window background');
  check('a window picture creates and selects Tokyo Night (custom)');

  await chooseRegion('chat'); await selectImage('#2477a8'); await chooseRegion('terminal'); await selectImage('#3a9860'); await chooseRegion('editor'); await bg().getByTestId('background-inherit').click(); await wait(async () => (await request('runtime.snapshot')).settings.customThemes[custom]?.backgrounds?.editor?.image === 'inherit', 'Editor inherit setting'); state = await request('runtime.snapshot'); const layers = state.settings.customThemes[custom].backgrounds;
  await chooseRegion('browser'); assert.match(await bg().innerText(), /Covers the browser toolbar and blank pages/, 'browser limitation is stated in English');
  const libraryBeforeDrop = (await readdir(backgrounds)).filter(file => file.endsWith('.webp')).length; await dropCurrentSource(); await wait(async () => (await readdir(backgrounds)).filter(file => file.endsWith('.webp')).length === libraryBeforeDrop + 1 && await bg().getAttribute('aria-busy') === 'false', 'native image drop import'); state = await request('runtime.snapshot'); const dropped = state.settings.customThemes[custom].backgrounds.browser.image; await bg().getByTestId(`background-library-image-${layers.chat.image}`).click(); await wait(async () => (await request('runtime.snapshot')).settings.customThemes[custom]?.backgrounds?.browser?.image === layers.chat.image, 'library image selection'); await bg().getByTestId(`background-library-image-${dropped}`).locator('..').getByRole('button', { name: /Remove from library/ }).click(); await wait(async () => !(await exists(join(backgrounds, `${dropped}.webp`))), 'unused library picture removal'); check('a native file drop imports a picture and an unused library picture can be removed');
  assert.equal(layers.editor.image, 'inherit'); assert.ok(layers.chat.image && layers.terminal.image, 'chat and terminal have own images');
  check('Chat and Terminal use own pictures; Editor inherits the window picture');

  await chooseRegion('editor'); const beforePatch = (await request('runtime.snapshot')).settings.revision; await setRange('overlay', 0); const floor = bg().getByTestId('background-floor-note'); await floor.waitFor();
  const overlay = await bg().getByTestId('background-overlay').inputValue(); assert.ok(Number(overlay) > 0, 'floor clamps an unsafe overlay'); assert.match(await floor.innerText(), /Raised to|已提高至/, 'floor attempt states that readability raised the overlay');
  await wait(async () => (await request('runtime.snapshot')).settings.revision === beforePatch + 1, 'one overlay release patch'); await shot('readability-floor-note.png');
  check('the overlay slider clamps at the readability floor and announces the raised value');

  await chooseRegion('window'); const beforePreview = (await request('runtime.snapshot')).settings.revision; await inputRange('opacity', 80); assert.equal((await request('runtime.snapshot')).settings.revision, beforePreview, 'input preview makes no settings patch'); await wait(async () => await page.locator('g[data-background-layer="window"] image').getAttribute('opacity') === '0.8', 'live window opacity'); await releaseRange('opacity'); await wait(async () => (await request('runtime.snapshot')).settings.revision === beforePreview + 1, 'single opacity release patch'); check('slider input previews the live picture and release writes exactly one patch');
  await inputRange('blur', 12); assert.equal((await readdir(cache).catch(() => [])).length, 0, 'blur input does not bake intermediate variants'); await releaseRange('blur'); await wait(async () => (await readdir(cache).catch(() => [])).length === 1, 'single baked blur cache');
  assert.equal((await readdir(cache)).filter(file => /-b12\.webp$/.test(file)).length, 1); await setRange('blur', 12); assert.equal((await readdir(cache)).filter(file => /-b12\.webp$/.test(file)).length, 1);
  check('blur 12 produces exactly one cached WebP variant');

  const before = await layerGeometry('window'); await bg().getByTestId('background-fit-fit').click(); await bg().getByTestId('background-focus-center').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); await setRange('scale', 175); await wait(async () => { const layer = (await request('runtime.snapshot')).settings.customThemes[custom]?.backgrounds?.window; return layer?.fit === 'contain' && layer?.focusX === 100 && layer?.focusY === 100 && layer?.scale === 175; }, 'fit/focus/scale settings'); assert.equal(await bg().getByTestId('background-scale').inputValue(), '175', 'scale control retains the released value'); await settle(); const after = await layerGeometry('window');
  assert.notDeepEqual(after, before, 'fit/focus/scale changes SVG placement geometry'); check('Fit, focus and scale change rendered background geometry');
  await shot('backgrounds-en-dark-1440.png');
  await closeSettings(); await shot('main-window-with-backgrounds.png'); await openAppearance();

  await bg().getByTestId('background-remove').click(); await wait(async () => !(await exists(join(backgrounds, `${layers.window.image}.webp`))), 'pruned removed image');
  check('removing the selected picture prunes its unreferenced stored file');

  await selectPreset(); await selectImage('#e7aa3d'); state = await request('runtime.snapshot'); const disposable = state.settings.themeSelection.slice(7), disposableImage = state.settings.customThemes[disposable].backgrounds.window.image; await deleteCustom(disposable); await wait(async () => !(await exists(join(backgrounds, `${disposableImage}.webp`))), 'theme deletion prunes its picture'); await selectCustom(custom); check('deleting a custom theme prunes only its unreferenced picture');

  const missingImage = 'f'.repeat(64); state = await request('runtime.snapshot'); await request('settings.update', { patch: { customThemes: { ...state.settings.customThemes, 'Missing picture QA': { ...state.settings.customThemes[custom], backgrounds: { window: { ...layers.window, image: missingImage } } } } }, expectedRevision: state.settings.revision, operationId: randomUUID() }); await page.getByRole('button', { name: 'Export theme', exact: true }).click(); await page.getByTestId('background-import-result').waitFor(); assert.match(await page.getByTestId('background-import-result').innerText(), new RegExp(`Skipped missing pictures: ${missingImage}`)); await shot('export-skipped-picture.png', page.getByTestId('background-import-result')); await deleteCustom('Missing picture QA'); await rm(exported); check('theme export identifies each skipped missing picture');

  // Recreate one image, export through the Settings action, then relaunch on a profile which has never seen it.
  await selectImage('#c42f4d'); await setRange('blur',12); await wait(async()=>await bg().getAttribute('aria-busy')==='false'&&(await request('runtime.snapshot')).settings.customThemes[custom].backgrounds.window.blur===12,'exported blurred background'); const exportedPixels = await windowPixels('export-window-pixels.png'); await page.getByRole('button', { name: 'Export theme', exact: true }).click(); await wait(() => exists(exported), 'exported v2 theme pack');
  const pack = await readFile(exported, 'utf8'); assert.match(pack, /threadtermThemePack/, 'export carries the image pack marker');
  await app.close(); app = undefined; if (runtimeProcess?.exitCode === null) runtimeProcess.kill(); runtimeProcess = undefined;
  activeProfile = freshProfile; activeData = join(scratch, 'data-fresh'); pipe = `\\\\.\\pipe\\tt-bg-settings-d2b-fresh-${randomUUID()}`;
  await startRuntime(); app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' }); await resize(1440, 900); await openAppearance();
  await page.getByRole('button', { name: 'Import theme', exact: true }).click(); const dialog = page.locator('.settings-theme-import'); await dialog.waitFor(); await dialog.locator('textarea').fill(pack); await dialog.getByRole('button', { name: 'Validate & import', exact: true }).click();
  await wait(async () => Object.keys((await request('runtime.snapshot')).settings.customThemes ?? {}).length > 0, 'fresh-profile theme import'); assert.ok((await readdir(join(freshProfile, 'backgrounds'))).some(file => file.endsWith('.webp')), 'fresh profile stored the imported picture'); await page.getByTestId('background-import-result').waitFor(); assert.match(await page.getByTestId('background-import-result').innerText(), /stored 3 pictures, rejected or missing 0/); await shot('fresh-profile-import-result.png', page.getByTestId('background-import-result'));
  const importedName = Object.keys((await request('runtime.snapshot')).settings.customThemes)[0]; await selectCustom(importedName); await closeSettings(); const importedPixels=await windowPixels('import-window-pixels.png'); assert.equal(importedPixels.width,exportedPixels.width);assert.equal(importedPixels.height,exportedPixels.height);let maximum=0,changed=0;for(let i=0;i<importedPixels.data.length;i+=4){let difference=0;for(let c=0;c<3;c++)difference=Math.max(difference,Math.abs(importedPixels.data[i+c]-exportedPixels.data[i+c]));maximum=Math.max(maximum,difference);if(difference)changed++;}report.measurements.packPixels={inset:4,maximum,changed,total:importedPixels.width*importedPixels.height};assert.equal(maximum,0,'fresh-profile window-region pixels match exactly (excluding the outer 4 px clip edge)'); await shot('fresh-profile-main-backgrounds.png'); await openAppearance(); check('export then import restores the background theme and picture into a fresh profile with matching region pixels');

  await page.getByRole('button', { name: 'Import theme', exact: true }).click(); await dialog.locator('textarea').fill('{"threadtermThemePack":2,"themes":{}}'); await dialog.getByRole('button', { name: 'Validate & import', exact: true }).click(); await dialog.getByRole('alert').waitFor(); assert.match(await dialog.getByRole('alert').innerText(), /no themes to import/); assert.doesNotMatch(await dialog.getByRole('alert').innerText(), /theme_pack_|background_image_/, 'invalid pack error is translated'); await shot('invalid-pack-en.png', dialog);
  check('an invalid pack shows a translated error instead of an internal error code');
  await page.keyboard.press('Escape');

  for (const [language, tone] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) {
    state = await request('runtime.snapshot'); await request('settings.update', { patch: { language, theme: tone, themeSelection: `preset:threadterm-${tone}` }, expectedRevision: state.settings.revision, operationId: randomUUID() });
    await openAppearance(language); if (language === 'zh-CN') { await chooseRegion('browser'); assert.match(await bg().innerText(), /覆盖浏览器工具栏和空白页面/, 'browser limitation is stated in Chinese'); } await chooseRegion('window'); await selectImage('#c42f4d'); await shot(`settings-backgrounds-${language}-${tone}-1440-top.png`); await shotLower(`settings-backgrounds-${language}-${tone}-1440-lower.png`); await resize(960, 640);
    const box = await page.locator('.settings-scroll').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })); assert.ok(box.scrollWidth <= box.clientWidth + 1, `${language} ${tone}: no horizontal settings overflow`); await shot(`settings-backgrounds-${language}-${tone}-960-top.png`); await shotLower(`settings-backgrounds-${language}-${tone}-960-lower.png`); if (language === 'zh-CN' && tone === 'dark') { await page.getByRole('button', { name: '导入主题', exact: true }).click(); await dialog.locator('textarea').fill('{"threadtermThemePack":2,"themes":{}}'); await dialog.getByRole('button', { name: '验证并导入', exact: true }).click(); await dialog.getByRole('alert').waitFor(); assert.match(await dialog.getByRole('alert').innerText(), /没有可导入的主题/); await shot('invalid-pack-zh.png', dialog); await page.keyboard.press('Escape'); } await closeSettings(language); await resize(1440, 900);
  }
  check('English and Chinese light/dark settings captures cover 1440 and 960×640 without horizontal scroll');
  report.passed = true;
} catch (error) {
  if(page){report.measurements.failureSettings=await request('runtime.snapshot').then(state=>state.settings).catch(()=>undefined);report.measurements.failureControls=await bg().evaluate(node=>({text:node.innerText,sliders:[...node.querySelectorAll('input')].map(input=>({id:input.dataset.testid,value:input.value,disabled:input.disabled}))})).catch(()=>undefined);}
  report.errors.push(error?.stack ?? String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
  if (runtimeProcess?.exitCode === null) runtimeProcess.kill(); runtimeLog?.end();
  await writeFile(join(out, 'runtime.log'), await readFile(join(scratch, 'runtime.log')).catch(() => '')).catch(() => {});
  await releaseLock?.().catch(error => report.errors.push(`Lock cleanup: ${error.message}`)); await qaApp?.cleanup?.().catch(() => {});
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(report.passed && report.errors.length === 0 ? 'APPEARANCE BACKGROUNDS SETTINGS VISUAL QA PASSED' : `APPEARANCE BACKGROUNDS SETTINGS VISUAL QA FAILED\n${report.errors.join('\n')}`);
  if (!report.passed || report.errors.length) process.exitCode = 1;
}
