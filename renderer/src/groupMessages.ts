import type { GroupMessage, GroupReference } from '@threadterm/protocol';

export type GroupIssue = { en: string; zh: string } | { code: string };
const errors: Record<string, [string, string]> = {
 group_delivery_not_retryable: ['This delivery cannot be resent in its current state.', '此投递当前无法重新发送。'],
 group_delivery_not_queued: ['This delivery is no longer queued.', '此投递已不在队列中。'],
 group_delivery_not_found: ['This delivery is no longer available.', '此投递已不可用。'],
 revision_conflict: ['The group changed. Refresh it and try again.', '群聊已更新，请刷新后重试。'],
 group_archived: ['This group is archived.', '此群聊已归档。'],
 group_not_found: ['This group is no longer available.', '此群聊已不可用。'],
 group_member_not_found: ['This member is no longer in the group.', '此成员已不在群聊中。'],
 group_member_busy: ['Wait for this member to finish before changing it.', '请等待此成员完成后再修改。'],
 group_message_not_found: ['This message is no longer available.', '此消息已不可用。'],
 group_full: ['A group can have up to six members.', '群聊最多可有六名成员。'],
 group_folder_mismatch: ['Choose the same folder as the group.', '请选择与群聊相同的目录。'],
 invalid_group_file: ['Choose a file inside the group folder.', '请选择群聊目录中的文件。'],
 invalid_group_url: ['Choose an HTTP(S) URL.', '请选择 HTTP(S) 网址。'],
 invalid_group_handle: ['Use a unique handle with letters, numbers or hyphens.', '请使用由字母、数字或连字符组成的唯一昵称。'],
 invalid_group_members: ['Choose one to six available agents.', '请选择一至六个可用智能体。'],
 invalid_group_recipients: ['Choose at least one group member.', '请至少选择一名群聊成员。'],
 invalid_group_reference: ['Load or remove the unavailable reference.', '请加载或移除不可用的引用。'],
 too_many_group_references: ['Include up to eight references.', '最多可附加八条引用。'],
 invalid_group_message: ['Enter a message within the length limit.', '请输入长度限制内的消息。'],
 invalid_group_title: ['Enter a group name within the length limit.', '请输入长度限制内的群聊名称。'],
 invalid_group_mode: ['Choose an available permission mode.', '请选择可用的权限模式。'],
 invalid_group_model: ['Choose an available model.', '请选择可用的模型。'],
 invalid_group_source: ['Choose an available Chat session.', '请选择可用的聊天会话。'],
 invalid_group_cursor: ['Reload the group history and try again.', '请重新加载群聊历史后重试。'],
 provider_unavailable: ['This agent is unavailable. Check its installation and configuration.', '此智能体不可用，请检查其安装和配置。'],
 provider_not_found: ['Install or configure this agent before continuing.', '请先安装或配置此智能体。'],
 provider_failed: ['The agent could not complete this request. Open its Chat for details.', '智能体未能完成此请求，请打开其聊天查看详情。'],
 chat_busy: ['This Chat is busy. Try again when it finishes.', '此聊天正在忙碌，请在完成后重试。'],
 connection_closed: ['The connection closed. Reconnect and try again.', '连接已关闭，请重新连接后重试。'],
};
export function groupIssueText(issue: GroupIssue, zh: boolean): string {
 if ('en' in issue) return zh ? issue.zh : issue.en;
 const text = Object.hasOwn(errors, issue.code) ? errors[issue.code] : undefined;
 return text ? text[zh ? 1 : 0] : `${zh ? '无法完成群聊操作。' : 'The group action could not be completed.'} (${issue.code})`;
}
export const groupIssueTitle = (issue: GroupIssue) => 'code' in issue ? issue.code : undefined;

export type GroupComposerWarning = GroupIssue & { source: 'attach' | 'drop' };
export const groupAttachWarning: GroupComposerWarning = { source: 'attach', en: 'Choose a path inside the group folder or an HTTP(S) URL.', zh: '请选择群聊目录内的路径或 HTTP(S) 网址。' };
export const groupDropWarning: GroupComposerWarning = { source: 'drop', en: 'Drop a file path inside this group folder, or attach its relative path.', zh: '请拖入群聊目录中的文件路径，或附加其相对路径。' };
export type GroupWarningEvent = 'attach-edit' | 'attach-close' | 'include' | 'drop' | 'edit' | 'send' | 'dismiss';
export function clearGroupWarning(issue: GroupComposerWarning | undefined, event: GroupWarningEvent) {
 if (event === 'send' || event === 'dismiss' || event === 'include' || event === 'drop') return undefined;
 if (issue?.source === 'attach' && (event === 'attach-edit' || event === 'attach-close')) return undefined;
 if (issue?.source === 'drop' && (event === 'edit' || event === 'attach-edit')) return undefined;
 return issue;
}
export const groupAttachEscape = (event: { key: string; isComposing?: boolean; keyCode?: number }) => event.key === 'Escape' && !event.isComposing && event.keyCode !== 229;

export function groupReferenceTitle(ref: Pick<GroupReference, 'kind' | 'messageId' | 'path' | 'url'> & Partial<Pick<GroupReference, 'handle' | 'title'>>, messages: readonly GroupMessage[], zh: boolean) {
 if (ref.kind === 'file') return `${zh ? '文件' : 'File'} ${ref.path ?? ''}`;
 if (ref.kind === 'url') return zh ? '网址' : 'URL';
 if (ref.kind === 'message') return zh ? '引用的消息' : 'Quoted message';
 const message = messages.find(row => row.id === ref.messageId), saved = /^@([a-z0-9-]+)'s reply \(to: "(.*)"\)$/is.exec(ref.title ?? '');
 const topic = messages.find(row => row.id === message?.replyTo)?.body ?? saved?.[2] ?? '';
 const handle = message?.handle ?? ref.handle ?? saved?.[1] ?? (zh ? '成员' : 'member');
 return zh ? `@${handle} 的回复（回复：“${[...topic].slice(0, 80).join('')}”）` : `@${handle}'s reply (to: "${[...topic].slice(0, 80).join('')}")`;
}

/** Decode new structured system rows while preserving legacy stored prose. */
export function groupSystemMessage(body: string, zh: boolean): string {
 try {
  const value = JSON.parse(body) as { kind?: unknown; paths?: unknown };
  if (value.kind === 'read_only_files_changed' && Array.isArray(value.paths) && value.paths.every(path => typeof path === 'string')) {
   const paths = value.paths.join(', ');
   return zh
    ? `只读成员处理期间文件已更改：${paths}。并发文件夹更改不会归因于该成员；其“已更改”输出仅来自自身工具事件。`
    : `Files changed during a read-only member's turn: ${paths}. Concurrent folder changes are not attributed to this member; its Changed outputs come only from its own tool events.`;
  }
 } catch { /* Legacy system rows are stored prose. */ }
 return body;
}

export function groupReadOnlyNote(note: string | undefined, zh: boolean): string | undefined {
 if (!note || !zh) return note;
 if (note === 'The group member reports the requested native read-only mode') return '群聊成员已确认启用请求的原生只读模式。';
 if (note === 'Pi has no confirmed read-only launch restriction — update Pi for enforced read-only') return 'Pi 尚未确认只读启动限制，请更新 Pi 以启用强制只读。';
 return `只读模式状态详情。 (${note})`;
}
