import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NavigationDocuments, NavigationHistory, navigationKey, navigationLanguage } from './editorNavigation';

test('navigation history commits successful opens, branches and bounds itself', () => {
  const history = new NavigationHistory();
  const a = { path: 'a.ts', line: 1, column: 2 }, b = { path: 'b.ts', line: 3, column: 4 }, c = { path: 'c.ts', line: 5, column: 6 };
  assert.equal(history.target(-1), undefined);
  history.visit(a, b);
  assert.deepEqual(history.target(-1), a);
  // Looking up a target is non-mutating, including a failed file open.
  assert.deepEqual(history.target(-1), a);
  history.move(-1, b);
  assert.deepEqual(history.target(1), b);
  history.visit(a, c);
  assert.equal(history.canForward, false);
  for (let n = 0; n < 150; n++) history.visit({ ...c, line: n + 1 }, { ...c, line: n + 2 });
  let count = 0;
  while (history.canBack) { history.move(-1, c); count++; }
  assert.ok(count <= 99);
});

test('overlay snapshot prefers live dirty targets and current source, rejects ambiguous independent drafts', () => {
  const docs = new NavigationDocuments();
  const source = { path: 'a.ts', content: 'use(renamed)', dirty: true };
  const stored = [{ path: 'b.ts', content: 'old', dirty: true }];
  const live = [{ path: 'b.ts', content: 'new', dirty: true }, { ...source, content: 'other pane' }];
  const first = docs.snapshot(source, stored, live);
  assert.equal(first.find(doc => doc.path === 'b.ts')?.content, 'new');
  assert.equal(first.find(doc => doc.path === 'a.ts')?.content, source.content);
  assert.deepEqual(docs.snapshot(source, stored, live), first);
  assert.ok(docs.snapshot({ ...source, content: 'changed' }, stored, live).find(doc => doc.path === 'a.ts')!.version > first.find(doc => doc.path === 'a.ts')!.version);
  const previousTarget = first.find(doc => doc.path === 'b.ts')!.version;
  docs.snapshot(source, [], []);
  assert.ok(docs.snapshot(source, stored, live).find(doc => doc.path === 'b.ts')!.version > previousTarget);
  assert.throws(() => docs.snapshot(source, [], [live[0], { ...live[0], content: 'divergent' }]), /divergent_buffers/);
  assert.throws(() => docs.snapshot({ ...source, content: '中'.repeat(400_000) }, [], []), /too_large/);
});

test('semantic shortcut mapping excludes diff arrows and unrelated modifiers', () => {
  const key = (key: string, ctrlKey = false, altKey = false, shiftKey = false) => navigationKey({ key, ctrlKey, altKey, shiftKey, metaKey: false });
  assert.equal(key('b', true), 'definition');
  assert.equal(key('F12'), 'definition');
  assert.equal(key('F12', true), 'symbols');
  assert.equal(key('ArrowLeft', true, true), 'back');
  assert.equal(key('ArrowRight', false, true), undefined);
  assert.equal(key('b', true, false, true), undefined);
  assert.equal(navigationLanguage('foo.MTS'), 'typescript');
  assert.equal(navigationLanguage('foo.cjs'), 'javascript');
  assert.equal(navigationLanguage('foo.txt'), undefined);
});
