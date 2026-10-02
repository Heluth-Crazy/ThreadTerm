export const MAX_EXPLAIN_SELECTION = 24_000;

export function buildExplainPrompt(selection: string) {
  if (!selection.trim()) throw new Error("Select terminal text before asking for an explanation.");
  const clipped = selection.length > MAX_EXPLAIN_SELECTION
    ? `${selection.slice(0, MAX_EXPLAIN_SELECTION)}\n\n[Selection truncated for the chat request.]`
    : selection;
  return `Explain the following selected terminal output. State what it means, identify failures or risks, and suggest safe next steps. Do not execute commands or claim that anything changed.\n\nSelected terminal output:\n\`\`\`text\n${clipped}\n\`\`\``;
}

export function isExplainProvider(value: { installed: boolean; chat: boolean; auth?: string }) {
  return value.installed && value.chat && value.auth === "authenticated";
}
