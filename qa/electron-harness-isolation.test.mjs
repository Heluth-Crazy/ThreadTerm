import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const file of ['boot-splash-visual.mjs', 'workbench-live.mjs', 'browser-agent-tools-visual.mjs', 'chat-connect-visual.mjs', 'claude-chat-options-visual.mjs', 'codex-send-presentation.mjs', 'pane-terminal-resize.mjs']) {
  test(`${file} uses Desktop 1 and releases the shared Electron lock`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /import\s*\{\s*electron\s*\}\s*from\s*['"]\.\/lib\/desktop1\.mjs['"]/);
    assert.match(source, /releaseLock\s*=\s*await acquireElectronQaLock\(/);
    assert.match(source, /finally\s*\{[\s\S]*await releaseLock\?\.\(\)/);
    assert.doesNotMatch(source, /runtime\/target\/debug/);
  });
}
