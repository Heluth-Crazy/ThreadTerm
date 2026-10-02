// Terminal file links over a real xterm buffer, with the runtime's existence check faked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');
const bundle = await build({ entryPoints: [resolve('renderer/src/components/terminalFileLinks.ts')], bundle: true, format: 'esm', platform: 'node', write: false, external: ['@xterm/xterm'] });
const modulePath = join(await mkdtemp(join(tmpdir(), 'threadterm-terminal-links-')), 'terminalFileLinks.mjs');
await writeFile(modulePath, bundle.outputFiles[0].text);
const { createFileLinkValidator, fileLinkStatusOf, provideTerminalFileLinks, terminalFileLinks } = await import(pathToFileURL(modulePath).href);

const terminalWith = async (cols, text) => {
  const terminal = new Terminal({ cols, rows: 12, allowProposedApi: true });
  await new Promise(done => terminal.write(text, done));
  return terminal;
};
const runtime = (existing, checked = []) => createFileLinkValidator(async path => { checked.push(path); return existing.includes(path) ? 'exists' : 'missing'; });
const shape = link => ({ text: link.text, from: [link.range.start.x, link.range.start.y], to: [link.range.end.x, link.range.end.y] });
const provided = async (terminal, line, validator, opened = []) =>
  (await provideTerminalFileLinks(terminal, line, reference => opened.push(reference), undefined, validator)).map(link => {
    link.activate({ ctrlKey: true, metaKey: false }, link.text);
    return shape(link);
  });

test('a tool-call wrapper is not part of the link', async () => {
  const terminal = await terminalWith(60, 'Update(src/tool.tsx)');
  assert.deepEqual(terminalFileLinks(terminal, 1, () => {}).map(shape), [{ text: 'src/tool.tsx', from: [8, 1], to: [19, 1] }]);
});

test('a path hard-wrapped by a TUI links both rows once the runtime finds it', async () => {
  // 7 + 31 columns: the first row reaches the right edge, the second is indented.
  const text = 'x Read(D:/repo/src/components/terminal\r\n  FileLinks.ts)';
  const terminal = await terminalWith(40, text);
  const full = 'D:/repo/src/components/terminalFileLinks.ts';
  const opened = [];
  assert.deepEqual(await provided(terminal, 1, runtime([full]), opened), [{ text: 'D:/repo/src/components/terminal', from: [8, 1], to: [38, 1] }]);
  assert.deepEqual(await provided(terminal, 2, runtime([full]), opened), [{ text: 'FileLinks.ts', from: [3, 2], to: [14, 2] }]);
  assert.deepEqual(opened, [{ path: full }, { path: full }]);
  // Neither half alone exists, so nothing is offered.
  assert.deepEqual(await provided(terminal, 1, runtime([])), []);
  assert.deepEqual(await provided(terminal, 2, runtime([])), []);
});

test('an absolute path with spaces is joined only when it exists', async () => {
  const terminal = await terminalWith(80, 'run C:/Program Files/nodejs/node.exe --version');
  assert.deepEqual((await provided(terminal, 1, runtime(['C:/Program Files/nodejs/node.exe']))).map(link => link.text), ['C:/Program Files/nodejs/node.exe']);
  assert.deepEqual(await provided(terminal, 1, runtime([])), []);
});

test('git diff prefixes fall back to the real path', async () => {
  const terminal = await terminalWith(80, '+++ b/src/app.ts');
  assert.deepEqual((await provided(terminal, 1, runtime(['src/app.ts']))).map(link => link.text), ['src/app.ts']);
  assert.deepEqual((await provided(terminal, 1, runtime(['b/src/app.ts']))).map(link => link.text), ['b/src/app.ts']);
});

test('paths the runtime cannot check keep their default reading', async () => {
  // Shell sessions reject relative lookups; the click still explains why.
  const unknown = createFileLinkValidator(async () => fileLinkStatusOf(new Error('file_reference_relative_requires_absolute')));
  const terminal = await terminalWith(80, 'modified: src/a.ts and 3.14');
  assert.deepEqual((await provided(terminal, 1, unknown)).map(link => link.text), ['src/a.ts']);
  assert.equal(fileLinkStatusOf(new Error('file_reference_not_found')), 'missing');
  assert.equal(fileLinkStatusOf(new Error('socket closed')), 'unknown');
});

test('soft-wrapped paths stay one link and short rows are not joined', async () => {
  const wrapped = await terminalWith(20, 'src/wrapped/path/to/file.ts:31');
  assert.deepEqual(await provided(wrapped, 2, runtime(['src/wrapped/path/to/file.ts'])), [{ text: 'src/wrapped/path/to/file.ts:31', from: [1, 1], to: [10, 2] }]);
  const checked = [];
  const listing = await terminalWith(80, 'src/a.ts\r\nsrc/b.ts');
  await provided(listing, 1, runtime([], checked));
  await provided(listing, 2, runtime([], checked));
  assert.deepEqual(checked, ['src/a.ts', 'src/b.ts']);
});

test('the Ctrl layer skips pending lookups and redraws when they settle', async () => {
  let answer;
  const validator = createFileLinkValidator(() => new Promise(done => { answer = done; }));
  let settled = 0;
  validator.onSettled(() => { settled += 1; });
  const terminal = await terminalWith(80, 'see src/a.ts');
  assert.deepEqual(terminalFileLinks(terminal, 1, () => {}, undefined, validator), []);
  assert.deepEqual(terminalFileLinks(terminal, 1, () => {}, undefined, validator), [], 'one lookup per path');
  answer('exists');
  await validator.settle('src/a.ts');
  assert.equal(settled, 1);
  assert.deepEqual(terminalFileLinks(terminal, 1, () => {}, undefined, validator).map(link => link.text), ['src/a.ts']);
});
