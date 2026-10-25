import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// Harnesses that need native views, OS input or the real app; they were moved to Desktop 1 by hand before this job and
// also stopped using the user's runtime/target build. They stay on this list so a rewrite cannot silently drop that.
for (const file of ['boot-splash-visual.mjs', 'workbench-live.mjs', 'browser-agent-tools-visual.mjs', 'chat-connect-visual.mjs', 'claude-chat-options-visual.mjs', 'codex-send-presentation.mjs', 'pane-terminal-resize.mjs']) {
  test(`${file} uses Desktop 1 and releases the shared Electron lock`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /import\s*\{\s*electron\s*\}\s*from\s*['"]\.\/lib\/desktop1\.mjs['"]/);
    assert.match(source, /releaseLock\s*=\s*await acquireElectronQaLock\(/);
    assert.match(source, /finally\s*\{[\s\S]*await releaseLock\?\.\(\)/);
    assert.doesNotMatch(source, /runtime\/target\/debug/);
  });
}

// The remaining visible harnesses moved to Desktop 1 with the shared lock (AC4). Same acquire/release contract; these
// still run fixtures that point at their own runtime binary, so only the launch hygiene is asserted here.
for (const file of [
  'cache-cleanup-smoke.mjs', 'chat-compose-visual.mjs', 'chat-event-overflow-luna.mjs', 'chat-event-overflow.mjs',
  'codex-chat-compose.mjs', 'codex-command-groups-luna.mjs', 'codex-compat-fixture.mjs', 'codex-compat-live.mjs',
  'codex-image-paste-live.mjs', 'codex-terminal-clipboard-probe.mjs', 'codex-terminal-image-live.mjs',
  'delegation-visual.mjs', 'editor-smoke.mjs', 'electron-smoke.mjs', 'floating-smoke.mjs', 'installed-smoke.mjs',
  'memory-baseline.mjs', 'native-notifications.mjs', 'orca-quick-wins-visual.mjs', 'parity-runtime-smoke.mjs',
  'provider-network-visual.mjs', 'relocation-desktop-lifecycle.mjs', 'send-latency-breakdown.mjs',
  'session-attention-live.mjs', 'tool-activity-luna.mjs', 'visual-smoke.mjs', 'workbench-agent-menu.mjs',
  'workbench-standalone-visual.mjs', 'workspace-live-probe.mjs',
]) {
  test(`${file} holds and releases the shared Electron QA lock`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /\.\/lib\/desktop1\.mjs['"]/);
    assert.match(source, /releaseLock\s*\?{0,2}=\s*await acquireElectronQaLock\(/);
    assert.match(source, /finally\s*\{[\s\S]*await releaseLock\?\.\(\)/);
  });
}

// A QA Electron window may never open on the desktop the user is working on: every qa/*.mjs that launches one goes
// through qa/lib/desktop1.mjs (virtual Desktop 1, never focused). Harnesses whose fixture window is created with
// show:false never reach the user's desktop and are exempt from the helper; anything else needs an entry here with its
// reason. The lock has no repo-wide rule yet — the harnesses above hold it, the rest of the back catalogue does not.
const allowList = new Map([
  // A deliberately visible, user-owned preview: the user opens it to look at the real app and the controller waits until
  // they exit it, so moving it to a virtual desktop would defeat its purpose.
  ['open-parity-preview.mjs', 'visible user-owned preview window'],
]);
const LAUNCH = /\b_?electron\.launch\s*\(/;
const USES_DESKTOP1 = /import\s*\{\s*electron\s*\}\s*from\s*['"]\.\/lib\/desktop1\.mjs['"]|import\(\s*['"]\.\/lib\/desktop1\.mjs['"]/;
const HIDDEN_WINDOW = /show\s*:\s*false|parity\/electron-static\.cjs/;

test('every Electron harness launches on Desktop 1', async () => {
  const directory = new URL('.', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.mjs')).sort();
  const offenders = [];
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8');
    if (!LAUNCH.test(source) || allowList.has(file) || USES_DESKTOP1.test(source)) continue;
    if (!HIDDEN_WINDOW.test(source)) offenders.push(`${file}: launches Electron but does not import ./lib/desktop1.mjs`);
  }
  assert.deepEqual(offenders, []);
});


test('every QA harness avoids the user development runtime build', async () => {
  const directory = new URL('.', import.meta.url);
  const files = (await readdir(directory)).filter(file => /\.(?:mjs|cjs)$/.test(file)).sort();
  const offenders = [];
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8');
    if (/runtime[\\/]target[\\/]/.test(source) || /['"]runtime['"]\s*,\s*['"]target['"]/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
