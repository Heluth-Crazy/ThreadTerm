// Drop-in for Playwright's `_electron` in real-app QA: launched apps open on virtual Desktop 1 (or TT_QA_DESKTOP,
// 1-based) without taking focus, so tests never disturb the desktop the user is working on. See desktop1-hook.cjs.
//   import { electron } from './lib/desktop1.mjs';   // instead of: import { _electron as electron } from '@playwright/test'
import { _electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const hook = join(import.meta.dirname, 'desktop1-hook.cjs');
const helper = join(root, 'runtime', 'target-qa', 'vdesk.exe');

function vdesk() {
  if (process.platform !== 'win32') return undefined;
  if (!existsSync(helper)) {
    const csc = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(csc, ['-nologo', `-out:${helper}`, join(import.meta.dirname, 'vdesk.cs')], { stdio: 'pipe' });
  }
  return helper;
}

/** 0-based index of the QA desktop; throws when it does not exist (never fall back to the user's desktop). */
function qaDesktop(exe) {
  const index = Math.max(0, Number(process.env.TT_QA_DESKTOP || '1') - 1);
  const [, count] = /count=(\d+)/.exec(execFileSync(exe, ['list'], { encoding: 'utf8' })) ?? [];
  if (!(index < Number(count))) throw new Error(`QA needs virtual desktop ${index + 1}; only ${count} exist`);
  return index;
}

export const electron = {
  async launch(options = {}) {
    const exe = vdesk();
    if (!exe) return _electron.launch(options);
    const index = qaDesktop(exe);
    return _electron.launch({
      ...options,
      args: ['-r', hook, ...(options.args ?? [])],
      env: { ...(options.env ?? process.env), TT_QA_VDESK: exe, TT_QA_DESKTOP_INDEX: String(index) },
    });
  },
};
