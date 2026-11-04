import assert from 'node:assert/strict';
import test from 'node:test';
import { addPageComment } from './reviewComments';

test('remote review uploads its screenshot before persisting draft and assetPaths', async () => {
  const calls: string[] = [], rows: unknown[] = [];
  const scope = { projectId: 'host-project', root: 'Z:/host' };
  (globalThis as unknown as { window: unknown }).window = { threadterm: {
    machineId: 'office',
    persistPageShot: async (id: string, session: string) => { calls.push('upload'); assert.equal(id, 'local-shot'); assert.equal(session, 'host-chat'); return { id: 'host-asset', path: 'Z:/host-data/attachments/host-asset/shot.png' }; },
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'reviewDrafts.importLegacy') return { imported: false, complete: true };
      if (method === 'reviewDrafts.list') return { drafts: rows };
      if (method === 'reviewDrafts.upsert') {
        calls.push('persist');
        const draft = params.draft as { shot: { id: string; path: string } };
        assert.equal(draft.shot.id, 'host-asset'); assert.deepEqual(params.assetPaths, [draft.shot.path]); assert.ok(!draft.shot.path.includes('client'));
        const row = { ...params, revision: 1, updatedAt: 'now' }; rows.push(row); return { status: 'ok', draft: row };
      }
      throw new Error(method);
    },
  } };
  const result = await addPageComment({ ...scope, url: 'https://example.invalid/', title: 'Host page', viewport: { width: 800, height: 600 }, target: { type: 'area', rect: { x: 0, y: 0, width: 100, height: 100 }, elements: [] }, shot: { id: 'local-shot', path: 'C:/client/shot.png', width: 100, height: 100, thumbnail: 'data:image/png;base64,YQ==' }, provenance: { previewId: 'preview', sessionId: 'host-chat' }, body: 'Review it' });
  assert.deepEqual(calls, ['upload', 'persist']); assert.equal(result.length, 1);
});
