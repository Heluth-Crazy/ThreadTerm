import { join } from '@tauri-apps/api/path';
import { readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

import {
  createWorkflowImportPlan,
  fetchWorkflowImportText,
  parseWorkflowImportText,
  type WorkflowImportFetchOptions,
  type WorkflowImportFetchResponse,
  type WorkflowImportFetcher,
  type WorkflowImportPlan,
  type WorkflowImportResult,
} from './importWorkflow';
import { ensureDir, resolveProjectWorkflowsDir } from './tauriFs';

const fetchWorkflowYaml: WorkflowImportFetcher = (
  url: string,
  options: WorkflowImportFetchOptions,
): Promise<WorkflowImportFetchResponse> => tauriFetch(url, options);

function isMissingFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such file|not found/i.test(message) || message.startsWith('ENOENT');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function previewProjectWorkflowUrlImport(
  rawUrl: string,
  projectCwd: string,
): Promise<WorkflowImportResult<WorkflowImportPlan>> {
  const fetched = await fetchWorkflowImportText(rawUrl, fetchWorkflowYaml);
  if (fetched.kind === 'error') return fetched;

  const parsed = parseWorkflowImportText(
    fetched.value.sourceUrl,
    fetched.value.yamlText,
  );
  if (parsed.kind === 'error') return parsed;

  const targetDir = await resolveProjectWorkflowsDir(projectCwd);
  const targetFilePath = await join(targetDir, parsed.value.targetFileName);

  let existingText: string | null = null;
  try {
    await stat(targetFilePath);
    existingText = await readTextFile(targetFilePath);
  } catch (err) {
    if (!isMissingFileError(err)) {
      return {
        kind: 'error',
        error: {
          reason: 'read-existing-failed',
          message: messageOf(err),
        },
      };
    }
  }

  return {
    kind: 'success',
    value: createWorkflowImportPlan({
      projectCwd,
      targetDir,
      targetFilePath,
      yamlText: fetched.value.yamlText,
      existingText,
      parsed: parsed.value,
    }),
  };
}

export async function saveProjectWorkflowImportPlan(
  plan: WorkflowImportPlan,
): Promise<void> {
  await ensureDir(plan.targetDir);
  await writeTextFile(plan.targetFilePath, plan.yamlText);
}
