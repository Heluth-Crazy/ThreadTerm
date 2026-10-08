// Isolated visual regression for question cards. It bundles renderer components
// with an in-memory external-link bridge and never starts a runtime or provider.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-question-card-'));
const out = resolve('qa/results/question-card');
await mkdir(out, { recursive: true });
const entry = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { ChatApprovalCard } from './renderer/src/components/ChatApprovalCard';
import './renderer/src/styles.css';
const copy=(en,zh)=>window.qaLocale==='zh-CN'?zh:en; const answers=[]; const links=[];
window.threadterm={openExternal:async url=>links.push(url)};
const question=(data,status='pending')=>({type:'approval',approvalId:'q',status,data:{approvalId:'q',interaction:'question',answerable:true,...data}});
const common={subagent:{label:'Schema reviewer'}};
const cards={
 single:question({...common,form:{kind:'questions',questions:[{id:'color',header:'Choice',question:'Choose a color',options:[{label:'Blue',description:'A calm default'},{label:'Red',description:'A vivid option'}],multiSelect:false,allowOther:true,secret:false}]}}),
 multi:question({form:{kind:'questions',questions:[{id:'labels',header:'Labels',question:'Choose labels',options:[{label:'One',description:'Include the first group'},{label:'Two',description:'Include the second group'}],multiSelect:true,allowOther:true,secret:false},{id:'style',header:'Style',question:'Which style should we use?',options:[{label:'Compact'},{label:'Spacious'}],multiSelect:false,allowOther:false,secret:false}]}}),
 secret:question({form:{kind:'questions',questions:[{id:'token',question:'Enter the access token',options:[],multiSelect:false,allowOther:true,secret:true}]}}),
 form:question({form:{kind:'form',message:'Complete each field.',fields:[{id:'name',title:'Name',type:'string',required:true},{id:'count',title:'Count',type:'integer',required:true,minimum:1,maximum:5},{id:'ratio',title:'Ratio',type:'number',required:false},{id:'enabled',title:'Enabled',type:'boolean',required:true},{id:'tone',title:'Tone',type:'enum',required:true,options:[{value:'calm',label:'Calm'}]},{id:'tags',title:'Tags',type:'multiEnum',required:false,options:[{value:'a',label:'A'},{value:'b',label:'B'}]}]}}),
 url:question({form:{kind:'url',message:'Open the sign-in page, then continue.',url:'https://example.test/sign-in'}}),
 unsupported:question({answerable:false,form:{kind:'form',message:'This server requested an unsupported schema.',fields:[]}}),
 answered:question({form:{kind:'questions',questions:[{id:'secret',question:'Secret',options:[],multiSelect:false,allowOther:true,secret:true},{id:'name',question:'Name',options:[],multiSelect:false,allowOther:true,secret:false}]},answerSummary:{secret:'••••',name:'Ada'}},'resolved'),
 dismissed:question({form:{kind:'questions',questions:[{id:'choice',header:'Choice',question:'Choose a color',options:[],multiSelect:false,allowOther:true,secret:false}]}},'dismissed'),
};
const root=createRoot(document.getElementById('root')); window.qaRender=(name,locale='en',theme='light')=>{window.qaLocale=locale;document.documentElement.dataset.theme=theme;answers.length=0;root.render(<main className='chat-view v3-session-chat qa-card' data-scenario={name}><div className='chat-scroll v3-chat-log'><div className='v3-chat-message is-native is-codex assistant'><div className='chat-part approval v3-tool-card'><ChatApprovalCard key={name} part={cards[name]} writable={true} onChoose={()=>{}} onAnswer={answer=>answers.push(answer)} copy={copy}/></div></div></div></main>)};window.qaAnswers=()=>answers.slice();window.qaLinks=()=>links.slice();window.qaRender('single');
`;
await build({ stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'}, bundle:true, outfile:join(scratch,'qa.js'), jsx:'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'} });
await writeFile(join(scratch,'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>body{margin:0}#root{height:100vh}.qa-card{min-width:0}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1000,height:760,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
let app, page; const report={passed:false,scratch,checks:[],snapshots:[],errors:[]};
async function render(name, locale='en', theme='light'){await page.evaluate(([card,language,selectedTheme])=>window.qaRender(card,language,selectedTheme),[name,locale,theme]);await page.locator(`.qa-card[data-scenario="${name}"]`).waitFor({state:'attached'});await page.locator('.v3-chat-log').evaluate(node=>{node.scrollTop=0;});}
async function shot(name){const path=join(out,name);await page.screenshot({path,animations:'disabled'});report.snapshots.push(path);}
try {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path'));
 app=await electron.launch({args:[join(scratch,'main.cjs'),'--disable-gpu','--in-process-gpu','--no-sandbox'],env});page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.waitForFunction(()=>typeof window.qaRender==='function');
 await render('single'); assert.match(await page.locator('.chat-question-wrapper').textContent()??'',/Subagent.*Schema reviewer/); assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),true);assert.equal(await page.getByLabel('Other answer').count(),0);await page.getByRole('radio',{name:'Blue A calm default'}).check();await shot('01-single-wide-light.png');await page.getByRole('radio',{name:'Other',exact:true}).check();await page.getByLabel('Other answer').fill('Custom');assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),false);await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{color:['Custom']}}]);
 await render('multi');await page.getByRole('checkbox',{name:/One.*Include the first group/}).check();await page.getByRole('checkbox',{name:'Other',exact:true}).check();await page.getByLabel('Other answer').fill('Custom');await page.getByLabel('Compact').check();await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{labels:['One','Custom'],style:['Compact']}}]);await shot('02-multi-other-wide-light.png');
 await render('secret');assert.equal(await page.locator('input[type=password]').count(),1);await page.getByLabel('Enter the access token').fill('private');await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{token:['private']}}]);await shot('03-secret-wide-light.png');
 await render('form');assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),true);await page.getByLabel('Name').fill('Ada');await page.getByLabel('Count').fill('2');await page.getByLabel('Ratio').fill('1.5');await page.getByLabel('Ratio').fill('');await page.getByLabel('Tone').selectOption('calm');await page.getByRole('checkbox',{name:'A',exact:true}).check();await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{name:'Ada',count:2,enabled:false,tone:'calm',tags:['a']}}]);await shot('04-form-wide-light.png');
 await render('url');await page.getByRole('button',{name:'Open link'}).click();assert.deepEqual(await page.evaluate(()=>window.qaLinks()),['https://example.test/sign-in']);await page.getByRole('button',{name:'Done'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{}}]);await shot('05-url-wide-light.png');
 await render('unsupported');assert.equal(await page.getByRole('button',{name:'Submit'}).count(),0);await page.getByRole('button',{name:'Dismiss'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'dismiss'}]);await shot('06-unanswerable-wide-light.png');
 await render('multi');await page.getByRole('checkbox',{name:/One.*Include the first group/}).check();await page.getByRole('button',{name:'Dismiss'}).focus();await page.getByRole('button',{name:'Dismiss'}).press('Enter');assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'dismiss'}]);
 await render('answered');assert.match(await page.locator('.chat-question-summary').textContent()??'',/Secret: ••••.*Name: Ada/);await shot('07-answered-wide-light.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(420,760));await render('form','zh-CN','light');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await shot('08-form-narrow-zh-light.png');await render('multi','en','dark');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await shot('09-multi-narrow-dark.png');
 await render('single','en','dark');await page.getByRole('radio',{name:'Blue A calm default'}).check();await shot('10-single-narrow-dark.png');await render('dismissed','en','light');await shot('11-dismissed-narrow-light.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,760));await render('single','en','dark');await page.getByRole('radio',{name:'Red A vivid option'}).check();assert.ok(await page.locator('.chat-question-option').first().evaluate(node=>node.getBoundingClientRect().width)<=560);await shot('12-single-wide-dark.png');
 assert.deepEqual(report.errors,[]);report.checks.push('single, multi/other, secret, form field types, URL, unanswerable, answered summary, subagent chip, wide/narrow, light/dark');report.checks.push('exact submit and dismiss payloads captured by the isolated bridge');report.passed=true;
} catch(error) { report.error=error instanceof Error?error.stack:String(error);if(page)await page.screenshot({path:join(out,'failure.png'),animations:'disabled'}).catch(()=>undefined);process.exitCode=1; }
finally {await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');if(app)await app.close();console.log(`${report.passed?'QUESTION CARD VISUAL QA PASSED':'QUESTION CARD VISUAL QA FAILED'}; report: ${join(out,'report.json')}`);}
