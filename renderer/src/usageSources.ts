// Sources panel shaping: provider status, problem counts and coverage lines. Pure, so the label rules (including the
// "format not supported yet" and unreadable buckets) are unit-testable and every provider state has one stable key the
// copy table can translate.
import type { UsageLedgerScanStats, UsageLedgerSource } from '@threadterm/protocol';
import type { UsageCopy } from './usageCopy';

/** Provider states the panel can show. `history_not_read` is the settings switch, not a failure. */
export type SourceState = 'found' | 'partial' | 'notInstalled' | 'unsupported' | 'notRead' | 'cancelled' | 'failed';

export function sourceState(status: UsageLedgerSource['status'] | string): SourceState {
  switch (status) {
    case 'ready': return 'found';
    case 'partial': return 'partial';
    case 'not_installed': return 'notInstalled';
    case 'not_supported_yet': return 'unsupported';
    case 'cancelled': return 'cancelled';
    case 'failed': return 'failed';
    default: return 'notRead';
  }
}

/** Problem kinds with a written label; anything else falls back to its readable key so a new kind is never hidden. */
export const PROBLEM_LABELS = [
  'not_supported_yet', 'unsupported_format', 'unreadable', 'invalid_json', 'record_too_large',
  'truncated_last_line', 'symlink_skipped', 'depth_limit', 'database_error', 'io_error',
  'unsupported_zstd', 'copied_fork_prefix_excluded', 'cumulative_counter_reset', 'scanner_error', 'model_not_reported_per_request',
] as const;

export type ProblemLabel = typeof PROBLEM_LABELS[number];

export function problemLabel(kind: string): ProblemLabel | null {
  if ((PROBLEM_LABELS as readonly string[]).includes(kind)) return kind as ProblemLabel;
  if (kind.startsWith('unsupported_format')) return 'unsupported_format';
  if (kind.startsWith('database_error')) return 'database_error';
  if (kind.startsWith('io_error')) return 'io_error';
  if (kind.startsWith('unsupported_zstd')) return 'unsupported_zstd';
  return null;
}

/** A readable fallback for a problem key nobody has translated yet: `record_too_large` → "record too large". */
export function humanizeProblem(kind: string): string {
  return kind.replace(/_+/g, ' ').trim();
}

export type ProblemCount = { kind: string; label: ProblemLabel | null; count: number };

export function sourceProblemMatchesState(problem: ProblemCount, state: SourceState): boolean {
  return problem.count === 1 && state === 'unsupported'
    && (problem.label === 'not_supported_yet' || problem.label === 'unsupported_format');
}

/** Descending counts, ties broken by key, so the tallest problem is first and the order never flickers. */
export function problemCounts(problems: Readonly<Record<string, number>> | undefined): ProblemCount[] {
  return Object.entries(problems ?? {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([kind, count]) => ({ kind, label: problemLabel(kind), count: Math.round(count) }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind, 'en'));
}

/** Totals the panel puts above the provider list. Only providers whose history was actually read contribute. */
export type SourceTotals = {
  providers: number;
  readProviders: number;
  filesRead: number;
  filesFound: number;
  facts: number;
  missingSources: number;
  problems: number;
};

export function sourceTotals(providers: readonly UsageLedgerSource[]): SourceTotals {
  const totals: SourceTotals = { providers: providers.length, readProviders: 0, filesRead: 0, filesFound: 0, facts: 0, missingSources: 0, problems: 0 };
  for (const provider of providers) {
    const state = sourceState(provider.status);
    if (state === 'found' || state === 'partial') totals.readProviders += 1;
    totals.filesRead += count(provider.stats?.filesRead);
    totals.filesFound += count(provider.stats?.filesFound);
    totals.facts += count(provider.stats?.facts);
    totals.missingSources += count(provider.missingSources);
    totals.problems += sumProblems(provider.stats);
  }
  return totals;
}

function count(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.round(value!) : 0;
}

function sumProblems(stats: UsageLedgerScanStats | undefined): number {
  return problemCounts(stats?.problems).reduce((sum, item) => sum + item.count, 0);
}

/** What a provider can report, in a fixed order so two providers with the same buckets read the same way. */
export const BUCKET_ORDER = ['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown', 'output', 'reasoning'] as const;

/** Bucket keys become the page's own token words, so a source row reads like the tiles. */
export function bucketLabel(bucket: string, copy: Pick<UsageCopy, 'buckets'>): string {
  if (bucket === 'cacheWrite5m' || bucket === 'cacheWrite1h' || bucket === 'cacheWriteUnknown') return copy.buckets.cacheWrite;
  return (copy.buckets as Record<string, string>)[bucket] ?? bucket;
}

export function reportedBuckets(buckets: readonly string[] | undefined): string[] {
  const known = new Set(buckets ?? []);
  return BUCKET_ORDER.filter(bucket => known.has(bucket));
}

/** A provider row with nothing to say about files stays quiet instead of printing zeros. */
export function fileLine(stats: UsageLedgerScanStats | undefined): { read: number; found: number } | null {
  const read = count(stats?.filesRead), found = count(stats?.filesFound);
  return read || found ? { read, found } : null;
}
