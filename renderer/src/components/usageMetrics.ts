import type { UsageRecord } from '@threadterm/protocol';

export type ModelPrices = Record<string, { input?: number; output?: number }>;

export function validatePrices(value: unknown): ModelPrices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prices must be an object');
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9_-]+\/[A-Za-z0-9._:-]+$/.test(key) || !row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid provider/model price');
    const fields = Object.entries(row as Record<string, unknown>);
    if (!fields.length || fields.some(([name, amount]) => (name !== 'input' && name !== 'output') || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) throw new Error('Prices require only finite non-negative input/output values');
  }
  return value as ModelPrices;
}

export function parsePrices(text: string): ModelPrices { return validatePrices(JSON.parse(text)); }
export function savedPrices(value: unknown): ModelPrices { try { return validatePrices(value); } catch { return {}; } }

export function estimatedCost(row: UsageRecord, prices: ModelPrices): number | undefined {
  if (typeof row.estimatedCost === 'number' && Number.isFinite(row.estimatedCost) && row.estimatedCost >= 0 && row.currency === 'USD') return row.estimatedCost;
  const price = prices[`${row.provider}/${row.model ?? ''}`];
  if (!price) return undefined;
  if (row.inputTokens === undefined || row.outputTokens === undefined) return undefined;
  if ((row.inputTokens > 0 && price.input === undefined) || (row.outputTokens > 0 && price.output === undefined)) return undefined;
  let total = 0;
  if (price.input !== undefined) { if (row.inputTokens === undefined) return undefined; total += row.inputTokens * price.input / 1_000_000; }
  if (price.output !== undefined) { if (row.outputTokens === undefined) return undefined; total += row.outputTokens * price.output / 1_000_000; }
  return price.input === undefined && price.output === undefined ? undefined : total;
}

export function endOfUtcDay(date: string): string | undefined { return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.999Z` : undefined; }

export function knownTokenTrend(records: UsageRecord[]): [string, number][] {
  const days: Record<string, number> = {};
  for (const row of records) {
    if (row.inputTokens === undefined && row.outputTokens === undefined) continue;
    const day = row.recordedAt.slice(0, 10);
    days[day] = (days[day] ?? 0) + (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  }
  return Object.entries(days).sort(([left], [right]) => left.localeCompare(right)).slice(-14);
}
