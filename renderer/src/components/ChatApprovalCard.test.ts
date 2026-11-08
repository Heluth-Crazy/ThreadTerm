import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import type { ChatPart } from '@threadterm/protocol';
import { ChatApprovalCard } from './ChatApprovalCard';
import { EditBody } from './ToolCards';
import { approvalPreviewBudget } from '../toolCards';
import type { ToolEditFile } from '../toolView';

const copy = (en: string) => en;
function card(details: unknown, extra: Record<string, unknown> = {}) {
  const part: ChatPart = {type:'approval',approvalId:'edit',status:'pending',data:{
    approvalId:'edit',title:'Review edits',submittable:true,choices:[{choiceId:'allow',label:'Allow once',kind:'allow',scope:'once'}],details,...extra,
  }};
  return renderToStaticMarkup(createElement(ChatApprovalCard,{part,writable:true,onChoose:()=>{},copy}));
}
test('approval card clearly reports unavailable and huge incomplete edit previews', () => {
  assert.match(card({}, {previewUnavailableReason:'The edit exceeds the preview limit'}), /Preview unavailable/);
  const huge = Array.from({length:2050},(_,i)=>'+line '+i).join('\n');
  const html = card({changes:[{path:'huge.ts',kind:{type:'update'},diff:huge}]});
  assert.match(html, /Preview is incomplete for a large edit/);
  assert.ok((html.match(/class="tool-diff-line /g) ?? []).length <= 1200);
});
test('expanded approval rendering applies one total file and row budget', () => {
  const files: ToolEditFile[] = Array.from({length:100},(_,i)=>({path:`file-${i}.ts`,change:'modify',diff:{unified:Array.from({length:400},(_,j)=>'+line '+j).join('\n')}}));
  const budget = approvalPreviewBudget(files,true);
  const html = renderToStaticMarkup(createElement(EditBody,{view:{kind:'edit',files,status:'running',title:'Review edits'},copy,fileLimit:budget.files,rowLimits:budget.rows}));
  assert.ok((html.match(/class="tool-edit-file"/g) ?? []).length <= 12);
  assert.ok((html.match(/class="tool-diff-line /g) ?? []).length <= 1200);
  assert.ok(budget.omittedFiles > 0 && budget.omittedRows > 0);
});

test('a delegation widening card names the gap and offers only once-scoped choices', () => {
  const part: ChatPart = {type:'approval',approvalId:'delegation-authority-x',status:'pending',data:{
    approvalId:'delegation-authority-x',runtimeOwned:true,requestType:'threadterm.delegation.authority',interaction:'permission',submittable:true,
    title:'Start pi with full_access access',
    authorityRequest:{agent:'pi',parentAuthority:'ask_before_writes',childAuthority:'full_access'},
    choices:[{choiceId:'allow_once',label:'Allow once',kind:'allow',scope:'once'},{choiceId:'deny',label:'Deny',kind:'deny',scope:'once'}],
  }};
  const html = renderToStaticMarkup(createElement(ChatApprovalCard,{part,writable:true,onChoose:()=>{},copy}));
  assert.match(html, /@pi wants to start with Full access/);
  assert.match(html, /This chat is limited to Asks before writes/);
    assert.match(html, /Allow once/);
  assert.match(html, /Deny/);
});

// A 2.2.5 card carries the stored form policy; these assertions pin what the user can see and send.
const targetForm = {
  kind: "form" as const, message: "Deployment details", validation: { semantics: "opencode-v2" as const, patternAndFormat: "native" as const },
  fields: [
    { id: "hidden", type: "string" as const, title: "Hidden value", required: true, hidden: true, default: "H" },
    { id: "name", type: "string" as const, title: "Release name", required: true, placeholder: "e.g. Atlas" },
    { id: "mode", type: "multiselect" as const, title: "Regions", required: true, custom: true, options: [{ value: "eu", label: "Europe", description: "Frankfurt" }, { value: "us", label: "United States" }] },
    { id: "tone", type: "string" as const, title: "Tone", required: true, custom: true, options: [{ value: "calm", label: "Calm", description: "Quiet and low-key" }] },
    { id: "docs", type: "external" as const, title: "Read the runbook", url: "https://example.test/runbook" },
    { id: "window", type: "string" as const, title: "Window", when: [{ key: "name" as const, op: "eq" as const, value: "Atlas" }] },
  ],
};
function targetCard(extra: Record<string, unknown> = {}, status = 'pending') {
  const part: ChatPart = {type:'approval',approvalId:'v2-form',status:status as ChatPart['status'],data:{
    approvalId:'v2-form',interaction:'question',answerable:true,form:targetForm,...extra,
  }};
  return renderToStaticMarkup(createElement(ChatApprovalCard,{part,writable:true,onChoose:()=>{},onAnswer:()=>{},copy}));
}
test('a form with the stored policy renders choices, custom entry and external steps without jargon', () => {
  const html = targetCard();
  assert.match(html, /Europe/);
  assert.match(html, /Frankfurt/, 'option descriptions are shown');
  assert.match(html, /Quiet and low-key/);
  assert.match(html, /Open link/);
  assert.match(html, /I finished this step/, 'the acknowledgement is separate from Open');
  assert.match(html, /https:\/\/example.test\/runbook/);
  assert.match(html, /Other answer/);
  assert.doesNotMatch(html, /Hidden value|>H</, 'a hidden field is neither rendered nor summarized');
  assert.doesNotMatch(html, /Enter a value\./, 'a pristine form does not paint errors before an attempt');
  assert.doesNotMatch(html, /\b(native|policy|schema)\b/i, 'visible text never names the stored contract');
  assert.doesNotMatch(html, /Window/, 'a conditional field stays hidden until its earlier answer activates it');
  assert.match(html, /type="submit"/);
});
test('an answered policy card summarizes only the visible answers', () => {
  const html = targetCard({answerSummary:{hidden:'H',name:'Atlas',mode:'eu',docs:'true'}}, 'answered');
  assert.match(html, /Release name: Atlas/);
  assert.doesNotMatch(html, /Hidden value|>H</);
  assert.match(html, /Read the runbook/);
});
test('a legacy form card keeps its own markup', () => {
  const part: ChatPart = {type:'approval',approvalId:'legacy',status:'pending',data:{
    approvalId:'legacy',interaction:'question',answerable:true,
    form:{kind:'form',message:'Complete each field.',fields:[{id:'tone',title:'Tone',type:'enum',required:true,options:[{value:'calm',label:'Calm'}]},{id:'tags',title:'Tags',type:'multiEnum',required:false,options:[{value:'a',label:'A'}]}]},
  }};
  const html = renderToStaticMarkup(createElement(ChatApprovalCard,{part,writable:true,onChoose:()=>{},onAnswer:()=>{},copy}));
  assert.match(html, /<select/, 'the legacy enum stays a select');
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /Open link|I finished this step/);
});
