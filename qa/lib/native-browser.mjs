// QA-only access to WebContentsView pages. No Playwright Page registration or OS focus required.
import { writeFile } from 'node:fs/promises';

/** Fixture Chat completions may leave a toast holding a legitimate browser occlusion lease. */
export async function dismissBrowserNotifications(page){
 const dismiss=page.locator('.attention-toast button[aria-label]');
 if(await dismiss.count())await dismiss.first().click();
}

/** Include hidden live contents for ownership assertions; attachment is checked separately before input. */
export async function nativeBrowserContents(app){
 return app.evaluate(({BrowserWindow,webContents,session})=>{
  const profile=session.fromPartition('persist:threadterm-browser');
  return webContents.getAllWebContents().filter(contents=>!contents.isDestroyed()&&contents.session===profile).map(contents=>({id:contents.id,url:contents.getURL(),windowId:BrowserWindow.getAllWindows().find(window=>window.contentView.children.some(view=>view.webContents===contents))?.id}));
 });
}

/** Scope to the renderer's BrowserWindow, then bind operations to an exact attached contents ID. */
export async function attachedNativeBrowserPages(app,rendererPage){
 const owner=await app.browserWindow(rendererPage);let windowId;
 try{windowId=await owner.evaluate(window=>window.id);}finally{await owner.dispose();}
 return (await nativeBrowserContents(app)).filter(contents=>contents.windowId===windowId).map(contents=>({
  ...contents,
  boundingBox:selector=>operate(app,contents,'box',{selector}),
  click:selector=>operate(app,contents,'click',{selector}),
  rightClick:selector=>operate(app,contents,'click',{selector,button:'right'}),
  drag:(from,to,steps=6)=>operate(app,contents,'drag',{from,to,steps}),
  async screenshot({path}){const data=await operate(app,contents,'capture');await writeFile(path,Buffer.from(data,'base64'));},
 }));
}

async function operate(app,identity,operation,args={}){
 return app.evaluate(async({BrowserWindow,webContents},{identity,operation,args})=>{
  const window=BrowserWindow.fromId(identity.windowId),contents=webContents.fromId(identity.id);
  if(!contents||contents.isDestroyed()||!window?.contentView.children.some(view=>view.webContents===contents))throw Error(`Native contents ${identity.id} is no longer attached to window ${identity.windowId}`);
  if(contents.getURL()!==identity.url)throw Error(`Native contents ${identity.id} navigated; select it again`);
  if(operation==='capture')return (await contents.capturePage()).toPNG().toString('base64');
  const box=async selector=>contents.executeJavaScript(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null;})()`);
  if(operation==='box')return box(args.selector);
  let from=args.from,to=args.to;
  if(operation==='click'){const rect=await box(args.selector);if(!rect)throw Error(`Native selector is not visible: ${args.selector}`);from=to={x:rect.x+rect.width/2,y:rect.y+rect.height/2};}
  // Electron sendInputEvent requires OS focus. CDP sends trusted input to this exact contents without it.
  // Never detach a debugger owned by another harness/tool.
  if(contents.debugger.isAttached())throw Error(`Native contents ${identity.id} already has an Electron debugger`);
  contents.debugger.attach('1.3');
  try{
   const button=args.button??'left',pressed=button==='right'?2:1;
   const send=(type,point,buttons,button='none')=>contents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,buttons,button,clickCount:button==='none'?0:1});
   await send('mouseMoved',from,0);await send('mousePressed',from,pressed,button);
   if(operation==='drag')for(let step=1;step<=args.steps;step++)await send('mouseMoved',{x:from.x+(to.x-from.x)*step/args.steps,y:from.y+(to.y-from.y)*step/args.steps},1,'left');
   await send('mouseReleased',to,0,button);
  }finally{contents.debugger.detach();}
 },{identity,operation,args});
}
