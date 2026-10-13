import type { ChatBackgroundTask, ChatItem } from '@threadterm/protocol';
import { subagentInfo } from './subagentActivity';

/** Pure render-time duration; terminal events freeze the end. No clock subscription. */
export function backgroundElapsed(task: ChatBackgroundTask, now: number): number | undefined {
  if (!task.startedAt) return undefined;
  const start = Date.parse(task.startedAt);
  const end = task.endedAt ? Date.parse(task.endedAt) : task.status === 'running' ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

/** Match runtime-authored identity, never provider names, titles or command text. */
export function backgroundHasOutput(task: ChatBackgroundTask, items: readonly ChatItem[]): boolean {
  const id = task.toolId ?? task.id;
  return items.some(item => item.parts.some(part => part.toolId === id
    || (part.type === 'subagent' && subagentInfo(part)?.key === id)));
}

export function backgroundOutputTarget(root: HTMLElement, task: ChatBackgroundTask): HTMLElement | undefined {
  const id = task.toolId ?? task.id;
  return Array.from(root.querySelectorAll<HTMLElement>('[data-tool-id], [data-subagent-key]'))
    .find(node => node.dataset.toolId === id || node.dataset.subagentKey === id);
}

/** Native disclosures keep their existing React state; pause follow before changing their layout. */
export function revealBackgroundOutput(root: HTMLElement, task: ChatBackgroundTask, inspect: () => void): boolean {
  const target = backgroundOutputTarget(root, task);
  if (!target) return false;
  inspect();
  const ancestors: HTMLDetailsElement[] = [];
  for (let node: HTMLElement | null = target; node && node !== root; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) ancestors.unshift(node);
  }
  // Subagent cards own their details child; tool entries own their ancestor.
  const own = target.querySelector<HTMLDetailsElement>(':scope > details');
  if (own && !own.open) ancestors.push(own);
  for (const details of ancestors) details.querySelector<HTMLElement>(':scope > summary')?.click();
  requestAnimationFrame(() => {
    if (!target.isConnected) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  });
  return true;
}
