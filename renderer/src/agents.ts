import type { ProviderCapability, ProviderId } from "@threadterm/protocol";

const builtinOrder = ["codex", "claude", "kimi", "gemini", "opencode", "grok"];

export function agentName(id: string, capabilities: readonly ProviderCapability[] = []): string {
  const name = capabilities.find(capability => capability.id === id)?.name;
  if (name?.trim()) return name;
  if (id === "claude") return "Claude Code";
  if (id === "opencode") return "OpenCode";
  return id ? id[0].toUpperCase() + id.slice(1) : "";
}

export function agentIds(capabilities: readonly ProviderCapability[]): ProviderId[] {
  const ids = [...new Set(capabilities.map(capability => capability.id))].filter(id => id !== "shell" && id !== "custom");
  const rank = (id: string) => { const index = builtinOrder.indexOf(id); return index < 0 ? builtinOrder.length : index; };
  return ids.sort((left, right) => rank(left) - rank(right)
    || agentName(left, capabilities).localeCompare(agentName(right, capabilities), "en", { sensitivity: "base" })
    || left.localeCompare(right, "en"));
}
