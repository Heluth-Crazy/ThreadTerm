import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registeredExternalFileIdentityPath, registeredExternalFilePath } from './references.js';
import { revealLocalFileLocation } from '../fileLocation.js';

test('raw registration identity rejects a replaced directory junction without changing old accessor behavior',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tt-registered-location-'));
 const previous=join(root,'previous'),replacement=join(root,'replacement');
 await mkdir(replacement);await writeFile(join(replacement,'file.txt'),'replacement');
 await symlink(replacement,previous,process.platform==='win32'?'junction':'dir');
 const row={id:'registered',canonicalPath:join(previous,'file.txt'),name:'file.txt',source:'link',openedAt:new Date().toISOString()};
 const coordination=async()=>row;
 assert.equal(await registeredExternalFileIdentityPath(coordination,row.id),row.canonicalPath);
 assert.equal(await registeredExternalFilePath(coordination,row.id),await realpath(join(replacement,'file.txt')));
 const shown:string[]=[];
 await assert.rejects(revealLocalFileLocation({externalId:row.id},{workspaceRoot:async()=>root,
  externalPath:id=>registeredExternalFileIdentityPath(coordination,id),canonical:realpath,
  kind:async path=>(await stat(path)).isFile()?'file':'directory',showItem:path=>{shown.push(path)},openDirectory:async()=>''}),/identity changed/);
 assert.deepEqual(shown,[]);
});

test('raw identity rejects mismatched registration IDs, malformed rows, and unsafe paths',async()=>{
 const row={id:'registered',canonicalPath:join(tmpdir(),'file.txt'),name:'file.txt',source:'link',openedAt:new Date().toISOString()};
 await assert.rejects(registeredExternalFileIdentityPath(async()=>row,''),/invalid_request/);
 await assert.rejects(registeredExternalFileIdentityPath(async()=>row,'different'),/invalid_external/);
 await assert.rejects(registeredExternalFileIdentityPath(async()=>({...row,canonicalPath:'relative.txt'}),row.id),/invalid_external/);
 await assert.rejects(registeredExternalFileIdentityPath(async()=>({...row,canonicalPath:row.canonicalPath+'\0'}),row.id),/invalid_path/);
 await assert.rejects(registeredExternalFileIdentityPath(async()=>({...row,source:'untrusted'}),row.id),/invalid_external/);
});
