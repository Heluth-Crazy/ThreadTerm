import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { toolView, type ToolView } from './toolView';

interface Case { id: string; kind: ToolView['kind']; _unverified?: boolean; expect?: Record<string, unknown>; part: ChatPart }
interface Fixture { provider: string; note: string; cases: Case[] }

const directory = resolve(process.cwd(), 'renderer/src/fixtures/tool-parts');
const providers = ['claude', 'codex', 'acp', 'grok', 'opencode', 'pi'];
const corpus = providers.flatMap(provider => (JSON.parse(readFileSync(join(directory, `${provider}.json`), 'utf8')) as Fixture).cases.map(entry => ({ provider, entry })));

function assertCase(provider: string, entry: Case, view: ToolView) {
  const where = `${provider}/${entry.id}`;
  assert.equal(view.kind, entry.kind, `${where} kind`);
  assert.ok(view.title.length > 0, `${where} title`);
  const expect = entry.expect ?? {};
  switch (view.kind) {
    case 'edit': {
      assert.equal(view.files.length, expect.files, `${where} files`);
      if (expect.change) assert.equal(view.files[0]!.change, expect.change, `${where} change`);
      if (expect.changes) assert.deepEqual(view.files.map(file => file.change), expect.changes, `${where} changes`);
      assert.ok(view.files.every(file => file.path.length > 0), `${where} file path`);
      break;
    }
    case 'command': {
      assert.equal(view.command, expect.command, `${where} command`);
      if (expect.status) assert.equal(view.status, expect.status, `${where} status`);
      if (expect.exitCode !== undefined) assert.equal(view.exitCode, expect.exitCode, `${where} exitCode`);
      if (expect.actions) assert.deepEqual(view.actions, expect.actions, `${where} actions`);
      if (expect.background) assert.equal(view.background, true, `${where} background`);
      break;
    }
    case 'read': {
      assert.equal(view.path, expect.path, `${where} path`);
      if (expect.offset !== undefined) assert.equal(view.offset, expect.offset, `${where} offset`);
      if (expect.limit !== undefined) assert.equal(view.limit, expect.limit, `${where} limit`);
      break;
    }
    case 'search': {
      assert.equal(view.query, expect.query, `${where} query`);
      if (expect.path) assert.equal(view.path, expect.path, `${where} path`);
      if (expect.glob) assert.equal(view.glob, expect.glob, `${where} glob`);
      if (expect.flags) assert.deepEqual(view.flags, expect.flags, `${where} flags`);
      break;
    }
    case 'web': {
      if (expect.url) assert.equal(view.url, expect.url, `${where} url`);
      if (expect.query) assert.equal(view.query, expect.query, `${where} query`);
      break;
    }
    case 'todo': { assert.equal(view.done, expect.done, `${where} done`); assert.equal(view.total, expect.total, `${where} total`); break; }
    case 'skill': { if (expect.name) assert.equal(view.name, expect.name, `${where} skill`); break; }
    case 'subagent': break;
    case 'mcp': { if (expect.server) assert.equal(view.server, expect.server, `${where} server`); assert.equal(view.tool, expect.tool, `${where} tool`); break; }
    case 'image': { if (expect.path) assert.equal(view.path, expect.path, `${where} path`); if (expect.status) assert.equal(view.imageStatus, expect.status, `${where} image status`); break; }
    case 'compaction': break;
    case 'generic': { if (expect.name) assert.equal(view.name, expect.name, `${where} name`); break; }
  }
}

test('every A0 provider fixture maps to its expected view kind and fields', () => {
  assert.equal(corpus.length, 74);
  for (const { provider, entry } of corpus) assertCase(provider, entry, toolView(entry.part));
});

test('codex command actions classify reads, searches and listings without losing the command kind', () => {
  const [read] = corpus.filter(({ entry }) => entry.id === 'codex-command-read').map(({ entry }) => toolView(entry.part));
  assert.deepEqual(read && read.kind === 'command' ? read.actions : undefined, ['read']);
  const [find] = corpus.filter(({ entry }) => entry.id === 'pi-find').map(({ entry }) => toolView(entry.part));
  assert.equal(find?.kind, 'search');
});

test('command display unwraps real Codex shell wrappers while retaining the raw command', () => {
  const cases = [
    {
      command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command \'Get-Content -Raw .agents/skills/gitnexus-exploring/SKILL.md; Get-Command pi -ErrorAction SilentlyContinue | Select-Object Source\'',
      display: 'Get-Content -Raw .agents/skills/gitnexus-exploring/SKILL.md; Get-Command pi -ErrorAction SilentlyContinue | Select-Object Source', shell: 'pwsh',
    },
    {
      command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command \'Get-ChildItem -Force C:/Users/27968/.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode\'',
      display: 'Get-ChildItem -Force C:/Users/27968/.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode', shell: 'pwsh',
    },
    {
      command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command "Get-ChildItem -Force C:\\\\Users\\\\27968\\\\.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode"',
      display: 'Get-ChildItem -Force C:\\Users\\27968\\.pi -ErrorAction SilentlyContinue | Select-Object Name,Mode', shell: 'pwsh',
    },
  ];
  for (const { command, display, shell } of cases) {
    const view = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command } } as ChatPart);
    assert.equal(view.kind, 'command');
    if (view.kind === 'command') { assert.equal(view.command, command); assert.equal(view.display, display); assert.equal(view.shell, shell); assert.equal(view.title, `Run ${display}`); }
  }
});

test('command display recognizes bash and cmd wrappers without unwrapping encoded or plain commands', () => {
  const cases = [
    { command: "bash -lc 'npm test -- --runInBand'", display: 'npm test -- --runInBand', shell: 'bash' },
    { command: 'cmd /d /s /c "echo hello world"', display: 'echo hello world', shell: 'cmd' },
    { command: 'pwsh -EncodedCommand SGVsbG8=', display: 'pwsh -EncodedCommand SGVsbG8=', shell: 'pwsh' },
    { command: 'npm test', display: 'npm test', shell: undefined },
    { command: '"C:\\\\Program Files\\\\Example\\\\runner.exe" --flag', display: '"C:\\\\Program Files\\\\Example\\\\runner.exe" --flag', shell: undefined },
  ];
  for (const { command, display, shell } of cases) {
    const view = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command } } as ChatPart);
    assert.equal(view.kind, 'command');
    if (view.kind === 'command') { assert.equal(view.command, command); assert.equal(view.display, display); assert.equal(view.shell, shell); }
  }
});

test('an unbalanced shell wrapper falls back to its one action command', () => {
  const command = 'pwsh -Command "unterminated';
  const view = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command, commandActions: [{ command: 'git status --short' }] } } as ChatPart);
  assert.equal(view.kind, 'command');
  if (view.kind === 'command') { assert.equal(view.command, command); assert.equal(view.display, 'git status --short'); assert.equal(view.shell, undefined); }
});

test('command display preserves POSIX quoting details and only falls back after tokenization fails', () => {
  const prefix = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command: 'powershell -CoM "Get-ChildItem"' } } as ChatPart);
  assert.equal(prefix.kind, 'command');
  if (prefix.kind === 'command') { assert.equal(prefix.display, 'Get-ChildItem'); assert.equal(prefix.shell, 'powershell'); }

  const quoting = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command: 'pwsh -Command "Write-Output \\x \\\"quote\\\" \\$HOME \\`tick"' } } as ChatPart);
  assert.equal(quoting.kind, 'command');
  if (quoting.kind === 'command') assert.equal(quoting.display, 'Write-Output \\x "quote" $HOME `tick');

  const raw = '"C:\\\\Program Files\\\\Example\\\\runner.exe" --flag';
  const nonShell = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command: raw, commandActions: [{ command: 'should not replace the command' }] } } as ChatPart);
  assert.equal(nonShell.kind, 'command');
  if (nonShell.kind === 'command') assert.equal(nonShell.display, raw);

  const unbalanced = 'pwsh -Command "unterminated';
  const noAction = toolView({ type: 'tool', toolName: 'commandExecution', data: { type: 'commandExecution', command: unbalanced } } as ChatPart);
  assert.equal(noAction.kind, 'command');
  if (noAction.kind === 'command') { assert.equal(noAction.display, unbalanced); assert.equal(noAction.shell, undefined); }
});

test('malformed or unknown tool data is total and never throws', () => {
  const values: unknown[] = [undefined, null, '', 'not-an-object', 42, [], { type: 'tool', data: 'raw string' }, { type: 'tool', data: [] }, { type: 'tool', data: null },
    { type: 'tool', data: { input: 'not json' } }, { type: 'tool', data: { args: null } }, { type: 'tool', data: { command: ['not', 'a', 'string'] } },
    { type: 'tool', toolName: 'Bash', data: { input: { command: 42 } } }, { type: 'tool', toolName: 'Edit', data: { input: { edits: 'nope' } } }];
  for (const value of values) {
    const view = toolView(value as ChatPart);
    assert.equal(typeof view.kind, 'string');
    assert.equal(typeof view.title, 'string');
    assert.ok(view.title.length > 0);
    assert.ok(['running', 'complete', 'failed', 'cancelled', 'unknown'].includes(view.status));
  }
});

test('the same immutable part object reuses one memoized view', () => {
  const part = { type: 'tool', toolId: 'memo', toolName: 'Bash', status: 'running', data: { input: { command: 'npm test' } } } as ChatPart;
  assert.equal(toolView(part), toolView(part));
  assert.notEqual(toolView({ ...part }), toolView(part));
});

test('a web result keeps its full text, not a 160-character preview', () => {
  const long = Array.from({ length: 40 }, (_, index) => `result line ${index}`).join('\n');
  const view = toolView({ type: 'tool', toolId: 'web', toolName: 'WebFetch', status: 'complete', data: { input: { url: 'https://example.com/docs' }, rawOutput: long } } as ChatPart);
  assert.equal(view.kind, 'web');
  assert.equal(view.kind === 'web' ? view.result : undefined, long);
  assert.ok((view.kind === 'web' ? view.result?.length ?? 0 : 0) > 160);
});

test('an ACP delete without a diff is classified as a delete, not a modify', () => {
  const view = toolView({ type: 'tool', toolId: 'del', toolName: 'delete', status: 'completed', data: { kind: 'delete', rawInput: { path: 'src/old.ts' } } } as ChatPart);
  assert.equal(view.kind, 'edit');
  assert.equal(view.kind === 'edit' ? view.files[0]?.change : undefined, 'delete');
});

test('a replaced part with the same tool id exposes its new live output', () => {
  const first = { type: 'tool', toolId: 'cmd', toolName: 'Bash', status: 'running', data: { input: { command: 'npm test' }, aggregatedOutput: 'first output' } } as ChatPart;
  const second = { ...first, data: { input: { command: 'npm test' }, aggregatedOutput: 'second output' } } as ChatPart;
  const before = toolView(first), after = toolView(second);
  assert.notEqual(before, after);
  assert.equal(before.kind === 'command' ? before.output : undefined, 'first output');
  assert.equal(after.kind === 'command' ? after.output : undefined, 'second output');
});

test('2,000 mixed parts classify well inside the 50 ms budget', () => {
  const parts = Array.from({ length: 2_000 }, (_, index) => ({
    type: 'tool', toolId: `perf-${index}`, status: 'complete',
    toolName: index % 3 === 0 ? 'Bash' : index % 3 === 1 ? 'Read' : 'Grep',
    data: { input: { command: `npm run task-${index}`, file_path: `src/file-${index}.ts`, pattern: `symbol-${index}`, path: 'src' } },
  })) as ChatPart[];
  const started = performance.now();
  for (const part of parts) toolView(part);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `classifying 2,000 parts took ${elapsed.toFixed(1)} ms`);
});

test('an unquoted Windows path inside a shell wrapper keeps its backslashes', () => {
  const view = toolView({ type: 'tool', toolName: 'Bash', data: { input: { command: 'powershell.exe -Command Get-ChildItem C:\Users\me\.pi' } } } as ChatPart);
  assert.equal(view.kind, 'command');
  if (view.kind === 'command') { assert.equal(view.display, 'Get-ChildItem C:\Users\me\.pi'); assert.equal(view.shell, 'powershell'); }
});
