import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, WorktreeSetupRun } from '@threadterm/protocol';
import { activeSequenceForCommand, allocatedRunPort, sequenceChipText, setupRunForRoot } from './runSequence';
import { portPlaceholderHint, resolvedPortPreview } from './quickLaunch';

const run = (overrides: Partial<WorktreeSetupRun & {trigger:string;targetCommandId:string}> = {}) => ({
 id:'sequence-1', projectId:'project-1', root:'C:\\repo', commandIds:['db','api'], names:['db','api'], step:1,
 state:'running', sessionIds:[], trigger:'depends_on', targetCommandId:'api', createdAt:'2026-10-30T00:00:00.000Z', updatedAt:'2026-10-30T00:00:00.000Z', ...overrides,
}) as WorktreeSetupRun & {trigger:string;targetCommandId:string};

test('sequence chip reports its active step and does not expose terminal sequences', () => {
 assert.equal(sequenceChipText(run(), false), 'Starting api (2/2)…');
 assert.equal(sequenceChipText(run(), true), '正在启动 api（2/2）…');
 assert.equal(sequenceChipText(run({state:'failed',error:'dependency_failed: db'}), false), 'Dependency failed: db');
 assert.equal(sequenceChipText(run({state:'completed'}), false), undefined);
});

test('setup panel excludes dependency sequences and accepts canonical roots', () => {
 const setup = run({id:'setup-1', trigger:'manual', targetCommandId:undefined, root:'\\\\?\\C:\\REPO\\', state:'completed'});
 assert.equal(setupRunForRoot([run(), setup], 'c:/repo')?.id, 'setup-1');
 assert.equal(activeSequenceForCommand([run()], 'C:/repo', 'api')?.id, 'sequence-1');
});

test('allocated port is shown before readiness overwrites the observed port', () => {
 const session = {run:{commandId:'api', name:'api', kind:'service', shell:'cmd', allocatedPort:43123, port:43124}} as Session;
 assert.equal(allocatedRunPort(session), 43123);
});

test('port editor copy explains allocation and previews an existing reservation bilingually', () => {
 assert.equal(portPlaceholderHint(false), 'Use ${port} for a free port per worktree.');
 assert.equal(portPlaceholderHint(true), '使用 ${port} 为每个工作树分配空闲端口。');
 assert.equal(resolvedPortPreview(43123, false), 'Resolved port for this worktree: 43123');
});
