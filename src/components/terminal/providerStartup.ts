import { isAgentSessionProvider, type AgentSessionProvider } from '../../types/agentSession';
import type {
  PtyProviderStartupIntent,
  PtyStartupIntent,
} from '../../types/ptyStartup';
import type { ProviderSessionLaunchAction, TerminalLaunchCommand } from './providerSession';

function isProviderAction(value: unknown): value is ProviderSessionLaunchAction {
  return value === 'start' || value === 'resume' || value === 'discover';
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Converts an already-validated built-in Provider launch into the additive v2
 * startup descriptor. Custom commands intentionally return null.
 */
export function buildProviderStartupIntent(
  cardId: string,
  launch: TerminalLaunchCommand,
): PtyProviderStartupIntent | null {
  if (!launch || !hasText(cardId) || !hasText(launch.command)) return null;

  const provider: AgentSessionProvider | undefined =
    typeof launch.provider === 'string' && isAgentSessionProvider(launch.provider)
      ? launch.provider
      : undefined;
  if (!provider || !isProviderAction(launch.action)) return null;

  const sideEffectPlan = hasText(launch.providerSessionId)
    ? { kind: 'bind' as const, providerSessionId: launch.providerSessionId }
    : { kind: 'discover' as const };

  return {
    kind: 'provider',
    provider,
    command: launch.command,
    cardId,
    action: launch.action,
    sideEffectPlan,
  } satisfies PtyStartupIntent;
}
