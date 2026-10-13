import type { ContextItem } from './chatContext';
type Target={visible:()=>boolean;insert:(text:string)=>void;focus?:()=>boolean|void;attachImages?:(images:string[])=>number;attachContext?:(item:ContextItem)=>boolean};
const requestedChatFocus = new Map<string, object>();
const focusBurst = new Map<string, number>();
function stopFocusBurst(sessionId: string) {
  const handle = focusBurst.get(sessionId);
  if (handle === undefined) return;
  focusBurst.delete(sessionId);
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
}
export function cancelChatInputFocus(sessionId: string) {
  stopFocusBurst(sessionId);
  requestedChatFocus.delete(sessionId);
}
export function focusRequestedChatInput(sessionId: string) {
  const pending = requestedChatFocus.get(sessionId);
  if (!pending) { stopFocusBurst(sessionId); return; }
  const target = visibleTarget(chatTargets, sessionId);
  const applied = !!target?.focus && target.focus() !== false && requestedChatFocus.get(sessionId) === pending;
  // Node unit tests have no frame scheduler; a confirmed focus is consumed immediately.
  if (typeof requestAnimationFrame !== 'function') {
    if (applied) requestedChatFocus.delete(sessionId);
    return;
  }
  if (focusBurst.has(sessionId)) return;
  // Chromium ignores focus() in the turn that drops `inert` or `hidden`, and a
  // new Ask composer can disable again for a frame after the first success. The
  // browser then moves focus to the document. Keep this one handoff until focus
  // has stayed for several frames, or for about two seconds.
  let left = 120;
  let stable = 0;
  const tick = () => {
    focusBurst.delete(sessionId);
    if (requestedChatFocus.get(sessionId) !== pending) return;
    const current = visibleTarget(chatTargets, sessionId);
    const held = !!current?.focus && current.focus() !== false && requestedChatFocus.get(sessionId) === pending;
    if (held) stable += 1; else stable = 0;
    if (stable >= 15) {
      requestedChatFocus.delete(sessionId);
      return;
    }
    if (--left <= 0) return;
    focusBurst.set(sessionId, requestAnimationFrame(tick));
  };
  focusBurst.set(sessionId, requestAnimationFrame(tick));
}
/** A one-shot handoff, consumed when the new chat's existing input becomes writable. */
export function requestChatInputFocus(sessionId: string) { requestedChatFocus.set(sessionId, {}); focusRequestedChatInput(sessionId); }
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
  const remove = register(chatTargets,sessionId,target);
  return () => {
    remove();
    const pending = requestedChatFocus.get(sessionId);
    // Effect replay/replacement registers the next target in this commit. Only
    // a genuine final close retires its still-pending handoff; no idle timer.
    if (pending && !chatTargets.has(sessionId)) queueMicrotask(() => {
      if (!chatTargets.has(sessionId) && requestedChatFocus.get(sessionId) === pending) cancelChatInputFocus(sessionId);
    });
  };
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
