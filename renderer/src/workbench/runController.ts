import type { Session } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { currentRunEntry, runCurrentConfigs, runningRows, type RunCommandRequest, type RunScope } from './runView';

/** Ref-only launch mapping: the runtime resolves file-backed entries at admission. */
export function runRequest(scope:RunScope, ref:string) {
 return {cwd:scope.root, ...(ref.startsWith('detected:') ? {projectId:scope.projectId,detectedKey:ref.slice(9)} : ref.startsWith('repo:') ? {projectId:scope.projectId,repoId:ref.slice(5)} : {commandId:ref})};
}

/** Shared mutation funnel. Navigation and localized errors belong to the invoking surface. */
export function createRunController(scope:RunScope, sessions:readonly Session[], send:typeof request = request) {
 const stop = (sessionId:string) => send('session.stop',{sessionId,operationId:operationId()});
 return {
  run:(ref:string) => send('quickLaunch.run',{...runRequest(scope,ref),operationId:operationId()}),
  stop,
  restart:(sessionId:string) => send('quickLaunch.restart',{sessionId,operationId:operationId()}),
  stopAll:async () => {
   const results=await Promise.allSettled(runningRows(sessions,scope).filter(row=>row.current).map(row=>stop(row.session.id)));
   const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
   if(failure)throw failure.reason;
  },
 };
}

/** Workspace keys and captured palette events work even when the Run view has never mounted. */
export async function executeRunCommand(scope:RunScope, sessions:readonly Session[], command:RunCommandRequest, send:typeof request = request) {
 const controller=createRunController(scope,sessions,send);
 if(command.stopAll)return controller.stopAll();
 const ref=command.detectedKey ? `detected:${command.detectedKey}` : command.commandId;
 if(ref)return controller.run(ref);
 const current=currentRunEntry(scope,sessions,runCurrentConfigs.get(scope));
 if(!current)return;
 const active=runningRows(sessions,scope).find(row=>row.current&&row.commandId===current.commandId)?.session;
 if(command.current==='stop'){if(active)return controller.stop(active.id);return;}
 if(command.current==='restart'&&active)return controller.restart(active.id);
 if(command.current)return controller.run(current.commandId);
}
