import type { Terminal as HeadlessTerminal } from '@xterm/headless';

// xterm's platform detector expects browser navigator strings even though its
// headless core never opens a DOM. Hermes supplies navigator without these two
// optional web fields, so provide only the absent metadata before module eval.
const host=globalThis as typeof globalThis & {navigator?:{userAgent?:string;platform?:string}};
if(!host.navigator)host.navigator={} as Navigator;
if(!host.navigator.userAgent)Object.defineProperty(host.navigator,'userAgent',{value:'ReactNative',configurable:true});
if(!host.navigator.platform)Object.defineProperty(host.navigator,'platform',{value:'iPhone',configurable:true});
const { Terminal }=require('@xterm/headless') as typeof import('@xterm/headless');

export type TerminalLine = { text:string; cursor?:boolean; cursorColumn?:number };

/** The terminal protocol's Enter is CR; pasted line endings cannot create a second command. */
export function terminalCommand(text:string) { return `${text.replace(/[\r\n]+/g,'')}\r`; }

export function terminalViewportSize(width:number,height:number,cellWidth:number,lineHeight=20) {
  return {cols:Math.max(2,Math.min(500,Math.floor(width/cellWidth))),rows:Math.max(2,Math.min(200,Math.floor(height/lineHeight)))};
}

/**
 * A DOM-free VT screen. The mobile UI draws its buffer rather than treating PTY
 * bytes as a transcript, so carriage returns, CSI updates and alt-screen apps
 * retain their terminal meaning under Hermes.
 */
export class TerminalScreen {
  private terminal:HeadlessTerminal;
  private pending=new Set<()=>void>();
  constructor(private cols=120,private rows=40) { this.terminal=this.create(); }
  private create() { return new Terminal({cols:this.cols,rows:this.rows,scrollback:2000,allowProposedApi:true,convertEol:false,logLevel:'off'}); }
  reset() { this.dispose();this.terminal=this.create(); }
  dispose() { this.terminal.dispose();for(const done of this.pending)done();this.pending.clear(); }
  resize(cols:number,rows:number) {
    const nextCols=Math.max(1,Math.floor(cols)),nextRows=Math.max(1,Math.floor(rows));
    if(nextCols===this.cols&&nextRows===this.rows)return;
    this.cols=nextCols;this.rows=nextRows;this.terminal.resize(nextCols,nextRows);
  }
  write(text:string):Promise<void> {
    return new Promise(done=>{
      const complete=()=>{this.pending.delete(complete);done();};
      this.pending.add(complete);this.terminal.write(text,complete);
    });
  }
  lines():TerminalLine[] {
    const buffer=this.terminal.buffer.active;
    const cursor=buffer.baseY+buffer.cursorY;
    const rows:TerminalLine[]=[];
    for(let index=0;index<buffer.length;index++) {
      const text=buffer.getLine(index)?.translateToString(true)??'';
      // Keep blank interior rows: cursor positioning is screen geometry, not
      // an append-only transcript. Trim only blank rows below all content.
      rows.push({text:text||' ',cursor:index===cursor,cursorColumn:index===cursor?buffer.cursorX:undefined});
    }
    while(rows.length>1&&!rows.at(-1)?.cursor&&rows.at(-1)?.text===' ')rows.pop();
    return rows;
  }
}
