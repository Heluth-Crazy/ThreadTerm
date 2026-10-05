import type { ProviderCapability, ProviderId } from "@threadterm/protocol";
import { agentIds, agentName } from "../agents";

export type SignInTerminal = Readonly<{
  provider: "custom";
  executable: string;
  args: readonly string[];
}>;

export function signInTerminal(capability: ProviderCapability): SignInTerminal | undefined {
  if (!capability.installed || !capability.signIn) return undefined;
  return { provider: "custom", executable: capability.signIn.executable, args: [...capability.signIn.args] };
}

export function accountProviders(capabilities: readonly ProviderCapability[]): ProviderCapability[] {
  const indexed = new Map(capabilities.map((capability) => [capability.id, capability]));
  return agentIds(capabilities).map(id => ({ ...indexed.get(id)!, name: providerName(id, capabilities) }));
}

export function providerName(id: ProviderId, capabilities: readonly ProviderCapability[] = []): string {
  return agentName(id, capabilities);
}
