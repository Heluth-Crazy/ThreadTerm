import type { ChatItem, PaneLayout } from '@threadterm/protocol';
import type { ChatPresentationIndex } from './chatPresentation';

// `index` is the per-revision presentation pass from ChatView: fork completion is a
// per-item turn lookup, so it must not rescan the transcript for every reply.
export function isCompletedForkReply(item: ChatItem, items: readonly ChatItem[] = [item], index?: ChatPresentationIndex): boolean {
  if (item.role !== 'assistant'
    || !item.parts.some(part => part.type === 'text' && part.phase !== 'commentary' && (part.data as {kind?: unknown} | undefined)?.kind !== 'plan' && Boolean(part.text?.trim()))
    || item.parts.some(part => ['streaming','running','pending'].includes(part.status ?? ''))) return false;
  // A provider can publish a separate completion boundary for the same turn.
  // Absence alone never proves completion; an explicit non-success wins.
  const outcome = item.turnId ? index?.outcomes.get(item.turnId) : undefined;
  if (outcome) return !outcome.notCompleted && (outcome.completed || item.turnOrigin === 'history');
  const turn = item.turnId ? items.filter(candidate => candidate.turnId === item.turnId) : [item];
  if (turn.some(candidate => candidate.turnStatus && candidate.turnStatus !== 'completed')) return false;
  return turn.some(candidate => candidate.turnStatus === 'completed') || item.turnOrigin === 'history';
}

/** Insert and select a fork in the originating pane; preserve every other tab. */
export function openForkInPane(layout: PaneLayout, paneId: string, sessionId: string): PaneLayout {
  if (layout.kind === 'pane') {
    if (layout.id !== paneId) return layout;
    const existing = layout.tabs.find(tab => tab.kind === 'session' && tab.sessionId === sessionId);
    const tab = existing ?? { kind: 'session' as const, id: `session:${sessionId}`, sessionId };
    return { ...layout, tabs: existing ? layout.tabs : [...layout.tabs, tab], activeTabId: tab.id };
  }
  const first = openForkInPane(layout.first, paneId, sessionId);
  const second = openForkInPane(layout.second, paneId, sessionId);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Clear only the composer text captured when /fork started. Later typing stays. */
export function composerTextAfterFork(current: string, capturedAtStart: string): string {
  return current === capturedAtStart ? '' : current;
}

export function forkDisabledReason(running: boolean, busy: boolean, zh: boolean): string | undefined {
  if (running) return zh ? '运行期间无法分叉' : "Can't fork while a turn is running";
  if (busy) return zh ? '正在分叉…' : 'Forking…';
  return undefined;
}

export type ForkMode = 'native' | 'copy';
const notices = new Map<string, ForkMode>();
/** Action-scoped handoff to the new tab, with no global listeners or timers. */
export function rememberForkNotice(id: string, mode: ForkMode) {
  notices.set(id, mode);
  if (notices.size > 64) notices.delete(notices.keys().next().value!);
}
export function takeForkNotice(id: string) {
  const mode = notices.get(id); notices.delete(id); return mode;
}
export function peekForkNotice(id: string) { return notices.get(id); }
