import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RUNTIME_LOG_MAX_BYTES, RuntimeLogWriter, redactRuntimeLogLine, rotateRuntimeLog } from './runtime-log.js';

test('runtime log rotates at 5 MiB and retains three files total', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-runtime-log-'));
  const log = join(directory, 'runtime.log');
  try {
    for (let index = 1; index <= 4; index += 1) {
      rotateRuntimeLog(log, 1);
      await writeFile(log, `active-${index}${'x'.repeat(RUNTIME_LOG_MAX_BYTES)}`);
    }
    assert.match(await readFile(`${log}.1`, 'utf8'), /^active-3/);
    assert.match(await readFile(`${log}.2`, 'utf8'), /^active-2/);
    assert.equal(existsSync(`${log}.3`), false);
    assert.equal(existsSync(`${log}.4`), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop log records are redacted, line-bounded, and joined across chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-runtime-log-'));
  const log = join(directory, 'runtime.log');
  try {
    const writer = new RuntimeLogWriter(log);
    writer.write('provider failure token=super-secret');
    writer.write('\nordinary diagnostic\n');
    writer.write('z'.repeat(5 * 1024));
    writer.finish();
    const contents = await readFile(log, 'utf8');
    assert.match(contents, /\[redacted runtime stderr line\]/);
    assert.match(contents, /ordinary diagnostic/);
    assert.match(contents, /\[truncated runtime log line\]/);
    assert.doesNotMatch(contents, /super-secret/);
    assert.equal(redactRuntimeLogLine('Authorization: Bearer abc'), '[redacted runtime stderr line]');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an oversized fragmented line discards its suffix through the newline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-runtime-log-'));
  const log = join(directory, 'runtime.log');
  try {
    const writer = new RuntimeLogWriter(log);
    writer.write(Buffer.from(`provider failure token=${'x'.repeat(5 * 1024)}`));
    writer.write(Buffer.from('SUPER_SECRET_SUFFIX\nnext diagnostic\n'));
    writer.finish();
    const contents = await readFile(log, 'utf8');
    assert.match(contents, /\[truncated runtime log line\]/);
    assert.match(contents, /next diagnostic/);
    assert.doesNotMatch(contents, /SUPER_SECRET_SUFFIX/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
