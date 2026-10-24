import type { GroupPrerequisiteProvider, ProviderCapability, ProviderId } from "@threadterm/protocol";

export type GroupMemberMode = "default" | "read_only";
export type GroupDraftMember = { provider: ProviderId; handle: string; mode: GroupMemberMode };

export function groupProviders(capabilities: readonly ProviderCapability[]): ProviderId[] {
  return capabilities.filter(capability => capability.installed && capability.chat).map(capability => capability.id)
    .filter((id, index, all) => all.indexOf(id) === index);
}

export function usableGroupProviders(checks: readonly GroupPrerequisiteProvider[]): ProviderId[] {
  return checks.filter(check => check.usable).map(check => check.provider)
    .filter((id, index, all) => all.indexOf(id) === index);
}

export function defaultGroupMembers(providers: readonly ProviderId[]): GroupDraftMember[] {
  return providers[0] ? [{ provider: providers[0], handle: "", mode: "default" }] : [];
}

export function previewGroupHandles(members: readonly GroupDraftMember[]): string[] {
  const used = new Set(members.map(member => member.handle.trim().toLowerCase()).filter(Boolean));
  const counts = new Map<string, number>();
  return members.map(member => {
    const explicit = member.handle.trim().toLowerCase();
    if (explicit) return explicit;
    const base = member.provider.toLowerCase();
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    let candidate = count === 1 ? base : `${base}-${count}`;
    while (used.has(candidate)) { const next = (counts.get(base) ?? count) + 1; counts.set(base, next); candidate = `${base}-${next}`; }
    used.add(candidate);
    return candidate;
  });
}

export function groupHandleIssue(handle: string, previews: readonly string[], index: number): "invalid" | "duplicate" | undefined {
  const normalized = handle.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-z0-9-]{1,24}$/.test(normalized) || normalized === "all") return "invalid";
  return previews.filter((preview, current) => current !== index && preview === normalized).length ? "duplicate" : undefined;
}

export function canCreateGroup(members: readonly GroupDraftMember[], available: readonly ProviderId[]): boolean {
  const previews = previewGroupHandles(members);
  return members.length >= 1 && members.length <= 6
    && members.every((member, index) => available.includes(member.provider) && !groupHandleIssue(member.handle, previews, index));
}
