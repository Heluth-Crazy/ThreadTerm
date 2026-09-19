import {sameCanonicalScope} from './projectScope';
type EditorScope={projectId:string;worktreePath?:string;ownerSessionId?:string;isDirty:()=>boolean};
const editors = new Map<string, {confirm:()=>Promise<boolean>;scope?:EditorScope}>();
export function registerDirtyEditor(id:string, confirm:()=>Promise<boolean>,scope?:EditorScope) {
  const entry={confirm,scope};editors.set(id,entry);
  return () => {if(editors.get(id)===entry)editors.delete(id);};
}
export async function confirmCloseEditors(ids?:string[]) {
  for(const [id,entry] of editors){if((!ids||ids.includes(id))&&!await entry.confirm())return false;}
  return true;
}
export function hasDirtyEditorsInScope(target:{projectId:string;projectPath?:string;worktreePath?:string;sessionId?:string}){
  return [...editors.values()].some(({scope})=>scope&&scope.projectId===target.projectId&&scope.isDirty()
    && (!target.sessionId||scope.ownerSessionId===target.sessionId)
    && (!target.worktreePath||sameCanonicalScope(scope.worktreePath??target.projectPath,target.worktreePath)));
}
