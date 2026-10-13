import type { ContextItem } from './chatContext';
type Target={visible:()=>boolean;insert:(text:string)=>void;focus?:()=>void;attachImages?:(images:string[])=>number;attachContext?:(item:ContextItem)=>boolean};
const requestedChatFocus = new Set<string>();
export function cancelChatInputFocus(sessionId: string) { requestedChatFocus.delete(sessionId); }
export function focusRequestedChatInput(sessionId: string) {
  const target = visibleTarget(chatTargets, sessionId);
  if (requestedChatFocus.has(sessionId) && target?.focus) { requestedChatFocus.delete(sessionId); target.focus(); }
}
/** A one-shot handoff, consumed when the new chat's existing input becomes writable. */
export function requestChatInputFocus(sessionId: string) { requestedChatFocus.add(sessionId); focusRequestedChatInput(sessionId); }
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
/** Inserts (multi-line) text into the session's visible Chat composer only; `chat_view_unavailable` while it has
 * none (not shown, or still connecting). File comments use this: a terminal takes one line at a time. */
export function insertChatText(sessionId:string,text:string){
  const chat=visibleTarget(chatTargets,sessionId);
  if(!chat)throw new Error('chat_view_unavailable');
  chat.insert(text);
}
/** Inserts a one-line reference into whichever input the session shows (Chat composer or terminal). */
export function insertSessionText(sessionId:string,text:string){
  const chat=visibleTarget(chatTargets,sessionId);
  if(chat){chat.insert(text);return;}
  insertTerminalText(sessionId,text);
}
/** Attaches images to the same visible Chat used for text insertion; unsupported receivers use paths only. */
export function attachChatImages(sessionId:string,images:string[]):number {
  const chat=visibleTarget(chatTargets,sessionId);
  return chat?.attachImages?.(images)??0;
}

/** Context belongs to Chat drafts only. Terminal insertion deliberately remains unchanged. */
export function attachChatContext(sessionId:string,item:ContextItem):boolean {
  const chat=visibleTarget(chatTargets,sessionId);
  if(!chat?.attachContext)throw new Error('chat_view_unavailable');
  return chat.attachContext(item);
}
