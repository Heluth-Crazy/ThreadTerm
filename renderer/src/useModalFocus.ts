import { useEffect, useRef, type RefObject } from 'react';
const stack:symbol[]=[];
export function useModalFocus(panel:RefObject<HTMLElement|null>,onClose:()=>void){
 const callback=useRef(onClose);callback.current=onClose;
 const invokerRef=useRef(document.activeElement instanceof HTMLElement?document.activeElement:null);
 useEffect(()=>{
  const token=Symbol('modal');stack.push(token);
  const invoker=invokerRef.current;
  const focusable=()=>Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')??[]).filter(node=>node.getClientRects().length>0&&node.checkVisibility({visibilityProperty:true}));
  if(!panel.current?.contains(document.activeElement))(focusable()[0]??panel.current)?.focus();
  const key=(event:KeyboardEvent)=>{
   if(stack.at(-1)!==token)return;
   if(event.key==='Escape'){
    // An expanded combobox owns the first Escape. Its target handler closes
    // the listbox; the next Escape can dismiss the surrounding dialog.
    const combobox=event.target instanceof Element?event.target.closest('[role="combobox"][aria-expanded="true"]'):null;
    if(combobox&&panel.current?.contains(combobox))return;
    event.preventDefault();event.stopPropagation();callback.current();return;
   }
   if(event.key!=='Tab')return;
   const nodes=focusable(),first=nodes[0],last=nodes.at(-1);
   if(!first){event.preventDefault();panel.current?.focus();}
   else if(event.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){event.preventDefault();first.focus();}
  };
  document.addEventListener('keydown',key,true);
  return()=>{document.removeEventListener('keydown',key,true);const top=stack.at(-1)===token,index=stack.indexOf(token);if(index>=0)stack.splice(index,1);if(top&&invoker?.isConnected)invoker.focus();};
 },[]);
}
