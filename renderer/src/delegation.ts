import type { ChatItem, ChatPart, Session, SessionDelegationState } from '@threadterm/protocol';

const DELEGATION_TOOLS = ['delegate_start', 'delegate_status', 'delegate_wait', 'delegate_respond', 'delegate_result', 'delegate_cancel'] as const;
export type DelegationTool = typeof DELEGATION_TOOLS[number];

/**
 * ThreadTerm's own delegation tool behind a chat tool part: `mcp__threadterm__<tool>`
 * (Claude, ACP agents), `threadterm__<tool>` (Grok) or a Codex `mcpToolCall` item on the
 * `threadterm` server.
 */
export function delegationTool(part: Pick<ChatPart, 'toolName' | 'data'>): DelegationTool | undefined {
  const data = part.data && typeof part.data === 'object' ? part.data as { server?: unknown; tool?: unknown } : {};
  const name = data.server === 'threadterm' && typeof data.tool === 'string'
    ? data.tool
    : /^(?:mcp__)?threadterm__(\w+)$/.exec(part.toolName ?? '')?.[1];
  return DELEGATION_TOOLS.find(tool => tool === name);
}

export function delegationToolLabel(tool: DelegationTool, copy: (en: string, zh: string) => string): string {
  switch (tool) {
    case 'delegate_start': return copy('Started a delegate', '启动了委派');
    case 'delegate_status': return copy('Checked delegates', '查看了委派状态');
    case 'delegate_wait': return copy('Waited for delegates', '等待了委派');
    case 'delegate_respond': return copy("Answered a delegate's request", '答复了委派的请求');
    case 'delegate_result': return copy("Read a delegate's result", '读取了委派结果');
    case 'delegate_cancel': return copy('Stopped a delegate', '停止了委派');
  }
}

/** A delegation that has not finished (its delegated turn is still going, or a stop is unconfirmed). */
export function delegationActive(state: SessionDelegationState): boolean {
  return state === 'starting' || state === 'running' || state === 'awaiting_parent' || state === 'awaiting_user'
    || state === 'cancelling' || state === 'cancel_failed';
}

export function delegationStateLabel(state: SessionDelegationState, zh: boolean): string {
  return zh
    ? ({ starting: '启动中', running: '执行中', awaiting_parent: '等待委派方', awaiting_user: '待你处理', cancelling: '停止中', cancel_failed: '停止失败', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[state]
    : ({ starting: 'Starting', running: 'Running', awaiting_parent: 'Waiting for parent agent', awaiting_user: 'Needs you', cancelling: 'Stopping', cancel_failed: 'Stop failed', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' })[state];
}

/** Ordered, compact status groups for the parent Chat's delegation strip. */
export function delegationStateSummary(delegates: readonly Session[], copy: (en: string, zh: string) => string): { state: SessionDelegationState; label: string }[] {
  const counts = new Map<SessionDelegationState, number>();
  for (const delegate of delegates) {
    const state = delegate.delegation?.state;
    if (state) {
      const group = state === 'starting' ? 'running' : state;
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
  }
  const order: SessionDelegationState[] = ['awaiting_user', 'cancel_failed', 'cancelling', 'awaiting_parent', 'running', 'failed', 'interrupted', 'cancelled', 'completed'];
  return order.flatMap(state => {
    const count = counts.get(state);
    if (!count) return [];
    const label = {
      awaiting_user: copy(`${count} ${count === 1 ? 'needs' : 'need'} you`, `${count} 个待你处理`),
      cancel_failed: copy(`${count} stop failed`, `${count} 个停止失败`),
      cancelling: copy(`${count} stopping`, `${count} 个停止中`),
      awaiting_parent: copy(`${count} waiting for parent`, `${count} 个等待委派方`),
      running: copy(`${count} running`, `${count} 个执行中`),
      failed: copy(`${count} failed`, `${count} 个失败`),
      interrupted: copy(`${count} interrupted`, `${count} 个已中断`),
      cancelled: copy(`${count} cancelled`, `${count} 个已取消`),
      completed: copy(`${count} completed`, `${count} 个已完成`),
      starting: '',
    }[state];
    return [{ state, label }];
  });
}

/** A hidden finished set resurfaces for a new delegate or renewed activity. */
export function delegationStripVisible(hiddenIds: readonly string[] | undefined, delegates: readonly Session[]): boolean {
  const hidden = new Set(hiddenIds);
  return delegates.some(delegate => !hidden.has(delegate.id) || (delegate.delegation && delegationActive(delegate.delegation.state)));
}

/**
 * A delegate card's note that ThreadTerm sent some of the user's own messages
 * from this chat, word for word, to the delegate (its first message shows them).
 */
export function attachedMessagesLabel(count: number, copy: (en: string, zh: string) => string): { label: string; title: string } {
  return {
    label: copy(`${count} of your messages attached`, `已附上你的 ${count} 条消息`),
    title: copy(
      'ThreadTerm sent these messages from this chat to the delegate word for word. Open the delegate to read them.',
      'ThreadTerm 已把本对话中的这些消息原样发给委派代理。打开委派会话即可查看。',
    ),
  };
}

/**
 * What a finished delegate's card previews from its chat: its last assistant
 * text, or the error it failed with (its last text when it has no error).
 */
export function delegateOutcomePreview(items: readonly ChatItem[], failed: boolean, limit = 280): string | undefined {
  const last = (type: 'text' | 'error') => [...items].reverse()
    .filter(item => item.role === 'assistant')
    .flatMap(item => item.parts.filter(part => part.type === type && part.text?.trim()).map(part => part.text!.trim()))
    .find(Boolean);
  const text = (failed && last('error')) || last('text');
  return text && text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Sessions that some shown session delegated, i.e. render nested under it. */
export function nestedDelegateIds(sessions: readonly Session[]): Set<string> {
  const shown = new Set(sessions.map(session => session.id));
  return new Set(sessions.filter(session => session.delegation && shown.has(session.delegation.parentSessionId)).map(session => session.id));
}

/**
 * Orders one rendered list so each delegate follows its parent (one level),
 * wherever the delegate's folder is. `all` is every session the catalog shows
 * for the project; delegates whose parent is not shown stay where they are.
 */
export function withDelegates<T extends Session>(list: readonly T[], all: readonly T[]): T[] {
  const nested = nestedDelegateIds(all);
  return list
    .filter(session => !nested.has(session.id))
    .flatMap(parent => [
      parent,
      ...all
        .filter(child => child.delegation?.parentSessionId === parent.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    ]);
}
