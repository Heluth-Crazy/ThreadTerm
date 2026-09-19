import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

test('build emits the official platform CLI beside the self-contained host', () => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const host = join('dist', 'claude-sdk-host.mjs');
  const cli = join('dist', `claude-sdk-cli${suffix}`);
  assert.ok(existsSync(host), 'build must emit the SDK host');
  assert.ok(existsSync(cli), 'build must emit the SDK native CLI');
  assert.ok(statSync(cli).size > 0, 'SDK native CLI must not be empty');
});
