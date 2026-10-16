import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachedNativeBrowserPages } from './native-browser.mjs';

/** Match the actual attached native contents, never a URL that two owners may share. */
export async function attachedBrowserPages(app,rendererPage){
 const targets=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().flatMap(window=>window.contentView.children.flatMap(view=>view.webContents?[view.webContents.getOrCreateDevToolsTargetId()]:[])));
 const matches=[];
 for(const page of app.context().pages()){
  if(page===rendererPage||page.isClosed())continue;
  const session=await app.context().newCDPSession(page);
  try{const {targetInfo}=await session.send('Target.getTargetInfo');if(targets.includes(targetInfo.targetId))matches.push(page);}finally{await session.detach();}
 }
 return matches;
}

/** Preserve native bounds/ownership, renderer readiness and native pixels before shutdown. */
export async function writeBrowserViewDiagnostics(app,page,out){
 const diagnostics={};
 try{diagnostics.native=await app.evaluate(({BrowserWindow,webContents})=>({windows:BrowserWindow.getAllWindows().map(window=>({id:window.id,focused:window.isFocused(),views:window.contentView.children.flatMap(view=>view.webContents?[{id:view.webContents.id,url:view.webContents.getURL(),bounds:view.getBounds()}]:[])})),contents:webContents.getAllWebContents().map(contents=>({id:contents.id,url:contents.getURL(),title:contents.getTitle(),loading:contents.isLoading()}))}));}catch(error){diagnostics.nativeError=String(error);}
 try{diagnostics.renderer=await page.locator('.wb-web-preview').evaluateAll(elements=>elements.map(element=>{const placeholder=element.querySelector('.tt-browser-view'),bounds=placeholder?.getBoundingClientRect();return {tabId:element.dataset.webTabId,previewId:element.dataset.previewId,documentId:element.dataset.documentId,nativeReady:placeholder?.dataset.nativeReady,bounds:bounds?{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}:undefined,visible:!!element.getClientRects().length,issue:element.querySelector('[role=alert]')?.textContent,snapshot:!!placeholder?.querySelector('img'),find:element.querySelector('.wb-browser-find')?.textContent};}));}catch(error){diagnostics.rendererError=String(error);}
 try{diagnostics.overlays=await page.locator('[role=dialog], [role=menu], [role=listbox], [role=tooltip], .overlay, .popover, .scrim, .settings-drawer, .toast, .attention-toast, .selection-bubble, .chat-connection-popover, [data-tooltip]:hover').evaluateAll(elements=>elements.filter(element=>!element.hidden&&element.getAttribute('aria-hidden')!=='true'&&element.getClientRects().length>0).map(element=>({tag:element.tagName,className:element.className,role:element.getAttribute('role'),text:element.textContent?.slice(0,200)})));}catch(error){diagnostics.overlayError=String(error);}
 const screenshots=[];
 let attached=[];try{attached=await attachedNativeBrowserPages(app,page);}catch(error){diagnostics.attachmentError=String(error);}
 for(const [index,native] of attached.entries()){
  const name=`native-page-${index}.png`;
  try{await native.screenshot({path:join(out,name)});screenshots.push({id:native.id,url:native.url,file:name});}catch(error){screenshots.push({id:native.id,url:native.url,error:String(error)});}
 }
 diagnostics.screenshots=screenshots;
 await writeFile(join(out,'browser-diagnostics.json'),JSON.stringify(diagnostics,null,2));
}
