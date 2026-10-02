import type { ProviderCapability, ProviderId } from "@threadterm/protocol";

export const ACCOUNT_PROVIDERS = ["codex", "claude", "kimi", "gemini", "opencode"] as const;
export type AccountProviderId = (typeof ACCOUNT_PROVIDERS)[number];

export type SignInTerminal = Readonly<{
  provider: "custom";
  executable: string;
  args: readonly string[];
}>;

// These commands are limited to the installed CLIs whose read-only `--help`
// output explicitly documents an interactive login command.
const signInTerminals: Readonly<Partial<Record<AccountProviderId, SignInTerminal>>> = {
  codex: { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "codex login"] },
  claude: { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "claude auth login"] },
  kimi: { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "kimi login"] },
  opencode: { provider: "custom", executable: "cmd.exe", args: ["/D", "/S", "/C", "opencode providers login"] },
};

export function signInTerminal(provider: ProviderId): SignInTerminal | undefined {
  return signInTerminals[provider as AccountProviderId];
}

export function accountProviders(capabilities: readonly ProviderCapability[]): ProviderCapability[] {
  const indexed = new Map(capabilities.map((capability) => [capability.id, capability]));
  return ACCOUNT_PROVIDERS.map((id) => indexed.get(id) ?? {
    id,
    name: providerName(id),
    installed: false,
    terminal: false,
    chat: false,
    history: false,
    resume: false,
    auth: "unknown",
    reason: "Capability information is unavailable.",
  });
}

export function providerName(id: AccountProviderId): string {
  return ({ codex: "Codex", claude: "Claude", kimi: "Kimi", gemini: "Gemini", opencode: "OpenCode" })[id];
}
