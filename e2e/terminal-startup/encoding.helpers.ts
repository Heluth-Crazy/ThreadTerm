import { invoke } from './helpers';
import {
  countExactOccurrences,
  harnessShellValue,
  PROVIDER_SENTINEL,
  shellAvailability,
  syntheticProviderCommand,
  type ProviderShell,
} from './provider.helpers';

export type EncodingShell = Exclude<ProviderShell, 'cmd'>;
export type EncodingMode = 'plain' | 'syntheticProvider';
export type Availability = 'available' | 'unavailable';
export type ProbeName = 'git' | 'node' | 'python' | 'cmd';
export type ProbeStatus = 'passed' | 'unavailable' | 'failed';

export const ENCODING_SHELLS: readonly EncodingShell[] = [
  'pwsh',
  'windowsPowerShell',
];

export const ENCODING_MODES: readonly EncodingMode[] = [
  'plain',
  'syntheticProvider',
];

export const PROBE_NAMES: readonly ProbeName[] = [
  'git',
  'node',
  'python',
  'cmd',
];

const READY_MARKER_FRAGMENT = '\u001b]777;threadterm;ready';
const ROUND_TRIP_PREFIX = 'THREADTERM_ENCODING_ROUNDTRIP_';
const ROUND_TRIP_SUFFIX = '_中文🚀';
const ASCII_ROUND_TRIP_SUFFIX = '_ASCII';
const PROBE_PREFIX = 'THREADTERM_ENCODING_PROBE_';
const PROBE_AVAILABLE_SUFFIX = '_AVAILABLE';
const PROBE_UNAVAILABLE_SUFFIX = '_UNAVAILABLE';
const CMD_READBACK_PREFIX = 'THREADTERM_ENCODING_CMD_READBACK_';
const CMD_READBACK_SUFFIX = '_OK';

type FlagName =
  | 'THREADTERM_POWERSHELL_UTF8'
  | 'THREADTERM_PROVIDER_SHELL_READY'
  | 'THREADTERM_DA1_AUTHORITY'
  | 'THREADTERM_CONPTY_WARMUP'
  | 'THREADTERM_WDIO_EXPECT_POWERSHELL_UTF8';

export type EncodingEnvironment = {
  dataRoot: string;
  utf8Enabled: boolean;
  providerReady: boolean;
  da1Authority: boolean;
  warmup: boolean;
  shellAvailability: Record<EncodingShell, Availability>;
};

export type EncodingReport = {
  kind: 'harness-encoding';
  artifact: 'harness';
  flow: 'encoding';
  shell: EncodingShell;
  mode: EncodingMode;
  availability: Availability;
  status: 'passed' | 'unavailable' | 'failed';
  utf8: 'enabled' | 'disabled';
  providerReady: 'enabled' | 'disabled';
  da1Authority: 'enabled' | 'disabled';
  warmup: 'enabled' | 'disabled';
  shellFamily: 'pwsh' | 'windowsPowerShell' | 'unknown';
  markerMatched: 'yes' | 'no' | 'notApplicable';
  markerLeaks: number;
  sentinelMatches: number;
  roundTrip: 'passed' | 'notRequired' | 'failed';
  roundTripMatches: number;
  git: ProbeStatus;
  node: ProbeStatus;
  python: ProbeStatus;
  cmd: ProbeStatus;
  probePassed: number;
  probeUnavailable: number;
  probeFailed: number;
  cleanup: 'notStarted' | 'killed' | 'killNotObserved' | 'cleanupFailed' | 'notPrepared';
  elapsedMs: number;
  errorKind?:
    | 'artifactMismatch'
    | 'flowMismatch'
    | 'dataRootMissing'
    | 'reportPathMissing'
    | 'flagMissing'
    | 'flagMismatch'
    | 'requiredCmdUnavailable'
    | 'availabilityMissing'
    | 'shellUnavailable'
    | 'prepareFailed'
    | 'createFailed'
    | 'createIdentityMismatch'
    | 'createShellMismatch'
    | 'caseNotBound'
    | 'inputFailed'
    | 'startupFailed'
    | 'startupTimeout'
    | 'markerLeak'
    | 'markerMissing'
    | 'sentinelMissing'
    | 'sentinelDuplicate'
    | 'roundTripMismatch'
    | 'probeFailed'
    | 'cmdMarkerInCommand'
    | 'cmdReadbackMissing'
    | 'cmdReadbackDuplicate'
    | 'killFailed'
    | 'cleanupFailed'
    | 'unexpected';
};

type RecordValue = Record<string, unknown>;

function objectValue(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' ? value as RecordValue : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boolFlag(value: string): boolean | undefined {
  if (['1', 'true', 'on', 'enabled'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'off', 'disabled'].includes(value.toLowerCase())) return false;
  return undefined;
}

function requiredFlag(name: FlagName): boolean {
  const value = process.env[name];
  if (!value || boolFlag(value) === undefined) throw new Error('encoding-flag-missing');
  return boolFlag(value) as boolean;
}

export function requireEncodingEnvironment(): EncodingEnvironment {
  if ((process.env.THREADTERM_WDIO_ARTIFACT ?? 'production') !== 'harness') {
    throw new Error('encoding-artifact-mismatch');
  }
  if ((process.env.THREADTERM_WDIO_FLOW ?? '') !== 'encoding') {
    throw new Error('encoding-flow-mismatch');
  }
  const dataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;
  if (!dataRoot) throw new Error('encoding-data-root-missing');
  if (!process.env.THREADTERM_WDIO_REPORT) throw new Error('encoding-report-path-missing');

  const utf8Enabled = requiredFlag('THREADTERM_POWERSHELL_UTF8');
  const expectedUtf8 = requiredFlag('THREADTERM_WDIO_EXPECT_POWERSHELL_UTF8');
  if (utf8Enabled !== expectedUtf8) throw new Error('encoding-flag-mismatch');

  const providerReady = requiredFlag('THREADTERM_PROVIDER_SHELL_READY');
  const da1Authority = requiredFlag('THREADTERM_DA1_AUTHORITY');
  const warmup = requiredFlag('THREADTERM_CONPTY_WARMUP');
  const availability: Record<EncodingShell, Availability> = {
    pwsh: shellAvailability('pwsh'),
    windowsPowerShell: shellAvailability('windowsPowerShell'),
  };
  if (shellAvailability('cmd') === 'unavailable') {
    throw new Error('encoding-required-cmd-unavailable');
  }
  return {
    dataRoot,
    utf8Enabled,
    providerReady,
    da1Authority,
    warmup,
    shellAvailability: availability,
  };
}

export function newEncodingReport(
  shell: EncodingShell,
  mode: EncodingMode,
  environment: EncodingEnvironment,
  started: number,
): EncodingReport {
  return {
    kind: 'harness-encoding',
    artifact: 'harness',
    flow: 'encoding',
    shell,
    mode,
    availability: environment.shellAvailability[shell],
    status: 'failed',
    utf8: environment.utf8Enabled ? 'enabled' : 'disabled',
    providerReady: environment.providerReady ? 'enabled' : 'disabled',
    da1Authority: environment.da1Authority ? 'enabled' : 'disabled',
    warmup: environment.warmup ? 'enabled' : 'disabled',
    shellFamily: 'unknown',
    markerMatched: mode === 'syntheticProvider' ? 'no' : 'notApplicable',
    markerLeaks: 0,
    sentinelMatches: 0,
    roundTrip: environment.utf8Enabled ? 'failed' : 'notRequired',
    roundTripMatches: 0,
    git: 'failed',
    node: 'failed',
    python: 'failed',
    cmd: 'failed',
    probePassed: 0,
    probeUnavailable: 0,
    probeFailed: 0,
    cleanup: 'notStarted',
    elapsedMs: Date.now() - started,
  };
}

export function safeEncodingErrorKind(error: unknown): EncodingReport['errorKind'] {
  const message = error instanceof Error ? error.message : '';
  const known: EncodingReport['errorKind'][] = [
    'artifactMismatch', 'flowMismatch', 'dataRootMissing', 'reportPathMissing',
    'flagMissing', 'flagMismatch', 'requiredCmdUnavailable', 'availabilityMissing',
    'shellUnavailable', 'prepareFailed', 'createFailed', 'createIdentityMismatch',
    'createShellMismatch', 'caseNotBound', 'inputFailed', 'startupFailed', 'startupTimeout',
    'markerLeak', 'markerMissing', 'sentinelMissing', 'sentinelDuplicate',
    'roundTripMismatch', 'probeFailed', 'cmdMarkerInCommand', 'cmdReadbackMissing',
    'cmdReadbackDuplicate', 'killFailed', 'cleanupFailed', 'unexpected',
  ];
  const mapping: Record<string, EncodingReport['errorKind']> = {
    'encoding-artifact-mismatch': 'artifactMismatch',
    'encoding-flow-mismatch': 'flowMismatch',
    'encoding-data-root-missing': 'dataRootMissing',
    'encoding-report-path-missing': 'reportPathMissing',
    'encoding-flag-missing': 'flagMissing',
    'encoding-flag-mismatch': 'flagMismatch',
    'encoding-required-cmd-unavailable': 'requiredCmdUnavailable',
    'provider-shell-availability-missing': 'availabilityMissing',
    'required-cmd-shell-unavailable': 'requiredCmdUnavailable',
    'provider-shell-unavailable': 'shellUnavailable',
    'encoding-prepare-failed': 'prepareFailed',
    'encoding-create-failed': 'createFailed',
    'encoding-create-identity-mismatch': 'createIdentityMismatch',
    'encoding-create-shell-mismatch': 'createShellMismatch',
    'encoding-case-not-bound': 'caseNotBound',
    'encoding-input-failed': 'inputFailed',
    'provider-startup-terminal-state': 'startupFailed',
    'provider-startup-sent-timeout': 'startupTimeout',
    'encoding-poll-timeout': 'startupTimeout',
    'encoding-startup-failed': 'startupFailed',
    'encoding-startup-timeout': 'startupTimeout',
    'encoding-marker-leak': 'markerLeak',
    'encoding-marker-missing': 'markerMissing',
    'encoding-sentinel-missing': 'sentinelMissing',
    'encoding-sentinel-duplicate': 'sentinelDuplicate',
    'encoding-round-trip-mismatch': 'roundTripMismatch',
    'encoding-probe-failed': 'probeFailed',
    'encoding-cmd-marker-in-command': 'cmdMarkerInCommand',
    'encoding-cmd-readback-missing': 'cmdReadbackMissing',
    'encoding-cmd-readback-duplicate': 'cmdReadbackDuplicate',
    'encoding-kill-failed': 'killFailed',
    'encoding-cleanup-failed': 'cleanupFailed',
  };
  if (message in mapping) return mapping[message];
  if (known.includes(message as EncodingReport['errorKind'])) {
    return message as EncodingReport['errorKind'];
  }
  return 'unexpected';
}

export function encodingCaseId(shell: EncodingShell, mode: EncodingMode): string {
  return `terminal-startup-encoding-${shell}-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function syntheticRoundTripCommand(utf8Enabled: boolean): string {
  const suffix = utf8Enabled ? ROUND_TRIP_SUFFIX : ASCII_ROUND_TRIP_SUFFIX;
  return `Write-Output ('${ROUND_TRIP_PREFIX}' + '${suffix}')`;
}

export function syntheticEncodingProviderCommand(shell: EncodingShell): string {
  return syntheticProviderCommand(shell);
}

export function markerFragmentPresent(output: string): boolean {
  return output.includes(READY_MARKER_FRAGMENT);
}

export function cmdReadbackMarker(): string {
  return `${CMD_READBACK_PREFIX}${CMD_READBACK_SUFFIX}`;
}

function probeReceiptEnvName(name: ProbeName): string {
  return name === 'git'
    ? 'THREADTERM_WDIO_ENCODING_GIT_PATH'
    : name === 'node'
      ? 'THREADTERM_WDIO_ENCODING_NODE_PATH'
      : name === 'python'
        ? 'THREADTERM_WDIO_ENCODING_PYTHON_PATH'
        : 'THREADTERM_WDIO_PROVIDER_CMD_PATH';
}

function expectedProbeBasename(name: ProbeName): string {
  return name === 'cmd' ? 'cmd.exe' : `${name}.exe`;
}

/** Runner-only local executable receipt. Never returned in evidence. */
export function canonicalProbeReceipt(name: ProbeName): string | undefined {
  const value = process.env[probeReceiptEnvName(name)];
  const diskPath = value?.startsWith('\\\\?\\') ? value.slice(4) : value;
  if (!value || !diskPath || !/^[A-Za-z]:\\/.test(diskPath) || value.includes('/') || /['"`$]/.test(value)) return undefined;
  if (value.startsWith('\\\\') || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) return undefined;
  if (value.toLowerCase().includes('\\windowsapps\\')) return undefined;
  const basename = value.slice(value.lastIndexOf('\\') + 1);
  return basename.toLowerCase() === expectedProbeBasename(name) ? value : undefined;
}

export function probeCommand(name: ProbeName): string {
  const tag = name.toUpperCase();
  const available = `('${PROBE_PREFIX}' + '${tag}${PROBE_AVAILABLE_SUFFIX}')`;
  const unavailable = `('${PROBE_PREFIX}' + '${tag}${PROBE_UNAVAILABLE_SUFFIX}')`;
  const receipt = canonicalProbeReceipt(name);
  if (!receipt) return `Write-Output ${unavailable}`;
  const invocation = name === 'cmd'
    ? `& '${receipt}' /d /q /v:on /c "set tt_prefix=${CMD_READBACK_PREFIX}&echo !tt_prefix!${CMD_READBACK_SUFFIX}" 2>&1`
    : `& '${receipt}' --version 2>&1`;
  const command = `Write-Output ${available}; ${invocation}`;
  if (name === 'cmd' && command.includes(cmdReadbackMarker())) {
    throw new Error('encoding-cmd-marker-in-command');
  }
  return command;
}

function probeAvailableMarker(name: ProbeName): string {
  return `${PROBE_PREFIX}${name.toUpperCase()}${PROBE_AVAILABLE_SUFFIX}`;
}

function probeUnavailableMarker(name: ProbeName): string {
  return `${PROBE_PREFIX}${name.toUpperCase()}${PROBE_UNAVAILABLE_SUFFIX}`;
}

function probeVersionPattern(name: Exclude<ProbeName, 'cmd'>): RegExp {
  switch (name) {
    case 'git': return /git version\s+\d/i;
    case 'node': return /v\d+\.\d+/i;
    case 'python': return /python\s+\d+\.\d+/i;
  }
}

async function recentOutput(ptyId: string): Promise<string> {
  const result = await invoke('pty_get_recent_output', { ptyId });
  return result.ok && typeof result.value === 'string' ? result.value : '';
}

async function waitForPoll(
  read: () => Promise<string>,
  accept: (value: string) => boolean,
  timeoutMs = 20_000,
  stableReads = 1,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) {
      stable += 1;
      if (stable >= stableReads) return value;
    } else {
      stable = 0;
    }
    await browser.pause(75);
  }
  throw new Error('encoding-poll-timeout');
}

async function assertNoPrivateMarker(
  ptyId: string,
  markerLeaks: { value: number },
): Promise<string> {
  const output = await recentOutput(ptyId);
  if (markerFragmentPresent(output)) {
    markerLeaks.value += 1;
    throw new Error('encoding-marker-leak');
  }
  return output;
}

export async function waitForCaseBound(caseToken: string): Promise<void> {
  await waitForPoll(
    async () => {
      const result = await invoke('terminal_startup_harness_snapshot', { caseToken });
      const state = objectValue(result.value)?.state;
      if (state === 'failed' || state === 'cleaned') throw new Error('encoding-case-not-bound');
      return typeof state === 'string' ? state : '';
    },
    (state) => state === 'bound',
  );
}

export async function waitForMarkerEvidence(caseToken: string): Promise<boolean> {
  await waitForPoll(
    async () => {
      const result = await invoke('terminal_startup_harness_snapshot', { caseToken });
      const value = objectValue(result.value);
      if (value?.state === 'failed' || value?.state === 'cleaned') {
        throw new Error('encoding-marker-missing');
      }
      return value?.markerMatched === true ? 'matched' : '';
    },
    (state) => state === 'matched',
  );
  return true;
}

export async function assertPrivateMarkerAbsent(
  ptyId: string,
  markerLeaks: { value: number },
): Promise<void> {
  await assertNoPrivateMarker(ptyId, markerLeaks);
}

export async function waitForSentinelExactlyOnce(
  ptyId: string,
  markerLeaks: { value: number },
): Promise<number> {
  const observed = await waitForPoll(
    () => assertNoPrivateMarker(ptyId, markerLeaks),
    (output) => {
      const matches = countExactOccurrences(output, PROVIDER_SENTINEL);
      if (matches > 1) throw new Error('encoding-sentinel-duplicate');
      return matches === 1;
    },
    20_000,
    3,
  );
  const matches = countExactOccurrences(observed, PROVIDER_SENTINEL);
  if (matches !== 1) throw new Error('encoding-sentinel-missing');
  return matches;
}

export async function waitForRoundTrip(
  ptyId: string,
  utf8Enabled: boolean,
  markerLeaks: { value: number },
): Promise<number> {
  const expected = `${ROUND_TRIP_PREFIX}${utf8Enabled ? ROUND_TRIP_SUFFIX : ASCII_ROUND_TRIP_SUFFIX}`;
  const observed = await waitForPoll(
    () => assertNoPrivateMarker(ptyId, markerLeaks),
    (output) => {
      const matches = countExactOccurrences(output, expected);
      if (matches > 1) throw new Error('encoding-round-trip-mismatch');
      return matches === 1;
    },
  );
  const matches = countExactOccurrences(observed, expected);
  if (matches !== 1) throw new Error('encoding-round-trip-mismatch');
  return matches;
}

export async function runProbe(
  ptyId: string,
  name: ProbeName,
  markerLeaks: { value: number },
): Promise<ProbeStatus> {
  const input = `${probeCommand(name)}\r`;
  const submitted = await invoke('pty_input', { id: ptyId, data: input });
  if (!submitted.ok) throw new Error('encoding-probe-failed');
  const availableMarker = probeAvailableMarker(name);
  const unavailableMarker = probeUnavailableMarker(name);
  try {
    const output = await waitForPoll(
      () => assertNoPrivateMarker(ptyId, markerLeaks),
      (value) => value.includes(availableMarker) || value.includes(unavailableMarker),
    );
    if (output.includes(unavailableMarker)) return 'unavailable';
    if (!output.includes(availableMarker)) return 'failed';
    if (name === 'cmd') {
      const expected = cmdReadbackMarker();
      const withReadback = await waitForPoll(
        () => assertNoPrivateMarker(ptyId, markerLeaks),
        (value) => {
          const matches = countExactOccurrences(value, expected);
          if (matches > 1) throw new Error('encoding-cmd-readback-duplicate');
          return matches === 1;
        },
        20_000,
        3,
      );
      const matches = countExactOccurrences(withReadback, expected);
      if (matches !== 1) throw new Error('encoding-cmd-readback-missing');
      return 'passed';
    }
    const withVersion = await waitForPoll(
      () => assertNoPrivateMarker(ptyId, markerLeaks),
      (value) => {
        const markerEnd = value.indexOf(availableMarker) + availableMarker.length;
        return markerEnd >= availableMarker.length
          && probeVersionPattern(name).test(value.slice(markerEnd));
      },
    );
    const markerEnd = withVersion.indexOf(availableMarker) + availableMarker.length;
    return markerEnd >= availableMarker.length
      && probeVersionPattern(name).test(withVersion.slice(markerEnd))
      ? 'passed'
      : 'failed';
  } catch (error) {
    if (error instanceof Error && error.message === 'encoding-poll-timeout') {
      if (name === 'cmd') throw new Error('encoding-cmd-readback-missing');
      return 'failed';
    }
    throw error;
  }
}

export async function prepareEncodingCase(
  shell: EncodingShell,
  mode: EncodingMode,
): Promise<string> {
  const result = await invoke('terminal_startup_harness_prepare_case', {
    request: {
      shell: harnessShellValue(shell),
      surface: 'uiNextCreate',
      timing: 'natural',
      da1Fault: 'none',
      warmup: 'disabled',
      fixture: mode === 'syntheticProvider' ? 'syntheticProvider' : 'plainShell',
    },
  });
  const token = result.ok ? stringValue(objectValue(result.value)?.caseToken) : undefined;
  if (!token) throw new Error('encoding-prepare-failed');
  return token;
}

export async function createEncodingCase(
  shell: EncodingShell,
  mode: EncodingMode,
  environment: EncodingEnvironment,
  ptyId = encodingCaseId(shell, mode),
): Promise<{ ptyId: string; generation: string; shellFamily: EncodingReport['shellFamily'] }> {
  const command = syntheticEncodingProviderCommand(shell);
  if (mode === 'syntheticProvider' && command.includes(PROVIDER_SENTINEL)) {
    throw new Error('encoding-sentinel-in-command');
  }
  const startup = mode === 'syntheticProvider'
    ? {
      kind: 'provider',
      provider: 'codex',
      command,
      cardId: 'terminal-startup-encoding-card',
      action: 'start',
      sideEffectPlan: {
        kind: 'bind',
        providerSessionId: 'terminal-startup-encoding-session',
      },
    }
    : { kind: 'none' };
  const result = await invoke('pty_create_session_v2', {
    request: {
      id: ptyId,
      workingDir: environment.dataRoot,
      rows: 24,
      cols: 100,
      startup,
    },
  });
  const value = objectValue(result.value);
  const generation = stringValue(value?.generation);
  const returnedPtyId = stringValue(value?.ptyId);
  const shellFamily = value?.shellFamily === 'pwsh'
    || value?.shellFamily === 'windowsPowerShell'
    ? value.shellFamily
    : 'unknown';
  if (!result.ok || !generation) throw new Error('encoding-create-failed');
  if (returnedPtyId !== ptyId) throw new Error('encoding-create-identity-mismatch');
  if (shellFamily !== shell) throw new Error('encoding-create-shell-mismatch');
  // Binding and startup observation are intentionally performed by the spec
  // after it has retained the generated PTY id. If an observation fails after
  // native create, finally can still kill this exact session.
  return { ptyId, generation, shellFamily };
}

export async function sendCommand(ptyId: string, command: string): Promise<void> {
  const result = await invoke('pty_input', { id: ptyId, data: `${command}\r` });
  if (!result.ok) throw new Error('encoding-input-failed');
}
