import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
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

test('MCP smoke keeps stdin open until delayed request responses arrive', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../qa/mcp-smoke.mjs'), 'utf8');
  const start = source.indexOf('function mcpRequest(');
  const end = source.indexOf('function baseRequests()', start);
  assert.ok(start > 0 && end > start, 'exercise the MCP request lifecycle from the smoke script');
  const stdout = new EventEmitter(), stderr = new EventEmitter(), stdin = new EventEmitter();
  stdout.setEncoding = () => {}; stderr.setEncoding = () => {};
  let written = '', ended = false;
  stdin.write = value => { written += value; };
  stdin.end = value => { written += value ?? ''; ended = true; };
  const child = new EventEmitter();
  Object.assign(child, {stdin, stdout, stderr});
  const mcpRequest = runInNewContext(`(() => { ${source.slice(start, end)}; return mcpRequest; })()`, {
    launch: () => child, mcpExe: 'fake-mcp', env: {}, setTimeout, clearTimeout,
  });
  const result = mcpRequest([{id: 1, method: 'initialize'}, {id: 2, method: 'tools/list'}]);
  assert.match(written, /initialize/);
  assert.equal(ended, false, 'EOF must not cancel delayed MCP work before its responses');
  stdout.emit('data', '{"id":1,"result":{}}\n{"id":2');
  assert.equal(ended, false, 'a partial response does not close stdin');
  stdout.emit('data', ',"result":{"tools":[]}}\n');
  assert.equal(ended, true, 'stdin closes only after every request response');
  child.emit('exit', 0);
  assert.deepEqual(JSON.parse(JSON.stringify(await result)), [{id: 1, result: {}}, {id: 2, result: {tools: []}}]);
});
