import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Windows QA initializes its helper directory and reuses the compiled helper', { skip: process.platform !== 'win32' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'tt-desktop-helper-'));
  try {
    const lib = join(scratch, 'qa', 'lib');
    const playwright = join(scratch, 'node_modules', '@playwright', 'test');
    await mkdir(lib, { recursive: true });
    await mkdir(playwright, { recursive: true });
    for (const name of ['desktop1.mjs', 'vdesk.cs']) {
      await cp(new URL(`./${name}`, import.meta.url), join(lib, name));
    }
    // Exercise the actual compiler and desktop validation without opening an app.
    await writeFile(join(playwright, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    await writeFile(join(playwright, 'index.mjs'), 'export const _electron = { calls: 0, async launch(options) { this.calls++; return options; } };');
    await writeFile(join(scratch, 'probe.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, rmSync, statSync } from 'node:fs';
      import { _electron } from '@playwright/test';
      import { electron } from './qa/lib/desktop1.mjs';
      const helper = new URL('./runtime/target-qa/vdesk.exe', import.meta.url);
      assert.equal(existsSync(new URL('./runtime', import.meta.url)), false);
      process.env.TT_QA_DESKTOP = '1';
      const options = await electron.launch({ args: ['qa-app'], env: { QA_MARKER: 'preserved' } });
      assert.ok(statSync(helper).size > 0);
      assert.equal(options.env.QA_MARKER, 'preserved');
      assert.equal(options.env.THREADTERM_V3_QA_AUTO_CONFIRM_QUIT, '1');
      assert.equal(options.env.TT_QA_DESKTOP_INDEX, '0');
      assert.equal(options.args.at(-1), 'qa-app');
      const modified = statSync(helper).mtimeMs;
      rmSync(new URL('./qa/lib/vdesk.cs', import.meta.url));
      await electron.launch();
      assert.equal(statSync(helper).mtimeMs, modified);
      process.env.TT_QA_DESKTOP = '2147483647';
      await assert.rejects(electron.launch(), /QA needs virtual desktop/);
      assert.equal(_electron.calls, 2, 'invalid desktop must not launch Electron');
      console.log('fresh compile, cached reuse and invalid desktop refusal passed');
    `);
    const output = execFileSync(process.execPath, [join(scratch, 'probe.mjs')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.match(output, /fresh compile, cached reuse and invalid desktop refusal passed/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
