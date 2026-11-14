import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileEntry } from '@threadterm/protocol';
import { createFilesReveal, requestFilesReveal, sameFilesScope, resolveFilesReveal } from './revealInFiles';

const scope = {projectId:'remote-project', worktreePath:'/remote/worktree', rootPath:'/remote/worktree'};
const entry = (path:string, kind:FileEntry['kind']='directory'):FileEntry => ({path, name:path.split('/').at(-1)!, kind});

test('repeated requests preserve provenance and always have a new identity', () => {
 const first = createFilesReveal(scope, 'deep\\nested\\file.ts'), second = createFilesReveal(scope, first.path);
 assert.notEqual(first.key, second.key);assert.equal(first.path, 'deep/nested/file.ts');
 assert.deepEqual(first.scope, scope);assert.notEqual(first.scope, scope);
 assert.equal(sameFilesScope(scope, {...scope, projectId:'local-project'}), false);
 assert.equal(sameFilesScope(scope, {...scope, worktreePath:'/other'}), false);
 assert.equal(sameFilesScope(scope, {...scope, worktreePath:undefined}), true);
});

test('requests reject external, escaping and ambiguous paths', () => {
 for(const path of ['', '/outside/file', 'C:\\outside', '../file', 'deep/../file', './file', 'a//b', 'a/']) assert.throws(() => createFilesReveal(scope, path), /invalid_path/);
});

test('dispatch carries the scoped path and a fresh request key through the shared host event', () => {
 const prior = globalThis.dispatchEvent, events:CustomEvent[] = [];
 globalThis.dispatchEvent = event => {events.push(event as CustomEvent);return true;};
 try {
  requestFilesReveal(scope, 'deep/file.ts');requestFilesReveal(scope, 'deep/file.ts');
  assert.equal(events[0].type, 'threadterm:workbench');
  assert.deepEqual(events[0].detail.reveal.scope, scope);
  assert.equal(events[0].detail.reveal.path, 'deep/file.ts');
  assert.equal(events[0].detail.key, events[0].detail.reveal.key);
  assert.notEqual(events[0].detail.key, events[1].detail.key);
 } finally { if(prior) globalThis.dispatchEvent = prior;else Reflect.deleteProperty(globalThis, 'dispatchEvent'); }
});

test('loads every ancestor from the root in order, including previously cached directories', async () => {
 const tree = {'':[entry('deep')], deep:[entry('deep/nested')], 'deep/nested':[entry('deep/nested/file.ts','file')]};
 const calls:string[] = [];
 const list = async (directory:string) => {calls.push(directory);return tree[directory as keyof typeof tree];};
 for(let index=0;index<2;index++) {
  const result = await resolveFilesReveal('deep/nested/file.ts', list);
  assert.equal(result.path, 'deep/nested/file.ts');assert.equal(result.missing, false);assert.deepEqual(result.expanded, ['', 'deep', 'deep/nested']);
 }
 assert.deepEqual(calls, ['', 'deep', 'deep/nested', '', 'deep', 'deep/nested']);
});

test('missing files or ancestor folders select the nearest existing directory, including root', async () => {
 const tree:Record<string,FileEntry[]> = {'':[entry('deep')], deep:[entry('deep/nested')], 'deep/nested':[]};
 const list = async (dir:string) => tree[dir];
 assert.equal((await resolveFilesReveal('deep/nested/missing.ts', list)).path, 'deep/nested');
 assert.equal((await resolveFilesReveal('deep/gone/missing.ts', list)).path, 'deep');
 const result = await resolveFilesReveal('gone/missing.ts', list);
 assert.equal(result.path, '');assert.equal(result.missing, true);
});

test('filtered paths remain in reveal results and list errors are not mistaken for missing files', async () => {
 const result = await resolveFilesReveal('.git/file', async dir => dir ? [entry('.git/file','file')] : [entry('.git')]);
 assert.equal(result.path, '.git/file');assert.deepEqual(result.expanded, ['', '.git']);
 await assert.rejects(resolveFilesReveal('deep/file', async () => {throw Error('permission_denied');}), /permission_denied/);
});
