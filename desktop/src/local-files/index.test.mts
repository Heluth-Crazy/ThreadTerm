import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalFileBackend } from './index.ts';
import { RuntimeRequestError } from '../runtime-client.ts';
import type { FileRequestTarget } from './router.ts';

test('unsupported Runtime cannot strand backend selection or normal quit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tt-local-backend-compat-'));
  try {
    for (const code of ['unknown_method', 'desktop_files_unavailable'] as const) for (const initial of ['runtime', 'main'] as const) {
      const configPath = join(directory, `${initial}.json`);
      await writeFile(configPath, JSON.stringify({version:1, backend:initial}));
      const backend = createLocalFileBackend({
        configPath,
        coordination:async () => { throw new RuntimeRequestError({code,message:code}); },
        trashItem:async () => {},
      });
      const runtime = {request:async () => ({path:'file.txt',content:'existing runtime',fingerprint:'known',readonly:false,size:16,modifiedAt:''})} as FileRequestTarget;
      const message = code === 'unknown_method' ? /local_files_requires_restart/ : /supported on Windows only/;
      if (initial === 'runtime') await assert.rejects(backend.setBackend('main'), message);
      else await assert.rejects(backend.request('local', runtime, 'filesystem.read', {projectId:'project',path:'file.txt'}), message);
      assert.equal(await backend.setBackend('runtime'), 'runtime');
      const document = await backend.request('local', runtime, 'filesystem.read', {projectId:'project',path:'file.txt'});
      assert.equal(document.content, 'existing runtime');
      await backend.prepareToQuit(100);
    }
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'tt-local-backend-compat-')));
    await rm(directory, {recursive:true,force:true});
  }
});
