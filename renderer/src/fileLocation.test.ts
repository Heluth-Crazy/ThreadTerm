import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedFileLocation, revealFileLocation, fileLocationMenuItem, fileLocationLabel } from './fileLocation';
import type { FileLocationRequest } from '@threadterm/protocol';
function machine(id:string,handler:(target:FileLocationRequest)=>Promise<{kind:'file'|'parent'}>,run:()=>Promise<void>){
 const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{threadterm:{machineId:id,revealFileLocation:handler}}});
 return run().finally(()=>{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');});
}
test('session references strip locations without corrupting drive/UNC paths or percent literals',()=>{
 for(const [input,path] of [['D:\\repo\\file.ts:12:3','D:\\repo\\file.ts'],['\\\\server\\share\\file.ts:10','\\\\server\\share\\file.ts'],['src/a.ts#L10C3','src/a.ts'],['src/a%20b.ts:8','src/a%20b.ts']])assert.deepEqual(normalizedFileLocation({sessionId:'s',path:input}),{sessionId:'s',path});
 assert.throws(()=>normalizedFileLocation({sessionId:'s',path:'https://example.com/a.ts'}));
 assert.deepEqual(normalizedFileLocation({sessionId:'s',path:'BUILD'}),{sessionId:'s',path:'BUILD'});
});
test('known workspace filenames stay literal; owner sessions do not turn them into cwd-relative refs',()=>{
 assert.deepEqual(normalizedFileLocation({projectId:'p',path:'notes#L12.md'}),{projectId:'p',path:'notes#L12.md'});
 assert.deepEqual(normalizedFileLocation({sessionId:'s',path:'README.md',workspaceRelative:true}),{sessionId:'s',path:'README.md',workspaceRelative:true});
});
test('action dispatches a single typed target and reports missing-file parent fallback',async()=>{
 const targets:FileLocationRequest[]=[],issues:string[]=[];
 await machine('local',async target=>{targets.push(target);return {kind:'parent'};},async()=>{
 await revealFileLocation({sessionId:'s',path:'src/a.ts:12'},true,message=>issues.push(message));
 assert.deepEqual(targets,[{sessionId:'s',path:'src/a.ts'}]);assert.match(issues[0],/文件已不存在/);
 });
});
test('native failures and unavailable facade produce visible errors, not silent no-ops',async()=>{
 const issues:string[]=[];
 await machine('local',async()=>{throw Error('denied');},async()=>{await revealFileLocation({externalId:'e'},false,message=>issues.push(message));assert.match(issues[0],/Could not locate/);});
});
test('remote has explicit host wording and registered local files are disabled',async()=>{
 await machine('remote',async()=>({kind:'file'}),async()=>{assert.equal(fileLocationLabel(true),'在远程文件中显示');assert.equal(fileLocationMenuItem({externalId:'e'},true).disabled,true);assert.equal(fileLocationMenuItem({projectId:'p',path:'a.ts'},true).disabled,false);});
});
