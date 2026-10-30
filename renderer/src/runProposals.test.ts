import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunProposal } from '@threadterm/protocol';
import { quickLaunchError } from './quickLaunch';
import { lineDiff, proposalDiff, proposalDraft, proposalReviewFields, recentRunLabel, type ProposalReview } from './runProposals';

const proposal = (overrides:Partial<RunProposal>={}) => ({id:'p1',projectId:'project',root:'C:/repo',sessionId:'chat',targetCommandId:'command',name:'Serve',command:'node server.mjs\n--port 3000',shell:'powershell',cwd:'apps/web',kind:'service',env:[{name:'PORT',value:'3000'}],previewUrl:'http://localhost:3000',reason:'Needed for preview',state:'pending',baseRevision:2,createdAt:'2026-10-30T00:00:00.000Z',target:{id:'command',projectId:'project',revision:2,name:'Dev',command:'node old.mjs',shell:'cmd',cwd:'',kind:'service',env:[],createdAt:'2026-10-29T00:00:00.000Z',updatedAt:'2026-10-29T00:00:00.000Z'},...overrides} satisfies RunProposal);

test('proposalDiff exposes every changed editable field and a complete command line diff',()=>{
 const diff=proposalDiff(proposal());
 assert.deepEqual(diff.map(item=>item.field),['Name','Command','Working directory','Shell','Environment: PORT','Preview address']);
 assert.deepEqual(diff.find(item=>item.field==='Command')?.command,[{kind:'removed',text:'node old.mjs [no EOL]'},{kind:'added',text:'node server.mjs [LF]'},{kind:'added',text:'--port 3000 [no EOL]'}]);
 assert.deepEqual(proposalDiff(proposal({target:undefined})),[],'new proposals show their full command instead of a diff');
});

test('lineDiff retains equal lines and recent labels include state, exit and relative age',()=>{
 assert.deepEqual(lineDiff('one\ntwo','one\nthree'),[{kind:'same',text:'one [LF]'},{kind:'removed',text:'two [no EOL]'},{kind:'added',text:'three [no EOL]'}]);
 assert.equal(recentRunLabel({state:'failed',exitCode:2,stopped:false,startedAt:'2026-10-30T00:00:00.000Z'},false,Date.parse('2026-10-30T00:05:00.000Z')),'Failed (exit 2) · 5m ago');
 assert.equal(recentRunLabel({state:'failed',exitCode:2,stopped:true,startedAt:'2026-10-30T00:00:00.000Z'},true,Date.parse('2026-10-30T00:00:30.000Z')),'已停止 · 刚刚');
});


test('proposal reviews disclose execution overrides and diffs identify each environment name',()=>{
 const input=proposal({env:[{name:'NODE_OPTIONS',value:'--require=./payload.cjs'},{name:'CHANGE',value:'after'},{name:'ADD',value:'added'}]});
 input.target.env=[{name:'CHANGE',value:'before'},{name:'REMOVE',value:'removed'}];
 const fields=proposalReviewFields(input);
 assert.deepEqual(fields.map(item=>item.field),['Name','Command','Shell','Working directory','Type','Environment: NODE_OPTIONS','Environment: CHANGE','Environment: ADD','Preview address']);
 assert.ok(fields.some(item=>item.field==='Environment: NODE_OPTIONS'&&item.text==='--require=./payload.cjs'));
 const env=proposalDiff(input).filter(item=>item.field.startsWith('Environment:'));
 assert.deepEqual(env.map(item=>[item.field,item.change,item.before,item.after]),[
  ['Environment: CHANGE','changed','CHANGE=before','CHANGE=after'],['Environment: REMOVE','removed','REMOVE=removed','—'],
  ['Environment: NODE_OPTIONS','added','—','NODE_OPTIONS=--require=./payload.cjs'],['Environment: ADD','added','—','ADD=added'],
 ]);
});

test('proposal review redacts inherited and replaced secret environment values',()=>{
 const input=proposal({env:[{name:'TOKEN',value:'replacement'}]});
 input.target.env=[{name:'TOKEN',secret:true,hasValue:true},{name:'UNCHANGED_SECRET',secret:true,hasValue:true}];
 const diff=proposalDiff(input).filter(item=>item.field.startsWith('Environment:'));
 assert.deepEqual(diff.map(item=>[item.field,item.before,item.after]),[
  ['Environment: TOKEN','TOKEN=secret','TOKEN=replacement'],
  ['Environment: UNCHANGED_SECRET','UNCHANGED_SECRET=secret','—'],
 ]);
 assert.doesNotMatch(JSON.stringify(diff),/undefined|hasValue/);
});

test('proposal draft retains returned secret metadata, honors explicit removal, and carries target dependencies',()=>{
 const target={...proposal().target!,dependsOn:['prepare']};
 const inherited={...proposal({target,dependsOn:['prepare','lint']}),env:[{name:'TOKEN',secret:true,value:'value-trap'}]} as unknown as ProposalReview;
 assert.deepEqual(proposalDraft(inherited),{name:'Serve',command:'node server.mjs\n--port 3000',shell:'powershell',cwd:'apps/web',kind:'service',env:[{name:'TOKEN',secret:true}],previewUrl:'http://localhost:3000',dependsOn:['prepare','lint']});
 assert.deepEqual(proposalDraft({...inherited,env:[]}),{...proposalDraft(inherited),env:[]},'an absent returned environment entry is an explicit removal');
 assert.deepEqual(proposalDraft({...inherited,env:[{name:'TOKEN',value:'replacement'}]}),{...proposalDraft(inherited),env:[{name:'TOKEN',value:'replacement'}]},'a plain proposal value replaces a secret only after the review');
});

test('proposal review and diff escape legacy invisible fields without changing saved bytes',()=>{
 const input=proposal({name:'Build\u202E',command:'.\\build\u200B.cmd',cwd:'app\u2066',env:[{name:'VAR\u200B',value:'--require=./payload\u202E.cjs'}],previewUrl:'http://localhost/\u2028'});
 input.target.command='node old\u2066.mjs';
 input.target.env=[{name:'OLD\u200B',value:'old\u202E'}];
 const before=JSON.stringify(input);
 const review=JSON.stringify(proposalReviewFields(input)),diff=JSON.stringify(proposalDiff(input));
 for(const text of [review,diff]) {
  assert.ok(!/[\p{Cf}\u2028\u2029]/u.test(text));
  assert.match(text,/⟨U\+200B⟩/); assert.match(text,/⟨U\+202E⟩/);
 }
 assert.equal(JSON.stringify(input),before,'display escaping must not rewrite command or environment values');
});

test('lineDiff compares exact terminators including CRLF to LF and a missing final newline',()=>{
 assert.deepEqual(lineDiff('one\r\ntwo','one\ntwo'),[
  {kind:'removed',text:'one [CRLF]'},{kind:'added',text:'one [LF]'},{kind:'same',text:'two [no EOL]'},
 ]);
 assert.deepEqual(lineDiff('one\n','one'),[{kind:'removed',text:'one [LF]'},{kind:'added',text:'one [no EOL]'}]);
 assert.deepEqual(lineDiff('one\rtwo','one\r\ntwo'),[{kind:'removed',text:'one [CR]'},{kind:'added',text:'one [CRLF]'},{kind:'same',text:'two [no EOL]'}]);
 assert.deepEqual(lineDiff('build.cmd','build\u200B.cmd'),[{kind:'removed',text:'build.cmd [no EOL]'},{kind:'added',text:'build⟨U+200B⟩.cmd [no EOL]'}]);
});


test('unprintable proposal errors have bilingual copy',()=>{
 assert.match(quickLaunchError('detected_command_unprintable',false),/invisible formatting or control characters/);
 assert.match(quickLaunchError('detected_command_unprintable',true),/不可见/);
});
