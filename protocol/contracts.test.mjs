import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequest,validateResult,validateLayout,METHODS,isRuntimeEvent,PROTOCOL_CONTRACT,PROTOCOL_VERSION,protocolIncompatibleReason} from './index.ts';

test('chat allows image-only input while retaining empty-message and type guards',()=>{
 const base={sessionId:'s',text:'',operationId:'image-op',leaseEpoch:1};
 assert.throws(()=>validateRequest('chat.send',base),/Invalid text/);
 assert.throws(()=>validateRequest('chat.send',{...base,images:[]}),/Invalid text/);
 validateRequest('chat.send',{...base,images:['data:image/png;base64,aGVsbG8=']});
 validateRequest('chat.send',{...base,text:'describe',images:['data:image/png;base64,aGVsbG8=']});
 validateRequest('chat.send',{...base,text:'existing text-only call'});
 assert.throws(()=>validateRequest('chat.send',{...base,images:[2]}));
 assert.throws(()=>validateRequest('chat.send',{...base,text:2,images:['image']}));
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
