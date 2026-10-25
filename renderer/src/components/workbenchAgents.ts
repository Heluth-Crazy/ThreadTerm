import type { ProviderCapability, ProviderId } from "@threadterm/protocol";
import { agentIds, agentName } from "../agents";
import { providerReadiness, type ProviderReadinessMode } from "../providerReadiness";

export type WorkbenchAgent = {
  id: ProviderId;
  name: string;
  available: boolean;
  hint?: string;
};

export function workbenchAgentName(id: ProviderId, zh: boolean, capabilities: readonly ProviderCapability[] = []): string {
  if (id === "custom") return zh ? "预设" : "Preset";
  return agentName(id, capabilities);
}

export function workbenchAgents(
  capabilities: readonly ProviderCapability[],
  zh: boolean,
  mode: ProviderReadinessMode = "terminal",
): WorkbenchAgent[] {
  const indexed = new Map(capabilities.map((capability) => [capability.id, capability]));
  return [...agentIds(capabilities), "shell", "custom"].map((id) => {
    const name = workbenchAgentName(id, zh, capabilities);
    if (id === "shell" || id === "custom") return { id, name, available: true };
    const capability = indexed.get(id);
    const readiness = providerReadiness(capability, mode, zh);
    if (readiness.available) {
      return { id, name, available: true };
    }
    return {
      id,
      name,
      available: false,
      hint: readiness.reason,
    };
  });
}
