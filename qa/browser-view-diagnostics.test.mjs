import assert from 'node:assert/strict';
import test from 'node:test';
import { attachedBrowserPages } from './lib/browser-view-diagnostics.mjs';

test('same-URL automation selects attached WebContents identity rather than page creation order',async()=>{
 const renderer={isClosed:()=>false},a={id:'target-a',isClosed:()=>false,url:()=> 'http://127.0.0.1:1234/'},b={id:'target-b',isClosed:()=>false,url:a.url};
 const detached=[];let active='target-a';
 const app={evaluate:async()=>[active],context:()=>({pages:()=>[renderer,a,b],newCDPSession:async page=>({send:async()=>({targetInfo:{targetId:page.id}}),detach:async()=>detached.push(page.id)})})};
 assert.deepEqual(await attachedBrowserPages(app,renderer),[a]);
 active='target-b';assert.deepEqual(await attachedBrowserPages(app,renderer),[b]);
 assert.deepEqual(detached,['target-a','target-b','target-a','target-b']);
});

test('native automation releases its CDP session if target lookup fails',async()=>{
 let detached=false;const page={isClosed:()=>false};
 const app={evaluate:async()=>['target'],context:()=>({pages:()=>[page],newCDPSession:async()=>({send:async()=>{throw Error('target closed');},detach:async()=>{detached=true;}})})};
 await assert.rejects(attachedBrowserPages(app,{}),/target closed/);assert.equal(detached,true);
});
