// Real-app check of task 10-05-file-comments: comments on lines of ANY file view (editor, Source Control diff,
// commit history diff, agent review) collect in one list per workspace folder, and "Add to message" inserts them
// (not sent) into the current session by default or into another chosen Chat session.
// Isolated Electron (own data, user data and pipe; app bundle cached in the git-ignored runtime/target-qa folder,
// --rebuild after app changes; desktop-dist and renderer/dist untouched) on the target-qa runtime. Fake providers
// only: two fake Grok ACP Chats and a fake Claude SDK host; PATH holds only the fake bin, node, Git's cmd folder and
// System32 (every case of PATH dropped first), so no real agent CLI can start. Nothing is sent to an agent.
//   node qa/file-comments-visual.mjs [--rebuild] [--keep]
// Screenshots (en + zh-CN): qa/results/file-comments/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const scratch = await mkdtemp(join(tmpdir(), 'tt-file-comments-'));
const workspace = join(scratch, 'shop app');
const bin = join(scratch, 'bin'), appDir = join(root, 'runtime/target-qa/orca-qa-app');
const out = join(root, 'qa/results/file-comments');
const report = { passed: false, scratch, checks: [], notes: [], shots: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const note = text => { report.notes.push(text); console.log(`NOTE ${text}`); };
let app, page;

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
  else if (request.method === 'session/prompt') reply({ stopReason: 'end_turn' });
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
const cartV1 = ['export function total(items: number[]): number {', '  let sum = 0;', '  for (const item of items) sum += item;', '  return sum;', '}', '', 'export function empty(items: number[]): boolean {', '  return items.length === 0;', '}', ''].join('\n');
const cartV2 = cartV1.replace('export function empty(', 'export function isEmpty(');
const cartWorking = cartV2.replace('  for (const item of items) sum += item;', '  for (const item of items) sum += Math.max(0, item);');

async function prepare() {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(bin, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, windowsHide: true, encoding: 'utf8' });
  await writeFile(join(workspace, 'README.md'), '# Shop app\n');
  await writeFile(join(workspace, 'src/cart.ts'), cartV1);
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'Cart totals');
  await writeFile(join(workspace, 'src/cart.ts'), cartV2);
  git('commit', '-q', '-am', 'Rename empty to isEmpty');
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  await writeFile(join(workspace, 'src/cart.ts'), cartWorking); // an uncommitted change for the Source Control diff
  await writeFile(join(bin, 'fake-grok.mjs'), fakeGrok);
  await writeFile(join(scratch, 'fake-claude-host.mjs'), fakeClaudeHost);
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var_os("TT_QA_NODE").expect("TT_QA_NODE")).arg(std::env::var_os("TT_QA_SCRIPT").expect("TT_QA_SCRIPT")).args(std::env::args_os().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', ['-O', join(bin, 'shim.rs'), '-o', join(bin, 'grok.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  if (process.argv.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'))) {
    console.log('building the QA app bundle…');
    await mkdir(appDir, { recursive: true });
    for (const name of ['main', 'preload']) {
      await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
    }
    await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-orca-qa', version: '0.1.0', main: 'main.cjs' }));
  } else console.log(`reusing the QA app bundle in ${appDir} (--rebuild to rebuild)`);
  return commit;
}

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(test, label, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await test(); if (value) return value; } catch { /* retry */ } if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(200); }
}
const shot = async name => { await delay(250); await page.screenshot({ path: join(out, name) }); report.shots.push(name); };
const setLanguage = async language => { const { settings } = await request('runtime.snapshot'); await request('settings.update', { patch: { language, theme: 'light' }, expectedRevision: settings.revision, operationId: randomUUID() }); await delay(400); };
const visible = selector => page.locator(`.pane-tab-surface:not([hidden]) ${selector}`);
const tab = label => page.locator('.workspace-tab .workspace-tab-select', { hasText: label }).first();
const rail = name => page.locator('.wb-switcher').getByRole('button', { name, exact: true });
const openView = async name => { if (await rail(name).getAttribute('aria-pressed') !== 'true') await rail(name).click(); };
const strip = () => visible('.wb-review-comments').first();
const userMessages = async id => (await request('chat.read', { sessionId: id })).filter(item => item.role === 'user').length;
/** Comment on the line containing `text` (in `side` 'a'/'b' of a diff, or the editor), then add `body`. */
async function comment(host, text, body, { side, expectPlace } = {}) {
  const line = host.locator(side ? `.cm-merge-${side} .cm-line` : '.cm-line', { hasText: text }).first();
  await line.click();
  const button = host.getByRole('button', { name: /^(Comment|评论)$/ }).first();
  await until(async () => !(await button.isDisabled()), `Comment enabled for "${text}"`);
  await button.click();
  const form = host.locator('.wb-review-comment-form');
  await form.waitFor();
  const place = (await form.locator('.wb-review-comment-where').innerText()).trim();
  if (expectPlace) assert.match(place, expectPlace);
  await form.locator('textarea').fill(body);
  await form.locator('textarea').press('Control+Enter');
  await until(async () => await form.count() === 0, 'the form closes after adding');
  return place;
}

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  console.log('preparing fixtures…');
  const commit = await prepare();
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name)));
  Object.assign(env, {
    // Git's own cmd folder (git, gitk, git-gui only) for checkpoints and history; no agent CLI lives in these folders.
    Path: [bin, dirname(process.execPath), gitDir, join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-file-comments-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_CLAUDE_SDK_HOST: join(scratch, 'fake-claude-host.mjs'), THREADTERM_CLAUDE_NODE: process.execPath,
    TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(bin, 'fake-grok.mjs'),
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(`pageerror: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await setLanguage('en');
  const project = await request('project.add', { path: workspace, name: 'Shop app', operationId: randomUUID() });
  const create = params => request('session.create', { projectId: project.id, cwd: workspace, operationId: randomUUID(), ...params });
  const cart = await create({ provider: 'grok', mode: 'chat', title: 'Cart agent' });
  const docs = await create({ provider: 'grok', mode: 'chat', title: 'Docs agent' });
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await request('session.present', { sessionId: cart.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const composer = id => page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
  await until(async () => await composer(cart.id).isVisible() && await composer(cart.id).isEnabled(), 'the Cart agent composer did not become ready', 60000);
  assert.ok(!(await page.locator('.workspace-tab .workspace-tab-select').allInnerTexts()).some(text => text.includes('Docs agent')), 'Docs agent starts outside the workspace');

  // ---------- 1. the file editor ----------
  await openView('Files');
  await page.locator('.wb-tree-row[data-path="src"]').click();
  await page.locator('.wb-tree-row[data-path="src/cart.ts"]').click();
  const editor = visible('.file-workspace').first();
  await editor.locator('.cm-line', { hasText: 'Math.max' }).waitFor();
  const editorPlace = await comment(editor, 'Math.max', 'Clamp in the caller instead.', { expectPlace: /^src\/cart\.ts:3$/ });
  await strip().waitFor();
  assert.match(await strip().innerText(), /1 comment/);
  await shot('en-1-editor-comment.png');
  check(`editor: comment on ${editorPlace} (current file); the strip appears`);

  // ---------- 2. the Source Control diff (old side = before the uncommitted changes) ----------
  await openView('Source Control');
  await page.locator('.wb-change-open', { hasText: 'cart.ts' }).first().click();
  const scm = visible('.file-workspace').first();
  await scm.locator('.cm-mergeView').waitFor();
  const scmPlace = await comment(scm, 'sum += item', 'Negative items were allowed on purpose.', { side: 'a', expectPlace: /^src\/cart\.ts \(before the uncommitted changes, line 3\)$/ });
  check(`Source Control diff: comment on ${scmPlace}`);

  // ---------- 3. a commit in the file's history ----------
  await openView('Files');
  await page.locator('.wb-tree-row[data-path="src/cart.ts"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'File history', exact: true }).click();
  const history = visible('.wb-history, .wb-history-diff, .git-history').first();
  await page.locator('.wb-commit-row', { hasText: 'Rename empty to isEmpty' }).first().click();
  const historyDiff = visible('.cm-mergeView').first().locator('xpath=ancestor::*[contains(@class,"pane-tab-surface")]');
  await historyDiff.locator('.cm-mergeView').waitFor();
  const historyPlace = await comment(historyDiff, 'isEmpty', 'Keep the old name as an alias for one release.', { side: 'b', expectPlace: new RegExp(`^src/cart\\.ts \\(in commit ${commit.slice(0, 7)}, line 7\\)$`) });
  check(`history: comment on ${historyPlace}`);
  void history;

  // ---------- 4. the agent review ----------
  await openView('Agent changes');
  await page.locator('.wb-review').getByRole('button', { name: 'Checkpoint', exact: true }).click();
  await page.locator('.wb-checkpoint').first().waitFor();
  await writeFile(join(workspace, 'src/cart.ts'), (await readFile(join(workspace, 'src/cart.ts'), 'utf8')).replace('export function total(', 'export function cartTotal('));
  const change = page.locator('.wb-review .wb-change-open', { hasText: 'cart.ts' }).first();
  await until(() => change.isVisible(), 'the edit did not show in Agent changes', 20000);
  await change.click();
  const review = visible('.wb-review-diff').first();
  await review.locator('.cm-mergeView').waitFor();
  const reviewPlace = await comment(review, 'cartTotal', 'Rename the callers too.', { side: 'b', expectPlace: /^src\/cart\.ts:1$/ });
  check(`agent review: comment on ${reviewPlace}`);

  // ---------- one list for the folder, kept across a reload ----------
  assert.match(await strip().innerText(), /4 comments/);
  const shortPlaces = (await strip().locator('li .wb-review-comment-where').allInnerTexts()).map(text => text.trim());
  note(`list: ${shortPlaces.join(' | ')}`);
  assert.equal(shortPlaces.length, 4);
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await request('session.present', { sessionId: cart.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(async () => await composer(cart.id).isVisible() && await composer(cart.id).isEnabled(), 'the Cart agent composer came back', 60000);
  await openView('Files');
  await page.locator('.wb-tree-row[data-path="src"]').click().catch(() => {});
  await page.locator('.wb-tree-row[data-path="README.md"]').click();
  // Markdown opens as a preview (no text lines to comment on); its source view is a text view like any other.
  await visible('.file-workspace').first().getByRole('button', { name: 'Source code', exact: true }).click();
  await until(async () => /4 comments/.test(await strip().innerText()), 'the 4 comments show in another file of the folder after a reload');
  check('one list per folder: all 4 comments show in README.md (source view) after a window reload');

  // ---------- receivers: current session by default, another one chosen ----------
  // ThreadTerm's Select: a combobox button and a listbox of options.
  const picker = strip().getByRole('combobox');
  assert.equal(await picker.getAttribute('aria-label'), 'Send to session');
  assert.equal((await picker.innerText()).trim(), 'Cart agent', 'default = current session');
  await picker.click();
  const listbox = page.getByRole('listbox', { name: 'Send to session' });
  const options = (await listbox.getByRole('option').allInnerTexts()).map(text => text.trim());
  note(`receivers: ${options.join(' | ')}`);
  assert.deepEqual(options, ['Cart agent', 'Docs agent'], 'current session first, then the folder\'s other Chat');
  await shot('en-2-strip-receivers.png');
  await listbox.getByRole('option', { name: 'Docs agent' }).click();
  assert.equal((await picker.innerText()).trim(), 'Docs agent');
  await strip().getByRole('button', { name: 'Add to message', exact: true }).click();
  await until(async () => await composer(docs.id).isVisible() && (await composer(docs.id).inputValue()).includes('Review comments:'), 'the comments did not reach the Docs agent', 30000);
  const inserted = (await composer(docs.id).inputValue()).trim();
  note(`inserted into Docs agent:\n${inserted}`);
  for (const expected of [
    /^Review comments:$/m,
    /^- src\/cart\.ts:3 — Clamp in the caller instead\.$/m,
    /^- src\/cart\.ts \(before the uncommitted changes, line 3\) — Negative items were allowed on purpose\.$/m,
    new RegExp(`^- src/cart\\.ts \\(in commit ${commit.slice(0, 7)}, line 7\\) — Keep the old name as an alias for one release\\.$`, 'm'),
    /^- src\/cart\.ts:1 — Rename the callers too\.$/m,
  ]) assert.match(inserted, expected);
  assert.ok((await page.locator('.workspace-tab .workspace-tab-select').allInnerTexts()).some(text => text.includes('Docs agent')), 'the chosen session was opened in the workspace');
  assert.equal(await (await composer(cart.id).count() ? composer(cart.id).inputValue() : ''), '', 'the current session got nothing');
  assert.equal(await userMessages(docs.id) + await userMessages(cart.id), 0, 'nothing was sent');
  assert.equal(await page.locator('.wb-review-comments').count(), 0, 'the inserted comments left the list');
  await shot('en-3-inserted-into-docs.png');
  check('Add to message with "Docs agent" chosen: the session opens, its message box holds all 4 comments with their versions, nothing sent, list cleared');

  // ---------- zh-CN ----------
  await composer(docs.id).fill('');
  await setLanguage('zh-CN');
  await openView('文件');
  await page.locator('.wb-tree-row[data-path="src/cart.ts"]').click();
  const zhEditor = visible('.file-workspace').first();
  await comment(zhEditor, 'Math.max', '这里改成在调用方处理。', { expectPlace: /^src\/cart\.ts:3$/ });
  await until(async () => /1 条审查意见/.test(await strip().innerText()), 'zh strip');
  assert.equal(await strip().getByRole('combobox').getAttribute('aria-label'), '发送到会话');
  await shot('zh-1-strip.png');
  await strip().getByRole('button', { name: '清除', exact: true }).click();
  await page.locator('.runtime-overlay').getByRole('button', { name: '清除', exact: true }).last().click();
  await until(async () => await page.locator('.wb-review-comments').count() === 0, 'Clear did not remove the comment');
  check('zh-CN: editor comment, strip wording and receiver label, Clear');

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
  if (!keep && report.passed) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(error => console.error(`scratch left: ${scratch} (${error.message})`));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, notes: report.notes, errors: report.errors, scratch: report.passed && !keep ? undefined : scratch }, null, 2));
}
