import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-file-drag-'));
const output = join(scratch, 'file-drag.mjs');
await build({ entryPoints: [resolve('renderer/src/fileDrag.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { FILE_DRAG_TYPE, fileDragData, readFileDrag } = await import(pathToFileURL(output).href);

assert.equal(FILE_DRAG_TYPE, 'application/x-threadterm-file');
const file = { projectId: 'p1', worktreePath: '\\\\?\\D:\\project\\ThreadTerm.delegates\\codex-1', path: 'src/main file.ts' };
assert.deepEqual(readFileDrag(fileDragData(file)), file, 'round trip keeps the worktree and spaces');
assert.deepEqual(readFileDrag(fileDragData({ projectId: 'p1', path: 'README.md' })), { projectId: 'p1', path: 'README.md' });

// Anything else dropped on a session pane is ignored rather than inserted.
for (const bad of [
  '', 'not json', '[]', 'null', '"src/a.ts"',
  JSON.stringify({ projectId: 'p1' }),
  JSON.stringify({ path: 'src/a.ts' }),
  JSON.stringify({ projectId: '', path: 'src/a.ts' }),
  JSON.stringify({ projectId: 'p1', path: 'C:\\Windows\\win.ini' }),
  JSON.stringify({ projectId: 'p1', path: '/etc/passwd' }),
  JSON.stringify({ projectId: 'p1', path: '../outside.txt' }),
  JSON.stringify({ projectId: 'p1', path: 'src//a.ts' }),
  JSON.stringify({ projectId: 'p1', path: 'src/a.ts\nrm -rf /' }),
  JSON.stringify({ projectId: 'p1', path: 'src/a.ts', worktreePath: 7 }),
  JSON.stringify({ projectId: 'p1', path: 'x'.repeat(4097) }),
]) assert.equal(readFileDrag(bad), undefined, bad.slice(0, 60));
console.log('file drag: ok');
