import { isolateHistory } from '@codemirror/commands';
import { type Extension, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { adjacentGitHunk, hunkAtPosition, hunkPreview, revertGitHunk } from '../workbench/gutterHunk';
import type { ChunkRange } from '../workbench/indexEdit';

export type GitHunkActions = { conflicted?:boolean; disabled?:string; stage:(base:string,buffer:string,chunk:ChunkRange)=>void; openDiff:(line:number)=>void };
export type GitHunkSnapshot = {base:string;doc:Text;chunks:readonly ChunkRange[]};

/** Plain DOM peek, sharing the gutter's debounced chunk snapshot. No second diff editor or scan. */
export function gitHunkPopup(snapshot:(view:EditorView)=>GitHunkSnapshot|undefined, actions:{current:GitHunkActions|undefined}, enabled:(view:EditorView)=>boolean, zh:boolean) {
 const label=(en:string,cn:string)=>zh?cn:en;
 const plugin=ViewPlugin.fromClass(class {
  dom:HTMLDivElement|undefined;
  chunk:ChunkRange|undefined;
  index=-1;
  rendered:{doc:Text;chunks:readonly ChunkRange[];index:number;disabled:string|undefined}|undefined;
  focusOutside=(event:FocusEvent)=>{if(this.dom&&event.target instanceof Node&&!this.dom.contains(event.target)&&!this.view.dom.contains(event.target))this.close(false);};
  constructor(readonly view:EditorView) {document.addEventListener('focusin',this.focusOutside);}
  close(focus=true) { this.dom?.remove();this.dom=undefined;this.chunk=undefined;this.index=-1;this.rendered=undefined;if(focus)this.view.focus(); }
  fresh() {return enabled(this.view)?snapshot(this.view):undefined;}
  open(index:number) {
   const state=this.fresh(),chunk=state?.chunks[index];if(!chunk)return false;
   this.chunk=chunk;this.index=index;
   if(!this.dom) {
    this.dom=document.createElement('div');this.dom.className='cm-git-hunk-popup';this.dom.setAttribute('role','dialog');this.dom.setAttribute('aria-label',label('Git change','Git 更改'));
    this.dom.addEventListener('keydown',event=>{
     if(!enabled(this.view)){this.close(false);return;}
     if(event.key==='Escape') {event.preventDefault();event.stopPropagation();this.close();return;}
     if(event.key==='F7'&&!event.altKey&&!event.ctrlKey&&!event.metaKey) {event.preventDefault();event.stopPropagation();this.move(event.shiftKey?-1:1);return;}
     if(event.key.toLowerCase()==='z'&&event.ctrlKey&&event.altKey&&!event.metaKey&&!event.shiftKey) {event.preventDefault();event.stopPropagation();this.revert();return;}
     if(event.key==='Tab') {const buttons=[...this.dom!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],at=buttons.indexOf(document.activeElement as HTMLButtonElement);event.preventDefault();buttons[(at+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();}
    });
    document.body.append(this.dom);
   }
   this.render(true);return true;
  }
  move(direction:1|-1) {
   const state=this.fresh();if(!state)return false;
   const next=this.dom?this.index+direction:adjacentGitHunk(state.chunks,this.view.state.selection.main.head,direction),chunk=state.chunks[next];
   if(!chunk)return false;
   const from=Math.min(chunk.fromB,this.view.state.doc.length);
   this.view.dispatch({selection:{anchor:from},effects:EditorView.scrollIntoView(from,{y:'center'})});
   if(this.dom)this.open(next);return true;
  }
  revert() {
   const state=this.fresh(),chunk=state?.chunks[this.index];if(!state||!chunk)return;
   const changes=revertGitHunk(state.base,state.doc.toString(),chunk);this.close(false);
   this.view.dispatch({changes,annotations:isolateHistory.of('full'),userEvent:'input.revert'});this.view.focus();
  }
  render(focus=false) {
   if(!enabled(this.view)){this.close(false);return;}
   const state=this.fresh(),dom=this.dom,chunk=state?.chunks[this.index];if(!dom||!state||!chunk)return;
   this.view.requestMeasure({key:this,read:()=>this.view.coordsAtPos(Math.min(Math.max(chunk.fromB,chunk.toB-1),state.doc.length))??this.view.coordsAtPos(Math.min(chunk.fromB,state.doc.length))??this.view.dom.getBoundingClientRect(),write:coords=>{if(!coords||this.dom!==dom)return;dom.style.left=`${Math.max(8,Math.min(coords.left,window.innerWidth-620))}px`;dom.style.top=`${Math.max(8,Math.min(coords.bottom+4,window.innerHeight-dom.offsetHeight-8))}px`;}});
   const previous=this.rendered,disabled=actions.current?.disabled;
   if(!focus&&previous?.doc===state.doc&&previous.chunks===state.chunks&&previous.index===this.index&&previous.disabled===disabled)return;
   this.rendered={doc:state.doc,chunks:state.chunks,index:this.index,disabled};
   const focused=dom.contains(document.activeElement)?(document.activeElement as HTMLElement).dataset.action:undefined;
   dom.replaceChildren();
   const header=document.createElement('div');header.className='cm-git-hunk-header';
   const title=document.createElement('strong');title.textContent=zh?`更改 ${this.index+1} / ${state.chunks.length}`:`Change ${this.index+1} of ${state.chunks.length}`;header.append(title);dom.append(header);
   const button=(parent:HTMLElement,key:string,text:string,run:()=>void,shortcut?:string,disabled=false,reason?:string)=>{
    const node=document.createElement('button');node.type='button';node.className='btn btn-sm';node.dataset.action=key;node.textContent=text;node.disabled=disabled;node.title=reason??`${text}${shortcut?` (${shortcut})`:''}`;if(shortcut)node.setAttribute('aria-keyshortcuts',shortcut);node.addEventListener('click',run);parent.append(node);return node;
   };
   button(header,'previous',label('Previous change','上一处更改'),()=>this.move(-1),'Shift+F7',this.index===0);
   button(header,'next',label('Next change','下一处更改'),()=>this.move(1),'F7',this.index===state.chunks.length-1);
   button(header,'close',label('Close','关闭'),()=>this.close(),'Escape');
   const preview=document.createElement('div');preview.className='cm-git-hunk-lines';
   const content=hunkPreview(state.base,state.doc.toString(),chunk);
   for(const line of content.lines) {const row=document.createElement('pre');row.className=`cm-git-hunk-${line.kind}`;row.textContent=`${line.kind==='removed'?'-':'+'} ${line.text}`;preview.append(row);}
   if(content.remaining) {const more=document.createElement('div');more.textContent=zh?`还有 ${content.remaining} 行`:`and ${content.remaining} more lines`;preview.append(more);}
   dom.append(preview);
   const footer=document.createElement('div');footer.className='cm-git-hunk-actions';dom.append(footer);
   button(footer,'revert',label('Revert','还原'),()=>this.revert(),'Control+Alt+Z');
   button(footer,'stage',label('Stage this change','暂存此更改'),()=>{const current=this.fresh();if(current&&!actions.current?.disabled)actions.current?.stage(current.base,current.doc.toString(),current.chunks[this.index]);},undefined,Boolean(actions.current?.disabled)||!actions.current,actions.current?.disabled);
   button(footer,'diff',label('Open in diff','在差异视图中打开'),()=>{const line=state.doc.lineAt(Math.min(chunk.fromB,state.doc.length)).number;this.close(false);actions.current?.openDiff(line);});
   if(focus||focused)queueMicrotask(()=>{if(this.dom===dom)(dom.querySelector<HTMLButtonElement>(`button[data-action="${focused??'close'}"]:not(:disabled)`)??dom.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();});
  }
  update(update:ViewUpdate) {
   if(!this.dom||!this.chunk)return;
   if(!enabled(this.view)) {this.close(false);return;}
   if(update.docChanged)this.chunk={...this.chunk,fromB:update.changes.mapPos(this.chunk.fromB,-1),toB:update.changes.mapPos(Math.min(this.chunk.toB,update.startState.doc.length),-1)};
   const state=this.fresh();
   if(!state) {for(const button of this.dom.querySelectorAll<HTMLButtonElement>('button:not([data-action=close])'))button.disabled=true;return;}
   const index=state.chunks.findIndex(chunk=>chunk.fromB===this.chunk!.fromB);
   if(index<0) {this.close();return;}
   this.index=index;this.chunk=state.chunks[index];this.render();
  }
  destroy() {document.removeEventListener('focusin',this.focusOutside);this.close(false);}
 });
 const open=(view:EditorView,position:number)=>{const state=enabled(view)?snapshot(view):undefined;return state?view.plugin(plugin)?.open(hunkAtPosition(state.chunks,state.doc,position))??false:false;};
 const extension:Extension=[plugin,keymap.of([{key:'Alt-F7',run:view=>enabled(view)&&open(view,view.state.selection.main.head)}])];
 return {extension,open,move:(view:EditorView,direction:1|-1)=>enabled(view)?view.plugin(plugin)?.move(direction)??false:false,refresh:(view:EditorView)=>view.plugin(plugin)?.render()};
}
