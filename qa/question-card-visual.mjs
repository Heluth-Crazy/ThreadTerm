// Isolated visual regression for question cards. It bundles renderer components
// with an in-memory external-link bridge and never starts a runtime or provider.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-question-card-'));
const out = resolve('qa/results/chat-parity/D1/question-card');
await mkdir(out, { recursive: true });
// Target forms come from the captured 2.2.5 native Info fixture mapped exactly like the adapter's
// canonical_from_info (native key becomes the field id; every other declared property is kept).
const nativeRows = JSON.parse(readFileSync(resolve('runtime/tests/fixtures/opencode-v2-native-form-info.json'), 'utf8'));
const canonical = native => ({ kind: 'form', message: native.title, validation: { semantics: 'opencode-v2', patternAndFormat: 'native' }, fields: native.fields.map(({ key, ...rest }) => ({ id: key, ...rest })) });
const v2forms = Object.fromEntries(nativeRows.forms.map(row => [row.case, canonical(row.native)]));
const v2expected = Object.fromEntries(nativeRows.forms.map(row => [row.case, { validAnswer: row.validAnswer, summary: row.summary }]));
// A stress case the captured forms do not cover: long labels, long custom values and two external steps.
const v2stress = { kind: 'form', message: 'Production deployment checklist for the November release window', validation: { semantics: 'opencode-v2', patternAndFormat: 'native' }, fields: [
 { id: 'release', type: 'string', title: 'Release name for the production deployment window', description: 'Use the exact tag that was signed off, for example 2026.11.1.', required: true, minLength: 4 },
 { id: 'regions', type: 'multiselect', title: 'Regions to deploy this release to (choose every one you need)', description: 'Each selected region is rolled out one at a time.', custom: true, minItems: 1, options: [{ value: 'eu-central-1', label: 'Europe (Frankfurt) eu-central-1', description: 'Lowest latency for European customers' }, { value: 'us-east-1', label: 'United States (N. Virginia) us-east-1', description: 'Primary region for North American customers' }] },
 { id: 'confirm-ticket', type: 'external', title: 'Confirm the maintenance ticket is approved', description: 'Open the ticket, then come back and confirm it.', url: 'https://example.test/tickets/MNT-2041' },
 { id: 'confirm-rollback', type: 'external', title: 'Confirm the rollback plan was reviewed', description: 'Opening this page is not enough; confirm after reading it.', url: 'https://example.test/runbooks/rollback' },
] };
const entry = `
const v2forms=${JSON.stringify(v2forms)}; const v2stress=${JSON.stringify(v2stress)};
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
 v2form:question({form:v2forms.all_field_types}),
 v2edge:question({form:v2forms.hidden_zero_empty_custom}),
 v2stress:question({form:v2stress}),
 v2answered:question({form:v2forms.all_field_types,answerSummary:{name:'ABC',count:'2',enabled:'false',mode:'red',external:'true'}},'answered'),
 answered:question({form:{kind:'questions',questions:[{id:'secret',question:'Secret',options:[],multiSelect:false,allowOther:true,secret:true},{id:'name',question:'Name',options:[],multiSelect:false,allowOther:true,secret:false}]},answerSummary:{secret:'••••',name:'Ada'}},'resolved'),
 dismissed:question({form:{kind:'questions',questions:[{id:'choice',header:'Choice',question:'Choose a color',options:[],multiSelect:false,allowOther:true,secret:false}]}},'dismissed'),
};
const root=createRoot(document.getElementById('root')); window.qaRender=(name,locale='en',theme='light')=>{window.qaLocale=locale;document.documentElement.dataset.theme=theme;answers.length=0;links.length=0;root.render(<main className='chat-view v3-session-chat qa-card' data-scenario={name}><div className='chat-scroll v3-chat-log'><div className='v3-chat-message is-native is-codex assistant'><div className='chat-part approval v3-tool-card'><ChatApprovalCard key={name} part={cards[name]} writable={true} onChoose={()=>{}} onAnswer={answer=>answers.push(answer)} copy={copy}/></div></div></div></main>)};window.qaAnswers=()=>answers.slice();window.qaLinks=()=>links.slice();window.qaRender('single');
`;
await build({ stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'}, bundle:true, outfile:join(scratch,'qa.js'), jsx:'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'} });
await writeFile(join(scratch,'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>body{margin:0}#root{height:100vh}.qa-card{min-width:0}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch,'profile-lane2'))});app.whenReady().then(()=>{const win=new BrowserWindow({title:'ThreadTerm Lane 2 — Question card QA',width:1000,height:760,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
let app, page; const report={passed:false,scratch,checks:[],snapshots:[],errors:[]};
async function render(name, locale='en', theme='light'){await page.evaluate(([card,language,selectedTheme])=>window.qaRender(card,language,selectedTheme),[name,locale,theme]);await page.locator(`.qa-card[data-scenario="${name}"]`).waitFor({state:'attached'});await page.locator('.v3-chat-log').evaluate(node=>{node.scrollTop=0;});}
async function shot(name){assertNoControlViolations(await checkControlConsistency(page, '.chat-question-wrapper'),name);const path=join(out,name);await page.screenshot({path,animations:'disabled'});report.snapshots.push(path);}
try {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path'));
 app=await electron.launch({args:[join(scratch,'main.cjs'),'--disable-gpu','--in-process-gpu','--no-sandbox'],env});page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.waitForFunction(()=>typeof window.qaRender==='function');
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__lane2Clipboard=value;},readText:async()=>window.__lane2Clipboard??''}}));
 await render('single'); assert.match(await page.locator('.chat-question-wrapper').textContent()??'',/Subagent.*Schema reviewer/); assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),true);assert.equal(await page.getByLabel('Other answer').count(),0);assertNoControlViolations(await checkControlConsistency(page, '.chat-question-wrapper'), 'question card');await page.getByRole('radio',{name:'Blue A calm default'}).check();await shot('01-single-wide-light.png');await page.getByRole('radio',{name:'Other',exact:true}).check();await page.getByLabel('Other answer').fill('Custom');assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),false);await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{color:['Custom']}}]);
 await render('multi');await page.getByRole('checkbox',{name:/One.*Include the first group/}).check();await page.getByRole('checkbox',{name:'Other',exact:true}).check();await page.getByLabel('Other answer').fill('Custom');await page.getByLabel('Compact').check();await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{labels:['One','Custom'],style:['Compact']}}]);await shot('02-multi-other-wide-light.png');
 await render('secret');assert.equal(await page.locator('input[type=password]').count(),1);await page.getByLabel('Enter the access token').fill('private');await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{token:['private']}}]);await shot('03-secret-wide-light.png');
 await render('form');assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),true);await page.getByLabel('Name').fill('Ada');await page.getByLabel('Count').fill('2');await page.getByLabel('Ratio').fill('1.5');await page.getByLabel('Ratio').fill('');await page.getByLabel('Tone').selectOption('calm');await page.getByRole('checkbox',{name:'A',exact:true}).check();await page.getByRole('button',{name:'Submit'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{name:'Ada',count:2,enabled:false,tone:'calm',tags:['a']}}]);await shot('04-form-wide-light.png');
 await render('url');await page.getByRole('button',{name:'Open link'}).click();assert.deepEqual(await page.evaluate(()=>window.qaLinks()),['https://example.test/sign-in']);await page.getByRole('button',{name:'Done'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{}}]);await shot('05-url-wide-light.png');
 await render('unsupported');assert.equal(await page.getByRole('button',{name:'Submit'}).count(),0);await page.getByRole('button',{name:'Dismiss'}).click();assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'dismiss'}]);await shot('06-unanswerable-wide-light.png');
 await render('multi');await page.getByRole('checkbox',{name:/One.*Include the first group/}).check();for(let tab=0;tab<30&&!(await page.getByRole('button',{name:'Dismiss'}).evaluate(node=>node===document.activeElement));tab++)await page.keyboard.press('Tab');await page.getByRole('button',{name:'Dismiss'}).press('Enter');assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'dismiss'}]);
 await render('answered');assert.match(await page.locator('.chat-question-summary').textContent()??'',/Secret: ••••.*Name: Ada/);await shot('07-answered-wide-light.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(420,760));await render('form','zh-CN','light');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await shot('08-form-narrow-zh-light.png');await render('multi','en','dark');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);await shot('09-multi-narrow-dark.png');
 await render('single','en','dark');await page.getByRole('radio',{name:'Blue A calm default'}).check();await shot('10-single-narrow-dark.png');await render('dismissed','en','light');await shot('11-dismissed-narrow-light.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,760));await render('single','en','dark');await page.getByRole('radio',{name:'Red A vivid option'}).check();assert.ok(await page.locator('.chat-question-option').first().evaluate(node=>node.getBoundingClientRect().width)<=560);await shot('12-single-wide-dark.png');
 // ---- P3b: target-policy (2.2.5) forms ------------------------------------------------------------------
 const fieldOf=id=>page.locator('[data-field-id="'+id+'"]');
 const focusedField=()=>page.evaluate(()=>document.activeElement?.closest('[data-field-id]')?.getAttribute('data-field-id'));
 await render('v2form');
 assert.equal(await page.locator('.chat-question-errors').count(),0,'a pristine form paints no errors');
 assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),false,'Submit stays clickable so its problems can be announced');
 await page.getByRole('button',{name:'Submit'}).click();
 assert.equal(await page.locator('.chat-question-errors').count(),1);
 await page.waitForFunction(()=>document.activeElement?.className.includes('chat-question-errors'));
 assert.ok(await page.locator('.chat-question-error').count()>=3,'each identifiable field carries its own message');
 assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[],'an invalid submit sends nothing');
 await shot('13-v2-errors-wide-light.png');
 await page.locator('.chat-question-error-link').first().click();
 assert.equal(await focusedField(),'name','the summary link moves focus to its field');
 await page.getByLabel('Name').fill('AB');
 assert.match(await fieldOf('name').locator('.chat-question-error').textContent(),/at least 3/);
 await page.getByLabel('Name').fill('ABC');
 await page.getByLabel('Count').fill('2');
 await page.getByRole('checkbox',{name:/Red/}).check();
 assert.equal(await page.getByLabel('conditional').count(),0,'a conditional field stays hidden while earlier answers keep it inactive');
 await page.getByRole('button',{name:'Open link'}).click();
 assert.deepEqual(await page.evaluate(()=>window.qaLinks()),['https://example.invalid/p0']);
 assert.equal(await page.getByRole('checkbox',{name:/I finished this step/}).isChecked(),false,'opening alone never acknowledges the step');
 await page.getByRole('button',{name:'Submit'}).click();
 assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[],'an unacknowledged external step blocks the answer');
 assert.match(await page.locator('.chat-question-errors').textContent(),/Confirm/);
 await page.getByRole('checkbox',{name:/I finished this step/}).check();
 await page.getByRole('checkbox',{name:'enabled'}).check();
 assert.equal(await page.getByLabel('conditional').count(),1,'the earlier answer activates its dependant');
 await page.getByLabel('conditional').fill('shown');
 await page.getByRole('checkbox',{name:'enabled'}).uncheck();
 assert.equal(await page.getByLabel('conditional').count(),0,'the inactive field disappears');
 assert.equal(await focusedField(),'enabled','focus returns to the field that controls it');
 await page.getByRole('checkbox',{name:'enabled'}).check();
 assert.equal(await page.getByLabel('conditional').inputValue(),'shown','the in-memory draft comes back on reactivation');
 await shot('14-v2-filled-wide-light.png');
 await page.getByRole('button',{name:'Submit'}).click();
 assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{name:'ABC',count:2,enabled:true,mode:['red'],external:true,conditional:'shown'}}]);
 await render('v2edge');
 assert.equal(await page.getByText('Hidden value').count(),0,'a hidden field is not rendered');
 assert.equal(await page.getByLabel('zero').inputValue(),'0','a declared zero default survives');
 assert.equal(await fieldOf('empty').locator('input').inputValue(),'','a declared empty default survives');
 await page.getByRole('radio',{name:'Other',exact:true}).check();
 await page.getByLabel('Other answer').first().fill('自定义的多字节值 with a long custom tail');
 await page.getByRole('checkbox',{name:/^X/}).check();
 await fieldOf('many').locator('input[type=text]').fill('custom-many');
 await page.getByRole('button',{name:'Submit'}).click();
 assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{hidden:'H',zero:0,empty:'',custom:'自定义的多字节值 with a long custom tail',many:['x','custom-many']}}]);
 await shot('15-v2-edge-wide-light.png');
 await render('v2answered');
 assert.match(await page.locator('.chat-question-summary').textContent()??'',/Name: ABC/);
 assert.doesNotMatch(await page.locator('.chat-question-summary').textContent()??'',/H/, 'no hidden answer is summarized');
 await shot('16-v2-answered-wide-light.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(420,760));
 await render('v2stress','zh-CN','light');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
 assert.match(await page.locator('.chat-question-wrapper').textContent()??'',/打开链接/,'localized external action');
 await shot('17-v2-stress-narrow-zh-light.png');
 await render('v2stress','en','dark');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
 assert.deepEqual(await page.getByRole('button',{name:'Open link'}).count(),2,'each external step has its own Open action');
 await page.getByLabel('Release name for the production deployment window').fill('2026.11.1');
 await page.getByRole('checkbox',{name:/Europe \(Frankfurt\)/}).check();
 for(const open of await page.getByRole('button',{name:'Open link'}).all())await open.click();
 assert.deepEqual(await page.evaluate(()=>window.qaLinks()),['https://example.test/tickets/MNT-2041','https://example.test/runbooks/rollback']);
 assert.equal(await page.getByRole('checkbox',{name:/I finished this step/}).first().isChecked(),false,'opening both steps acknowledges neither');
 for(const box of await page.getByRole('checkbox',{name:/I finished this step/}).all())await box.check();
 await shot('18-v2-stress-narrow-dark.png');
 await page.getByRole('button',{name:'Submit'}).click();
 assert.deepEqual(await page.evaluate(()=>window.qaAnswers()),[{action:'submit',values:{release:'2026.11.1',regions:['eu-central-1'],'confirm-ticket':true,'confirm-rollback':true}}]);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,760));
 await render('v2form','zh-CN','dark');
 await page.getByRole('button',{name:'提交'}).click();
 await shot('19-v2-errors-wide-zh-dark.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(420,760));
 await render('v2form','en','light');
 await page.getByRole('button',{name:'Submit'}).click();
 await shot('20-v2-errors-narrow-light.png');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,760));
 assert.deepEqual(report.errors,[]);report.checks.push('single, multi/other, secret, form field types, URL, unanswerable, answered summary, subagent chip, wide/narrow, light/dark');report.checks.push('exact submit and dismiss payloads captured by the isolated bridge');report.checks.push('target-policy forms from the captured native fixture: active-field cascade with draft restore, custom single/multi values, option descriptions, two external steps with Open plus separate acknowledgement, hidden/zero/empty defaults, error summary with focus links, keyboard-only submit, English/Chinese, light/dark, wide/420 px');report.passed=true;
} catch(error) { report.error=error instanceof Error?error.stack:String(error);if(page)await page.screenshot({path:join(out,'failure.png'),animations:'disabled'}).catch(()=>undefined);process.exitCode=1; }
finally {await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');if(app)await app.close();console.log(`${report.passed?'QUESTION CARD VISUAL QA PASSED':'QUESTION CARD VISUAL QA FAILED'}; report: ${join(out,'report.json')}`);}
