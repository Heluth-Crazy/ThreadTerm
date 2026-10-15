// Real-app check of task 10-04-orca-quick-wins: command palette ranked by attention, "Open in preview" from the
// terminal link bar, dragging an Explorer file into a Chat, and review comments added to the agent's message box.
// Isolated Electron (own data, user data and pipe; app bundle built into the scratch folder, so desktop-dist and
// renderer/dist stay untouched) on the target-qa runtime. Fake providers only: a fake Grok ACP agent for the Chat
// and a fake Claude SDK host; PATH holds only the fake bin, node and System32 (every case of PATH is dropped first),
// so no real agent CLI can start. A local HTTP page stands in for a development server. Nothing is sent to an agent.
//   node qa/orca-quick-wins-visual.mjs [--keep]
// Screenshots (en + zh-CN): qa/results/orca-quick-wins/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `missing ${runtime}`);
const keep = process.argv.includes('--keep');
const gitDir = (() => {
  const found = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean);
  const git = found.find(path => /\\cmd\\git\.exe$/i.test(path)) ?? found[0];
  assert.ok(git, 'git was not found');
  return dirname(git);
})();
const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'tt-orca-visual-'));
const workspace = join(scratch, 'shop app');
const bin = join(scratch, 'bin'), appDir = join(root, 'runtime/target-qa/orca-qa-app');
const out = join(root, 'qa/results/orca-quick-wins');
const report = { passed: false, scratch, checks: [], notes: [], shots: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const note = text => { report.notes.push(text); console.log(`NOTE ${text}`); };
let app, page, server;

// ---------- fakes ----------
const fakeGrok = `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv.includes('--version')) { console.log('grok 0.0.0-qa'); process.exit(0); }
let next = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined || request.method === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, load: {} } } });
  else if (request.method === 'session/new') reply({ sessionId: 'qa-' + process.pid + '-' + (++next) });
  else if (request.method === 'session/list') reply({ sessions: [] });
  else if (request.method === 'session/prompt') {
    // One answer with the dev server's address as a Markdown link and as a bare URL (GFM autolink).
    const text = 'The dev server runs at [Shop app](' + process.env.TT_QA_URL + '). Raw: ' + process.env.TT_QA_URL;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    setTimeout(() => reply({ stopReason: 'end_turn' }), 100);
  }
  else reply({});
});
`;
const fakeClaudeHost = `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, ok: { pid: process.pid, sdk: true } }) + '\\n');
});
`;

async function prepare() {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Shop app\n\nQA fixture for the ORCA quick wins.\n');
  await writeFile(join(workspace, 'src/cart.ts'), ['export function total(items: number[]): number {', '  let sum = 0;', '  for (const item of items) sum += item;', '  return sum;', '}', '', 'export function empty(items: number[]): boolean {', '  return items.length === 0;', '}', ''].join('\n'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'QA fixture');
  await writeFile(join(bin, 'fake-grok.mjs'), fakeGrok);
  await writeFile(join(scratch, 'fake-claude-host.mjs'), fakeClaudeHost);
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var_os("TT_QA_NODE").expect("TT_QA_NODE")).arg(std::env::var_os("TT_QA_SCRIPT").expect("TT_QA_SCRIPT")).args(std::env::args_os().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', ['-O', join(bin, 'shim.rs'), '-o', join(bin, 'grok.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  // The app bundle is cached in the git-ignored target-qa folder; --rebuild after changing app code.
  if (process.argv.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'))) {
    console.log('building the QA app bundle…');
    await mkdir(appDir, { recursive: true });
    for (const name of ['main', 'preload']) {
      await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    }
    await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-orca-qa', version: '0.1.0', main: 'main.cjs' }));
  } else console.log(`reusing the QA app bundle in ${appDir} (--rebuild to rebuild)`);
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>QA page</title><body style="font:16px system-ui;margin:0;padding:28px;background:#eef6ff;color:#0b3d6e"><h1 style="margin-top:0">Shop app · dev server</h1><p>Served on 127.0.0.1 for the web preview check.</p></body>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(test, label, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await test(); if (value) return value; } catch { /* retry */ } if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(200); }
}
const shot = async name => { await delay(250); await page.screenshot({ path: join(out, name) }); report.shots.push(name); };
const setLanguage = async language => { const { settings } = await request('runtime.snapshot'); await request('settings.update', { patch: { language, theme: 'light' }, expectedRevision: settings.revision, operationId: randomUUID() }); await delay(400); };
const tab = label => page.locator('.workspace-tab .workspace-tab-select', { hasText: label }).first();
const rail = name => page.locator('.wb-switcher').getByRole('button', { name, exact: true });
const openView = async name => { if (await rail(name).getAttribute('aria-pressed') !== 'true') await rail(name).click(); };

try {
  await mkdir(out, { recursive: true });
  console.log('preparing fixtures and building the QA app bundle…');
  await prepare();
  const url = `http://127.0.0.1:${server.address().port}/qa.html`;
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  Object.assign(env, {
    // Git's own cmd folder (git, gitk, git-gui only) for checkpoints; no agent CLI lives in any of these folders.
    Path: [bin, dirname(process.execPath), gitDir, join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-orca-visual-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_CLAUDE_SDK_HOST: join(scratch, 'fake-claude-host.mjs'), THREADTERM_CLAUDE_NODE: process.execPath,
    TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(bin, 'fake-grok.mjs'), TT_QA_URL: url,
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await setLanguage('en');
  const project = await request('project.add', { path: workspace, name: 'Shop app', operationId: randomUUID() });
  const create = params => request('session.create', { projectId: project.id, cwd: workspace, operationId: randomUUID(), ...params });
  const old = await create({ provider: 'shell', mode: 'terminal', title: 'Old build', executable: 'cmd.exe', args: ['/d', '/c', 'exit 0'] });
  const dev = await create({ provider: 'shell', mode: 'terminal', title: 'Dev server', executable: 'cmd.exe', args: ['/d', '/k', `echo ${url}`] });
  const chat = await create({ provider: 'grok', mode: 'chat', title: 'Cart agent' });
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === old.id)?.status === 'exited', 'old build terminal did not exit');
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await request('session.present', { sessionId: dev.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.locator('.xterm-rows').first().waitFor();
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const composer = page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-shell textarea`);
  await until(async () => await composer.isVisible() && await composer.isEnabled(), 'the Chat composer did not become ready', 60000);
  const tabs = await page.locator('.workspace-tab .workspace-tab-select').allInnerTexts();
  note(`workspace tabs: ${tabs.join(' | ')}`);
  assert.ok(tabs.some(text => text.includes('Dev server')) && tabs.some(text => text.includes('Cart agent')), 'both sessions are tabs of one workspace');

  // ---------- 1. palette ----------
  await page.keyboard.press('Control+K');
  await page.locator('.palette').waitFor();
  // The project name is part of each session's detail now, so it finds the project's sessions.
  await page.locator('.palette-input').fill('Shop app');
  const rows = await page.locator('.palette .cmd-row').evaluateAll(list => list.map(row => ({ label: row.querySelector('b')?.textContent, detail: row.querySelector('span')?.textContent, dot: row.querySelector('span .dot')?.className ?? '' })));
  const sessions = rows.filter(row => ['Old build', 'Dev server', 'Cart agent'].includes(row.label));
  note(`palette sessions: ${JSON.stringify(sessions)}`);
  assert.equal(sessions.at(-1).label, 'Old build', 'the ended session comes last');
  assert.match(sessions.find(row => row.label === 'Cart agent').detail, /^Grok · (Idle|Running|Starting|Status unknown) · Shop app$/);
  assert.match(sessions.find(row => row.label === 'Old build').detail, /^Shell · Ended · Shop app$/);
  assert.ok(sessions.every(row => /dot st-/.test(row.dot)), 'every session row has a state dot');
  await shot('en-1-palette.png');
  check('palette: sessions show provider · state · project with a state dot; the ended one is last');
  await page.keyboard.press('Escape');

  // ---------- 2. terminal link → Open in preview ----------
  await tab('Dev server').click();
  const clickUrl = async () => { const box = await until(() => page.evaluate(target => {
    for (const row of document.querySelectorAll('.pane-tab-surface:not([hidden]) .xterm-rows > div')) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let text = '', nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push([node, text.length]); text += node.textContent; }
      const at = text.indexOf(target);
      if (at < 0 || text.slice(0, at).trim()) continue;
      const [node, offset] = nodes.findLast(([, start]) => start <= at + 4);
      const range = document.createRange(); range.setStart(node, at + 4 - offset); range.setEnd(node, at + 5 - offset);
      const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  }, url), "the URL did not appear in the terminal"); for (let attempt = 1; attempt <= 3; attempt++) { if (attempt > 1) { await page.mouse.move(box.x, box.y + 200, { steps: 4 }); await delay(300); } await page.mouse.move(box.x - 2, box.y, { steps: 3 }); await page.mouse.move(box.x, box.y); await delay(300); await page.mouse.click(box.x, box.y); if (await page.locator(".pane-tab-surface:not([hidden]) .terminal-link-actions").isVisible().catch(() => false)) { if (attempt > 1) note(`link bar needed ${attempt} clicks: after the layout changed, the pointer had to leave and re-enter the link (xterm hover state)`); return; } await delay(500); } note(`link bar did not open at ${Math.round(box.x)},${Math.round(box.y)}; under the pointer: ${await page.evaluate(([x, y]) => { let element = document.elementFromPoint(x, y); const chain = []; while (element && chain.length < 6) { chain.push(element.tagName.toLowerCase() + (typeof element.className === 'string' && element.className ? '.' + element.className.trim().split(/\s+/).join('.') : '')); element = element.parentElement; } return chain.join(' < '); }, [box.x, box.y])}; focused: ${await page.evaluate(() => document.activeElement?.className ?? '')}`); };
  await clickUrl();
  const linkBar = page.locator('.pane-tab-surface:not([hidden]) .terminal-link-actions');
  await linkBar.waitFor();
  const assertLinkBar = async names => {
    const controls = await linkBar.locator('button').evaluateAll(buttons => buttons.map(button => ({
      name: (button.getAttribute('aria-label') || button.textContent).trim(),
      textButton: button.matches('.btn.btn-sm'), iconButton: button.matches('.icon-btn.icon-btn-sm'),
      height: button.getBoundingClientRect().height, fontSize: getComputedStyle(button).fontSize,
      radius: getComputedStyle(button).borderRadius, icon: Boolean(button.querySelector('svg')),
    })));
    assert.deepEqual(controls.map(control => control.name), names, 'all four terminal link actions have the expected accessible names');
    assert.ok(controls.slice(0, 3).every(control => control.textButton), 'text actions use shared compact buttons');
    assert.ok(controls[3].iconButton && controls[3].icon, 'Close uses the shared compact icon button and SVG');
    assert.ok(controls.every(control => Math.abs(control.height - 26) <= 0.5 && control.fontSize === '12px'), 'link actions share the 26px / 12px compact scale');
    assert.equal(new Set(controls.map(control => control.radius)).size, 1, 'link actions share one control radius');
  };
  await assertLinkBar(['Open in preview', 'Open in browser', 'Copy link', 'Close link actions']);
  await shot('en-2-link-bar.png');
  await linkBar.getByRole('button', { name: 'Open in preview', exact: true }).click();
  const preview = page.locator('.wb-web-preview').first();
  await preview.waitFor();
  const host = new URL(url).host;
  await until(async () => (await page.locator('.workspace-tab .workspace-tab-select').allInnerTexts()).some(text => text.includes(host)), 'the web tab is not in the tab bar');
  const frame = page.frameLocator('.wb-web-preview iframe').first();
  await frame.locator('h1').waitFor();
  assert.equal(await frame.locator('h1').innerText(), 'Shop app · dev server');
  assert.equal(await preview.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms');
  await shot('en-3-web-tab.png');
  check(`terminal link bar offers Open in preview; the page opens as an independent "${host}" tab, sandboxed like the existing preview`);
  // The same address again activates the existing tab instead of adding one.
  await tab('Dev server').click();
  await clickUrl();
  await linkBar.getByRole('button', { name: 'Open in preview', exact: true }).click();
  await delay(500);
  assert.equal((await page.locator('.workspace-tab .workspace-tab-select').allInnerTexts()).filter(text => text.includes(host)).length, 1, 'one tab per address');
  check('opening the same address again reuses its tab');
  const saved = (await request('runtime.snapshot')).workspaces.find(item => JSON.stringify(item.layout).includes('"kind":"web"'));
  assert.ok(saved, 'the layout with a web tab was saved (protocol + runtime accepted it)');
  check('a layout with a web tab passes the desktop and runtime validation (workspace.save)');

  // ---------- 3. drag an Explorer file into the Chat ----------
  await tab('Cart agent').click();
  await composer.waitFor();
  await composer.fill('');
  await openView('Files');
  const readme = page.locator('.wb-tree-row[data-path="README.md"]');
  await readme.waitFor();
  assert.equal(await readme.getAttribute('draggable'), 'true');
  // Synthetic drag through the real handlers (dragstart fills the payload; dragover highlights; drop inserts).
  await page.evaluate(([chatId]) => {
    const transfer = new DataTransfer();
    window.__qaTransfer = transfer;
    document.querySelector('.wb-tree-row[data-path="README.md"]').dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    const target = document.querySelector(`[data-testid="session-chat-${chatId}"]`).closest('.pane-tab-surface');
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [chat.id]);
  const surface = page.locator('.pane-tab-surface.file-drop-target');
  await surface.waitFor();
  assert.equal(await surface.getAttribute('data-drop-label'), 'Drop to insert the file reference (not sent)');
  await shot('en-4-drop-target.png');
  await page.evaluate(([chatId]) => {
    const target = document.querySelector(`[data-testid="session-chat-${chatId}"]`).closest('.pane-tab-surface');
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__qaTransfer, bubbles: true, cancelable: true }));
  }, [chat.id]);
  await until(async () => (await composer.inputValue()).includes('README.md'), 'the dropped reference did not reach the composer');
  assert.equal((await composer.inputValue()).trim(), 'README.md');
  assert.equal(await page.locator('.pane-tab-surface.file-drop-target').count(), 0, 'the highlight goes away after the drop');
  check('dragging README.md from the Explorer onto the Chat inserts "README.md" into the message box (not sent)');
  // A native drag through Chromium, best effort (Playwright drives HTML5 drag-and-drop in Chromium).
  await composer.fill('');
  try {
    await readme.dragTo(page.locator(`[data-testid="session-chat-${chat.id}"] .chat-scroll`).first(), { timeout: 8000 });
    await until(async () => (await composer.inputValue()).includes('README.md'), 'native drop', 5000);
    check('a native mouse drag (Playwright dragTo) inserts the same reference');
  } catch (error) { note(`native drag not confirmed by Playwright here: ${error.message.split('\n')[0]}`); }
  await composer.fill('');
  assert.equal((await request('chat.read', { sessionId: chat.id })).filter(item => item.role === 'user').length, 0, 'nothing was sent to the agent');

  // ---------- 4. review comments ----------
  await openView('Agent changes');
  const review = page.locator('.wb-review');
  await review.getByRole('button', { name: 'Checkpoint', exact: true }).click();
  await page.locator('.wb-checkpoint').first().waitFor();
  const cart = await readFile(join(workspace, 'src/cart.ts'), 'utf8');
  await writeFile(join(workspace, 'src/cart.ts'), cart.replace('  let sum = 0;\n  for (const item of items) sum += item;\n  return sum;', '  return items.reduce((sum, item) => sum + item, 0);').replace('export function empty', 'export function isEmpty'));
  const change = review.locator('.wb-change-open', { hasText: 'cart.ts' }).first();
  await until(() => change.isVisible(), 'the edit did not show in Agent changes', 20000);
  await change.click();
  const diff = page.locator('.wb-review-diff').first();
  await diff.locator('.cm-mergeView').waitFor();
  const commentButton = diff.getByRole('button', { name: 'Comment', exact: true });
  assert.equal(await commentButton.isDisabled(), true, 'Comment needs a selection');
  const line = (side, text) => diff.locator(`.cm-merge-${side} .cm-line`, { hasText: text }).first();
  await line('b', 'reduce').click();
  await until(async () => !(await commentButton.isDisabled()), 'selecting a new-side line enabled Comment');
  await commentButton.click();
  const form = diff.locator('.wb-review-comment-form');
  await form.locator('textarea').fill('Keep the loop: the profiler showed reduce is slower here.');
  assert.match(await form.locator('.wb-review-comment-where').innerText(), /^src\/cart\.ts:2$/);
  await shot('en-5-comment-form.png');
  await form.getByRole('button', { name: 'Add comment', exact: true }).click();
  await line('a', 'let sum = 0').click();
  await line('a', 'return sum;').click({ modifiers: ['Shift'] });
  await commentButton.click();
  assert.match(await form.locator('.wb-review-comment-where').innerText(), /^src\/cart\.ts \(before your change, lines 2-4\)$/);
  await form.locator('textarea').fill('Why was the explicit loop removed?');
  await form.locator('textarea').press('Control+Enter');
  const strip = diff.locator('.wb-review-comments');
  await strip.waitFor();
  assert.match(await strip.locator('.wb-review-comment-actions').first().innerText(), /^2 comments\s+not sent yet/);
  assert.ok(await diff.locator('.cm-merge-b .cm-review-commented').count() >= 1 && await diff.locator('.cm-merge-a .cm-review-commented').count() === 3, 'commented lines are marked on both sides');
  await shot('en-6-comments.png');
  check('comments on a new-side line and old-side lines (2-4); both sides marked; strip "2 comments · not sent yet" with Add to message / Copy / Clear');
  // Reloading the window keeps the pending comments (reopening a workspace shows only its sessions).
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => await composer.isVisible() && await composer.isEnabled(), 'the Chat composer did not come back', 60000);
  await openView('Agent changes');
  await page.locator('.wb-review .wb-change-open', { hasText: 'cart.ts' }).first().click();
  await page.locator('.wb-review-diff .wb-review-comments').waitFor();
  check('pending comments survive a window reload');
  await page.locator('.wb-review-diff .wb-review-comments').getByRole('button', { name: 'Add to message', exact: true }).click();
  await until(async () => (await composer.inputValue()).includes('Review comments on your changes:'), 'the comments did not reach the composer');
  const inserted = (await composer.inputValue()).trim();
  note(`inserted:\n${inserted}`);
  assert.equal(inserted, [
    'Review comments on your changes:',
    '- src/cart.ts:2 — Keep the loop: the profiler showed reduce is slower here.',
    '  > return items.reduce((sum, item) => sum + item, 0);',
    '- src/cart.ts (before your change, lines 2-4) — Why was the explicit loop removed?',
    '  > let sum = 0; …',
  ].join('\n'));
  assert.equal(await page.locator('.wb-review-diff .wb-review-comments').count(), 0, 'inserted comments leave the strip');
  assert.equal((await request('chat.read', { sessionId: chat.id })).filter(item => item.role === 'user').length, 0, 'nothing was sent to the agent');
  await shot('en-7-inserted.png');
  check('Add to message puts both comments into the Cart agent message box (not sent) and clears them');

  // ---------- 5. a link in a Chat message ----------
  // One prompt to the fake agent; its answer holds the dev server's address (Markdown link + bare URL).
  await composer.fill('Where does the dev server run?');
  await page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-shell`).evaluate(form => form.requestSubmit());
  const chatLog = page.locator(`[data-testid="session-chat-${chat.id}"] .v3-chat-log`);
  const chatLink = chatLog.locator(`a[href="${url}"]`);
  await until(async () => await chatLink.count() === 2, 'the answer with two links did not arrive', 30000);
  const before = await page.evaluate(() => location.href);
  await chatLink.first().click();
  const menu = page.locator('.catalogue-popover[role="menu"]');
  await menu.waitFor();
  assert.equal(await menu.locator('.chat-link-menu-url').innerText(), url);
  assert.deepEqual((await menu.locator('.menu-item').allInnerTexts()).map(text => text.trim()), ['Open in preview', 'Open in browser', 'Copy link']);
  await shot('en-8-chat-link-menu.png');
  await menu.getByRole('menuitem', { name: 'Open in preview', exact: true }).click();
  await page.locator('.wb-web-preview').first().waitFor();
  await page.frameLocator('.wb-web-preview iframe').first().locator('h1').waitFor();
  assert.equal(await page.evaluate(() => location.href), before, 'the app window did not navigate');
  await until(async () => (await page.locator('.workspace-tab .workspace-tab-select').allInnerTexts()).some(text => text.includes(host)), 'the web tab is not in the tab bar');
  // The bare URL behaves the same; Escape closes the menu without acting.
  await tab('Cart agent').click();
  await chatLink.last().click();
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await until(async () => await menu.count() === 0, 'Escape did not close the link menu');
  assert.equal(await page.evaluate(() => location.href), before);
  check('a link in a Chat message opens a menu (Open in preview / Open in browser / Copy link) at the link; preview opens the web tab; the app never navigates');

  // ---------- zh-CN ----------
  await composer.fill('');
  await setLanguage('zh-CN');
  await page.keyboard.press('Control+K'); await page.locator('.palette').waitFor();
  await page.locator('.palette-input').fill('Shop app');
  assert.match((await page.locator('.palette .cmd-row', { hasText: 'Old build' }).locator('span').innerText()), /^Shell · 已结束 · Shop app$/);
  await shot('zh-1-palette.png'); await page.keyboard.press('Escape');
  await tab('Dev server').click();
  await clickUrl();
  await linkBar.getByRole('button', { name: '在预览中打开', exact: true }).waitFor();
  await assertLinkBar(['在预览中打开', '在浏览器中打开', '复制链接', '关闭链接操作']);
  await shot('zh-2-link-bar.png');
  await linkBar.getByRole('button', { name: '在预览中打开', exact: true }).click();
  await page.locator('.wb-web-preview').first().waitFor();
  await shot('zh-3-web-tab.png');
  await tab('Cart agent').click();
  await page.locator(`[data-testid="session-chat-${chat.id}"] .v3-chat-log a[href="${url}"]`).first().click();
  await page.locator('.catalogue-popover[role="menu"]').waitFor();
  assert.deepEqual((await page.locator('.catalogue-popover[role="menu"] .menu-item').allInnerTexts()).map(text => text.trim()), ['在预览中打开', '在浏览器中打开', '复制链接']);
  await shot('zh-6-chat-link-menu.png');
  await page.keyboard.press('Escape');
  await tab('Cart agent').click();
  // The prompt above took a checkpoint before it was sent (as every chat.send does): edit again so there is a change.
  await writeFile(join(workspace, 'src/cart.ts'), (await readFile(join(workspace, 'src/cart.ts'), 'utf8')).replace('export function isEmpty(', 'export function isEmptyCart('));
  await openView('Agent 改动');
  await page.locator('.wb-review .wb-change-open', { hasText: 'cart.ts' }).first().click();
  const zhDiff = page.locator('.pane-tab-surface:not([hidden]) .wb-review-diff').first();
  await zhDiff.locator('.cm-merge-b .cm-line', { hasText: 'isEmpty' }).first().click();
  await zhDiff.getByRole('button', { name: '评论', exact: true }).click();
  await zhDiff.locator('.wb-review-comment-form textarea').fill('名称改了，调用方也要一起改。');
  await shot('zh-4-comment-form.png');
  await zhDiff.locator('.wb-review-comment-form textarea').press('Control+Enter');
  await zhDiff.locator('.wb-review-comments').waitFor();
  assert.match(await zhDiff.locator('.wb-review-comments .wb-review-comment-actions').first().innerText(), /^1 条审查意见\s+尚未发送/);
  await shot('zh-5-comments.png');
  await zhDiff.locator('.wb-review-comments').getByRole('button', { name: '清除', exact: true }).click();
  await page.locator('.runtime-overlay').getByRole('button', { name: '清除', exact: true }).last().click();
  await until(async () => await zhDiff.locator('.wb-review-comments').count() === 0, 'Clear did not remove the comment');
  check('zh-CN: palette state label, link bar, web tab, comment form, strip and Clear');

  assert.deepEqual(report.errors, [], 'no page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  // Exit the QA app at once: a still-running desktop would start a new runtime after the shutdown.
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await Promise.race([app.close(), delay(5000)]).catch(() => {}); try { app.process()?.kill(); } catch { /* already gone */ } }
  await delay(1500);
  // Safety net: only the target-qa runtime (never the user's ThreadTerm, which runs another executable).
  spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\runtime\\target-qa\\debug\\threadterm-v3-runtime.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { windowsHide: true });
  server?.close();
  if (!keep && report.passed) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(error => console.error(`scratch left: ${scratch} (${error.message})`));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, notes: report.notes, errors: report.errors, scratch: report.passed && !keep ? undefined : scratch }, null, 2));
}
