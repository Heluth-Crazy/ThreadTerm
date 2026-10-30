import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis,{require:createRequire(import.meta.url)});
const {renderToStaticMarkup}=await import('react-dom/server');
import type { RunProposal } from '@threadterm/protocol';
import { RunProposalReview } from './RunProposalReview';
import { RunProposals } from './RunProposals';

const proposal:RunProposal={id:'p',projectId:'project',root:'C:/repo',sessionId:'chat',name:'Review',command:'node app.mjs',shell:'powershell',cwd:'scripts',kind:'task',env:[{name:'NODE_OPTIONS',value:'--require=./payload.cjs'}],previewUrl:'http://localhost:4317/',reason:'Why',state:'pending',createdAt:'2026-10-30T00:00:00Z'};

test('shared row/dialog review always renders all executable fields, including NODE_OPTIONS',()=>{
 const html=renderToStaticMarkup(createElement(RunProposalReview,{proposal,zh:false}));
 for(const text of ['node app.mjs','Windows PowerShell','scripts','Task','NODE_OPTIONS','--require=./payload.cjs','http://localhost:4317/'])assert.ok(html.includes(text),text);
 assert.match(html,/data-testid="proposal-review"/);
 assert.ok(!html.includes('<details'),'execution review cannot be hidden in Advanced');
});

test('legacy pending row and shared accept review show invisible characters visibly in every field',()=>{
 const legacy={...proposal,name:'Name\u200B',command:'node app\u202E.mjs',reason:'Why\u2066',cwd:'app\u200B',env:[{name:'NODE_OPTIONS\u200B',value:'--require=./payload\u202E.cjs'}],previewUrl:'http://localhost/\u2028'};
 const source=JSON.stringify(legacy);
 const review=renderToStaticMarkup(createElement(RunProposalReview,{proposal:legacy,zh:false}));
 const row=renderToStaticMarkup(createElement(RunProposals,{proposals:[legacy],sessions:[],zh:false,busy:false,onAccept(){},onReject(){},onOpenChat(){}}));
 for(const html of [review,row]){assert.ok(!/[\p{Cf}\u2028\u2029]/u.test(html));assert.ok(html.includes('⟨U+200B⟩'));assert.ok(html.includes('⟨U+202E⟩'));}
 assert.ok(row.includes('Why⟨U+2066⟩'));
 assert.equal(JSON.stringify(legacy),source);
});
