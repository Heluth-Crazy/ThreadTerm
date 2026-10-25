// F05 real-app proof for byte-budgeted Chat pages (qa/chat-long-history.mjs proves the runtime side).
//
// Four Chats are seeded into an isolated database before the app starts: a long image-bearing
// transcript whose pages are reached with the wheel and the "Load earlier messages" control, an
// image-only newest page that cannot scroll, a read-only import, and a message larger than one
// response. Desktop 1, a fake Codex app-server (no model, no account), PATH holding only that
// shim, Node and System32, and the shared Electron QA lock.
//
//   node qa/chat-long-history-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomFillSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(qa, 'fixtures/fake-codex-long-history.cjs');
const out = join(qa, 'results/chat-long-history-ui');
const scratchBase = resolve(process.env.TEMP || tmpdir());
const scratch = await mkdtemp(join(scratchBase, 'tt-chat-long-ui-'));
const appDir = join(scratch, 'app'), bin = join(scratch, 'bin'), work = join(scratch, 'work');
const data = join(scratch, 'data'), profile = join(scratch, 'profile');
const requestLog = join(scratch, 'codex-requests.jsonl');
const lock = resolve(scratchBase, 'qa-electron.lock');
const report = { passed: false, checks: [], screenshots: [], widths: {}, errors: [] };
let app, page, locked = false;

const LONG_ID = 'chat-long', STRIP_ID = 'image-only', IMPORT_ID = 'imported-history', HUGE_ID = 'oversized-message';
// A 900x900 RGBA PNG is ~4.3 MiB encoded: larger than one page, so the runtime detaches it to a reference.
const BIG = { width: 900, height: 900 };
// Wide and short: a newest page of two of these is shorter than the transcript viewport.
const STRIP = { width: 1024, height: 160 };
const NOTE_BYTES = Math.floor(1.6 * 1024 * 1024);
const PROSE = 'The conversation kept going while the agent worked through the plan. ';
const at = index => `2026-10-08T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;

const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch (caught) { last = caught; }
    if (Date.now() > end) throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
    await delay(120);
  }
}
const chat = id => page.locator(`[data-testid="session-chat-${id}"]`);
const chatLog = id => page.locator(`[data-chat-log="${id}"]`);
const items = id => chat(id).locator('[data-chat-item]');
const scrollHeight = id => chatLog(id).evaluate(log => log.scrollHeight);
async function wheelUp(id, times = 1) {
  await chatLog(id).hover();
  for (let index = 0; index < times; index++) { await page.mouse.wheel(0, -900); await delay(120); }
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, body) {
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const chunkBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(chunkBody));
  return Buffer.concat([length, chunkBody, sum]);
}
/** A valid 8-bit RGBA PNG. Stored deflate blocks keep its size independent of compression. */
function pngDataUrl({ width, height }) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  randomFillSync(raw);
  for (let row = 0; row < height; row++) raw[row * stride] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const suffix = id => Number(id.split('-').at(-1)) || 0;
const item = (id, role, text, images) => JSON.stringify({
  id, role, createdAt: at(suffix(id)),
  parts: [{ type: 'text', text, ...(images ? { data: { images } } : {}) }],
});

/** Rows are written while no view is open and the runtime is idle. */
function seed(database) {
  const big = pngDataUrl(BIG);
  const strip = pngDataUrl(STRIP);
  const db = new DatabaseSync(database, { timeout: 20_000 });
  try {
    db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES (?,?,?,?)').run('long-project', 'Long history QA', work, at(0));
    const session = db.prepare('INSERT INTO sessions(id,project_id,worktree_path,title,provider,mode,status,created_at,updated_at,read_only) VALUES (?,?,?,?,?,?,?,?,?,?)');
    session.run(LONG_ID, 'long-project', work, 'Long history chat', 'codex', 'chat', 'idle', at(0), at(0), 0);
    session.run(STRIP_ID, 'long-project', work, 'Image-only chat', 'codex', 'chat', 'idle', at(1), at(1), 0);
    session.run(HUGE_ID, 'long-project', work, 'Oversized message chat', 'codex', 'chat', 'idle', at(2), at(2), 0);
    session.run(IMPORT_ID, 'long-project', work, 'Imported history', 'codex', 'chat', 'exited', at(3), at(3), 1);
    const insert = db.prepare("INSERT INTO chat_items(id,session_id,kind,data,created_at) VALUES (?,?,'message',?,?)");
    const put = (sessionId, id, role, text, images) => {
      const data = item(id, role, text, images);
      insert.run(id, sessionId, data, at(suffix(id)));
      return Buffer.byteLength(data);
    };
    // Oldest first: two detached images, then one page of prose per message.
    let seeded = put(LONG_ID, 'image-0', 'user', 'screenshot 1', [big]);
    seeded += put(LONG_ID, 'image-1', 'user', 'screenshot 2', [big]);
    for (let index = 2; index < 6; index++) {
      seeded += put(LONG_ID, 'note-' + index, 'assistant', `Note ${index}. ${PROSE.repeat(Math.ceil(NOTE_BYTES / PROSE.length))}`);
    }
    for (let index = 0; index < 5; index++) put(STRIP_ID, 'strip-' + index, 'user', 'strip ' + index, [strip]);
    for (let index = 0; index < 3; index++) put(IMPORT_ID, 'saved-' + index, 'user', `Saved ${index}. ${PROSE.repeat(Math.ceil(NOTE_BYTES / PROSE.length))}`);
    put(HUGE_ID, 'huge-0', 'user', 'h'.repeat(7 * 1024 * 1024));
    return { seeded, sizes: { big: big.length, strip: strip.length } };
  } finally {
    db.close();
  }
}

function childEnv() {
  const value = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|temp|tmp|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|claude_config_dir|threadterm_v3_.*|tt_qa_.*)$/i.test(key)));
  Object.assign(value, {
    TEMP: scratchBase, TMP: scratchBase,
    // Only the shim, Node and System32: no real agent CLI can be resolved by accident.
    PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    CODEX_HOME: join(scratch, 'codex-home'),
    THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_CODEX_LONG_LOG: requestLog, THREADTERM_QA_CODEX_LONG_CWD: work,
  });
  assert.deepEqual(Object.keys(value).filter(key => key.toLowerCase() === 'path'), ['PATH'], 'exactly one PATH variable');
  return value;
}

/** The runtime is started once headlessly so the isolated database exists before the app does. */
async function prepareDatabase() {
  const pipe = `\\\\.\\pipe\\tt-long-history-seed-${randomUUID()}`;
  const daemon = spawn(runtime, [], { windowsHide: true, env: { ...childEnv(), THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe }, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', () => {});
  let peer;
  try {
    for (let attempt = 0; attempt < 300 && !peer; attempt++) {
      if (daemon.exitCode !== null) throw new Error(`seed runtime exited with ${daemon.exitCode}`);
      try { peer = await connectPeer(`${pipe}-control`); } catch { await delay(100); }
    }
    assert.ok(peer, 'seed runtime never opened its control pipe');
    await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
    const seeded = seed(join(data, 'threadterm-v3.sqlite3'));
    await peer.request('runtime.shutdown', { operationId: randomUUID() });
    return seeded;
  } finally {
    peer?.close();
    for (let attempt = 0; attempt < 100 && daemon.exitCode === null; attempt++) await delay(100);
    if (daemon.exitCode === null) daemon.kill();
  }
}

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true, minify: false } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'chat-long-history-ui-qa', version: '0.1.0', main: 'main.cjs' }));
}

async function applySettings(language, theme) {
  const snapshot = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language, theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(({ language, theme }) => document.documentElement.lang === language && document.documentElement.dataset.theme === theme, { language, theme });
}
async function shot(name, width) {
  if (width) await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].setContentSize(next, 900), width);
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name);
}

try {
  assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
  assert.ok(existsSync(fixture), `Missing fake Codex app-server: ${fixture}`);
  await rm(out, { recursive: true, force: true });
  await Promise.all([out, bin, work, data, profile, join(scratch, 'home'), join(scratch, 'codex-home')].map(path => mkdir(path, { recursive: true })));
  await writeFile(requestLog, '');
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  const sizes = await prepareDatabase();
  report.seeded = sizes;
  check(`seeded ${(sizes.seeded / (1024 * 1024)).toFixed(1)} MiB of history in an isolated database before launch`);

  await buildApp();
  const deadline = Date.now() + 40 * 60 * 1000;
  for (;;) {
    try { await mkdir(lock); locked = true; break; } catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; console.log('Waiting for the shared Electron QA lock'); await delay(15_000); }
  }
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: root, env: { ...childEnv(), THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-long-history-ui-${randomUUID()}` }, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(45_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 45_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await applySettings('en', 'light');

  // 1. The newest page renders and offers the control at the top of the transcript.
  await rpc('session.present', { sessionId: LONG_ID, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat(LONG_ID).locator('[data-chat-item="note-5"]').waitFor({ timeout: 45_000 });
  await until(async () => (await rpc('chat.connection', { sessionId: LONG_ID })).phase === 'ready', 'fake Codex connection');
  const newest = await items(LONG_ID).evaluateAll(nodes => nodes.map(node => node.dataset.chatItem));
  assert.deepEqual(newest, ['note-5'], `the newest page is one message, got ${newest.join(',')}`);
  const paging = chat(LONG_ID).locator('.chat-earlier-page .btn');
  assert.equal(await paging.innerText(), 'Load earlier messages', 'the control is a translated shared button');
  check('the newest page rendered one message and exposed the shared "Load earlier messages" control');

  // 2. The control is keyboard reachable and loads one page per press.
  await paging.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Load earlier messages', 'the control takes focus');
  await page.keyboard.press('Enter');
  await chat(LONG_ID).locator('[data-chat-item="note-4"]').waitFor();
  check('the control is keyboard reachable: Enter on the focused button loaded the previous page');

  // 3. The wheel pages up to the very first message.
  for (let step = 0; step < 12 && !(await chat(LONG_ID).locator('[data-chat-item="image-0"]').count()); step++) {
    const height = await scrollHeight(LONG_ID);
    await wheelUp(LONG_ID, 4);
    await until(async () => (await scrollHeight(LONG_ID)) > height, `page ${step + 1} prepended by the wheel`, 30_000).catch(() => {});
  }
  // One scroll-to-top load measured atomically: the wheel reaches the same handler.
  if (await chat(LONG_ID).locator('.chat-earlier-page .btn').count()) {
    const before = await chatLog(LONG_ID).evaluate(log => {
      log.scrollTop = 0;
      const rect = log.getBoundingClientRect();
      const node = [...log.querySelectorAll('[data-chat-item]')].find(row => row.getBoundingClientRect().bottom > rect.top + 2);
      return { id: node?.dataset.chatItem, top: node ? Math.round(node.getBoundingClientRect().top - rect.top) : undefined, height: log.scrollHeight };
    });
    await until(async () => (await scrollHeight(LONG_ID)) > before.height, 'page prepended at the top', 30_000);
    const after = await chatLog(LONG_ID).evaluate((log, id) => {
      const node = id ? log.querySelector(`[data-chat-item="${id}"]`) : null;
      return node ? Math.round(node.getBoundingClientRect().top - log.getBoundingClientRect().top) : undefined;
    }, before.id);
    if (before.id && after !== undefined) {
      report.anchor = { id: before.id, delta: Math.abs(after - before.top) };
      assert.ok(report.anchor.delta <= 8, `the message being read stays in place (${before.id} moved ${report.anchor.delta}px)`);
    }
  }
  for (let step = 0; step < 12 && !(await chat(LONG_ID).locator('[data-chat-item="image-0"]').count()); step++) {
    const height = await scrollHeight(LONG_ID);
    await chatLog(LONG_ID).evaluate(log => { log.scrollTop = 0; });
    await until(async () => (await scrollHeight(LONG_ID)) > height, `page ${step + 1} prepended`, 30_000).catch(() => {});
  }
  await chat(LONG_ID).locator('[data-chat-item="image-0"]').waitFor();
  assert.equal(await chat(LONG_ID).locator('.chat-earlier-page').count(), 0, 'the control disappears once the whole transcript is loaded');
  check(`the wheel paged up to the very first message${report.anchor ? `, keeping ${report.anchor.id} in place (${report.anchor.delta}px)` : ''}`);

  // 4. The oversized image is a reference on the wire and is painted through chat.image.read.
  const pages = [];
  let cursor;
  for (let index = 0; index < 16; index++) {
    const page = await rpc('chat.snapshot', { sessionId: LONG_ID, ...(cursor ? { before: cursor } : {}) });
    pages.unshift(...page.items);
    if (!page.hasEarlier || !page.nextBefore) break;
    cursor = page.nextBefore;
  }
  const first = pages.find(entry => entry.id === 'image-0');
  assert.equal(first.parts[0].data.images[0], null, 'the oversized image is a reference on the wire');
  assert.equal(first.parts[0].data.imageRefs[0].itemId, 'image-0');
  assert.equal(first.parts[0].text, 'screenshot 1', 'the message text is never cut');
  const served = await rpc('chat.image.read', { sessionId: LONG_ID, itemId: 'image-0', part: 0, index: 0 });
  assert.ok(served.data.length > 4 * 1024 * 1024, `chat.image.read served ${served.data.length} bytes`);
  const reference = chat(LONG_ID).locator('[data-chat-item="image-0"] img');
  // A reference has no intrinsic size yet, so its box is empty until the message is
  // scrolled into range: scroll the transcript to it like a reader would.
  await chatLog(LONG_ID).evaluate(log => {
    const node = log.querySelector('[data-chat-item="image-0"]');
    if (node) log.scrollTop = Math.max(0, node.offsetTop - 80);
  });
  await until(() => reference.evaluate((image, width) => image.complete && image.naturalWidth === width, BIG.width).catch(() => false), 'reference image painted from chat.image.read').catch(async error => {
    const state = await reference.evaluate(image => ({ complete: image.complete, width: image.naturalWidth, src: image.currentSrc.slice(0, 40), box: image.getBoundingClientRect().height })).catch(() => ({}));
    throw new Error(`${error.message} (${JSON.stringify(state)})`);
  });
  check(`the detached 900x900 image (${(sizes.sizes.big / (1024 * 1024)).toFixed(1)} MiB inline) was served by chat.image.read and painted`);
  await shot('01-first-message-reached-light-en-1440.png');

  // 5. An image-only newest page cannot scroll, so the next pages load by themselves.
  await rpc('session.present', { sessionId: STRIP_ID, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat(STRIP_ID).locator('[data-chat-item="strip-4"]').waitFor();
  const stripPage = await items(STRIP_ID).evaluateAll(nodes => nodes.map(node => node.dataset.chatItem));
  report.stripNewestPage = stripPage;
  await until(async () => (await items(STRIP_ID).count()) === 5, 'image-only transcript paged up without any input');
  const stripImages = await chat(STRIP_ID).locator('[data-chat-item] img').evaluateAll((images, width) => images.map(image => image.naturalWidth === width), STRIP.width);
  assert.ok(stripImages.length === 5 && stripImages.every(ok => ok), `every image painted (${stripImages.join(',')})`);
  check(`an image-only newest page (${stripPage.length} items, no scroll range) reached all five messages on its own`);

  // 6. A page larger than one response shows translated copy and the app stays connected.
  await rpc('session.present', { sessionId: HUGE_ID, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat(HUGE_ID).locator('.chat-repair-banner').waitFor();
  const banner = await chat(HUGE_ID).locator('.chat-repair-banner').innerText();
  assert.match(banner, /Saved history could not be checked/);
  assert.match(banner, /This part of the conversation is too large to load at once\./, `translated copy, got: ${banner}`);
  assert.doesNotMatch(banner, /response_too_large|Error invoking remote method|RuntimeRequestError/u, 'raw IPC text is never shown');
  assert.equal((await rpc('chat.connection', { sessionId: LONG_ID })).phase, 'ready', 'the other Chat is still connected after the refusal');
  assert.equal((await rpc('runtime.snapshot')).sessions.length, 4, 'the app still reads runtime state');
  assert.equal(await chat(LONG_ID).locator('[data-chat-item="image-0"]').count(), 1, 'the first Chat view still shows its transcript');
  await shot('02-oversized-message-light-en-1440.png');
  check('a response_too_large showed only translated copy and both Chat views kept working');

  // 7. A read-only import pages back through the same control.
  await rpc('session.present', { sessionId: IMPORT_ID, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const imported = page.locator('.imported-history-view');
  await imported.locator('.imported-history-scroll').waitFor();
  await until(async () => (await imported.locator('.history-transcript-item').count()) > 0, 'imported transcript loaded');
  assert.equal(await imported.locator('.history-transcript-item').count(), 1, 'the import shows its newest page');
  await imported.locator('.imported-history-earlier .btn').click();
  await until(async () => (await imported.locator('.history-transcript-item').count()) > 1, 'import page prepended');
  await imported.locator('.imported-history-earlier .btn').click();
  await until(async () => (await imported.locator('.imported-history-earlier').count()) === 0, 'import fully loaded');
  assert.equal(await imported.locator('.history-transcript-item').count(), 3, 'every imported message is reachable');
  check('an imported read-only transcript paged back through the same shared control');

  // 8. Screenshots: light/dark, en/zh-CN, wide and the narrowest width the window allows.
  // A locale change reloads the import to its newest page, so the control stays in frame.
  await applySettings('zh-CN', 'light');
  for (const theme of ['light', 'dark']) for (const locale of ['en', 'zh-CN']) {
    await applySettings(locale, theme);
    await imported.locator('.imported-history-earlier .btn').waitFor();
    await imported.locator('.imported-history-scroll').evaluate(node => { node.scrollTop = 0; });
    await shot(`03-paging-${theme}-${locale === 'zh-CN' ? 'zh' : 'en'}-1440.png`, 1440);
  }
  await applySettings('en', 'light');
  await imported.locator('.imported-history-earlier .btn').waitFor();
  report.minimumWindow = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(960, 900);
    return window.getMinimumSize();
  });
  await delay(400);
  report.widths.narrowWindow = await page.evaluate(() => window.innerWidth);
  report.widths.narrowTranscript = await page.locator('.imported-history-scroll').evaluate(node => Math.round(node.getBoundingClientRect().width));
  await shot('04-paging-light-en-narrow.png');
  await applySettings('zh-CN', 'dark');
  await imported.locator('.imported-history-earlier .btn').waitFor();
  await shot('05-paging-dark-zh-narrow.png');
  await applySettings('en', 'light');
  await rpc('session.present', { sessionId: STRIP_ID, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat(STRIP_ID).locator('[data-chat-item="strip-0"]').waitFor();
  await shot('06-image-only-paged-light-en-narrow.png');
  await applySettings('zh-CN', 'dark');
  await shot('07-image-only-paged-dark-zh-narrow.png');
  check(`screenshots: light/dark x en/zh-CN at 1440 and at the ${report.widths.narrowWindow}px minimum window`);

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  if (locked) await rm(lock, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  if (report.errors.length) report.passed = false;
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, screenshots: report.screenshots, widths: report.widths, error: report.error ?? report.errors[0] })}\n`);
}
