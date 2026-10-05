import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-palette-sessions-'));
const output = join(scratch, 'palette-sessions.mjs');
await build({ entryPoints: [resolve('renderer/src/paletteSessions.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { orderedPaletteSessions, paletteOrder, paletteSessionDetail, paletteSessionState } = await import(pathToFileURL(output).href);

const at = minute => `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`;
const session = (id, extra = {}) => ({ id, title: id, provider: 'codex', projectId: 'p1', mode: 'chat', status: 'idle', createdAt: at(1), updatedAt: at(1), ...extra });
const sessions = [
  session('idle-new', { activity: { state: 'idle', revision: 1 }, createdAt: at(9) }),
  session('ended', { status: 'exited', updatedAt: at(30) }),
  session('running', { status: 'running', activity: { state: 'running', revision: 1 }, createdAt: at(2) }),
  session('approval', { status: 'waiting', createdAt: at(3) }),
  session('history', { readOnly: true, updatedAt: at(20) }),
  session('archived', { archived: true, activity: { state: 'awaiting_input', revision: 1 }, updatedAt: at(10) }),
  session('input', { activity: { state: 'awaiting_input', revision: 1 }, createdAt: at(4) }),
];

// What waits for the user first, then running, then idle; ended, read-only and archived last by last update.
const order = paletteOrder(sessions);
assert.deepEqual(orderedPaletteSessions(sessions, order).map(row => row.id), ['input', 'approval', 'running', 'idle-new', 'ended', 'history', 'archived']);

// The order captured on open holds while states change; a session created since comes last.
const changed = sessions.map(row => row.id === 'idle-new' ? { ...row, status: 'waiting', activity: { state: 'awaiting_approval', revision: 2 } } : row);
changed.push(session('created-later', { status: 'waiting', createdAt: at(50) }));
assert.deepEqual(orderedPaletteSessions(changed, order).map(row => row.id), ['input', 'approval', 'running', 'idle-new', 'ended', 'history', 'archived', 'created-later']);
// A fresh capture (next time the palette opens) ranks them again.
assert.equal(orderedPaletteSessions(changed, paletteOrder(changed))[0].id, 'created-later');

assert.deepEqual(paletteSessionState(session('a', { status: 'waiting' }), false), { tone: 'needs', label: 'Awaiting approval' });
assert.deepEqual(paletteSessionState(session('b', { activity: { state: 'awaiting_input', revision: 1 } }), true), { tone: 'needs', label: '待继续' });
assert.deepEqual(paletteSessionState(session('c', { mode: 'terminal', status: 'running' }), false), { tone: 'running', label: 'Running' });
assert.deepEqual(paletteSessionState(session('d', { status: 'error', activity: { state: 'running', revision: 1 } }), false), { tone: 'failed', label: 'Failed' });
assert.deepEqual(paletteSessionState(session('e', { readOnly: true }), true), { tone: 'ended', label: '只读' });

const projects = [{ id: 'p1', name: 'ThreadTerm', path: '\\\\?\\D:\\project\\ThreadTerm' }];
assert.equal(paletteSessionDetail(session('main', { provider: 'claude', worktreePath: 'D:\\project\\ThreadTerm\\' }), projects, false), 'Claude Code · Idle · ThreadTerm');
assert.equal(paletteSessionDetail(session('tree', { provider: 'opencode', worktreePath: '\\\\?\\D:\\project\\ThreadTerm.delegates\\codex-1a2b' }), projects, true), 'OpenCode · 空闲 · ThreadTerm · codex-1a2b');
assert.equal(paletteSessionDetail(session('loose', { projectId: undefined, status: 'exited' }), projects, false), 'Codex · Ended');
console.log('palette sessions: ok');
