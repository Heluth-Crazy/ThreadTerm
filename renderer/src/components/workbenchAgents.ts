import type { ProviderCapability, ProviderId } from "@threadterm/protocol";
import { agentIds, agentName } from "../agents";

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
): WorkbenchAgent[] {
  const indexed = new Map(capabilities.map((capability) => [capability.id, capability]));
  return [...agentIds(capabilities), "shell", "custom"].map((id) => {
    const name = workbenchAgentName(id, zh, capabilities);
    if (id === "shell" || id === "custom") return { id, name, available: true };
    const capability = indexed.get(id);
    if (capability?.installed && capability.terminal) {
      return { id, name, available: true };
    }
    return {
      id,
      name,
      available: false,
      hint: capability?.installed ? (zh ? "不支持终端" : "Terminal unavailable") : (zh ? "未安装" : "Not installed"),
    };
  });
}
