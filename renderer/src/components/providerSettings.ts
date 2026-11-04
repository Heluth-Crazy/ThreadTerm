import type { ProviderCapability, ProviderId } from "@threadterm/protocol";
import { agentIds, agentName } from "../agents";
import { isRemoteFiles } from "../remoteFiles";

export type SignInTerminal = Readonly<{
  provider: "custom";
  executable: string;
  args: readonly string[];
}>;

export function signInTerminal(capability: ProviderCapability, remote = isRemoteFiles()): SignInTerminal | undefined {
  const command = remote ? capability.remoteSignIn ?? capability.signIn : capability.signIn;
  if (!capability.installed || !command) return undefined;
  return { provider: "custom", executable: command.executable, args: [...command.args] };
}

export function accountProviders(capabilities: readonly ProviderCapability[]): ProviderCapability[] {
  const indexed = new Map(capabilities.map((capability) => [capability.id, capability]));
  return agentIds(capabilities).map(id => ({ ...indexed.get(id)!, name: providerName(id, capabilities) }));
}

export function providerName(id: ProviderId, capabilities: readonly ProviderCapability[] = []): string {
  return agentName(id, capabilities);
}
