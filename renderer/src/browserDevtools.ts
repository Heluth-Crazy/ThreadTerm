export type BrowserDevtoolsShortcut = {action:'toggle'|'open';panel?:'console'|'elements'};

export function browserDevtoolsShortcut(input:{key:string;control:boolean;meta:boolean;shift:boolean;alt:boolean}):BrowserDevtoolsShortcut|undefined {
 if(input.alt)return undefined;
 if(input.key==='F12')return {action:'toggle'};
 if(!input.shift||(!input.control&&!input.meta))return undefined;
 switch(input.key.toLowerCase()){
  case 'i':return {action:'toggle'};
  case 'j':return {action:'open',panel:'console'};
  case 'c':return {action:'open',panel:'elements'};
  default:return undefined;
 }
}

export function clampDevtoolsHeight(height:number,paneHeight:number):number {
 const pane=Number.isFinite(paneHeight)?Math.max(0,paneHeight):0;
 if(pane<240)return pane/2;
 const requested=Number.isFinite(height)?height:120;
 return Math.min(Math.max(requested,120),pane-120);
}
