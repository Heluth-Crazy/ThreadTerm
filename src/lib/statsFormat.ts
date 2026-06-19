// Compact formatters for token counts and USD cost, shared by the stats panel
// and the per-card token badge.

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(n: number): string {
  return `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
}
