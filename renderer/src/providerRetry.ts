export type ProviderRetryPresentation =
  | { kind: 'legacy-grok'; state: string; attempt?: number; maxRetries?: number }
  | { kind: 'native'; state: string; attempt?: number; message?: string; next?: string };

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function nextRetryText(value: unknown): string | undefined {
  const literal = text(value);
  if (literal !== undefined) return literal;
  const epoch = count(value);
  if (epoch === undefined) return undefined;
  // The retry contract supplies JavaScript timestamp milliseconds. A fixed ISO
  // representation remains readable without a timer or locale-dependent test.
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Recognize retry updates by their payload shape, keeping the original Grok
 * payload presentation intact while allowing native providers to supply a
 * readable message and next retry value.
 */
export function providerRetryPresentation(data: unknown): ProviderRetryPresentation | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = data as Record<string, unknown>;
  if (value.kind !== 'providerRetry') return undefined;
  const state = text(value.state) ?? 'retrying';
  const attempt = count(value.attempt);
  const message = text(value.message);
  const nextValue = nextRetryText(value.next);
  if (message !== undefined || nextValue !== undefined) return { kind: 'native', state, ...(attempt === undefined ? {} : { attempt }), ...(message === undefined ? {} : { message }), ...(nextValue === undefined ? {} : { next: nextValue }) };
  const maxRetries = count(value.maxRetries);
  return { kind: 'legacy-grok', state, ...(attempt === undefined ? {} : { attempt }), ...(maxRetries === undefined ? {} : { maxRetries }) };
}
