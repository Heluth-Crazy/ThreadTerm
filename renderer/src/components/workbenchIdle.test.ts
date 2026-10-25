import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

// F16: the last two 5 s polls are gone. Both panels refresh from real worktree events only, so a
// visible panel costs nothing while nothing happens; the Electron harness qa/idle-workbench.mjs
// proves the same thing against the real runtime.
test('the workbench Git status refreshes from events and keeps no timer', () => {
  const file = source('renderer/src/components/WorkbenchSideBar.tsx');
  assert.doesNotMatch(file, /setInterval/, 'no polling clock');
  assert.match(file, /createRefreshQueue/, 'bursts coalesce into one refresh');
  assert.match(file, /eventTouchesWorktree\(/, 'worktree events drive the refresh');
  assert.match(file, /addEventListener\('visibilitychange'/, 'the window regaining visibility refreshes once');
  assert.match(file, /addEventListener\(FILES_CHANGED_EVENT/, 'local file writes refresh it');
  assert.match(file, /const refresh = useCallback/, 'the explicit Refresh button still works');
});

test('the Agent changes panel refreshes from review, worktree and turn events', () => {
  const file = source('renderer/src/components/AgentChangesView.tsx');
  assert.doesNotMatch(file, /setInterval/, 'no polling clock');
  assert.match(file, /createRefreshQueue/);
  assert.match(file, /eventTouchesWorktree\(/);
  assert.match(file, /kind === 'agentReview'/, 'reviewer progress still reloads the reviewer rows');
  assert.match(file, /'session\.status'/, 'a reviewer or the reviewed session finishing reloads them');
  assert.match(file, /addEventListener\('visibilitychange'/);
});

test('a Git mutation does not refresh the status a second time by hand', () => {
  const file = source('renderer/src/components/SourceControlView.tsx');
  assert.doesNotMatch(file, /await git\.refresh\(\)/, 'the runtime event is the only invalidation');
  assert.match(file, /onClick=\{\(\) => void git\.refresh\(\)\}/, 'the toolbar Refresh button stays');
});
