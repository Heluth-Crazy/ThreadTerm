import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ts=createRequire(import.meta.url)('typescript');
function fixture(){
 const calls={insert:[],send:[],release:[],shots:[]};
 const review={
  formatReviewComments:comments=>comments.map(note=>`[${note.target.tag}] ${note.body}`).join('\n'),
  isPageComment:note=>note.kind==='page',
  releaseReviewComments:async(_scope,ids)=>{calls.release.push(ids);if(calls.releaseError||calls.releaseFailAt===calls.release.length)throw new Error('draft cleanup failed');},
 };
 const bridge={readPageShot:async id=>{calls.shots.push(id);return `data:image/png;base64,${id}`;}};
 const module={exports:{}};
 const require=name=>name==='@threadterm/protocol'?{MAX_CHAT_IMAGES:4}:name==='./bridge'?bridge:name==='./reviewComments'?review:name==='./projectScope'?{canonicalScopePath:value=>value}:{};
 const source=readFileSync('renderer/src/designDelivery.ts','utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(compiled,{module,exports:module.exports,require,Promise,Error});
 const host={defaultReceiverId:'chat-a',receivers:[{id:'chat-a',root:'C:/work'}],insert:async(...args)=>{calls.insert.push(args);},send:async(...args)=>{calls.send.push(args);}};
 const scope={projectId:'project',root:'C:/work'};
 const note=(id,body,shot=true)=>({id,kind:'page',body,target:{type:'element',tag:'button'},url:'https://example.test',title:'Example',...(shot?{shot:{id:`shot-${id}`}}:{})});
 return {deliver:module.exports.deliverDesignNotes,calls,host,scope,note};
}

test('batch notes become one normal send and release only after that send succeeds',async()=>{
 const f=fixture(),notes=[f.note('1','Make this primary'),f.note('2','Add spacing')];
 await f.deliver({scope:f.scope,host:f.host,comments:notes,zh:false});
 assert.equal(f.calls.send.length,1,'batch uses one session send');
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.send[0])),['chat-a',{text:'[button] Make this primary\n[button] Add spacing',images:['data:image/png;base64,shot-1','data:image/png;base64,shot-2']}]);
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.release)),[['1'],['2']],'notes release after accepted send');
});

test('a failed batch send retains every pending note',async()=>{
 const f=fixture();f.host.send=async()=>{throw new Error('queue unavailable');};
 await assert.rejects(f.deliver({scope:f.scope,host:f.host,comments:[f.note('1','Keep me')],zh:false}),/queue unavailable/);
 assert.deepEqual(f.calls.release,[]);
});

test('To chat stops at the existing composer insertion route',async()=>{
 const f=fixture();await f.deliver({scope:f.scope,host:f.host,comments:[f.note('1','Draft only',false)],zh:false,toChat:true});
 assert.equal(f.calls.send.length,0);
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.insert[0])),['chat-a','[button] Draft only',null]);
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.release)),[['1']]);
});

test('a partial cleanup retry on the remaining subset releases without sending twice',async()=>{
 const f=fixture(),notes=[f.note('1','Already deleted'),f.note('2','Keep the accepted receipt')];f.calls.releaseFailAt=2;
 await assert.rejects(f.deliver({scope:f.scope,host:f.host,comments:notes,zh:false}),/draft cleanup failed/);
 f.calls.releaseFailAt=undefined;await f.deliver({scope:f.scope,host:f.host,comments:[notes[1]],zh:false});
 assert.equal(f.calls.send.length,1);assert.equal(f.calls.release.length,3);
});

test('a cleanup retry after To chat insertion does not insert twice',async()=>{
 const f=fixture(),notes=[f.note('1','Keep the composer receipt',false)];f.calls.releaseError=true;
 await assert.rejects(f.deliver({scope:f.scope,host:f.host,comments:notes,zh:false,toChat:true}),/draft cleanup failed/);
 f.calls.releaseError=false;await f.deliver({scope:f.scope,host:f.host,comments:notes,zh:false,toChat:true});
 assert.equal(f.calls.insert.length,1);assert.equal(f.calls.release.length,2);
});

test('a pending accepted subset plus a fresh note sends only the fresh note',async()=>{
 const f=fixture(),first=f.note('1','Accepted first'),pending=f.note('2','Accepted but pending cleanup'),fresh=f.note('3','Only this may send now');f.calls.releaseFailAt=2;
 await assert.rejects(f.deliver({scope:f.scope,host:f.host,comments:[first,pending],zh:false}),/draft cleanup failed/);
 f.calls.releaseFailAt=undefined;await f.deliver({scope:f.scope,host:f.host,comments:[pending,fresh],zh:false});
 assert.equal(f.calls.send.length,2);assert.match(f.calls.send[1][1].text,/Only this may send now/);assert.doesNotMatch(f.calls.send[1][1].text,/Accepted but pending cleanup/);
});
