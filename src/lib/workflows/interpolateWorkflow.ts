/**
 * Pure `{{name}}` substitution for Workflow.command per PRD D3.
 *
 * MVP scope: only `command` is interpolated (not cwd / intent / description).
 * Returns a discriminated union: callers either run the substituted command
 * or surface the missing arg names so the WorkflowArgsDialog can collect them.
 */
import type { Workflow } from './parseWorkflow';

export type InterpolationValues = Record<string, string>;

export type InterpolateResult =
  | { kind: 'ready'; command: string }
  | { kind: 'missing'; missingArgs: string[] };

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function buildValuesMap(
  workflow: Workflow,
  overrides: InterpolationValues | undefined,
): InterpolationValues {
  const merged: InterpolationValues = {};
  if (workflow.arguments) {
    for (const arg of workflow.arguments) {
      if (typeof arg.default_value === 'string') {
        merged[arg.name] = arg.default_value;
      }
    }
  }
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      merged[key] = overrides[key];
    }
  }
  return merged;
}

export function interpolateWorkflow(
  workflow: Workflow,
  overrides?: InterpolationValues,
): InterpolateResult {
  const values = buildValuesMap(workflow, overrides);
  const missing = new Set<string>();

  const substituted = workflow.command.replace(PLACEHOLDER_REGEX, (match, rawName: string) => {
    const name = rawName;
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name];
    }
    missing.add(name);
    return match;
  });

  if (missing.size > 0) {
    return { kind: 'missing', missingArgs: [...missing] };
  }
  return { kind: 'ready', command: substituted };
}
