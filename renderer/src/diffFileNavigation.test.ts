import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentRef, GitChange, PaneLayout } from '@threadterm/protocol';
import { diffFilePosition, gitDiffFiles, retargetDiffFile } from './diffFileNavigation';

test('file navigation handles boundaries, empty/single lists and disappeared files without wrapping',()=>{
 assert.deepEqual(diffFilePosition(['a','b','c'],'b'),{position:2,total:3,previous:'a',next:'c'});
 assert.equal(diffFilePosition(['a','b'],'a').previous,undefined);
 assert.equal(diffFilePosition(['a','b'],'b').next,undefined);
 for(const paths of [[],['a'],['b','c']]) {
  const value=diffFilePosition(paths,'missing');
  assert.equal(value.position,0);assert.equal(value.previous,undefined);assert.equal(value.next,undefined);
 }
 assert.deepEqual(diffFilePosition(['a'],'a'),{position:1,total:1,previous:undefined,next:undefined});
});

test('Git diff selects the staged group or changed plus untracked, excluding conflicts',()=>{
 const change=(path:string,indexStatus:string,worktreeStatus:string,untracked=false):GitChange=>({path,indexStatus,worktreeStatus,untracked});
 const changes=[change('staged','A',' '),change('both','M','M'),change('unstaged',' ','D'),change('new','?','?',true),change('conflict','U','U'),change('clean',' ',' ')];
 assert.deepEqual(gitDiffFiles(changes,true),['staged','both']);
 assert.deepEqual(gitDiffFiles(changes,false),['both','unstaged','new']);
 assert.deepEqual(gitDiffFiles([],false),[]);
});

for(const kind of ['review','diff'] as const) test(`${kind} retarget preserves the same tab, owner, pane and unrelated layout`,()=>{
 const tab:Extract<ContentRef,{path:string}>=kind==='review'
  ?{id:'view',kind,projectId:'p',path:'a',sessionId:'s',checkpointId:'from',toCheckpointId:'to'}
  :{id:'view',kind,projectId:'p',path:'a',ownerSessionId:'owner',staged:true};
 const pane:PaneLayout={kind:'pane',id:'pane',tabs:[tab],activeTabId:'view'};
 const other:PaneLayout={kind:'pane',id:'other',tabs:[],activeTabId:null};
 const layout:PaneLayout={kind:'split',id:'split',direction:'horizontal',ratio:0.5,first:pane,second:other};
 const next=retargetDiffFile(layout,'pane',tab,'b');
 assert.equal(next.kind,'split');if(next.kind!=='split'||next.first.kind!=='pane')throw Error('missing pane');
 assert.equal(next.second,other);assert.equal(next.first.activeTabId,'view');assert.equal(next.first.tabs.length,1);
 assert.deepEqual(next.first.tabs[0],{...tab,path:'b'});
 assert.equal(retargetDiffFile(layout,'missing',tab,'b'),layout);
 assert.equal(retargetDiffFile(layout,'pane',{...tab},'b'),layout);
 assert.equal(retargetDiffFile(next,'pane',tab,'c'),next);
});
