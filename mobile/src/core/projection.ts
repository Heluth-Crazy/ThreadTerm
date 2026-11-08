import type { ChatApprovalData, ChatItem, ChatUiState } from '@threadterm/protocol';
import type { AttentionItem, CompanionState, Locale, MachineState, SessionRef, SessionView } from './types';
import { sessionKey } from './types';
import { chipValueText, partitionOptions, thinkingChipText } from '../../../renderer/src/composerOptions';

/** Same classification and localized values as the desktop; all choices come from the host. */
export function chatOptionsSummary(ui:ChatUiState|undefined,locale:Locale):string {
  const zh=locale==='zh-CN', {model,thinking}=partitionOptions(ui?.options??[]);
  return [model&&chipValueText(model,zh),thinking&&thinking.value&&thinkingChipText(thinking,zh)].filter(Boolean).join(' · ') || (zh?'会话选项':'Session options');
}

/** Desktop permits only host permission options when saved permissions need recovery. */
export function chatOptionsPermissionRecovery(view:SessionView|undefined):boolean {
  return view?.connection?.phase==='failed'&&view.connection.error?.code==='chat_permission_restore_failed';
}

/** Display-only reason. Runtime and the controller independently enforce authority. */
export function chatOptionsDisabledReason(state:CompanionState,ref:SessionRef):string|undefined {
  const zh=state.preferences.locale==='zh-CN',copy=(en:string,cn:string)=>zh?cn:en;
  const machine=state.machines.find(m=>m.id===ref.machineId),view=state.sessions[sessionKey(ref)];
  const session=machine?.snapshot?.sessions.find(s=>s.id===ref.sessionId);
  if(machine?.permission==='readonly')return copy('This computer allows viewing only.','此电脑仅允许查看。');
  if(!machine||machine.status!=='connected'||machine.syncing||view?.syncing)return copy('Waiting for this computer to sync.','正在等待此电脑同步。');
  if(!session||session.readOnly||session.archived)return copy('This session allows viewing only.','此会话仅允许查看。');
  if(!state.controlUnlocked)return copy('Locked — unlock to change options.','已锁定，解锁后可更改选项。');
  if(!machine.snapshot?.capabilities.methods.includes('chat.option.set'))return copy('Update ThreadTerm on this computer to change options.','请更新此电脑上的 ThreadTerm 以更改选项。');
  const recovering=chatOptionsPermissionRecovery(view);
  if(view?.connection?.phase!=='ready'&&!recovering)return copy('Connect the agent to change options.','连接 Agent 后可更改选项。');
  if(!view||view.optionsLoading||!view.chatUi||['idle','loading','unknown'].includes(view.chatUi.loadState??''))return copy('Loading options from this computer…','正在从此电脑读取选项…');
  if(view.chatUi.loadState==='error'&&!recovering)return copy('Options could not be loaded. Try again.','无法读取选项，请重试。');
}

export function mergeItems(existing:ChatItem[],incoming:ChatItem[]):ChatItem[] {
  const rows = new Map(existing.map(item=>[item.id,item]));
  for (const item of incoming) rows.set(item.id,item);
  return [...rows.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}
export function approvalData(value:unknown):ChatApprovalData|undefined {
  if (!value || typeof value!=='object') return;
  const data=value as Partial<ChatApprovalData>;
  if (typeof data.approvalId!=='string') return;
  return {...data,choices:Array.isArray(data.choices)?data.choices.filter(choice=>typeof choice?.choiceId==='string'&&typeof choice.label==='string'):[]} as ChatApprovalData;
}
export function attentionItems(machines:MachineState[],views:CompanionState['sessions']):AttentionItem[] {
  const result:AttentionItem[]=[];
  for(const machine of machines) {
    const snapshot=machine.snapshot;
    if(!snapshot) continue;
    for(const session of snapshot.sessions) {
      const ref={machineId:machine.id,sessionId:session.id};
      const view=views[sessionKey(ref)];
      const stale=machine.status!=='connected'||machine.syncing||view?.syncing===true;
      const base={ref,machineName:machine.name,session,stale};
      let pending=false;
      for(const item of view?.items??[]) {
        if(item.turnOrigin==='history'||['completed','failed','interrupted'].includes(item.turnStatus??'')) continue;
        for(const part of item.parts) {
          if(part.type!=='approval'||part.status!=='pending') continue;
          const data=approvalData(part.data);
          const approvalId=part.approvalId??data?.approvalId;
          const turnId=data?.turnId??item.turnId;
          if(!approvalId||!turnId||!data) continue;
          if(session.activity?.turnId&&session.activity.turnId!==turnId) continue;
          // Resolved historical cards must not authorize current controls.
          if(data.planOutcome||data.answerSummary||data.outcome) continue;
          if(!(session.activity?['awaiting_approval','awaiting_input'].includes(session.activity.state):session.status==='waiting')) continue;
          pending=true;
          result.push({...base,key:JSON.stringify([machine.id,session.id,turnId,approvalId]),title:data.title??part.text??session.title,createdAt:item.createdAt,turnId,approvalId,approval:data});
        }
      }
      for(const entry of snapshot.inbox.filter(entry=>entry.sessionId===session.id&&!entry.read)) {
        if(pending && /approval|question|input|waiting/i.test(entry.kind)) continue;
        result.push({...base,key:JSON.stringify([machine.id,'inbox',entry.id]),title:entry.title,createdAt:entry.createdAt,inboxId:entry.id});
      }
      if(!pending && !snapshot.inbox.some(entry=>entry.sessionId===session.id&&!entry.read) && ['awaiting_approval','awaiting_input'].includes(session.activity?.state??'')) {
        result.push({...base,key:JSON.stringify([machine.id,'attention',session.id]),title:session.title,createdAt:session.updatedAt});
      }
    }
  }
  return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.key.localeCompare(b.key));
}
export function emptySession(ref:SessionView['ref']):SessionView {
  return {ref,items:[],loading:true,syncing:true,terminal:'',terminalCursor:0,terminalGap:false,hasOlder:false};
}
export function errorMessage(error:unknown):string {
  if(error instanceof Error) return error.message;
  if(typeof error==='string') return error;
  return 'request_failed: The operation could not be completed.';
}
