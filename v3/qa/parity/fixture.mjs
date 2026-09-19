// QA-only memory bridge. Never bundled into the app or written to a database.
export function installVisualFixture({ seed, theme }) {
  theme=new URLSearchParams(location.search).get('theme')??theme;
  const date = '2026-09-10T14:21:00.000Z';
  const sessionDate = time => { const value = new Date(); if(time.startsWith('昨天'))value.setDate(value.getDate()-1);const parts=time.match(/(\d{2}):(\d{2})/);value.setHours(Number(parts?.[1]??14),Number(parts?.[2]??21),0,0);return value.toISOString(); };
  localStorage.setItem('threadterm.v3.recent-session-ids',JSON.stringify(seed.store.recentSessionIds));
  const providers = ['codex','claude','kimi','gemini','opencode','shell','grok','custom'].map(id=>({id,name:id==='claude'?'Claude Code':id[0].toUpperCase()+id.slice(1),installed:true,terminal:true,chat:id!=='shell',history:id!=='shell',resume:id!=='shell',auth:'unknown'}));
  const projects=Object.entries(seed.projects).map(([id,p])=>({id,name:p.name,path:p.path,createdAt:date}));
  const trees=Object.values(seed.trees).map(t=>({id:t.id,projectId:t.project,path:t.path,branch:t.branch,head:'fixture',isMain:t.id.endsWith('-main'),locked:false,missing:!!t.missing}));
  const sessions=seed.sessions.map((s,i)=>({id:s.id,projectId:s.project,worktreePath:seed.trees[s.tree].path,title:s.name,provider:s.agent.toLowerCase().replace(' code',''),mode:'terminal',status:({needs:'waiting',running:'running',failed:'error',ended:'exited',stalled:'interrupted'})[s.state],createdAt:sessionDate(s.time),updatedAt:sessionDate(s.time),nativeId:s.agent==='Shell'?undefined:'fixture-'+s.id,followed:seed.store.followed.includes(s.id),bookmarked:seed.store.bookmarks.includes(s.id),sortOrder:i,organizationRevision:0}));
  const sessionRef=sessionId=>({id:`session-${sessionId}`,kind:'session',sessionId});
  const pane=(id,tabs)=>({kind:'pane',id,tabs,activeTabId:tabs[0]?.id??null});
  // Approved reference preset seeds for isolated visual QA only.
  const presets=[
    {id:'orbit',name:'结账问题排查',revision:1,sessions:[],commands:['pnpm test -- checkout','git diff -- src/checkout'],layout:pane('orbit-pane',[sessionRef('orbit-claude'),{id:'orbit-focus-trap',kind:'file',projectId:'orbit',worktreePath:seed.trees['orbit-checkout'].path,path:'src/checkout/FocusTrap.tsx'}])},
    {id:'orbit-parallel',name:'结账功能与支付热修并行复核',revision:1,sessions:[],commands:['pnpm test -- checkout','git diff -- src/checkout','pnpm test -- payment','git diff -- tests/payment.spec.ts'],layout:{kind:'split',id:'orbit-parallel-split',direction:'horizontal',ratio:.5,first:pane('orbit-checkout-pane',[sessionRef('orbit-claude'),{id:'orbit-checkout-file',kind:'file',projectId:'orbit',worktreePath:seed.trees['orbit-checkout'].path,path:'src/checkout/FocusTrap.tsx'}]),second:pane('orbit-hotfix-pane',[sessionRef('orbit-hotfix-shell'),{id:'orbit-hotfix-diff',kind:'diff',projectId:'orbit',worktreePath:seed.trees['orbit-hotfix'].path,path:'tests/payment.spec.ts'}])}},
    {id:'pulse',name:'发布前 API 检查',revision:1,sessions:[],commands:['pnpm test -- retry','git diff -- src/webhooks','pnpm lint'],layout:pane('pulse-pane',[sessionRef('pulse-codex')])},
    {id:'docs',name:'文档整理',revision:1,sessions:[],commands:[],layout:pane('docs-pane',[sessionRef('docs-gemini')])},
  ];
  const inbox=[['orbit-approval-focus','orbit-claude','approval','确认焦点修复范围'],['orbit-input-checkout','orbit-claude','waiting','需要补充验收范围'],['pulse-failed-retry','pulse-codex','failed','重试连接已中断'],['docs-review-navigation','docs-gemini','review','导航文档待复核'],['orbit-stalled-server','orbit-shell','stalled','开发服务器长时间无新输出']].map(([id,sessionId,kind,title])=>({id,sessionId,kind,title,createdAt:date,read:false}));
  const state={epoch:'visual-fixture',revision:1,projects,sessions,inbox,providers,settings:{revision:1,theme,language:'zh-CN',notifications:{native:true,attention:true,completed:true,sound:false},terminalCompatibility:{aiCompletionHints:true},customThemes:{'Ocean glass':{background:'#f7f8f8',surface:'#ffffff',text:'#282a30',muted:'#6b6f76',accent:'#5db9ff',border:'#eeeeee'}}},workspaces:[],presets};
  const listeners=new Set(),calls=[];
  const changed=()=>listeners.forEach(fn=>fn({v:1,event:'state.changed',epoch:state.epoch,seq:++state.revision,data:{kind:'settings'}}));
  const output=id=>seed.sessions.find(s=>s.id===id)?.output.join('\r\n')||'';
  const clone=value=>structuredClone(value);
  window.__parityFixture={calls};
  window.threadterm={platform:'win32',async request(method,params){
    calls.push({method,params});
    switch(method){
      case 'runtime.snapshot':return clone(state);
      case 'catalog.visibility.list':return [];
      case 'provider.list':return clone(providers);
      case 'project.catalog.list':return projects.map((p,i)=>({...p,revision:0,pinned:false,sortOrder:i,git:{available:true,branch:trees.find(t=>t.projectId===p.id&&t.isMain)?.branch}}));
      case 'worktree.list':return clone(trees.filter(t=>t.projectId===params.projectId));
      case 'worktree.branches':return trees.filter(t=>t.projectId===params.projectId).map(t=>({name:t.branch,current:t.isMain,lastCommit:{id:'fixture',subject:'Fixture commit',committedAt:date}}));
      case 'history.list':return {items:[]};
      case 'history.read':return [];
      case 'settings.update':Object.assign(state.settings,params.patch);state.settings.revision++;changed();return clone(state.settings);
      case 'data.status':return {root:'D:/demo/ThreadTerm',database:{path:'D:/demo/ThreadTerm/threadterm.sqlite3',sizeBytes:81920},counts:{projects:projects.length,sessions:sessions.length,workspaces:0,presets:presets.length,drafts:0,usageRecords:0}};
      case 'data.relocation.status':return {state:'idle'};
      case 'preset.list':return clone(presets);case 'draft.list':return [];
      case 'device.list':return (seed.store.featureStates.settings.mobile.devices??[]).map(device=>({id:device.id,name:device.name,permission:device.access==='full'?'fullcontrol':'readonly',createdAt:date,expiresAt:new Date(device.tokenExpiresAt??0).toISOString(),...(device.state==='revoked'?{revokedAt:date}:{})}));
      case 'filesystem.list':{const paths=seed.projects[params.projectId].files;const base=params.path?params.path.replace(/\/$/,'')+'/':'';const entries=new Map();for(const path of paths){if(!path.startsWith(base))continue;const rest=path.slice(base.length),part=rest.split('/')[0];entries.set(part,{name:part,path:base+part,kind:rest.includes('/')?'directory':'file',size:120});}return [...entries.values()];}
      case 'filesystem.read':{const content=seed.fileContents[params.projectId][params.path];if(content===undefined)throw new Error('Fixture file missing: '+params.path);return {path:params.path,content,fingerprint:'fixture',readonly:false,size:content.length,modifiedAt:date};}
      case 'git.diff':{const content=seed.fileContents[params.projectId][params.path];return {path:params.path,staged:!!params.staged,oldText:content.replace('focusFirstReachable(dialog)','dialog.focus()'),newText:content,binary:false,fingerprint:'fixture'};}
      case 'usage.query':return {records:[],sessions:[],pricing:'unknown'};
      case 'device.status':return {enabled:false,tlsFingerprint:'visual-fixture'};
      case 'git.status':return {branch:trees.find(t=>t.path===(params.worktreePath||projects.find(p=>p.id===params.projectId)?.path))?.branch||'main',upstream:null,ahead:0,behind:0,changes:seed.projects[params.projectId].files.map(path=>({path,indexStatus:' ',worktreeStatus:'M'}))};
      case 'session.claim':case 'session.renew':return {epoch:1,leaseEpoch:1,expiresAt:'2099-01-01T00:00:00.000Z'};
      case 'terminal.read':{const bytes=new TextEncoder().encode(output(params.sessionId));const from=params.tail?Math.max(0,bytes.length-(params.limit??8192)):(params.cursor??0);const slice=bytes.slice(from,from+(params.limit??8192));return {sessionId:params.sessionId,encoding:'base64',data:btoa(String.fromCharCode(...slice)),fromCursor:from,nextCursor:from+slice.length,truncated:from+slice.length<bytes.length};}
      case 'session.config.read':{const s=sessions.find(s=>s.id===params.sessionId);return {sessionId:s.id,revision:0,provider:s.provider,mode:s.mode,cwd:s.worktreePath,projectId:s.projectId,title:s.title,args:[]};}
      case 'session.retry.read':return {sessionId:params.sessionId,revision:0,enabled:false,maxRetries:3,delaySeconds:5,attempts:[]};
      case 'session.release':case 'terminal.resize':return null;
      default:throw new Error('Unimplemented visual fixture method: '+method);
    }
  },onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);},onDesktopNavigate(){return()=>{};},async subscribeOutput(id,cursor,fn){await fn({sessionId:id,cursor:output(id).length,data:new TextEncoder().encode(output(id))});return()=>{};},async chooseDirectory(){return null;},async chooseSavePath(){return null;},async windowAction(){},async openWindow(){},async openExternal(){},async openDirectory(){},async desktopPreferences(){return {shortcuts:{}};},async scheduleElectronCacheCleanup(){return {scheduled:false,available:true};},async exportDiagnostics(){return null;},async testNotification(){return {sent:false,reason:'Visual fixture'};}};
}
