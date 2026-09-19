import type { ProviderCapability, ProviderId } from "@threadterm/protocol";

export const WORKBENCH_AGENTS: ProviderId[] = [
  "codex",
  "claude",
  "kimi",
  "gemini",
  "opencode",
  "grok",
  "shell",
  "custom",
];

export type WorkbenchAgent = {
  id: ProviderId;
  name: string;
  available: boolean;
  hint?: string;
};

export function workbenchAgentName(id: ProviderId, zh: boolean): string {
  if (id === "custom") return zh ? "预设" : "Preset";
  if (id === "claude") return "Claude";
  if (id === "opencode") return "OpenCode";
  return id[0].toUpperCase() + id.slice(1);
}

export function workbenchAgents(
  capabilities: readonly ProviderCapability[],
  zh: boolean,
): WorkbenchAgent[] {
  const indexed = new Map(capabilities.map((capability) => [capability.id, capability]));
  return WORKBENCH_AGENTS.map((id) => {
    const name = workbenchAgentName(id, zh);
    if (id === "shell" || id === "custom") return { id, name, available: true };
    const capability = indexed.get(id);
    if (capability?.installed) {
      return { id, name: capability.name || name, available: true };
    }
    if (id === "grok" && !capability) {
      return { id, name, available: false, hint: zh ? "即将支持" : "Coming soon" };
    }
    return {
      id,
      name: capability?.name || name,
      available: false,
      hint: zh ? "未安装" : "Not installed",
    };
  });
}
