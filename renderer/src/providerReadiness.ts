import type { ProviderCapability, ProviderId } from "@threadterm/protocol";
import { signInTerminal } from "./components/providerSettings";
import { runtimeText } from "./contextErrors";

export type ProviderReadinessMode = "chat" | "terminal" | "preferred";
export type ProviderReadiness = {
  available: boolean;
  mode: "chat" | "terminal";
  reason?: string;
  action?: "install" | "signIn" | "settings";
  actionLabel?: string;
  homepage?: string;
};

export function providerReadiness(
  capability: ProviderCapability | undefined,
  requestedMode: ProviderReadinessMode,
  zh: boolean,
): ProviderReadiness {
  const mode = requestedMode === "preferred" ? (capability?.chat ? "chat" : "terminal") : requestedMode;
  if (!capability) return unavailableStatusReadiness(mode, zh);
  if (capability?.id === "shell" || capability?.id === "custom") return { available: true, mode: "terminal" };
  if (!capability.installed) return missingReadiness(mode, capability.homepage, zh);
  if (capability.auth === "unauthenticated") return signedOutReadiness(mode, capability, zh);
  if ((mode === "chat" ? capability.chat : capability.terminal)) return { available: true, mode };
  return unsupportedReadiness(mode, capability.reason, zh);
}

function unavailableStatusReadiness(mode: "chat" | "terminal", zh: boolean): ProviderReadiness {
  return { available: false, mode, reason: zh ? "提供商状态不可用" : "Provider status unavailable", action: "settings", actionLabel: zh ? "打开提供商设置" : "Open provider settings" };
}

export function firstReadyAgent(capabilities: readonly ProviderCapability[]): ProviderId | undefined {
  const agents = capabilities.filter(capability => capability.id !== "shell" && capability.id !== "custom");
  const codex = agents.find(capability => capability.id === "codex" && providerReadiness(capability, "preferred", false).available);
  return codex?.id ?? agents.find(capability => providerReadiness(capability, "preferred", false).available)?.id;
}

function missingReadiness(mode: "chat" | "terminal", homepage: string | undefined, zh: boolean): ProviderReadiness {
  if (homepage) return { available: false, mode, reason: zh ? "未安装" : "Not installed", action: "install", actionLabel: zh ? "安装…" : "Install…", homepage };
  return { available: false, mode, reason: zh ? "未安装" : "Not installed", action: "settings", actionLabel: zh ? "打开提供商设置" : "Open provider settings" };
}

function signedOutReadiness(mode: "chat" | "terminal", capability: ProviderCapability, zh: boolean): ProviderReadiness {
  if (signInTerminal(capability)) return { available: false, mode, reason: zh ? "未登录" : "Signed out", action: "signIn", actionLabel: zh ? "登录" : "Sign in" };
  return { available: false, mode, reason: zh ? "未登录" : "Signed out", action: "settings", actionLabel: zh ? "打开提供商设置" : "Open provider settings" };
}

function unsupportedReadiness(mode: "chat" | "terminal", reason: string | undefined, zh: boolean): ProviderReadiness {
  return {
    available: false,
    mode,
    reason: (reason && runtimeText(reason, zh)) || (mode === "chat" ? (zh ? "不支持聊天模式" : "Chat unavailable") : (zh ? "不支持终端" : "Terminal unavailable")),
    action: "settings",
    actionLabel: zh ? "打开提供商设置" : "Open provider settings",
  };
}
