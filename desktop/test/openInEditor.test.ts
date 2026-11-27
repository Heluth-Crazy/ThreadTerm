import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { detectEditors, editorArguments, parseOpenInRequest, resolveOpenIn, type OpenInEditor } from '../src/openInEditor.js';

/* "Open in" (desktop/src/openInEditor.ts): which programs are offered, how each is started, and what it may open. */

const env = { localAppData: 'C:\\Users\\qa\\AppData\\Local', programFiles: 'C:\\Program Files', programFilesX86: 'C:\\Program Files (x86)' };
const files = new Set([
  join(env.localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
  join(env.localAppData, 'Programs', 'cursor', 'Cursor.exe'),
  join(env.programFiles, 'JetBrains', 'IntelliJ IDEA 2025.2', 'bin', 'idea64.exe'),
  join(env.programFiles, 'JetBrains', 'IntelliJ IDEA 2026.1', 'bin', 'idea64.exe'),
  join(env.localAppData, 'Programs', 'PyCharm', 'bin', 'pycharm64.exe'),
  join(env.localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'),
]);
const folders: Record<string, string[]> = {
  [join(env.programFiles, 'JetBrains')]: ['IntelliJ IDEA 2026.1', 'IntelliJ IDEA 2025.2'],
  [join(env.localAppData, 'Programs')]: ['Microsoft VS Code', 'cursor', 'PyCharm'],
};
const fs = { exists: (path: string) => files.has(path) || path in folders, list: (path: string) => folders[path] ?? [] };

test('only installed programs are offered, in picker order, and the newest JetBrains version wins', () => {
  const editors = detectEditors(env, fs);
  assert.deepEqual(editors.map(editor => editor.id), ['vscode', 'cursor', 'idea', 'pycharm', 'terminal']);
  assert.equal(editors.find(editor => editor.id === 'idea')?.exe, join(env.programFiles, 'JetBrains', 'IntelliJ IDEA 2026.1', 'bin', 'idea64.exe'));
  assert.deepEqual(detectEditors({}, { exists: () => false, list: () => [] }), [], 'nothing installed, nothing offered');
});

test('each program gets the arguments it understands: a folder as a workspace, a file at its line', () => {
  const file = { path: 'D:\\repo\\src\\app.ts', directory: false, line: 42 };
  const folder = { path: 'D:\\repo', directory: true };
  assert.deepEqual(editorArguments({ style: 'goto' }, file), ['--goto', 'D:\\repo\\src\\app.ts:42']);
  assert.deepEqual(editorArguments({ style: 'goto' }, { ...file, line: undefined }), ['D:\\repo\\src\\app.ts']);
  assert.deepEqual(editorArguments({ style: 'goto' }, folder), ['D:\\repo']);
  assert.deepEqual(editorArguments({ style: 'line' }, file), ['--line', '42', 'D:\\repo\\src\\app.ts']);
  assert.deepEqual(editorArguments({ style: 'path-line' }, file), ['D:\\repo\\src\\app.ts:42']);
  assert.deepEqual(editorArguments({ style: 'terminal' }, file), ['-d', 'D:\\repo\\src'], 'a terminal opens in the file’s folder');
  assert.deepEqual(editorArguments({ style: 'goto' }, { ...file, line: 0 }), ['D:\\repo\\src\\app.ts'], 'no line 0');
});

test('requests take only known keys, bounded text and a positive line', () => {
  assert.deepEqual(parseOpenInRequest({ editorId: 'vscode', projectId: 'p', path: 'src/a.ts', line: 3 }), { editorId: 'vscode', projectId: 'p', path: 'src/a.ts', line: 3 });
  for (const bad of [null, [], { editorId: 'vscode' }, { editorId: 'vscode', projectId: 'p', exe: 'calc.exe' }, { editorId: 'vscode', projectId: 'p', line: -1 },
    { editorId: 'vscode', projectId: 'p', line: 1.5 }, { editorId: 'vscode', projectId: 'p', path: 'a\nb' }, { editorId: '', projectId: 'p' }]) {
    assert.throws(() => parseOpenInRequest(bad), /Invalid open request/, JSON.stringify(bad));
  }
});

test('the target is the project root or a path inside it, and the editor must be one found here', async () => {
  const editors: OpenInEditor[] = [{ id: 'vscode', label: 'VS Code', exe: 'C:\\Code.exe', style: 'goto' }];
  const root = resolve('/qa/repo');
  const deps = {
    editors: () => editors,
    workspaceRoot: async () => root,
    canonical: async (path: string) => resolve(path),
    isDirectory: async (path: string) => path === root,
  };
  const opened = await resolveOpenIn({ editorId: 'vscode', projectId: 'p', path: 'src/a.ts', line: 7 }, deps);
  assert.deepEqual(opened.args, ['--goto', `${resolve(root, 'src/a.ts')}:7`]);
  assert.deepEqual((await resolveOpenIn({ editorId: 'vscode', projectId: 'p' }, deps)).args, [root], 'no path opens the root');
  await assert.rejects(resolveOpenIn({ editorId: 'vscode', projectId: 'p', path: '../outside.txt' }, deps), /outside its project/);
  await assert.rejects(resolveOpenIn({ editorId: 'vscode', projectId: 'p', path: resolve('/elsewhere/a.ts') }, deps), /Invalid file path/);
  await assert.rejects(resolveOpenIn({ editorId: 'notepad', projectId: 'p' }, deps), /not installed/);
});
