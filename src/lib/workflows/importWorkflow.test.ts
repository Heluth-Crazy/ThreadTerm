import { describe, expect, it, vi } from 'vitest';
import { MAX_WORKFLOW_FILE_BYTES } from './discoverWorkflows';
import {
  createWorkflowImportPlan,
  deriveWorkflowImportFileName,
  fetchWorkflowImportText,
  parseWorkflowImportText,
  validateWorkflowImportUrl,
  WORKFLOW_IMPORT_CONNECT_TIMEOUT_MS,
  WORKFLOW_IMPORT_MAX_REDIRECTIONS,
  type ParsedWorkflowImport,
  type WorkflowImportFetcher,
} from './importWorkflow';

function response(status: number, body: string, statusText = 'OK') {
  return { status, statusText, text: () => Promise.resolve(body) };
}

describe('workflow URL import', () => {
  it('fetches HTTPS workflow YAML with timeout and redirect limits', async () => {
    const fetcher = vi.fn<WorkflowImportFetcher>().mockResolvedValue(
      response(
        200,
        `
name: Deploy
command: npm run deploy
`,
      ),
    );

    const result = await fetchWorkflowImportText(
      'https://example.com/workflows/deploy.yaml',
      fetcher,
    );

    expect(result.kind).toBe('success');
    expect(fetcher).toHaveBeenCalledWith('https://example.com/workflows/deploy.yaml', {
      method: 'GET',
      connectTimeout: WORKFLOW_IMPORT_CONNECT_TIMEOUT_MS,
      maxRedirections: WORKFLOW_IMPORT_MAX_REDIRECTIONS,
    });
  });

  it('rejects http URLs before fetching', async () => {
    const fetcher = vi.fn<WorkflowImportFetcher>();

    const result = await fetchWorkflowImportText('http://example.com/a.yaml', fetcher);

    expect(result).toMatchObject({
      kind: 'error',
      error: { reason: 'unsupported-scheme' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs and credential URLs', () => {
    expect(validateWorkflowImportUrl('not a url')).toMatchObject({
      kind: 'error',
      error: { reason: 'invalid-url' },
    });
    expect(validateWorkflowImportUrl('https://u:p@example.com/a.yaml')).toMatchObject({
      kind: 'error',
      error: { reason: 'credentials-not-allowed' },
    });
  });

  it('normalizes timeout failures', async () => {
    const fetcher = vi
      .fn<WorkflowImportFetcher>()
      .mockRejectedValue(new Error('operation timed out'));

    const result = await fetchWorkflowImportText(
      'https://example.com/workflows/deploy.yaml',
      fetcher,
    );

    expect(result).toMatchObject({
      kind: 'error',
      error: { reason: 'timeout' },
    });
  });

  it('rejects non-2xx statuses', async () => {
    const fetcher = vi
      .fn<WorkflowImportFetcher>()
      .mockResolvedValue(response(404, 'not found', 'Not Found'));

    const result = await fetchWorkflowImportText(
      'https://example.com/missing.yaml',
      fetcher,
    );

    expect(result).toMatchObject({
      kind: 'error',
      error: { reason: 'http-status', status: 404, statusText: 'Not Found' },
    });
  });

  it('rejects oversized response bodies', async () => {
    const fetcher = vi
      .fn<WorkflowImportFetcher>()
      .mockResolvedValue(response(200, 'x'.repeat(MAX_WORKFLOW_FILE_BYTES + 1)));

    const result = await fetchWorkflowImportText(
      'https://example.com/large.yaml',
      fetcher,
    );

    expect(result).toMatchObject({
      kind: 'error',
      error: { reason: 'too-large' },
    });
  });

  it('parses valid multi-document YAML and dropped-field warnings', () => {
    const result = parseWorkflowImportText(
      'https://example.com/team.yaml',
      `
name: Install
command: npm install
extra: ignored
---
name: Test
command: npm test
`,
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.value.workflows.map((workflow) => workflow.name)).toEqual([
      'Install',
      'Test',
    ]);
    expect(result.value.droppedFields).toEqual([
      { workflowName: 'Install', documentIndex: 0, fields: ['extra'] },
    ]);
  });

  it('rejects invalid YAML and missing required fields', () => {
    expect(parseWorkflowImportText('https://example.com/a.yaml', 'name: [')).toMatchObject({
      kind: 'error',
      error: { reason: 'parse-failed' },
    });
    expect(parseWorkflowImportText('https://example.com/a.yaml', 'name: Only')).toMatchObject({
      kind: 'error',
      error: { reason: 'parse-failed' },
    });
  });

  it('derives target filenames from URL basename or workflow name', () => {
    expect(
      deriveWorkflowImportFileName('https://example.com/workflows/deploy.yml', 'Ignored'),
    ).toBe('deploy.yml');
    expect(
      deriveWorkflowImportFileName('https://example.com/raw?id=1', 'Deploy Web'),
    ).toBe('deploy-web.yaml');
  });

  it('builds create and overwrite plans', () => {
    const parsed: ParsedWorkflowImport = {
      sourceUrl: 'https://example.com/deploy.yaml',
      targetFileName: 'deploy.yaml',
      workflows: [{ name: 'Deploy', command: 'npm run deploy' }],
      droppedFields: [],
    };

    expect(
      createWorkflowImportPlan({
        projectCwd: '/repo',
        targetDir: '/repo/.threadterm/workflows',
        targetFilePath: '/repo/.threadterm/workflows/deploy.yaml',
        yamlText: 'name: Deploy\ncommand: npm run deploy\n',
        existingText: null,
        parsed,
      }).action,
    ).toBe('create');

    expect(
      createWorkflowImportPlan({
        projectCwd: '/repo',
        targetDir: '/repo/.threadterm/workflows',
        targetFilePath: '/repo/.threadterm/workflows/deploy.yaml',
        yamlText: 'name: Deploy\ncommand: npm run deploy\n',
        existingText: 'name: Old\ncommand: old\n',
        parsed,
      }).action,
    ).toBe('overwrite');
  });
});
