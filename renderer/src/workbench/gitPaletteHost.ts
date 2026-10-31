type GitHostCandidate = {key:string;focused:boolean;inOverlay:boolean};

/** An overlay fences out background workspaces, even if their previous focus is still present. */
export function selectGitPaletteHost<T extends GitHostCandidate>(hosts:readonly T[], overlayOpen=false):T|undefined {
 const eligible=overlayOpen?hosts.filter(host=>host.inOverlay):hosts;
 const focused=eligible.filter(host=>host.focused);
 return focused.length===1?focused[0]:focused.length===0&&eligible.length===1?eligible[0]:undefined;
}

/** Capture before the palette's focus effect runs; never infer ownership from DOM order. */
export function captureGitPaletteHost(doc:Document) {
 const host=captureWorkbenchPaletteHost(doc,'data-git-workbench','data-git-workbench-host');
 return host?{...host,repository:host.element.dataset.gitRepository==='true'}:undefined;
}

/** The Run host of the same exclusive capture: the palette's Run entries reach only this workspace's worktree. */
export function captureRunPaletteHost(doc:Document) {
 const host=captureWorkbenchPaletteHost(doc,'data-run-workbench','data-run-workbench-host');
 const projectId=host?.element.dataset.runProjectId, root=host?.element.dataset.runWorktreePath;
 return host&&projectId&&root?{...host,projectId,root}:undefined;
}

function captureWorkbenchPaletteHost(doc:Document, scopeAttribute:string, hostAttribute:string) {
 const datasetKey=(attribute:string)=>attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_match, letter:string) => letter.toUpperCase());
 const visible=(element:HTMLElement)=>element.getClientRects().length>0&&!element.closest('[hidden],[inert]')&&element.checkVisibility({visibilityProperty:true});
 const layerSelector='[role="dialog"][aria-modal="true"],dialog[open],.scrim,.overlay,.settings-drawer,[data-portal],[data-portal-root]';
 const rootFor=(element:HTMLElement|null)=>{
  let modal:HTMLElement|undefined;
  for(let node=element;node;node=node.parentElement) {
   const style=doc.defaultView?.getComputedStyle(node),zIndex=style?.zIndex;
   const parentDisplay=node.parentElement&&doc.defaultView?.getComputedStyle(node.parentElement).display;
   if(node.matches('.scrim,.overlay,.settings-drawer,[data-portal],[data-portal-root]')||(zIndex&&zIndex!=='auto'&&(style?.position!=='static'||/flex|grid/.test(parentDisplay??''))))return node;
   if(!modal&&node.matches('[role="dialog"][aria-modal="true"],dialog[open]'))modal=node;
  }
  return modal;
 };
 const layers=Array.from(doc.querySelectorAll<HTMLElement>(layerSelector))
  .filter(element=>!element.closest('.shell-palette-scrim')&&visible(element));
 const elements=Array.from(doc.querySelectorAll<HTMLElement>(`[${scopeAttribute}][${hostAttribute}]`)).filter(visible);
 const roots=new Set<HTMLElement>();
 for(const element of [...layers,...elements])for(let root=rootFor(element);root;root=rootFor(root.parentElement))roots.add(root);
 const overlays=[...roots].sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&4?-1:1);
 const ranked=overlays.map((element,index)=>({element,index,zIndex:parseInt(doc.defaultView?.getComputedStyle(element).zIndex??'',10)||0}));
 const chain=(element:HTMLElement)=>ranked.filter(layer=>layer.element===element||layer.element.contains(element));
 const order=(left:HTMLElement,right:HTMLElement)=>{
  const a=chain(left),b=chain(right);
  for(let index=0;index<Math.min(a.length,b.length);index++) {
   const difference=a[index].zIndex-b[index].zIndex||a[index].index-b[index].index;
   if(difference)return difference;
  }
  return a.length-b.length;
 };
 // Stacking is independent of focus and overlap geometry. Focus only chooses a host within the top layer.
 const overlay=overlays.sort(order).at(-1);
 const hosts=elements.map(element=>({element,key:element.dataset[datasetKey(hostAttribute)]??'',focused:element.contains(doc.activeElement),inOverlay:rootFor(element)===overlay}));
 const selected=selectGitPaletteHost(hosts,Boolean(overlay));
 // Duplicate keys cannot provide exclusive routing.
 return selected&&hosts.filter(host=>host.key===selected.key).length===1?selected:undefined;
}
