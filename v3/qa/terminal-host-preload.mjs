// Verify the production preload exposes host geometry metadata without Node access.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { terminalWindowArguments } from '../desktop/src/terminalEnvironment.ts';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-terminal-host-'));
const html = join(scratch, 'index.html');
await writeFile(html, '<!doctype html><meta charset="utf-8"><title>Terminal host metadata QA</title>');
await writeFile(join(scratch, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
app.whenReady().then(() => new BrowserWindow({show:false,webPreferences:{
  preload:${JSON.stringify(resolve('desktop-dist/preload.cjs'))},
  sandbox:true,contextIsolation:true,nodeIntegration:false,
  additionalArguments:${JSON.stringify(terminalWindowArguments(process.platform, release()))}
}}).loadFile(${JSON.stringify(html)}));
`);
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.threadterm));
  const result = await page.evaluate(() => ({
    platform: window.threadterm.platform,
    windowsPty: window.threadterm.windowsPty,
    nodeAccess: typeof window.require,
  }));
  assert.equal(result.nodeAccess, 'undefined');
  assert.equal(result.platform, process.platform);
  assert.deepEqual(result.windowsPty, process.platform === 'win32'
    ? { backend: 'conpty', buildNumber: Number(release().split('.')[2]) } : undefined);
  console.log(JSON.stringify({ passed: true, ...result }));
} finally {
  await app?.close();
}
