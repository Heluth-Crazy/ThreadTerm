import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const scratchBase=resolve('D:/project/ThreadTerm/tt-qa-temp');await mkdir(scratchBase,{recursive:true});
const require=createRequire(import.meta.url),root=await mkdtemp(join(scratchBase,'tt-browser-comments-unit-'));
assert.equal(dirname(resolve(root )).toLowerCase(),scratchBase.toLowerCase(),'scratch remains inside the approved QA root');
test.after(()=>rm(root,{recursive:true,force:true}));
// Load the real compiler through Node rather than bundling its CommonJS built-ins.
const ts=require('typescript');
const handlers=new Map(),app=Object.assign(new EventEmitter(),{getPath:()=>root});
const electron={app,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},BrowserWindow:{fromWebContents:()=>({isFocused:()=>true,getContentSize:()=>[1200,900]})}};
const cache=new Map();
function load(path){path=resolve(path);if(cache.has(path))return cache.get(path).exports;const module={exports:{}};cache.set(path,module);const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const localRequire=name=>name==='electron'?electron:name.startsWith('.')?load(resolve(dirname(path),name.replace(/\.js$/,'.ts'))):require(name);
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{Buffer,console,URL,Promise,process,setTimeout,clearTimeout,setInterval,clearInterval},{filename:path})(localRequire,module,module.exports);return module.exports;
}
const api=load('desktop/src/pageComments.ts');api.registerPageComments(event=>{if(!event.trusted)throw Error('Untrusted');});
const frameName='tt-preview-nativecomments';let serial=0;
function fixture(){const calls=[],crops=[],sender=Object.assign(new EventEmitter(),{id:++serial,isDestroyed:()=>false,mainFrame:{framesInSubtree:[]},focus(){this.focused=true;}});
 const image=(width=800,height=600)=>({isEmpty:()=>false,getSize:()=>({width,height}),crop(rect){crops.push(rect);return image(rect.width,rect.height);},resize:size=>image(size.width,size.height),toPNG:()=>Buffer.from('png'),toJPEG:()=>Buffer.from('jpeg')});
 let resolvePick;
 const page=Object.assign(new EventEmitter(),{isDestroyed:()=>false,mainFrame:{},capturePage:async()=>image(),executeJavaScriptInIsolatedWorld:async(world,scripts,gesture)=>{calls.push({world,scripts,gesture});if(scripts[0].code.endsWith('("pick",undefined,undefined)'))return new Promise(resolve=>{resolvePick=resolve;});return true;}});
 api.nativePageRegistered(sender,frameName,page,()=>({x:20,y:80,width:400,height:300}));
 return {sender,page,calls,crops,event:{sender,trusted:true},pick:()=>resolvePick,close:()=>api.nativePageClosed(sender,frameName)};
}
const pick=()=>({url:'https://example.test/',title:'Native comment fixture',viewport:{width:400,height:300},target:{type:'area',rect:{x:380,y:280,width:50,height:50},elements:['Save']}});
const invoke=(name,event,value)=>Promise.resolve().then(()=>handlers.get(`threadterm:${name}`)(event,value));
const request={frameName,frameRect:{x:20,y:80,width:400,height:300}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('native picks execute the shared picker in an isolated world and capture scaled clamped pixels',async()=>{
 const f=fixture(),pending=invoke('pick-page-target',f.event,request);await tick();assert.ok(f.pick());f.pick()(pick());const selected=await pending;
 assert.equal(f.calls[0].world,999);assert.equal(f.calls[0].gesture,false);assert.equal(selected.target.type,'area');assert.ok(selected.shot?.id);assert.deepEqual(JSON.parse(JSON.stringify(f.crops)),[{x:760,y:560,width:40,height:40}]);assert.equal(f.sender.focused,true);
 await api.deletePageShots([selected.shot.id],{force:true});f.close();
});

test('native pages cannot be picked through another renderer identity',async()=>{
 const f=fixture(),other=fixture();assert.equal(await invoke('pick-page-target',{sender:{...other.sender,id:99999},trusted:true},request),null);
 await assert.rejects(invoke('pick-page-target',{sender:f.sender,trusted:false},request),/Untrusted/);f.close();other.close();
});

test('native unregister and navigation cancel a pending picker without leaving screenshot files',async()=>{
 const f=fixture(),pending=invoke('pick-page-target',f.event,request);await tick();f.close();assert.equal(await pending,null);assert.ok(f.calls.some(call=>call.scripts[0].code.endsWith('("cancel",undefined,undefined)')));
 const next=fixture(),navigation=invoke('pick-page-target',next.event,request);await tick();next.page.emit('did-start-navigation',{isMainFrame:true});assert.equal(await navigation,null);assert.equal(next.page.listenerCount('did-start-navigation'),0);next.close();assert.deepEqual(await readdir(join(root,'page-comments')).catch(()=>[]),[]);
});
