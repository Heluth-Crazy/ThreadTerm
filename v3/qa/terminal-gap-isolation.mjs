// Real named-pipe regression for a corrupt terminal history alongside a
// healthy session.  It owns an isolated database and stops only its runtime.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {connectPeer} from './pipe-client.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/resume-qa/debug/threadterm-v3-runtime.exe'));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-gap-isolation-'));
const data = join(scratch, 'data');
const cwd = join(scratch, 'project');
const pipe = `\\\\.\\pipe\\threadterm-gap-${randomUUID()}`;
const environment = {...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe};
const database = join(data, 'threadterm-v3.sqlite3');
let daemon;
let control;
let output;

async function connect(name) {
  const peer = await connectPeer(name);
  try {
    await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
    return peer;
  } catch (error) {
    peer.close();
    throw error;
  }
}

async function start() {
  daemon = spawn(executable, [], {env: environment, windowsHide: true, stdio: 'ignore'});
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      control = await connect(`${pipe}-control`);
      return;
    } catch {
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw Error('isolated runtime exited while starting');
      await delay(100);
    }
  }
  throw Error('timed out starting isolated runtime');
}

async function stop() {
  control?.close(); control = undefined;
  output?.close(); output = undefined;
  if (!daemon || (daemon.exitCode !== null || daemon.signalCode !== null)) return;
  await Promise.race([
    new Promise(resolve => daemon.once('exit', resolve)),
    delay(10_000),
  ]);
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
}

async function shutdown() {
  await control.request('runtime.shutdown', {operationId: randomUUID()});
  await stop();
}

function parseOutputFrame(frame) {
  assert.ok(frame.length >= 5, 'output frame must include kind and JSON header length');
  const headerLength = frame.readUInt32LE(1);
  assert.ok(frame.length >= 5 + headerLength, 'output frame header is truncated');
  return {
    kind: frame[0],
    header: JSON.parse(frame.subarray(5, 5 + headerLength)),
    data: frame.subarray(5 + headerLength),
  };
}

async function nextOutput(timeout = 10_000) {
  return parseOutputFrame(await output.next(timeout));
}

async function seed(sql) {
  // This is exclusively our newly created temporary database, never user data.
  const connection = new DatabaseSync(database);
  try { connection.exec(sql); } finally { connection.close(); }
}

try {
  await mkdir(data); await mkdir(cwd);
  await start();
  const create = operationId => control.request('session.create', {
    cwd, provider: 'codex', mode: 'chat', operationId,
  });
  const bad = await create(randomUUID());
  const good = await create(randomUUID());
  await shutdown();

  const badFirst = Buffer.from('bad').toString('hex');
  const badLater = Buffer.from('gap').toString('hex');
  const goodFirst = Buffer.from('good-').toString('hex');
  const goodLater = Buffer.from('stream').toString('hex');
  await seed(`PRAGMA foreign_keys=ON;
    INSERT INTO output_chunks(session_id,start_cursor,data) VALUES ('${bad.id}',0,X'${badFirst}');
    INSERT INTO output_chunks(session_id,start_cursor,data) VALUES ('${bad.id}',8,X'${badLater}');
    INSERT INTO output_chunks(session_id,start_cursor,data) VALUES ('${good.id}',0,X'${goodFirst}');
    INSERT INTO output_chunks(session_id,start_cursor,data) VALUES ('${good.id}',5,X'${goodLater}');`);
  const badEnd = 11;

  await start();
  output = await connect(`${pipe}-output`);
  output.binary(3, {sessionId: bad.id, cursor: 0});
  output.binary(3, {sessionId: good.id, cursor: 0});
  output.binary(2, {sessionId: bad.id, credit: 1024});
  output.binary(2, {sessionId: good.id, credit: 1024});

  let gap;
  const goodBytes = [];
  for (let count = 0; count < 8 && (!gap || Buffer.concat(goodBytes).toString() !== 'good-stream'); count++) {
    const frame = await nextOutput();
    if (frame.kind === 4 && frame.header.sessionId === bad.id) gap = frame;
    if (frame.kind === 1 && frame.header.sessionId === good.id) goodBytes.push(frame.data);
  }
  assert.ok(gap, 'the corrupt session must receive an isolated gap frame');
  assert.equal(gap.header.cursor, badEnd, 'gap cursor must advance to bad durable end');
  assert.equal(gap.data.length, 0);
  assert.equal(Buffer.concat(goodBytes).toString(), 'good-stream', 'healthy session must fully stream on the same pipe');
  assert.ok(await control.request('runtime.health'), 'control pipe remains usable after peer gap');

  const recovered = Buffer.from('fixed').toString('hex');
  await seed(`INSERT INTO output_chunks(session_id,start_cursor,data) VALUES ('${bad.id}',${badEnd},X'${recovered}');`);
  // No extra credit: kind 4 has no payload and must retain the previous budget.
  let recovery;
  for (let count = 0; count < 4 && !recovery; count++) {
    const frame = await nextOutput();
    if (frame.kind === 1 && frame.header.sessionId === bad.id) recovery = frame;
  }
  assert.ok(recovery, 'bad subscription must deliver future output without fresh credit');
  assert.equal(recovery.header.cursor, badEnd);
  assert.equal(recovery.data.toString(), 'fixed');
  console.log(JSON.stringify({
    passed: true,
    checks: [
      'gap emits kind=4 only for the corrupt subscription',
      'healthy subscription fully streams on the same output pipe',
      'retained credit delivers contiguous bytes appended after the gap',
    ],
    scratch,
  }));
} finally {
  await shutdown().catch(() => {});
  await stop();
  await rm(scratch, {recursive: true, force: true});
}
