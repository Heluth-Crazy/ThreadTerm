// Mounted-production-ChatView DOM QA for composer inline mentions (M2 review fix).
// It bundles the real React 19 ChatView and drives a real textarea in an isolated
// Electron renderer with a controllable bridge mock. This covers the controlled
// textarea behaviour and the async session-pick orchestration that a plain-object
// unit test cannot: deferred `chat.read`, submission failures, revision conflicts
// and the A→B→A lifecycle. No runtime, provider, Desktop or system clipboard is
// used, so it is safe to run repeatedly.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'tt-composer-dom-'));
const out = join(root, 'qa/results/inline-mentions/dom');
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, 'qa/fixtures/composer-mentions-dom.tsx')],
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  logLevel: 'error',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>
html,body,#root{height:100%;margin:0}
#root{display:flex;flex-direction:column}
#root > *{flex:1;min-height:0;height:100%}
.chat-view.v3-session-chat{position:relative;height:100%;display:flex;flex-direction:column}
</style><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
Object.assign(env, { PATH: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';') });

const report = { passed: false, checks: [], errors: [] };
let app; let active = ''; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
async function until(probe, label, timeout = 15_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(100); } }
const scope = () => page.locator(`[data-testid="session-chat-${active}"]`);
const composer = () => scope().locator('.chat-compose-shell textarea');
const popup = () => scope().locator('.chat-mentions');
const readout = () => scope().locator('[data-testid="context-tray"] .context-budget');
const chips = () => scope().locator('[data-testid="context-chip"]');
const value = () => composer().inputValue();
const draftV2 = (text, mentions) => `[ThreadTerm draft v2]\n${JSON.stringify({ text, mentions })}`;
const fileEntry = (token, path) => ({ token, item: { kind: 'file', id: `file:${path}`, path } });
async function mount(sessionId, patch = {}, { editable = true } = {}) {
  await page.evaluate(([id, extra]) => window.qa.reset({ sessionId: id, ...extra }), [sessionId, patch]);
  active = sessionId;
  await until(() => composer().count(), `composer mounted for ${sessionId}`);
  if (editable) await until(() => composer().isEnabled(), `composer enabled for ${sessionId}`);
}
async function setCaret(position) { await composer().evaluate((node, value) => { node.focus(); node.setSelectionRange(value, value); }, position); await delay(60); }
async function typeAtCaret(text) { await composer().click(); await page.keyboard.press('End'); await page.keyboard.type(text); }
async function pickFile(query) {
  await composer().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(`@${query}`);
  await popup().waitFor();
  await until(async () => (await popup().locator('[data-testid="mention-option"][data-mention-group="files"]').count()) > 0, `files row for ${query}`);
  await page.keyboard.press('Enter');
  await delay(150);
}
async function queueSessionPick(query = 'Oth') {
  await composer().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(`@${query}`);
  await popup().waitFor();
  await until(async () => (await popup().locator('[data-testid="mention-option"][data-mention-group="sessions"]').count()) > 0, `sessions row for ${query}`);
  await popup().locator('[data-testid="mention-option"][data-mention-group="sessions"]').first().click();
  await delay(120);
}
const sent = () => page.evaluate(() => window.qa.state.sent);
const queued = () => page.evaluate(() => window.qa.state.queued);

try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox'], env });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.qa));

  // 1. Controlled textarea: insertion, typing, an unrelated rerender, undo/redo,
  //    atomic deletion and the execCommand-failure fallback.
  await mount('dom-1');
  await setCaret(0);
  await page.keyboard.type('Please check @alpha');
  await popup().waitFor();
  await page.keyboard.press('Enter');
  await until(async () => (await value()) === 'Please check @alpha.ts ', 'token inserted');
  assert.equal(await chips().count(), 0, 'a mention adds no tray chip');
  await until(async () => (await readout().innerText()).includes('1/12'), 'readout counts the mention');
  const caret = await composer().evaluate(node => node.selectionStart);
  assert.equal(caret, 'Please check @alpha.ts '.length, 'caret after the trailing space');
  await page.keyboard.type('!');
  await until(async () => (await value()) === 'Please check @alpha.ts !', 'typing continues after the token');
  await page.evaluate(() => window.qa.render({ capabilities: { images: true, steer: false } }));
  await delay(150);
  assert.equal(await value(), 'Please check @alpha.ts !', 'an unrelated rerender keeps the controlled value');
  await page.keyboard.press('Control+z');
  await until(async () => (await value()) === 'Please check @alpha.ts ', 'undo removes the typed character');
  await page.keyboard.press('Control+z');
  await until(async () => (await value()) === 'Please check @alpha', 'undo removes the token');
  await page.keyboard.press('Control+y');
  await until(async () => (await value()) === 'Please check @alpha.ts ', 'redo re-applies the token');
  await page.keyboard.press('Control+Shift+z');
  await until(async () => (await value()) === 'Please check @alpha.ts !', 'Ctrl+Shift+Z re-applies the typed character');
  await setCaret('Please check @alpha.ts'.length);
  await page.keyboard.press('Backspace');
  await until(async () => !(await value()).includes('@alpha'), 'Backspace removes the whole token at once');
  assert.equal((await value()).replace(/\s+/g, ' '), 'Please check !', 'only the token was removed');
  await page.keyboard.press('Control+z');
  await until(async () => (await value()) === 'Please check @alpha.ts !', 'undo restores the whole token');
  // Fallback: a failing execCommand still inserts, and the state mirrors it.
  await page.evaluate(() => { window.__exec = document.execCommand; document.execCommand = () => false; });
  await pickFile('beta');
  await until(async () => (await value()).includes('@beta.ts '), 'fallback insert keeps the token');
  await page.evaluate(() => { document.execCommand = window.__exec; });
  check('controlled textarea: insertion, typing, unrelated rerender, undo/redo, atomic delete, fallback');

  // 2. Pick-time identity budget leaves @query untouched.
  await page.evaluate(id => localStorage.setItem(`threadterm.compose.context.${id}`, JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ kind: 'quote', id: `q-${index}`, sourceTitle: `Quote ${index}`, text: 'body' })))), 'dom-budget');
  await mount('dom-budget');
  await until(async () => (await readout().innerText()).includes('12/12'), 'twelve tray identities loaded');
  await composer().click(); await page.keyboard.type('@alpha');
  await popup().waitFor();
  await page.keyboard.press('Enter');
  await until(() => scope().getByText(/Attach at most 12 context items/).count(), 'budget error shown');
  assert.equal(await value(), '@alpha', 'a rejected pick leaves @query in the text');
  check('a pick over the identity budget keeps @query and shows the limit error');

  // 3. A draft restoring 13 active identities keeps its text and blocks submission.
  const thirteen = Array.from({ length: 13 }, (_, index) => fileEntry(`@f${index}`, `src/f${index}.ts`));
  const thirteenText = `${thirteen.map(entry => entry.token).join(' ')} `;
  await mount('dom-thirteen', { draft: draftV2(thirteenText, thirteen) });
  await until(async () => (await readout().innerText()).includes('13/12'), 'thirteen identities restored');
  assert.equal(await value(), thirteenText, 'all text survives the over-budget restore');
  await composer().click(); await page.keyboard.press('Enter');
  await until(() => scope().getByText(/Attach at most 12 context items/).count(), 'submit-time budget error shown');
  assert.equal(await value(), thirteenText, 'the blocked submission keeps the text');
  assert.equal((await sent()).length, 0, 'the blocked submission reached no provider');
  check('a restored 13-identity draft keeps its text and blocks submission');

  // 4. Deferred session picks (session_info off): success and every transition.
  await mount('dom-deferred', { readGate: true, readItems: [{ id: 'm1', role: 'user', turnId: 't', createdAt: 'now', parts: [{ type: 'text', text: 'the other chat transcript' }] }] });
  await queueSessionPick();
  assert.equal(await value(), '@Oth', 'nothing is inserted while the read is pending');
  await page.evaluate(() => window.qa.releaseRead());
  await until(async () => (await value()).includes('@"Other chat" '), 'the resolved session pick inserts its token');
  await until(async () => (await readout().innerText()).includes('1/12'), 'the session mention is active');
  check('a resolved session pick inserts when nothing changed');

  await mount('dom-edit', { readGate: true });
  await queueSessionPick();
  await setCaret(3);
  await page.keyboard.type('X');
  await until(async () => (await value()) === '@OtXh', 'the query text edited in place');
  await page.evaluate(() => window.qa.releaseRead());
  await until(() => scope().getByText(/The mention was not added because the draft changed/).count(), 'edited-draft pick rejected');
  assert.equal(await value(), '@OtXh', 'the edited draft keeps @query as plain text');
  check('a session pick is dropped after the token text is edited');

  await mount('dom-newer', { readGate: true });
  await queueSessionPick();
  await typeAtCaret(' @alpha');
  await popup().waitFor();
  await page.keyboard.press('Enter');
  await until(async () => (await value()).includes('@alpha.ts '), 'the newer file pick inserts');
  await page.evaluate(() => window.qa.releaseRead());
  await delay(200);
  assert.ok(!(await value()).includes('Other chat'), 'the older session pick is cancelled by a newer pick');
  check('a newer synchronous pick cancels an outstanding session pick');

  await mount('dom-submit', { readGate: true });
  await queueSessionPick();
  await page.keyboard.press('Escape');
  await composer().click(); await page.keyboard.press('Enter');
  await until(async () => (await sent()).length === 1, 'the pending-query submission was sent');
  const submitted = (await sent())[0];
  assert.match(submitted, /@Oth/, 'the @query is sent as plain text');
  assert.doesNotMatch(submitted, /mentions v1/, 'no session mention was added to the submission');
  await page.evaluate(() => window.qa.releaseRead());
  await delay(200);
  assert.ok(!(await value()).includes('Other chat'), 'the pick is dropped after submission started');
  check('submission start invalidates a pending session pick and sends @query as plain text');

  await mount('dom-aba', { readGate: true });
  await queueSessionPick();
  await page.evaluate(() => window.qa.render({ sessionId: 'dom-aba-b' }));
  await delay(150);
  await page.evaluate(() => window.qa.render({ sessionId: 'dom-aba' }));
  active = 'dom-aba';
  await until(() => composer().isEnabled(), 'composer ready after A→B→A');
  await page.evaluate(() => window.qa.releaseRead());
  await delay(200);
  assert.equal(await value(), '', 'an A→B→A lifecycle drops the stale session pick');
  check('an A→B→A session switch drops a pending session pick');

  // 5. Recovery arbitration: same text, different identity mapping.
  const runtimeCart = draftV2('@alpha.ts ', [fileEntry('@alpha.ts', 'src/alpha.ts')]);
  const localBeta = { v: 2, text: '@alpha.ts ', mentions: [fileEntry('@alpha.ts', 'src/beta.ts')] };
  await page.evaluate(([key, local]) => localStorage.setItem(key, JSON.stringify(local)), ['threadterm.compose.dom-recover', localBeta]);
  await mount('dom-recover', { draft: runtimeCart }, { editable: false });
  await page.getByText('An unsaved draft is available on this device.').waitFor();
  await page.getByRole('button', { name: 'Recover text' }).click();
  await until(async () => (await readout().innerText()).includes('1/12'), 'Recover text keeps the local catalogue');
  await composer().click(); await page.keyboard.press('Enter');
  await until(async () => (await sent()).length === 1, 'recovered draft sent');
  assert.match((await sent())[0], /File: src\/beta\.ts/, 'Recover text swaps text and catalogue together');

  await page.evaluate(([key, local]) => localStorage.setItem(key, JSON.stringify(local)), ['threadterm.compose.dom-keep', localBeta]);
  await mount('dom-keep', { draft: runtimeCart }, { editable: false });
  await page.getByText('An unsaved draft is available on this device.').waitFor();
  await page.getByRole('button', { name: 'Keep saved draft' }).click();
  await until(async () => (await readout().innerText()).includes('1/12'), 'Keep saved draft keeps the runtime catalogue');
  await composer().click(); await page.keyboard.press('Enter');
  await until(async () => (await sent()).length === 1, 'kept draft sent');
  assert.match((await sent())[0], /File: src\/alpha\.ts/, 'Keep saved draft keeps the runtime identity');
  check('recovery banner compares the pair; both choices swap or keep text+catalogue');

  // 6. Failure transitions preserve or clear exactly as the design requires.
  await mount('dom-send-fail', { sendError: 'send refused' });
  await pickFile('alpha');
  await composer().click(); await page.keyboard.press('Enter');
  await until(() => scope().locator('.surface-error').count(), 'send failure shown');
  assert.equal((await sent()).length, 0, 'a rejected send reached no provider');
  assert.equal(await value(), '@alpha.ts ', 'a failed send keeps the draft text');
  await until(async () => (await readout().innerText()).includes('1/12'), 'a failed send keeps the catalogue');
  check('a rejected send keeps both text and catalogue');

  await mount('dom-save-fail', { saveError: 'Draft revision conflict' });
  await pickFile('alpha');
  await composer().click(); await page.keyboard.press('Enter');
  await until(() => scope().locator('.surface-error').count(), 'revision-conflict failure shown');
  assert.equal((await sent()).length, 0, 'a revision conflict reached no provider');
  assert.equal(await value(), '@alpha.ts ', 'a revision conflict keeps the draft text');
  await until(async () => (await readout().innerText()).includes('1/12'), 'a revision conflict keeps the catalogue');
  check('a revision conflict keeps both text and catalogue');

  await mount('dom-clear-fail', { clearError: true });
  await pickFile('alpha');
  await composer().click(); await page.keyboard.press('Enter');
  await until(() => scope().getByText(/Message sent, but the draft could not be cleared/).count(), 'post-acceptance clear failure shown');
  await until(async () => (await value()) === '', 'the accepted message still clears the composer');
  assert.equal(await readout().count(), 0, 'the accepted message still clears the catalogue');
  check('a failed post-acceptance draft clear still clears text and catalogue');

  await mount('dom-storage');
  await page.evaluate(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('quota'); }; });
  await pickFile('alpha');
  await until(() => scope().getByText(/Local recovery is unavailable/).count(), 'storage failure surfaced');
  await until(() => scope().getByText(/Local recovery is unavailable/).count(), 'storage failure surfaced');
  assert.ok((await value()).includes('@alpha.ts '), 'the draft survives the storage failure');
  const saved = await until(async () => {
    const text = await page.evaluate(() => window.qa.state.savedDrafts.join('\n'));
    return text.includes('@alpha.ts') ? text : '';
  }, 'the runtime draft still received the mention pair');
  assert.ok(saved.includes('@alpha.ts'), 'the runtime draft still received the mention pair');
  await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
  check('a local storage failure surfaces an issue without losing the runtime draft');

  // 7. Identity overlap: a tray file and a mention are one block; chip and token are independent.
  await page.evaluate(id => localStorage.setItem(`threadterm.compose.context.${id}`, JSON.stringify([{ kind: 'file', id: 'attach-alpha', path: 'src/alpha.ts' }])), 'dom-overlap');
  await mount('dom-overlap');
  await until(async () => (await chips().count()) === 1, 'tray chip loaded');
  await pickFile('alpha');
  await until(async () => (await value()).includes('@alpha.ts '), 'mention of the attached file');
  assert.equal(await chips().count(), 1, 'mentioning an attached file does not duplicate the chip');
  await until(async () => (await readout().innerText()).startsWith('1/12'), 'overlap counts one identity');
  await setCaret('@alpha.ts'.length);
  await page.keyboard.press('Backspace');
  await until(async () => (await value()).trim() === '', 'token deleted');
  assert.equal(await chips().count(), 1, 'deleting the token keeps the tray chip');
  check('an identity shared by a tray item and a mention is one block; deleting the token keeps the chip');

  // 8. The send and queue paths serialize the identical immutable snapshot.
  await mount('dom-send');
  await pickFile('alpha');
  await composer().click(); await page.keyboard.press('Enter');
  await until(async () => (await sent()).length === 1, 'direct send recorded');
  const direct = (await sent())[0];
  const running = [{ id: 'a1', role: 'assistant', turnId: 't1', createdAt: 'now', parts: [{ type: 'text', text: 'working', status: 'streaming' }] }];
  await mount('dom-queue', { status: 'running', items: running, queue: { sessionId: 'dom-queue', paused: false, items: [] } });
  await pickFile('alpha');
  await composer().click(); await page.keyboard.press('Enter');
  await until(async () => (await queued()).length === 1, 'queued send recorded');
  assert.equal((await queued())[0], direct, 'send and queue serialize the same snapshot');
  check('the send and queue paths serialize the identical submission snapshot');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? 'COMPOSER MENTIONS DOM QA PASSED' : `COMPOSER MENTIONS DOM QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
