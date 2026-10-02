import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleSessions,pinnedSessions,nextSessionId } from './src/navigation.ts';
const sessions=[
 {id:'a',title:'Alpha',provider:'codex',mode:'terminal',status:'running',createdAt:'2026-01-01',updatedAt:'2026-01-03',followed:true},
 {id:'b',title:'Beta',provider:'kimi',mode:'chat',status:'exited',createdAt:'2026-01-01',updatedAt:'2026-01-02',bookmarked:true},
 {id:'c',title:'Archived',provider:'claude',mode:'terminal',status:'exited',createdAt:'2026-01-01',updatedAt:'2026-01-04',archived:true,pinned:true},
 ...Array.from({length:7},(_,index)=>({id:`p${index}`,title:`Pinned ${index}`,provider:'codex',mode:'terminal',status:'idle',createdAt:'2026-01-01',updatedAt:`2026-01-0${index+1}`,pinned:true,sortOrder:index})),
];
test('filters scopes and text before sorting',()=>{assert.deepEqual(visibleSessions(sessions,'alpha','active','title').map(s=>s.id),['a']);assert.deepEqual(visibleSessions(sessions,'','followed','updated').map(s=>s.id),['a']);assert.deepEqual(visibleSessions(sessions,'','recent','updated',['b']).map(s=>s.id),['b']);});
test('wraps session navigation',()=>{assert.equal(nextSessionId(sessions.slice(0,2),'a',-1),'b');assert.equal(nextSessionId(sessions.slice(0,2),'b',1),'a');});


test('hides archived sessions from ordinary scopes but restores them in archive scope',()=>{
 assert.equal(visibleSessions(sessions,'','all','updated').some(s=>s.id==='c'),false);
 assert.deepEqual(visibleSessions(sessions,'','archived','updated').map(s=>s.id),['c']);
 assert.deepEqual(visibleSessions(sessions,'','bookmarked','updated').map(s=>s.id),['b']);
 assert.equal(pinnedSessions(sessions).length,6);
 assert.equal(pinnedSessions(sessions).some(s=>s.id==='c'),false);
});

