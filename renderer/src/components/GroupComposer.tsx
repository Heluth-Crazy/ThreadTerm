import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { Group } from '@threadterm/protocol';
import { byteLabel, describeGroupReference, droppedGroupReferences, groupComposition, groupEnterSends, insertGroupMention, leadingGroupRecipientKey, mentionCompletion, referenceKey, replyReferenceHandle, selectedGroupRecipients, type GroupReferenceInput } from '../groupComposer';
import { clearGroupWarning, groupAttachEscape, groupAttachWarning, groupDropWarning, groupIssueText, groupReferenceTitle, type GroupComposerWarning } from '../groupMessages';
import { groupDropPaths } from '../groupFileDrop';
import { Icon } from './PrototypeIcon';
import { groupMenuBlur, groupMenuKeys } from './groupMenuKeys';
import './group-composer.css';
export type GroupComposeIntent={text:string;to?:string[];reference?:GroupReferenceInput};
type Props={group:Group;zh:boolean;disabled:boolean;intent?:GroupComposeIntent;onSend:(text:string,to:string[],references:GroupReferenceInput[])=>Promise<boolean>;onAddMember:(handle?:string)=>void;onFindReply:(handle:string,messageId?:string)=>Promise<void>};
export function GroupComposer({group,zh,disabled,intent,onSend,onAddMember,onFindReply}:Props){
 const copy=(en:string,cn:string)=>zh?cn:en,input=useRef<HTMLTextAreaElement>(null),composing=useRef(false),menuId=useId();
 const [text,setText]=useState(''),[caret,setCaret]=useState(0),[extra,setExtra]=useState<GroupReferenceInput[]>([]),[excluded,setExcluded]=useState<string[]>([]),[manual,setManual]=useState<{key:string;to:string[]}>(),[active,setActive]=useState(0),[completionHidden,setCompletionHidden]=useState(false),[recipientMenu,setRecipientMenu]=useState(false),[attaching,setAttaching]=useState(false),[attachment,setAttachment]=useState(''),[issue,setIssue]=useState<GroupComposerWarning>();
 const parsed=groupComposition(text,group),to=selectedGroupRecipients(text,parsed.to,group.members.map(member=>member.handle),manual);
 const references=[...new Map([...parsed.references.filter(ref=>!excluded.includes(referenceKey(ref))),...extra.map(ref=>describeGroupReference(ref,group.messages))].map(ref=>[referenceKey(ref),ref])).values()];
 const completion=!completionHidden?mentionCompletion(text,caret,composing.current):undefined,choices=completion?['all',...group.members.map(member=>member.handle)].filter(handle=>handle.startsWith(completion.query)):[];
 const reason=group.archived?copy('This group is archived.','此群聊已归档。'):disabled?copy('Waiting for the current operation or connection.','正在等待当前操作完成或连接恢复。'):!to.length?copy('Choose at least one recipient.','请至少选择一个接收者。'):references.length>8?copy('Include up to eight references.','最多可附加八条引用。'):references.some(ref=>ref.missing)||parsed.unresolved.some(handle=>!excluded.includes(`handle:${handle}`))?copy('Resolve or remove the missing reply reference.','请查找或移除缺失的回复引用。'):!text.trim()?copy('Write a message to send.','请填写要发送的消息。'):undefined;
 const grow=()=>{const node=input.current;if(!node)return;node.style.height='auto';node.style.height=`${Math.min(200,Math.max(34,node.scrollHeight))}px`;};
 useEffect(()=>{grow();},[text]);
 useEffect(()=>{if(!intent)return;setText(intent.text);setCaret(intent.text.length);setExcluded([]);setExtra(intent.reference?[intent.reference]:[]);setCompletionHidden(true);setIssue(undefined);const parsedIntent=groupComposition(intent.text,group);setManual(intent.to?{key:leadingGroupRecipientKey(intent.text,parsedIntent.to,group.members.map(member=>member.handle)),to:intent.to}:undefined);input.current?.focus();},[intent]);
 const recipients=(next:string[])=>setManual({key:leadingGroupRecipientKey(text,parsed.to,group.members.map(member=>member.handle)),to:next});
 const attach=(refs:GroupReferenceInput[])=>{setExtra(old=>[...new Map([...old,...refs].map(ref=>[referenceKey(ref),ref])).values()]);setExcluded(old=>old.filter(key=>!refs.some(ref=>referenceKey(ref)===key)));setIssue(old=>clearGroupWarning(old,'include'));};
 const choose=(handle:string)=>{if(!completion||composing.current)return;const next=insertGroupMention(text,completion,handle==='all'?'All':handle);const nextParsed=groupComposition(next.text,group);if(manual&&manual.key!==leadingGroupRecipientKey(next.text,nextParsed.to,group.members.map(member=>member.handle)))setManual(undefined);setText(next.text);setCaret(next.caret);setCompletionHidden(true);setActive(0);requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(next.caret,next.caret);});};
 const send=async()=>{if(reason||composing.current)return;if(await onSend(text,to,references.map(({kind,messageId,path,url})=>({kind,messageId,path,url})))){setText('');setCaret(0);setExtra([]);setExcluded([]);setManual(undefined);setIssue(undefined);}};
 const removeReference=(key:string)=>{setExcluded(old=>[...old,key]);setExtra(old=>old.filter(value=>referenceKey(value)!==key));};
 const warning=()=>issue&&<div className="gc-notice gc-error gc-composer-error" id={`${menuId}-warning`} role="alert"><Icon name="info"/><span>{groupIssueText(issue,zh)}</span><button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Dismiss','关闭')} title={copy('Dismiss','关闭')} onClick={()=>setIssue(old=>clearGroupWarning(old,'dismiss'))}><Icon name="close"/></button></div>;
 return (
  <form
   className="gc-composer chat-compose-shell"
   data-testid="group-composer"
   onSubmit={event=>{event.preventDefault();void send();}}
   onDragOver={event=>{
    if(event.dataTransfer.types.includes('text/uri-list')||event.dataTransfer.types.includes('text/plain')||event.dataTransfer.types.includes('Files'))event.preventDefault();
   }}
   onDrop={event=>{
    event.preventDefault();setIssue(old=>clearGroupWarning(old,'drop'));
    const dropped=event.dataTransfer.getData('text/uri-list')||event.dataTransfer.getData('text/plain');
    const refs=droppedGroupReferences([dropped,...groupDropPaths(event.dataTransfer)].filter(Boolean).join('\n'),group.cwd);
    if(refs.length)attach(refs);
    else if(dropped||event.dataTransfer.files.length)setIssue(groupDropWarning);
   }}
  >
   <div className="gc-composer-chips" data-testid="group-to">
    <span className="gc-chip-label">{copy('To:','发送给：')}</span>
    {to.map(handle=><button type="button" className="chip chip-btn is-plain gc-recipient" key={handle} aria-label={copy(`Remove recipient @${handle}`,`移除接收者 @${handle}`)} onClick={()=>recipients(to.filter(value=>value!==handle))}>@{handle==='all'?'All':handle}<Icon name="close"/></button>)}
    <span className="gc-add-recipient-anchor" onKeyDown={event=>groupMenuKeys(event,recipientMenu,setRecipientMenu)}
     onBlur={event=>groupMenuBlur(event,setRecipientMenu)} onClick={event=>{
      if((event.target as Element).closest('[role=option]'))event.currentTarget.querySelector<HTMLButtonElement>('[role=combobox]')?.focus();
     }}>
     <button type="button" className="chip chip-btn is-plain" role="combobox" aria-label={copy('Add recipient','添加接收者')} aria-expanded={recipientMenu} aria-haspopup="listbox" aria-controls={recipientMenu?`${menuId}-recipients`:undefined} disabled={disabled||group.archived} onClick={()=>setRecipientMenu(value=>!value)}>
      {copy('Add recipient','添加接收者')}<Icon name="chevD"/>
     </button>
     {recipientMenu&&<div className="popover gc-recipient-menu" id={`${menuId}-recipients`} role="listbox" aria-label={copy('Add recipient','添加接收者')}>
      <button type="button" className="menu-item" role="option" aria-selected={to.includes('all')} data-value="all" onClick={()=>{recipients(['all']);setRecipientMenu(false);}}>@All</button>
      {group.members.map(member=><button type="button" className="menu-item" role="option" aria-selected={to.includes(member.handle)} data-value={member.handle} key={member.handle} onClick={()=>{recipients([...new Set([...to.filter(handle=>handle!=='all'),member.handle])]);setRecipientMenu(false);}}>@{member.handle}</button>)}
     </div>}
    </span>
   </div>
   {(references.length>0||parsed.unresolved.length>0)&&<div className="gc-composer-chips" data-testid="group-includes">
    <span className="gc-chip-label">{copy('Includes:','包含：')}</span>
    {references.map(ref=>{
     const key=referenceKey(ref),title=groupReferenceTitle(ref,group.messages,zh);
     const replyHandle=replyReferenceHandle(ref)??group.messages.find(message=>message.id===ref.messageId)?.handle??'?';
     return <Fragment key={key}>
      <button type="button" className="chip chip-btn is-plain gc-reference" title={title} data-reference-kind={ref.kind} data-reference-id={ref.messageId??ref.path??ref.url} data-bytes={ref.bytes} aria-label={copy(`Remove reference ${title}`,`移除引用 ${title}`)} onClick={()=>removeReference(key)}>
       <span>{ref.kind==='reply'?copy(`@${replyHandle}'s reply`,`@${replyHandle} 的回复`):ref.kind==='message'?copy('Quoted message','引用的消息'):ref.path??ref.url}</span>
       {!ref.missing&&<small>{copy(` · ${byteLabel(ref.bytes)}`,` · ${byteLabel(ref.bytes)}`)}{ref.shortened?copy(' · shortened',' · 已缩短'):''}</small>}
       <Icon name="close"/>
      </button>
      {ref.missing&&<button type="button" className="btn btn-sm" disabled={disabled} onClick={()=>void onFindReply(replyHandle,ref.messageId)}>{copy('Load original message','加载原始消息')}</button>}
     </Fragment>;
    })}
    {parsed.unresolved.filter(handle=>!excluded.includes(`handle:${handle}`)).map(handle=><Fragment key={handle}>
     <button type="button" className="chip chip-btn is-plain gc-reference" aria-label={copy(`Remove reference @${handle}`,`移除引用 @${handle}`)} onClick={()=>setExcluded(old=>[...old,`handle:${handle}`])}>@{handle}<Icon name="close"/></button>
     {group.hasMore?<button className="btn btn-sm" type="button" disabled={disabled} onClick={()=>void onFindReply(handle)}>{copy('Find latest reply','查找最新回复')}</button>:<small>{copy('No reply yet','尚无回复')}</small>}
    </Fragment>)}
   </div>}
   {parsed.unknownHandles.map(handle=><button className="btn btn-sm btn-ghost gc-unknown" type="button" key={handle} disabled={disabled||group.members.length>=6} onClick={()=>onAddMember(handle)}>{copy(`Add @${handle} to the group?`,`将 @${handle} 加入群聊？`)}</button>)}
   <div className="gc-input-wrap">
    <textarea
     data-testid="group-message"
     aria-label={copy('Message the group','发送群聊消息')}
     placeholder={copy('Message the group — @ to address an agent…','发送群聊消息 — 使用 @ 指定智能体…')}
     value={text}
     rows={1}
     maxLength={64000}
     ref={input}
     disabled={disabled||group.archived}
     aria-autocomplete="list"
     aria-controls={choices.length?menuId:undefined}
     aria-activedescendant={choices.length?`${menuId}-${active%choices.length}`:undefined}
     onCompositionStart={()=>{composing.current=true;setCompletionHidden(true);}}
     onCompositionEnd={event=>{composing.current=false;setCaret(event.currentTarget.selectionStart);setCompletionHidden(false);}}
     onChange={event=>{setIssue(old=>clearGroupWarning(old,'edit'));const next=event.target.value,nextParsed=groupComposition(next,group),nextKey=leadingGroupRecipientKey(next,nextParsed.to,group.members.map(member=>member.handle));if(manual&&manual.key!==nextKey)setManual(undefined);setText(next);setCaret(event.target.selectionStart);setCompletionHidden(false);setActive(0);}}
     onSelect={event=>setCaret(event.currentTarget.selectionStart)}
     onKeyDown={event=>{
      if(event.nativeEvent.isComposing||composing.current||event.nativeEvent.keyCode===229)return;
      if(choices.length&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)){
       event.preventDefault();
       if(event.key==='Escape')setCompletionHidden(true);
       else if(event.key==='ArrowDown')setActive(value=>(value+1)%choices.length);
       else if(event.key==='ArrowUp')setActive(value=>(value-1+choices.length)%choices.length);
       else choose(choices[active%choices.length]);
       return;
      }
      if(groupEnterSends(event.nativeEvent,composing.current)){event.preventDefault();void send();}
     }}
    />
    {choices.length>0&&<div className="popover gc-mention-menu" role="listbox" id={menuId} data-testid="group-mention-menu" aria-label={copy('Group members','群聊成员')}>
     {choices.map((handle,index)=><button type="button" role="option" className="menu-item" id={`${menuId}-${index}`} aria-selected={index===active%choices.length} key={handle} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(handle)}>@{handle==='all'?'All':handle}</button>)}
    </div>}
   </div>
   <div className="gc-toolbar chat-compose-bar">
    <span className="chat-compose-left">
     <button type="button" className="icon-btn icon-btn-sm" aria-label={copy('Attach reference','附加引用')} title={copy('Attach reference','附加引用')} disabled={disabled||group.archived} aria-expanded={attaching} onClick={()=>{setAttaching(value=>!value);setIssue(old=>clearGroupWarning(old,'attach-close'));}}><Icon name="plus"/></button>
    </span>
    <span className="gc-composer-hint">{reason&&text.trim()?reason:copy('Only recipients see this message and its references.','只有接收者能看到此消息及其引用。')}</span>
    <span className="chat-compose-right">
     <button className="icon-btn icon-btn-sm icon-btn-round is-secondary chat-compose-send" data-testid="group-send" disabled={!!reason} title={reason} aria-label={copy('Send','发送')} type="submit"><Icon name="arrowUp"/></button>
    </span>
   </div>
   {attaching&&<div className="gc-attach-section">
    <div className="gc-attach-row">
     <input className="create-input" autoFocus aria-label={copy('File path or URL','文件路径或网址')} aria-invalid={issue?.source==='attach'||undefined} aria-describedby={issue?.source==='attach'?`${menuId}-warning`:undefined} placeholder={copy('Relative file path or http(s) URL','相对文件路径或 http(s) 网址')} value={attachment} onChange={event=>{setAttachment(event.target.value);setIssue(old=>clearGroupWarning(old,'attach-edit'));}} onKeyDown={event=>{if(groupAttachEscape(event.nativeEvent)){event.preventDefault();setAttaching(false);setIssue(old=>clearGroupWarning(old,'attach-close'));event.currentTarget.form?.querySelector<HTMLButtonElement>('.gc-toolbar button')?.focus();}else if(event.key==='Enter'&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();event.currentTarget.parentElement?.querySelector('button')?.click();}}}/>
     <button className="btn btn-sm" type="button" onClick={()=>{const refs=droppedGroupReferences(attachment,group.cwd);if(!refs.length){setIssue(groupAttachWarning);return;}attach(refs);setAttachment('');setAttaching(false);}}>{copy('Include','包含')}</button>
    </div>
    {issue?.source==='attach'&&warning()}
   </div>}
   {issue?.source==='drop'&&warning()}
  </form>
 );
}
