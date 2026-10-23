import type { ChatConnectionError, ChatSessionOption } from "@threadterm/protocol";
import { choiceText, optionTitle, type ComposerCopy } from "./composerOptions";

function shortLabel(value: string | undefined, fallback: string): string {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /[{}]/.test(text) || /^\[.*\]$/.test(text)) return fallback;
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** Render only structured permission evidence; native error messages are not display labels. */
export function permissionRestoreDetail(
  error: ChatConnectionError | undefined,
  options: readonly ChatSessionOption[],
  provider: string,
  copy: ComposerCopy,
): string | undefined {
  if (error?.code !== "chat_permission_restore_failed") return undefined;
  const detail = error.permissionRestore;
  const name = shortLabel(provider, copy("Provider", "提供方"));
  if (!detail) return copy(`${name} could not confirm the saved permission choice.`, `${name} 无法确认已保存的权限设置。`);
  const option: ChatSessionOption = options.find(row => row.id === detail.optionId) ?? {
    id: detail.optionId, name: detail.optionName || detail.optionId, value: detail.savedValue, category: "mode", choices: [],
  };
  const label = (zh: boolean) => shortLabel(optionTitle(option, (en, cn) => zh ? cn : en), zh ? "权限设置" : "Permission setting");
  const value = (raw: string, nativeLabel: string | undefined, zh: boolean) => shortLabel(choiceText(option,
    option.choices.find(choice => choice.value === raw) ?? { value: raw, name: nativeLabel || raw }, zh), zh ? "不可用" : "Unavailable");
  if (detail.reason === "missing") {
    return copy(`Saved setting “${label(false)}” is no longer offered by ${name}.`, `${name} 已不再提供已保存的设置“${label(true)}”。`);
  }
  const saved = value(detail.savedValue, detail.savedLabel, false), savedZh = value(detail.savedValue, detail.savedLabel, true);
  if (detail.reportedValue !== undefined) {
    const reported = value(detail.reportedValue, detail.reportedLabel, false), reportedZh = value(detail.reportedValue, detail.reportedLabel, true);
    return copy(`${label(false)}: saved ${saved}; ${name} reported ${reported}.`, `${label(true)}：已保存 ${savedZh}；${name} 报告 ${reportedZh}。`);
  }
  return copy(`${label(false)}: ${name} could not restore saved ${saved}.`, `${label(true)}：${name} 无法恢复已保存的 ${savedZh}。`);
}
