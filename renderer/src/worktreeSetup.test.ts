import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, WorktreeSetupRun } from '@threadterm/protocol';
import { setupActions, setupCurrentSessionId, setupForRoot, setupStatusLine, setupStepLabel } from './worktreeSetup';

const run = (overrides: Partial<WorktreeSetupRun> = {}): WorktreeSetupRun => ({ id: 'setup-1', projectId: 'project-1', root: 'C:\\repo', commandIds: ['install', 'build'], names: ['npm install', 'npm run build'], step: 1, state: 'running', sessionIds: ['session-1', 'session-2'], trigger: 'manual', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', ...overrides });

test('worktree setup labels use the snapshot name and localize every terminal state', () => {
 assert.equal(setupStepLabel(run(), false), '2/2 · npm run build');
 assert.equal(setupStatusLine(run(), false), 'Setting up · 2/2 · npm run build');
 assert.equal(setupStatusLine(run({ state: 'completed' }), true), '已初始化');
 assert.equal(setupStatusLine(run({ state: 'failed', exitCode: 3 }), false), 'Setup failed at npm run build (exit 3)');
 assert.equal(setupStatusLine(run({ state: 'failed', exitCode: undefined }), false), 'Setup failed at npm run build');
 assert.equal(setupStatusLine(run({ state: 'cancelled' }), true), '初始化已取消');
 assert.equal(setupStatusLine(run({ state: 'interrupted' }), false), 'Setup interrupted');
});

test('worktree setup actions match the sequence state', () => {
 assert.deepEqual(setupActions(run(), 'session-2'), ['open']);
 assert.deepEqual(setupActions(run()), []);
 assert.deepEqual(setupActions(run({ state: 'failed' }), 'session-2'), ['open', 'retry', 'run']);
 assert.deepEqual(setupActions(run({ state: 'failed' })), ['retry', 'run']);
 assert.deepEqual(setupActions(run({ state: 'cancelled' })), ['run']);
});

test('worktree setup opens only the current step session for this sequence', () => {
 const setup = run({ id: 'retry-2', step: 1, sessionIds: ['old-step', 'failed-admission'] });
 const session = (id: string, runId: string, step: number): Session => ({ id, title: id, provider: 'custom', mode: 'terminal', status: 'exited', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', run: { commandId: 'build', name: 'build', kind: 'task', shell: 'cmd', setup: { runId, step, total: 2 } } });
 assert.equal(setupCurrentSessionId(setup, [session('old-step', 'retry-1', 0), session('current-step', 'retry-2', 1)]), 'current-step');
 assert.equal(setupCurrentSessionId(setup, [session('old-step', 'retry-1', 0)]), undefined);
});

test('worktree setup status selects the latest matching canonical root', () => {
 const older = run({ id: 'older', updatedAt: '2026-10-05T00:00:00.000Z' });
 const current = run({ id: 'current', root: '\\\\?\\C:\\REPO\\', updatedAt: '2026-10-07T00:00:00.000Z' });
 assert.equal(setupForRoot([older, current], 'c:/repo')?.id, 'current');
 assert.equal(setupForRoot([older], 'C:\\other'), undefined);
});
