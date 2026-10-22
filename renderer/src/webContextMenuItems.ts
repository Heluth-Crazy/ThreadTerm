import type { PagePick } from '@threadterm/protocol';
import type { ContextMenuItem } from './components/ContextMenu';

export function webContextMenuItems({pick,zh,enabled,comment,reload,copy,inspect}:{pick:PagePick;zh:boolean;enabled:boolean;comment:()=>void;reload:()=>void;copy:()=>void|Promise<void>;inspect?:()=>void}):ContextMenuItem[] {
 const text=(en:string,cn:string)=>zh?cn:en, hasText=pick.target.type==='element'&&Boolean(pick.target.text);
 const items:ContextMenuItem[]=[
  {label:text('Comment on element','评论此元素'),disabled:!enabled,reason:text('Open a Chat session in this workspace first.','请先在此工作区打开一个聊天会话。'),onSelect:comment,testId:'web-preview-comment-element'},
  {label:text('Reload','重新加载'),onSelect:reload,testId:'web-preview-reload'},
  {label:'',separator:true},
  {label:text('Copy element text','复制元素文本'),disabled:!hasText,reason:text('This element has no text.','此元素没有文本。'),onSelect:copy,testId:'web-preview-copy-element-text'},
 ];
 if(inspect)items.push({label:'',separator:true},{label:text('Inspect','检查'),onSelect:inspect,testId:'web-preview-inspect'});
 return items;
}
