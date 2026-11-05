import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileService } from './files.ts';
import { createLocalFileTarget } from './service.ts';
import type { LocalFileCoordination } from './coordination.ts';

async function fixture(action: (folder: string, files: LocalFileService) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'tt-main-file-service-'));
  try { await action(folder, new LocalFileService({ trashItem: async () => { throw new Error('Unexpected trash call'); } })); }
  finally { await rm(folder, { recursive: true, force: true }); }
}
const references = { request: async () => { throw new Error('Unexpected external request'); } };

test('workspace window reads retain Runtime root authority and a read access lease', async()=>{
  await fixture(async(folder,service)=>{
    await writeFile(join(folder,'large.txt'),'first\r\nsecond €\r\nthird\n');
    const calls:string[]=[];
    const coordination:LocalFileCoordination=async(method,params)=>{
      calls.push(method);
      if(method==='desktop.files.access.begin')return {accessId:params.accessId};
      if(method==='desktop.files.access.release')return null;
      if(method==='desktop.files.context')return {kind:'workspace',projectId:'p',rootPath:folder};
      throw new Error(`unexpected ${method}`);
    };
    const target=createLocalFileTarget({service,coordination,references});
    const window=await target.request('filesystem.readWindow',{projectId:'p',path:'large.txt',offset:0,maxBytes:16});
    assert.equal(window.start,0);
    assert.ok(window.end>window.start);
    assert.ok(Buffer.byteLength(window.content,'utf8')<=16);
    assert.deepEqual(calls,['desktop.files.access.begin','desktop.files.context','desktop.files.access.release']);
  });
});

test('mutation receipts replay before consulting filesystem and unknown completion never aborts', async () => {
  await fixture(async (folder, service) => {
    await writeFile(join(folder, 'a.txt'), 'old');
    const before = await service.read(folder, { path: 'a.txt' });
    const calls: string[] = [];
    let replay = false;
    const coordination: LocalFileCoordination = async (method, params) => {
      calls.push(method);
      if (method === 'desktop.files.access.begin') return { accessId: params.accessId };
      if (method === 'desktop.files.access.release') return null;
      if (method === 'desktop.files.mutation.begin') return replay ? { kind: 'replay', result: { ...before, content: 'saved receipt' } }
        : { kind: 'execute', reservationId: 'reservation', projectId: 'p', rootPath: folder };
      if (method.endsWith('.complete')) throw new Error('connection lost after save');
      throw new Error(`unexpected ${method}: ${JSON.stringify(params)}`);
    };
    const target = createLocalFileTarget({ service, coordination, references });
    const params = { projectId: 'p', path: 'a.txt', content: 'new', expectedFingerprint: before.fingerprint, operationId: 'save' };
    await assert.rejects(target.request('filesystem.write', params), /connection lost/);
    assert.equal(await readFile(join(folder, 'a.txt'), 'utf8'), 'new');
    assert.deepEqual(calls, ['desktop.files.access.begin', 'desktop.files.mutation.begin', 'desktop.files.mutation.complete', 'desktop.files.access.release']);
    await rm(join(folder, 'a.txt'));
    replay = true;
    assert.equal((await target.request('filesystem.write', params)).content, 'saved receipt');
  });
});

test('a fingerprint rejection aborts only a known no-effect reservation and preserves source', async () => {
  await fixture(async (folder, service) => {
    await writeFile(join(folder, 'a.txt'), 'outside change');
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const coordination: LocalFileCoordination = async (method, params) => {
      calls.push({ method, params });
      if (method === 'desktop.files.access.begin') return { accessId: params.accessId };
      return method === 'desktop.files.mutation.begin' ? { kind: 'execute', reservationId: 'reservation', projectId: 'p', rootPath: folder } : null;
    };
    const target = createLocalFileTarget({ service, coordination, references });
    await assert.rejects(target.request('filesystem.write', { projectId: 'p', path: 'a.txt', content: 'dirty draft', expectedFingerprint: 'stale', operationId: 'save' }), /file_conflict/);
    assert.equal(await readFile(join(folder, 'a.txt'), 'utf8'), 'outside change');
    assert.equal(calls[2].method, 'desktop.files.mutation.abort');
    assert.deepEqual(calls[2].params, { reservationId: 'reservation', effect: 'none' });
    assert.equal(calls[1].params.accessId, calls[0].params.accessId);
    assert.equal(calls[0].params.write, true);
    assert.equal(calls[3].method, 'desktop.files.access.release');
  });
});
