/**
 * Pure YAML → Workflow parser for Stage 7.1.
 *
 * Schema follows warpdotdev/workflows with two ThreadTerm extensions
 * (`intent`, `cwd`). Unknown top-level fields are dropped silently and
 * collected into `droppedFields` so we stay forward-compatible per
 * IMPLEMENTATION_PLAN.md Stage 7 + PRD R1.
 *
 * Zero React, zero Tauri, zero filesystem imports — the whole module is
 * deterministic and unit-testable on plain strings.
 */
import { load, loadAll, YAMLException } from 'js-yaml';

export interface WorkflowArgument {
  name: string;
  description?: string;
  default_value?: string;
}

export interface Workflow {
  name: string;
  command: string;
  tags?: string[];
  description?: string;
  arguments?: WorkflowArgument[];
  // ThreadTerm extensions per plan + PRD R1.
  intent?: string;
  cwd?: string;
}

export type ParseWorkflowError =
  | 'name-required'
  | 'command-required'
  | 'invalid-yaml'
  | 'not-an-object';

export type ParseWorkflowResult =
  | { kind: 'success'; workflow: Workflow; droppedFields: string[] }
  | { kind: 'error'; reason: ParseWorkflowError; message: string };

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'command',
  'tags',
  'description',
  'arguments',
  'intent',
  'cwd',
]);

const KNOWN_ARG_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'default_value',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildWorkflow(raw: Record<string, unknown>): {
  workflow: Workflow;
  droppedFields: string[];
} {
  const droppedFields: string[] = [];
  const workflow: Workflow = {
    name: raw.name as string,
    command: raw.command as string,
  };

  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((t): t is string => typeof t === 'string');
    if (tags.length === raw.tags.length) {
      workflow.tags = tags;
    } else {
      droppedFields.push('tags');
    }
  } else if (raw.tags !== undefined) {
    droppedFields.push('tags');
  }

  if (typeof raw.description === 'string') {
    workflow.description = raw.description;
  } else if (raw.description !== undefined) {
    droppedFields.push('description');
  }

  if (typeof raw.intent === 'string') {
    workflow.intent = raw.intent;
  } else if (raw.intent !== undefined) {
    droppedFields.push('intent');
  }

  if (typeof raw.cwd === 'string') {
    workflow.cwd = raw.cwd;
  } else if (raw.cwd !== undefined) {
    droppedFields.push('cwd');
  }

  if (Array.isArray(raw.arguments)) {
    const args: WorkflowArgument[] = [];
    for (let i = 0; i < raw.arguments.length; i += 1) {
      const item = raw.arguments[i];
      if (!isPlainObject(item) || !isNonEmptyString(item.name)) {
        droppedFields.push(`arguments[${i}]`);
        continue;
      }
      const arg: WorkflowArgument = { name: item.name };
      if (typeof item.description === 'string') {
        arg.description = item.description;
      }
      if (typeof item.default_value === 'string') {
        arg.default_value = item.default_value;
      }
      for (const key of Object.keys(item)) {
        if (!KNOWN_ARG_FIELDS.has(key)) {
          droppedFields.push(`arguments[${i}].${key}`);
        }
      }
      args.push(arg);
    }
    if (args.length > 0) {
      workflow.arguments = args;
    }
  } else if (raw.arguments !== undefined) {
    droppedFields.push('arguments');
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      droppedFields.push(key);
    }
  }

  return { workflow, droppedFields };
}

function parseValue(value: unknown): ParseWorkflowResult {
  if (!isPlainObject(value)) {
    return {
      kind: 'error',
      reason: 'not-an-object',
      message: 'workflow document must be a YAML mapping',
    };
  }
  if (!isNonEmptyString(value.name)) {
    return {
      kind: 'error',
      reason: 'name-required',
      message: 'workflow `name` is required and must be a non-empty string',
    };
  }
  if (!isNonEmptyString(value.command)) {
    return {
      kind: 'error',
      reason: 'command-required',
      message: 'workflow `command` is required and must be a non-empty string',
    };
  }
  const { workflow, droppedFields } = buildWorkflow(value);
  return { kind: 'success', workflow, droppedFields };
}

export function parseWorkflow(yamlText: string): ParseWorkflowResult {
  let parsed: unknown;
  try {
    parsed = load(yamlText);
  } catch (e) {
    const message =
      e instanceof YAMLException || e instanceof Error ? e.message : String(e);
    return { kind: 'error', reason: 'invalid-yaml', message };
  }
  return parseValue(parsed);
}

export function parseWorkflowDocuments(yamlText: string): ParseWorkflowResult[] {
  const docs: unknown[] = [];
  try {
    loadAll(yamlText, (doc) => {
      docs.push(doc);
    });
  } catch (e) {
    const message =
      e instanceof YAMLException || e instanceof Error ? e.message : String(e);
    return [{ kind: 'error', reason: 'invalid-yaml', message }];
  }
  if (docs.length === 0) {
    return [
      {
        kind: 'error',
        reason: 'not-an-object',
        message: 'no YAML documents found',
      },
    ];
  }
  return docs.map(parseValue);
}
