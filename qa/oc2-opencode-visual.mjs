// Desktop-1 component visual. No runtime or provider process is launched.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {electron} from './lib/desktop1.mjs';
import {oc2VisualEntry} from './oc2-opencode-visual-fixture.mjs';
import {assertNoControlViolations,checkControlConsistency} from './lib/visual-consistency.mjs';
const root=resolve('.'),scratch=await mkdtemp(join(resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir()), 'oc2-visual-')),out=join(scratch,'captures');
const report={passed:false,scratch,checks:[],cells:['light','dark','custom'].flatMap(theme=>[1280,400].map(width=>({theme,width,status:'pending',step:'not started',controls:[]}))),errors:[]};let app,page,current;
const step=label=>{report.stage=label;if(current)current.step=label;console.log(`[OC2 visual] ${current?`${current.theme}/${current.width} `:''}${label}`);};
try{
 step('build isolated component fixture');
 await mkdir(out);await writeFile(join(scratch,'fixture.tsx'),oc2VisualEntry());
 await build({stdin:{contents:oc2VisualEntry(),resolveDir:root,loader:'tsx'},bundle:true,outfile:join(scratch,'qa.js'),jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},logLevel:'error'});
 await writeFile(join(scratch,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>body{margin:0}#root{height:100vh;display:flex;justify-content:center}.qa-pane{height:100%;min-width:0;display:flex;flex-direction:column}</style><div id="root"></div><script src="qa.js"></script>');
 await writeFile(join(scratch,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>new BrowserWindow({title:'ThreadTerm OC2 visual',show:false,width:1480,height:1040,webPreferences:{sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch,'index.html'))}));`);
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path')),Path:[dirname(process.execPath),join(process.env.SystemRoot||'C:\\Windows','System32')].join(';')};
 step('launch on Desktop 1');app=await electron.launch({args:[join(scratch,'main.cjs')],env});page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));
 step('wait for fixture bridge');await page.waitForFunction(()=>typeof window.qaRender==='function');
 for(const cell of report.cells){
  current=cell;cell.status='running';const{theme,width}=cell;step('render and hydrate');
  const renderId=await page.evaluate(args=>window.qaRender(args),{theme,width});
  const scope=page.locator(`.qa-pane[data-render="${renderId}"]`),composer=scope.locator('.chat-compose-shell textarea');
  await scope.locator('.chat-question-wrapper').waitFor();await composer.waitFor();step('wait for composer control and connection');await page.waitForFunction(()=>!document.querySelector('.chat-compose-shell textarea')?.disabled);
  step('verify compact receipt, recovered question, and image badge');
  assert.match(await scope.locator('.v3-chat-log').innerText(),/Conversation compacted by OpenCode\./);assert.equal(await scope.locator('.codex-status-card').count(),0);
  assert.equal(await scope.locator('.chat-question-wrapper').count(),1);assert.equal(await page.evaluate(()=>window.qaAttach()),1);await scope.locator('.chat-image-draft img').waitFor();
  step('native palette descriptions and keyboard selection');await composer.fill('/');await scope.getByRole('listbox',{name:'Commands'}).waitFor();
  assert.match(await scope.locator('.chat-slash').innerText(),/\/review.*Review the current changes/s);assert.match(await scope.locator('.chat-slash').innerText(),/\/compact.*Compact conversation/s);
  await composer.press('ArrowDown');await composer.press('Enter');assert.match(await composer.inputValue(),/^\/(?:review|compact)/);await composer.fill('/');
  step('measure Chat and check shared controls');
  const metrics=await scope.evaluate(node=>({pane:node.getBoundingClientRect().width,chat:node.querySelector('.v3-session-chat').getBoundingClientRect().width,overflow:node.scrollWidth-node.clientWidth}));Object.assign(cell,metrics);
  assert.ok(Math.abs(metrics.chat-width)<=1,`Chat itself is ${width}px: ${JSON.stringify(metrics)}`);assert.ok(metrics.overflow<=1);
  for(const selector of ['.chat-compose-bar','.chat-question-wrapper','.chat-slash']){const result=await checkControlConsistency(page,`.qa-pane ${selector}`);cell.controls.push({selector,result});assertNoControlViolations(result,`${theme}/${width} ${selector}`);assert.ok(result.checked>0,`${theme}/${width} ${selector}: no visible controls checked`);}
  step('capture verified palette, image, compact receipt, and recovered question');cell.screenshot=join(out,`${theme}-${width}.png`);await scope.screenshot({path:cell.screenshot,animations:'disabled'});
  step('answer the recovered question once');await composer.fill('');await scope.getByRole('radio',{name:'Continue Use the recovered plan'}).check();await scope.getByRole('button',{name:'Submit',exact:true}).click();
  await page.waitForFunction(()=>window.qaRequests().filter(row=>row.method==='chat.answer').length===1);
  const requests=await page.evaluate(()=>window.qaRequests()),answers=requests.filter(row=>row.method==='chat.answer');
  assert.deepEqual(answers[0].params.response,{action:'submit',values:{'question-0':['Continue']}});assert.equal(requests.some(row=>row.method==='chat.send'),false);
  cell.status='passed';step('passed');current=undefined;
 }
 step('verify complete matrix');assert.equal(report.cells.length,6);assert.ok(report.cells.every(cell=>cell.status==='passed'&&cell.screenshot&&cell.controls.length===3));
 assert.deepEqual(report.errors,[]);report.checks.push('six light/dark/custom × wide/measured-400px cells; native palette descriptions and keyboard selection; production image badge; compact receipt; actionable recovered question; shared control consistency');report.passed=true;
}catch(error){
 report.error=error instanceof Error?error.stack:String(error);report.errors.push(`${report.stage}: ${report.error}`);process.exitCode=1;if(current){current.status='failed';current.error=report.error;}
 if(page){report.observed=await page.evaluate(()=>({composer:{disabled:document.querySelector('.chat-compose-shell textarea')?.disabled},text:document.body.innerText,requests:window.qaRequests?.().slice(-30)})).catch(error=>({error:String(error)}));await page.screenshot({path:join(out,'failure.png')}).catch(()=>undefined);}
 console.error(`[OC2 visual] failed at ${report.stage}: ${report.error}`);
}finally{
 for(const cell of report.cells)if(cell.status==='pending')cell.status='skipped';
 try{await app?.close();}catch(error){report.passed=false;report.errors.push(`cleanup: ${String(error)}`);process.exitCode=1;}
 await writeFile(join(scratch,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(`${report.passed?'PASS':'FAIL'} OC2 visual: ${join(scratch,'report.json')}`);
}
