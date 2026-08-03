import {
  isAgentSessionProvider,
  type AgentSessionProvider,
} from '../types/agentSession';
import type { TerminalCard, TerminalType } from '../types/terminal';

export type TerminalLaunchMode = 'default' | 'resume' | 'custom';
export type TerminalWorkspaceMode = 'current' | 'session';

export type TerminalLaunchConfiguration =
  | {
      terminalType: TerminalType;
      launchMode: 'default';
    }
  | {
      terminalType: TerminalType;
      launchMode: 'custom';
      command: string;
    }
  | {
      terminalType: AgentSessionProvider;
      launchMode: 'resume';
      providerSessionId: string;
      workspaceMode: TerminalWorkspaceMode;
      sessionProjectPath?: string;
    };

export interface TerminalLaunchConfigurationDraft {
  terminalType: TerminalType;
  launchMode: TerminalLaunchMode;
  command?: string | null;
  providerSessionId?: string | null;
  workspaceMode?: TerminalWorkspaceMode | null;
  sessionProjectPath?: string | null;
}

export type TerminalConfigurationValidationError =
  | 'command-required'
  | 'agent-required'
  | 'session-id-required'
  | 'session-id-invalid'
  | 'session-project-required';

export type TerminalConfigurationValidationResult =
  | { ok: true; value: TerminalLaunchConfiguration }
  | { ok: false; error: TerminalConfigurationValidationError };

export interface TerminalSessionBindingConflict {
  cardId: string;
  archived: boolean;
}

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_SESSION_ID_LENGTH = 256;

export function isAgentTerminalType(
  terminalType: TerminalType,
): terminalType is AgentSessionProvider {
  return isAgentSessionProvider(terminalType);
}

export function isSafeProviderSessionId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0
    && trimmed.length <= MAX_SESSION_ID_LENGTH
    && SAFE_SESSION_ID_PATTERN.test(trimmed)
  );
}

export function normalizeTerminalLaunchConfiguration(
  draft: TerminalLaunchConfigurationDraft,
): TerminalConfigurationValidationResult {
  if (draft.launchMode === 'custom') {
    const command = draft.command ?? '';
    return command.trim()
      ? {
          ok: true,
          value: {
            terminalType: draft.terminalType,
            launchMode: 'custom',
            command,
          },
        }
      : { ok: false, error: 'command-required' };
  }

  if (draft.launchMode === 'resume') {
    if (!isAgentTerminalType(draft.terminalType)) {
      return { ok: false, error: 'agent-required' };
    }
    const providerSessionId = draft.providerSessionId?.trim() ?? '';
    if (!providerSessionId) {
      return { ok: false, error: 'session-id-required' };
    }
    if (!isSafeProviderSessionId(providerSessionId)) {
      return { ok: false, error: 'session-id-invalid' };
    }

    const workspaceMode = draft.workspaceMode === 'session' ? 'session' : 'current';
    const sessionProjectPath = draft.sessionProjectPath?.trim() || undefined;
    if (workspaceMode === 'session' && !sessionProjectPath) {
      return { ok: false, error: 'session-project-required' };
    }

    return {
      ok: true,
      value: {
        terminalType: draft.terminalType,
        launchMode: 'resume',
        providerSessionId,
        workspaceMode,
        ...(sessionProjectPath ? { sessionProjectPath } : {}),
      },
    };
  }

  return {
    ok: true,
    value: {
      terminalType: draft.terminalType,
      launchMode: 'default',
    },
  };
}

export function terminalLaunchConfigurationFromCard(
  card: Pick<
    TerminalCard,
    'terminalType' | 'command' | 'providerSessionId' | 'providerSessionState'
  >,
): TerminalLaunchConfiguration {
  const command = card.command;
  if (command?.trim()) {
    return {
      terminalType: card.terminalType,
      launchMode: 'custom',
      command,
    };
  }

  if (
    isAgentTerminalType(card.terminalType)
    && card.providerSessionState === 'bound'
    && card.providerSessionId?.trim()
  ) {
    return {
      terminalType: card.terminalType,
      launchMode: 'resume',
      providerSessionId: card.providerSessionId.trim(),
      workspaceMode: 'current',
    };
  }

  return {
    terminalType: card.terminalType,
    launchMode: 'default',
  };
}

export function terminalLaunchConfigurationsEqual(
  left: TerminalLaunchConfiguration,
  right: TerminalLaunchConfiguration,
): boolean {
  if (
    left.terminalType !== right.terminalType
    || left.launchMode !== right.launchMode
  ) {
    return false;
  }
  if (left.launchMode === 'custom' && right.launchMode === 'custom') {
    return left.command === right.command;
  }
  if (left.launchMode === 'resume' && right.launchMode === 'resume') {
    return (
      left.providerSessionId === right.providerSessionId
      && left.workspaceMode === right.workspaceMode
      && (
        left.workspaceMode !== 'session'
        || (left.sessionProjectPath ?? '') === (right.sessionProjectPath ?? '')
      )
    );
  }
  return left.launchMode === 'default' && right.launchMode === 'default';
}

export function findTerminalSessionBindingConflict(
  cards: readonly Pick<
    TerminalCard,
    'id' | 'terminalType' | 'providerSessionId'
  >[],
  archivedCards: readonly (Pick<
    TerminalCard,
    'id' | 'terminalType' | 'providerSessionId'
  > & { archivedAt: number })[],
  provider: AgentSessionProvider,
  providerSessionId: string,
  excludeCardId?: string,
): TerminalSessionBindingConflict | null {
  const sessionId = providerSessionId.trim();
  if (!sessionId) return null;

  const active = cards.find(
    (card) =>
      card.id !== excludeCardId
      && card.terminalType === provider
      && card.providerSessionId?.trim() === sessionId,
  );
  if (active) return { cardId: active.id, archived: false };

  const archived = archivedCards.find(
    (card) =>
      card.id !== excludeCardId
      && card.terminalType === provider
      && card.providerSessionId?.trim() === sessionId,
  );
  return archived
    ? { cardId: archived.id, archived: true }
    : null;
}

export function parsePersistedTerminalLaunchConfiguration(
  value: unknown,
): TerminalLaunchConfiguration | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.terminalType !== 'string') return null;
  const terminalType = record.terminalType as TerminalType;
  const validTerminalTypes: TerminalType[] = [
    'shell',
    'claude',
    'codex',
    'opencode',
    'gemini',
    'kimi',
    'grok',
    'npm',
    'yarn',
    'pnpm',
    'docker',
    'python',
    'node',
    'custom',
  ];
  if (!validTerminalTypes.includes(terminalType)) return null;
  if (
    record.launchMode !== 'default'
    && record.launchMode !== 'resume'
    && record.launchMode !== 'custom'
  ) {
    return null;
  }

  const result = normalizeTerminalLaunchConfiguration({
    terminalType,
    launchMode: record.launchMode,
    command: typeof record.command === 'string' ? record.command : null,
    providerSessionId:
      typeof record.providerSessionId === 'string'
        ? record.providerSessionId
        : null,
    workspaceMode:
      record.workspaceMode === 'session' || record.workspaceMode === 'current'
        ? record.workspaceMode
        : null,
    sessionProjectPath:
      typeof record.sessionProjectPath === 'string'
        ? record.sessionProjectPath
        : null,
  });
  return result.ok ? result.value : null;
}
