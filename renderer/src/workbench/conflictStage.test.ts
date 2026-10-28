import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictStageReason, readConflictState, reviewConflictStage, type ConflictSavedState } from './conflictStage';
import { sourceControlMenuItems } from '../contextMenuSurfaceItems';

test('saved-file conflict policy blocks unchecked and parseable files in both languages', () => {
  for (const zh of [false, true]) {
    assert.ok(conflictStageReason(undefined, zh));
    const reason = conflictStageReason({kind:'markers'}, zh);
    assert.ok(reason);
    const item = sourceControlMenuItems({zh, staged:false, conflict:true, discardable:false, busy:false, canSend:false, stageReason:reason})[1];
    assert.equal(item.disabled, true);
    assert.equal(item.reason, reason);
  }
});

test('clear files allow staging; unknown and malformed files reach explicit confirmation', () => {
  for (const kind of ['clear', 'unknown', 'unparseable'] as const)
    assert.equal(conflictStageReason({kind}, false), undefined);
});

test('saved-file inspection reads fresh content and keeps its fingerprint for staging', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let content = '<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n';
  let failure: string | undefined;
  Object.defineProperty(globalThis, 'window', {configurable:true, value:{threadterm:{request:async (method:string, params:unknown) => {
    assert.equal(method, 'filesystem.read');
    assert.deepEqual(params, {projectId:'p', worktreePath:undefined, path:'a.ts'});
    if (failure) throw Error(failure);
    return {content, fingerprint:'disk-fingerprint'};
  }}}});
  try {
    assert.deepEqual(await readConflictState({projectId:'p'}, 'a.ts'), {kind:'markers', fingerprint:'disk-fingerprint'});
    content = '<<<<<<< truncated\n';
    assert.equal((await readConflictState({projectId:'p'}, 'a.ts')).kind, 'unparseable');
    content = 'resolved\n';
    assert.equal((await readConflictState({projectId:'p'}, 'a.ts')).kind, 'clear');
    failure = 'binary_file';
    assert.deepEqual(await readConflictState({projectId:'p'}, 'a.ts'), {kind:'unknown'});
    failure = 'file_not_found';
    assert.deepEqual(await readConflictState({projectId:'p'}, 'a.ts'), {kind:'clear'});
    for (failure of ['file_too_large', 'path_escape', 'unknown_method'])
      assert.deepEqual(await readConflictState({projectId:'p'}, 'a.ts'), {kind:'unknown'});
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});


test('every mutation review blocks parseable saved markers even after an earlier confirmation', async () => {
  const read = async ():Promise<ConflictSavedState> => ({kind:'markers', fingerprint:'new'});
  await assert.rejects(reviewConflictStage({projectId:'p'}, ['a'], false, {a:{kind:'unknown'}}, read), /saved file still contains conflict markers/);
});

test('unknown and malformed reviews require explicit confirmation and retain all batch fingerprints', async () => {
  const states:Record<string,ConflictSavedState>={a:{kind:'unknown'},b:{kind:'unparseable',fingerprint:'b1'},c:{kind:'clear',fingerprint:'c1'}};
  const read = async (_scope:unknown,path:string) => states[path];
  const first=await reviewConflictStage({projectId:'p'}, ['a','b','c'], false, undefined, read);
  assert.deepEqual(Object.keys(first.warnings), ['a','b']);
  const accepted=await reviewConflictStage({projectId:'p'}, ['a','b','c'], false, first.warnings, read);
  assert.deepEqual(accepted, {warnings:{},fingerprints:{b:'b1',c:'c1'}});
  states.b={kind:'unparseable',fingerprint:'b2'};
  await assert.rejects(reviewConflictStage({projectId:'p'}, ['a','b','c'], false, first.warnings, read), /file_conflict/);
});

test('a changed unknown/malformed warning requires a new confirmation', async () => {
  const read = async ():Promise<ConflictSavedState> => ({kind:'unknown'});
  const next=await reviewConflictStage({projectId:'p'}, ['a'], false, {a:{kind:'unparseable'}}, read);
  assert.equal(next.warnings.a.kind,'unknown');
});

test('valid file names matching Object properties still require confirmation', async () => {
  const read = async ():Promise<ConflictSavedState> => ({kind:'unparseable',fingerprint:'saved'});
  const checked = await reviewConflictStage({projectId:'p'}, ['__proto__','constructor'], false, undefined, read);
  assert.deepEqual(Object.keys(checked.warnings), ['__proto__','constructor']);
  assert.equal(Object.hasOwn(checked.fingerprints, '__proto__'), true);
});

test('batch staging bounds inspection to 100 unique paths and confirms remaining unknown paths', async () => {
  let reads=0;
  const read=async ():Promise<ConflictSavedState> => {reads++;return {kind:'clear',fingerprint:'saved'};};
  const paths=Array.from({length:105},(_,index)=>String(index));
  const review=await reviewConflictStage({projectId:'p'}, [...paths,...paths],false,undefined,read);
  assert.equal(reads,100);
  assert.equal(Object.keys(review.warnings).length,5);
  assert.ok(Object.values(review.warnings).every(state=>state.kind==='unknown'));
});
