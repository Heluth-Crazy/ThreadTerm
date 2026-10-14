import test from 'node:test';
import assert from 'node:assert/strict';
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

test('context read preserves timestamp and all counters, with an empty-session null result',()=>{
 validateRequest('chat.context.read',{sessionId:'s'});
 const usage={usedTokens:60000,windowTokens:200000,percent:30,inputTokens:30000,outputTokens:4700,cacheReadTokens:60000,cacheWriteTokens:1000,totalTokens:95700,updatedAt:'2026-10-13T10:00:00Z'};
 validateResult('chat.context.read',usage);
 validateResult('chat.context.read',null);
 assert.throws(()=>validateResult('chat.context.read',{...usage,updatedAt:1}));
 assert.throws(()=>validateResult('chat.context.read',{...usage,contextSequence:2}));
 assert.equal(isRuntimeEvent({v:1,event:'chat.context',epoch:'e',seq:1,data:{sessionId:'s',usage}}),true);
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
 validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],selectedCommit:{head,indexFingerprint:fingerprint,supported:false,unsupportedReason:'Git cannot guard symbolic HEAD',gitVersion:'test'}});
 assert.throws(()=>validateResult('git.status',{branch:'main',upstream:null,ahead:0,behind:0,changes:[],selectedCommit:{head,indexFingerprint:fingerprint,supported:'yes'}}));
});

test('the additive plan part type requires a valid plan payload',()=>{
 const part={type:'plan',toolId:'plan:turn-1',data:{entries:[{content:'Write the tests',status:'in_progress',priority:'high'},{content:'Ship it',status:'pending'}],explanation:'Two-step plan'}};
 const item={id:'plan-item',role:'assistant',createdAt:'2026-01-01T00:00:00Z',turnId:'turn-1',parts:[part]};
 validateResult('chat.read',[item]);
 validateResult('chat.snapshot',{items:[item],revision:1,repair:{offered:false,reason:'history_unavailable',degraded:false}});
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
 const snapshot={items:[item],revision:1,repair:{offered:true,mode:'rebuild',degraded:false,reason:'history_metadata_missing'}};
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
 validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:true,mode:'rebuild',degraded:true,ingressFailed:true}});
 assert.throws(()=>validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:true,mode:'rebuild',degraded:true,ingressFailed:'true'}}));
 validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:false,reason:'history_unavailable',degraded:false}});
 assert.throws(()=>validateResult('chat.snapshot',{items:[],revision:10,repair:{offered:false,reason:'reader_start_required',degraded:false}}));
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

test('web preview tabs show only http(s) pages and belong to no session',()=>{
 const web={id:'web',kind:'web',url:'http://localhost:5173/'};
 const layout={kind:'pane',id:'pane',tabs:[web],activeTabId:'web'};
 const params={name:'Web',layout,expectedRevision:0,operationId:'web'};
 validateRequest('workspace.save',params);
 validateRequest('preset.save',{name:'Web',sessions:[],layout,commands:[],expectedRevision:0,operationId:'web-preset'});
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
 for(const patch of [{sessionId:''},{path:''},{path:'a\0b'},{path:'x'.repeat(16385)},{line:0},{column:1000001},{line:1.5},{projectId:'injected-scope'}])assert.throws(()=>validateRequest('filesystem.resolve',{sessionId:'s',path:'a.ts',...patch}));
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

test('handshake rejects old and mismatched Chat approval contracts without implying a runtime kill',()=>{
 assert.equal(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:PROTOCOL_CONTRACT}),undefined);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION}),/older and was left running/);
 assert.match(protocolIncompatibleReason({kind:'auth',clientId:'c',protocol:PROTOCOL_VERSION,nonce:'n',hmac:'00'},'runtime'),/Running jobs were not stopped/);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:1}),new RegExp('contract '+PROTOCOL_CONTRACT));
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:12}),/contract 13/);
 assert.match(protocolIncompatibleReason({kind:'challenge',nonce:'n',protocol:PROTOCOL_VERSION,contract:12}),/left running/);
 assert.match(protocolIncompatibleReason({kind:'auth',clientId:'c',protocol:PROTOCOL_VERSION,nonce:'n',hmac:'00',contract:12},'runtime'),/contract 13/);
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
  error:{code:'native_resume_failed',message:'resume failed',retryable:true,category:'provider'},
  optionsLoadState:'error',optionsError:{code:'chat_not_open',message:'not open'}
 });
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
 assert.equal(PROTOCOL_CONTRACT,13);
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
});

test('provider refresh is additive and carries the claimed generation',()=>{
 validateRequest('provider.refresh',{});
 validateResult('provider.refresh',{refreshId:1});
 validateResult('provider.refresh',{refreshId:0});
 assert.throws(()=>validateResult('provider.refresh',{}));
 assert.throws(()=>validateResult('provider.refresh',{refreshId:'1'}));
 assert.throws(()=>validateRequest('provider.refresh',{callerToken:'secret'}));
});

