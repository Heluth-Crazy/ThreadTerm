import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePagePick } from './pageCommentsCore.js';
import { isLocalHtmlPreviewUrl } from '../../renderer/src/htmlPreviewUrl.js';
import { addPageComment, loadReviewComments } from '../../renderer/src/reviewComments.js';

test('saved HTML selections survive desktop validation and persisted comment reload', async () => {
  const url = `tt-preview://${'a'.repeat(32)}/site/index.html?reload=1`;
  const pick = { url, title: 'Fixture', viewport: { width: 800, height: 600 }, target: { type: 'area', rect: { x: 1, y: 2, width: 30, height: 40 }, elements: ['Heading'] } };
  assert.deepEqual(sanitizePagePick(pick), pick);
  const rows = new Map<string, { draftId:string; scopeProjectId?:string; scopeRoot?:string; draft:unknown; revision:number; updatedAt:string }>();
  (globalThis as unknown as { window: unknown }).window = { threadterm: { request: async (method:string, params:Record<string, unknown>) => {
    if(method === 'reviewDrafts.importLegacy') return { imported:false, drafts:[...rows.values()] };
    if(method === 'reviewDrafts.list') return { drafts:[...rows.values()].filter(row=>row.scopeProjectId===params.scopeProjectId&&row.scopeRoot===params.scopeRoot) };
    if(method === 'reviewDrafts.upsert') { const row={draftId:params.draftId as string,scopeProjectId:params.scopeProjectId as string,scopeRoot:params.scopeRoot as string,draft:params.draft,revision:(params.expectedRevision as number)+1,updatedAt:'now'};rows.set(row.draftId,row);return {status:'ok',draft:row}; }
    throw new Error(method);
  }, onEvent: () => () => {} } };
  const scope = { projectId: 'fixture', root: '/workspace' };
  await addPageComment({ ...scope, ...sanitizePagePick(pick)!, body: 'Adjust the heading' });
  assert.equal((await loadReviewComments(scope)).length, 1);
});

test('comment URLs accept only the grant URL form, never host file or executable schemes', () => {
  for (const url of ['file:///private', 'data:text/html,hello', 'javascript:alert(1)', 'tt-preview://other/file.html', `tt-preview://${'a'.repeat(32)}:1/file.html`, `tt-preview://user@${'a'.repeat(32)}/file.html`]) {
    assert.equal(isLocalHtmlPreviewUrl(url), false, url);
    assert.throws(() => sanitizePagePick({ url, title: '', viewport: { width: 800, height: 600 }, target: { type: 'area', rect: { x: 0, y: 0, width: 20, height: 20 }, elements: [] } }));
  }
});
