import assert from 'node:assert/strict';
import test from 'node:test';
import { activeSessionTurnId, attentionItems, isPendingAttentionInboxItem, sessionNeedsUserAction, sessionPresentation, sessionPresentationLabel } from '../src/core/projection';
import { validateMobileRequest, mobileResult } from '../src/core/wire';
import { isMobileSnapshot } from '@threadterm/protocol/mobile';

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

test('mobile snapshot accepts only the optional closed ConPTY metadata shape',()=>{
  const snapshot={epoch:'e',revision:1,permission:'fullcontrol',capabilities:{contract:1 as const,methods:[]},projects:[],worktrees:[],sessions:[],inbox:[],providers:[]};
  assert.equal(isMobileSnapshot(snapshot),true,'older hosts omit the additive field');
  assert.equal(isMobileSnapshot({...snapshot,capabilities:{...snapshot.capabilities,windowsPty:{backend:'conpty',buildNumber:19041}}}),true);
  assert.equal(isMobileSnapshot({...snapshot,capabilities:{...snapshot.capabilities,windowsPty:{backend:'winpty',buildNumber:19041}}}),false);
  assert.equal(isMobileSnapshot({...snapshot,capabilities:{...snapshot.capabilities,windowsPty:{backend:'conpty',buildNumber:-1}}}),false);
  assert.equal(isMobileSnapshot({...snapshot,capabilities:{...snapshot.capabilities,windowsPty:{backend:'conpty',buildNumber:19041,extra:true}}}),false);
  assert.equal(isMobileSnapshot({...snapshot,capabilities:{...snapshot.capabilities,unexpected:true}}),false);
});

test('pending-looking approval from an earlier or settled turn cannot authorize an attention action',()=>{
  const host=machine('a');host.snapshot.sessions=[{...session,activity:{...session.activity,turnId:'new-turn'}}];
  const views:any={'["a","same"]':{items:[approval(),{...approval({turnId:'new-turn'}),turnStatus:'completed'}],ref:{machineId:'a',sessionId:'same'}}};
  const rows=attentionItems([host],views);
  assert.equal(rows.length,0,'there is no synthetic fallback for a stale approval card');
});

test('a session resync keeps a current approval visible but stale until authoritative data returns',()=>{
  const host=machine('a');host.snapshot.sessions=[{...session,activity:{...session.activity,turnId:'turn'}}];
  const views:any={'["a","same"]':{items:[approval()],syncing:true,ref:{machineId:'a',sessionId:'same'}}};
  const rows=attentionItems([host],views);
  assert.equal(rows[0]!.approvalId,'approval');assert.equal(rows[0]!.stale,true);
});

test('attention treats settled awaiting_input replies as unread replies, not approvals',()=>{
  const host=machine('a');
  host.snapshot.sessions=[{...session,status:'idle',activity:{state:'awaiting_input',turnId:'reply-turn',revision:2}}];
  host.snapshot.inbox=[{id:'reply',sessionId:'same',kind:'reply',title:'Finished reply',createdAt:now,read:false}];
  const views:any={'["a","same"]':{items:[],ref:{machineId:'a',sessionId:'same'}}};
  assert.deepEqual(attentionItems([host],views),[],'a non-waiting awaiting_input reply is not Needs You');
  assert.equal(sessionNeedsUserAction(host.snapshot.sessions[0]),false);
  assert.equal(activeSessionTurnId(host.snapshot.sessions[0]),undefined,'a settled reply cannot show Stop');
});

test('attention keeps real pending approvals, questions, plans and forms plus waiting input',()=>{
  const cases=[
    {name:'approval',data:{}},
    {name:'question',data:{interaction:'question'}},
    {name:'plan',data:{interaction:'plan'}},
    {name:'form',data:{form:{kind:'questions',questions:[]}}},
  ];
  for(const entry of cases){
    const host=machine(entry.name);host.snapshot.sessions=[{...session,activity:{state:'awaiting_approval',turnId:'turn',revision:1}}];
    const views:any={[JSON.stringify([entry.name,'same'])]:{items:[approval(entry.data)],ref:{machineId:entry.name,sessionId:'same'}}};
    assert.equal(attentionItems([host],views).length,1,entry.name);
  }
  const host=machine('input');host.snapshot.sessions=[{...session,activity:{state:'awaiting_input',turnId:'input-turn',revision:1}}];
  assert.equal(attentionItems([host],{}).length,1,'a status-waiting input remains actionable without an approval card');
  host.snapshot.inbox=[{id:'input',sessionId:'same',kind:'waiting',title:'Answer requested',createdAt:now,read:false}];
  assert.equal(attentionItems([host],{}).length,1,'a real waiting inbox item remains actionable');
  assert.equal(sessionNeedsUserAction(host.snapshot.sessions[0]),true);
});

test('active turn is limited to running or status-waiting pending input/approval',()=>{
  const running={...session,status:'running',activity:{state:'running',turnId:'running-turn',revision:1}} as any;
  const waitingInput={...session,status:'waiting',activity:{state:'awaiting_input',turnId:'input-turn',revision:1}} as any;
  const waitingApproval={...session,status:'waiting',activity:{state:'awaiting_approval',turnId:'approval-turn',revision:1}} as any;
  const unknown={...session,status:'idle',activity:{state:'unknown',turnId:'unknown-turn',revision:1}} as any;
  assert.equal(activeSessionTurnId(running),'running-turn');
  assert.equal(activeSessionTurnId(waitingInput),'input-turn');
  assert.equal(activeSessionTurnId(waitingApproval),'approval-turn');
  assert.equal(activeSessionTurnId(unknown),undefined);
});

test('settled input has an unread-reply presentation while waiting input remains Needs You',()=>{
  const reply={...session,status:'idle',activity:{state:'awaiting_input',turnId:'reply-turn',revision:1}} as any;
  const waiting={...session,status:'waiting',activity:{state:'awaiting_input',turnId:'input-turn',revision:1}} as any;
  assert.equal(sessionPresentation(reply),'unread_reply');
  assert.equal(sessionPresentationLabel(reply,'en'),'Unread reply');
  assert.equal(sessionPresentationLabel(reply,'zh-CN'),'未读回复');
  assert.equal(sessionPresentation(waiting),'needs_user');
  assert.equal(sessionPresentationLabel(waiting,'en'),'Needs you');
});

test('Needs You inbox accepts only known pending request kinds',()=>{
  for (const kind of ['approval','question','plan','form','waiting','input']) assert.equal(isPendingAttentionInboxItem({read:false,kind}),true,kind);
  for (const kind of ['reply','stalled','completed','error','unknown']) assert.equal(isPendingAttentionInboxItem({read:false,kind}),false,kind);
  assert.equal(isPendingAttentionInboxItem({read:true,kind:'approval'}),false);
});
