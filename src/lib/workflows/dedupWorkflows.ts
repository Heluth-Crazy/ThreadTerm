/**
 * Pure classifier for "Apply preset" — partitions a list of workflows into
 * three buckets so the diff dialog can render them and the caller knows what
 * to actually create.
 *
 * Dedup key (PRD D6) = (normalized cwd, normalized command):
 *   • cwd: resolve relative workflow cwd against project cwd, then trim +
 *     collapse trailing slashes; case-sensitive
 *   • command: .trim(); case-sensitive; whitespace inside command preserved
 *
 * Workflows whose `cwd` field is unset inherit a caller-provided fallback so
 * we can still detect duplicates against existing cards.
 */
import type { Workflow } from './parseWorkflow';
import { interpolateWorkflow } from './interpolateWorkflow';

export type ApplyPresetState = 'new' | 'duplicate' | 'missing-args';

export interface ApplyPresetEntry {
  workflow: Workflow & { filePath: string };
  state: ApplyPresetState;
  /** Fully resolved cwd used by duplicate checks and card creation. */
  resolvedCwd?: string;
  /** Interpolated command used by duplicate checks and card creation. */
  resolvedCommand?: string;
  /** When `state === 'duplicate'`, id of the existing card. */
  duplicateOf?: string;
  /** When `state === 'missing-args'`, names of args without `default_value`. */
  missingArgs?: string[];
}

export interface ExistingCardForDedup {
  id: string;
  cwd: string;
  command: string;
}

export function normalizeCwd(cwd: string): string {
  // Collapse repeated trailing slashes/backslashes; do NOT case-fold.
  const trimmed = cwd.trim();
  if (/^[/\\]+$/.test(trimmed)) return trimmed[0] ?? '';
  if (/^[A-Za-z]:[/\\]+$/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.replace(/[/\\]+$/, '');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizePathSegments(path: string): string {
  const usesBackslash = /^[A-Za-z]:\\/.test(path);
  const separator = usesBackslash ? '\\' : '/';
  const normalized = path.replace(/[\\/]+/g, separator);
  const driveMatch = normalized.match(/^[A-Za-z]:/);
  const root = driveMatch ? `${driveMatch[0]}${separator}` : normalized.startsWith(separator) ? separator : '';
  const rest = driveMatch ? normalized.slice(3) : root ? normalized.slice(1) : normalized;
  const parts: string[] = [];

  for (const segment of rest.split(separator)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!root) {
        parts.push(segment);
      }
      continue;
    }
    parts.push(segment);
  }

  const body = parts.join(separator);
  if (!root) return body || '.';
  return body ? `${root}${body}` : root;
}

export function resolveWorkflowCwd(
  workflowCwd: string | undefined,
  fallbackCwd: string,
): string {
  const raw = workflowCwd?.trim() || fallbackCwd;
  if (isAbsolutePath(raw)) return normalizeCwd(normalizePathSegments(raw));
  const base = normalizeCwd(fallbackCwd);
  const separator = /^[A-Za-z]:\\/.test(base) ? '\\' : '/';
  return normalizeCwd(normalizePathSegments(`${base}${separator}${raw}`));
}

export function normalizeCommand(command: string): string {
  return command.trim();
}

function findMissingArgs(workflow: Workflow): string[] {
  if (!workflow.arguments || workflow.arguments.length === 0) return [];
  return workflow.arguments
    .filter((arg) => typeof arg.default_value !== 'string')
    .map((arg) => arg.name);
}

export function classifyApplyEntries(
  workflows: Array<Workflow & { filePath: string }>,
  existingCards: ExistingCardForDedup[],
  fallbackCwd: string,
): ApplyPresetEntry[] {
  const cardKeys = new Map<string, string>();
  for (const card of existingCards) {
    const key = `${normalizeCwd(card.cwd)}::${normalizeCommand(card.command)}`;
    if (!cardKeys.has(key)) cardKeys.set(key, card.id);
  }

  return workflows.map((workflow) => {
    const resolvedCwd = resolveWorkflowCwd(workflow.cwd, fallbackCwd);
    const missingDefaults = findMissingArgs(workflow);
    if (missingDefaults.length > 0) {
      return {
        workflow,
        state: 'missing-args',
        missingArgs: missingDefaults,
        resolvedCwd,
      };
    }

    const interpolation = interpolateWorkflow(workflow);
    if (interpolation.kind === 'missing') {
      return {
        workflow,
        state: 'missing-args',
        missingArgs: interpolation.missingArgs,
        resolvedCwd,
      };
    }
    const cwd = resolvedCwd;
    const command = normalizeCommand(interpolation.command);
    const key = `${cwd}::${command}`;
    const existingId = cardKeys.get(key);
    if (existingId) {
      return {
        workflow,
        state: 'duplicate',
        duplicateOf: existingId,
        resolvedCwd: cwd,
        resolvedCommand: command,
      };
    }
    return { workflow, state: 'new', resolvedCwd: cwd, resolvedCommand: command };
  });
}
