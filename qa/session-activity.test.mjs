import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-session-activity-'));
const output = join(scratch, 'session-activity.mjs');
await build({ entryPoints: [resolve('renderer/src/sessionActivity.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { activityOrder, canAcknowledgeActivity, sessionActivity, sessionActivityLabel, sortSessionsByActivity } = await import(pathToFileURL(output).href);
const session = (id, activity, createdAt = '2026-09-30T00:00:00.000Z', mode = 'chat', status = 'idle', extra = {}) => ({ id, title: id, provider: 'codex', projectId: 'project', mode, status, createdAt, updatedAt: createdAt, ...(activity ? { activity } : {}), ...extra });

assert.equal(sessionActivity(session('waiting', undefined, undefined, 'chat', 'waiting')), 'awaiting_approval');
assert.equal(sessionActivity(session('running', undefined, undefined, 'chat', 'running')), 'running');
assert.equal(sessionActivity(session('idle', undefined, undefined, 'chat', 'idle')), 'idle');
assert.equal(sessionActivity(session('terminal', undefined, undefined, 'terminal', 'running')), 'unknown');
assert.equal(sessionActivityLabel('awaiting_input', true), '待继续');
assert.equal(sessionActivityLabel('unknown', false), 'Status unknown');
assert.equal(canAcknowledgeActivity(session('input', { state: 'awaiting_input', revision: 4 })), true);
assert.equal(canAcknowledgeActivity(session('approval', { state: 'awaiting_approval', revision: 4 })), false);
assert.equal(sessionActivity(session('ended-stale', { state: 'running', revision: 4 }, undefined, 'chat', 'exited')), 'unknown');
assert.equal(sessionActivity(session('error-stale', { state: 'awaiting_input', revision: 4 }, undefined, 'chat', 'error')), 'unknown');
assert.equal(sessionActivity(session('readonly-stale', { state: 'running', revision: 4 }, undefined, 'chat', 'idle', { readOnly: true })), 'unknown');
assert.equal(canAcknowledgeActivity(session('ended-input', { state: 'awaiting_input', revision: 4 }, undefined, 'chat', 'exited')), false);

const ordered = sortSessionsByActivity([
  session('idle', { state: 'idle', revision: 1 }, '2026-09-30T00:04:00.000Z'),
  session('run-old', { state: 'running', revision: 1 }, '2026-09-30T00:01:00.000Z'),
  session('approval', { state: 'awaiting_approval', revision: 1 }, '2026-09-30T00:03:00.000Z'),
  session('input', { state: 'awaiting_input', revision: 1 }, '2026-09-30T00:02:00.000Z'),
  session('run-new', { state: 'running', revision: 1 }, '2026-09-30T00:05:00.000Z'),
]).map(row => row.id);
assert.deepEqual(ordered, ['approval', 'input', 'run-new', 'run-old', 'idle']);
const frozen = activityOrder([session('first', { state: 'running', revision: 1 }), session('second', { state: 'awaiting_input', revision: 1 })]);
assert.deepEqual(sortSessionsByActivity([session('first', { state: 'awaiting_input', revision: 2 }), session('second', { state: 'running', revision: 2 })], frozen).map(row => row.id), ['second', 'first']);
console.log('session activity helper passed');
