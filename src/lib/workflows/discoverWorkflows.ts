/**
 * Workflow file discovery + per-source dedup + cross-source override.
 *
 * Pure module: callers inject the filesystem reader so this stays unit
 * testable without Tauri. Behavior matches PRD R2 + D5/A1/A2/A3 + D4.
 *
 * Source precedence: project workflows override global ones with the same
 * `name`. Within a single source, the first occurrence of a name wins and
 * later ones are reported as duplicate-name errors.
 */
import { parseWorkflowDocuments, type Workflow } from './parseWorkflow';

export interface WorkflowFsEntry {
  name: string;
  size: number;
}

export interface WorkflowFs {
  readDir: (path: string) => Promise<WorkflowFsEntry[]>;
  readTextFile: (path: string) => Promise<string>;
}

export type WorkflowSource = 'global' | 'project';

export interface DiscoveredWorkflow extends Workflow {
  source: WorkflowSource;
  filePath: string;
}

export type DiscoveryErrorReason =
  | 'parse-failed'
  | 'too-large'
  | 'duplicate-name'
  | 'read-failed';

export interface DiscoveryError {
  source: WorkflowSource;
  filePath: string;
  reason: DiscoveryErrorReason;
  message: string;
}

export interface DiscoveryResult {
  workflows: DiscoveredWorkflow[];
  errors: DiscoveryError[];
}

export interface DiscoveryPaths {
  globalDir: string | null;
  projectDir: string | null;
}

export const MAX_WORKFLOW_FILE_BYTES = 256 * 1024;

const YAML_EXTENSIONS = ['.yaml', '.yml'];

function hasYamlExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return YAML_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${name}`;
  return `${dir}/${name}`;
}

// Pragmatic ENOENT detection: Tauri's fs plugin surfaces "No such file" or
// errors that begin with "ENOENT". A missing source dir is normal (user just
// hasn't created `~/.threadterm/workflows/` yet), so swallow it. Real errors
// (permission denied, etc.) bubble up as `read-failed`.
function isMissingDirError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such file/i.test(message) || message.startsWith('ENOENT');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadFromSource(
  fs: WorkflowFs,
  dir: string,
  source: WorkflowSource,
): Promise<DiscoveryResult> {
  let entries: WorkflowFsEntry[];
  try {
    entries = await fs.readDir(dir);
  } catch (err) {
    if (isMissingDirError(err)) {
      return { workflows: [], errors: [] };
    }
    return {
      workflows: [],
      errors: [
        {
          source,
          filePath: dir,
          reason: 'read-failed',
          message: errorMessage(err),
        },
      ],
    };
  }

  const workflows: DiscoveredWorkflow[] = [];
  const errors: DiscoveryError[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (!hasYamlExtension(entry.name)) continue;
    const filePath = joinPath(dir, entry.name);
    if (entry.size > MAX_WORKFLOW_FILE_BYTES) {
      errors.push({
        source,
        filePath,
        reason: 'too-large',
        message: `file exceeds ${MAX_WORKFLOW_FILE_BYTES} bytes (size ${entry.size})`,
      });
      continue;
    }

    let text: string;
    try {
      text = await fs.readTextFile(filePath);
    } catch (err) {
      errors.push({
        source,
        filePath,
        reason: 'read-failed',
        message: errorMessage(err),
      });
      continue;
    }

    const docs = parseWorkflowDocuments(text);
    for (const doc of docs) {
      if (doc.kind === 'error') {
        errors.push({
          source,
          filePath,
          reason: 'parse-failed',
          message: doc.message,
        });
        continue;
      }
      if (seenNames.has(doc.workflow.name)) {
        errors.push({
          source,
          filePath,
          reason: 'duplicate-name',
          message: `workflow name "${doc.workflow.name}" already loaded from this source`,
        });
        continue;
      }
      seenNames.add(doc.workflow.name);
      workflows.push({ ...doc.workflow, source, filePath });
    }
  }

  return { workflows, errors };
}

export async function discoverWorkflows(
  fs: WorkflowFs,
  paths: DiscoveryPaths,
): Promise<DiscoveryResult> {
  const globalResult = paths.globalDir
    ? await loadFromSource(fs, paths.globalDir, 'global')
    : { workflows: [], errors: [] };
  const projectResult = paths.projectDir
    ? await loadFromSource(fs, paths.projectDir, 'project')
    : { workflows: [], errors: [] };

  const projectNames = new Set(projectResult.workflows.map((w) => w.name));
  const globalKept = globalResult.workflows.filter((w) => !projectNames.has(w.name));

  return {
    workflows: [...globalKept, ...projectResult.workflows],
    errors: [...globalResult.errors, ...projectResult.errors],
  };
}
