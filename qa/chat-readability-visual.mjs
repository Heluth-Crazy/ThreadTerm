// Visual QA for Chat readability (task 10-20-delegation-tool-ux): the shared tool-activity drawer and the
// "Delegated agents" strip, rendered from fixtures shaped like real provider data (Codex pwsh-wrapped command
// failures, ThreadTerm delegate_* JSON results, third-party MCP calls, Claude and ACP tool parts).
// Hidden Electron window; no runtime, no agent CLIs. Screenshots go to qa/results/chat-readability/<label>.
//   node qa/chat-readability-visual.mjs [label]
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const label = process.argv[2] || 'current';
const out = join(root, 'qa/results/chat-readability', label);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-readability-'));

const entry = String.raw`
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ToolActivity } from './renderer/src/components/ToolActivity';
import { DelegationPanel } from './renderer/src/components/DelegationPanel';
import './renderer/src/styles.css';

const tool = (id, toolName, status, data) => ({ id: 'item-' + id, itemId: 'item-' + id, part: { type: 'tool', toolId: id, toolName, status, data } });
const mcp = (id, server, name, args, text, status = 'completed') => tool(id, 'mcpToolCall', status, { type: 'mcpToolCall', server, tool: name, status, arguments: args, result: { content: [{ type: 'text', text }] } });
const unified = 'Failed to create unified exec process: helper_unknown_error: setup refresh had errors';
const pwsh = (id, script, command) => tool(id, 'commandExecution', 'failed', { type: 'commandExecution', status: 'failed', exitCode: -1, source: 'unifiedExecStartup', cwd: 'D:\\project\\ThreadTerm\\ThreadTerm-v3', aggregatedOutput: unified, command, commandActions: [{ type: 'unknown', command: script }] });
const workspaceJson = JSON.stringify({ agent: 'pi', branch: null, delegationId: 'e340d98f', sessionId: 'face82d9', state: 'starting', workspace: 'shared', workspacePath: '\\\\?\\D:\\project\\ThreadTerm\\ThreadTerm-v3' }, null, 2);

const fixtures = {
  // Screenshot 2: three Codex commands failed in the sandbox, plus two MCP calls.
  codexFailures: { provider: 'codex', active: false, entries: [
    pwsh('c1', "Get-Content -Raw .agents/skills/gitnexus-exploring/SKILL.md; Get-Command pi -ErrorAction SilentlyContinue | Select-Object Source", '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command \'Get-Content -Raw .agents/skills/gitnexus-exploring/SKILL.md; Get-Command pi -ErrorAction SilentlyContinue | Select-Object Source\''),
    pwsh('c2', 'Get-ChildItem -Force C:/Users/27968/.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode', '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command \'Get-ChildItem -Force C:/Users/27968/.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode\''),
    mcp('m1', 'threadterm', 'session_info', { session: 'face82d9' }, JSON.stringify({ id: 'face82d9', provider: 'pi', status: 'idle', cwd: '\\\\?\\D:\\project\\ThreadTerm\\ThreadTerm-v3' }, null, 2)),
    mcp('m2', 'codegraph', 'codegraph_explore', { query: 'pi provider command-code' }, '**Exploration: pi provider command-code**\n\nFound 21 symbols across 3 files.'),
    pwsh('c3', 'Get-ChildItem -Force C:\\Users\\27968\\.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode', '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command "Get-ChildItem -Force C:\\\\Users\\\\27968\\\\.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode"'),
  ] },
  // Screenshot 1: a finished delegation round (and a second delegation system's call).
  delegation: { provider: 'codex', active: false, entries: [
    mcp('d0', 'threadterm', 'delegate_status', {}, JSON.stringify({ availableAgents: ['codex', 'claude', 'pi'], delegates: [], maxActive: 4 }, null, 2)),
    mcp('d1', 'codex-agent-mesh', 'list_agents', {}, 'list_agents returned a validated durable mesh response.'),
    mcp('d2', 'threadterm', 'delegate_start', { agent: 'pi', prompt: 'Read README.md and summarize it.' }, workspaceJson),
    mcp('d3', 'threadterm', 'delegate_wait', { ids: ['e340d98f'] }, JSON.stringify({ allFinished: true, changed: ['e340d98f'] }, null, 2)),
    mcp('d4', 'threadterm', 'delegate_result', { id: 'e340d98f' }, workspaceJson),
  ] },
  // A live turn: a running command streams output.
  running: { provider: 'codex', active: true, entries: [
    tool('r0', 'commandExecution', 'completed', { type: 'commandExecution', status: 'completed', exitCode: 0, command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command \'rg -n "Delegated agents" renderer/src\'', commandActions: [{ type: 'search', command: 'rg -n "Delegated agents" renderer/src', query: 'Delegated agents' }], aggregatedOutput: 'renderer/src/components/DelegationPanel.tsx:31' }),
    tool('r1', 'commandExecution', 'inProgress', { type: 'commandExecution', status: 'inProgress', command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command \'cargo test --manifest-path runtime/Cargo.toml -j 2\'', commandActions: [{ type: 'unknown', command: 'cargo test --manifest-path runtime/Cargo.toml -j 2' }], aggregatedOutput: '   Compiling threadterm-v3-runtime v0.1.0\n    Finished test profile in 41.2s\n     Running unittests src/lib.rs\ntest delegation::tests::start_records_workspace ... ok' }),
  ] },
  // Claude Agent SDK and ACP (Kimi/Grok/OpenCode) tool shapes.
  claude: { provider: 'claude', active: false, entries: [
    tool('a1', 'Read', 'completed', { input: { file_path: 'renderer/src/components/ToolActivity.tsx' }, result: { content: 'export function ToolActivity(...)' } }),
    tool('a2', 'Grep', 'completed', { input: { pattern: 'delegation-panel', path: 'renderer/src' }, result: { content: 'Found 3 files' } }),
    tool('a3', 'Bash', 'completed', { input: { command: 'npm run typecheck:renderer' }, result: { content: '> tsc --noEmit\n' } }),
    tool('a4', 'mcp__threadterm__delegate_start', 'completed', { input: { agent: 'codex', prompt: 'Fix the bar' }, result: { content: [{ type: 'text', text: workspaceJson }] } }),
    tool('a5', 'Edit', 'failed', { input: { file_path: 'renderer/src/components/DelegationPanel.tsx', old_string: 'a', new_string: 'b' }, result: { content: 'String to replace not found in file.' }, is_error: true }),
  ] },
  acp: { provider: 'kimi', active: false, entries: [
    tool('k1', 'Shell', 'completed', { kind: 'execute', title: 'Shell', rawInput: { command: 'git status --short' }, content: [{ type: 'content', content: { type: 'text', text: ' M renderer/src/styles.css' } }] }),
    tool('k2', 'ReadFile', 'completed', { kind: 'read', title: 'ReadFile: renderer/src/delegation.ts', locations: [{ path: 'renderer/src/delegation.ts' }] }),
    tool('k3', 'SearchWeb', 'completed', { kind: 'fetch', title: 'Search web', rawInput: { query: 'React details summary sticky' } }),
  ] },
};

const now = '2026-10-20T23:07:00Z';
const session = (id, provider, title, extra = {}) => ({ id, provider, title, mode: 'chat', status: 'idle', createdAt: now, updatedAt: now, projectId: 'p', ...extra });
const parent = session('parent', 'codex', 'codex-chat-test5');
const delegate = (id, provider, title, state, extra = {}) => session(id, provider, title, { delegation: { id: 'd-' + id, parentSessionId: 'parent', workspace: 'shared', state, userMessages: 5, ...extra } });
const delegateSets = {
  mixed: [delegate('g1', 'codex', 'Codex: fix the delegation strip', 'running'), delegate('g2', 'claude', 'Claude: review the tool drawer', 'completed'), delegate('g3', 'pi', 'Pi reads the project README', 'failed')],
  finished: [delegate('g4', 'pi', 'Pi reads the project README', 'failed'), delegate('g5', 'pi', 'Pi reads README (provider updated)', 'failed')],
};
const outcomes = {
  g2: [{ id: 'x', role: 'assistant', createdAt: now, parts: [{ type: 'text', text: 'The drawer header repeats the tool name, and failed rows wrap over three lines. Recommend one summary line.' }] }],
  g3: [{ id: 'y', role: 'assistant', createdAt: now, parts: [{ type: 'error', text: '401: {"message":"Authentication Fails, Your api key: ****rj7a is invalid","type":"authentication_error"}' }] }],
  g4: [{ id: 'y', role: 'assistant', createdAt: now, parts: [{ type: 'error', text: '401: {"message":"Authentication Fails, Your api key: ****rj7a is invalid","type":"authentication_error"}' }] }],
  g5: [{ id: 'y', role: 'assistant', createdAt: now, parts: [{ type: 'error', text: '401: {"message":"Authentication Fails, Your api key: ****rj7a is invalid","type":"authentication_error"}' }] }],
};
window.threadterm = { onEvent: () => () => {}, request: async (method, params) => method === 'chat.read' ? (outcomes[params.sessionId] ?? []) : Promise.reject(Error('Unexpected ' + method)) };

const en = (english) => english;
function Gallery({ open, extra }) {
  return <div className="qa-gallery">
    {Object.entries(delegateSets).map(([name, base]) => { const delegates = extra && name === 'finished' ? [...base, delegate('g6', 'claude', 'Claude: a new delegate', 'completed')] : base; return <section key={name} data-qa={'delegation-' + name}>
      <h2>delegation: {name}</h2>
      <div className="qa-chat-frame"><DelegationPanel session={parent} delegates={delegates} onOpenSession={() => {}} copy={en} zh={false} /></div>
    </section>; })}
    {Object.entries(fixtures).map(([name, fixture]) => <section key={name} data-qa={'tools-' + name}>
      <h2>tools: {name}</h2>
      <div className="v3-chat-log qa-log"><ToolActivity key={name + String(open)} entries={fixture.entries} active={fixture.active} provider={fixture.provider} copy={en} /></div>
    </section>)}
  </div>;
}
const container = createRoot(document.getElementById('root'));
window.qaRender = ({ theme = 'light', open = false, extra = false } = {}) => {
  document.documentElement.dataset.theme = theme;
  flushSync(() => container.render(<Gallery open={open} extra={extra} />));
  if (open) for (const details of document.querySelectorAll('.chat-tool-activity')) details.open = true;
};
window.qaRender();
`;

await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{margin:0;background:var(--bg,#fff);color:var(--text)} #root{padding:16px} .qa-gallery{display:grid;gap:18px;max-width:880px} .qa-gallery h2{margin:0 0 6px;font:600 11px/1.4 ui-monospace,monospace;color:var(--faint);text-transform:uppercase} .qa-log{display:block;height:auto;overflow:visible;padding:0} .qa-chat-frame{display:flex;flex-direction:column;border:1px dashed var(--border)}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const report = { passed: false, label, screenshots: [], overflow: [], errors: [] };
let app;
try {
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.Path = [join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
  app = await electron.launch({ args: ['--disable-gpu', join(scratch, 'main.cjs')], env });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  for (const theme of ['light', 'dark']) for (const width of [1280, 560, 420]) for (const open of [false, true]) {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(next => window.qaRender(next), { theme, open });
    await page.waitForTimeout(250);
    for (const section of await page.locator('[data-qa]').all()) {
      const name = await section.getAttribute('data-qa');
      const file = `${name}-${theme}-${width}${open ? '-open' : ''}.png`;
      await section.screenshot({ path: join(out, file), animations: 'disabled' });
      report.screenshots.push(file);
      const wide = await section.evaluate(node => [...node.querySelectorAll('*')].some(child => child.scrollWidth > node.clientWidth + 2 && getComputedStyle(child).overflowX === 'visible' && child.getBoundingClientRect().right > node.getBoundingClientRect().right + 2));
      if (wide) report.overflow.push(file);
    }
  }
  // Strip interactions (last: Hide is remembered for the rest of the page).
  await page.evaluate(next => window.qaRender(next), { theme: 'light', open: false });
  const finished = page.locator('[data-qa="delegation-finished"]'), mixed = page.locator('[data-qa="delegation-mixed"]');
  const toggle = finished.locator('.delegation-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'finished delegates start collapsed');
  await toggle.click(); assert.equal(await finished.locator('.delegate-card').count(), 2, 'expand shows the cards');
  await toggle.click(); assert.equal(await finished.locator('.delegate-card').count(), 0, 'collapse hides the cards');
  assert.equal(await mixed.locator('.delegation-toggle').getAttribute('aria-expanded'), 'true', 'active delegates start expanded');
  assert.equal(await mixed.locator('.delegation-hide').count(), 0, 'no Hide while a delegate runs');
  await finished.locator('.delegation-hide').click();
  assert.equal(await finished.locator('.delegation-strip').count(), 0, 'Hide removes the finished strip');
  await page.evaluate(next => window.qaRender(next), { theme: 'light', open: false });
  assert.equal(await finished.locator('.delegation-strip').count(), 0, 'Hide survives a re-render');
  await page.evaluate(next => window.qaRender(next), { theme: 'light', open: false, extra: true });
  assert.equal(await finished.locator('.delegation-strip').count(), 1, 'a new delegate brings the strip back');
  await finished.screenshot({ path: join(out, 'delegation-finished-new-delegate.png') });
  report.checks = ['strip collapse/expand', 'no Hide while active', 'Hide + re-render', 'new delegate resurfaces'];
  assert.deepEqual(report.errors, [], 'no page errors');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (app) await app.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(`${report.passed ? 'CHAT READABILITY VISUAL PASSED' : 'CHAT READABILITY VISUAL FAILED'} (${report.screenshots.length} shots, overflow: ${report.overflow.length}); ${join(out, 'report.json')}`);
}
