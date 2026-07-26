import type { TerminalCard } from '../../types/terminal';
import type { CodexAppRequestPayload } from '../tauri-bridge';
import { getString } from './normalize';

export interface PendingCodexRequest {
  key: string;
  requestId: unknown;
  cardId: string;
  threadId: string | null;
  method: string;
  params: unknown;
  raw: unknown;
  createdAt: number;
  notificationId: string | null;
}
export type CodexRequestKind = 'approval' | 'waiting_input';

export function codexRequestKey(requestId: unknown): string {
  if (typeof requestId === 'string' || typeof requestId === 'number') {
    return String(requestId);
  }
  try {
    return JSON.stringify(requestId);
  } catch {
    return String(requestId);
  }
}

export function codexRequestThreadId(params: unknown): string | null {
  return getString(params, 'threadId') ?? null;
}

export function resolveCodexRequestCardId(
  payload: Pick<CodexAppRequestPayload, 'cardId' | 'params'>,
  cards: readonly Pick<TerminalCard, 'id' | 'codexAppThreadId'>[],
): string | null {
  if (payload.cardId && cards.some((card) => card.id === payload.cardId)) {
    return payload.cardId;
  }

  const threadId = codexRequestThreadId(payload.params);
  if (!threadId) return null;
  return cards.find((card) => card.codexAppThreadId === threadId)?.id ?? null;
}

export function classifyCodexRequest(method: string): CodexRequestKind {
  const normalized = method.toLocaleLowerCase();
  if (
    normalized.includes('requestapproval') ||
    normalized.includes('permission') ||
    normalized.includes('applypatch')
  ) {
    return 'approval';
  }
  return 'waiting_input';
}

export function summarizeCodexRequest(params: unknown, maxLength = 180): string {
  const candidates = [
    getString(params, 'command'),
    getString(params, 'prompt'),
    getString(params, 'question'),
    getString(params, 'reason'),
    getString(params, 'message'),
    getString(params, 'cwd'),
  ];
  const summary = candidates.find((candidate) => candidate?.trim())?.trim() ?? '';
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
