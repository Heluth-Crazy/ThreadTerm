import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

test('MCP smoke prints and preserves its original failure when cleanup also fails', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../qa/mcp-smoke.mjs'), 'utf8');
  const start = source.indexOf('let primaryFailure;');
  assert.ok(start > 0, 'exercise the smoke script itself with fake process and filesystem boundaries');
  const original = new Error('original assertion failed');
  const locked = Object.assign(new Error('scratch database still locked'), {code: 'EBUSY'});
  const events = [];
  const result = runInNewContext(`(async () => { ${source.slice(start)} })()`, {
    runtimeExe: 'fake-runtime', env: {}, daemon: undefined,
    launch: () => { throw original; },
    peer: {close: () => events.push('peer closed')},
    children: new Set([{}]), scratch: 'fake-scratch',
    shutdownRuntime: async () => events.push('runtime exited'),
    stopChild: async () => events.push('helper exited'),
    removeScratch: async () => { events.push('scratch deletion'); throw locked; },
    console: {
      error: message => events.push(message),
      log: () => assert.fail('a failed smoke run must not print success'),
    },
  });
  await assert.rejects(result, error => error === original);
  assert.match(events[0], /MCP smoke original failure:.*original assertion failed/s);
  assert.deepEqual(events.slice(1, 5), ['runtime exited', 'peer closed', 'helper exited', 'scratch deletion']);
  assert.match(events[5], /cleanup failure.*scratch database still locked/s);
});
