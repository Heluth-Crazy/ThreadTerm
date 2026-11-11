import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { LocalFileService } from './files.ts';
import { createLocalFileReferenceTarget } from './references.ts';

const source = '2026-11-05T00:00:00.000Z';
const setup = async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tt-local-references-'));
  const root = join(folder, 'workspace'), cwd = join(root, 'nested'), outside = join(folder, 'outside.txt');
  await (await import('node:fs/promises')).mkdir(root, {recursive:true});
  await writeFile(join(root, '.keep'), '');
  await writeFile(join(root, 'sample.ts'), 'export const value = 1;\n');
  await (await import('node:fs/promises')).mkdir(cwd, {recursive:true});
  await writeFile(outside, 'outside\n');
  const row = {id:'external-1', canonicalPath:outside, name:'outside.txt', source:'dialog' as const, openedAt:source};
  const calls:{command:string;params:Record<string,unknown>}[] = [];
  const target = createLocalFileReferenceTarget({
    service:new LocalFileService({trashItem:async()=>{}}),
    coordination:async (command, params) => {
      calls.push({command,params});
      if (command === 'desktop.files.context') return {kind:'session',sessionId:params.sessionId,projectId:'project',rootPath:root,cwd,provider:'codex',mode:'chat',relativeRequiresAbsolute:false};
      if (command === 'desktop.files.external.open') return {...row,canonicalPath:params.canonicalPath,source:params.source};
      if (command === 'desktop.files.external.get') return row;
      if (command === 'desktop.files.external.list') return {files:[row]};
      if (command === 'desktop.files.external.forget') return null;
      throw Error(`unexpected ${command}`);
    },
  });
  return {folder,root,cwd,outside,row,calls,target};
};

test('main resolve preserves location, canonical containment and session-relative semantics', async () => {
  const fixture = await setup();
  try {
    const result = await fixture.target.request('filesystem.resolve', {sessionId:'session',path:'../sample.ts',line:7,column:3});
    assert.deepEqual(result, {projectId:'project',worktreePath:toNamespacedPath(fixture.root),path:'sample.ts',kind:'text',line:7,column:3});
    await assert.rejects(fixture.target.request('filesystem.resolve', {sessionId:'session',path:'../../outside.txt'}), /file_reference_outside_scope/);
    await assert.rejects(fixture.target.request('filesystem.resolve', {sessionId:'session',path:'bad\0path'}), /file_reference_invalid_path/);
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('main resolve keeps shell/custom relative paths refused by the private session scope', async () => {
  const fixture = await setup();
  try {
    const shell = createLocalFileReferenceTarget({service:new LocalFileService({trashItem:async()=>{}}), coordination:async () => ({kind:'session',sessionId:'shell',projectId:'project',rootPath:fixture.root,cwd:fixture.root,provider:'shell',mode:'terminal',relativeRequiresAbsolute:true})});
    await assert.rejects(shell.request('filesystem.resolve', {sessionId:'shell',path:'sample.ts'}), /file_reference_relative_requires_absolute/);
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('external open redirects workspace files and registered-id reads retain readonly display paths', async () => {
  const fixture = await setup();
  try {
    const redirected = await fixture.target.request('filesystem.external.open', {path:join(fixture.root,'sample.ts'),source:'dialog',sessionId:'session'});
    assert.deepEqual(redirected, {inWorkspace:{projectId:'project',worktreePath:toNamespacedPath(fixture.root),path:'sample.ts'}});
    assert.equal(fixture.calls.some(call => call.command === 'desktop.files.external.open'), false);
    const opened = await fixture.target.request('filesystem.external.open', {path:fixture.outside,source:'dialog',sessionId:'session'});
    assert.equal('file' in opened, true);
    if ('file' in opened) {
      assert.equal(opened.file.size, 8);
      assert.notEqual(opened.file.modifiedAt, '');
    }
    assert.equal(fixture.calls.find(call => call.command === 'desktop.files.external.open')?.params.canonicalPath, toNamespacedPath(fixture.outside));
    const document = await fixture.target.request('filesystem.external.read', {id:fixture.row.id});
    assert.equal(document.readonly, true);
    assert.equal(document.path, fixture.outside);
    assert.equal(document.content, 'outside\n');
    const listed = await fixture.target.request('filesystem.external.list', {});
    assert.deepEqual(listed.files.map(file => [file.id,file.exists,file.size]), [[fixture.row.id,true,8]]);
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('external windows resolve registered IDs and preserve stale-token errors',async()=>{
  const fixture=await setup();
  try{
    await writeFile(fixture.outside,'first line\r\nsecond € line\r\nthird line\n');
    await utimes(fixture.outside,1_700_000_000,1_700_000_000);
    const first=await fixture.target.request('filesystem.external.readWindow',{id:fixture.row.id,offset:0,maxBytes:24});
    assert.equal(first.start,0);
    assert.ok(first.end>0);
    assert.ok(Buffer.byteLength(first.content,'utf8')<=24);
    assert.deepEqual(fixture.calls.findLast(call=>call.command==='desktop.files.external.get')?.params,{id:fixture.row.id});
    await writeFile(fixture.outside,'changed content with a different version\n');
    await utimes(fixture.outside,1_700_000_001,1_700_000_001);
    await assert.rejects(fixture.target.request('filesystem.external.readWindow',{id:fixture.row.id,offset:0,maxBytes:24,changeToken:first.changeToken}),
      error=>error instanceof Error&&error.message==='file_changed');
  }finally{await rm(fixture.folder,{recursive:true,force:true});}
});

test('external document reads use the registered ID and the shared Word checks',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'tt-local-doc-'));
  const file=join(folder,'report.docx');
  await writeFile(file,Buffer.concat([Buffer.from('PK\x03\x04','binary'),Buffer.from('word bytes')]));
  try{
    const row={id:'doc-1',canonicalPath:file,name:'report.docx',source:'dialog' as const,openedAt:source};
    const calls:string[]=[];
    const target=createLocalFileReferenceTarget({service:new LocalFileService({trashItem:async()=>{}}),coordination:async command=>{calls.push(command);if(command==='desktop.files.external.get')return row;throw Error(`unexpected ${command}`);}});
    const first=await target.request('filesystem.external.document.read',{id:row.id,offset:0,limit:1024});
    assert.equal(first.offset,0);
    assert.equal(first.size,14);
    assert.equal(first.eof,true);
    assert.deepEqual(Buffer.from(first.chunk,'base64'),Buffer.from('PK\x03\x04word bytes','binary'));
    await assert.rejects(target.request('filesystem.external.document.read',{id:row.id,offset:0,limit:1024*1024+1}),/invalid_limit/);
    assert.ok(calls.includes('desktop.files.external.get'));
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('external open, list and read preserve Runtime filesystem timestamp precision', async () => {
  const fixture = await setup();
  try {
    for (const [seconds, expected] of [
      [1_700_000_000, '2023-11-14T22:13:20+00:00'],
      [1_700_000_000.125, '2023-11-14T22:13:20.125+00:00'],
    ] as const) {
      await utimes(fixture.outside, seconds, seconds);
      const opened = await fixture.target.request('filesystem.external.open', {path:fixture.outside, source:'dialog'});
      assert.ok('file' in opened);
      assert.equal(opened.file.modifiedAt, expected);
      const listed = await fixture.target.request('filesystem.external.list', {});
      assert.equal(listed.files[0].modifiedAt, expected);
      const document = await fixture.target.request('filesystem.external.read', {id:fixture.row.id});
      assert.equal(document.modifiedAt, expected);
    }
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('source search follows Runtime source-root order for Java and Kotlin module layouts', async () => {
  const fixture = await setup();
  try {
    await mkdir(join(fixture.root, 'api', 'src', 'main', 'java', 'com', 'example'), {recursive:true});
    await mkdir(join(fixture.root, 'services', 'api', 'src', 'test', 'kotlin', 'com', 'example'), {recursive:true});
    await writeFile(join(fixture.root, 'api', 'src', 'main', 'java', 'com', 'example', 'Api.java'), 'class Api {}');
    await writeFile(join(fixture.root, 'services', 'api', 'src', 'test', 'kotlin', 'com', 'example', 'Nested.kt'), 'class Nested');
    const java = await fixture.target.request('filesystem.resolve', {sessionId:'session',path:'com/example/Api.java',sourceSearch:true});
    const kotlin = await fixture.target.request('filesystem.resolve', {sessionId:'session',path:'com/example/Nested.kt',sourceSearch:true});
    assert.equal(java.path, 'api/src/main/java/com/example/Api.java');
    assert.equal(kotlin.path, 'services/api/src/test/kotlin/com/example/Nested.kt');
    await assert.rejects(fixture.target.request('filesystem.resolve', {sessionId:'session',path:'../Api.java',sourceSearch:true}), /file_reference_invalid_path/);
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('source search skips an escaping junction or symlink and finds the next valid module', async t => {
  const fixture = await setup();
  try {
    const escaped = join(fixture.folder, 'escaped');
    await mkdir(join(escaped, 'src', 'main', 'java', 'com', 'example'), {recursive:true});
    await mkdir(join(fixture.root, 'z-valid', 'src', 'main', 'java', 'com', 'example'), {recursive:true});
    await writeFile(join(escaped, 'src', 'main', 'java', 'com', 'example', 'Target.java'), 'class Escaped {}');
    await writeFile(join(fixture.root, 'z-valid', 'src', 'main', 'java', 'com', 'example', 'Target.java'), 'class Valid {}');
    await symlink(escaped, join(fixture.root, 'a-escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await fixture.target.request('filesystem.resolve', {sessionId:'session',path:'com/example/Target.java',sourceSearch:true});
    assert.equal(result.path, 'z-valid/src/main/java/com/example/Target.java');
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('external paths reject device, stream and control forms before filesystem access, including stale registered rows', async () => {
  const fixture = await setup();
  try {
    for (const path of ['\\\\.\\NUL', '/??/NUL', `${fixture.outside}:stream`, `${fixture.outside}\n`, `${fixture.outside}\u0085`])
      await assert.rejects(fixture.target.request('filesystem.external.open', {path,source:'dialog'}), /invalid_path/);
    const stale = createLocalFileReferenceTarget({service:new LocalFileService({trashItem:async()=>{}}), coordination:async command => {
      if(command === 'desktop.files.external.get') return {...fixture.row,canonicalPath:'\\\\.\\NUL'};
      throw Error(`unexpected ${command}`);
    }});
    await assert.rejects(stale.request('filesystem.external.read', {id:fixture.row.id}), /invalid_path/);
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});

test('every session reference validates the saved cwd even for an absolute in-root file', async () => {
  const fixture = await setup();
  try {
    const target = (cwd:string) => createLocalFileReferenceTarget({ service:new LocalFileService({trashItem:async()=>{}}),
      coordination:async () => ({kind:'session',sessionId:'session',projectId:'project',rootPath:fixture.root,cwd,provider:'codex',mode:'chat',relativeRequiresAbsolute:false}) });
    const params = {sessionId:'session',path:join(fixture.root,'sample.ts')};
    await assert.rejects(target(join(fixture.folder,'missing')).request('filesystem.resolve', params), /file_reference_cwd_unavailable/);
    await assert.rejects(target(fixture.outside).request('filesystem.resolve', params), /file_reference_cwd_unavailable/);
    await assert.rejects(target(fixture.folder).request('filesystem.resolve', params), /file_reference_scope_mismatch/);
    await assert.rejects(target(fixture.folder).request('filesystem.external.open', {sessionId:'session',path:fixture.outside,source:'dialog'}), /file_reference_scope_mismatch/);
  } finally { await rm(fixture.folder,{recursive:true,force:true}); }
});
