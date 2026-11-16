import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { parseFileLocationRequest, locationRelativePath, remoteLocationPath, remoteLocationRootEquals, revealLocalFileLocation, type FileLocationDependencies } from './fileLocation.js';
const root=resolve('location-fixture'),file=resolve(root,'src','中文 file.ts');
function fixture(){
 const calls:string[]=[];
 const deps:FileLocationDependencies={workspaceRoot:async()=>root,externalPath:async()=>file,canonical:async path=>path,kind:async path=>path===file?'file':'directory',showItem:path=>{calls.push('reveal:'+path);},openDirectory:async path=>{calls.push('directory:'+path);return '';}};
 return {calls,deps};
}
const absent=()=>Object.assign(new Error('missing'),{code:'ENOENT'});
test('strict request shapes separate project, source session and registered external identities',()=>{
 assert.deepEqual(parseFileLocationRequest({projectId:'p',path:'src\\a.ts'}),{projectId:'p',path:'src/a.ts'});
 assert.deepEqual(parseFileLocationRequest({sessionId:'s',path:'D:\\repo\\a.ts',workspaceRelative:true}),{sessionId:'s',path:'D:\\repo\\a.ts',workspaceRelative:true});
 assert.deepEqual(parseFileLocationRequest({externalId:'e'}),{externalId:'e'});
 for(const value of [null,[],{}, {externalId:'e',path:'x'}, {sessionId:'s',path:'x',projectId:'p'}, {sessionId:'s',path:'x',workspaceRelative:false}, {projectId:'p',path:'x',root:'D:\\'}, {projectId:'p',path:'a\0b'}])assert.throws(()=>parseFileLocationRequest(value));
});
test('project paths reject absolute, traversal, streams and empty roots without shell calls',()=>{
 for(const p of ['../a.ts','src/../../a.ts','D:\\a.ts','\\\\server\\share\\a.ts','/tmp/a','a.ts:stream','.','a/..',''])assert.throws(()=>locationRelativePath(p),p);
 assert.equal(locationRelativePath('src/./a%20b.ts'),'src/a%20b.ts');
});
test('existing project files and directories only reveal; no default-app opening',async()=>{
 const {calls,deps}=fixture();
 assert.deepEqual(await revealLocalFileLocation({projectId:'p',path:'src/中文 file.ts'},deps),{kind:'file'});
 await revealLocalFileLocation({projectId:'p',path:'src'},deps);
 assert.deepEqual(calls,['reveal:'+file,'reveal:'+dirname(file)]);
});
test('canonical junction escapes fail closed',async()=>{
 const {calls,deps}=fixture();deps.canonical=async path=>path===file?resolve(root,'..','outside.ts'):path;
 await assert.rejects(revealLocalFileLocation({projectId:'p',path:'src/中文 file.ts'},deps),/outside/);assert.deepEqual(calls,[]);
});
test('missing project file opens only a canonical in-scope existing directory',async()=>{
 const {calls,deps}=fixture();deps.canonical=async path=>{if(path===file)throw absent();return path;};
 assert.deepEqual(await revealLocalFileLocation({projectId:'p',path:'src/中文 file.ts'},deps),{kind:'parent'});
 assert.deepEqual(calls,['directory:'+dirname(file)]);
});
test('missing nested directories walk up without escaping root',async()=>{
 const {calls,deps}=fixture();deps.canonical=async path=>{if(path!==root)throw absent();return path;};
 await revealLocalFileLocation({projectId:'p',path:'gone/nested/file.ts'},deps);assert.deepEqual(calls,['directory:'+root]);
});
test('access errors and missing-parent junction escapes never fall back outside scope',async()=>{
 const first=fixture();first.deps.canonical=async path=>{if(path===file)throw Object.assign(new Error('denied'),{code:'EACCES'});return path;};
 await assert.rejects(revealLocalFileLocation({projectId:'p',path:'src/中文 file.ts'},first.deps),/denied/);assert.deepEqual(first.calls,[]);
 const second=fixture();second.deps.canonical=async path=>{if(path===file)throw absent();return path===dirname(file)?resolve(root,'..'):path;};
 await assert.rejects(revealLocalFileLocation({projectId:'p',path:'src/中文 file.ts'},second.deps),/outside/);assert.deepEqual(second.calls,[]);
});
test('registered external file uses only ID, rejects replaced identity and directories',async()=>{
 const a=fixture();await revealLocalFileLocation({externalId:'e'},a.deps);assert.deepEqual(a.calls,['reveal:'+file]);
 const b=fixture();b.deps.canonical=async()=>resolve(root,'replaced.ts');await assert.rejects(revealLocalFileLocation({externalId:'e'},b.deps),/identity/);assert.deepEqual(b.calls,[]);
 const c=fixture();c.deps.kind=async()=> 'directory';await assert.rejects(revealLocalFileLocation({externalId:'e'},c.deps),/unavailable/);
});
test('remote host separators are independent of this Windows client and reject traversal',()=>{
 assert.equal(remoteLocationPath('/home/user/repo','src\\file.ts'),'/home/user/repo/src/file.ts');
 assert.equal(remoteLocationPath('D:\\repo','src/file.ts'),'D:\\repo\\src\\file.ts');
 assert.equal(remoteLocationPath('\\\\server\\share\\repo','src/a.ts'),'\\\\server\\share\\repo\\src\\a.ts');
 assert.throws(()=>remoteLocationPath('/repo','../file'));
});

test('remote Windows root identity matches verbatim, drive case and UNC spellings without local I/O',()=>{
 for(const [left,right] of [
  ['\\\\?\\D:\\Repo','d:/repo/'],
  ['D:/Repo','d:\\repo'],
  ['\\\\?\\UNC\\Server\\Share\\Repo','\\\\server\\share\\repo\\'],
  ['\\\\server\\share\\repo','//SERVER/SHARE/repo'],
  ['//?/UNC/Server/Share/Repo','\\\\server\\share\\repo'],
  ['\\\\?\\D:\\','d:/'],
 ])assert.equal(remoteLocationRootEquals(left,right),true,`${left} versus ${right}`);
 for(const [left,right] of [['D:/repo','E:/repo'],['D:/repo','D:/repo-other'],['D:/repo','/repo'],['D:/','D:'],['\\\\server\\share','\\\\server\\other']])assert.equal(remoteLocationRootEquals(left,right),false);
});

test('remote POSIX root identity preserves case and literal backslashes',()=>{
 assert.equal(remoteLocationRootEquals('/home/user/repo/','/home/user/repo'),true);
 assert.equal(remoteLocationRootEquals('/home/user/Repo','/home/user/repo'),false);
 assert.equal(remoteLocationRootEquals('//host/Repo','//host/repo'),false);
 assert.equal(remoteLocationRootEquals('/home/user/a\\b','/home/user/a/b'),false);
 assert.equal(remoteLocationRootEquals('/','/'),true);
});
