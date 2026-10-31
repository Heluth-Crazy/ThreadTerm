import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@threadterm/protocol';
import { request } from '../bridge';
import { createRunController, executeRunCommand, runRequest } from './runController';
import { runCurrentConfigs } from './runView';

const scope={projectId:'p',root:'C:\\work'};
const session=(id:string,commandId:string,worktreePath=scope.root,projectId=scope.projectId):Session=>({id,projectId,worktreePath,status:'running',createdAt:'2026-10-30',updatedAt:'2026-10-30',run:{commandId,name:commandId,kind:'service',shell:'cmd'}} as Session);
test('entry refs map to runtime admission params without reading a catalog',()=>{
 assert.deepEqual(runRequest(scope,'saved-id'),{cwd:scope.root,commandId:'saved-id'});
 assert.deepEqual(runRequest(scope,'detected:node:package.json:dev'),{cwd:scope.root,projectId:'p',detectedKey:'node:package.json:dev'});
 assert.deepEqual(runRequest(scope,'repo:dev'),{cwd:scope.root,projectId:'p',repoId:'dev'});
});
test('controller runs, stops and restarts through one request funnel',async()=>{
 const calls:{method:string;params:unknown}[]=[];
 const send=(async(method:string,params:unknown)=>{calls.push({method,params});return {};}) as typeof request;
 const controller=createRunController(scope,[],send);
 await controller.run('repo:dev');await controller.stop('s');await controller.restart('s');
 assert.deepEqual(calls.map(row=>row.method),['quickLaunch.run','session.stop','quickLaunch.restart']);
 assert.deepEqual({...calls[0].params as object,operationId:undefined},{cwd:scope.root,projectId:'p',repoId:'dev',operationId:undefined});
 assert.ok(calls.every(row=>typeof (row.params as {operationId:string}).operationId==='string'));
});
test('stop all attempts every active run here even if one stop fails; errors propagate',async()=>{
 const stopped:string[]=[];
 const send=(async(_method:string,params:{sessionId:string})=>{stopped.push(params.sessionId);if(params.sessionId==='a')throw Error('stop failed');return {};}) as typeof request;
 const controller=createRunController(scope,[session('a','a'),session('b','b'),session('other-tree','c','C:\\other'),session('other-project','d',scope.root,'q'),{...session('ended','e'),status:'exited'}],send);
 await assert.rejects(controller.stopAll(),/stop failed/);
 assert.deepEqual(stopped,['a','b']);
});
test('workspace keys resolve the current entry without a mounted view or catalog',async()=>{
 const methods:string[]=[];
 const send=(async(method:string)=>{methods.push(method);return {};}) as typeof request;
 const sessions=[session('s','repo:dev')];
 await executeRunCommand(scope,sessions,{key:'1',current:'run'},send);
 await executeRunCommand(scope,sessions,{key:'2',current:'restart'},send);
 await executeRunCommand(scope,sessions,{key:'3',current:'stop'},send);
 assert.deepEqual(methods,['quickLaunch.run','quickLaunch.restart','session.stop']);
 runCurrentConfigs.choose(scope,{commandId:'detected:node:build',source:'detected',name:'build'});
 const calls:unknown[]=[];
 const capture=(async(_method:string,params:unknown)=>{calls.push(params);return {};}) as typeof request;
 await executeRunCommand(scope,sessions,{key:'4',current:'restart'},capture);
 assert.equal((calls[0] as {detectedKey:string}).detectedKey,'node:build');
 runCurrentConfigs.forget(scope);
});
test('workspace keys retain saved, detected and repo ref mappings',async()=>{
 const calls:{method:string;params:Record<string,unknown>}[]=[];
 const send=(async(method:string,params:Record<string,unknown>)=>{calls.push({method,params});return {};}) as typeof request;
 try {
  runCurrentConfigs.choose(scope,{commandId:'saved-dev',source:'saved',name:'saved dev'});
  await executeRunCommand(scope,[],{key:'saved',current:'run'},send);
  runCurrentConfigs.choose(scope,{commandId:'detected:node:dev',source:'detected',name:'detected dev'});
  await executeRunCommand(scope,[],{key:'detected',current:'run'},send);
  runCurrentConfigs.choose(scope,{commandId:'repo:shared-dev',source:'repo',name:'shared dev'});
  await executeRunCommand(scope,[],{key:'repo',current:'run'},send);
  assert.deepEqual(calls.map(({method,params})=>({method,...params,operationId:undefined})),[
   {method:'quickLaunch.run',cwd:scope.root,commandId:'saved-dev',operationId:undefined},
   {method:'quickLaunch.run',cwd:scope.root,projectId:scope.projectId,detectedKey:'node:dev',operationId:undefined},
   {method:'quickLaunch.run',cwd:scope.root,projectId:scope.projectId,repoId:'shared-dev',operationId:undefined},
  ]);
 } finally { runCurrentConfigs.forget(scope); }
});
test('stop is a no-op while restart runs the current entry when it is no longer active',async()=>{
 const calls:string[]=[];
 const send=(async(method:string)=>{calls.push(method);return {};}) as typeof request;
 try {
  runCurrentConfigs.choose(scope,{commandId:'saved-dev',source:'saved',name:'saved dev'});
  await executeRunCommand(scope,[],{key:'stop',current:'stop'},send);
  await executeRunCommand(scope,[],{key:'restart',current:'restart'},send);
  assert.deepEqual(calls,['quickLaunch.run']);
 } finally { runCurrentConfigs.forget(scope); }
});
test('palette refs and stop all execute independently and preserve action failures',async()=>{
 const calls:string[]=[];
 const send=(async(method:string)=>{calls.push(method);throw Error('admission failed');}) as typeof request;
 await assert.rejects(executeRunCommand(scope,[],{key:'p',detectedKey:'node:dev'},send),/admission failed/);
 assert.deepEqual(calls,['quickLaunch.run']);
});
