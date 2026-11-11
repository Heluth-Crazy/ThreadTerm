import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Method, RequestParams, RequestResult } from '@threadterm/protocol';
import { LocalFileBackendConfig, type LocalFileBackend } from './config.ts';
import { LocalFileRouter, type FileRequestTarget } from './router.ts';
import { registerLocalFileBackendIpc } from './ipc.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const target = (action: (method: string) => Promise<unknown>): FileRequestTarget => ({
  request: <M extends Method>(method: M, _params: RequestParams<M>) => action(method) as Promise<RequestResult<M>>,
});
const scope = { projectId: 'project', path: 'source.ts' };

test('preference is opt in, tolerates malformed settings and persists both choices', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tt-file-mode-'));
  try {
    const config = new LocalFileBackendConfig(join(folder, 'local-files.json'));
    assert.equal(await config.load(), 'runtime');
    for (const malformed of ['broken', 'null', '{"version":1,"backend":"fallback"}', '{"version":2,"backend":"main"}', 'x'.repeat(4097)]) {
      await writeFile(config.path, malformed);
      assert.equal(await config.load(), 'runtime');
    }
    for (const backend of ['main', 'runtime'] as const) {
      await config.save(backend);
      assert.equal(await new LocalFileBackendConfig(config.path).load(), backend);
      assert.deepEqual(JSON.parse(await readFile(config.path, 'utf8')), { version: 1, backend });
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('route defaults to runtime; remote and non-file requests never use main', async () => {
  const routes: string[] = [];
  const runtime = target(async method => { routes.push(`runtime:${method}`); return null; });
  const main = target(async method => { routes.push(`main:${method}`); return null; });
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => {} }, main);
  await router.request('local', runtime, 'filesystem.read', scope);
  await router.setBackend('main');
  await router.request('local', runtime, 'filesystem.read', scope);
  await router.request('peer', runtime, 'filesystem.read', scope);
  await router.request('local', runtime, 'draft.list', { projectId: 'project' });
  assert.deepEqual(routes, ['runtime:filesystem.read', 'main:filesystem.read', 'runtime:filesystem.read', 'runtime:draft.list']);
});

test('Word document reads follow the file backend and remote requests stay with their host', async () => {
  const routes: string[] = [];
  const runtime = target(async method => { routes.push(`runtime:${method}`); return { path: 'p', size: 1, offset: 0, fingerprint: 'f', chunk: '', eof: true }; });
  const main = target(async method => { routes.push(`main:${method}`); return { path: 'p', size: 1, offset: 0, fingerprint: 'f', chunk: '', eof: true }; });
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => {} }, main);
  const params = { projectId: 'project', path: 'report.docx', offset: 0, limit: 1024 };
  await router.request('local', runtime, 'filesystem.document.read', params);
  await router.setBackend('main');
  await router.request('local', runtime, 'filesystem.document.read', params);
  await router.request('local', runtime, 'filesystem.external.document.read', { id: 'external', offset: 0, limit: 1024 });
  await router.request('peer', runtime, 'filesystem.document.read', params);
  assert.deepEqual(routes, ['runtime:filesystem.document.read', 'main:filesystem.document.read', 'main:filesystem.external.document.read', 'runtime:filesystem.document.read']);
});

test('window reads use the selected backend and drain before lifecycle work', async () => {
  const project=deferred(), external=deferred(), removal=deferred(), log:string[]=[];
  const main=target(async method=>{log.push(`main:${method}`);if(method==='filesystem.readWindow')await project.promise;if(method==='filesystem.external.readWindow')await external.promise;return null;});
  const runtime=target(async method=>{log.push(`runtime:${method}`);if(method==='project.remove')await removal.promise;return null;});
  const router=new LocalFileRouter({load:async()=>'main',save:async()=>{}},main,undefined,async()=>{log.push('release pending access');});
  const workspace=router.request('local',runtime,'filesystem.readWindow',{...scope,offset:0});
  const registered=router.request('local',runtime,'filesystem.external.readWindow',{id:'external',offset:0});
  const removing=router.request('local',runtime,'project.remove',{id:'project',operationId:'remove'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(log,['main:filesystem.readWindow','main:filesystem.external.readWindow']);
  project.resolve();external.resolve();await Promise.all([workspace,registered]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(log,['main:filesystem.readWindow','main:filesystem.external.readWindow','release pending access','runtime:project.remove']);
  removal.resolve();await removing;
  await router.request('peer',runtime,'filesystem.external.readWindow',{id:'external',offset:0});
  assert.equal(log.at(-1),'runtime:filesystem.external.readWindow');
});

test('switch waits for admitted file work and queues later work behind persisted choice', async () => {
  const read = deferred(), write = deferred(), stored = deferred(), log: string[] = [];
  const runtime = target(async method => { log.push(method); await (method === 'filesystem.read' ? read.promise : write.promise); return null; });
  const main = target(async () => { log.push('main'); return null; });
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => { log.push('save'); await stored.promise; } }, main);
  const reading = router.request('local', runtime, 'filesystem.read', scope);
  const writing = router.request('local', runtime, 'filesystem.write', { ...scope, operationId: 'op', content: 'dirty content', expectedFingerprint: 'before' });
  const change = router.setBackend('main');
  const next = router.request('local', runtime, 'filesystem.read', scope);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['filesystem.read', 'filesystem.write']);
  read.resolve(); await reading;
  assert.equal(log.includes('save'), false);
  write.resolve(); await writing;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['filesystem.read', 'filesystem.write', 'save']);
  stored.resolve(); await Promise.all([change, next]);
  assert.deepEqual(log, ['filesystem.read', 'filesystem.write', 'save', 'main']);
});

test('failed persistence and main errors do not silently choose another backend', async () => {
  const runtime = target(async () => 'runtime'), main = target(async () => { throw new Error('access denied'); });
  const router = new LocalFileRouter({ load: async () => 'main', save: async () => { throw new Error('disk full'); } }, main);
  await assert.rejects(router.setBackend('runtime'), /disk full/);
  assert.equal(await router.getBackend(), 'main');
  await assert.rejects(router.request('local', runtime, 'filesystem.read', scope), /access denied/);
  await assert.rejects(router.setBackend('automatic'), /Invalid/);
});

test('unsupported main backend fails before persisting the selected mode', async () => {
  let persisted = false;
  const runtime = target(async () => 'original');
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => { persisted = true; } }, runtime,
    async backend => { if (backend === 'main') throw new Error('restart required'); });
  await assert.rejects(router.setBackend('main'), /restart required/);
  assert.equal(persisted, false);
  assert.equal(await router.getBackend(), 'runtime');
  assert.equal(await router.request('local', runtime, 'filesystem.read', scope), 'original');
});

test('mutations preserve arrival order across windows and failed earlier writes', async () => {
  const first = deferred(), log: string[] = [];
  const runtime = target(async method => { log.push(method); if (method === 'filesystem.create') { await first.promise; throw new Error('conflict'); } return null; });
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => {} }, runtime);
  const a = router.request('local', runtime, 'filesystem.create', { ...scope, kind: 'file', operationId: 'a' });
  const rejected = assert.rejects(a, /conflict/);
  const b = router.request('local', runtime, 'filesystem.delete', { ...scope, operationId: 'b' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['filesystem.create']);
  first.resolve(); await Promise.all([rejected, b]);
  assert.deepEqual(log, ['filesystem.create', 'filesystem.delete']);
});

test('preference IPC rejects untrusted, child and remote senders before changing settings', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => {} }, target(async () => null));
  registerLocalFileBackendIpc({ handle: (name, handler) => { handlers.set(name, handler as (...args: unknown[]) => unknown); } }, router,
    event => { if (!(event as unknown as { trusted: boolean }).trusted) throw new Error('untrusted'); },
    event => (event as unknown as { machine: string }).machine);
  const frame = {}, base = { trusted: true, machine: 'local', sender: { mainFrame: frame }, senderFrame: frame };
  const set = handlers.get('threadterm:local-files-set-backend')!;
  for (const event of [{ ...base, trusted: false }, { ...base, machine: 'remote' }, { ...base, senderFrame: {} }]) {
    assert.throws(() => set(event, 'main'));
    assert.equal(await router.getBackend(), 'runtime');
  }
  assert.equal(await set(base, 'main'), 'main');
});

test('root removal drains pending reads and saves before admitting later file access', async () => {
  const read = deferred(), write = deferred(), removal = deferred(), log: string[] = [];
  let readCount = 0;
  const main = target(async method => {
    log.push(method);
    if (method === 'filesystem.read' && readCount++ === 0) await read.promise;
    if (method === 'filesystem.write') await write.promise;
    return null;
  });
  const runtime = target(async method => { log.push(method); await removal.promise; return null; });
  const router = new LocalFileRouter({ load: async () => 'main', save: async () => {} }, main, undefined, async () => { log.push('release pending access'); });
  const reading = router.request('local', runtime, 'filesystem.read', scope);
  const writing = router.request('local', runtime, 'filesystem.write', { ...scope, content: 'saved', expectedFingerprint: 'before', operationId: 'save' });
  const removing = router.request('local', runtime, 'project.remove', { id: 'project', operationId: 'remove' });
  const later = router.request('local', runtime, 'filesystem.read', scope);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['filesystem.read', 'filesystem.write']);
  read.resolve(); await reading;
  assert.equal(log.includes('project.remove'), false);
  write.resolve(); await writing;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['filesystem.read', 'filesystem.write', 'release pending access', 'project.remove']);
  removal.resolve(); await Promise.all([removing, later]);
  assert.deepEqual(log, ['filesystem.read', 'filesystem.write', 'release pending access', 'project.remove', 'filesystem.read']);
});

test('quit waits for saved completion, rejects new local work, and cancellation resumes access', async () => {
  const completed = deferred(), log: string[] = [];
  const main = target(async method => { log.push(method); if (method === 'filesystem.write') await completed.promise; return null; });
  const runtime = target(async method => { log.push(`remote:${method}`); return null; });
  const router = new LocalFileRouter({ load: async () => 'main', save: async () => {} }, main, undefined, async () => { log.push('release pending access'); });
  const writing = router.request('local', runtime, 'filesystem.write', { ...scope, content: 'saved', expectedFingerprint: 'before', operationId: 'save' });
  let drained = false;
  const stopping = router.prepareToQuit().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  await assert.rejects(router.request('local', runtime, 'filesystem.read', scope), /shutting down/);
  await assert.rejects(router.setBackend('runtime'), /shutting down/);
  await router.request('other-machine', runtime, 'filesystem.read', scope);
  completed.resolve(); await Promise.all([writing, stopping]);
  assert.equal(drained, true);
  router.resumeAfterQuitCancelled();
  await router.request('local', runtime, 'filesystem.read', scope);
  assert.deepEqual(log, ['filesystem.write', 'remote:filesystem.read', 'release pending access', 'filesystem.read']);
});

test('quit timeout leaves admitted write alive and reopens admission', async () => {
  const completed = deferred();
  const main = target(async method => { if (method === 'filesystem.write') await completed.promise; return null; });
  const router = new LocalFileRouter({ load: async () => 'main', save: async () => {} }, main);
  const writing = router.request('local', main, 'filesystem.write', { ...scope, content: 'saved', expectedFingerprint: 'before', operationId: 'save' });
  await assert.rejects(router.prepareToQuit(10), /still running/);
  assert.equal(await router.getBackend(), 'main');
  completed.resolve(); await writing;
  await router.request('local', main, 'filesystem.read', scope);
});
