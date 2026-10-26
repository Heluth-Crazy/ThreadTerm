// Real-app QA for external Chat files.  This is deliberately a single-run harness:
// its own app bundle/profile/runtime and fake provider PATH never touch a developer's
// running app.  Run after X1b product work is merged:
//   node qa/external-files-visual.mjs [--keep]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratchBase = resolve(process.env.TEMP ?? (() => { throw Error('TEMP must point to tt-qa-temp'); })());
assert.match(scratchBase.replaceAll('\\', '/').toLowerCase(), /\/tt-qa-temp$/, 'TEMP is the approved QA scratch root');
assert.ok(existsSync(runtime), `missing ${runtime}; rebuild target-qa first`);
const scratch = await mkdtemp(join(scratchBase, 'tt-external-files-'));
const project = join(scratch, 'project');
const outside = join(scratch, 'outside');
const bin = join(scratch, 'bin');
const out = join(root, 'qa/results/external-files');
const appDir = join(scratch, 'qa-app');
const keep = process.argv.includes('--keep');
const report = { passed: false, scratch, checks: [], screenshots: [], limitations: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
let app, page, releaseLock, cleanupApp;

const sourceV1 = ['export const outsideValue = 1;', 'export function total(a: number, b: number) {', '  return a + b;', '}', ''].join('\n');
const sourceV2 = sourceV1.replace('return a + b;', 'return a + b + 1;');
const outsideHtml = '<!doctype html><h1>Safe external HTML</h1><script>window.__externalScriptRan=true;parent.postMessage("external-script", "*")</script><img src="http://127.0.0.1:9/forbidden.png"><a href="http://127.0.0.1:9/forbidden.html">blocked link</a>';
const fakeGrok = `
import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const uri=value=>'file:///'+String(value??'').split(String.fromCharCode(92)).join('/');
const outside=uri(process.env.TT_QA_OUTSIDE_PATH);
const missing=uri(process.env.TT_QA_MISSING_PATH);
if(process.argv.includes('--version')){console.log('grok 0.0.0-qa');process.exit(0)}
let next=0;
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 const reply=result=>send({jsonrpc:'2.0',id:request.id,result});
 if(request.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},load:{}}}});
 else if(request.method==='session/new')reply({sessionId:'external-qa-'+(++next)});
 else if(request.method==='session/list')reply({sessions:[]});
 else if(request.method==='session/prompt'){
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{text:'[outside agent file]('+outside+') [missing agent file]('+missing+')'}}}});
  reply({stopReason:'end_turn'});
 } else reply({});
});`;
const fakeCodex = 'process.stdin.resume(); setInterval(() => {}, 1_000);';
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, sum]); };
const visiblePng = () => { const width = 96, height = 64, raw = Buffer.alloc((width * 3 + 1) * height); for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; raw[at] = 62 + x; raw[at + 1] = 104 + y; raw[at + 2] = 220; } } const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]); };

async function prepare() {
  await Promise.all([mkdir(project, { recursive: true }), mkdir(outside, { recursive: true }), mkdir(bin, { recursive: true })]);
  await writeFile(join(project, 'inside.ts'), 'export const insideWorkspace = true;\n');
  await writeFile(join(outside, 'outside.ts'), sourceV1);
  await writeFile(join(outside, 'outside.md'), '# Outside markdown\n\nRead-only preview.\n');
  await writeFile(join(outside, 'outside.png'), visiblePng());
  await writeFile(join(outside, 'outside.html'), outsideHtml);
  await writeFile(join(outside, 'large.ts'), `${'x'.repeat(1_048_577)}\n`);
  await writeFile(join(outside, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
  await writeFile(join(bin, 'fake-grok.mjs'), fakeGrok);
  await writeFile(join(bin, 'fake-codex.mjs'), fakeCodex);
  await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(bin, 'fake-codex.mjs')}" %*\r\n`);
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let s=std::process::Command::new(std::env::var_os("TT_QA_NODE").unwrap()).arg(std::env::var_os("TT_QA_SCRIPT").unwrap()).args(std::env::args_os().skip(1)).status().unwrap();std::process::exit(s.code().unwrap_or(1));}');
  const { spawnSync } = await import('node:child_process');
  const fakeGrokCheck = spawnSync(process.execPath, ['--check', join(bin, 'fake-grok.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(fakeGrokCheck.status, 0, fakeGrokCheck.stderr);
  const compiled = spawnSync('rustc', ['-O', join(bin, 'shim.rs'), '-o', join(bin, 'grok.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  ({ cleanup: cleanupApp } = await buildQaApp({ root, outDir: appDir }));
}

function environment(pickerPaths) {
  // Remove every spelling: Windows accepts all of them, which could otherwise find a real agent CLI.
  const dropped = /^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    TEMP: scratchBase, TMP: scratchBase, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-external-files-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(bin, 'fake-grok.mjs'),
    TT_QA_OUTSIDE_PATH: join(outside, 'outside.ts'), TT_QA_MISSING_PATH: join(outside, 'missing.ts'),
    THREADTERM_V3_OPEN_EXTERNAL_QA: JSON.stringify(pickerPaths),
  });
  assert.deepEqual(Object.keys(env).filter(name => name.toLowerCase() === 'path'), ['Path'], 'PATH isolation has exactly one spelling');
  return env;
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function launchRead(sessionId) {
  try { return { ok: true, value: await request('session.launch.read', { sessionId }) }; }
  catch (error) { return { ok: false, error: /session_launch_unavailable/.test(String(error)) ? 'session_launch_unavailable' : String(error) }; }
}
async function until(test, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await test(); if (value) return value; } catch { /* state is still changing */ } if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(150); }
}
const visible = selector => page.locator(`.pane-tab-surface:not([hidden]) ${selector}`);
const text = async selector => (await page.locator(selector).allInnerTexts()).join('\n');
const shot = async name => {
  await until(() => page.evaluate(() => { const splash = document.getElementById('boot-splash'); return !splash || getComputedStyle(splash).opacity === '0'; }), 'boot splash clears before screenshot', 12_000);
  await page.screenshot({ path: join(out, name) }); report.screenshots.push(name);
};
async function setAppearance(language, theme, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language, theme, themeSelection: theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  // A restart can have the app shell mounted while the boot-splash exit animation still
  // covers it; matrix captures must wait for the overlay to be removed.
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 12_000 }).catch(() => {});
  await delay(350);
}
async function openWithPicker() {
  await page.keyboard.press('Control+O');
  await until(() => page.locator('[role=tab]').filter({ hasText: 'outside.ts' }).count(), 'external picker opens its tabs');
}
async function activateTab(name) {
  const tab = page.getByRole('tab', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
  await tab.click();
  return tab;
}
async function restart(env) {
  await app.close();
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor({ timeout: 60_000 });
}

try {
  await mkdir(out, { recursive: true });
  await prepare();
  const pickerPaths = [join(outside, 'outside.ts'), join(outside, 'outside.md'), join(project, 'inside.ts'), join(outside, 'outside.png'), join(outside, 'outside.html'), join(outside, 'large.ts'), join(outside, 'binary.bin')];
  const env = environment(pickerPaths);
  releaseLock = await acquireElectronQaLock({ directory: scratchBase });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000);
  const loopbackRequests = [];
  page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
  page.on('request', requestEvent => { if (requestEvent.url().startsWith('http://127.0.0.1:9/')) loopbackRequests.push(requestEvent.url()); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor({ timeout: 60_000 });
  await setAppearance('en', 'light', 1440);
  const added = await request('project.add', { path: project, name: 'External QA', operationId: randomUUID() });
  // Only deferred Codex terminal launches have a durable `session.launch.read` row. Keep it
  // separate from the Chat receiver, then prove both immutable records survive all file work.
  const launchSession = await request('session.create', { projectId: added.id, cwd: project, provider: 'codex', mode: 'terminal', title: 'Launch invariant', deferLaunch: true, operationId: randomUUID() });
  const session = await request('session.create', { projectId: added.id, cwd: project, provider: 'grok', mode: 'chat', title: 'External files agent', operationId: randomUUID() });
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const composer = () => page.locator(`[data-testid="session-chat-${session.id}"] .chat-compose-shell textarea`);
  await until(() => composer().isVisible(), 'Chat composer');
  const configBefore = await request('session.config.read', { sessionId: session.id });
  const chatLaunchBefore = await launchRead(session.id);
  const launchConfigBefore = await request('session.config.read', { sessionId: launchSession.id });
  const launchBefore = await until(async () => {
    const value = await request('session.launch.read', { sessionId: launchSession.id });
    return value.phase === 'preparing' || value.phase === 'launching' ? undefined : value;
  }, 'deferred launch settles before baseline', 60_000);

  // Picker bridge verifies native-dialog plumbing while its QA-only list includes an in-project redirect.
  await openWithPicker();
  await until(() => page.getByRole('tab').filter({ hasText: 'inside.ts' }).count(), 'workspace redirect tab');
  assert.equal(await page.getByRole('tab').filter({ hasText: 'outside.ts' }).count(), 1, 'one external TypeScript tab');
  assert.equal(await page.getByRole('tab').filter({ hasText: 'outside.md' }).count(), 1, 'one external markdown tab');
  const markerDescriptions = await page.locator('[role=tab][aria-describedby]').evaluateAll(tabs => tabs.map(tab => ({
    label: tab.textContent ?? '', description: tab.getAttribute('aria-describedby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ') ?? '',
  })));
  assert.ok(markerDescriptions.some(item => /outside\.ts/i.test(item.label) && /Outside workspace.*Read-only/i.test(item.description)), 'external tab marker exposes its read-only boundary');
  await activateTab('outside.ts');
  const cardText = await text('.pane-tab-surface:not([hidden])');
  assert.equal(await visible('[data-testid="external-file-boundary"] .path').getAttribute('title'), join(outside, 'outside.ts'), 'visible external card keeps the full absolute path in its tooltip');
  assert.match(cardText, /Outside workspace|Read-only/i, 'visible external card labels the permission boundary');
  // The Files header and Command Palette must use the same native-dialog helper and
  // re-open existing IDs without duplicating their tabs.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'files' } })));
  const filesOpen = page.getByRole('button', { name: /Open file outside workspace|打开工作区外的文件/ }); await filesOpen.waitFor(); await filesOpen.click();
  await until(() => page.getByRole('tab').filter({ hasText: 'outside.ts' }).count().then(count => count === 1), 'Files-header picker reuses external tab');
  await page.getByRole('button', { name: /Command palette|命令面板/ }).click();
  const paletteOpen = page.getByRole('dialog').filter({ hasText: /Open file outside workspace|打开工作区外的文件/ }); await paletteOpen.getByText(/Open file outside workspace|打开工作区外的文件/).click();
  await until(() => page.getByRole('tab').filter({ hasText: 'outside.ts' }).count().then(count => count === 1), 'Command Palette picker reuses external tab');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'quick-open' } })));
  const eventQuickOpen = page.locator('.wb-quick-open'); await eventQuickOpen.waitFor();
  const eventPath = join(outside, 'state-changed.md'); await writeFile(eventPath, '# State changed\n'); await request('filesystem.external.open', { path: eventPath, source: 'dialog', sessionId: session.id });
  await until(() => eventQuickOpen.getByText('state-changed.md').count(), 'visible Quick Open refreshes external recents from state.changed'); await page.keyboard.press('Escape');
  check('Files header, Command Palette and visible Quick Open state.changed all use the shared external-file flow');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'toggle' } })));
  await activateTab('outside.ts');
  const editor = visible('.cm-content').first(); await editor.waitFor();
  const beforeTyping = await editor.innerText(); await editor.click(); await editor.pressSequentially('SHOULD_NOT_WRITE');
  assert.equal(await editor.innerText(), beforeTyping, 'typing cannot modify external CodeMirror content');
  assert.equal(await visible('button').filter({ hasText: /^Save$/ }).count(), 0, 'external card has no Save action');
  await shot('initial-en-light-1440-external-ts.png');
  check('picker: outside files create read-only marked tabs, while the picked project file uses the normal workspace flow');

  // Disk mutation must only be observed after an explicit reload; it never creates a draft.
  await writeFile(join(outside, 'outside.ts'), sourceV2);
  const reload = visible('button').filter({ hasText: /Reload/i }).first(); await reload.click();
  await until(async () => (await text('.pane-tab-surface:not([hidden])')).includes('a + b + 1'), 'external reload content');
  assert.equal(await request('draft.list', { projectId: added.id }).then(rows => rows.filter(row => String(row.path ?? '').includes('outside.ts')).length), 0, 'reload did not create an external draft');
  check('external text is read-only, reloads from disk on demand, and creates no draft');

  await activateTab('outside.md'); await until(async () => (await text('.pane-tab-surface:not([hidden])')).includes('Read-only preview.'), 'external markdown preview');
  await activateTab('outside.png'); await until(() => visible('img').count(), 'external image preview');
  const imageContexts = await page.getByTestId('context-chip').count();
  await visible('button[aria-label="Send to agent"]').first().click();
  await until(() => page.getByTestId('context-chip').count().then(count => count === imageContexts + 1), 'external image toolbar send');
  assert.ok((await page.getByTestId('context-chip').evaluateAll(chips => chips.map(chip => chip.getAttribute('aria-label') ?? ''))).some(label => label.includes(join(outside, 'outside.png'))), 'image toolbar creates an absolute external file chip');
  await activateTab('outside.html'); await visible('button').filter({ hasText: /^Preview$/ }).click();
  const htmlFrame = visible('iframe[title="Outside workspace HTML preview"]'); await htmlFrame.waitFor();
  assert.equal(await htmlFrame.getAttribute('sandbox'), '', 'external HTML iframe has an empty sandbox');
  await visible('iframe[title="Outside workspace HTML preview"]').contentFrame().getByRole('heading', { name: 'Safe external HTML' }).waitFor();
  assert.equal(await visible('iframe[title="Outside workspace HTML preview"]').contentFrame().locator('script').count(), 0, 'external HTML script was removed before preview');
  assert.equal(await visible('iframe[title="Outside workspace HTML preview"]').contentFrame().locator('img').getAttribute('src'), null, 'external HTML remote image URL was removed before preview');
  assert.deepEqual(loopbackRequests, [], 'external HTML preview did not request the loopback fixture resource');
  await activateTab('large.ts'); await until(async () => /1 MiB|too large|exceeds/i.test(await text('.pane-tab-surface:not([hidden])')), 'large-file error card');
  await activateTab('binary.bin'); await until(async () => /binary|UTF-8|supported/i.test(await text('.pane-tab-surface:not([hidden])')), 'binary-file error card');
  check('external image and static sandboxed HTML use previews; oversized and binary text get readable in-card errors');

  // The renderer-owned comment/send controls vary by final UI placement.  These role-based assertions deliberately
  // exercise the production controls without depending on a private CSS implementation.
  await activateTab('outside.ts');
  const commentButton = visible('button').filter({ hasText: /^(Comment|评论)$/ }).first();
  assert.equal(await commentButton.count(), 1, 'external editor exposes the required Comment action');
  {
    await visible('.cm-line').filter({ hasText: 'return a + b + 1' }).first().click();
    await until(async () => !(await commentButton.isDisabled()), 'external Comment action enables for selected line'); await commentButton.click();
    const form = visible('.wb-review-comment-form'); await form.locator('textarea').fill('External QA comment'); await form.getByRole('button', { name: /Add comment|添加评论/ }).click();
    await until(async () => /External QA comment/.test(await text('.wb-review-comments')), 'external pending comment');
    assert.ok((await text('.wb-review-comments')).replaceAll('/', '\\').includes(join(outside, 'outside.ts')), 'pending comment retains the absolute external path');
    await page.locator('.wb-review-comments').getByRole('button', { name: /Add to message|添加到消息/ }).click();
    await until(async () => (await composer().inputValue()).includes('External QA comment'), 'comment inserted into composer');
    const commentMessage = await composer().inputValue();
    assert.ok(commentMessage.replaceAll('/', '\\').includes(join(outside, 'outside.ts')), 'comment message keeps the absolute external reference');
    assert.match(commentMessage, /:3\b/, 'comment message preserves the selected line');
    assert.match(commentMessage, /return a \+ b \+ 1/, 'comment message preserves the selected excerpt');
    check('external line comment keeps its absolute path and enters the existing pending-comment/message flow');

    // Leave a second comment pending so restart proves its absolute-path draft survives.
    await visible('.cm-line').filter({ hasText: 'export const outsideValue' }).first().click();
    await until(async () => !(await commentButton.isDisabled()), 'second external Comment action enables'); await commentButton.click();
    const persistentForm = visible('.wb-review-comment-form'); await persistentForm.locator('textarea').fill('External persistent comment'); await persistentForm.getByRole('button', { name: /Add comment|添加评论/ }).click();
    await until(async () => /External persistent comment/.test(await text('.wb-review-comments')), 'pending external comment before restart');
  }

  // Mod-L is the real CodeEditor selection route.  The ContextTray preview exposes the
  // serialized file and quote items, including the absolute path and selected text.
  await activateTab('outside.ts');
  const selectionContexts = await page.getByTestId('context-chip').count();
  const firstLine = visible('.cm-line').filter({ hasText: 'export const outsideValue' }).first(); await firstLine.click(); await page.keyboard.press('Home');
  for (let index = 0; index < 'export const '.length; index++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift'); for (let index = 0; index < 'outsideValue'.length; index++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.keyboard.press('Control+L');
  await until(() => page.getByTestId('context-chip').count().then(count => count === selectionContexts + 2), 'external partial selection adds file and quote context');
  const contextTitles = await page.getByTestId('context-chip').evaluateAll(chips => chips.map(chip => chip.getAttribute('aria-label') ?? ''));
  assert.ok(contextTitles.some(title => title.includes(join(outside, 'outside.ts'))), 'selection file chip contains the absolute external path');
  await page.getByTestId('context-chip').filter({ hasText: /Quote|引用/ }).first().click();
  await until(async () => /```text\s*outsideValue\s*```/.test(await text('[data-testid="context-preview"]')), 'exact partial external selection quote preview');
  await page.getByRole('dialog', { name: /Context preview|上下文预览/ }).getByRole('button', { name: /Close|关闭/ }).click();
  const sendFile = visible('button[aria-label="Send to agent"]').first(); await sendFile.click();
  const wholeFileTitle = `File: ${join(outside, 'outside.ts')}`;
  await until(async () => {
    const more = page.locator('.context-tray .context-more:visible').first();
    if (await more.count()) { await more.click(); return true; }
    const whole = page.getByRole('button', { name: wholeFileTitle, exact: true }).first();
    if (await whole.isVisible()) { await whole.click(); return true; }
    return false;
  }, 'whole-file context exposes a preview');
  await until(async () => (await page.getByTestId('context-preview').allInnerTexts()).some(block => block.split('\n')[0].replace(/^\[ThreadTerm context \d+\/\d+\] /, '').trimEnd() === wholeFileTitle), 'toolbar creates a distinct whole-file context with the absolute path and no line range');
  await page.getByRole('dialog', { name: /Context preview|上下文预览/ }).getByRole('button', { name: /Close|关闭/ }).click();
  check('external selection sends absolute file range plus quote text; toolbar sends the whole file as a context chip');

  // The fake ACP provider emits two real markdown file links on a genuine Chat turn.  One
  // is a registered outside path; the other proves the link route retains a clear error.
  await composer().fill('Give the external QA links.'); await composer().press('Control+Enter');
  const agentLink = page.locator('.file-reference-link').filter({ hasText: 'outside agent file' });
  await agentLink.waitFor({ timeout: 30_000 }); await agentLink.click();
  await until(async () => (await visible('[data-testid="external-file-boundary"]').count()) === 1, 'agent outside-file link opens external card');
  const missingLink = page.locator('.file-reference-link').filter({ hasText: 'missing agent file' }); await missingLink.click();
  await until(async () => /no longer exists|missing/i.test(await text('.workspace-file-error, .runtime-overlay, [role="alert"]')), 'missing agent file link error');
  check('a fake-agent outside-path link opens the external view; its missing-file link reports a clear error');

  // Quick Open must fetch recents on open/event only.  Verify missing state and forget through the user UI.
  await page.keyboard.press('Control+P');
  const quickOpen = page.locator('.wb-quick-open');
  await until(() => quickOpen.getByText(/Outside workspace|工作区外/).count(), 'Quick Open external section');
  const recentTypeScript = quickOpen.locator('.external-file-open-row').filter({ hasText: 'outside.ts' }).first();
  await recentTypeScript.click(); await until(() => visible('[data-testid="external-file-boundary"]').count(), 'Quick Open recent reopens external file');
  await quickOpen.waitFor({ state: 'hidden' });
  await rm(join(outside, 'outside.md'));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'quick-open' } })));
  await quickOpen.waitFor();
  await until(async () => /Missing|缺失/.test(await quickOpen.innerText()), 'missing recent label');
  const missingMarkdown = quickOpen.locator('.external-file-recent.external-file-missing').filter({ hasText: 'outside.md' });
  const forget = missingMarkdown.getByRole('button', { name: /Remove|Forget|移除|删除|×/ });
  if (await forget.count()) { await forget.click(); check('Quick Open marks a missing recent and can forget its registry entry'); }
  else report.limitations.push('Quick Open forget action needs an accessible button label for this harness.');
  await page.keyboard.press('Escape').catch(() => {});

  const configAfter = await request('session.config.read', { sessionId: session.id });
  const chatLaunchAfter = await launchRead(session.id);
  const launchConfigAfter = await request('session.config.read', { sessionId: launchSession.id });
  const launchAfter = await request('session.launch.read', { sessionId: launchSession.id });
  assert.deepEqual(configAfter, configBefore, 'opening/commenting/sending does not mutate session config');
  assert.deepEqual(chatLaunchAfter, chatLaunchBefore, 'opening/commenting/sending does not mutate the Chat launch state or its unavailable-state contract');
  assert.deepEqual(launchConfigAfter, launchConfigBefore, 'opening/commenting/sending does not mutate the saved launch config');
  assert.deepEqual(launchAfter, launchBefore, 'opening/commenting/sending does not mutate session launch');
  check('Chat config and the real deferred-launch config/launch record are identical before and after external-file actions');

  await restart(env); await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await setAppearance('en', 'dark', 960);
  await until(() => page.getByRole('tab').filter({ hasText: 'outside.ts' }).count(), 'persisted external tab after restart');
  await activateTab('outside.ts');
  await until(async () => /External persistent comment/.test(await text('.wb-review-comments')), 'pending absolute-path external comment after restart');
  assert.ok((await text('.wb-review-comments')).replaceAll('/', '\\').includes(join(outside, 'outside.ts')), 'restarted pending comment retains its absolute external path');
  await page.locator('.wb-review-comments .wb-review-comment-open').click();
  await until(() => visible('[data-testid="external-file-boundary"]').count(), 'pending comment opens or focuses its external file');
  check('pending external comments survive restart with their absolute path and reopen the external file');
  await shot('en-dark-960-restart.png');
  // Model a stale saved tab without touching source data.  On the following restart the renderer must recover it by
  // re-registering the stored path as a recent user-owned file.
  const stale = (await request('filesystem.external.list', {})).files.find(file => file.path === join(outside, 'outside.ts'));
  assert.ok(stale, 'outside.ts stays registered before unknown-id recovery');
  await request('filesystem.external.forget', { id: stale.id, operationId: randomUUID() });
  await rm(join(outside, 'outside.ts'));
  await visible('button').filter({ hasText: /Reload from disk|从磁盘重新载入/ }).click();
  await until(async () => /missing|no longer exists/i.test(await text('.workspace-file-error, .runtime-overlay, [role="alert"], .pane-tab-surface:not([hidden])')), 'unknown external id recovers to a missing-file card');
  await writeFile(join(outside, 'outside.ts'), sourceV2);
  await visible('button').filter({ hasText: /Retry|重试/ }).click();
  await until(async () => (await text('.pane-tab-surface:not([hidden])')).includes('a + b + 1'), 'missing external Retry re-registers and reloads the file');
  const recovered = (await request('filesystem.external.list', {})).files.find(file => file.path === join(outside, 'outside.ts'));
  assert.ok(recovered && recovered.id !== stale.id, 'Retry obtains a fresh external registration');
  await request('filesystem.external.forget', { id: recovered.id, operationId: randomUUID() });
  await restart(env); await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await until(async () => (await text('.pane-tab-surface:not([hidden])')).includes('a + b + 1'), 'unknown external id recovers by stored path');
  check('unknown external IDs recover on Retry after a missing file and reopen once from the stored absolute path after restart');

  // Recreate the deliberately removed recent before the visual-state matrix.  The real picker
  // refreshes existing tabs and preserves their IDs, so this also checks de-duplication.
  await writeFile(join(outside, 'outside.md'), '# Outside markdown\n\nRead-only preview.\n');
  await openWithPicker();
  const states = [
    ['ts-comments', async () => { await activateTab('outside.ts'); }],
    ['markdown-preview', async () => { await activateTab('outside.md'); const preview = visible('button').filter({ hasText: /^(Preview|预览)$/ }).first(); if (await preview.count()) await preview.click(); await until(async () => (await text('.pane-tab-surface:not([hidden])')).includes('Read-only preview.'), 'markdown preview loads for matrix'); }],
    ['image-preview', async () => { await activateTab('outside.png'); await until(async () => (await visible('img').first().evaluate(image => image.naturalWidth > 0)), 'image preview decodes for matrix'); }],
    ['large-error', async () => { await activateTab('large.ts'); }],
    ['binary-error', async () => { await activateTab('binary.bin'); }],
    ['html-sandbox', async () => { await activateTab('outside.html'); const preview = visible('button').filter({ hasText: /^(Preview|预览)$/ }).first(); if (await preview.count()) await preview.click(); const frame = visible('iframe[title="Outside workspace HTML preview"],iframe[title="工作区外 HTML 预览"]'); const heading = frame.contentFrame().getByRole('heading', { name: 'Safe external HTML' }); await heading.waitFor(); await heading.screenshot({ animations: 'disabled' }); await delay(180); }],
    ['quick-open-recents', async () => { await page.evaluate(() => window.dispatchEvent(new CustomEvent('threadterm:workbench', { detail: { view: 'quick-open' } }))); await page.locator('.wb-quick-open').waitFor(); }],
    ['permission-disclosure', async () => { await page.keyboard.press('Escape').catch(() => {}); await activateTab('outside.ts'); const chip = visible('[data-testid="external-file-boundary"] .external-file-boundary-chip'); if (await chip.getAttribute('aria-expanded') !== 'true') await chip.click(); await visible('.external-file-boundary-notice').waitFor(); }],
  ];
  for (const [language, locale] of [['en', 'en'], ['zh-CN', 'zh']]) for (const theme of ['light', 'dark']) for (const width of [1440, 960]) for (const [state, reveal] of states) {
    await page.keyboard.press('Escape').catch(() => {}); await setAppearance(language, theme, width); await reveal(); await shot(`matrix-${locale}-${theme}-${width}-${state}.png`);
  }
  check('visual-state matrix captures text/comments, previews, errors, recents and permission disclosure across en/zh × light/dark × 1440/960');
  for (const [language, locale] of [['en', 'en'], ['zh-CN', 'zh']]) for (const theme of ['light', 'dark']) for (const width of [1440, 960]) {
    await setAppearance(language, theme, width); await activateTab('outside.ts'); await shot(`${locale}-${theme}-${width}-external-ts.png`);
  }
  check('external tabs persist through an isolated app restart and visual matrix captures en/zh × light/dark × 1440/960');

  // Playwright cannot synthesize a native Explorer drop that preserves Windows file paths. The product unit tests
  // cover the injected drop handler; provider-authored file links above run against the fake ACP provider for real.
  report.limitations.push('Native Explorer drop requires an injected getPathForFile handler unit test; Playwright cannot preserve a real Windows file path in a synthetic drop.');
  report.passed = report.errors.length === 0;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await shot('failure.png').catch(() => {});
} finally {
  await app?.close().catch(() => {}); await releaseLock?.().catch(() => {}); await cleanupApp?.().catch(() => {});
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(report.passed ? 'EXTERNAL FILES VISUAL QA PASSED' : `EXTERNAL FILES VISUAL QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
