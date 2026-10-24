import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePagePick } from './pageCommentsCore.js';
import { isLocalHtmlPreviewUrl } from '../../renderer/src/htmlPreviewUrl.js';
import { addPageComment, loadReviewComments } from '../../renderer/src/reviewComments.js';

test('saved HTML selections survive desktop validation and persisted comment reload', () => {
  const url = `tt-preview://${'a'.repeat(32)}/site/index.html?reload=1`;
  const pick = { url, title: 'Fixture', viewport: { width: 800, height: 600 }, target: { type: 'area', rect: { x: 1, y: 2, width: 30, height: 40 }, elements: ['Heading'] } };
  assert.deepEqual(sanitizePagePick(pick), pick);
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const scope = { projectId: 'fixture', root: '/workspace' };
  addPageComment({ ...scope, ...sanitizePagePick(pick)!, body: 'Adjust the heading' }, store);
  assert.equal(loadReviewComments(scope, store).length, 1);
});

test('comment URLs accept only the grant URL form, never host file or executable schemes', () => {
  for (const url of ['file:///private', 'data:text/html,hello', 'javascript:alert(1)', 'tt-preview://other/file.html', `tt-preview://${'a'.repeat(32)}:1/file.html`, `tt-preview://user@${'a'.repeat(32)}/file.html`]) {
    assert.equal(isLocalHtmlPreviewUrl(url), false, url);
    assert.throws(() => sanitizePagePick({ url, title: '', viewport: { width: 800, height: 600 }, target: { type: 'area', rect: { x: 0, y: 0, width: 20, height: 20 }, elements: [] } }));
  }
});
