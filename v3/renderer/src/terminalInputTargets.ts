type Target={visible:()=>boolean;insert:(text:string)=>void};
const targets=new Map<string,Set<Target>>();
export function registerTerminalInputTarget(sessionId:string,target:Target){
  const values=targets.get(sessionId)??new Set<Target>();values.add(target);targets.set(sessionId,values);
  return()=>{values.delete(target);if(!values.size)targets.delete(sessionId);};
}
export function insertTerminalText(sessionId:string,text:string){
  if(!text||/[\x00-\x1f\x7f]/.test(text))throw new Error('terminal_command_requires_single_line');
  const target=[...(targets.get(sessionId)??[])].reverse().find(value=>value.visible());
  if(!target)throw new Error('terminal_view_unavailable');
  target.insert(text);
}
