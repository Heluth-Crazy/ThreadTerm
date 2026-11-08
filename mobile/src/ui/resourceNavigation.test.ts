import assert from 'node:assert/strict';
import test from 'node:test';
import { isGitTabSwitch } from './resourceNavigation';
import type { ResourceRoute } from './ResourceScreen';

const git: ResourceRoute = {kind:'git',machineId:'pc',projectId:'project',worktreePath:'C:/project'};
test('Git tabs replace their page, while child pages and other scopes push', () => {
  for (const view of ['status','history','branches'] as const) {
    assert.equal(isGitTabSwitch(git, {...git,view}), true);
  }
  assert.equal(isGitTabSwitch(git, {...git,kind:'diff',path:'index.ts',staged:false}), false);
  assert.equal(isGitTabSwitch(git, {...git,kind:'commit',commit:'abc'}), false);
  assert.equal(isGitTabSwitch({...git,kind:'files'},git), false);
  for (const change of [{machineId:'other'},{projectId:'other'},{worktreePath:'C:/other'}]) {
    assert.equal(isGitTabSwitch(git, {...git,...change}), false);
  }
});
