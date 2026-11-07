import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionItems } from '../src/core/projection';
import { validateMobileRequest, mobileResult } from '../src/core/wire';

const now='2026-11-06T00:00:00.000Z';
const session={id:'same',title:'Needs approval',provider:'codex',mode:'chat',status:'waiting',createdAt:now,updatedAt:now,activity:{state:'awaiting_approval',revision:1}};
const machine=(id:string)=>({id,name:id,color:'#123',transport:'tls',endpoint:'x',tlsFingerprint:'AA',permission:'fullcontrol',expiresAt:'2099-01-01T00:00:00.000Z',status:'connected',syncing:false,snapshot:{epoch:`e-${id}`,revision:1,permission:'fullcontrol',capabilities:{contract:1,methods:[]},projects:[],worktrees:[],sessions:[session],inbox:[],providers:[]}}) as any;
const approval=(patch:any={})=>({id:'item',role:'assistant',createdAt:now,turnId:'turn',parts:[{type:'approval',status:'pending',approvalId:'approval',data:{approvalId:'approval',turnId:'turn',title:'Approve?',choices:[{choiceId:'yes',label:'Yes'}],...patch}}]});

test('approval/question projection is machine-qualified and excludes resolved or historical cards',()=>{
  const a=machine('a'),b=machine('b');b.snapshot.sessions=[{...session,status:'idle',activity:undefined}];const views:any={
    '["a","same"]':{items:[approval()],ref:{machineId:'a',sessionId:'same'}},
    '["b","same"]':{items:[approval({answerSummary:{answer:'done'}}),{...approval(),id:'history',turnOrigin:'history'}],ref:{machineId:'b',sessionId:'same'}},
  };
  const rows=attentionItems([a,b],views);assert.equal(rows.length,1);assert.equal(rows[0]!.key,'["a","same","turn","approval"]');assert.equal(rows[0]!.approval?.choices[0]?.choiceId,'yes');
});

test('wire contract caps detailed subscriptions and rejects desktop-only authority',()=>{
  validateMobileRequest('mobile.events.subscribe',{sessionIds:['a','b','c','d']});
  assert.throws(()=>validateMobileRequest('mobile.events.subscribe',{sessionIds:['a','b','c','d','e']}),/invalid_subscription/);
  assert.throws(()=>validateMobileRequest('runtime.shutdown' as never,{}),/mobile_forbidden/);
  assert.throws(()=>mobileResult('mobile.snapshot' as const,{epoch:'e',revision:1,permission:'fullcontrol',capabilities:{contract:1,methods:[]},projects:[],worktrees:[],sessions:[],inbox:[],providers:[],settings:{}}),/invalid_mobile_snapshot/);
});

test('pending-looking approval from an earlier or settled turn cannot authorize an attention action',()=>{
  const host=machine('a');host.snapshot.sessions=[{...session,activity:{...session.activity,turnId:'new-turn'}}];
  const views:any={'["a","same"]':{items:[approval(),{...approval({turnId:'new-turn'}),turnStatus:'completed'}],ref:{machineId:'a',sessionId:'same'}}};
  const rows=attentionItems([host],views);
  assert.equal(rows.length,1);assert.equal(rows[0]!.approvalId,undefined,'only the non-actionable session attention fallback remains');
});

test('a session resync keeps a current approval visible but stale until authoritative data returns',()=>{
  const host=machine('a');host.snapshot.sessions=[{...session,activity:{...session.activity,turnId:'turn'}}];
  const views:any={'["a","same"]':{items:[approval()],syncing:true,ref:{machineId:'a',sessionId:'same'}}};
  const rows=attentionItems([host],views);
  assert.equal(rows[0]!.approvalId,'approval');assert.equal(rows[0]!.stale,true);
});
