import { MAX_WORKFLOW_FILE_BYTES } from './discoverWorkflows';
import {
  parseWorkflowDocuments,
  type ParseWorkflowResult,
  type Workflow,
} from './parseWorkflow';

export const WORKFLOW_IMPORT_CONNECT_TIMEOUT_MS = 10_000;
export const WORKFLOW_IMPORT_MAX_REDIRECTIONS = 0;

export type WorkflowImportErrorReason =
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'credentials-not-allowed'
  | 'fetch-failed'
  | 'timeout'
  | 'http-status'
  | 'empty-body'
  | 'too-large'
  | 'parse-failed'
  | 'read-existing-failed';

export interface WorkflowImportError {
  reason: WorkflowImportErrorReason;
  message: string;
  status?: number;
  statusText?: string;
}

export interface WorkflowImportFetchOptions {
  method: 'GET';
  connectTimeout: number;
  maxRedirections: number;
}

export interface WorkflowImportFetchResponse {
  status: number;
  statusText: string;
  text: () => Promise<string>;
}

export type WorkflowImportFetcher = (
  url: string,
  options: WorkflowImportFetchOptions,
) => Promise<WorkflowImportFetchResponse>;

export interface WorkflowImportFetchedText {
  sourceUrl: string;
  yamlText: string;
}

export interface ParsedWorkflowImport {
  sourceUrl: string;
  targetFileName: string;
  workflows: Workflow[];
  droppedFields: Array<{
    workflowName: string;
    documentIndex: number;
    fields: string[];
  }>;
}

export interface WorkflowImportPlan {
  sourceUrl: string;
  projectCwd: string;
  targetDir: string;
  targetFileName: string;
  targetFilePath: string;
  action: 'create' | 'overwrite';
  yamlText: string;
  existingText: string | null;
  workflows: Workflow[];
  droppedFields: ParsedWorkflowImport['droppedFields'];
}

export type WorkflowImportResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'error'; error: WorkflowImportError };

function importError(
  reason: WorkflowImportErrorReason,
  message: string,
  extra: Partial<WorkflowImportError> = {},
): WorkflowImportResult<never> {
  return { kind: 'error', error: { reason, message, ...extra } };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:\0]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '');
}

function workflowNameSlug(value: string): string {
  return sanitizeFileName(value.toLowerCase()) || 'workflow';
}

export function validateWorkflowImportUrl(
  rawUrl: string,
): WorkflowImportResult<string> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return importError('invalid-url', 'Enter a valid workflow URL.');
  }

  if (url.protocol !== 'https:') {
    return importError('unsupported-scheme', 'Only HTTPS workflow URLs are allowed.');
  }

  if (url.username || url.password) {
    return importError(
      'credentials-not-allowed',
      'Workflow URLs cannot contain usernames or passwords.',
    );
  }

  return { kind: 'success', value: url.toString() };
}

export function deriveWorkflowImportFileName(
  sourceUrl: string,
  firstWorkflowName?: string,
): string {
  let urlBaseName = '';
  try {
    const pathname = new URL(sourceUrl).pathname;
    urlBaseName = tryDecodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    urlBaseName = '';
  }

  const sanitizedUrlName = sanitizeFileName(urlBaseName);
  if (/\.ya?ml$/i.test(sanitizedUrlName)) {
    return sanitizedUrlName;
  }

  const stem = workflowNameSlug(firstWorkflowName ?? sanitizedUrlName);
  return `${stem.replace(/\.ya?ml$/i, '')}.yaml`;
}

function normalizeFetchFailure(err: unknown): WorkflowImportError {
  const message = err instanceof Error ? err.message : String(err);
  const reason = /timeout|timed out|aborted|cancelled/i.test(message)
    ? 'timeout'
    : 'fetch-failed';
  return { reason, message };
}

export async function fetchWorkflowImportText(
  rawUrl: string,
  fetcher: WorkflowImportFetcher,
): Promise<WorkflowImportResult<WorkflowImportFetchedText>> {
  const validation = validateWorkflowImportUrl(rawUrl);
  if (validation.kind === 'error') return validation;

  let response: WorkflowImportFetchResponse;
  try {
    response = await fetcher(validation.value, {
      method: 'GET',
      connectTimeout: WORKFLOW_IMPORT_CONNECT_TIMEOUT_MS,
      maxRedirections: WORKFLOW_IMPORT_MAX_REDIRECTIONS,
    });
  } catch (err) {
    return { kind: 'error', error: normalizeFetchFailure(err) };
  }

  if (response.status < 200 || response.status > 299) {
    return importError(
      'http-status',
      `Server returned ${response.status} ${response.statusText}`.trim(),
      { status: response.status, statusText: response.statusText },
    );
  }

  let yamlText: string;
  try {
    yamlText = await response.text();
  } catch (err) {
    return { kind: 'error', error: normalizeFetchFailure(err) };
  }

  if (yamlText.trim().length === 0) {
    return importError('empty-body', 'Workflow URL returned an empty file.');
  }

  const size = byteLength(yamlText);
  if (size > MAX_WORKFLOW_FILE_BYTES) {
    return importError(
      'too-large',
      `Workflow file exceeds ${MAX_WORKFLOW_FILE_BYTES} bytes (size ${size}).`,
    );
  }

  return {
    kind: 'success',
    value: { sourceUrl: validation.value, yamlText },
  };
}

function firstParseError(results: ParseWorkflowResult[]): ParseWorkflowResult | null {
  return results.find((result) => result.kind === 'error') ?? null;
}

export function parseWorkflowImportText(
  sourceUrl: string,
  yamlText: string,
): WorkflowImportResult<ParsedWorkflowImport> {
  const size = byteLength(yamlText);
  if (yamlText.trim().length === 0) {
    return importError('empty-body', 'Workflow URL returned an empty file.');
  }
  if (size > MAX_WORKFLOW_FILE_BYTES) {
    return importError(
      'too-large',
      `Workflow file exceeds ${MAX_WORKFLOW_FILE_BYTES} bytes (size ${size}).`,
    );
  }

  const parsed = parseWorkflowDocuments(yamlText);
  const parseError = firstParseError(parsed);
  if (parseError?.kind === 'error') {
    return importError('parse-failed', parseError.message);
  }

  const successes = parsed.filter(
    (result): result is Extract<ParseWorkflowResult, { kind: 'success' }> =>
      result.kind === 'success',
  );
  if (successes.length === 0) {
    return importError('parse-failed', 'No valid workflows found.');
  }

  return {
    kind: 'success',
    value: {
      sourceUrl,
      targetFileName: deriveWorkflowImportFileName(
        sourceUrl,
        successes[0].workflow.name,
      ),
      workflows: successes.map((result) => result.workflow),
      droppedFields: successes
        .map((result, index) => ({
          workflowName: result.workflow.name,
          documentIndex: index,
          fields: result.droppedFields,
        }))
        .filter((entry) => entry.fields.length > 0),
    },
  };
}

export function createWorkflowImportPlan(input: {
  projectCwd: string;
  targetDir: string;
  targetFilePath: string;
  yamlText: string;
  existingText: string | null;
  parsed: ParsedWorkflowImport;
}): WorkflowImportPlan {
  return {
    sourceUrl: input.parsed.sourceUrl,
    projectCwd: input.projectCwd,
    targetDir: input.targetDir,
    targetFileName: input.parsed.targetFileName,
    targetFilePath: input.targetFilePath,
    action: input.existingText === null ? 'create' : 'overwrite',
    yamlText: input.yamlText,
    existingText: input.existingText,
    workflows: input.parsed.workflows,
    droppedFields: input.parsed.droppedFields,
  };
}
