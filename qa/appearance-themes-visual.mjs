// Appearance preset visual matrix. Runs only against an isolated runtime and fake providers on Desktop 1.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must be the approved tt-qa-temp directory'); })());
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const out = join(root, 'qa/results/appearance-themes');
const presets = ['threadterm-light', 'threadterm-dark', 'github-light', 'github-dark', 'solarized-light', 'solarized-dark', 'catppuccin-latte', 'catppuccin-mocha', 'rose-pine-dawn', 'rose-pine', 'gruvbox-light', 'gruvbox-dark', 'nord', 'tokyo-night', 'dracula'];
const compactPresets = ['solarized-light', 'catppuccin-mocha', 'tokyo-night', 'dracula'];
const presetEditors = { 'threadterm-light': '#fefdfb', 'threadterm-dark': '#2c2c2a', 'github-light': '#ffffff', 'github-dark': '#151b23', 'solarized-light': '#fdf6e3', 'solarized-dark': '#002b36', 'catppuccin-latte': '#eff1f5', 'catppuccin-mocha': '#1e1e2e', 'rose-pine-dawn': '#fffaf3', 'rose-pine': '#1f1d2e', 'gruvbox-light': '#fbf1c7', 'gruvbox-dark': '#32302f', nord: '#2e3440', 'tokyo-night': '#1f2335', dracula: '#282a36' };
assert.ok(existsSync(runtime), `missing AB2 QA runtime: ${runtime}`);
await mkdir(scratchBase, { recursive: true });
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP must be tt-qa-temp');
assert.ok(!/\/runtime\/target\/(debug|release)\/threadterm-v3-runtime\.exe$/i.test(runtime.replaceAll('\\', '/')), 'never launch the user runtime build');
const scratch = await mkdtemp(join(scratchBase, 'tt-appearance-ab2-'));
assert.equal(dirname(scratch).toLowerCase(), scratchBase.toLowerCase(), 'scratch stays under TEMP');
const bin = join(scratch, 'bin'), plugins = join(scratch, 'plugins'), work = join(scratch, 'work');
const pipe = `\\\\.\\pipe\\tt-appearance-ab2-${randomUUID()}`, lock = join(scratchBase, 'qa-electron.lock');
const report = { passed: false, checks: [], screenshots: [], measurements: [], errors: [], limitations: [] };
let app, page, runtimeProcess, qaApp, server, baseUrl, locked = false;
const pause = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; for (;;) { if (await probe()) return; if (Date.now() >= end) throw Error(`Timed out: ${label}`); await pause(100); } }
function environment() {
 const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_plugin_dirs'].includes(key.toLowerCase())));
 Object.assign(value, { TEMP: scratchBase, TMP: scratchBase, PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: baseUrl });
 assert.equal(Object.keys(value).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation has exactly one spelling');
 return value;
}
async function acquireLock() { const deadline = Date.now() + 40 * 60_000; for (;;) { try { await mkdir(lock); locked = true; return; } catch (error) { if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error; console.log('Waiting for shared Electron QA lock'); await pause(15_000); } } }
async function startRuntime() { runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: 'ignore' }); await until(async () => { let peer; try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(scratch, 'data', 'runtime.credential'), 'utf8')).trim()); return true; } catch { return false; } finally { peer?.close(); } }, 'isolated runtime control pipe'); }
async function resize(width, height) { await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height }); await page.setViewportSize({ width, height }); await pause(160); }
async function show(sessionId) { await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('threadterm:desktop-navigate', { sessionId: id }), sessionId); await page.locator('.pane-workspace').waitFor(); }
async function settings(language, selection) {
 const snapshot = await request('runtime.snapshot');
 await request('settings.update', { patch: { language, theme: selection.endsWith('dark') || ['rose-pine', 'nord', 'tokyo-night', 'dracula'].includes(selection) ? 'dark' : 'light', themeSelection: `preset:${selection}`, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
 await page.waitForFunction(language => document.documentElement.lang === language, language);
 await page.waitForFunction(expected => { const p=document.createElement('i'),q=document.createElement('i');p.style.color=getComputedStyle(document.documentElement).getPropertyValue('--editor').trim();q.style.color=expected;document.body.append(p,q);const result=getComputedStyle(p).color===getComputedStyle(q).color;p.remove();q.remove();return result; }, presetEditors[selection]);
}
async function customEditorTheme(language) {
 const snapshot = await request('runtime.snapshot');
 const custom = { background: '#101820', sidebar: '#0d151c', surface: '#172a36', editor: '#14212e', text: '#f1f7fb', muted: '#a9c0cd', accent: '#40c4ff', border: '#33586a' };
 await request('settings.update', { patch: { language, theme: 'dark', themeSelection: 'custom:appearance-qa', customThemes: { 'appearance-qa': custom }, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
 await page.waitForFunction(language => document.documentElement.lang === language && document.documentElement.dataset.customTheme === 'true', language);
}
async function shot(name, metadata = {}) { await page.mouse.move(0, 0); await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); const file = `${name}.png`; await page.screenshot({ path: join(out, file), animations: 'disabled' }); report.screenshots.push(file); report.measurements.push({ file, ...metadata }); }
async function openFiles() { const button = page.locator('.wb-switcher').getByRole('button', { name: /^(Files|文件)$/, exact: true }); if (await button.getAttribute('aria-pressed') !== 'true') await button.click(); }
async function workspaceAction(name) { const pane = page.locator('.workspace-pane.selected'); await pane.getByRole('button', { name: 'Workspace actions', exact: true }).click(); await page.getByRole('button', { name, exact: true }).click(); }
async function fillFocusedPane(title) { const pane = page.locator('.workspace-pane.selected'); await pane.getByRole('button', { name: 'Choose session', exact: true }).click(); await page.locator('.switcher-row').filter({ hasText: title }).click(); }
async function assertRoles(label) {
 const image = PNG.sync.read(await page.screenshot({ animations: 'disabled' }));
 const roles = await page.evaluate(() => {
  const color = name => { const probe=document.createElement('i');probe.style.color=getComputedStyle(document.documentElement).getPropertyValue(name).trim();document.body.append(probe);const value=getComputedStyle(probe).color.toLowerCase();probe.remove();return value; };
  const rect = node => { const r=node?.getBoundingClientRect();return r&&{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
  const visible=node=>Boolean(node&&node.offsetParent!==null&&!node.closest('[hidden]'));
  const filePane=[...document.querySelectorAll('.workspace-pane')].find(node=>visible(node)&&[...node.querySelectorAll('.file-workspace')].some(visible));
  const terminalPane=[...document.querySelectorAll('.workspace-pane')].find(node=>visible(node)&&[...node.querySelectorAll('.xterm')].some(visible));
  const fileTab=filePane?.querySelector('.workspace-tab.active'),terminalTab=terminalPane?.querySelector('.workspace-tab.active');
  const chat=[...document.querySelectorAll('.workspace-pane')].find(node=>visible(node)&&[...node.querySelectorAll('.chat-compose-shell')].some(visible));
  const terminalPaint=document.querySelector('.xterm-scrollable-element')??document.querySelector('.xterm');
  return {viewport:{width:innerWidth,height:innerHeight},sidebar:color('--sidebar'),panel:color('--surface'),editor:color('--editor'),terminal:terminalPaint&&getComputedStyle(terminalPaint).backgroundColor.toLowerCase(),file:document.querySelector('.tt-editor-shell')&&getComputedStyle(document.querySelector('.tt-editor-shell')).backgroundColor.toLowerCase(),gutter:document.querySelector('.tt-editor-shell .cm-gutters')&&getComputedStyle(document.querySelector('.tt-editor-shell .cm-gutters')).backgroundColor.toLowerCase(),fileTab:fileTab&&getComputedStyle(fileTab).backgroundColor.toLowerCase(),terminalTab:terminalTab&&getComputedStyle(terminalTab).backgroundColor.toLowerCase(),chat:chat?.querySelector('.workspace-tab.active')&&getComputedStyle(chat.querySelector('.workspace-tab.active')).backgroundColor.toLowerCase(),fileTabRect:rect(fileTab),terminalTabRect:rect(terminalTab),fileCardRect:rect(filePane?.querySelector('.pane-card')),terminalCardRect:rect(terminalPane?.querySelector('.pane-card')),fileRect:rect(document.querySelector('.tt-editor-shell')),gutterRect:rect(document.querySelector('.tt-editor-shell .cm-gutters')),terminalRect:rect(terminalPaint)};
 });
 const expected=roles.editor.match(/\d+/g).map(Number),scale={x:image.width/roles.viewport.width,y:image.height/roles.viewport.height};
 report.measurements.push({ label, roles });
 const painted=box=>{if(!box)return false;for(let y=box.top+3;y<box.bottom-3;y+=Math.max(2,Math.floor(box.height/6)))for(let x=box.left+3;x<box.right-3;x+=Math.max(2,Math.floor(box.width/6))){const o=(Math.round(y*scale.y)*image.width+Math.round(x*scale.x))*4;if(Math.max(...expected.map((v,i)=>Math.abs(v-image.data[o+i])))<=4)return true}return false};
 const pixel=(x,y)=>{const o=(Math.round(y*scale.y)*image.width+Math.round(x*scale.x))*4;return [...expected].every((v,i)=>Math.abs(v-image.data[o+i])<=4)};
 const joined=(tab,card)=>Boolean(tab&&card&&[tab.left+12,tab.right-12].every(x=>[card.top-1,card.top,card.top+1,tab.bottom-1].every(y=>pixel(x,y))));
 assert.ok(roles.editor && roles.panel && roles.sidebar, `${label}: resolved role variables are present`);
 assert.equal(roles.fileTab, roles.editor, `${label}: selected file tab uses editor role`);
 assert.equal(roles.terminalTab, roles.editor, `${label}: selected terminal tab uses editor role`);
 assert.equal(roles.chat, roles.panel, `${label}: selected chat tab uses panel role`);
 assert.equal(roles.terminal, roles.editor, `${label}: terminal background uses editor role`);
 assert.equal(roles.file, roles.editor, `${label}: CodeMirror body uses editor role`);
 assert.equal(roles.gutter, roles.editor, `${label}: CodeMirror gutter uses editor role`);
 assert.ok(painted(roles.fileRect)&&painted(roles.gutterRect)&&painted(roles.terminalRect),`${label}: screenshot pixels prove CodeMirror body/gutter and terminal use editor`);
 assert.ok(painted(roles.fileTabRect)&&painted(roles.terminalTabRect),`${label}: screenshot pixels prove selected tabs and feet use editor`);
 assert.ok(joined(roles.fileTabRect,roles.fileCardRect)&&joined(roles.terminalTabRect,roles.terminalCardRect),`${label}: screenshot pixels prove tab feet and covered panel border have no seam`);
}
async function gallery(name) {
 const user = page.getByRole('button', { name: 'Local user', exact: true }); await user.click(); await page.getByRole('button', { name: 'More themes…', exact: true }).click(); await page.locator('.settings-panel').waitFor();
 await page.getByRole('button', { name: 'Appearance', exact: true }).click().catch(() => undefined);
 const cards = page.locator('[class*=theme][class*=card], .theme-gallery button, .theme-preset');
 assert.ok(await cards.count() >= 15, `${name}: Appearance shows all preset cards`);
 if(name==='dark')await page.locator('.theme-gallery-card[aria-pressed="true"]').scrollIntoViewIfNeeded();
 await shot(`gallery-${name}`, { gallery: name, cards: await cards.count() });
 await resize(960,640);await page.locator('.settings-scroll').evaluate(node=>node.scrollTop=0);await shot('gallery-'+name+'-minimum-960');
 await page.getByRole('button',{name:'GitHub Dark',exact:true}).focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--editor').trim()==='#151b23');
 assert.equal(await page.getByRole('button',{name:'GitHub Dark, Current',exact:true}).getAttribute('aria-pressed'),'true','keyboard activation selects a card');
 check(name+': More themes opens Appearance; 15 cards and keyboard selection work at minimum size');
 await page.keyboard.press('Escape');await resize(1440,900);
}
async function liveWindows() {
 const terminalNode=await page.locator('.xterm:visible').elementHandle();
 await page.getByRole('tab',{name:'Appearance chat',exact:true}).click();
 const [floating]=await Promise.all([app.waitForEvent('window',{timeout:20000}),workspaceAction('Open floating window')]);
 floating.setDefaultTimeout(20000);await floating.locator('.floating-shell').waitFor();
 await page.emulateMedia({colorScheme:'light'});await floating.emulateMedia({colorScheme:'light'});
 const snapshot=await request('runtime.snapshot');
 await request('settings.update',{patch:{theme:'system',themeSelection:'system:github'},expectedRevision:snapshot.settings.revision,operationId:randomUUID()});
 const editorIs=(target,color)=>target.waitForFunction(color=>getComputedStyle(document.documentElement).getPropertyValue('--editor').trim()===color,color);
 await editorIs(page,'#ffffff');await editorIs(floating,'#ffffff');
 await page.emulateMedia({colorScheme:'dark'});await floating.emulateMedia({colorScheme:'dark'});
 await editorIs(page,'#151b23');await editorIs(floating,'#151b23');
 await settings('en','dracula');await editorIs(floating,'#282a36');
 assert.ok(await terminalNode.evaluate(node=>node.isConnected&&node===document.querySelector('.xterm')),'live preset/OS changes retain the terminal instance');
 await floating.screenshot({path:join(out,'floating-dracula.png'),animations:'disabled'});report.screenshots.push('floating-dracula.png');
 await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url)?.destroy(),floating.url());check('System family responds to OS events in main and floating windows; preset changes retain the terminal');
}
async function arrangeWorkspace(project,chat,terminal,compact=false) {
 const state=await request('runtime.snapshot'),saved=state.workspaces.find(item=>item.projectId===project.id);
 const leaves=node=>node.kind==='pane'?[node]:[...leaves(node.first),...leaves(node.second)];
 const panes=leaves(saved.layout),has=(node,kind,id)=>node.tabs.some(tab=>tab.kind===kind&&(!id||tab.sessionId===id));
 const chatPane=panes.find(node=>has(node,'session',chat.id)),terminalPane=panes.find(node=>has(node,'session',terminal.id)),filePane=panes.find(node=>has(node,'file')),webPane=panes.find(node=>has(node,'web'));
 assert.ok(chatPane&&terminalPane&&filePane&&webPane,'fixture has four distinct content panes');
 const file=filePane.tabs.find(tab=>tab.kind==='file'),scope={projectId:file.projectId,worktreePath:file.worktreePath,path:file.path};
 const doc=await request('filesystem.read',scope);
 if(!(await request('draft.list',{projectId:file.projectId,worktreePath:file.worktreePath})).some(draft=>draft.path===file.path))await request('draft.put',{...scope,content:doc.content+'// Appearance draft fixture\n',baseFingerprint:doc.fingerprint,expectedRevision:0,operationId:randomUUID()});
 const split=(direction,ratio,first,second)=>({kind:'split',id:randomUUID(),direction,ratio,first,second});
 const layout=split('horizontal',compact?.25:.58,chatPane,split('vertical',compact?1/3:.24,webPane,split('vertical',.5,filePane,terminalPane)));
 await request('workspace.save',{id:saved.id,name:saved.name,projectId:project.id,worktreePath:saved.worktreePath,layout,expectedRevision:saved.revision,operationId:randomUUID()});
 await page.reload();await page.waitForFunction(()=>Boolean(window.threadterm?.request));await page.locator('#boot-splash').waitFor({state:'detached'});await show(chat.id);
 await page.locator('.tt-editor-shell:visible').waitFor();await page.locator('.xterm:visible').waitFor();await page.locator('.wb-web-preview:visible').waitFor();await openFiles();
 const activity=page.locator('.chat-tool-activity:visible');if(await activity.getAttribute('open')===null){await activity.locator(':scope > summary').focus();await page.keyboard.press('Enter');}
 await page.locator('.tool-diff:visible').first().scrollIntoViewIfNeeded();
}
try {
 await Promise.all([out, bin, plugins, work].map(path => mkdir(path, { recursive: true })));
 await writeFile(join(work, 'plan.md'), '# Appearance QA\n\nFile editor role sample.\n');
 await writeFile(join(work, 'sample.ts'), 'export const appearance = "editor role";\n');
 cpSync(join(root, 'qa/fixtures/chat-visual-echo-acp'), join(plugins, 'chat-visual-echo-acp'), { recursive: true });
 cpSync(join(root, 'qa/fixtures/browser-plugins'), join(plugins, 'browser-preview-acp-qa'), { recursive: true });
 await writeFile(join(bin, 'fake-terminal.cjs'), "process.stdout.write('Appearance terminal fixture ready\\r\\n');for(const i of [...Array(8).keys()].map(n=>30+n).concat([...Array(8).keys()].map(n=>90+n)))process.stdout.write('\\x1b['+i+'m ANSI '+i+' \\x1b[0m');process.stdout.write('\\r\\n');process.stdin.resume();\n");
 await writeFile(join(bin, 'codex.cmd'), `@echo off\r\nif "%~1"=="--help" (echo codex-appearance-qa 1.0.0 --no-alt-screen& exit /b 0)\r\necho %*|findstr /C:"resume" >nul && (@"${process.execPath}" "%~dp0fake-terminal.cjs"& exit /b 0)\r\n@"${process.execPath}" "${join(root, 'qa/fixtures/browser-plugins/fake-codex-browser.cjs')}" %*\r\n`);
 server = createServer((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Appearance browser</title><main>Browser chrome QA</main>'); });
 await new Promise(done => server.listen(0, '127.0.0.1', done)); baseUrl = `http://127.0.0.1:${server.address().port}`;
 qaApp = await buildQaApp({ outDir: join(scratch, 'app') }); await acquireLock(); await startRuntime();
 app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
 page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(error.message));
 await page.waitForFunction(() => Boolean(window.threadterm?.request)); await page.locator('#boot-splash').waitFor({ state: 'detached' });
 await until(async () => (await request('provider.list')).some(item => item.id === 'codex' && item.chat), 'fake Codex discovery');
 await until(async () => (await request('plugin.list')).plugins.some(item => item.id === 'chat-visual-echo-acp'), 'chat tool fixture plugin discovery');
 await request('plugin.setEnabled', { pluginId: 'chat-visual-echo-acp', enabled: true, operationId: randomUUID() });
 await until(async () => (await request('provider.list')).some(item => item.id === 'chat-visual-echo' && item.chat), 'chat tool fixture discovery');
 const project = await request('project.add', { path: work, name: 'Appearance QA', operationId: randomUUID() });
 const chat = await request('session.create', { projectId: project.id, cwd: work, provider: 'chat-visual-echo', mode: 'chat', title: 'Appearance chat', operationId: randomUUID() });
 const terminal = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'terminal', title: 'Appearance terminal', operationId: randomUUID() });
 const browser = await request('session.create', { projectId: project.id, cwd: work, provider: 'codex', mode: 'chat', title: 'Appearance browser', operationId: randomUUID() });
 await show(browser.id); await page.locator('.chat-compose-shell textarea').fill('open preview'); await page.locator('.chat-compose-send[type=submit]').click(); await page.locator('.wb-web-preview:visible').waitFor({ timeout: 30_000 });
 await resize(1440, 900); await show(chat.id); await page.locator('.chat-compose-shell textarea:visible').waitFor();
 await page.locator('.chat-compose-shell textarea:visible').fill('Emit the plan, tools and a final answer.'); await page.locator('.chat-compose-send[type=submit]:visible').click();
 await page.locator('.chat-tool-activity').waitFor({ timeout: 30_000 });
 await page.getByText('Chat visual fixture complete.',{exact:true}).waitFor();
 await page.locator('.chat-tool-activity:visible > summary').click();await page.locator('.tool-diff:visible').first().scrollIntoViewIfNeeded();
 await openFiles(); await page.locator('.wb-tree [data-path="sample.ts"]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Open beside session', exact: true }).click(); await page.locator('.tt-editor-shell:visible').waitFor();
 await workspaceAction('Split down'); await fillFocusedPane('Appearance terminal'); await page.locator('.xterm').waitFor(); await page.getByText('Appearance terminal fixture ready', { exact: true }).waitFor();
 await page.getByRole('tab', { name: 'Appearance chat', exact: true }).click(); await page.locator('.tt-editor-shell:visible').waitFor();
 await page.locator('.wb-web-preview:visible').waitFor();
 await page.locator('.tool-diff:visible').first().scrollIntoViewIfNeeded();
 await arrangeWorkspace(project,chat,terminal);
 for (const preset of presets) { await resize(1440, 900); await settings('en', preset); await assertRoles(`${preset} en 1440`); await shot(`workspace-${preset}-en-1440`, { preset, language: 'en', viewport: '1440x900' }); }
 await resize(960,640);await arrangeWorkspace(project,chat,terminal,true);
 for (const preset of compactPresets) { await settings('zh-CN', preset); await assertRoles(`${preset} zh 960`); await shot(`workspace-${preset}-zh-960`, { preset, language: 'zh-CN', viewport: '960x640' }); }
 await resize(1440,900);await arrangeWorkspace(project,chat,terminal);
 await resize(1440, 900); await customEditorTheme('en'); await assertRoles('custom editor-panel join'); await shot('custom-editor-panel-tab-join', { preset: 'custom:appearance-qa', language: 'en', viewport: '1440x900' });
 const joinRect=await page.locator('.workspace-pane:has(.file-workspace:visible) .workspace-tab.active').boundingBox();
 await page.screenshot({path:join(out,'custom-editor-panel-tab-join-crop.png'),clip:{x:Math.floor(joinRect.x-10),y:Math.floor(joinRect.y-2),width:Math.ceil(joinRect.width+20),height:65},animations:'disabled'});report.screenshots.push('custom-editor-panel-tab-join-crop.png');
 await resize(1440, 900); await settings('en', 'github-light'); await gallery('light'); await settings('en', 'dracula'); await gallery('dark');
 await liveWindows();
 check('15 English 1440×900 presets, four Chinese 960×640 presets, role pixels, terminal ANSI output, browser, file and Files sidebar captured');
 assert.deepEqual(report.errors, [], report.errors.join('\n')); report.passed = true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally {
 if (app) await app.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
 if (runtimeProcess?.exitCode === null) runtimeProcess.kill(); if (server) await new Promise(done => server.close(done));
 if (locked) await rm(lock, { recursive: true, force: true }).catch(error => report.errors.push(`Lock cleanup: ${error.message}`));
 await qaApp?.cleanup?.().catch(() => {}); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
 await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
 console.log(report.passed && report.errors.length === 0 ? 'APPEARANCE THEMES VISUAL QA PASSED' : `APPEARANCE THEMES VISUAL QA FAILED\n${report.errors.join('\n')}`);
 if (!report.passed || report.errors.length) process.exitCode = 1;
}
