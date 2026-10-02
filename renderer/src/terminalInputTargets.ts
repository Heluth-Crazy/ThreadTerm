type Target={visible:()=>boolean;insert:(text:string)=>void};
const targets=new Map<string,Set<Target>>();
const chatTargets=new Map<string,Set<Target>>();
const register=(registry:Map<string,Set<Target>>,sessionId:string,target:Target)=>{
  const values=registry.get(sessionId)??new Set<Target>();values.add(target);registry.set(sessionId,values);
  return()=>{values.delete(target);if(!values.size)registry.delete(sessionId);};
};
const visibleTarget=(registry:Map<string,Set<Target>>,sessionId:string)=>[...(registry.get(sessionId)??[])].reverse().find(value=>value.visible());
export function registerTerminalInputTarget(sessionId:string,target:Target){
  return register(targets,sessionId,target);
}
/** Chat composers accept inserted text at the caret; they never submit it. */
export function registerChatInputTarget(sessionId:string,target:Target){
  return register(chatTargets,sessionId,target);
}
export function insertTerminalText(sessionId:string,text:string){
  if(!text||/[\x00-\x1f\x7f]/.test(text))throw new Error('terminal_command_requires_single_line');
  const target=visibleTarget(targets,sessionId);
  if(!target)throw new Error('terminal_view_unavailable');
  target.insert(text);
}
/** Inserts a one-line reference into whichever input the session shows (Chat composer or terminal). */
export function insertSessionText(sessionId:string,text:string){
  const chat=visibleTarget(chatTargets,sessionId);
  if(chat){chat.insert(text);return;}
  insertTerminalText(sessionId,text);
}
