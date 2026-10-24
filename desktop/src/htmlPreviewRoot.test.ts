import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHtmlPreviewRoot } from './htmlPreviewRoot.js';

test('preview root is selected from the runtime project and its registered worktrees', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'tt-html-root-'));
  const project = join(scratch, 'project'), tree = join(scratch, 'tree'), foreign = join(scratch, 'foreign');
  await Promise.all([project, tree, foreign].map(path => mkdir(path)));
  const catalog = {
    projects: async () => [{ id: 'project', name: 'Fixture', path: project, createdAt: '' }],
    worktrees: async () => [
      { id: 'tree', projectId: 'project', path: tree, branch: null, head: '', isMain: false, locked: false, missing: false },
      { id: 'other', projectId: 'other-project', path: foreign, branch: null, head: '', isMain: false, locked: false, missing: false },
    ],
  };
  assert.equal(await resolveHtmlPreviewRoot(catalog, { projectId: 'project' }), project);
  assert.equal(await resolveHtmlPreviewRoot(catalog, { projectId: 'project', worktreePath: tree }), tree);
  assert.equal(await resolveHtmlPreviewRoot(catalog, { projectId: 'project', worktreePath: join(project, '.') }), project);
  await assert.rejects(resolveHtmlPreviewRoot(catalog, { projectId: 'project', worktreePath: foreign }), /unavailable/);
  await assert.rejects(resolveHtmlPreviewRoot(catalog, { projectId: 'missing' }), /unavailable/);
  catalog.worktrees = async () => [{ id: 'tree', projectId: 'project', path: tree, branch: null, head: '', isMain: false, locked: false, missing: true }];
  await assert.rejects(resolveHtmlPreviewRoot(catalog, { projectId: 'project', worktreePath: tree }), /unavailable/);
});
