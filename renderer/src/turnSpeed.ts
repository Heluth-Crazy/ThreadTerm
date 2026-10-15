import type { ChatContextUsage } from '@threadterm/protocol';
import type { CodexTurn } from './codexTranscript';

export type TurnSpeed = { tokensPerSecond: number; estimated: boolean; firstTokenMs?: number };
export type LiveTurnUsage = { turnId: string; usage: ChatContextUsage };
export type TurnSpeedEvent = { turnId: string; active: boolean; usage?: ChatContextUsage };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Converts saved or live turn usage into the small, comparable token-rate display. */
export function turnSpeed(usage: ChatContextUsage | undefined): TurnSpeed | undefined {
  if (!usage || !finite(usage.outputTokens) || !finite(usage.generationMs) || usage.outputTokens < 1 || usage.generationMs < 250) return undefined;
  return {
    tokensPerSecond: Math.round(usage.outputTokens / (usage.generationMs / 1_000)),
    estimated: usage.outputTokensEstimated === true,
    ...(finite(usage.firstTokenMs) && usage.firstTokenMs >= 0 ? { firstTokenMs: usage.firstTokenMs } : {}),
  };
}

/** A speed event belongs only to the current live turn; old turn events must not linger. */
export function liveTurnSpeed(activeTurnId: string | undefined, live: LiveTurnUsage | undefined): TurnSpeed | undefined {
  return activeTurnId && live?.turnId === activeTurnId ? turnSpeed(live.usage) : undefined;
}

/** One live indicator per pane, on the last group belonging to the measured turn. */
export function liveSpeedGroupIndex(groups: readonly Pick<CodexTurn, 'items' | 'settled'>[], turnId: string | undefined): number {
  if (!turnId) return -1;
  const index = groups.findLastIndex(group => group.items.some(item => item.turnId === turnId));
  return index >= 0 && !groups[index]!.settled ? index : -1;
}

/** Tool and user-wait transitions retain the active turn but deliberately clear its stale rate. */
export function nextLiveTurnUsage(current: LiveTurnUsage | undefined, event: TurnSpeedEvent): LiveTurnUsage | undefined {
  if (event.active && event.usage) return { turnId: event.turnId, usage: event.usage };
  return !event.active && current?.turnId !== event.turnId ? current : undefined;
}

export function turnSpeedText(speed: TurnSpeed): string {
  return `${speed.estimated ? '≈ ' : ''}${speed.tokensPerSecond} tok/s`;
}

function firstTokenDuration(value: number): string {
  return `${Number((value / 1_000).toFixed(1))} s`;
}

export function turnSpeedTooltip(speed: TurnSpeed, zh: boolean): string {
  const detail = speed.firstTokenMs === undefined ? '' : zh ? ` 首个令牌在 ${firstTokenDuration(speed.firstTokenMs)} 后到达。` : ` First token after ${firstTokenDuration(speed.firstTokenMs)}.`;
  const estimated = speed.estimated ? zh ? ' 此提供方不报告令牌数；已根据流式文本估算。' : ' This provider reports no token count; estimated from the streamed text.' : '';
  return (zh ? '模型生成期间的每秒输出令牌数（不含工具运行和等待）。' : 'Output tokens per second while the model was generating (tool runs and waits excluded).') + detail + estimated;
}
