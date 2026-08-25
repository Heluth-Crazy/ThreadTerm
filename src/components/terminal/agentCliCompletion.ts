import type { TerminalCard, TerminalType } from '../../types/terminal';
import { isAiCliTerminalType } from './providerSession';

/**
 * Compatibility completion is deliberately conservative.  These values are
 * kept here (rather than in the event bridge) so the timing and prompt
 * contracts can be exercised without mounting a Tauri listener.
 */
export const AGENT_CLI_PROMPT_SETTLE_MS = 500;
export const AGENT_CLI_COMPATIBILITY_IDLE_MS = 8_000;
export const AGENT_CLI_MIN_RUNNING_MS = 1_500;

export type AgentCliPromptAdapter = (preview: string) => string | null;
export type AgentCliCompletionAdapter = (preview: string) => string | null;

const PROMPT_PATTERNS: Readonly<Partial<Record<TerminalType, readonly RegExp[]>>> = {
  // Claude Code's prompt is commonly a bare `>` or `❯`; the adapter is only
  // consulted for a Claude card, so a shell prompt can never match here.
  claude: [/^>\s*$/i, /^❯\s*$/u, /^claude(?:\s+code)?\s*[>:]\s*$/i],
  codex: [/^codex(?:\s+(?:chat|resume))?\s*[>:]\s*$/i, /^❯\s*$/u, /^›\s*$/u],
  opencode: [/^opencode\s*[>:]\s*$/i, /^❯\s*$/u, /^›\s*$/u],
  gemini: [/^gemini\s*[>:]\s*$/i, /^❯\s*$/u, /^>\s*$/u],
  kimi: [/^kimi(?:\s+code)?\s*[>:]\s*$/i, /^❯\s*$/u, /^›\s*$/u],
  grok: [/^grok(?:\s+build)?\s*[>:]\s*$/i, /^❯\s*$/u, /^›\s*$/u],
};

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[()][0-2A-Z]/g, '');
}

function normalizeRedraws(value: string): string {
  // A carriage return redraws the current row.  Keep the final frame so a
  // progress line followed by a provider prompt cannot leave stale text in
  // the fingerprint input.
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}

/** Returns the visible, bounded tail used by prompt adapters. */
export function normalizeAgentCliPreview(preview: string): string {
  return normalizeRedraws(stripAnsi(preview))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .slice(-8_192);
}

/**
 * Return the provider-specific prompt line when the rendered tail is at a
 * prompt.  Matching only the final non-empty line prevents ordinary output
 * containing a provider name from being treated as completion evidence.
 */
export function detectAgentCliPrompt(
  terminalType: TerminalType,
  preview: string,
): string | null {
  const patterns = PROMPT_PATTERNS[terminalType];
  if (!patterns || !isAiCliTerminalType(terminalType)) return null;

  const lines = normalizeAgentCliPreview(preview)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.at(-1);
  if (line && patterns.some((pattern) => pattern.test(line))) return line;
  return null;
}

export function getAgentCliPromptAdapter(
  terminalType: TerminalType,
): AgentCliPromptAdapter | null {
  if (!PROMPT_PATTERNS[terminalType] || !isAiCliTerminalType(terminalType)) return null;
  return (preview) => detectAgentCliPrompt(terminalType, preview);
}

function normalizePromptFingerprint(prompt: string): string {
  return prompt.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/**
 * Return stable, non-content-bearing completion evidence for one provider.
 * The output tail is bounded and sanitized before matching; only the prompt
 * marker contributes to the fingerprint, so repeated redraws are identical
 * while a renewed/provider-changed prompt gets a distinct value.
 */
export function getAgentCliCompletionFingerprint(
  terminalType: TerminalType,
  preview: string,
): string | null {
  const prompt = detectAgentCliPrompt(terminalType, preview);
  if (!prompt) return null;
  return `agent-cli:${terminalType}:prompt:${normalizePromptFingerprint(prompt)}`;
}

/** Alias phrased for callers that treat prompt detection as completion evidence. */
export const buildAgentCliCompletionFingerprint = getAgentCliCompletionFingerprint;

export function getAgentCliCompletionAdapter(
  terminalType: TerminalType,
): AgentCliCompletionAdapter | null {
  if (!PROMPT_PATTERNS[terminalType] || !isAiCliTerminalType(terminalType)) return null;
  return (preview) => getAgentCliCompletionFingerprint(terminalType, preview);
}

/** One-shot cards have an authoritative process boundary and never use this path. */
export function isAgentCliCompatibilityCandidate(card: TerminalCard): boolean {
  return card.executionMode !== 'oneShot' && isAiCliTerminalType(card.terminalType);
}
