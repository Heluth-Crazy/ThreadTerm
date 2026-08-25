import { invoke } from './helpers';

export type Da1Fault = 'none' | 'reject' | 'zero' | 'partial' | 'unknown';
export type Da1Shell = 'pwsh' | 'windowsPowerShell';

export const DA1_FAULTS: readonly Da1Fault[] = [
  'none',
  'reject',
  'zero',
  'partial',
  'unknown',
];

/**
 * The fixture emits six real DA1 queries:
 * one exact query, one `0c` query, three adjacent/repeated queries, and one
 * query whose ESC and CSI body are written by separate Console writes. OSC,
 * DCS and unsupported CSI lookalikes are deliberately interleaved but are not
 * included in this count.
 */
export const DA1_EXPECTED_QUERIES = 6;
export const DA1_PRIORITY_CHUNK_BYTES = 64 * 1024;
export const DA1_PRIORITY_CHUNKS = 16;

const REPORT_KIND = 'harness-da1';
const DA1_START_MARKER = 'DA1-E2E-BEGIN';
const DA1_END_MARKER = 'DA1-E2E-END';
const OSC_FAKE_MARKER = 'OSC-FAKE';
const DCS_FAKE_MARKER = 'DCS-FAKE';

export type Da1Counters = {
  queries: number;
  committed: number;
  rejected: number;
  zero: number;
  partial: number;
  unknown: number;
  fatal: number;
};

export type Da1Observation = {
  counters: Da1Counters;
  visibleMarkers: 'preserved' | 'notObserved' | 'notApplicable';
  fakeSequences: 'preserved' | 'notObserved' | 'notApplicable';
  fallback: 'observed' | 'notObserved' | 'notApplicable';
};

export type Da1Report = {
  kind: typeof REPORT_KIND;
  artifact: 'harness';
  flow: 'da1';
  fault: Da1Fault;
  status: 'passed' | 'unavailable' | 'failed';
  shell: Da1Shell;
  availability: 'available' | 'unavailable';
  renderer: 'unmounted';
  queries: number;
  committed: number;
  rejected: number;
  zero: number;
  partial: number;
  unknown: number;
  fatal: number;
  visibleMarkers: Da1Observation['visibleMarkers'];
  fakeSequences: Da1Observation['fakeSequences'];
  fallback: Da1Observation['fallback'];
  priority: 'notRun' | 'completed' | 'notObserved';
  priorityElapsedMs: number;
  submittedBytes: number;
  cleanup: 'notStarted' | 'killed' | 'alreadyGone' | 'cleanupFailed' | 'notPrepared';
  elapsedMs: number;
  errorKind?:
    | 'authorityOff'
    | 'availabilityMissing'
    | 'shellUnavailable'
    | 'dataRootMissing'
    | 'prepareFailed'
    | 'createFailed'
    | 'createIdentityMismatch'
    | 'createShellMismatch'
    | 'caseNotBound'
    | 'queryTimeout'
    | 'counterMismatch'
    | 'visibleOutputMismatch'
    | 'priorityWriteFailed'
    | 'priorityTimeout'
    | 'killFailed'
    | 'cleanupFailed'
    | 'unexpected';
};

export type Da1HarnessSnapshot = {
  state?: unknown;
  da1?: unknown;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function da1ShellFromEnvironment(): Da1Shell {
  const value = process.env.THREADTERM_WDIO_DA1_SHELL ?? 'windowsPowerShell';
  if (value === 'pwsh' || value === 'windowsPowerShell') return value;
  throw new Error('da1-shell-unavailable');
}

export function da1AvailabilityFromEnvironment(): 'available' | 'unavailable' {
  const value = process.env.THREADTERM_WDIO_DA1_AVAILABLE;
  if (value === '1') return 'available';
  if (value === '0') return 'unavailable';
  throw new Error('da1-shell-availability-missing');
}

/**
 * Produce a shell command whose output, rather than the PTY input, contains
 * the protocol sequences. The actual query bytes are assembled from `char`
 * values so the submitted line cannot accidentally satisfy the output check.
 * Flushes between the split query writes provide a real ConPTY chunk seam;
 * the test still waits on observed backend counters, never on that flush.
 */
export function deviceAttributesCommand(): string {
  const statements = [
    `[Console]::Write('DA1-E2E-' + 'BEGIN')`,
    `[Console]::Write($e + '[c')`,
    `[Console]::Write($e + '[0c')`,
    `[Console]::Write($e + '[c' + $e + '[0c' + $e + '[c')`,
    `[Console]::Write($e); [Console]::Out.Flush(); [Console]::Write('[c')`,
    `[Console]::Write($e + ']0;' + 'OSC-' + 'FAKE' + $e + '[c' + $b)`,
    `[Console]::Write($e + 'P1;' + 'DCS-' + 'FAKE' + $e + '\\')`,
    `[Console]::Write($e + '[?1c')`,
    `[Console]::Write('DA1-E2E-' + 'END')`,
    '[Console]::Out.Flush()',
  ];
  return `$e = [char]27; $b = [char]7; ${statements.join('; ')}`;
}

export function da1HarnessShellValue(shell: Da1Shell): Da1Shell {
  return shell;
}

export function extractDa1Counters(value: unknown): Da1Counters {
  const da1 = objectValue(objectValue(value)?.da1);
  return {
    queries: numberValue(da1?.queries),
    committed: numberValue(da1?.committed),
    rejected: numberValue(da1?.rejected),
    zero: numberValue(da1?.zero),
    partial: numberValue(da1?.partial),
    unknown: numberValue(da1?.unknown),
    fatal: numberValue(da1?.fatal),
  };
}

function targetQueries(fault: Da1Fault): number {
  return fault === 'partial' || fault === 'unknown' ? 1 : DA1_EXPECTED_QUERIES;
}

function faultObserved(counters: Da1Counters, fault: Da1Fault): boolean {
  if (fault === 'none') return counters.committed >= DA1_EXPECTED_QUERIES;
  if (fault === 'reject') return counters.rejected >= 1 && counters.queries >= DA1_EXPECTED_QUERIES;
  if (fault === 'zero') return counters.zero >= 1 && counters.queries >= DA1_EXPECTED_QUERIES;
  if (fault === 'partial') return counters.partial >= 1 && counters.fatal >= 1;
  return counters.unknown >= 1 && counters.fatal >= 1;
}

export async function waitForDa1Counters(
  caseToken: string,
  fault: Da1Fault,
): Promise<Da1Counters> {
  const deadline = Date.now() + 20_000;
  let latest = extractDa1Counters(undefined);
  while (Date.now() < deadline) {
    const result = await invoke('terminal_startup_harness_snapshot', { caseToken });
    if (result.ok) {
      latest = extractDa1Counters(result.value);
      if (latest.queries >= targetQueries(fault) && faultObserved(latest, fault)) return latest;
    }
    await browser.pause(50);
  }
  throw new Error('da1-counter-timeout');
}

export async function waitForDa1CaseBound(caseToken: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await invoke('terminal_startup_harness_snapshot', { caseToken });
    const state = result.ok ? objectValue(result.value)?.state : undefined;
    if (state === 'bound') return;
    if (state === 'failed' || state === 'cleaned') throw new Error('da1-case-not-bound');
    await browser.pause(50);
  }
  throw new Error('da1-case-bind-timeout');
}

/**
 * Inspect output only inside the test process. The returned projection is
 * limited to booleans/enums; raw PTY output never reaches a report or error.
 */
export async function observeDa1Output(
  ptyId: string,
  fault: Da1Fault,
): Promise<Pick<Da1Observation, 'visibleMarkers' | 'fakeSequences' | 'fallback'>> {
  const result = await invoke('pty_get_recent_output', { ptyId });
  const output = result.ok && typeof result.value === 'string' ? result.value : '';
  if (!output) {
    return {
      visibleMarkers: 'notObserved',
      fakeSequences: 'notObserved',
      fallback: fault === 'partial' || fault === 'unknown' ? 'notApplicable' : 'notObserved',
    };
  }
  const visibleMarkers = output.includes(DA1_START_MARKER) && output.includes(DA1_END_MARKER)
    ? 'preserved'
    : 'notObserved';
  const oscFake = `\u001b]0;${OSC_FAKE_MARKER}\u001b[c\u0007`;
  const dcsFake = `\u001bP1;${DCS_FAKE_MARKER}\u001b\\`;
  const unsupportedCsi = '\u001b[?1c';
  const fakeSequences = output.includes(oscFake)
    && output.includes(dcsFake)
    && output.includes(unsupportedCsi)
    ? 'preserved'
    : 'notObserved';
  const fallback = fault === 'reject' || fault === 'zero'
    // The configured fault is consumed by the first query (the exact `ESC[c`);
    // later `0c`/repeated queries are allowed to commit normally.
    ? output.includes('\u001b[c') ? 'observed' : 'notObserved'
    : fault === 'partial' || fault === 'unknown'
      ? 'notApplicable'
      : 'notApplicable';
  return { visibleMarkers, fakeSequences, fallback };
}

export async function waitForDa1Output(
  ptyId: string,
  fault: Da1Fault,
): Promise<Pick<Da1Observation, 'visibleMarkers' | 'fakeSequences' | 'fallback'>> {
  const deadline = Date.now() + 10_000;
  let latest = await observeDa1Output(ptyId, fault);
  while (Date.now() < deadline) {
    if (fault === 'partial' || fault === 'unknown'
      || (latest.visibleMarkers === 'preserved' && latest.fakeSequences === 'preserved')) {
      return latest;
    }
    await browser.pause(50);
    latest = await observeDa1Output(ptyId, fault);
  }
  return latest;
}

export function buildPriorityInputs(command: string): string[] {
  const fillerBytes = DA1_PRIORITY_CHUNK_BYTES;
  const firstPayload = `${command}\r${'x'.repeat(Math.max(0, fillerBytes - command.length - 1))}`;
  return [
    firstPayload,
    ...Array.from({ length: DA1_PRIORITY_CHUNKS - 1 }, () => 'x'.repeat(fillerBytes)),
  ];
}

export async function runPriorityInputs(ptyId: string, command: string): Promise<void> {
  const payloads = buildPriorityInputs(command);
  const results = await Promise.all(
    payloads.map((data) => invoke('pty_input', { id: ptyId, data })),
  );
  if (results.some((result) => !result.ok)) throw new Error('da1-priority-write-failed');
}

export function newDa1Report(fault: Da1Fault, shell: Da1Shell): Da1Report {
  return {
    kind: REPORT_KIND,
    artifact: 'harness',
    flow: 'da1',
    fault,
    status: 'failed',
    shell,
    availability: 'available',
    renderer: 'unmounted',
    queries: 0,
    committed: 0,
    rejected: 0,
    zero: 0,
    partial: 0,
    unknown: 0,
    fatal: 0,
    visibleMarkers: 'notObserved',
    fakeSequences: 'notObserved',
    fallback: 'notApplicable',
    priority: 'notRun',
    priorityElapsedMs: 0,
    submittedBytes: 0,
    cleanup: 'notStarted',
    elapsedMs: 0,
  };
}

export function safeDa1ErrorKind(error: unknown): Da1Report['errorKind'] {
  const message = error instanceof Error ? error.message : '';
  if (message === 'da1-authority-not-enabled') return 'authorityOff';
  if (message === 'da1-shell-availability-missing') return 'availabilityMissing';
  if (message === 'da1-shell-unavailable') return 'shellUnavailable';
  if (message === 'da1-data-root-missing') return 'dataRootMissing';
  if (message === 'da1-prepare-failed') return 'prepareFailed';
  if (message === 'da1-create-failed') return 'createFailed';
  if (message === 'da1-create-identity-mismatch') return 'createIdentityMismatch';
  if (message === 'da1-create-shell-mismatch') return 'createShellMismatch';
  if (message === 'da1-case-not-bound' || message === 'da1-case-bind-timeout') return 'caseNotBound';
  if (message === 'da1-counter-timeout') return 'queryTimeout';
  if (message === 'da1-counter-mismatch') return 'counterMismatch';
  if (message === 'da1-visible-output-mismatch') return 'visibleOutputMismatch';
  if (message === 'da1-priority-write-failed') return 'priorityWriteFailed';
  if (message === 'da1-priority-timeout') return 'priorityTimeout';
  if (message === 'da1-kill-failed') return 'killFailed';
  if (message === 'da1-cleanup-failed') return 'cleanupFailed';
  return 'unexpected';
}
