import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { relativeToolPath, thoughtSummary, toolRow } from './toolRow';
import { grammarFor } from './codeHighlightEngine';
import { hasCodeFence } from './codeHighlight';

const en = (english: string) => english;
const zh = (_english: string, chinese: string) => chinese;
const command = (data: Record<string, unknown>, status = 'completed'): ChatPart =>
  ({ type: 'tool', toolId: 'c', toolName: 'commandExecution', status, data: { type: 'commandExecution', ...data } });

test('paths inside the session folder are shown relative to it, on any separator', () => {
  assert.equal(relativeToolPath('D:\\work\\src\\a.ts', 'D:\\work'), 'src/a.ts');
  assert.equal(relativeToolPath('d:/work/src/a.ts', 'D:\\work\\'), 'src/a.ts');
  assert.equal(relativeToolPath('E:/other/a.ts', 'D:\\work'), 'E:/other/a.ts');
  assert.equal(relativeToolPath('./src/a.ts'), 'src/a.ts');
});

test('a command Codex parsed as reads says which files it read', () => {
  const one = toolRow(command({ command: 'cat src/a.ts', commandActions: [{ type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'D:\\work\\src\\a.ts' }] }), zh, 'D:\\work');
  assert.deepEqual(one.lines.map(line => [line.icon, line.label, line.where, line.mono]), [['file', '读取 a.ts', 'src', undefined]]);
  assert.equal(one.live, '正在读取 a.ts');
  const many = toolRow(command({ command: 'x', commandActions: ['a', 'b', 'c'].map(name => ({ type: 'read', command: 'x', name: `${name}.ts`, path: `src/${name}.ts` })) }), en);
  assert.equal(many.lines[0]!.label, 'Read a.ts, b.ts and 1 more');
  const list = toolRow(command({ command: 'ls src', commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }] }), zh);
  assert.equal(list.lines[0]!.label, '列出 src');
});

test('a search command names its query, scope and hits; nothing found is a note, not a failure', () => {
  const found = toolRow(command({ command: 'rg -n foo src', aggregatedOutput: 'src/a.ts:1:foo\nsrc/b.ts:9:foo', commandActions: [{ type: 'search', command: 'rg -n foo src', query: 'foo', path: 'src' }] }), zh);
  assert.deepEqual([found.lines[0]!.label, found.lines[0]!.where], ['搜索 foo', 'src · 2 处']);
  const none = toolRow(command({ command: 'rg -n foo src', exitCode: 1, aggregatedOutput: '', commandActions: [{ type: 'search', command: 'rg -n foo src', query: 'foo' }] }, 'failed'), zh);
  assert.equal(none.status, 'complete');
  assert.equal(none.lines[0]!.note, '无匹配');
  assert.equal(none.exitCode, undefined);
});

test('any other command is shown as itself, and a failure says why on one line', () => {
  const row = toolRow(command({ command: 'pwsh -Command "npm test"', exitCode: 1, aggregatedOutput: '> vitest\n FAIL  a.test.ts\nAssertionError: expected 2 to be 1\n\n Tests  1 failed | 13 passed (14)' }, 'failed'), zh);
  assert.deepEqual([row.lines[0]!.label, row.lines[0]!.mono, row.exitCode], ['npm test', true, 1]);
  assert.equal(row.reason, 'Tests  1 failed | 13 passed (14)', 'the last line that names the failure');
  assert.equal(row.live, '正在运行 npm test');
  const mixed = toolRow(command({ command: 'cd src && npm test', commandActions: [{ type: 'unknown', command: 'cd src' }, { type: 'read', command: 'cat a', name: 'a' }] }), zh);
  assert.equal(mixed.lines[0]!.mono, true, 'a command with any unparsed step stays a command');
});

test('an edit is one line per file with its own counts', () => {
  const part: ChatPart = { type: 'tool', toolId: 'e', toolName: 'fileChange', status: 'completed', data: { type: 'fileChange', changes: [
    { path: 'D:\\work\\src\\queue.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1,2 @@\n+a\n+b' },
    { path: 'D:\\work\\src\\api.ts', kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@\n-a\n+b' },
  ] } };
  const row = toolRow(part, zh, 'D:\\work');
  assert.deepEqual(row.lines.map(line => [line.icon, line.label, line.where, line.added, line.removed]), [
    ['plus', '新建 queue.ts', 'src', 2, 0],
    ['diff', '修改 api.ts', 'src', 1, 1],
  ]);
  assert.equal(row.live, '正在修改 queue.ts 等 2 个文件');
  assert.equal(row.moreFiles, 0);
});

test('native read, search and web tools read the same way', () => {
  const read = toolRow({ type: 'tool', toolId: 'r', toolName: 'Read', status: 'completed', data: { input: { file_path: 'src/app.ts' } } }, en);
  assert.deepEqual([read.lines[0]!.label, read.lines[0]!.where], ['Read app.ts', 'src']);
  const grep = toolRow({ type: 'tool', toolId: 'g', toolName: 'Grep', status: 'completed', data: { input: { pattern: 'saveNote', path: 'src' } } }, zh);
  assert.equal(grep.lines[0]!.label, '搜索 saveNote');
  const web = toolRow({ type: 'tool', toolId: 'w', toolName: 'WebSearch', status: 'completed', data: { input: { query: 'vitest retry' } } }, zh);
  assert.equal(web.lines[0]!.label, '搜索网页 vitest retry');
});

test('a Codex reasoning heading is the thought title without Markdown markers', () => {
  assert.deepEqual(thoughtSummary('**Finding the save path**\n\nI need the hook first.'), { title: 'Finding the save path', body: 'I need the hook first.' });
  assert.deepEqual(thoughtSummary('- Check `api.ts` first\nthen the rest'), { title: 'Check api.ts first', body: '- Check `api.ts` first\nthen the rest' });
  assert.deepEqual(thoughtSummary(''), { title: '', body: '' });
});

test('fenced code names map onto the bundled grammars', () => {
  for (const [fence, grammar] of [['ts', 'ts'], ['typescript', 'ts'], ['bash', 'sh'], ['powershell', 'ps1'], ['py', 'py'], ['rust', 'rs'], ['yml', 'yaml'], ['c++', 'cpp']] as const) {
    assert.equal(grammarFor(fence), grammar, fence);
  }
  assert.equal(grammarFor('brainfuck'), undefined);
  assert.equal(hasCodeFence('text\n```ts\ncode\n```'), true);
  assert.equal(hasCodeFence('inline `code` only'), false);
});
