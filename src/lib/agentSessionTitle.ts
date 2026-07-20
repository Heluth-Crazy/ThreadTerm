import type { AgentSessionProvider, AgentSessionSummary, TitleKind } from '../types/agentSession';
import { AGENT_SESSION_PROVIDER_LABELS } from '../types/agentSession';

export interface DerivedSessionTitle {
  primary: string;
  secondary?: string;
  kind: TitleKind | 'fallback';
}

function suffixSessionId(id: string): string {
  return id.length <= 8 ? id : `…${id.slice(-5)}`;
}

function isGenericNativeTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'new session' ||
    normalized === 'new chat' ||
    normalized === 'untitled' ||
    normalized === 'untitled session'
  );
}

/**
 * Display priority:
 * 1. explicit native title
 * 2. first user message preview
 * 3. meaningful generated/unknown native title
 * 4. Provider · …idSuffix
 *
 * OpenCode keeps unknown provenance and may show native title + prompt subtitle.
 */
export function deriveAgentSessionTitle(
  summary: Pick<
    AgentSessionSummary,
    'provider' | 'id' | 'nativeTitle' | 'titleKind' | 'firstUserMessagePreview'
  >,
): DerivedSessionTitle {
  const providerLabel = AGENT_SESSION_PROVIDER_LABELS[summary.provider as AgentSessionProvider];
  const nativeTitle = summary.nativeTitle?.trim() || '';
  const preview = summary.firstUserMessagePreview?.trim() || '';

  if (summary.provider === 'opencode') {
    if (nativeTitle && !isGenericNativeTitle(nativeTitle)) {
      return {
        primary: nativeTitle,
        secondary: preview || undefined,
        kind: 'unknown',
      };
    }
    if (preview) {
      return { primary: preview, kind: 'firstPrompt' };
    }
    if (nativeTitle) {
      return { primary: nativeTitle, kind: 'unknown' };
    }
    return {
      primary: `${providerLabel} · ${suffixSessionId(summary.id)}`,
      kind: 'fallback',
    };
  }

  if (summary.titleKind === 'explicit' && nativeTitle) {
    return {
      primary: nativeTitle,
      secondary: preview || undefined,
      kind: 'explicit',
    };
  }

  if (preview) {
    return {
      primary: preview,
      secondary:
        nativeTitle && !isGenericNativeTitle(nativeTitle) ? nativeTitle : undefined,
      kind: 'firstPrompt',
    };
  }

  if (nativeTitle && !isGenericNativeTitle(nativeTitle)) {
    return {
      primary: nativeTitle,
      kind: summary.titleKind === 'generated' ? 'generated' : 'unknown',
    };
  }

  return {
    primary: `${providerLabel} · ${suffixSessionId(summary.id)}`,
    kind: 'fallback',
  };
}

export function agentSessionSelectionKey(
  provider: AgentSessionProvider,
  id: string,
): string {
  return `${provider}\0${id}`;
}
