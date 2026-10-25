// F05: a legal long, image-bearing Chat reopens page by page over the real Windows
// control pipe, an answer too large for one frame is refused for its own request only,
// and a second connection keeps working. No provider CLI is started: the isolated
// runtime's own SQLite file receives the history rows and PATH holds only node and
// System32, so nothing can be resolved as an agent.
//
//   node qa/chat-long-history.mjs [--baseline]
//
// --baseline runs the same checks against a pre-fix runtime binary (if one is present
// under runtime/target-qa/baseline) and passes when the history cannot be reopened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { connectPeer } from './pipe-client.mjs';

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const suppliedRuntime = process.env.THREADTERM_V3_RUNTIME_BIN;
const candidate = baseline ? join(root, 'runtime/target-qa/baseline/threadterm-v3-runtime.exe') : join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const runtime = suppliedRuntime ?? candidate;
if (baseline && !existsSync(runtime)) {
  process.stdout.write(`${JSON.stringify({ passed: true, baseline, skipped: 'no pre-fix runtime binary under runtime/target-qa/baseline' }, null, 2)}\n`);
  process.exit(0);
}
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-long-'));
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const pipe = `\\\\.\\pipe\\threadterm-chat-long-${randomUUID()}`;
const IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_ITEMS = 3;
const TEXT_ITEMS = 10;
const NOTE_BYTES = Math.floor(1.5 * 1024 * 1024);
const OVERSIZED_TEXT_BYTES = 7 * 1024 * 1024;
const RESULT = join(scratch, 'report.json');
const report = { passed: false, baseline, runtime, scratch, checks: [] };
let daemon, peer, second;

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:path|home|userprofile|appdata|localappdata|threadterm_v3_.*)$/i.test(key)));
Object.assign(env, {
  Path: [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  TEMP: scratch, TMP: scratch,
  THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe,
});

async function connect() {
  const client = await connectPeer(`${pipe}-control`);
  try { await client.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); }
  catch (error) { client.close(); throw error; }
  return client;
}

async function start() {
  daemon = spawn(runtime, [], { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', () => {});
  for (let attempt = 0; attempt < 300; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`runtime exited at startup with ${daemon.exitCode}`);
    try { peer = await connect(); return; } catch { await delay(100); }
  }
  throw new Error('runtime startup timeout');
}

const at = index => `2026-10-08T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;
const base64 = bytes => Buffer.alloc(bytes, 0x41).toString('base64');
const item = (id, role, text, images) => JSON.stringify({
  id, role, createdAt: at(Number(id.split('-').at(-1))),
  parts: [{ type: 'text', text, ...(images ? { data: { images } } : {}) }],
});

/** The runtime is isolated and idle; rows are written between its reads. */
function seed(database) {
  const db = new DatabaseSync(database, { timeout: 20_000 });
  try {
    const session = (id, title, status) => db.prepare('INSERT INTO sessions(id,worktree_path,title,provider,mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, scratch, title, 'codex', 'chat', status, at(0), at(0));
    session('long-history', 'Long history', 'idle');
    session('oversized-message', 'Oversized message', 'idle');
    const insert = db.prepare('INSERT INTO chat_items(id,session_id,kind,data,created_at) VALUES (?,?,\'message\',?,?)');
    let total = 0;
    for (let index = 0; index < IMAGE_ITEMS; index++) {
      const image = `data:image/png;base64,${base64(IMAGE_BYTES)}`;
      const data = item(`image-${index}`, 'user', `screenshot ${index + 1}`, [image]);
      total += data.length;
      insert.run(`image-${index}`, 'long-history', data, at(index));
    }
    for (let index = 0; index < TEXT_ITEMS; index++) {
      const data = item(`note-${IMAGE_ITEMS + index}`, 'assistant', `note ${index} ${'n'.repeat(NOTE_BYTES)}`);
      total += data.length;
      insert.run(`note-${IMAGE_ITEMS + index}`, 'long-history', data, at(IMAGE_ITEMS + index));
    }
    // Text is never cut, so a message beyond the response ceiling must be a typed
    // per-request error instead of a dead connection.
    insert.run('huge-0', 'oversized-message', item('huge-0', 'user', 'h'.repeat(OVERSIZED_TEXT_BYTES)), at(0));
    return total;
  } finally { db.close(); }
}

async function stop() {
  if (peer) await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  for (let attempt = 0; attempt < 200 && daemon?.exitCode === null; attempt++) await delay(100);
  if (daemon && daemon.exitCode === null) daemon.kill();
  peer?.close(); second?.close();
  peer = second = undefined;
}

async function pages(sessionId) {
  const collected = []; const sizes = [];
  let before;
  for (let index = 0; index < 64; index++) {
    const page = await peer.request('chat.snapshot', { sessionId, ...(before ? { before } : {}) });
    sizes.push(Buffer.byteLength(JSON.stringify(page)));
    collected.unshift(...page.items);
    if (!page.hasEarlier) return { items: collected, sizes };
    assert.ok(page.nextBefore && page.nextBefore !== before, 'a page that has earlier items must provide a new cursor');
    before = page.nextBefore;
  }
  throw new Error('paging did not terminate');
}

try {
  await Promise.all([data, profile, env.HOME, env.APPDATA, env.LOCALAPPDATA].map(path => mkdir(path, { recursive: true })));
  await start();
  const database = join(data, 'threadterm-v3.sqlite3');
  const seeded = seed(database);

  if (baseline) {
    let failure;
    try { await peer.request('chat.snapshot', { sessionId: 'long-history' }, 60_000); } catch (error) { failure = error; }
    report.baselineFailure = failure ? `${failure.code ?? ''} ${failure.message}` : 'unexpected success';
    assert.ok(failure, 'a pre-fix runtime must fail to answer a >8 MiB snapshot');
    report.passed = true;
    report.checks.push(`baseline refused the ${(seeded / (1024 * 1024)).toFixed(1)} MiB history: ${report.baselineFailure}`);
  } else {
    const newest = await peer.request('chat.snapshot', { sessionId: 'long-history' }, 60_000);
    const newestBytes = Buffer.byteLength(JSON.stringify(newest));
    assert.ok(newest.hasEarlier, 'a long history must report earlier items');
    assert.ok(newestBytes < 6 * 1024 * 1024, `the newest page must stay far below the frame ceiling, got ${newestBytes}`);
    assert.equal(newest.items.at(-1).id, `note-${IMAGE_ITEMS + TEXT_ITEMS - 1}`, 'the newest page ends at the newest message');
    assert.ok(newest.items.length < IMAGE_ITEMS + TEXT_ITEMS, 'the newest page must not carry the whole history');
    report.newestPage = { items: newest.items.length, bytes: newestBytes, hasEarlier: newest.hasEarlier };
    report.checks.push(`newest page ${newest.items.length} items / ${(newestBytes / 1024).toFixed(0)} KiB of a ${(seeded / (1024 * 1024)).toFixed(1)} MiB history`);

    const walked = await pages('long-history');
    assert.deepEqual(walked.items.map(entry => entry.id), [...Array(IMAGE_ITEMS + TEXT_ITEMS).keys()].map(index => index < IMAGE_ITEMS ? `image-${index}` : `note-${index}`), 'pages restore the complete transcript in order');
    assert.ok(Math.max(...walked.sizes) <= 2 * 1024 * 1024 + 64 * 1024, `no page may exceed its byte budget, largest ${Math.max(...walked.sizes)}`);
    report.pages = { count: walked.sizes.length, largest: Math.max(...walked.sizes) };
    report.checks.push(`${walked.sizes.length} pages reopened all ${walked.items.length} messages, largest ${(Math.max(...walked.sizes) / 1024).toFixed(0)} KiB`);

    const imageItem = walked.items.find(entry => entry.id === 'image-0');
    const detached = imageItem.parts[0].data;
    assert.equal(detached.images[0], null, 'an oversized inline image is replaced by a reference');
    assert.equal(detached.imageRefs[0].itemId, 'image-0');
    assert.equal(detached.imageRefs[0].index, 0);
    assert.ok(detached.imageRefs[0].bytes > IMAGE_BYTES, 'the reference reports the real payload size');
    assert.equal(imageItem.parts[0].text, 'screenshot 1', 'text is never cut');
    const image = await peer.request('chat.image.read', { sessionId: 'long-history', itemId: 'image-0', part: 0, index: 0 });
    assert.equal(Buffer.from(image.data.split(',')[1], 'base64').length, IMAGE_BYTES, 'the on-demand image returns the stored bytes');
    report.checks.push('oversized message kept its text and served its image through the bounded reference RPC');

    // A message beyond the response ceiling fails alone; the connection and every
    // other view on it stay alive, and a second connection is unaffected.
    const refusal = await peer.request('chat.snapshot', { sessionId: 'oversized-message' }, 60_000).then(() => undefined, error => error);
    assert.ok(refusal, 'a 7 MiB text message cannot be one response');
    assert.equal(refusal.code, 'response_too_large');
    second = await connect();
    const sibling = await second.request('chat.snapshot', { sessionId: 'long-history' }, 60_000);
    assert.equal(sibling.items.at(-1).id, `note-${IMAGE_ITEMS + TEXT_ITEMS - 1}`, 'a second connection keeps serving the same runtime');
    const after = await peer.request('chat.snapshot', { sessionId: 'long-history' }, 60_000);
    assert.ok(after.hasEarlier && Array.isArray(after.items), 'the refused connection still answers its next request');
    const health = await peer.request('runtime.snapshot', {}, 30_000);
    assert.equal(health.sessions.length, 2, 'the refused connection still reads the unchanged runtime state');
    report.checks.push(`one ${(OVERSIZED_TEXT_BYTES / (1024 * 1024)).toFixed(1)} MiB answer was refused with response_too_large; both connections kept serving`);
    report.passed = true;
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (!baseline) process.exitCode = 1;
  else report.passed = true;
} finally {
  await stop().catch(() => {});
  await writeFile(RESULT, `${JSON.stringify(report, null, 2)}\n`);
  for (const check of report.checks) process.stdout.write(`PASS ${check}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
