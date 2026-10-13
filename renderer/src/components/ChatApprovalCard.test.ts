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
