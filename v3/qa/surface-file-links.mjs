// Isolated production ChatView/TerminalSurface click regression. No runtime,
// provider process, filesystem access, or model request is started.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-surface-links-'));
const out = resolve('qa/results/surface-file-links');
await mkdir(out,{recursive:true});
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {ChatView} from './renderer/src/components/ChatView';
import {TerminalSurface} from './renderer/src/components/TerminalSurface';
import {SessionSurfaceContext} from './renderer/src/components/SessionSurfaceContext';
import {FileLinkedMarkdown} from './renderer/src/components/FileReferenceText';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
window.opened=[];
window.terminalRequests=[];
const openFile=reference=>window.opened.push(reference);
const originalOpen=Terminal.prototype.open;
Terminal.prototype.open=function(element){window.term=this;return originalOpen.call(this,element)};
const originalLinks=Terminal.prototype.registerLinkProvider;
Terminal.prototype.registerLinkProvider=function(provider){
 window.fileProvider=provider;
 return originalLinks.call(this,{provideLinks(line,callback){provider.provideLinks(line,links=>{
  for(const link of links??[]){
   const hover=link.hover,leave=link.leave;
   link.hover=(event,text)=>{window.hoveredFileLink=link;hover?.(event,text)};
   link.leave=(event,text)=>{leave?.(event,text)};
  }
  callback(links);
 })}});
};
window.threadterm={
 windowsPty:{backend:'conpty',buildNumber:22631},
 request:async(method,params)=>{
  if(method.startsWith('terminal.')||method.startsWith('session.'))window.terminalRequests.push({method,params});
  if(method==='chat.snapshot')return {revision:1,items:[
   {id:'u',role:'user',createdAt:'now',parts:[{type:'text',text:'Please read src/App.tsx:12'}]},
   {id:'a',role:'assistant',createdAt:'now',parts:[
    {type:'text',text:'See \`src/App.tsx:12\` and [details](src/other.ts:7).',fileReferences:[{path:'src/App.tsx',line:12},{path:'src/other.ts',line:7}]},
    {type:'tool',toolName:'Read',status:'failed',text:'Could not read src/missing.ts:4',fileReferences:[{path:'src/missing.ts',line:4},{path:'src/extra.ts',line:9},{path:'file:///C:/repo/native.rs',line:11},{path:'image',line:5,column:3},{path:'https://example.com/image'},{path:'bad'+String.fromCharCode(0)+'path'},{path:'file:///C:/repo/%2e%2e/secret'}]}
   ]}
  ]};
  if(method==='chat.draft.read')return {text:'',revision:0};
  if(method==='chat.options')return {options:[],commands:[]};
  if(method==='terminal.read')return {nextCursor:0};
  if(method==='session.launch.read')throw new Error('session_launch_unavailable');
  if(method==='session.claim')return {leaseEpoch:73};
  if(method==='session.renew'||method==='session.release'||method==='terminal.resize'||method==='terminal.input')return null;
  throw new Error('Unexpected QA method '+method);
 },
 onEvent:()=>()=>{},
 subscribeOutput:async()=>()=>{},
};
const chat={id:'chat',provider:'codex',mode:'chat',status:'exited',readOnly:true,title:'Chat',createdAt:'now',updatedAt:'now'};
const presentation={primaryHost:document.getElementById('primary'),menuHost:document.getElementById('menu'),focused:true,openFile};
function Fixture(){
 const [provider,setProvider]=useState('shell');
 window.qaSetTerminalProvider=setProvider;
 const session={id:'terminal-'+provider,provider,mode:'terminal',status:provider==='shell'?'exited':'running',readOnly:provider==='shell',title:'Terminal',cols:45,rows:12,createdAt:'now',updatedAt:'now'};
 return <I18nProvider locale="en-US"><SessionSurfaceContext.Provider value={presentation}><div className="panels"><ChatView session={chat}/><TerminalSurface key={provider} sessionId={session.id} provider={provider} theme="light" terminalCompatibility={{}} session={session}/></div></SessionSurfaceContext.Provider></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
createRoot(document.getElementById('no-context')).render(<FileLinkedMarkdown sanitizedHtml={'<a href="src/other.ts:7">details</a> and <a href="https://example.com">web</a>'}/>);
`;
await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
await writeFile(join(scratch,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body,#root{height:100%;margin:0}.panels{display:grid;grid-template-columns:1fr 1fr;height:100%}.panels>*{min-width:0;min-height:0}#no-context{display:none}</style><div id="primary"></div><div id="menu"></div><div id="root"></div><div id="no-context"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1300,height:800,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);
let app;
try {
 app=await electron.launch({args:[join(scratch,'main.cjs')]});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.locator('.codex-markdown .file-reference-link').first().waitFor();
 assert.equal(await page.locator('#no-context a[href="src/other.ts:7"]').count(),0,'local markdown target is inert without an app opener');
 assert.equal(await page.locator('#no-context a[href="https://example.com"]').count(),1,'HTTP links keep their normal policy');
 assert.equal(await page.locator('.chat-view > header').count(),0,'redundant Chat header removed');
 assert.equal(await page.locator('.terminal-wrap .term-head,.terminal-wrap .v3-session-controls').count(),0,'redundant terminal rows removed');
 await page.locator('.codex-markdown .file-reference-link').first().click();
 await page.locator('.codex-tool-disclosure summary').click();
 assert.equal(await page.locator('.codex-tool-disclosure .file-reference-chips .file-reference-link').count(),3,'unsafe URI and control candidates are excluded, extensionless native path remains');
 await page.locator('.codex-tool-disclosure pre .file-reference-link').click();
 await page.locator('.codex-tool-disclosure .file-reference-chips .file-reference-link').first().click();
 await page.locator('.codex-tool-disclosure .file-reference-chips .file-reference-link').nth(1).click();
 await page.locator('.codex-tool-disclosure .file-reference-chips .file-reference-link').last().click();
 assert.deepEqual(await page.evaluate(()=>window.opened.slice(0,5)),[
  {path:'src/App.tsx',line:12},{path:'src/missing.ts',line:4},{path:'src/extra.ts',line:9},{path:'C:/repo/native.rs',line:11},{path:'image',line:5,column:3}
 ]);
 await page.waitForFunction(()=>window.term&&window.fileProvider);
 await page.evaluate(async()=>{await new Promise(resolve=>window.term.write('src/wrapped/path/to/a/very/long/nested/folder/file.ts:31',resolve));});
 const found=await page.evaluate(async()=>{
  const term=window.term;
  for(let y=1;y<=term.buffer.active.length;y++){
   const links=await new Promise(resolve=>window.fileProvider.provideLinks(y,resolve));
   const link=links?.find(item=>item.text.includes('file.ts:31'));
   if(link){link.activate(new MouseEvent('click'),link.text);link.activate(new MouseEvent('click',{ctrlKey:true}),link.text);return {range:link.range,text:link.text};}
  }
 });
 assert.ok(found,'rendered terminal cells yield a local file link');
 assert.ok(found.range.end.y>found.range.start.y,'file link spans a soft-wrapped terminal line');
 assert.deepEqual((await page.evaluate(()=>window.opened)).at(-1),{path:'src/wrapped/path/to/a/very/long/nested/folder/file.ts',line:31},'plain click ignored, modifier activation opens');
 const pointer=await page.evaluate(range=>{
  const term=window.term, screen=term.element.querySelector('.xterm-screen').getBoundingClientRect();
  return {x:screen.left+(range.start.x-.5)*screen.width/term.cols,y:screen.top+(range.start.y-term.buffer.active.viewportY-.5)*screen.height/term.rows};
 },found.range);
 await page.mouse.move(pointer.x,pointer.y);
 await page.waitForFunction(()=>window.hoveredFileLink?.text?.includes('file.ts:31'));
 const hovered=()=>page.evaluate(({x,y})=>({
  decorations:{pointerCursor:window.hoveredFileLink.decorations.pointerCursor,underline:window.hoveredFileLink.decorations.underline},
  cursor:getComputedStyle(document.elementFromPoint(x,y)).cursor,
 }),pointer);
 assert.deepEqual((await hovered()).decorations,{pointerCursor:false,underline:false},'ordinary hover keeps native selection cursor and no underline');
 const openedBefore=await page.evaluate(()=>window.opened.length);
 await page.mouse.click(pointer.x,pointer.y);
 assert.equal(await page.evaluate(()=>window.opened.length),openedBefore,'ordinary xterm click does not open a file');
 await page.keyboard.down('Control');
 await page.waitForFunction(()=>window.hoveredFileLink?.decorations?.pointerCursor&&window.hoveredFileLink?.decorations?.underline);
 assert.equal((await hovered()).cursor,'pointer','stationary Ctrl-hover exposes the actual pointer cursor');
 await page.mouse.click(pointer.x,pointer.y);
 assert.equal(await page.evaluate(()=>window.opened.length),openedBefore+1,'real Ctrl-click opens the hovered file once');
 await page.keyboard.up('Control');
 await page.waitForFunction(()=>window.hoveredFileLink?.decorations?.pointerCursor===false&&window.hoveredFileLink?.decorations?.underline===false);
 assert.notEqual((await hovered()).cursor,'pointer','releasing Ctrl clears hover feedback without mouse movement');
 await page.keyboard.down('Meta');
 await page.waitForFunction(()=>window.hoveredFileLink?.decorations?.pointerCursor===true);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 assert.deepEqual((await hovered()).decorations,{pointerCursor:false,underline:false},'window blur clears feedback even while a modifier is held');
  await page.keyboard.up('Meta');
  await page.mouse.move(1,1);
  const afterLeave=await hovered();
  assert.notEqual(afterLeave.decorations.pointerCursor,true,'leaving the terminal clears pointer feedback even if xterm disposes the link');
  assert.notEqual(afterLeave.decorations.underline,true,'leaving the terminal clears underline feedback even if xterm disposes the link');
  assert.notEqual(afterLeave.cursor,'pointer','leaving the terminal clears the actual cursor');
  // File links must use the entire rendered cell rectangle, rather than
  // xterm's unscaled mouse-coordinate estimate. Keep the candidate away from
  // the first column so scaling shifts are observable at its head, middle and
  // tail. CSS zoom and Electron page zoom are intentionally distinct paths.
  const zoomCandidate='          src/zoom/a.ts:37';
  const zoomRange=await page.evaluate(async text=>{
   const term=window.term; term.reset(); await new Promise(resolve=>term.write(text,resolve));
   for(let y=1;y<=term.buffer.active.length;y++){
    const links=await new Promise(resolve=>window.fileProvider.provideLinks(y,resolve));
    const found=links?.find(link=>link.text==='src/zoom/a.ts:37'); if(found)return found.range;
   }
   throw new Error('zoom hit-area link absent');
  },zoomCandidate);
  const hitLinkCells=async(label,scale)=>{
   await page.evaluate(value=>{document.documentElement.style.zoom=String(value);},scale);
   await page.waitForTimeout(50);
   const points=await page.evaluate(range=>{
    const term=window.term,screen=term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const row=range.start.y-term.buffer.active.viewportY-1;
    const columns=[range.start.x-.5,Math.floor((range.start.x+range.end.x)/2)-.5,range.end.x-.5];
    return columns.flatMap(column=>[.15,.85].map(rowPart=>({x:screen.left+column*screen.width/term.cols,y:screen.top+(row+rowPart)*screen.height/term.rows})));
   },zoomRange);
   const before=await page.evaluate(()=>window.opened.length);
   await page.keyboard.down('Control');
   const targets=await page.evaluate(items=>items.map(({x,y})=>{
    const element=document.elementFromPoint(x,y); const style=element&&getComputedStyle(element);
    return {className:element?.className,cursor:style?.cursor,background:style?.backgroundColor};
   }),points);
   assert.ok(targets.every(target=>target.className==='terminal-file-link-hit'&&target.cursor==='pointer'&&target.background!=='rgba(0, 0, 0, 0)'),`${label}: modifier feedback covers every tested cell`);
   if(label==='100% CSS zoom')await page.screenshot({path:join(out,'ctrl-hover.png')});
   for(const point of points)await page.mouse.click(point.x,point.y);
   await page.keyboard.up('Control');
   assert.equal(await page.evaluate(()=>window.opened.length),before+points.length,`${label}: Ctrl-click opens from head/middle/tail across each full cell height`);
   return points;
  };
  const animatedPoints=await hitLinkCells('100% CSS zoom',1);
  await hitLinkCells('125% CSS zoom',1.25);
  await hitLinkCells('150% CSS zoom',1.5);
  await page.evaluate(()=>{document.documentElement.style.zoom='1';});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await hitLinkCells('125% Electron zoom',1);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  // A modifier held when focus returns has no new keydown in this window. The
  // real mousemove must restore local-file feedback and activation.
  const reentryBefore=await page.evaluate(()=>window.opened.length);
  await page.keyboard.down('Control');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.mouse.move(animatedPoints[0].x,animatedPoints[0].y);
  await page.waitForFunction(point=>{
   const element=document.elementFromPoint(point.x,point.y);return element?.className==='terminal-file-link-hit'&&getComputedStyle(element).cursor==='pointer';
  },animatedPoints[0]);
  await page.mouse.click(animatedPoints[0].x,animatedPoints[0].y);
  await page.keyboard.up('Control');
  assert.equal(await page.evaluate(()=>window.opened.length),reentryBefore+1,'Ctrl held across blur restores the local-file hit target on terminal entry');
  // Retained session surfaces can be hidden and restored without a size change.
  // ResizeObserver must rebuild the modifier-only layer on the real screen.
  const restoreBefore=await page.evaluate(()=>window.opened.length);
  await page.keyboard.down('Control');
  await page.evaluate(()=>window.term.element.closest('.terminal-host').hidden=true);
  await page.waitForTimeout(30);
  await page.evaluate(()=>window.term.element.closest('.terminal-host').hidden=false);
  await page.waitForFunction(point=>document.elementFromPoint(point.x,point.y)?.className==='terminal-file-link-hit',animatedPoints[0]);
  await page.mouse.click(animatedPoints[0].x,animatedPoints[0].y);
  await page.keyboard.up('Control');
  assert.equal(await page.evaluate(()=>window.opened.length),restoreBefore+1,'restoring a same-sized hidden terminal rebuilds the Ctrl file hit target');
  const animatedPoint=animatedPoints[0];
  const animationBefore=await page.evaluate(()=>window.opened.length);
  await page.keyboard.down('Control');
  await page.mouse.move(animatedPoint.x,animatedPoint.y);
  await page.evaluate(point=>{window.pendingFileHit=document.elementFromPoint(point.x,point.y);},animatedPoint);
  await page.mouse.down(animatedPoint);
  await page.evaluate(async()=>{
   const term=window.term;
   for(let frame=0;frame<6;frame++)await new Promise(resolve=>term.write(`\x1b[12;1Hframe ${frame}                         `,resolve));
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(point=>window.pendingFileHit===document.elementFromPoint(point.x,point.y),animatedPoint),true,'terminal redraw keeps the Ctrl-click target node stable between mousedown and mouseup');
  await page.mouse.up();
  await page.keyboard.up('Control');
  assert.equal(await page.evaluate(()=>window.opened.length),animationBefore+1,'terminal redraw during Ctrl-click opens the file exactly once');
  const longWrapped=await page.evaluate(async()=>{
  const term=window.term;
  await new Promise(resolve=>term.write('\r\nsrc/'+('a'.repeat(term.cols*9))+'/end.rs',resolve));
  const buffer=term.buffer.active;
  let last=-1;
  for(let y=0;y<buffer.length;y++)if(buffer.getLine(y)?.translateToString(true).includes('end.rs'))last=y;
  if(last<0)throw new Error('long wrapped path not rendered');
  let first=last;
  while(first>0&&buffer.getLine(first)?.isWrapped)first--;
  let links=0;
  for(let y=first;y<=last;y++)links+=(await new Promise(resolve=>window.fileProvider.provideLinks(y+1,resolve)))?.length??0;
  return {physicalLines:last-first+1,links};
 });
 assert.ok(longWrapped.physicalLines>8,'fixture exceeds the bounded logical-line scan');
 assert.equal(longWrapped.links,0,'incomplete 8-line windows must not expose a truncated file path');
 const providerChecks=[];
 for(const provider of ['codex','claude','kimi','grok']){
  await page.evaluate(next=>{
   window.previousTerm=window.term;
   window.hoveredFileLink=undefined;
   window.fileProvider=undefined;
   window.qaSetTerminalProvider(next);
  },provider);
  await page.waitForFunction(()=>window.term&&window.term!==window.previousTerm&&window.fileProvider&&!window.term.options.disableStdin);
  const candidate=`src/${provider}.ts:8`;
  const range=await page.evaluate(async text=>{
   await new Promise(resolve=>window.term.write(text,resolve));
   for(let y=1;y<=window.term.buffer.active.length;y++){
    const links=await new Promise(resolve=>window.fileProvider.provideLinks(y,resolve));
    const found=links?.find(link=>link.text===text);
    if(found)return found.range;
   }
   throw new Error('provider terminal file link absent: '+text);
  },candidate);
  const cell=await page.evaluate(linkRange=>{
   const term=window.term,screen=term.element.querySelector('.xterm-screen').getBoundingClientRect();
   return {x:screen.left+(linkRange.start.x-.5)*screen.width/term.cols,y:screen.top+(linkRange.start.y-term.buffer.active.viewportY-.5)*screen.height/term.rows};
  },range);
  await page.mouse.move(cell.x,cell.y);
  await page.waitForFunction(text=>window.hoveredFileLink?.text===text,candidate);
  assert.equal(await page.evaluate(()=>window.hoveredFileLink.decorations.pointerCursor),false,`${provider}: ordinary hover does not capture input`);
  const before=await page.evaluate(()=>window.opened.length);
  await page.mouse.click(cell.x,cell.y);
  assert.equal(await page.evaluate(()=>window.opened.length),before,`${provider}: plain click does not navigate`);
  await page.locator('.terminal-host .xterm-helper-textarea').focus();
  await page.keyboard.down('Control');
  await page.waitForFunction(()=>window.hoveredFileLink?.decorations?.pointerCursor&&window.hoveredFileLink?.decorations?.underline);
  await page.mouse.click(cell.x,cell.y);
  assert.deepEqual((await page.evaluate(()=>window.opened)).at(-1),{path:`src/${provider}.ts`,line:8},`${provider}: real Ctrl-click retains native path and line`);
  await page.keyboard.up('Control');
  await page.waitForFunction(()=>window.hoveredFileLink?.decorations?.pointerCursor===false);
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),true,`${provider}: link hit button must not steal terminal focus`);
  await page.keyboard.type('q');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(id=>{
   const data=window.terminalRequests.filter(call=>call.method==='terminal.input'&&call.params.sessionId===id).map(call=>call.params.data);
   return data.includes('q')&&data.includes(String.fromCharCode(127));
  },`terminal-${provider}`);
  providerChecks.push({provider,link:candidate,input:'q/7f'});
 }
 assert.deepEqual(errors,[],'no renderer exceptions');
 await page.screenshot({path:join(out,'chat-terminal-links.png')});
 console.log(JSON.stringify({passed:true,scratch,out,found,longWrapped,providerChecks}));
} finally {await app?.close();}
