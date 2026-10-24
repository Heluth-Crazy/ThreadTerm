#!/usr/bin/env node
/**
 * Produces the small, offline price catalog used by the usage ledger.
 *
 * This intentionally reads one public source only. LiteLLM does not expose a
 * stable data commit through this endpoint, so the response ETag and SHA-256
 * are recorded as the reproducible source revision.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const sourceUrl = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const output = resolve(import.meta.dirname, '../src/usage_ledger/prices.snapshot.json');
const maxBytes = 300 * 1024;
const supportedProviders = new Set(['openai', 'anthropic', 'google', 'gemini', 'xai', 'moonshot', 'deepseek']);
const modelFamily = /^(?:gpt|o[1-9]|chatgpt|claude|gemini|grok|kimi|moonshot|deepseek)/i;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function ratesOf(row, suffix = '') {
  return Object.fromEntries(Object.entries({
    input: numeric(row[`input_cost_per_token${suffix}`]),
    output: numeric(row[`output_cost_per_token${suffix}`]),
    cacheRead: numeric(row[`cache_read_input_token_cost${suffix}`]),
    cacheWrite5m: numeric(row[`cache_creation_input_token_cost${suffix}`]),
    cacheWrite1h: numeric(row[`cache_creation_input_token_cost_above_1hr${suffix}`]),
  }).filter(([, value]) => value !== undefined));
}

function aliasesFor(name, provider) {
  const aliases = new Set([name]);
  const prefix = `${provider}/`;
  if (name.startsWith(prefix)) aliases.add(name.slice(prefix.length));
  if (name.startsWith('models/')) aliases.add(name.slice('models/'.length));
  return [...aliases].sort();
}

function contextTiers(row) {
  const tiers = new Map();
  for (const key of Object.keys(row)) {
    const match = key.match(/_above_(\d+)(k|m)?_tokens$/i);
    if (!match) continue;
    const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
    const threshold = Number(match[1]) * multiplier;
    if (!Number.isSafeInteger(threshold) || threshold <= 0) continue;
    const suffix = `_above_${match[1]}${match[2] ?? ''}_tokens`;
    tiers.set(threshold, suffix);
  }
  return [...tiers].sort(([left], [right]) => left - right).map(([threshold, suffix]) => ({ threshold, rates: ratesOf(row, suffix) })).filter(tier => Object.keys(tier.rates).length);
}

function entry(name, row) {
  const provider = String(row.litellm_provider ?? '').toLowerCase();
  const bare = name.replace(/^(?:openai|anthropic|google|gemini|xai|moonshot|deepseek)\//i, '').replace(/^models\//i, '');
  if (!supportedProviders.has(provider) || !modelFamily.test(bare)) return undefined;
  const rates = ratesOf(row);
  if (!Object.keys(rates).length) return undefined;
  const tiers = contextTiers(row);
  return { provider, aliases: aliasesFor(name, provider), rates, ...(tiers.length ? { tiers } : {}) };
}

const sourceFile = process.env.USAGE_PRICES_SOURCE_FILE;
const response = sourceFile ? undefined : await fetch(sourceUrl, { headers: { accept: 'application/json' } });
if (response && !response.ok) throw new Error(`LiteLLM price download failed: HTTP ${response.status}`);
const body = sourceFile ? await readFile(sourceFile) : Buffer.from(await response.arrayBuffer());
const etag = sourceFile ? process.env.USAGE_PRICES_ETAG : response.headers.get('etag');
if (!etag) throw new Error('LiteLLM price source requires an ETag for reproducibility');
const data = JSON.parse(body.toString('utf8'));
const models = Object.fromEntries(Object.entries(data)
  .map(([name, row]) => [name, entry(name, row)])
  .filter(([, row]) => row)
  .sort(([left], [right]) => left.localeCompare(right)));
const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: {
    url: sourceUrl,
    // LiteLLM is MIT licensed. The source field is kept for future audits.
    license: 'MIT (BerriAI/litellm)',
    etag,
    sha256: createHash('sha256').update(body).digest('hex'),
  },
  models,
};
const serialized = `${JSON.stringify(snapshot)}\n`;
if (Buffer.byteLength(serialized) > maxBytes) {
  throw new Error(`Filtered snapshot is ${Buffer.byteLength(serialized)} bytes, above ${maxBytes}`);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, serialized, 'utf8');
console.log(`Wrote ${output} (${Buffer.byteLength(serialized)} bytes, ${Object.keys(models).length} models)`);
