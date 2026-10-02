import type { ProviderId } from "@threadterm/protocol";

const MAX_OUTPUT_TAIL = 4096;
const AI_TERMINAL_PROVIDERS = new Set<ProviderId>([
  "codex",
  "claude",
  "kimi",
  "gemini",
  "opencode",
]);
const ANSI_ESCAPE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
const PROMPT = /(?:^|\n)\s*(?:[›❯]|(?:ask|message)\s+(?:codex|claude|kimi|gemini|opencode))\s*$/i;

export function appendTerminalOutputTail(tail: string, chunk: string): string {
  return (tail + chunk).slice(-MAX_OUTPUT_TAIL);
}

/**
 * Terminal output has no provider-owned completion event. This deliberately
 * remains a bounded, opt-in visual hint and must never drive session state,
 * input leases, retries, or output transport.
 */
export function hasTentativeAiCompletionPrompt(provider: ProviderId, tail: string): boolean {
  return AI_TERMINAL_PROVIDERS.has(provider) && PROMPT.test(tail.replace(ANSI_ESCAPE, ""));
}

export function aiCompletionHintsEnabled(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { aiCompletionHints?: unknown }).aiCompletionHints === true,
  );
}
