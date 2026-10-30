import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('runtime eval approval uses a separate leased, exact-hash decision contract',()=>{
 const read={sessionId:'session',turnId:'turn',approvalId:'approval',leaseEpoch:1};
 validateRequest('browser.approval.read',read);
 const resolve={...read,operationId:'decision',codeHash:'a'.repeat(64),choice:'approve_once'};
 validateRequest('browser.approval.resolve',resolve);
 validateRequest('browser.approval.resolve',{...resolve,choice:'deny'});
 for(const patch of [{leaseEpoch:0},{leaseEpoch:undefined},{turnId:''},{sessionId:'s\nforged'},{approvalId:'😀'.repeat(65)},{code:'PRIVATE_CODE'}])assert.throws(()=>validateRequest('browser.approval.read',{...read,...patch}));
 for(const patch of [{codeHash:'A'.repeat(64)},{codeHash:'a'.repeat(63)},{choice:'allow_always'},{operationId:''},{code:'PRIVATE_CODE'}])assert.throws(()=>validateRequest('browser.approval.resolve',{...resolve,...patch}));
 const result={approvalId:'approval',operationId:'browser-operation',code:' 1+1\n',codeHash:'a'.repeat(64),codeByteLength:5,tabId:'tab',origin:'https://example.invalid',expiresAtUnixMs:Date.now()+300_000,settingsGeneration:'epoch:1',status:'pending'};
 validateResult('browser.approval.read',result);
 for(const patch of [{codeByteLength:3},{code:'\uD800'},{codeHash:'A'.repeat(64)},{status:'resolved'},{origin:'https://user:secret@example.invalid/'},{exception:'PRIVATE_EXCEPTION'}])assert.throws(()=>validateResult('browser.approval.read',{...result,...patch}));
 validateResult('browser.approval.resolve',{status:'approved'});
 validateResult('browser.approval.resolve',{status:'denied'});
 assert.throws(()=>validateResult('browser.approval.resolve',{status:'approved',code:'PRIVATE_CODE'}));
});
test('fork requires a lease and stable operation identity and carries additive native anchors and origin',()=>{
 const params={sessionId:'source',operationId:'fork-op',leaseEpoch:1};
 validateRequest('chat.fork',params);
 validateRequest('chat.fork',{...params,itemId:'reply'});
 for(const patch of [{leaseEpoch:undefined},{leaseEpoch:0},{operationId:''},{sessionId:''},{itemId:''},{itemId:'x'.repeat(1025)}])assert.throws(()=>validateRequest('chat.fork',{...params,...patch}));
 const session={id:'child',title:'Source (fork)',provider:'codex',mode:'chat',status:'idle',createdAt:'now',updatedAt:'now',forkedFrom:{sessionId:'source',itemId:'reply',title:'Source'}};
 validateResult('chat.fork',{session,mode:'native'});
 validateResult('chat.fork',{session,mode:'copy'});
 assert.throws(()=>validateResult('chat.fork',{session,mode:'other'}));
 validateResult('chat.read',[{id:'reply',role:'assistant',parts:[{type:'text',text:'Done',status:'complete'}],createdAt:'now',forkAnchor:{nativeId:'native',turnId:'turn',messageId:'msg'}}]);
});
// Feedback is additive and remains fenced by a lease and a stable operation ID.
test('feedback notes validate leases, unicode limits and delivery status',()=>{
 const request={sessionId:'s',turnId:'turn',text:'note',operationId:'op',leaseEpoch:1};
 validateRequest('chat.feedback.add',request);
 validateRequest('chat.feedback.add',{...request,text:'😀'.repeat(4000)});
 validateRequest('chat.feedback.read',{sessionId:'s'});
 for(const patch of [{text:''},{text:' '},{text:'中'.repeat(4001)},{leaseEpoch:0},{leaseEpoch:undefined},{turnId:''},{operationId:''},{callerToken:'injected'}]) assert.throws(()=>validateRequest('chat.feedback.add',{...request,...patch}));
 const note={id:'n',sessionId:'s',turnId:'turn',text:'note',status:'waiting',createdAt:'now'};
 validateResult('chat.feedback.add',{note});
 validateResult('chat.feedback.read',{notes:[{...note,status:'received'}]});
 assert.throws(()=>validateResult('chat.feedback.read',{notes:[{...note,status:'sent'}]}));
 const dismiss={sessionId:'s',noteIds:['n'],operationId:'op',leaseEpoch:1};
 validateRequest('chat.feedback.dismiss',dismiss);
 validateResult('chat.feedback.dismiss',{removed:['n']});
 for(const patch of [{noteIds:[]},{noteIds:Array(41).fill('n')},{noteIds:['n','n']},{noteIds:['']},{leaseEpoch:0},{leaseEpoch:undefined},{operationId:''}]) assert.throws(()=>validateRequest('chat.feedback.dismiss',{...dismiss,...patch}));
});
test('all four tool switches remain optional boolean portable settings',()=>{
 const settings={'chatTools.ask':true,'chatTools.sessionInfo':false,'chatTools.feedback':true,'chatTools.delegation':false};
 const bundle={marker:'threadterm-v3-settings',version:1,exportedAt:'now',settings};
 validateResult('settings.export',bundle);
 validateResult('settings.export',{...bundle,settings:{}});
 for(const key of Object.keys(settings)) assert.throws(()=>validateResult('settings.export',{...bundle,settings:{[key]:'true'}}));
});
import {validateRequest,validateResult,validateLayout,METHODS,isRuntimeEvent,PROTOCOL_CONTRACT,PROTOCOL_VERSION,protocolIncompatibleReason} from './index.ts';

test('push preview and explicit lease contracts preserve plain push and reject unsafe force requests',()=>{
 const scope={projectId:'p'},oid='a'.repeat(40),plain={...scope,operationId:'push'};
 validateRequest('git.push',plain);
 validateRequest('git.push',{...plain,setUpstream:true});
 const reviewed={remote:'origin',remoteBranch:'main',localBranch:'refs/heads/main'};
 validateRequest('git.push',{...plain,...reviewed,force:'with-lease',expectedRemoteOid:oid});
 validateRequest('git.push',{...plain,...reviewed,force:'with-lease',expectedRemoteOid:'b'.repeat(64)});
 for(const patch of [{force:'with-lease',expectedRemoteOid:oid,setUpstream:true},{force:true},{force:'force'},{force:'with-lease'},{expectedRemoteOid:oid},{force:'with-lease',expectedRemoteOid:''},{force:'with-lease',expectedRemoteOid:'HEAD'},{force:'with-lease',expectedRemoteOid:'a'.repeat(39)}]) assert.throws(()=>validateRequest('git.push',{...plain,...patch}));
 validateRequest('git.push.preview',scope);
 validateRequest('git.push.preview',{...scope,worktreePath:'worktree'});
 for(const patch of [{projectId:''},{operationId:'unexpected'},{remote:'injected'},{force:'with-lease'}]) assert.throws(()=>validateRequest('git.push.preview',{...scope,...patch}));
 const commit={hash:oid,subject:'Publish me',author:'QA',committedAt:'2026-10-28T12:00:00Z'};
 const preview={branch:'main',localBranch:'refs/heads/main',detached:false,remote:'origin',remoteBranch:'main',upstream:'origin/main',setUpstream:false,ahead:{count:2,commits:[commit,commit]},behind:{count:0,commits:[]},remoteOid:oid,diverged:false,lastFetchedAt:commit.committedAt,remoteDefaultBranch:'main'};
 validateResult('git.push.preview',preview);
 validateResult('git.push.preview',{...preview,remoteOid:undefined,lastFetchedAt:undefined,remoteDefaultBranch:undefined,upstream:undefined,setUpstream:true});
 validateResult('git.push.preview',{...preview,ahead:{count:100,commits:Array(50).fill(commit)}});
 for(const patch of [{remote:''},{remoteOid:'HEAD'},{ahead:{count:-1,commits:[]}},{ahead:{count:1,commits:[commit,commit]}},{ahead:{count:51,commits:Array(51).fill(commit)}},{behind:{count:0.5,commits:[]}},{ahead:{count:1,commits:[{...commit,author:3}]}},{diverged:'yes'}]) assert.throws(()=>validateResult('git.push.preview',{...preview,...patch}));
 for(const patch of [{remote:undefined},{remote:''},{remoteBranch:undefined},{localBranch:undefined},{localBranch:'main'}]) assert.throws(()=>validateRequest('git.push',{...plain,...reviewed,force:'with-lease',expectedRemoteOid:oid,...patch}));
 validateRequest('git.fetch',{...plain,remote:'backup'});
 for(const remote of ['', '-all', 'origin\nother']) assert.throws(()=>validateRequest('git.fetch',{...plain,remote}));
 assert.throws(()=>validateResult('git.push.preview',{...preview,localBranch:'main'}));
 assert.ok(METHODS.includes('git.push.preview'));
});

test('external files have a small read-only registration contract',()=>{
 const opened={id:'external-1',path:join(tmpdir(),'external-files','notes.md'),name:'notes.md',size:12,modifiedAt:'2026-10-26T00:00:00Z',openedAt:'2026-10-26T00:00:01Z',image:false};
 validateRequest('filesystem.external.open',{path:opened.path,source:'dialog'});
 validateRequest('filesystem.external.open',{path:'relative.md',source:'link',sessionId:'session'});
 for(const patch of [{path:''},{source:'picker'},{sessionId:''},{operationId:'unexpected'}])assert.throws(()=>validateRequest('filesystem.external.open',{path:opened.path,source:'dialog',...patch}));
 validateResult('filesystem.external.open',{file:opened});
 validateResult('filesystem.external.open',{inWorkspace:{projectId:'project',path:'src/main.ts'}});
 validateRequest('filesystem.external.read',{id:opened.id});
 validateResult('filesystem.external.read',{path:opened.path,content:'notes',fingerprint:'a'.repeat(64),readonly:true,size:5,modifiedAt:opened.modifiedAt});
 validateRequest('filesystem.external.image',{id:opened.id});
 validateResult('filesystem.external.image',{mime:'image/png',data:'AA=='});
 validateRequest('filesystem.external.list',{});
 validateResult('filesystem.external.list',{files:[{...opened,exists:true}]});
 validateRequest('filesystem.external.forget',{id:opened.id,operationId:'forget-1'});
 for(const params of [{},{id:''},{id:opened.id},{id:opened.id,operationId:''},{id:opened.id,operationId:'forget-1',extra:true}])assert.throws(()=>validateRequest('filesystem.external.forget',params));
 assert.ok(METHODS.includes('filesystem.external.open'));
});

test('context read preserves timestamp and all counters, with an empty-session null result',()=>{
 validateRequest('chat.context.read',{sessionId:'s'});
 const usage={usedTokens:60000,windowTokens:200000,percent:30,inputTokens:30000,outputTokens:4700,generationMs:1840,firstTokenMs:420,outputTokensEstimated:false,cacheReadTokens:60000,cacheWriteTokens:1000,totalTokens:95700,updatedAt:'2026-10-13T10:00:00Z'};
 validateResult('chat.context.read',usage);
 validateResult('chat.read',[{id:'reply',role:'assistant',parts:[],createdAt:'now',turnId:'turn',turnUsage:usage}]);
 assert.throws(()=>validateResult('chat.read',[{id:'reply',role:'assistant',parts:[],createdAt:'now',turnUsage:{generationMs:'1840'}}]));
 validateResult('chat.context.read',null);
 assert.throws(()=>validateResult('chat.context.read',{...usage,updatedAt:1}));
 for(const patch of [{generationMs:'1840'},{firstTokenMs:null},{outputTokensEstimated:'false'}]) assert.throws(()=>validateResult('chat.context.read',{...usage,...patch}));
 assert.throws(()=>validateResult('chat.context.read',{...usage,contextSequence:2}));
 assert.equal(isRuntimeEvent({v:1,event:'chat.context',epoch:'e',seq:1,data:{sessionId:'s',usage}}),true);
 assert.equal(isRuntimeEvent({v:1,event:'chat.turnSpeed',epoch:'e',seq:2,data:{sessionId:'s',turnId:'t',active:true,usage}}),true);
});

test('selected commits carry an exact staged snapshot and reject ambiguous or unsafe selections',()=>{
 const oid='a'.repeat(40),fingerprint='b'.repeat(64);
 const head={kind:'branch',oid,target:'refs/heads/main'};
 const input={projectId:'p',message:'Commit selected',operationId:'selected',expectedHead:head,expectedIndexFingerprint:fingerprint,selected:[{path:'src/partial.ts',indexStatus:'M'}]};
 validateRequest('git.commit.selected',input);
 validateRequest('git.commit.selected',{...input,message:'a'.repeat(65535)});
 validateRequest('git.commit.selected',{...input,message:'a'.repeat(65535)+'\n'});
 assert.throws(()=>validateRequest('git.commit.selected',{...input,message:'a'.repeat(65536)}));
 assert.throws(()=>validateRequest('git.commit.selected',{...input,message:'中'.repeat(21845)+'a'}));
 validateRequest('git.commit.selected',{...input,expectedHead:{kind:'detached',oid}});
 validateRequest('git.commit.selected',{...input,expectedHead:{kind:'unborn',target:'refs/heads/new'}});
 validateRequest('git.commit.selected',{...input,selected:[{path:'new.ts',originalPath:'old.ts',indexStatus:'R'}]});
 validateRequest('git.commit.selected',{...input,selected:[{path:'copy.ts',indexStatus:'C'}]});
 validateRequest('git.commit.selected',{...input,selected:[{path:'a'.repeat(4096),indexStatus:'M'}]});
 assert.throws(()=>validateRequest('git.commit.selected',{...input,selected:[{path:'a'.repeat(4097),indexStatus:'M'}]}));
 assert.throws(()=>validateRequest('git.commit.selected',{...input,selected:[{path:'new.ts',originalPath:'a'.repeat(4097),indexStatus:'R'}]}));
 for(const patch of [{selected:[]},{selected:Array.from({length:501},(_,i)=>({path:`${i}.ts`,indexStatus:'A'}))},{selected:[input.selected[0],input.selected[0]]},{message:'   '},{expectedIndexFingerprint:'stale'},{expectedHead:{...head,oid:'not-a-commit'}},{expectedHead:{kind:'unborn',oid,target:'refs/heads/new'}},{amend:true},{projectId:''},{operationId:''}])assert.throws(()=>validateRequest('git.commit.selected',{...input,...patch}));
 for(const path of ['../outside.ts','/outside.ts','C:/outside.ts','src/../outside.ts','src//alias.ts','src\u0000bad.ts'])assert.throws(()=>validateRequest('git.commit.selected',{...input,selected:[{path,indexStatus:'M'}]}));
 for(const row of [{path:'untracked.ts',indexStatus:'?'},{path:'new.ts',indexStatus:'R'},{path:'new.ts',indexStatus:'C',originalPath:'../outside.ts'},{path:'partial.ts',indexStatus:'M',worktreeStatus:'M'}])assert.throws(()=>validateRequest('git.commit.selected',{...input,selected:[row]}));
 const result={commit:oid,tree:oid,parent:oid,refTarget:'refs/heads/main',committedPaths:['src/partial.ts'],retainedStagedPaths:['excluded.ts'],retainedStagedPathsTruncated:true,postCommitError:'post-commit hook failed'};
 validateResult('git.commit.selected',result);
 validateResult('git.commit.selected',{...result,parent:null,refTarget:null});
 const {parent:_parent,...withoutParent}=result;
 const {refTarget:_refTarget,...withoutRef}=result;
 assert.throws(()=>validateResult('git.commit.selected',withoutParent));
 assert.throws(()=>validateResult('git.commit.selected',withoutRef));
 validateResult('git.commit.selected',{...result,cleanupError:'git_selected_commit_cleanup_failed'});
 assert.throws(()=>validateResult('git.commit.selected',{...result,cleanupError:true}));
 assert.throws(()=>validateResult('git.commit.selected',{...result,retainedStagedPathsTruncated:'yes'}));
 validateRequest('git.merge',{projectId:'p',branch:'feature/merge',operationId:'merge-branch'});
 validateRequest('git.merge',{projectId:'p',upstream:true,operationId:'merge-upstream'});
 for(const target of [{},{branch:'feature/merge',upstream:true},{branch:'feature/merge',upstream:false},{branch:'',upstream:undefined},{upstream:false}]) assert.throws(()=>validateRequest('git.merge',{projectId:'p',operationId:'invalid-merge',...target}));
 validateResult('git.merge',{output:'Already up to date.',conflicted:false});
 validateResult('git.merge',{output:'Merge made by the recursive strategy.',conflicted:false,warning:'merge_completed_after_error'});
 assert.throws(()=>validateResult('git.merge',{output:'',conflicted:false,warning:'merge_incomplete'}));
 validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],operation:{kind:'merge',head:'abc123',message:'Merge upstream'},selectedCommit:{head,indexFingerprint:fingerprint,supported:false,unsupportedReason:'Git cannot guard symbolic HEAD',gitVersion:'test'}});
 assert.throws(()=>validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],operation:{kind:'squash'}}));
 assert.throws(()=>validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],operation:{kind:'merge',head:7}}));
 assert.throws(()=>validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],operation:{kind:'merge',message:false}}));
 assert.throws(()=>validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],selectedCommit:{head,indexFingerprint:fingerprint,supported:'yes'}}));
});

test('the additive plan part type requires a valid plan payload',()=>{
 const part={type:'plan',toolId:'plan:turn-1',data:{entries:[{content:'Write the tests',status:'in_progress',priority:'high'},{content:'Ship it',status:'pending'}],explanation:'Two-step plan'}};
 const item={id:'plan-item',role:'assistant',createdAt:'2026-01-01T00:00:00Z',turnId:'turn-1',parts:[part]};
 validateResult('chat.read',[item]);
 validateResult('chat.snapshot',{items:[item],revision:1,repair:{offered:false,reason:'history_unavailable',degraded:false},hasEarlier:false});
 // A page continues from a cursor and reports older items behind it.
 validateResult('chat.snapshot',{items:[item],revision:1,repair:{offered:false,reason:'history_unavailable',degraded:false},hasEarlier:true,nextBefore:'2026-01-01T00:00:00Z\u001fitem-1'});
 validateRequest('chat.snapshot',{sessionId:'s',before:'2026-01-01T00:00:00Z\u001fitem-1',maxBytes:65536});
 // An answer without the bounded-page flag is not a valid snapshot.
 assert.throws(()=>validateResult('chat.snapshot',{items:[item],revision:1,repair:{offered:false,reason:'history_unavailable',degraded:false}}));
 validateResult('chat.image.read',{data:'data:image/png;base64,AAAA'});
 validateRequest('chat.image.read',{sessionId:'s',itemId:'item-1',part:0,index:0});
 // An empty snapshot is an explicit clearing marker.
 validateResult('chat.read',[{...item,parts:[{...part,data:{entries:[]}}]}]);
 for(const data of [undefined,null,{}, {entries:{}}, {entries:[{}]}, {entries:[{content:'Missing status'}]}, {entries:[{content:7,status:'pending'}]}, {entries:[{content:'Bad status',status:'started'}]}, {entries:[{content:'Bad priority',status:'pending',priority:'urgent'}]}, {entries:[],unexpected:true}, {entries:[{content:'Unexpected field',status:'pending',extra:true}]}, {entries:[],explanation:7}])
  assert.throws(()=>validateResult('chat.read',[{...item,parts:[{...part,data}]}]),/Invalid runtime result/,JSON.stringify(data));
 for(const invalid of [{...part,unexpected:true},{...part,phase:'draft'}])
  assert.throws(()=>validateResult('chat.read',[{...item,parts:[invalid]}]),/Invalid runtime result/,JSON.stringify(invalid));
 // Existing non-plan parts continue to carry opaque provider payloads.
 validateResult('chat.read',[{...item,parts:[{type:'tool',data:{providerSpecific:['still','opaque']}}]}]);
 // The union stays closed: unknown part types are still rejected.
 assert.throws(()=>validateResult('chat.read',[{...item,parts:[{...part,type:'roadmap'}]}]));
});

test('session options carry additive kind, category, description and recommendation metadata',()=>{
 const ui={options:[
  {id:'model',name:'Model',value:'openai/gpt-5',category:'model',recommended:'openai/gpt-5',choices:[{value:'openai/gpt-5',name:'GPT-5',group:'openai',recommended:true},{value:'m',name:'M',description:'Fast'}]},
  {id:'fast',name:'Fast mode',value:'true',kind:'boolean',category:'other',description:'Priority processing',choices:[{value:'true',name:'On'},{value:'false',name:'Off'}]}
 ],commands:[],loadState:'ready'};
 validateResult('chat.options',ui);
 validateResult('chat.options',{...ui,options:[{id:'bare',name:'Bare',value:'a',choices:[]}]});
 validateResult('chat.option.set',ui);
 // The union stays closed: unknown kinds and categories are rejected.
 assert.throws(()=>validateResult('chat.options',{...ui,options:[{...ui.options[1],kind:'toggle'}]}));
 assert.throws(()=>validateResult('chat.options',{...ui,options:[{...ui.options[1],category:'speed'}]}));
 assert.throws(()=>validateResult('chat.options',{...ui,options:[{...ui.options[1],choices:[{value:'true',name:'On',group:2}]}]}));
});

test('chat UI skills are additive and carry a text invocation',()=>{
 validateResult('chat.options',{options:[],commands:[],skills:[{name:'skill:review',description:'Review code',invocation:'/skill:review'}]});
 // Absent or empty is valid: a provider that cannot tell skills apart publishes none.
 validateResult('chat.options',{options:[],commands:[]});
 validateResult('chat.options',{options:[],commands:[],skills:[]});
 // Invocation is required and the closed shape rejects extras.
 assert.throws(()=>validateResult('chat.options',{options:[],commands:[],skills:[{name:'x'}]}));
 assert.throws(()=>validateResult('chat.options',{options:[],commands:[],skills:[{name:'x',invocation:'/x',extra:1}]}));
 assert.throws(()=>validateResult('chat.options',{options:[],commands:[],skills:[{name:2,invocation:'/x'}]}));
});

test('background tasks are additive UI state with explicit lazy list and leased stop',()=>{
 const running={id:'proc-1',title:'Build docs',command:'npm run docs',status:'running',startedAt:'2026-10-13T12:00:00Z',canStop:true,toolId:'tool-1'};
 const finished={id:'task-2',title:'Inspect tests',status:'completed',startedAt:'2026-10-13T12:00:00Z',endedAt:'2026-10-13T12:00:05Z',canStop:false};
 validateResult('chat.options',{options:[],commands:[],backgroundTasks:[running,finished]});
 validateRequest('chat.backgroundTasks.list',{sessionId:'s'});
 validateResult('chat.backgroundTasks.list',{tasks:[running,finished]});
 const stop={sessionId:'s',taskId:'proc-1',leaseEpoch:2,operationId:'stop-1'};
 validateRequest('chat.backgroundTask.stop',stop);
 validateResult('chat.backgroundTask.stop',{accepted:true});
 assert.ok(METHODS.includes('chat.backgroundTasks.list'));
 assert.ok(METHODS.includes('chat.backgroundTask.stop'));
 for(const patch of [{sessionId:''},{taskId:''},{operationId:''},{leaseEpoch:0},{leaseEpoch:undefined}])
  assert.throws(()=>validateRequest('chat.backgroundTask.stop',{...stop,...patch}));
 for(const taskPatch of [{status:'cancelled'},{canStop:'yes'},{id:2},{title:2},{endedAt:2},{toolId:2}])
  assert.throws(()=>validateResult('chat.backgroundTasks.list',{tasks:[{...running,...taskPatch}]}));
 assert.throws(()=>validateResult('chat.backgroundTasks.list',{tasks:[{...running,provider:'codex'}]}));
});

test('native turn outcome and message phase are typed independently of duration',()=>{
 const item={id:'native-boundary',role:'assistant',parts:[],createdAt:'2026-01-01T00:00:00Z',turnId:'scoped-turn',turnStatus:'completed'};
 validateResult('chat.read',[item]);
 validateResult('chat.read',[{...item,turnStatus:'inProgress'}]);
 for(const turnStatus of ['failed','interrupted']) validateResult('chat.read',[{...item,turnStatus}]);
 validateResult('chat.read',[{...item,turnStatus:'unknown',turnOrigin:'history'}]);
 validateResult('chat.read',[{...item,parts:[{type:'text',text:'answer',phase:'final_answer'}]}]);
 assert.throws(()=>validateResult('chat.read',[{...item,turnStatus:'historical'}]));
 assert.throws(()=>validateResult('chat.read',[{...item,turnOrigin:'live'}]));
 assert.throws(()=>validateResult('chat.read',[{...item,parts:[{type:'text',text:'answer',phase:'unknown'}]}]));
 const snapshot={items:[item],revision:1,repair:{offered:true,mode:'rebuild',degraded:false,reason:'history_metadata_missing'},hasEarlier:false};
 validateResult('chat.snapshot',snapshot);
 assert.throws(()=>validateResult('chat.snapshot',{...snapshot,repair:{...snapshot.repair,reason:'invented_reason'}}));
});

test('chat repair is a leased rebuild with bounded integer counts and snapshot integrity',()=>{
 const request={sessionId:'s',leaseEpoch:1,operationId:'repair'};
 validateRequest('chat.repair',request);
 for(const patch of [{sessionId:''},{operationId:''},{leaseEpoch:0},{leaseEpoch:1.5},{leaseEpoch:undefined},{nativeId:'injected'},{mode:'merge'}]) assert.throws(()=>validateRequest('chat.repair',{...request,...patch}));
 const result={sessionId:'s',mode:'rebuild',added:2,updated:0,removed:1,expired:1,total:2,revision:10};
 validateResult('chat.repair',result);
 for(const key of ['added','updated','removed','expired','total','revision']) for(const value of [-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateResult('chat.repair',{...result,[key]:value}));
 assert.throws(()=>validateResult('chat.repair',{...result,mode:'merge'}));
 assert.throws(()=>validateResult('chat.repair',{...result,sessionId:''}));
 validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:true,mode:'rebuild',degraded:true,ingressFailed:true},hasEarlier:false});
 assert.throws(()=>validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:true,mode:'rebuild',degraded:true,ingressFailed:'true'},hasEarlier:false}));
 validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:false,reason:'history_unavailable',degraded:false},hasEarlier:false});
 assert.throws(()=>validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:false,reason:'reader_start_required',degraded:false},hasEarlier:false}));
});

test('chat allows image-only input while retaining empty-message and type guards',()=>{
 const base={sessionId:'s',text:'',operationId:'image-op',leaseEpoch:1};
 assert.throws(()=>validateRequest('chat.send',base),/Invalid text/);
 assert.throws(()=>validateRequest('chat.send',{...base,images:[]}),/Invalid text/);
 validateRequest('chat.send',{...base,images:['data:image/png;base64,aGVsbG8=']});
 validateRequest('chat.send',{...base,text:'describe',images:['data:image/png;base64,aGVsbG8=']});
 validateRequest('chat.send',{...base,text:'existing text-only call'});
 assert.throws(()=>validateRequest('chat.send',{...base,images:[2]}));
 assert.throws(()=>validateRequest('chat.send',{...base,text:2,images:['image']}));
 const steer={sessionId:'s',turnId:'turn-1',text:'',operationId:'steer-op',leaseEpoch:1};
 assert.throws(()=>validateRequest('chat.steer',steer),/Invalid text/);
 validateRequest('chat.steer',{...steer,text:'while you work'});
 validateRequest('chat.steer',{...steer,images:['data:image/png;base64,aGVsbG8='],queueItemId:'q1'});
 assert.throws(()=>validateRequest('chat.steer',{...steer,text:'while you work',leaseEpoch:undefined}));
 validateResult('chat.steer',{disposition:'delivered'});
 validateResult('chat.steer',{disposition:'queued'});
 validateResult('chat.steer',{disposition:'note'});
 assert.throws(()=>validateResult('chat.steer',{disposition:'sent'}));
});

test('file preview owners are additive and validated without changing file scope',()=>{
 const file={id:'file',kind:'preview',projectId:'p',path:'README.md'};
 const layout={kind:'pane',id:'pane',tabs:[file],activeTabId:'file'};
 validateLayout(layout);
 const params={name:'Preview',layout,expectedRevision:0,operationId:'owned'};
 validateRequest('workspace.save',params);
 const owned={...layout,tabs:[{...file,ownerSessionId:'session-a'}]};
 validateRequest('workspace.save',{...params,layout:owned});
 validateResult('workspace.save',{id:'workspace',name:'Preview',revision:1,layout:owned});
 for(const ownerSessionId of ['',null,2,'a\nb','x'.repeat(257)])assert.throws(()=>validateRequest('workspace.save',{...params,layout:{...layout,tabs:[{...file,ownerSessionId}]}}));
});

test('external file and preview tabs persist with portable absolute paths and bounded identities',()=>{
 const file={id:'external',kind:'file',projectId:'p',ownerSessionId:'chat',externalId:'registered',path:join(tmpdir(),'external-file.md')};
 const layout=tab=>({kind:'pane',id:'pane',tabs:[tab],activeTabId:tab.id});
 const params=tab=>({name:'External file',layout:layout(tab),expectedRevision:0,operationId:'external-layout'});
 const paths=[file.path,'/external/notes.md','C:\\external\\notes.md','C:/external/notes.md','\\\\server\\share\\notes.md','/'+ 'x'.repeat(16383),'/'+'😀'.repeat(4095)+'abc'];
 for(const kind of ['file','preview']) for(const path of paths) for(const externalId of ['registered','x'.repeat(256),'😀'.repeat(128)]) {
  const tab={...file,kind,path,externalId};
  validateLayout(layout(tab));
  validateRequest('workspace.save',params(tab));
  validateResult('workspace.save',{id:'workspace',name:'External file',revision:1,layout:layout(tab)});
 }
 const {externalId,...legacy}=file;
 for(const tab of [{...legacy,path:'README.md'},{...legacy,kind:'diff',path:'src/main.ts',staged:true}]) {
  validateLayout(layout(tab));
  validateRequest('workspace.save',params(tab));
  validateResult('workspace.save',{id:'workspace',name:'Legacy file',revision:1,layout:layout(tab)});
 }
});

test('external layout fields reject invalid identities, paths, kinds and staged state',()=>{
 const file={id:'external',kind:'file',projectId:'p',externalId:'registered',path:join(tmpdir(),'external-file.md')};
 const layout=tab=>({kind:'pane',id:'pane',tabs:[tab],activeTabId:tab.id});
 const patches=[...['',null,4,'x'.repeat(257),'😀'.repeat(129),'a\nb','a\u007fb','a\u0085b'].map(externalId=>({externalId})),
  ...['notes.md','C:notes.md','\\notes.md','\\\\server','/'+ 'x'.repeat(16384),'/'+'😀'.repeat(4096),'/a\nb','/a\u007fb','/a\u0085b'].map(path=>({path})),
  {kind:'diff'},{kind:'session',sessionId:'chat'},{kind:'web',url:'https://example.test/'},
  ...[false,true,null].map(staged=>({staged})),{projectId:''},{projectId:null},{ownerSessionId:''}];
 for(const patch of patches) {
  const tab={...file,...patch};
  assert.throws(()=>validateLayout(layout(tab)),undefined,JSON.stringify(patch).slice(0,100));
  assert.throws(()=>validateRequest('workspace.save',{name:'External file',layout:layout(tab),expectedRevision:0,operationId:'external-layout'}));
 }
});

test('task map tabs require a bounded session identity and no owner',()=>{
 const map={id:'map',kind:'map',sessionId:'root'};
 const layout=tab=>({kind:'pane',id:'pane',tabs:[tab],activeTabId:'map'});
 const params=tab=>({name:'Task map',layout:layout(tab),expectedRevision:0,operationId:'map'});
 for(const sessionId of ['root','x'.repeat(256),'😀'.repeat(128)]){
  const tab={...map,sessionId};
  validateLayout(layout(tab));
  validateRequest('workspace.save',params(tab));
  validateResult('workspace.save',{id:'workspace',name:'Task map',revision:1,layout:layout(tab)});
 }
 for(const tab of [{id:'map',kind:'map'},...['',null,42,'x'.repeat(257),'😀'.repeat(129)].map(sessionId=>({...map,sessionId})),...['session-a',null,42].map(ownerSessionId=>({...map,ownerSessionId}))]){
  assert.throws(()=>validateLayout(layout(tab)));
  assert.throws(()=>validateRequest('workspace.save',params(tab)));
 }
});
test('usage tabs are independent and carry only an optional bounded project',()=>{
 const usage={id:'usage',kind:'usage'};
 const layout=tab=>({kind:'pane',id:'pane',tabs:[tab],activeTabId:'usage'});
 const params=tab=>({name:'Usage',layout:layout(tab),expectedRevision:0,operationId:'usage'});
 for(const tab of [usage,{...usage,projectId:'project-a'},{...usage,projectId:'x'.repeat(256)}]){
  validateLayout(layout(tab));
  validateRequest('workspace.save',params(tab));
  validateResult('workspace.save',{id:'workspace',name:'Usage',revision:1,layout:layout(tab)});
 }
 for(const tab of [...['',null,42,'x'.repeat(257)].map(projectId=>({...usage,projectId})),...['session-a',null].map(ownerSessionId=>({...usage,ownerSessionId}))]){
  assert.throws(()=>validateLayout(layout(tab)));
  assert.throws(()=>validateRequest('workspace.save',params(tab)));
 }
});
test('group tabs preserve a bounded independent room identity and title',()=>{
 const room={id:'group',kind:'group',groupId:'room-a',title:'Group chat'};
 const layout=tab=>({kind:'pane',id:'pane',tabs:[tab],activeTabId:'group'});
 const params=tab=>({name:'Group chat',layout:layout(tab),expectedRevision:0,operationId:'group'});
 validateLayout(layout(room));
 validateRequest('workspace.save',params(room));
 validateResult('workspace.save',{id:'workspace',name:'Group chat',revision:1,layout:layout(room)});
 for(const tab of [{id:'group',kind:'group'},...['',null,42,'x'.repeat(257)].map(groupId=>({...room,groupId})),...['x'.repeat(513),'title\n'].map(title=>({...room,title})),...['session-a',null,42].map(ownerSessionId=>({...room,ownerSessionId}))]){
  assert.throws(()=>validateLayout(layout(tab)));
  assert.throws(()=>validateRequest('workspace.save',params(tab)));
 }
});

test('legacy Roundtable tabs remain readable in saved workspace layouts only',()=>{
 const room={id:'roundtable',kind:'roundtable',roundtableId:'legacy-room',title:'Old discussion'};
 const layout={kind:'pane',id:'pane',tabs:[room],activeTabId:'roundtable'};
 validateLayout(layout);
 validateRequest('workspace.save',{name:'Legacy workspace',layout,expectedRevision:1,operationId:'legacy-layout'});
 validateResult('workspace.save',{id:'workspace',name:'Legacy workspace',revision:2,layout});
 for(const tab of [{id:'roundtable',kind:'roundtable'},...['',null,42,'x'.repeat(257)].map(roundtableId=>({...room,roundtableId})),...['x'.repeat(513),'title\n'].map(title=>({...room,title})),...['session-a',null,42].map(ownerSessionId=>({...room,ownerSessionId}))]) assert.throws(()=>validateLayout({...layout,tabs:[tab]}));
});

test('web preview tabs show only http(s) pages and belong to no session',()=>{
 const web={id:'web',kind:'web',url:'http://localhost:5173/'};
 const layout={kind:'pane',id:'pane',tabs:[web],activeTabId:'web'};
 const params={name:'Web',layout,expectedRevision:0,operationId:'web'};
 validateRequest('workspace.save',params);
 validateResult('workspace.save',{id:'workspace',name:'Web',revision:1,layout});
 validateRequest('workspace.save',{...params,layout:{...layout,tabs:[{id:'web',kind:'web',url:'https://[::1]:8443/app?x=1#top'}]}});
 for(const url of ['file:///C:/Windows/win.ini','javascript:alert(1)','localhost:3000','http://','http://local host/','http://x/\u0085',`http://localhost/${'a'.repeat(2048)}`,'',3,undefined])
  assert.throws(()=>validateRequest('workspace.save',{...params,layout:{...layout,tabs:[{...web,url}]}}),undefined,String(url).slice(0,40));
 // Owned views are reached only through a file header, which a web page does not have.
 assert.throws(()=>validateRequest('workspace.save',{...params,layout:{...layout,tabs:[{...web,ownerSessionId:'session-a'}]}}));
 assert.throws(()=>validateLayout({...layout,tabs:[{...web,ownerSessionId:'session-a'}]}));
 // Fields of file tabs do not belong on a web tab (the schema forbids unknown and file-only properties).
 assert.throws(()=>validateRequest('workspace.save',{...params,layout:{...layout,tabs:[{...web,projectId:'p',path:'README.md'}]}}));
});

test('file references are additive, scoped by session, and bounded at the request boundary',()=>{
 validateRequest('filesystem.resolve',{sessionId:'s',path:'src/main.ts',line:5,column:2});
 validateRequest('filesystem.resolve',{sessionId:'s',path:'src/main.ts',column:2});
 // A JVM frame asks the runtime to search source roots for the package-relative file.
 validateRequest('filesystem.resolve',{sessionId:'s',path:'com/example/UserController.java',line:42,sourceSearch:true});
 for(const patch of [{sessionId:''},{path:''},{path:'a\0b'},{path:'x'.repeat(16385)},{line:0},{column:1000001},{line:1.5},{projectId:'injected-scope'},{sourceSearch:'yes'},{sourceSearch:1}])assert.throws(()=>validateRequest('filesystem.resolve',{sessionId:'s',path:'a.ts',...patch}));
 validateResult('filesystem.resolve',{projectId:'p',worktreePath:'D:/repo',path:'image',kind:'image',line:1});
 assert.throws(()=>validateResult('filesystem.resolve',{path:'a.ts',kind:'text'}));
 validateResult('chat.read',[{id:'tool',role:'assistant',createdAt:'now',parts:[{type:'tool',status:'failed',fileReferences:[{path:'README.md',line:2}]}]}]);
 const layout={kind:'pane',id:'pane',tabs:[{id:'image',kind:'preview',projectId:'p',path:'image',assetKind:'image'}],activeTabId:'image'};
 validateRequest('workspace.save',{name:'Test',layout,expectedRevision:0,operationId:'test'});
 assert.throws(()=>validateRequest('workspace.save',{name:'Test',layout:{...layout,tabs:[{...layout.tabs[0],assetKind:'script'}]},expectedRevision:0,operationId:'test'}));
});

test('deferred terminal launch has an additive typed request and durable phase result',()=>{
 validateRequest('session.create',{cwd:'C:\\repo',provider:'codex',mode:'terminal',deferLaunch:true,operationId:'o'});
 assert.throws(()=>validateRequest('session.create',{cwd:'C:\\repo',provider:'codex',mode:'terminal',deferLaunch:'yes',operationId:'o'}));
 validateRequest('session.launch.read',{sessionId:'s'});
 assert.throws(()=>validateRequest('session.launch.read',{sessionId:''}));
 for(const phase of ['preparing','launching','running','failed','cancelled']) validateResult('session.launch.read',{phase});
 validateResult('session.launch.read',{phase:'failed',error:{code:'native_prepare_failed',message:'Retry available'}});
 assert.throws(()=>validateResult('session.launch.read',{phase:'ready'}));
 assert.throws(()=>validateResult('session.launch.read',{phase:'failed',error:{message:'missing code'}}));
});

test('preload rejects unknown methods and unauthenticated control writes',()=>{
 assert.throws(()=>validateRequest('shell.exec',{command:'whoami'}));
 assert.throws(()=>validateRequest('terminal.input',{sessionId:'s',data:'x'}));
 assert.throws(()=>validateRequest('terminal.input',{sessionId:'s',data:'x',leaseEpoch:0}));
 assert.throws(()=>validateRequest('terminal.resize',{sessionId:'s',cols:Infinity,rows:30,leaseEpoch:1}));
 assert.throws(()=>validateRequest('chat.approve',{sessionId:'s',turnId:'t',approvalId:'a',decision:'always',leaseEpoch:1,operationId:'o'}));
 assert.throws(()=>validateRequest('chat.approve',{sessionId:'s',turnId:'t',approvalId:'a',decision:'allow',leaseEpoch:1,operationId:'o'}));
 validateRequest('chat.approve',{sessionId:'s',turnId:'t',approvalId:'a',choiceId:'allow_once',leaseEpoch:1,operationId:'o'});
 validateRequest('chat.connection',{sessionId:'s'});
 validateRequest('chat.connect',{sessionId:'s',leaseEpoch:1,operationId:'o'});
 assert.throws(()=>validateRequest('chat.connect',{sessionId:'s',operationId:'o'}));
});
test('chat.answer carries a typed question response and always requires the active chat lease',()=>{
 const base={sessionId:'s',turnId:'turn',approvalId:'question',leaseEpoch:1,operationId:'answer'};
 assert.ok(METHODS.includes('chat.answer'));
 validateRequest('chat.answer',{...base,response:{action:'submit',values:{color:['Blue'],count:2,enabled:true}}});
 validateRequest('chat.answer',{...base,response:{action:'dismiss'}});
 for(const response of [
  {action:'submit'},
  {action:'submit',values:null},
  {action:'submit',values:{color:[2]}},
  {action:'submit',values:{color:{label:'Blue'}}},
  {action:'dismiss',values:{}},
  {action:'accept',values:{}},
 ]) assert.throws(()=>validateRequest('chat.answer',{...base,response}),undefined,JSON.stringify(response));
 for(const patch of [
  {leaseEpoch:undefined}, {leaseEpoch:0}, {operationId:''}, {approvalId:''}, {turnId:''},
 ]) assert.throws(()=>validateRequest('chat.answer',{...base,...patch,response:{action:'dismiss'}}));
});
test('chat.answer accepts only the additive plan review decisions and optional feedback',()=>{
 const base={sessionId:'s',turnId:'turn',approvalId:'plan',leaseEpoch:1,operationId:'answer'};
 for(const response of [
  {action:'approve'},
  {action:'request_changes'},
  {action:'request_changes',feedback:'Please split the migration into two commits.'},
  {action:'abandon'},
 ]) validateRequest('chat.answer',{...base,response});
 for(const response of [
  {action:'approve',feedback:7},
  {action:'abandon',feedback:'x'.repeat(16_001)},
  {action:'plan'},
 ]) assert.throws(()=>validateRequest('chat.answer',{...base,response}),undefined,JSON.stringify(response));
});
test('Pi project trust is additive to chat UI and has a leased decision RPC',()=>{
 assert.ok(METHODS.includes('chat.projectTrust.set'));
 const trust={protectedResources:['.pi/extensions','.agents/skills'],piDecision:'none',defaultProjectTrust:'ask',threadtermDecision:'none',effective:'skipped'};
 validateResult('chat.options',{options:[],commands:[],piTrust:trust});
 validateResult('chat.options',{options:[],commands:[],piTrust:{...trust,protectedResources:[],outsideProtectedResources:[{path:'.pi/extensions/link',target:'D:/outside/extension'}]}});
 assert.throws(()=>validateResult('chat.options',{options:[],commands:[],piTrust:{...trust,outsideProtectedResources:[{path:'.pi/extensions/link',target:4}]}}));
 validateRequest('chat.projectTrust.set',{sessionId:'s',decision:'trusted',leaseEpoch:1,operationId:'trust'});
 for(const decision of ['always','',7]) assert.throws(()=>validateRequest('chat.projectTrust.set',{sessionId:'s',decision,leaseEpoch:1,operationId:'trust'}));
 assert.throws(()=>validateRequest('chat.projectTrust.set',{sessionId:'s',decision:'trusted',operationId:'trust'}));
});
test('mutation boundary requires conflict and idempotency fields',()=>{
 validateRequest('catalog.visibility.list',{});
 validateRequest('catalog.visibility.update',{kind:'session',id:'s',visibility:'archived',expectedRevision:0,operationId:'visibility'});
 assert.throws(()=>validateRequest('catalog.visibility.update',{kind:'unknown',id:'s',visibility:'archived',expectedRevision:0,operationId:'visibility'}));
 assert.throws(()=>validateRequest('catalog.visibility.update',{kind:'session',id:'s',visibility:'hidden',expectedRevision:0,operationId:'visibility'}));
 assert.throws(()=>validateRequest('catalog.visibility.update',{kind:'session',id:'s',visibility:'archived',operationId:'visibility'}));
 assert.throws(()=>validateRequest('catalog.visibility.update',{kind:'session',id:'s',visibility:'archived',projectId:'p',expectedRevision:0,operationId:'visibility'}));
 assert.throws(()=>validateRequest('filesystem.write',{projectId:'p',path:'a',content:'data',operationId:'o'}));
 assert.throws(()=>validateRequest('draft.put',{projectId:'p',path:'a',content:'data',baseFingerprint:'sha',operationId:'o'}));
 assert.throws(()=>validateRequest('settings.update',{patch:{theme:'dark'},operationId:'o'}));
 validateRequest('filesystem.write',{projectId:'p',path:'a',content:'',expectedFingerprint:'sha',operationId:'o'});
 validateRequest('draft.put',{projectId:'p',path:'a',content:'data',baseFingerprint:'sha',expectedRevision:0,operationId:'o'});
 assert.throws(()=>validateRequest('device.enable',{}));
 assert.throws(()=>validateRequest('device.pairing.create',{permission:'admin',operationId:'o'}));
 validateRequest('device.pairing.create',{permission:'readonly',operationId:'o'});
 validateRequest('device.pairing.cancel',{pairingId:'p',operationId:'o'});
 assert.throws(()=>validateRequest('device.pairing.cancel',{pairingId:'p',code:'secret',operationId:'o'}));
 validateRequest('device.rename',{deviceId:'d',name:'  Phone  ',operationId:'o'});
 assert.throws(()=>validateRequest('device.rename',{deviceId:'d',name:'   ',operationId:'o'}));
 assert.throws(()=>validateRequest('device.rename',{deviceId:'d',name:'x'.repeat(81),operationId:'o'}));
 validateRequest('device.renew',{deviceId:'d',operationId:'o'});
 validateRequest('device.revoke',{deviceId:'d',operationId:'o'});
 assert.throws(()=>validateRequest('history.import',{provider:'codex',nativeId:'n',cwd:'C:\\repo',operationId:'o'}));
 validateRequest('history.import',{provider:'codex',nativeId:'n',cwd:'C:\\repo',mode:'chat',operationId:'o'});
 assert.throws(()=>validateRequest('terminal.read',{sessionId:'s',cursor:0,tail:true,limit:8192}));
 assert.throws(()=>validateRequest('terminal.read',{sessionId:'s',tail:true,limit:8193}));
 assert.throws(()=>validateRequest('terminal.read',{sessionId:'s',cursor:-1}));
 validateRequest('terminal.read',{sessionId:'s',tail:true,limit:8192});
 validateRequest('session.stop',{sessionId:'s',operationId:'o',force:true});
 assert.throws(()=>validateRequest('session.stop',{sessionId:'s',operationId:'o',force:'yes'}));
 validateRequest('session.attention.acknowledge',{sessionId:'s',expectedRevision:3,operationId:'handled'});
 assert.throws(()=>validateRequest('session.attention.acknowledge',{sessionId:'s',expectedRevision:-1,operationId:'handled'}));
 assert.throws(()=>validateRequest('session.attention.acknowledge',{sessionId:'s',expectedRevision:3}));
});
test('session activity is additive and limited to its canonical states',()=>{
 const session={id:'s',title:'Chat',provider:'codex',mode:'chat',status:'idle',createdAt:'now',updatedAt:'now',activity:{state:'awaiting_input',revision:2,turnId:'turn'}};
 validateResult('session.attention.acknowledge',{...session,activity:{state:'idle',revision:3,turnId:'turn'}});
 assert.throws(()=>validateResult('session.attention.acknowledge',{...session,activity:{state:'done',revision:3}}));
});

test('terminal.host reports only the two console hosts',()=>{
 assert.ok(METHODS.includes('terminal.host'));
 validateRequest('terminal.host',{});
 validateResult('terminal.host',{conptyHost:'system',bundledAvailable:false});
 validateResult('terminal.host',{conptyHost:'bundled',bundledAvailable:true});
 assert.throws(()=>validateResult('terminal.host',{conptyHost:'winpty',bundledAvailable:true}));
 assert.throws(()=>validateResult('terminal.host',{conptyHost:'bundled'}),'bundledAvailable is required');
 assert.throws(()=>validateResult('terminal.host',{conptyHost:'bundled',bundledAvailable:true,build:1}));
});

test('a delegation may say how many of the user\'s messages were attached, and nothing else new',()=>{
 const delegation={id:'d',parentSessionId:'p',workspace:'shared',state:'running'};
 const session={id:'s',title:'Chat',provider:'codex',mode:'chat',status:'idle',createdAt:'now',updatedAt:'now',delegation};
 validateResult('session.attention.acknowledge',session);
 validateResult('session.attention.acknowledge',{...session,delegation:{...delegation,userMessages:3}});
 assert.throws(()=>validateResult('session.attention.acknowledge',{...session,delegation:{...delegation,userMessages:'3'}}));
 assert.throws(()=>validateResult('session.attention.acknowledge',{...session,delegation:{...delegation,attachedMessages:3}}));
});
test('catalog and device admin results keep scope metadata additive and credentials write-only',()=>{
 const visibility={kind:'worktree',id:'w',visibility:'archived',revision:1,projectId:'p',worktreePath:'C:\\repo\\tree'};
 validateResult('catalog.visibility.list',[visibility]);
 validateResult('catalog.visibility.update',visibility);
 const device={id:'d',name:'Phone',permission:'fullcontrol',createdAt:'2026-09-10T00:00:00Z',expiresAt:'2026-09-11T00:00:00Z'};
 validateResult('device.rename',device);
 validateResult('device.renew',device);
 assert.throws(()=>validateResult('device.renew',{...device,token:'must-not-cross-admin-result'}));
});
test('workspace layouts reject excessive panes, invalid active identities and duplicate node ids',()=>{
 const pane=id=>({kind:'pane',id,tabs:[],activeTabId:null});
 const split=(id,first,second)=>({kind:'split',id,direction:'horizontal',ratio:0.5,first,second});
 validateLayout(split('r',pane('a'),pane('b')));
 assert.throws(()=>validateLayout(split('r',pane('a'),pane('a'))));
 assert.throws(()=>validateLayout({...pane('p'),activeTabId:'missing'}));
 assert.throws(()=>validateLayout(split('a',split('b',pane('1'),pane('2')),split('c',pane('3'),split('d',pane('4'),pane('5'))))));
});
test('control events require epoch and integral sequence, method registry has no duplicate',()=>{
 assert.equal(isRuntimeEvent({v:1,event:'state.changed',epoch:'e',seq:1,data:{}}),true);
 assert.equal(isRuntimeEvent({v:1,event:'state.changed',seq:1,data:{}}),false);
 assert.equal(isRuntimeEvent({v:1,event:'state.changed',epoch:'e',seq:NaN,data:{}}),false);
 assert.equal(new Set(METHODS).size,METHODS.length);
});

test('portable settings export accepts custom themes while rejecting extra fields',()=>{
 const result={marker:'threadterm-v3-settings',version:1,exportedAt:'2026-09-10T00:00:00Z',settings:{theme:'dark',themeSelection:'custom:ocean',customThemes:{ocean:{background:'#07111f',surface:'#10233c',text:'#ffffff',muted:'#91a4bf',accent:'#3b82f6',border:'#274768'}}}};
 validateResult('settings.export',result);
 assert.throws(()=>validateResult('settings.export',{...result,settings:{...result.settings,providerApiKey:'not-portable'}}));
 assert.throws(()=>validateResult('settings.export',{...result,settings:{customThemes:{broken:{background:'#000000'}}}}));
});

test('custom themes and theme selections carry the appearance roles',()=>{
 const base={marker:'threadterm-v3-settings',version:1,exportedAt:'2026-09-10T00:00:00Z'};
 const theme={background:'#07111f',surface:'#10233c',text:'#ffffff',muted:'#91a4bf',accent:'#3b82f6',border:'#274768'};
 // Old six-key packs keep validating unchanged.
 validateResult('settings.export',{...base,settings:{customThemes:{ocean:theme}}});
 // New optional role colours and base preset ids are part of the bundle.
 validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,sidebar:'#050a13',editor:'#0b1a2b',base:'tokyo-night'}}}});
 for(const themeSelection of ['light','dark','system','custom:ocean','preset:github-dark','system:rose-pine']){
  validateResult('settings.export',{...base,settings:{themeSelection}});
 }
 // Unknown keys are still rejected: only the documented appearance keys are portable.
 const image='a'.repeat(64);
 const layer={image,opacity:100,blur:8,overlay:35,fit:'cover',focusX:50,focusY:50,scale:100};
 // A theme may carry one picture layer per region; an empty map means no backgrounds.
 validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{window:layer,chat:{...layer,fit:'tile',blur:0,scale:200}}}}}});
 // A layer may show the window picture (`inherit`); the wire schema only checks the type, the runtime rejects a window
 // layer that inherits from itself.
 validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{window:layer,chat:{...layer,image:'inherit',overlay:20}}}}}});
 validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{}}}}});
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{inspector:layer}}}}}));
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{window:{...layer,opacity:'40'}}}}}}));
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{window:{...layer,fit:'fill'}}}}}}));
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{window:{...layer,image:7}}}}}}));
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,backgrounds:{window:{...layer,scale:100,extra:1}}}}}}));
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,extra:'#112233'}}}}));
 assert.throws(()=>validateResult('settings.export',{...base,settings:{customThemes:{ocean:{...theme,sidebar:7}}}}));
});

test('handshake rejects old and mismatched Chat approval contracts without implying a runtime kill',()=>{
 assert.equal(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:PROTOCOL_CONTRACT}),undefined);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION}),/older and was left running/);
 assert.match(protocolIncompatibleReason({kind:'auth',clientId:'c',protocol:PROTOCOL_VERSION,nonce:'n',hmac:'00'},'runtime'),/Running jobs were not stopped/);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:1}),new RegExp('contract '+PROTOCOL_CONTRACT));
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:12}),/contract 17/);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:12}),/left running/);
 assert.match(protocolIncompatibleReason({kind:'auth',clientId:'c',protocol:PROTOCOL_VERSION,nonce:'n',hmac:'00',contract:12},'runtime'),/contract 17/);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:13}),/contract 17/);
 assert.match(protocolIncompatibleReason({kind:'auth',clientId:'c',protocol:PROTOCOL_VERSION,nonce:'n',hmac:'00',contract:12},'runtime'),/were not stopped/);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:99,contract:PROTOCOL_CONTRACT}),/wire protocol/);
 validateResult('runtime.health',{version:'0.1.0',epoch:'e',contract:PROTOCOL_CONTRACT});
 assert.throws(()=>validateResult('runtime.health',{version:'0.1.0',epoch:'e'}));
});

test('chat connection and options results distinguish unknown from empty success',()=>{
 validateResult('chat.connection',{
  sessionId:'s',runtimeEpoch:'e',connectionGeneration:1,revision:2,phase:'connecting',optionsLoadState:'unknown'
 });
 validateResult('chat.connection',{
  sessionId:'s',runtimeEpoch:'e',connectionGeneration:2,revision:3,phase:'failed',nativeId:'n',
  error:{code:'chat_permission_restore_failed',message:'restore failed',retryable:true,category:'provider',permissionRestore:{optionId:'sandbox',savedValue:'danger-full-access',reportedValue:'workspace-write',reason:'mismatch',optionName:'Sandbox',savedLabel:'Full access',reportedLabel:'Workspace write'}},
  optionsLoadState:'error',optionsError:{code:'chat_not_open',message:'not open'}
 });
 assert.throws(()=>validateResult('chat.connection',{
  sessionId:'s',runtimeEpoch:'e',connectionGeneration:2,revision:3,phase:'failed',
  error:{code:'chat_permission_restore_failed',message:'restore failed',retryable:true,permissionRestore:{optionId:'sandbox',savedValue:'danger-full-access',reason:'other'}},
  optionsLoadState:'error'
 }));
 assert.throws(()=>validateResult('chat.connection',{
  sessionId:'s',runtimeEpoch:'e',connectionGeneration:1,revision:1,phase:'ready'
 }));
 validateResult('chat.options',{options:[],commands:[],loadState:'unknown',error:{code:'chat_not_open',message:'not open'}});
 validateResult('chat.options',{options:[],commands:[]});
 assert.throws(()=>validateResult('chat.options',{options:[],commands:[],loadState:'success'}));
});

test('chat protocol preserves structured Codex status parts',()=>{
 validateResult('chat.read',[{
  id:'status-item',role:'assistant',createdAt:'2026-09-12T00:00:00Z',turnId:'status-turn',parts:[{
   type:'status',status:'complete',text:'Codex session status',data:{model:'gpt-5.5-luna',rateLimits:[],context:{modelContextWindow:258000}}
  }]
 }]);
});

test('agent ids are checked for shape only; the runtime registry decides which agents exist',()=>{
 for(const provider of ['codex','shell','echo','qwen-code']) validateRequest('session.create',{cwd:'C:\repo',provider,mode:'chat',operationId:'o'});
 for(const provider of ['','Echo','1agent','a','x'.repeat(40),'../codex']) assert.throws(()=>validateRequest('session.create',{cwd:'C:\repo',provider,mode:'chat',operationId:'o'}),/Invalid provider/);
 assert.throws(()=>validateRequest('session.create',{cwd:'C:\repo',provider:7,mode:'chat',operationId:'o'}),/protocol schema/);
});

test('prompt queue mutations need the Chat lease and bounded positions; image-only items are allowed like chat.send',()=>{
 const lease={sessionId:'s',operationId:'o',leaseEpoch:1};
 validateRequest('chat.queue.read',{sessionId:'s'});
 validateRequest('chat.queue.add',{...lease,text:'next step'});
 validateRequest('chat.queue.add',{...lease,text:'',images:['data:image/png;base64,AAAA']});
 assert.throws(()=>validateRequest('chat.queue.add',{...lease,text:''}),/Invalid text/);
 assert.throws(()=>validateRequest('chat.queue.add',{sessionId:'s',operationId:'o',text:'x'}),/Missing leaseEpoch|protocol schema/);
 validateRequest('chat.queue.update',{...lease,itemId:'i',text:'edited',expectedRevision:2});
 assert.throws(()=>validateRequest('chat.queue.update',{...lease,itemId:'i',text:'edited',expectedRevision:0}),/Invalid queue item revision/);
 validateRequest('chat.queue.move',{...lease,itemId:'i',toIndex:0});
 for(const toIndex of [-1,20,1.5]) assert.throws(()=>validateRequest('chat.queue.move',{...lease,itemId:'i',toIndex}),/Invalid queue position|protocol schema/);
 for(const m of ['chat.queue.pause','chat.queue.resume']) validateRequest(m,lease);
 validateRequest('chat.queue.send',{...lease,itemId:'i'});
 validateResult('chat.queue.read',{sessionId:'s',paused:true,pauseReason:'restarted',items:[{id:'i',text:'t',images:[],revision:1,createdAt:'c',updatedAt:'u',state:'failed',error:'e'}]});
});

test('agent reviews take a shape-checked agent and a checkpoint or uncommitted scope; marks and results are bounded and exact',()=>{
 const base={sessionId:'s',agent:'codex',operationId:'o'};
 validateRequest('agentReview.start',{...base,scope:{kind:'checkpoints',from:'c1'}});
 validateRequest('agentReview.start',{...base,scope:{kind:'checkpoints',from:'c1',to:'c2'}});
 validateRequest('agentReview.start',{...base,agent:'qwen-code',scope:{kind:'uncommitted'}});
 for(const scope of [{kind:'checkpoints'},{kind:'checkpoints',from:''},{kind:'checkpoints',from:'c',to:''},{kind:'session'},{kind:'uncommitted',from:'c'},null,'uncommitted'])
  assert.throws(()=>validateRequest('agentReview.start',{...base,scope}),/Invalid review scope|protocol schema/,JSON.stringify(scope));
 for(const agent of ['','Codex','../x']) assert.throws(()=>validateRequest('agentReview.start',{...base,agent,scope:{kind:'uncommitted'}}),/Invalid agent/);
 assert.throws(()=>validateRequest('agentReview.start',{sessionId:'s',agent:'codex',scope:{kind:'uncommitted'}}),/Invalid operationId|protocol schema/);
 validateRequest('agentReview.list',{sessionId:'s'});
 validateRequest('agentReview.mark',{reviewId:'r',findingIds:['f1','f2'],state:'added',operationId:'o'});
 for(const findingIds of [[],[''],Array.from({length:101},(_,index)=>`f${index}`)])
  assert.throws(()=>validateRequest('agentReview.mark',{reviewId:'r',findingIds,state:'dismissed',operationId:'o'}),/Invalid findings|protocol schema/);
 assert.throws(()=>validateRequest('agentReview.mark',{reviewId:'r',findingIds:['f'],state:'done',operationId:'o'}),/protocol schema/);
 const started={id:'r',sessionId:'s',reviewerSessionId:'rs',agent:'claude',scope:{kind:'checkpoints',from:'c1'},state:'starting',files:2,truncated:[],instructions:'built-in',createdAt:'t',updatedAt:'t'};
 validateResult('agentReview.start',started);
 const findings=[{id:'f1',severity:'high',path:'src/a.ts',line:12,title:'Null deref',body:'x may be null',state:'open'},{id:'f2',severity:'info',title:'General',body:'b',state:'added'}];
 const completed={...started,state:'completed',truncated:['big.json'],instructions:'repository',findings};
 validateResult('agentReview.list',[completed,{...started,id:'r2',state:'failed',error:'agent_unavailable'},{...started,id:'r3',state:'completed',scope:{kind:'uncommitted'},unparsed:true}]);
 validateResult('agentReview.mark',completed);
 assert.throws(()=>validateResult('agentReview.list',[{...completed,findings:[{...findings[0],severity:'critical'}]}]));
 assert.throws(()=>validateResult('agentReview.list',[{...completed,findings:[{...findings[0],state:'resolved'}]}]));
 assert.throws(()=>validateResult('agentReview.start',{...started,extra:1}));
});

test('groups validate messages, members, archive state, paging, and the member session link',()=>{
 const member={sessionId:'s-a',provider:'codex',handle:'codex',model:'fixture-model',mode:'read_only',readOnly:'enforced',readOnlyNote:'Read-only',state:'idle',joinedAt:'t'};
 const message={id:'message-1',author:'user',body:'Review @claude',recipients:['codex'],references:[{kind:'reply',messageId:'reply-1',handle:'claude',title:"@claude's reply",bytes:12}],deliveries:[{sessionId:'s-a',handle:'codex',state:'queued'}],createdAt:'t'};
 const group={id:'g-1',revision:2,projectId:'p',worktreePath:'fixture-workspace',cwd:'fixture-workspace',title:'Group chat',members:[member,{...member,sessionId:'s-b',provider:'claude',handle:'claude',mode:'default',readOnly:undefined,readOnlyNote:undefined,state:'working'}],messages:[message],lastRecipients:['codex'],filesCheck:{state:'on'},hasMore:true,before:'message-0',createdAt:'t',updatedAt:'u'};
 const create={projectId:'p',cwd:'fixture-workspace',title:'Group chat',members:[{provider:'codex',handle:'codex',model:'fixture-model',mode:'read_only'},{provider:'claude'}],fromSessionId:'source',operationId:'create-group'};
 validateRequest('group.create',create); validateRequest('group.create',{...create,expectedRevision:0}); validateResult('group.create',group);
 const outputs={files:['codex/page.html'],urls:[],changed:['codex/page.html'],changedDetails:[{path:'codex/page.html',status:'added',evidence:'folder'}],possiblyChanged:['shared/style.css'],changedIncomplete:true,possiblyChangedWith:['claude']};
 validateResult('group.read',{...group,messages:[{...message,id:'reply-1',author:'member',sessionId:'s-a',handle:'codex',outputs}]});
 validateResult('group.read',{...group,messages:[{...message,id:'reply-tool-only',author:'member',sessionId:'s-a',handle:'codex',outputs:{...outputs,changedDetails:[{path:'codex/tool-only.txt',status:'changed',evidence:'tool'}]}}]});
 for(const patch of [
  {changedDetails:[{path:'codex/page.html',status:'renamed',evidence:'folder'}]},
  {changedDetails:[{path:'codex/page.html',status:'added',evidence:'guess'}]},
  {possiblyChanged:'shared/style.css'},
  {changedIncomplete:'yes'},
  {possiblyChangedWith:[1]},
 ]) assert.throws(()=>validateResult('group.read',{...group,messages:[{...message,id:'reply-1',author:'member',sessionId:'s-a',handle:'codex',outputs:{...outputs,...patch}}]}));
 for(const expectedRevision of [-1,1,1.5]) assert.throws(()=>validateRequest('group.create',{...create,expectedRevision}),/Invalid group revision/);
 for(const patch of [{members:[]},{members:Array.from({length:7},()=>({provider:'codex'}))},{members:[{provider:'Codex'}]},{members:[{provider:'codex',handle:'Bad_Handle'}]},{members:[{provider:'codex',model:' '}]}]) assert.throws(()=>validateRequest('group.create',{...create,...patch}),/Invalid group|protocol schema/);
 validateRequest('group.list',{}); validateRequest('group.list',{projectId:'p'}); validateResult('group.list',[{id:'g-1',title:'Group chat',projectId:'p',worktreePath:'fixture-workspace',members:[{sessionId:'s-a',provider:'codex',handle:'codex',state:'idle'}],updatedAt:'u'}]); assert.throws(()=>validateRequest('group.list',{projectId:'p',extra:true}));
 validateRequest('group.read',{id:'g-1',before:'message-0',limit:200}); validateResult('group.read',group); assert.throws(()=>validateRequest('group.read',{id:'g-1',limit:201}));
 const send={id:'g-1',text:'Please review this.',to:['codex'],references:[{kind:'reply',messageId:'reply-1'}],expectedRevision:2,operationId:'send-group'};
 validateRequest('group.send',send); validateResult('group.send',{...group,revision:3});
 for(const patch of [{text:' '},{text:'x'.repeat(64*1024+1)},{to:[]},{to:['all','codex']},{to:['Bad']},{references:Array.from({length:9},()=>({kind:'file',path:'x'}))}]) assert.throws(()=>validateRequest('group.send',{...send,...patch}),/Invalid group|protocol schema/);
 validateRequest('group.stop',{id:'g-1',messageId:'message-1',handle:'codex',expectedRevision:2,operationId:'stop-group'});
 validateRequest('group.resend',{id:'g-1',messageId:'message-1',handle:'codex',operationId:'resend-group'});
 validateRequest('group.member.add',{id:'g-1',provider:'claude',handle:'reviewer',mode:'default',operationId:'add-group'});
 validateRequest('group.member.update',{id:'g-1',sessionId:'s-a',handle:'designer',operationId:'update-group'});
 validateRequest('group.member.remove',{id:'g-1',sessionId:'s-a',operationId:'remove-group'});
 validateRequest('group.rename',{id:'g-1',title:'Renamed',operationId:'rename-group'});
 validateRequest('group.archive',{id:'g-1',operationId:'archive-group'}); validateRequest('group.archive',{id:'g-1',archived:false,operationId:'restore-group'});
 for(const method of ['group.stop','group.resend','group.member.add','group.member.update','group.member.remove','group.rename','group.archive']) assert.throws(()=>validateRequest(method,{id:'g-1',operationId:'bad',expectedRevision:0,...(method==='group.stop'||method==='group.resend'?{messageId:'m',handle:'codex'}:method==='group.member.add'?{provider:'codex'}:method==='group.member.update'?{sessionId:'s',handle:'next'}:method==='group.member.remove'?{sessionId:'s'}:method==='group.rename'?{title:'x'}:{})}),/Invalid group revision/);
 validateResult('session.create',{id:'s-a',title:'Group chat · @codex',provider:'codex',mode:'chat',status:'idle',createdAt:'t',updatedAt:'t',group:{id:'g-1',handle:'codex'}});
});

test('group mention parsing keeps text untouched and routes only known handles',async()=>{
 const {parseGroupMentions}=await import('./index.ts');
 assert.deepEqual(parseGroupMentions('@codex @claude make drafts',['codex','claude']),{to:['codex','claude'],referenceHandles:[],unknownHandles:[]});
 assert.deepEqual(parseGroupMentions('@codex review @claude',['codex','claude']),{to:['codex'],referenceHandles:['claude'],unknownHandles:[]});
 assert.deepEqual(parseGroupMentions('review @claude @unknown',['codex','claude'],['codex']),{to:['codex'],referenceHandles:['claude'],unknownHandles:['unknown']});
 assert.deepEqual(parseGroupMentions('no mention',['codex']),{to:['all'],referenceHandles:[],unknownHandles:[]});
});

test('worktree setup saves an ordered unique list of up to 20 commands and runs from a bounded step',()=>{
 validateRequest('quickLaunch.setup.read',{projectId:'p'});
 validateRequest('quickLaunch.setup.save',{projectId:'p',commandIds:['install','build'],expectedRevision:0,operationId:'o'});
 validateRequest('quickLaunch.setup.save',{projectId:'p',commandIds:[],expectedRevision:3,operationId:'o'});
 for(const commandIds of [['a','a'],[''],Array.from({length:21},(_,index)=>`c${index}`),'install'])
  assert.throws(()=>validateRequest('quickLaunch.setup.save',{projectId:'p',commandIds,expectedRevision:0,operationId:'o'}),/Invalid setup commands|protocol schema/);
 for(const expectedRevision of [-1,1.5]) assert.throws(()=>validateRequest('quickLaunch.setup.save',{projectId:'p',commandIds:[],expectedRevision,operationId:'o'}),/Invalid setup revision|protocol schema/);
 validateRequest('quickLaunch.setup.run',{projectId:'p',cwd:'C:\\repo-wt',operationId:'o'});
 validateRequest('quickLaunch.setup.run',{projectId:'p',cwd:'C:\\repo-wt',fromStep:2,operationId:'o'});
 for(const fromStep of [-1,20,0.5]) assert.throws(()=>validateRequest('quickLaunch.setup.run',{projectId:'p',cwd:'C:\\repo-wt',fromStep,operationId:'o'}),/Invalid setup step|protocol schema/);
 validateResult('quickLaunch.setup.read',{projectId:'p',revision:0,commandIds:[]});
 const run={id:'s',projectId:'p',root:'C:\\repo-wt',commandIds:['install','build'],names:['Install','Build'],step:1,state:'failed',sessionIds:['t1','t2'],exitCode:1,trigger:'worktree.create',createdAt:'t',updatedAt:'t'};
 validateResult('quickLaunch.setup.run',run);
 validateResult('quickLaunch.setup.status',[run,{...run,id:'s2',state:'interrupted',exitCode:undefined,trigger:'retry'}].map(({exitCode,...rest})=>exitCode===undefined?rest:{...rest,exitCode}));
 assert.throws(()=>validateResult('quickLaunch.setup.run',{...run,state:'paused'}));
 assert.throws(()=>validateResult('quickLaunch.setup.run',{...run,trigger:'startup'}));
 validateResult('quickLaunch.run',{existing:false,session:{id:'t1',title:'Install',provider:'custom',mode:'terminal',status:'running',createdAt:'t',updatedAt:'t',run:{commandId:'install',name:'Install',kind:'task',shell:'cmd',setup:{runId:'s',step:0,total:2}}}});
 // An agent-started run carries the calling Chat session; a user run leaves it out.
 validateResult('quickLaunch.run',{existing:false,session:{id:'t2',title:'Dev',provider:'custom',mode:'terminal',status:'running',createdAt:'t',updatedAt:'t',run:{commandId:'dev',name:'Dev',kind:'service',shell:'cmd',readiness:'ready',port:5173,startedBy:'chat-session',setup:{runId:'s',step:0,total:1}}}});
 assert.throws(()=>validateResult('quickLaunch.run',{existing:false,session:{id:'t2',title:'Dev',provider:'custom',mode:'terminal',status:'running',createdAt:'t',updatedAt:'t',run:{commandId:'dev',name:'Dev',kind:'service',shell:'cmd',startedBy:7}}}));
});

test('session documents pin relative paths inside the worktree and list exact rows',()=>{
 validateRequest('session.documents.list',{sessionId:'s'});
 for(const path of ['docs/plan.md','notes.txt','.trellis/plan.md','a\\b.md','docs/..hidden.md'])
  for(const m of ['session.documents.pin','session.documents.unpin']) validateRequest(m,{sessionId:'s',path,operationId:'o'});
 for(const path of ['','../x.md','docs/../../x.md','a\\..\\b.md','/etc/plan.md','\\server\\share.md','C:\\repo\\plan.md','c:plan.md','a\0b'])
  assert.throws(()=>validateRequest('session.documents.pin',{sessionId:'s',path,operationId:'o'}),/Invalid path/,JSON.stringify(path));
 assert.throws(()=>validateRequest('session.documents.pin',{sessionId:'s',path:'docs/plan.md'}),/Invalid operationId|protocol schema/);
 validateResult('session.documents.list',[{path:'docs/plan.md',title:'Checkout plan',pinnedAt:'t'},{path:'notes.txt',pinnedAt:'t',missing:true}]);
 assert.throws(()=>validateResult('session.documents.pin',[{path:'docs/plan.md',pinnedAt:'t',size:3}]));
 assert.equal(PROTOCOL_CONTRACT,17);
});

test('preview presentation is attachment-scoped and requires a persisted tab acknowledgement',()=>{
 const base={sessionId:'a',attachmentId:'view-a',requestId:'r',previewId:'p',documentId:'d'};
 validateRequest('preview.attach',{sessionId:'a',viewId:'v'});
 validateRequest('preview.ack',{...base,state:'presented',tabId:'tab',workspaceId:'w',workspaceRevision:1});
 for(const patch of [{workspaceRevision:0},{workspaceRevision:1.5},{tabId:undefined},{sessionId:'a\0b'}])assert.throws(()=>validateRequest('preview.ack',{...base,state:'presented',tabId:'tab',workspaceId:'w',workspaceRevision:1,...patch}));
 validateRequest('preview.observe',{...base,sequence:2,navigation:'load_observed'});
 assert.throws(()=>validateRequest('preview.observe',{...base,sequence:0.5,navigation:'load_observed'}));
 assert.throws(()=>validateRequest('preview.attach',{sessionId:'a',viewId:'v',callerToken:'secret'}));
 const result={requestId:'r',previewId:'p',state:'presented',sequence:2,navigation:'load_observed',applicationReady:'unknown',contentVerified:false};
 validateResult('preview.ack',result);assert.throws(()=>validateResult('preview.ack',{...result,contentVerified:true}));
 assert.throws(()=>validateResult('preview.ack',{...result,applicationReady:'ready'}));
});

test('quick launch commands are bounded: relative cwd inside the root, known shells, unique env names, revisioned updates',()=>{
 const base={projectId:'p',name:'Web dev server',command:'npm run dev',shell:'cmd',cwd:'',kind:'service',env:[],operationId:'o'};
 validateRequest('quickLaunch.save',base);
 validateRequest('quickLaunch.save',{...base,cwd:'packages\\web',shell:'pwsh',kind:'task',env:[{name:'JAVA_HOME',value:'C:\\jdk'},{name:'Path',value:'C:\\tools;%PATH%'}],previewUrl:'http://localhost:5173/'});
 validateRequest('quickLaunch.save',{...base,id:'c',expectedRevision:2,command:'Write-Host "a b"\nnpm test'});
 for(const cwd of ['..','a/../..','..\\x','C:\\repo','/abs','\\\\server\\share','a|b']) assert.throws(()=>validateRequest('quickLaunch.save',{...base,cwd}),/Invalid working directory/);
 // Enums: the generated schema rejects these first; the explicit checks back it up.
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,shell:'bash'}),/Invalid shell|protocol schema/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,kind:'daemon'}),/Invalid command kind|protocol schema/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,name:'   '}),/Invalid command name/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,command:'x'.repeat(8001)}),/Invalid command text/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,env:[{name:'A',value:'1'},{name:'a',value:'2'}]}),/Invalid environment overrides/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,env:[{name:'1BAD',value:''}]}),/Invalid environment overrides/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,previewUrl:'file:///C:/x.html'}),/Invalid preview address/);
 assert.throws(()=>validateRequest('quickLaunch.save',{...base,id:'c'}),/Invalid command revision/);
 assert.throws(()=>validateRequest('quickLaunch.delete',{id:'c',expectedRevision:0,operationId:'o'}),/Invalid command revision/);
 validateRequest('quickLaunch.run',{commandId:'c',cwd:'C:\\repo',operationId:'o'});
 validateResult('quickLaunch.run',{existing:false,session:{id:'s',title:'Web dev server',provider:'custom',mode:'terminal',status:'running',createdAt:'t',updatedAt:'t',run:{commandId:'c',name:'Web dev server',kind:'service',shell:'cmd',url:'http://localhost:5174/',urlSource:'output'}}});
 // Readiness: a watched run, a run ready on its own port, one whose watcher gave up, and an older run without it.
 const ready={existing:false,session:{id:'s',title:'Web dev server',provider:'custom',mode:'terminal',status:'running',createdAt:'t',updatedAt:'t',run:{commandId:'c',name:'Web dev server',kind:'service',shell:'cmd',readiness:'waiting'}}};
 validateResult('quickLaunch.run',ready);
 validateResult('quickLaunch.run',{...ready,session:{...ready.session,run:{...ready.session.run,readiness:'ready',url:'http://localhost:8080/',urlSource:'port',port:8080}}});
 validateResult('quickLaunch.run',{...ready,session:{...ready.session,run:{...ready.session.run,readiness:'none'}}});
 validateResult('quickLaunch.run',{...ready,session:{...ready.session,run:{commandId:'c',name:'Build',kind:'task',shell:'cmd'}}});
 for(const patch of [{readiness:'starting'},{urlSource:'guess'},{port:'8080'},{port:null},{readiness:null}]) assert.throws(()=>validateResult('quickLaunch.run',{...ready,session:{...ready.session,run:{...ready.session.run,...patch}}}),/Invalid runtime result|protocol schema/,JSON.stringify(patch));
});

test('detected entries are read-only suggestions with a stable key and exactly one run target',()=>{
 const scope={projectId:'p',cwd:'C:\\repo'};
 validateRequest('quickLaunch.detect',scope);
 for(const patch of [{projectId:undefined},{projectId:''},{cwd:undefined},{cwd:''},{operationId:'unexpected'}]) assert.throws(()=>validateRequest('quickLaunch.detect',{...scope,...patch}));
 const entry={key:'node:apps/web/package.json:dev',source:{kind:'node',file:'apps/web/package.json',label:'package.json'},name:'dev',command:'npm run dev',shell:'cmd',cwd:'apps/web',kind:'service',group:'@acme/web'};
 validateResult('quickLaunch.detect',{entries:[entry],truncated:false});
 validateResult('quickLaunch.detect',{entries:[],truncated:false});
 validateResult('quickLaunch.detect',{entries:[{...entry,key:'procfile:Procfile:web',missingTool:'make',source:{kind:'procfile',file:'Procfile',label:'Procfile'},command:'make web',kind:'task'}],truncated:true});
 // The JVM and Python detectors add three source kinds; `suggested` marks an entry inferred from source code.
 for(const [kind,file,label,command] of [['maven','pom.xml','pom.xml','mvn test'],['gradle','build.gradle','build.gradle','gradle test'],['python','pyproject.toml','pyproject.toml','uv run python -m pytest']]) {
  validateResult('quickLaunch.detect',{entries:[{...entry,key:`${kind}:${file}:test`,source:{kind,file,label},command}],truncated:false});
  validateResult('quickLaunch.detect',{entries:[{...entry,key:`${kind}:${file}:suggested`,source:{kind,file,label},command,suggested:true}],truncated:false});
 }
 for(const patch of [{source:{kind:'daemon',file:'pom.xml',label:'pom.xml'}},{missingTool:3},{group:3},{kind:'daemon'},{suggested:'yes'},{suggested:null}]) assert.throws(()=>validateResult('quickLaunch.detect',{entries:[{...entry,...patch}],truncated:false}));
 // Nothing detected can be launched with client-supplied command text: only a key is accepted, and it needs a project.
 validateRequest('quickLaunch.run',{commandId:'c',cwd:'C:\\repo',operationId:'o'});
 validateRequest('quickLaunch.run',{detectedKey:entry.key,projectId:'p',cwd:'C:\\repo',operationId:'o'});
 for(const patch of [
  {commandId:undefined,operationId:'o'},
  {commandId:'c',detectedKey:entry.key,projectId:'p'},
  {commandId:undefined,detectedKey:''},
  {commandId:undefined,detectedKey:'x'.repeat(513)},
  {commandId:undefined,projectId:undefined},
  {commandId:undefined,projectId:''},
  {commandId:undefined,command:'npm run injected'},
 ]) assert.throws(()=>validateRequest('quickLaunch.run',{cwd:'C:\\repo',operationId:'o',...patch}));
 validateResult('quickLaunch.run',{existing:true,session:{id:'t1',title:'dev',provider:'custom',mode:'terminal',status:'running',createdAt:'t',updatedAt:'t',run:{commandId:'detected:node:apps/web/package.json:dev',name:'dev',kind:'service',shell:'cmd'}}});
 assert.ok(METHODS.includes('quickLaunch.detect'));
});

test('restart names one run session and replays its receipt',()=>{
 validateRequest('quickLaunch.restart',{sessionId:'s',operationId:'o'});
 for(const patch of [{sessionId:undefined},{sessionId:''},{operationId:undefined},{operationId:''},{cwd:'C:\\repo'},{command:'npm run dev'}]) assert.throws(()=>validateRequest('quickLaunch.restart',{sessionId:'s',operationId:'o',...patch}));
 validateResult('quickLaunch.restart',{existing:false,session:{id:'t2',title:'dev',provider:'custom',mode:'terminal',status:'starting',createdAt:'t',updatedAt:'t',run:{commandId:'detected:node:apps/web/package.json:dev',name:'dev',kind:'service',shell:'cmd'}}});
 assert.ok(METHODS.includes('quickLaunch.restart'));
});

test('provider refresh is additive and carries the claimed generation',()=>{
 validateRequest('provider.refresh',{});
 validateResult('provider.refresh',{refreshId:1});
 validateResult('provider.refresh',{refreshId:0});
 assert.throws(()=>validateResult('provider.refresh',{}));
 assert.throws(()=>validateResult('provider.refresh',{refreshId:'1'}));
 assert.throws(()=>validateRequest('provider.refresh',{callerToken:'secret'}));
});

test('group prerequisites preserve duplicate providers and explicit degradation',()=>{
 validateRequest('group.prerequisites',{});
 validateRequest('group.prerequisites',{cwd:'fixture-workspace',providers:['fixture','fixture']});
 for(const params of [{providers:['Bad']},{providers:'fixture'},{cwd:''},{extra:true}]) assert.throws(()=>validateRequest('group.prerequisites',params));
 const row={provider:'fixture',usable:false,reason:'not_installed',fix:{kind:'install',text:'Install Fixture CLI'},readOnly:'prompt',readOnlyNote:'Read-only by instruction'};
 validateResult('group.prerequisites',{providers:[row,row],git:{found:false},folder:{repository:false,reason:'no_git'}});
 assert.throws(()=>validateResult('group.prerequisites',{providers:[{...row,readOnly:'assumed'}],git:{found:true}}));
});

test('git fingerprints snapshots and discard require exact nullable maps',()=>{
 const paths=['tracked.txt','deleted.txt','untracked.txt'];
 validateRequest('git.fingerprints',{projectId:'p',paths});
 validateResult('git.fingerprints',{fingerprints:{'tracked.txt':'a'.repeat(64),'deleted.txt':null,'untracked.txt':'b'.repeat(64)},indexFingerprints:{'tracked.txt':'c'.repeat(64),'deleted.txt':'d'.repeat(64),'untracked.txt':null}});
 const discard={projectId:'p',paths,expectedFingerprints:{'tracked.txt':'a'.repeat(64),'deleted.txt':null,'untracked.txt':'b'.repeat(64)},expectedIndexFingerprints:{'tracked.txt':'c'.repeat(64),'deleted.txt':'d'.repeat(64),'untracked.txt':null},operationId:'discard-1'};
 validateRequest('git.discard',discard);
 assert.ok(METHODS.includes('git.fingerprints'));
 for(const patch of [
  {paths:[]},{expectedFingerprints:undefined},{expectedIndexFingerprints:undefined},
  {expectedFingerprints:{'tracked.txt':'a'.repeat(64),'deleted.txt':null}},{expectedIndexFingerprints:{'tracked.txt':'c'.repeat(64),'deleted.txt':'d'.repeat(64),'untracked.txt':null,extra:null}},
  {expectedFingerprints:{...discard.expectedFingerprints,'untracked.txt':undefined}},{expectedIndexFingerprints:{...discard.expectedIndexFingerprints,'untracked.txt':0}},
 ]) assert.throws(()=>validateRequest('git.discard',{...discard,...patch}));
 for(const path of ['toString','constructor','__proto__']) assert.throws(()=>validateRequest('git.discard',{projectId:'p',paths:[path],expectedFingerprints:{},expectedIndexFingerprints:{},operationId:'discard-inherited'}));
 const ownProto=JSON.parse('{\"__proto__\":null}');
 validateRequest('git.discard',{projectId:'p',paths:['__proto__'],expectedFingerprints:ownProto,expectedIndexFingerprints:ownProto,operationId:'discard-own-proto'});
 for(const params of [{projectId:'p',paths:[]},{projectId:'p',paths:Array.from({length:501},(_,i)=>'f'+i)}]) assert.throws(()=>validateRequest('git.fingerprints',params));
});

test('git branches add the optional checked-out worktree path',()=>{
 const branch={name:'feature/elsewhere',remote:false,current:false,lastCommit:{hash:'a'.repeat(40),subject:'Elsewhere',committedAt:'2026-10-28T00:00:00Z'},worktreePath:'C:/repo/elsewhere'};
 validateResult('git.branches',{current:'main',detached:false,branches:[branch]});
 validateResult('git.branches',{current:'main',detached:false,branches:[{...branch,worktreeMissing:true}]});
 validateResult('git.branches',{current:null,detached:true,branches:[{...branch,worktreePath:undefined}]});
 assert.throws(()=>validateResult('git.branches',{current:'main',detached:false,branches:[{...branch,worktreePath:7}]}));
 assert.throws(()=>validateResult('git.branches',{current:'main',detached:false,branches:[{...branch,worktreeMissing:'yes'}]}));
});

test('git stashes use stable OIDs, distinguish untracked files, and keep failed applications',()=>{
 const oid='a'.repeat(40), scope={projectId:'p'};
 const entry={oid,index:0,message:'ThreadTerm: switch to feature',branch:'main',createdAt:1_793_000_000,untracked:true};
 validateRequest('git.stash.list',scope);
 validateResult('git.stash.list',{entries:[entry]});
 validateRequest('git.stash.show',{...scope,oid});
 validateResult('git.stash.show',{files:[{path:'src/renamed.ts',originalPath:'src/changed.ts',status:'R'},{path:'scratch.txt',status:'?',untracked:true}]});
 validateRequest('git.stash.push',{...scope,message:'save point',includeUntracked:true,operationId:'stash-push'});
 validateResult('git.stash.push',{oid});
 validateRequest('git.stash.apply',{...scope,oid,pop:true,operationId:'stash-pop'});
 validateResult('git.stash.apply',{oid,applied:true,dropped:true});
 validateResult('git.stash.apply',{oid,applied:true,conflicted:true,dropped:false});
 validateResult('git.stash.apply',{oid,applied:false,dropped:false,warning:'untracked restore refused'});
 const interference={oid,ourEntryDropped:false,restored:[{oid:'b'.repeat(40),message:'foreign save'}],restoreFailed:[{oid:'c'.repeat(40),message:'other save',error:'store failed'}],orderChanged:true,unknownEntryLost:true};
 validateResult('git.stash.apply',{oid,applied:true,dropped:false,interference});
 validateRequest('git.stash.drop',{...scope,oid,operationId:'stash-drop'});
 validateResult('git.stash.drop',{oid,dropped:true});
 validateRequest('git.checkout',{...scope,branch:'feature',stash:true,operationId:'stash-switch'});
 validateResult('git.checkout',{branch:'feature',stash:{oid,applied:true,dropped:true}});
 validateResult('git.checkout',{branch:'feature',stash:{oid,message:'ThreadTerm: switch to feature',applied:true,conflicted:true,dropped:false},warning:'post-checkout hook failed'});
 validateResult('git.checkout',{branch:'feature',stash:{oid,applied:true,dropped:false,interference}});
 for(const params of [{...scope,oid,pop:true},{...scope,oid,pop:'yes',operationId:'o'},{...scope,oid,operationId:'o',extra:true}]) assert.throws(()=>validateRequest('git.stash.apply',params));
 assert.throws(()=>validateResult('git.stash.list',{entries:[{...entry,createdAt:'now'}]}));
 assert.throws(()=>validateResult('git.stash.apply',{oid,applied:false,dropped:false,warning:1}));
 assert.throws(()=>validateResult('git.stash.apply',{oid,applied:true,dropped:false,interference:{...interference,restoreFailed:[{oid:'c'.repeat(40),message:'other',error:1}]}}));
 assert.ok(METHODS.includes('git.stash.list'));
});


test('worktree creation accepts a bounded base only for new branches',()=>{
 const request={projectId:'p',path:'C:/worktree',branch:'feature/base',createBranch:true,operationId:'worktree-base'};
 validateRequest('worktree.create',request);
 for(const startPoint of ['main','origin/main','a'.repeat(40),'x'.repeat(255)]) validateRequest('worktree.create',{...request,startPoint});
 validateRequest('worktree.create',{...request,createBranch:false});
 for(const startPoint of ['', '-main', 'x'.repeat(256), 1, null]) assert.throws(()=>validateRequest('worktree.create',{...request,startPoint}));
 assert.throws(()=>validateRequest('worktree.create',{...request,createBranch:false,startPoint:'main'}));
});


test('worktree bases accept multibyte refs within the character limit',()=>{
 const request={projectId:'p',path:'C:/worktree',branch:'feature/base',createBranch:true,operationId:'worktree-multibyte-base'};
 for(const startPoint of ['基'.repeat(43)+'/'+'准'.repeat(42),'基'.repeat(255)]) validateRequest('worktree.create',{...request,startPoint});
 assert.throws(()=>validateRequest('worktree.create',{...request,startPoint:'基'.repeat(256)}));
});

test('history actions validate commit hashes, reset fences and operation kinds',()=>{
 const scope={projectId:'p'},hash='a'.repeat(40),head='b'.repeat(40),operationId='history-action';
 for(const method of ['git.history.plan','git.cherryPick','git.revert']) {
  const params={...scope,hash,...(method==='git.history.plan'?{}:{operationId})};
  validateRequest(method,params);
  validateRequest(method,{...params,hash:'abcdef0'});
  validateRequest(method,{...params,hash:'c'.repeat(64),worktreePath:'worktree'});
  for(const bad of ['HEAD','--abort','abc123','g'.repeat(40),'a'.repeat(65),'abc1234\n']) assert.throws(()=>validateRequest(method,{...params,hash:bad}));
  assert.ok(METHODS.includes(method));
 }
 validateRequest('git.revert',{...scope,hash,operationId,mainline:1});
 for(const mainline of [0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateRequest('git.revert',{...scope,hash,operationId,mainline}));
 const reset={...scope,hash,operationId,expectedHead:head,mode:'mixed'};
 validateRequest('git.reset',reset);
 validateRequest('git.reset',{...reset,mode:'soft',undoOf:'completed-reset'});
 for(const patch of [{mode:'hard'},{expectedHead:'HEAD'},{expectedHead:'abcdef0'},{expectedHead:undefined},{undoOf:'receipt'},{mode:'soft',undoOf:''},{mode:'soft',undoOf:' '},{mode:'soft',undoOf:3}]) assert.throws(()=>validateRequest('git.reset',{...reset,...patch}));
 for(const method of ['git.operation.abort','git.operation.continue']) {
  for(const kind of ['cherry-pick','revert']) validateRequest(method,{...scope,kind,operationId});
  for(const kind of ['merge','rebase','--abort','']) assert.throws(()=>validateRequest(method,{...scope,kind,operationId}));
  assert.throws(()=>validateRequest(method,{...scope,kind:'revert'}));
  assert.ok(METHODS.includes(method));
 }
 assert.ok(METHODS.includes('git.reset'));
});

test('history plans and action results preserve full OIDs and bounded reset previews',()=>{
 const hash='a'.repeat(40),head='b'.repeat(40),commit={hash,subject:'Reviewed commit'};
 const plan={hash,head,branch:'main',detached:false,isAncestor:true,parents:[commit],reset:{count:21,commits:Array(20).fill(commit),pushed:true}};
 validateResult('git.history.plan',plan);
 validateResult('git.history.plan',{...plan,branch:'',detached:true,isAncestor:false,parents:[],reset:{count:0,commits:[],pushed:false}});
 for(const patch of [{head:'abcdef0'},{hash:'HEAD'},{detached:'false'},{parents:[{hash:'abc1234',subject:'parent'}]},{reset:{count:1,commits:[commit,commit],pushed:false}},{reset:{count:21,commits:Array(21).fill(commit),pushed:false}},{reset:{count:-1,commits:[],pushed:false}},{reset:{count:0.5,commits:[],pushed:false}},{reset:{count:0,commits:[],pushed:'yes'}}]) assert.throws(()=>validateResult('git.history.plan',{...plan,...patch}));
 for(const method of ['git.cherryPick','git.revert','git.operation.continue']) {
  validateResult(method,{output:'done',conflicted:false,head});
  validateResult(method,{output:'CONFLICT',conflicted:true});
  assert.throws(()=>validateResult(method,{output:'done'}));
  assert.throws(()=>validateResult(method,{output:'done',conflicted:false,head:'HEAD'}));
 }
 validateResult('git.operation.abort',{output:'',head});
 validateResult('git.reset',{output:'',previousHead:head,head:hash,symbolicHead:'refs/heads/main'});
 validateResult('git.reset',{output:'',previousHead:head,head:hash,symbolicHead:'detached'});
 for(const symbolicHead of [undefined,'main','refs/heads/','refs/heads/main\n'])assert.throws(()=>validateResult('git.reset',{output:'',previousHead:head,head:hash,symbolicHead}));
 assert.throws(()=>validateResult('git.reset',{output:'',previousHead:'HEAD',head:hash,symbolicHead:'refs/heads/main'}));
 assert.throws(()=>validateResult('git.reset',{output:'',previousHead:head,symbolicHead:'refs/heads/main'}));
});

test('git undo exposes a bounded identifier-only journal and fences undo requests',()=>{
 const scope={projectId:'project',worktreePath:'worktree'},id='undo-operation',operationId='undo-request';
 validateRequest('git.undo.list',scope);
 validateRequest('git.undo',{...scope,id,operationId});
 for(const params of [{projectId:''},{...scope,id:''},{...scope,id,operationId:''},{...scope,id,operationId,paths:['leak']}]) assert.throws(()=>validateRequest(params.id===undefined?'git.undo.list':'git.undo',params));
 const entry={id,kind:'discard',label:'Discard 2 files',createdAt:'2026-10-29T00:00:00Z',available:true,paths:['src/a.ts','src/b.ts'],pathCount:2,undoneAt:null};
 validateResult('git.undo.list',{entries:[entry]});
 validateResult('git.undo',{id,undoneAt:'2026-10-29T00:01:00Z'});
 for(const patch of [{kind:'other'},{paths:['/absolute.ts']},{pathCount:-1},{pathCount:1.5},{undoneAt:undefined},{available:'yes'},{partial:'yes'},{applied:['/absolute.ts']},{remaining:['../escape.ts']}]) assert.throws(()=>validateResult('git.undo.list',{entries:[{...entry,...patch}]}));
 const partial={...entry,undoneAt:'2026-10-29T00:01:00Z',available:false,partial:true,applied:['src/a.ts'],remaining:['src/b.ts']};
 validateResult('git.undo.list',{entries:[partial]});
 const recycled={...entry,paths:['src/a.ts'],pathCount:1,recycledCount:1,label:'Discarded changes in 1 file (1 more moved to the Recycle Bin)'};
 validateResult('git.undo.list',{entries:[recycled]});
 for(const patch of [{recycledCount:-1},{recycledCount:1.5},{recycledCount:'1'}]) assert.throws(()=>validateResult('git.undo.list',{entries:[{...recycled,...patch}]}));
 assert.throws(()=>validateResult('git.undo.list',{entries:[{...partial,applied:Array(21).fill('src/a.ts')}]}));
 assert.throws(()=>validateResult('git.undo',{id,undoneAt:null}));
 assert.ok(METHODS.includes('git.undo')&&METHODS.includes('git.undo.list'));
});

test('branch comparison requests bound the base, the merge base and the scope',()=>{
 const scope={projectId:'p'};
 validateRequest('git.compare.files',scope);
 validateRequest('git.compare.files',{...scope,worktreePath:'worktree'});
 validateRequest('git.compare.files',{...scope,base:'origin/main'});
 validateRequest('git.compare.files',{...scope,base:'a'.repeat(40),committedOnly:true});
 for(const patch of [{projectId:''},{base:''},{base:'-upload-pack'},{base:'refs/heads/'+'x'.repeat(250)},{base:'main\ninjected'},{committedOnly:'yes'},{committedOnly:null},{operationId:'unexpected'}])
  assert.throws(()=>validateRequest('git.compare.files',{...scope,...patch}),undefined,JSON.stringify(patch).slice(0,80));
 const oid='a'.repeat(40);
 validateRequest('git.compare.diff',{...scope,base:{ref:'origin/main',oid},mergeBase:oid,path:'src/a.ts'});
 validateRequest('git.compare.diff',{...scope,base:{oid},mergeBase:oid,path:'src/a.ts',originalPath:'src/b.ts',committedOnly:true});
 for(const patch of [{base:{}},{base:{oid:'HEAD'}},{base:{oid:'abc'}},{base:{ref:'',oid}},{base:{ref:'-x',oid}},{mergeBase:'abc'},{path:''},{committedOnly:1}])
  assert.throws(()=>validateRequest('git.compare.diff',{...scope,base:{ref:'origin/main',oid},mergeBase:oid,path:'src/a.ts',...patch}),undefined,JSON.stringify(patch).slice(0,80));
});

test('branch comparison results cap files and keep statuses and counts exact',()=>{
 const oid='a'.repeat(40),base={ref:'origin/main',oid};
 const file={path:'src/a.ts',status:'modified',additions:4,deletions:2,binary:false};
 const result={base,mergeBase:oid,head:'b'.repeat(40),files:[file,{path:'src/b.ts',originalPath:'src/old.ts',status:'renamed',additions:0,deletions:0,binary:false},{path:'img.png',status:'added',additions:0,deletions:0,binary:true},{path:'big.log',status:'added',additions:0,deletions:0,binary:false,countsUnknown:true}],truncated:false};
 validateResult('git.compare.files',result);
 validateResult('git.compare.files',{...result,files:[]});
 validateResult('git.compare.files',{...result,files:Array.from({length:1000},(_,index)=>({...file,path:`src/${index}.ts`})),truncated:true});
 for(const patch of [{base:{ref:'',oid}},{base:{ref:'origin/main',oid:'HEAD'}},{mergeBase:'abc'},{head:'HEAD'},{files:[{...file,status:'copied'}]},{files:[{...file,additions:-1}]},{files:[{...file,deletions:0.5}]},{files:[{...file,binary:'no'}]},{files:[{...file,originalPath:''}]},{files:[{...file,countsUnknown:'yes'}]},{files:Array.from({length:1001},(_,index)=>({...file,path:`src/${index}.ts`}))},{truncated:'yes'}])
  assert.throws(()=>validateResult('git.compare.files',{...result,...patch}),undefined,JSON.stringify(patch).slice(0,80));
 validateResult('git.compare.diff',{path:'src/a.ts',oldText:'old\n',newText:'new\n',binary:false,deleted:false});
 validateResult('git.compare.diff',{path:'src/a.ts',oldText:'',newText:'',binary:true});
 for(const patch of [{path:''},{oldText:1},{newText:null},{binary:'no'},{deleted:'no'}]) assert.throws(()=>validateResult('git.compare.diff',{path:'src/a.ts',oldText:'',newText:'',binary:false,...patch}));
 assert.ok(METHODS.includes('git.compare.files')&&METHODS.includes('git.compare.diff'));
});

test('compare diff tabs require a full commit pair and no staged mode',()=>{
 const oid='a'.repeat(40),tab={id:'compare',kind:'diff',projectId:'p',path:'src/a.ts',compare:{base:'origin/main',oid,mergeBase:oid}};
 const layout=value=>({kind:'pane',id:'pane',tabs:[value],activeTabId:'compare'});
 validateLayout(layout(tab));
 validateLayout(layout({...tab,compare:{...tab.compare,committedOnly:true}}));
 validateRequest('workspace.save',{name:'Compare',layout:layout(tab),expectedRevision:0,operationId:'compare-layout'});
 for(const patch of [{staged:true},{kind:'file'},{kind:'preview'},{compare:{base:'-x',oid,mergeBase:oid}},{compare:{base:'origin/main',oid:'HEAD',mergeBase:oid}},{compare:{base:'origin/main',oid,mergeBase:'HEAD'}},{compare:{base:'origin/main',oid,mergeBase:oid,committedOnly:'yes'}},{compare:{base:'x'.repeat(256),oid,mergeBase:oid}}])
  assert.throws(()=>validateLayout(layout({...tab,...patch})),undefined,JSON.stringify(patch).slice(0,80));
});

test('agent run tools are caller-scoped, bounded and never carry caller identity',()=>{
 validateRequest('chat.tool.run.list',{});
 validateRequest('chat.tool.run.start',{id:'detected:node:package.json:dev',requestId:'run-1'});
 validateRequest('chat.tool.run.start',{id:'saved-command',requestId:'run-2'});
 validateRequest('chat.tool.run.status',{runId:'t1'});
 validateRequest('chat.tool.run.logs',{runId:'t1'});
 validateRequest('chat.tool.run.logs',{runId:'t1',lines:2000});
 validateRequest('chat.tool.run.stop',{runId:'t1'});
 validateRequest('chat.tool.run.restart',{runId:'t1',requestId:'restart-1'});
 for(const method of ['chat.tool.run.start','chat.tool.run.restart'])assert.throws(()=>validateRequest(method,{runId:'t1',id:'saved',requestId:'r',callerSessionId:'spoofed',callerToken:'spoofed'}));
 const entry={id:'saved',name:'Dev',command:'npm run dev',cwd:'',kind:'service',source:'saved',approved:true,activeRunId:'t1'};
 const detected={id:'detected:node:package.json:dev',name:'dev',command:'npm run dev',cwd:'',kind:'service',source:'detected',approved:false,missingTool:'npm'};
 const run={runId:'t1',entryId:'saved',name:'Dev',state:'running',readiness:'waiting',url:'http://localhost:5173/',port:5173,startedAt:'2026-10-30T00:00:00Z',startedBy:'agent',startedBySelf:true};
 validateResult('chat.tool.run.list',{worktree:'C:\\repo-wt',entries:[entry,detected],runs:[run],truncated:false});
 validateResult('chat.tool.run.list',{worktree:'C:\\repo-wt',entries:[],runs:[{...run,exitCode:0,state:'exited',readiness:undefined,url:undefined,port:undefined}].map(({readiness,url,port,...rest})=>rest),truncated:true});
 assert.throws(()=>validateResult('chat.tool.run.list',{worktree:'C:\\repo-wt',entries:[{...entry,source:'proposal'}],runs:[],truncated:false}));
 assert.throws(()=>validateResult('chat.tool.run.list',{worktree:'C:\\repo-wt',entries:[{...entry,approved:'yes'}],runs:[],truncated:false}));
 validateResult('chat.tool.run.start',{runId:'t1',existing:false,state:'starting',entryId:'saved',name:'Dev'});
 validateResult('chat.tool.run.start',{runId:'t1',existing:true,state:'running',entryId:null,name:null});
 validateResult('chat.tool.run.status',{...run,uptimeSeconds:12});
 validateResult('chat.tool.run.logs',{text:'ready\n30%\ntail',truncated:false,totalBytes:42});
 validateResult('chat.tool.run.stop',{runId:'t1',state:'running',stopRequested:true});
 validateResult('chat.tool.run.restart',{runId:'t2',existing:false,state:'starting',entryId:'detected:node:package.json:dev',name:'dev'});
});

test('repo run configs keep file concurrency, local secrets and exact trust in the protocol',()=>{
 const scope={projectId:'p',cwd:'C:\\repo-wt'},fingerprint='a'.repeat(64),fileFingerprint='b'.repeat(64);
 validateRequest('quickLaunch.run',{...scope,repoId:'api',operationId:'run-repo'});
 for(const target of [{},{commandId:'saved',repoId:'api'},{detectedKey:'node:package.json:dev',repoId:'api'},{repoId:'Bad ID'},{repoId:'api',projectId:undefined}])assert.throws(()=>validateRequest('quickLaunch.run',{...scope,operationId:'run-repo',...target}));
 validateRequest('quickLaunch.repo.list',scope);
 const input={name:'API',command:'npm run dev',shell:'cmd',cwd:'apps/api',kind:'service',env:[{name:'LOG_LEVEL',value:'debug'},{name:'API_TOKEN',value:'local-only',secret:true}],previewUrl:'http://localhost:3000/'};
 validateRequest('quickLaunch.repo.save',{...scope,entry:input,operationId:'save-repo'});
 validateRequest('quickLaunch.repo.save',{...scope,entry:{...input,id:'api'},expectedFingerprint:fileFingerprint,operationId:'save-repo'});
 for(const entry of [{...input,id:'Bad ID'},{...input,env:[{name:'API_TOKEN',value:'x',secret:null}]},{...input,command:''},{...input,command:'echo one\necho two'}])assert.throws(()=>validateRequest('quickLaunch.repo.save',{...scope,entry,operationId:'save-repo'}));
 assert.throws(()=>validateRequest('quickLaunch.repo.save',{...scope,entry:input,operationId:'x'.repeat(513)}));
 validateRequest('quickLaunch.repo.delete',{...scope,id:'api',expectedFingerprint:fileFingerprint,operationId:'delete-repo'});
 validateRequest('quickLaunch.repo.trust',{...scope,id:'api',fingerprint,operationId:'trust-repo'});
 assert.throws(()=>validateRequest('quickLaunch.repo.trust',{...scope,id:'api',fingerprint:'stale',operationId:'trust-repo'}));
 const accepted={command:input.command,shell:'cmd',cwd:input.cwd,kind:'service',env:[{name:'LOG_LEVEL',value:'debug'},{name:'API_TOKEN',secret:true}],previewUrl:input.previewUrl};
 const entry={id:'api',...input,env:[{name:'LOG_LEVEL',value:'debug'},{name:'API_TOKEN',secret:true,hasValue:false}],fingerprint,trusted:false,changed:true,missingSecrets:['API_TOKEN'],accepted};
 validateResult('quickLaunch.repo.list',{exists:true,fileFingerprint,entries:[entry]});
 validateResult('quickLaunch.repo.list',{exists:true,fileFingerprint,entries:[],error:'repo_config_invalid: invalid JSON'});
 validateResult('quickLaunch.repo.list',{exists:false,entries:[]});
 validateResult('quickLaunch.repo.save',entry);
 validateResult('quickLaunch.repo.trust',{...entry,trusted:true,changed:false});
 validateResult('quickLaunch.repo.delete',null);
 const agentEntry={id:'repo:api',name:'API',command:input.command,cwd:input.cwd,kind:'service',source:'repo',approved:false};
 validateResult('chat.tool.run.list',{worktree:'C:\\repo-wt',entries:[agentEntry],runs:[],truncated:false});
 assert.ok(['quickLaunch.repo.list','quickLaunch.repo.save','quickLaunch.repo.delete','quickLaunch.repo.trust'].every(method=>METHODS.includes(method)));
});

test('run secret contracts preserve overrides without returning plaintext and fence server-side moves',()=>{
 const fingerprint='a'.repeat(64),scope={projectId:'p',cwd:'C:/worktree'};
 const fields={name:'API',command:'node server.mjs',shell:'cmd',cwd:'',kind:'service',env:[{name:'TOKEN',secret:true}]};
 validateRequest('quickLaunch.repo.save',{...scope,entry:fields,localSource:{id:'local',revision:1},operationId:'move-repo'});
 validateRequest('quickLaunch.save',{projectId:'p',...fields,repoSource:{id:'api',fingerprint,cwd:scope.cwd},operationId:'move-local'});
 for(const source of [{id:'api',fingerprint:'bad',cwd:scope.cwd},{id:'api',fingerprint,cwd:''}])assert.throws(()=>validateRequest('quickLaunch.save',{projectId:'p',...fields,repoSource:source,operationId:'bad-source'}));
 assert.throws(()=>validateRequest('quickLaunch.repo.save',{...scope,entry:fields,localSource:{id:'local',revision:0},operationId:'bad-source'}));
 assert.throws(()=>validateRequest('quickLaunch.repo.save',{...scope,entry:{...fields,env:[{name:'PUBLIC'}]},operationId:'missing-value'}));
 const repo={id:'api',...fields,env:[{name:'TOKEN',secret:true,hasValue:true}],fingerprint,trusted:true,changed:false,missingSecrets:[]};
 const local={id:'local',projectId:'p',revision:1,...fields,env:repo.env,createdAt:'now',updatedAt:'now'};
 validateResult('quickLaunch.repo.save',repo);validateResult('quickLaunch.repo.trust',repo);validateResult('quickLaunch.save',local);validateResult('quickLaunch.list',[local]);
 for(const env of [[{name:'TOKEN',secret:true,value:'must-not-return',hasValue:true}],[{name:'TOKEN',secret:true}]]) {
  assert.throws(()=>validateResult('quickLaunch.repo.save',{...repo,env}));
  assert.throws(()=>validateResult('quickLaunch.save',{...local,env}));
 }
});
