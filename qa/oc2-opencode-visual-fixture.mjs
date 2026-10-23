// Only the bridge is simulated; all displayed components are production code.
export function oc2VisualEntry() {
  return `
import React from 'react';import{createRoot}from'react-dom/client';
import{ChatView}from'./renderer/src/components/ChatView';import{I18nProvider}from'./renderer/src/i18n';
import{attachChatImages}from'./renderer/src/terminalInputTargets';import{applyThemeTokens}from'./renderer/src/themes';
import'./renderer/src/styles.css';
const listeners=new Set(),requests=[],sessionId='oc2-visual';let items=[],revision=1,seq=0,renderId=0;
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const ui={options:[{id:'next-model',name:'Model',category:'model',value:'vision',choices:[{value:'vision',name:'Vision · Vision 1'}]}],commands:[{name:'review',description:'Review the current changes'},{name:'compact',description:'Compact conversation using the current model'}],inputCapabilities:{images:true},loadState:'ready'};
const emit=(event,data)=>listeners.forEach(f=>f({seq:++seq,event,data}));
window.threadterm={platform:'win32',onEvent(f){listeners.add(f);return()=>listeners.delete(f)},async request(method,params={}){
 requests.push({method,params});
 if(method==='chat.snapshot')return{items,revision:seq};if(method==='chat.read')return items;if(method==='chat.options')return ui;
 if(method==='chat.connect'||method==='chat.connection')return{sessionId,runtimeEpoch:'oc2-visual-epoch',revision:1,phase:'ready',connectionGeneration:1,optionsLoadState:'ready'};
 if(method==='chat.draft.read')return{text:'',revision};if(method==='chat.draft.save')return{revision:++revision};
 if(method==='session.claim'||method==='session.renew')return{leaseEpoch:1};if(method==='session.release')return null;
 if(method==='chat.queue.read')return{sessionId,paused:false,items:[]};if(method==='chat.feedback.read')return{sessionId,notes:[]};
 if(method==='chat.answer'){const item=items.find(item=>item.parts.some(part=>part.approvalId===params.approvalId));item.parts[0]={...item.parts[0],status:params.response.action==='dismiss'?'dismissed':'answered'};emit('chat.item',{sessionId,item:{...item}});return null;}
 if(method==='provider.list')return[];if(method==='session.config.read')return{sessionId,revision:1,provider:'opencode',mode:'chat',cwd:'D:/fixture',args:[]};return null;
}};
const root=createRoot(document.getElementById('root'));window.qaRequests=()=>requests.slice();window.qaAttach=()=>attachChatImages(sessionId,[image]);
window.qaRender=({theme,width})=>{
 localStorage.clear();requests.length=0;const base=theme==='light'?'light':'dark';document.documentElement.dataset.theme=base;document.documentElement.dataset.customTheme='false';applyThemeTokens(undefined,base);
 if(theme==='custom'){const style=getComputedStyle(document.documentElement),ctx=document.createElement('canvas').getContext('2d');const color=token=>{ctx.fillStyle=style.getPropertyValue(token).trim();return ctx.fillStyle};applyThemeTokens({background:color('--surface'),surface:color('--raised'),text:color('--text'),muted:color('--muted'),accent:color('--amber'),border:color('--border')},base);document.documentElement.dataset.customTheme='true';}
 items=[{id:'compact-receipt',role:'assistant',createdAt:'2026-10-16T12:00:00Z',turnId:'compact-turn',turnStatus:'completed',parts:[{type:'text',text:'Conversation compacted by OpenCode.',data:{kind:'commandResult',command:'compact'}}]},
 {id:'recovered-question',role:'assistant',createdAt:'2026-10-16T12:00:01Z',turnId:'native-busy',parts:[{type:'approval',approvalId:'q-recovered',status:'pending',data:{approvalId:'q-recovered',interaction:'question',answerable:true,form:{kind:'questions',questions:[{id:'question-0',header:'Recovered question',question:'Continue with the recovered plan?',options:[{label:'Continue',description:'Use the recovered plan'},{label:'Revise',description:'Change the plan first'}],multiSelect:false,allowOther:true,secret:false}]}}}]}];
 root.render(<I18nProvider locale='en'><main className='qa-pane' data-render={++renderId} data-pane-id='oc2' style={{width}}><ChatView key={renderId} session={{id:sessionId,provider:'opencode',mode:'chat',status:'waiting',title:'OpenCode',worktreePath:'D:/fixture',createdAt:'now',updatedAt:'now'}}/></main></I18nProvider>);return renderId;
};
`;
}
