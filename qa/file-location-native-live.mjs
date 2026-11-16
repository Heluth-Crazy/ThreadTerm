import {buildQaApp} from './lib/qa-app.mjs';
import {electron} from './lib/desktop1.mjs';
import {acquireElectronQaLock} from './lib/electron-lock.mjs';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),base=join(process.env.TEMP,'tt-qa-temp');await mkdir(base,{recursive:true});
const scratch=await mkdtemp(join(base,'tt-location-live-')),workspace=join(scratch,'workspace'),outside=join(scratch,'outside'),out=join(root,'qa/results/file-location-native-live');
await mkdir(join(workspace,'src'),{recursive:true});await mkdir(outside,{recursive:true});await mkdir(out,{recursive:true});
await writeFile(join(workspace,'src','location-sample.ts'),'export const location = "original";\n');await writeFile(join(workspace,'README.md'),'# Location QA\n');await writeFile(join(outside,'outside-location.txt'),'Synthetic external file for location QA.\n');
for(const args of [['init','-q'],['config','user.name','ThreadTerm QA'],['config','user.email','qa@threadterm.invalid'],['add','.'],['commit','-qm','QA baseline']]){const r=spawnSync('D:\\Git\\cmd\\git.exe',args,{cwd:workspace,encoding:'utf8',windowsHide:true});if(r.status)throw Error(r.stderr);}
await writeFile(join(workspace,'src','location-sample.ts'),'export const location = "modified";\n');
const runtime=join(root,'runtime/target-qa/debug/threadterm-v3-runtime.exe');if(!existsSync(runtime))throw Error('QA runtime unavailable');
const dropped=/^(path|temp|tmp|home|userprofile|appdata|localappdata|codex_home|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!dropped.test(k)));
Object.assign(env,{Path:[dirname(process.execPath),'D:\\Git\\cmd',join(process.env.SystemRoot,'System32')].join(';'),TEMP:base,TMP:base,HOME:join(scratch,'home'),USERPROFILE:join(scratch,'home'),APPDATA:join(scratch,'appdata'),LOCALAPPDATA:join(scratch,'localappdata'),CODEX_HOME:join(scratch,'home','.codex'),THREADTERM_V3_DATA:join(scratch,'data'),THREADTERM_V3_USER_DATA:join(scratch,'profile'),THREADTERM_V3_PIPE:'\\\\.\\pipe\\tt-location-live-'+randomUUID(),THREADTERM_V3_RUNTIME:runtime,THREADTERM_V3_RUNTIME_BIN:runtime,TT_QA_DESKTOP:'1',THREADTERM_V3_QA_AUTO_CONFIRM_QUIT:'1'});
await mkdir(env.CODEX_HOME,{recursive:true});
const bin=join(scratch,'bin'),historyFile=join(scratch,'history.json');await mkdir(bin,{recursive:true});
await mkdir(join(workspace,'nested','src'),{recursive:true});await writeFile(join(workspace,'nested','src','relative-location.ts'),'export const relative = true;\n');
await writeFile(join(bin,'codex.cmd'),`@"${process.execPath}" "${join(root,'qa/fixtures/fake-codex-history-refresh.cjs')}" %*\r\n`);
await writeFile(historyFile,JSON.stringify([{id:'file-location-turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'Locate these test files',text_elements:[]}]},{id:'a',type:'agentMessage',phase:'final_answer',text:`[Absolute file](${join(workspace,'src','location-sample.ts').replaceAll('\\','/')}#L1)\n\n[Relative file](src/relative-location.ts#L1)\n\n[External file](${join(outside,'outside-location.txt').replaceAll('\\','/')}#L1)`}]}]));
Object.assign(env,{THREADTERM_QA_PROVIDER_BIN:bin,TT_QA_HISTORY_FILE:historyFile,TT_QA_HISTORY_CWD:join(workspace,'nested'),TT_QA_HISTORY_LOG:join(scratch,'history-provider.log')});
env.Path=bin+';'+env.Path;
const {appDir,cleanup}=await buildQaApp({root,outDir:join(scratch,'qa-app')});
let app,release;try{
 release=await acquireElectronQaLock({directory:base,timeoutMs:15000});
 app=await electron.launch({args:['--force-renderer-accessibility','--disable-features=CalculateNativeWinOcclusion',appDir],cwd:root,env,timeout:60000});
 const page=await app.firstWindow({timeout:45000});await page.waitForFunction(()=>Boolean(window.threadterm));await page.locator('.app-shell').waitFor({timeout:60000});
 const rpc=(name,params={})=>page.evaluate(([n,p])=>window.threadterm.request(n,p),[name,params]);
 const project=await rpc('project.add',{path:workspace,name:'Location QA ONLY',operationId:randomUUID()});
 const session=await rpc('session.create',{projectId:project.id,cwd:workspace,provider:'shell',mode:'terminal',title:'Location QA ONLY',operationId:randomUUID()});
 const snapshot=await rpc('runtime.snapshot');await rpc('settings.update',{patch:{language:'en',notifications:{native:false,attention:false,completed:false,sound:false}},expectedRevision:snapshot.settings.revision,operationId:randomUUID()});
 await rpc('session.present',{sessionId:session.id,placement:'workspace',presentation:'focused',operationId:randomUUID()});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setTitle('ThreadTerm Location QA ONLY'));
 const chat=await rpc('history.import',{projectId:project.id,provider:'codex',nativeId:'qa-history-refresh-thread',cwd:join(workspace,'nested'),mode:'chat',title:'File location references QA',operationId:randomUUID()});
 const info={scratch,workspace,outside,projectId:project.id,sessionId:session.id,chatSessionId:chat.id,profile:env.THREADTERM_V3_USER_DATA,codexHome:env.CODEX_HOME,stopFile:join(scratch,'stop'),commandFile:join(scratch,'command.json')};
 await writeFile(join(out,'active.json'),JSON.stringify(info,null,2));console.log('READY '+JSON.stringify(info));
 while(!existsSync(info.stopFile)){
  if(existsSync(info.commandFile)){const command=JSON.parse((await readFile(info.commandFile,'utf8')).replace(/^\uFEFF/,''));if(command.id!==globalThis.lastCommand){globalThis.lastCommand=command.id;try{const result=await rpc(command.method,command.params);await writeFile(join(scratch,'reply.json'),JSON.stringify({id:command.id,result}));}catch(error){await writeFile(join(scratch,'reply.json'),JSON.stringify({id:command.id,error:String(error)}));}}}
  await new Promise(r=>setTimeout(r,500));
 }

}finally{if(app)await app.close();if(release)await release();console.log('CLOSED; retained isolated QA data at '+scratch);}
