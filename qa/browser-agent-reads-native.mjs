// Native leaf acceptance with disposable loopback pages and profile; no providers.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';

const root = resolve(import.meta.dirname, '..'), scratchBase = resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir());
const out = resolve(process.env.THREADTERM_QA_BROWSER_READS_OUT || join(root, 'qa/results/browser-agent-reads-native'));
await mkdir(scratchBase, { recursive: true }); await mkdir(out, { recursive: true }); await mkdir(join(root, 'runtime/target-qa'), { recursive: true });
const scratch = await mkdtemp(join(scratchBase, 'tt-browser-agent-reads-'));
assert.equal(dirname(resolve(scratch)).toLowerCase(), scratchBase.toLowerCase());
const report = { passed: false, checks: [], errors: [], limitations: ['Leaf/native CDP acceptance only; runtime, MCP delivery and sharing UI are covered separately.'], versions: {}, artifacts: [] };
const servers = []; let app;
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
async function serve(render) {
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(render(new URL(request.url, 'http://127.0.0.1'))); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:18px sans-serif;background:#f4f6fb;padding:20px}iframe{width:400px;height:170px}button,input{font:inherit;margin:10px}</style></head><body>${body}</body></html>`;
let mainOrigin;
const foreignOrigin = await serve(() => shell('Foreign frame', `<p>FOREIGN_FRAME_SECRET</p><script>console.error('FOREIGN_CONSOLE_SECRET')</script><iframe title="Nested frame" src="${mainOrigin}/nested"></iframe>`));
mainOrigin = await serve(url => {
  if (url.pathname === '/same') return shell('Same frame', '<p>SAME_FRAME_CONTENT</p><script>console.info("SAME_FRAME_CONSOLE")</script>');
  if (url.pathname === '/nested') return shell('Nested frame', '<p>NESTED_FRAME_SECRET</p><script>console.error("NESTED_CONSOLE_SECRET")</script>');
  return shell('Native read fixture', `<h1>Native read fixture</h1><button id="stable">Stable button</button><label>Password<input id="password" type="password" value="PASSWORD_VALUE_SECRET"></label><label>Text<input value="EDITABLE_VALUE_SECRET"></label><iframe title="Same-origin frame" src="${mainOrigin}/same"></iframe><iframe title="Foreign frame" src="${foreignOrigin}/foreign"></iframe><div id="shadow"></div><canvas width="2000" height="700"></canvas><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),pixels=ctx.createImageData(canvas.width,canvas.height);let seed=1781;for(let i=0;i<pixels.data.length;i+=4){for(let j=0;j<3;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+j]=seed>>>24}pixels.data[i+3]=255}ctx.putImageData(pixels,0,0);console.log('MAIN_LOG');console.debug('MAIN_DEBUG');console.info('MAIN_INFO');console.warn('MAIN_WARNING');console.error('MAIN_ERROR')</script>`);
});

const mainSource = `
const {app,BrowserWindow,WebContentsView,nativeImage}=require('electron');
const {BrowserAgentGrants}=require(${JSON.stringify(join(root, 'desktop/src/browser/agentGrants.ts'))});
const {BrowserAgentSnapshotRefs}=require(${JSON.stringify(join(root, 'desktop/src/browser/agentSnapshot.ts'))});
const {readBrowserAgentTool}=require(${JSON.stringify(join(root, 'desktop/src/browser/agentTools.ts'))});
app.setPath('userData',process.env.THREADTERM_READS_PROFILE);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({width:2200,height:1300,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'persist:browser-agent-reads-qa'}});
 window.contentView.addChildView(view);view.setBounds({x:0,y:0,width:2200,height:1300});
 const wc=view.webContents;await wc.loadURL(process.env.THREADTERM_READS_URL);window.showInactive();
 let nativeCaptures=0;const originalCapture=wc.capturePage.bind(wc);wc.capturePage=(...args)=>{nativeCaptures++;const pending=originalCapture(...args);void pending.then(()=>nativeCaptures--,()=>nativeCaptures--);return pending};
 const grants=new BrowserAgentGrants(),refs=new BrowserAgentSnapshotRefs();
 const registration={tabId:'native-public-tab',sourceTabId:'native-source-tab',attachmentId:'native-attachment',attachmentGeneration:1,runtimeEpoch:'fixture',viewGeneration:1};
 const document={sourceTabId:registration.sourceTabId,viewGeneration:1,documentGeneration:1,navigationEpoch:1,url:wc.getURL(),available:true,loaded:true};
 grants.register(registration);grants.setShare(registration.sourceTabId,'read',{...document,grantEpoch:grants.state(registration.sourceTabId).grantEpoch},document);
 const contexts=new Set();
 globalThis.browserReadsFixture={
  async read(tool,level){const controller=new AbortController();contexts.add(controller);try{return await readBrowserAgentTool(grants,refs,{fence:grants.captureRead(registration.sourceTabId,document),deadline:Date.now()+10000,signal:controller.signal,getTab:()=>({document,contents:wc,canCaptureScreenshot:window.isVisible()&&!window.isMinimized()}),assertAuthorized(){}},tool,level)}finally{contexts.delete(controller)}},
  async replace(){await wc.executeJavaScript("document.querySelector('#stable').outerHTML='<button id=stable>Stable button</button>'")},
  refAvailable(ref){try{refs.resolve(grants.captureRead(registration.sourceTabId,document),ref);return true}catch(error){if(error.code==='browser_stale_ref')return false;throw error}},
  async console(){await wc.executeJavaScript("console.log('LATER_MAIN_LOG');console.debug('LATER_MAIN_DEBUG')")},
  debugState(){return {attached:wc.debugger.isAttached(),messageListeners:wc.debugger.listenerCount('message'),detachListeners:wc.debugger.listenerCount('detach'),pending:contexts.size}},
  attachOther(){wc.debugger.attach('1.3')},detachOther(){wc.debugger.detach()},
  async rawIdentity(){wc.debugger.attach('1.3');try{const {nodes}=await wc.debugger.sendCommand('Accessibility.getFullAXTree',{depth:32});return nodes.filter(n=>n.name?.value==='Stable button').map(n=>({nodeId:n.nodeId,backendId:n.backendDOMNodeId,role:n.role?.value}))}finally{wc.debugger.detach()}},
  imageSize(data){return nativeImage.createFromBuffer(Buffer.from(data,'base64')).getSize()},
  hideWindow(){window.hide()},windowVisible(){return window.isVisible()},
  pendingNativeCaptures(){return nativeCaptures},
  versions:process.versions,
 };
}).catch(error=>{console.error(error);app.exit(2)});
`;

function environment() {
  const excluded = new Set(['path', 'temp', 'tmp', 'home', 'userprofile', 'appdata', 'localappdata', 'codex_home', 'electron_run_as_node']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key.toLowerCase()) && !key.toLowerCase().startsWith('threadterm_')));
  Object.assign(env, { TEMP: scratchBase, TMP: scratchBase, PATH: [join(scratch, 'bin'), dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'), CODEX_HOME: join(scratch, 'home/.codex'), THREADTERM_READS_PROFILE: join(scratch, 'profile'), THREADTERM_READS_URL: mainOrigin });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1);
  return env;
}

try {
  for (const path of ['bin', 'home', 'appdata', 'localappdata', 'profile', 'app']) await mkdir(join(scratch, path), { recursive: true });
  await build({ stdin: { contents: mainSource, resolveDir: root, sourcefile: 'browser-agent-reads-qa.cjs', loader: 'js' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(scratch, 'app/main.cjs'), logLevel: 'error' });
  await writeFile(join(scratch, 'app/package.json'), JSON.stringify({ name: 'browser-agent-reads-native-qa', version: '1', main: 'main.cjs' }));
  app = await electron.launch({ args: [`--user-data-dir=${join(scratch, 'profile')}`, join(scratch, 'app')], cwd: root, env: environment(), timeout: 60_000 });
  const until = Date.now() + 30_000;
  while (!await app.evaluate(() => Boolean(globalThis.browserReadsFixture))) { if (Date.now() >= until) throw Error('Native fixture startup timed out'); await new Promise(done => setTimeout(done, 50)); }
  report.versions = await app.evaluate(() => globalThis.browserReadsFixture.versions);
  const read = (tool, level) => app.evaluate((_electron, [tool, level]) => globalThis.browserReadsFixture.read(tool, level), [tool, level]);
  const state = () => app.evaluate(() => globalThis.browserReadsFixture.debugState());
  const first = await read('browser_snapshot'), second = await read('browser_snapshot');
  const stableRef = value => value.outline.match(/button "Stable button" \[(ref-[^\]]+)\]/)?.[1];
  assert.ok(stableRef(first), 'native AX button has a backend-bound ref');
  report.refIdentities = { first: stableRef(first), second: stableRef(second), rawOne: await app.evaluate(() => globalThis.browserReadsFixture.rawIdentity()), rawTwo: await app.evaluate(() => globalThis.browserReadsFixture.rawIdentity()) };
  assert.equal(stableRef(first), stableRef(second), 'unchanged native node retains its ref across debugger detach/reattach');
  check('Unchanged native backend nodes retain refs across scoped debugger attachment');
  await app.evaluate(() => globalThis.browserReadsFixture.replace());
  const replaced = await read('browser_snapshot'); assert.ok(stableRef(replaced)); assert.notEqual(stableRef(replaced), stableRef(first));
  assert.equal(await app.evaluate((_electron, ref) => globalThis.browserReadsFixture.refAvailable(ref), stableRef(first)), false);
  check('Replacing a native node gives a new ref and prunes the old mapping');
  for (const result of [first, second, replaced]) {
    assert.doesNotMatch(result.outline, /PASSWORD_VALUE_SECRET|EDITABLE_VALUE_SECRET|FOREIGN_FRAME_SECRET|NESTED_FRAME_SECRET|SAME_FRAME_CONTENT/);
    assert.match(result.outline, /Shadow button/); assert.ok(result.omittedFrames >= 2); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
  }
  check('Native AX omits editable/password values and embedded frame contents, including cross-origin ancestors');
  const messages = await read('browser_console_messages');
  report.console = { levels: [...new Set(messages.entries.map(entry => entry.level))], count: messages.entries.length, omitted: messages.omitted, truncated: messages.truncated };
  assert.match(JSON.stringify(messages), /MAIN_LOG|MAIN_INFO|MAIN_ERROR|MAIN_WARNING|MAIN_DEBUG/);
  assert.match(JSON.stringify(messages), /SAME_FRAME_CONSOLE/);
  assert.doesNotMatch(JSON.stringify(messages), /FOREIGN_CONSOLE_SECRET|NESTED_CONSOLE_SECRET/);
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 60 * 1024);
  for (const level of ['debug', 'log', 'info', 'warning', 'error']) { const filtered = await read('browser_console_messages', level); assert.ok(filtered.entries.some(entry => entry.text.includes(`MAIN_${level.toUpperCase()}`))); assert.ok(filtered.entries.every(entry => entry.level === level)); }
  check('Native cached console replay filters debug/log/info/warning/error and excludes foreign or ambiguous contexts');
  const screenshot = await read('browser_screenshot'), dimensions = await app.evaluate((_electron, data) => globalThis.browserReadsFixture.imageSize(data), screenshot.data);
  report.image = { ...dimensions, mimeType: screenshot.mimeType, bytes: Buffer.from(screenshot.data, 'base64').length };
  assert.equal(dimensions.width, screenshot.width); assert.equal(dimensions.height, screenshot.height); assert.ok(Math.max(dimensions.width, dimensions.height) <= 1600); assert.ok(Buffer.from(screenshot.data, 'base64').length <= 512 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(screenshot)) < 900 * 1024);
  assert.match(screenshot.provenance.thumbnail, /^data:image\/jpeg;base64,/);
  const thumbnailData = screenshot.provenance.thumbnail.split(',')[1], thumbnailSize = await app.evaluate((_electron, data) => globalThis.browserReadsFixture.imageSize(data), thumbnailData);
  report.thumbnail = { ...thumbnailSize, bytes: Buffer.from(thumbnailData, 'base64').length };
  assert.ok(Math.max(thumbnailSize.width, thumbnailSize.height) <= 240); assert.ok(report.thumbnail.bytes <= 16 * 1024); assert.notEqual(thumbnailData, screenshot.data);
  await writeFile(join(out, screenshot.mimeType === 'image/png' ? 'native-read.png' : 'native-read.jpg'), Buffer.from(screenshot.data, 'base64')); report.artifacts.push(screenshot.mimeType === 'image/png' ? 'native-read.png' : 'native-read.jpg');
  check('Native screenshot and separately reencoded activity thumbnail meet image bytes and decoded dimension bounds');
  await app.evaluate(() => globalThis.browserReadsFixture.hideWindow()); assert.equal(await app.evaluate(() => globalThis.browserReadsFixture.windowVisible()), false);
  const hiddenSnapshot = await read('browser_snapshot'); assert.ok(stableRef(hiddenSnapshot));
  const hiddenStarted = Date.now();
  await assert.rejects(read('browser_screenshot'), /Browser screenshots are unavailable while the app window is hidden or minimized/);
  report.hiddenScreenshot = { outcome: 'fail-fast-unavailable', elapsedMs: Date.now() - hiddenStarted, nativeCapturesPending: await app.evaluate(() => globalThis.browserReadsFixture.pendingNativeCaptures()) }; assert.equal(report.hiddenScreenshot.nativeCapturesPending, 0); assert.ok(report.hiddenScreenshot.elapsedMs < 2000);
  assert.equal(await app.evaluate(() => globalThis.browserReadsFixture.windowVisible()), false);
  check('Hidden live AX reads succeed; hidden-window screenshots fail fast without starting a native capture or showing the window');
  assert.deepEqual(await state(), { attached: false, messageListeners: 0, detachListeners: 0, pending: 0 });
  await app.evaluate(() => globalThis.browserReadsFixture.attachOther());
  let rejected; try { await read('browser_snapshot'); } catch (error) { rejected = String(error); }
  assert.match(rejected || '', /another debugger/); assert.equal((await state()).attached, true);
  await app.evaluate(() => globalThis.browserReadsFixture.detachOther());
  assert.deepEqual(await state(), { attached: false, messageListeners: 0, detachListeners: 0, pending: 0 });
  check('Owned debugger sessions and listeners drain; unrelated attachments are not detached');
  report.passed = true;
} catch (error) { report.errors.push(error?.stack || String(error)); process.exitCode = 1; }
finally {
  if (app) await app.close().catch(error => report.errors.push(`Close: ${String(error)}`));
  await Promise.all(servers.map(server => new Promise(done => server.close(done))));
  const target = resolve(scratch);
  assert.equal(dirname(target).toLowerCase(), scratchBase.toLowerCase());
  await rm(target, { recursive: true, force: true, maxRetries: 5 }).catch(error => report.errors.push(String(error)));
  report.passed = report.passed && report.errors.length === 0;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (report.errors.length) { report.passed = false; process.exitCode = 1; console.error(report.errors.join('\n')); }
  console.log(report.passed ? 'BROWSER AGENT NATIVE READS PASSED' : 'BROWSER AGENT NATIVE READS FAILED');
}
