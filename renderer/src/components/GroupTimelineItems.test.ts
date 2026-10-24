import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
import type { GroupMessage } from '@threadterm/protocol';
import { ReplyOutputs } from './GroupReplyOutputs';
import type { GroupCopy } from './GroupStatus';

Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
const copy:GroupCopy=(en:string)=>en;
function render(outputs:NonNullable<GroupMessage['outputs']>, localCopy:GroupCopy=copy) {
  const message:GroupMessage={id:'reply',author:'member',sessionId:'member',handle:'codex',body:'Done.',outputs,createdAt:'now'};
  return renderToStaticMarkup(createElement(ReplyOutputs,{message,copy:localCopy,onOpenFile:()=>{},onOpenUrl:()=>{}}));
}

test('group reply outputs keep deleted files non-openable and describe editor overlap as you',()=>{
  const html=render({files:['removed.html'],urls:[],changed:['removed.html'],changedDetails:[{path:'removed.html',status:'deleted',evidence:'folder'}],possiblyChanged:['shared.css'],possiblyChangedWith:['you']});
  assert.match(html,/Changed while you were also working/);
  assert.match(html,/gc-output-deleted/);
  assert.doesNotMatch(html,/<button[^>]*data-output-path="removed\.html"/);
  assert.match(html,/found by comparing the folder before and after the turn/);
});

test('group reply outputs use workbench change rows and keep tool-only paths neutral',()=>{
  const html=render({files:[],urls:[],changed:['legacy.txt','tool-only.txt','added.txt','changed.txt'],changedDetails:[
    {path:'tool-only.txt',status:'changed',evidence:'tool'},
    {path:'added.txt',status:'added',evidence:'folder'},
    {path:'changed.txt',status:'modified',evidence:'folder'},
  ],possiblyChanged:['shared.css'],possiblyChangedWith:['claude']});
  assert.match(html,/wb-change-row tone-added/);
  assert.match(html,/wb-change-row tone-modified/);
  assert.match(html,/wb-deco[^>]*>A/);
  assert.match(html,/wb-deco[^>]*>M/);
  assert.match(html,/data-change-status="changed"/);
  assert.doesNotMatch(html,/data-change-status="changed"[^>]*tone-/);
  assert.match(html,/Reported by the agent&#x27;s file tool/);
  assert.match(html,/gc-possibly-list/);
  assert.match(html,/Possibly changed \(1\)/);
});

test('group reply output evidence tooltips are localized',()=>{
  const html=render({files:[],urls:[],changed:['tool-only.txt'],changedDetails:[{path:'tool-only.txt',status:'changed',evidence:'tool'}]},(_en, cn)=>cn);
  assert.match(html,/由 Agent 的文件工具报告/);
});
