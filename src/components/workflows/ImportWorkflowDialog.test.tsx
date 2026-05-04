import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportWorkflowDialog } from './ImportWorkflowDialog';
import type { WorkflowImportPlan } from '../../lib/workflows/importWorkflow';

const previewMock = vi.fn();
const saveMock = vi.fn();

vi.mock('../../lib/workflows/tauriWorkflowImport', () => ({
  previewProjectWorkflowUrlImport: (...args: unknown[]) => previewMock(...args),
  saveProjectWorkflowImportPlan: (...args: unknown[]) => saveMock(...args),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => {
  cleanup();
  previewMock.mockReset();
  saveMock.mockReset();
});

function plan(): WorkflowImportPlan {
  return {
    sourceUrl: 'https://example.com/deploy.yaml',
    projectCwd: '/repo',
    targetDir: '/repo/.threadterm/workflows',
    targetFileName: 'deploy.yaml',
    targetFilePath: '/repo/.threadterm/workflows/deploy.yaml',
    action: 'create',
    yamlText: 'name: Deploy\ncommand: npm run deploy\n',
    existingText: null,
    workflows: [{ name: 'Deploy', command: 'npm run deploy' }],
    droppedFields: [],
  };
}

describe('ImportWorkflowDialog', () => {
  it('previews a URL and imports the resulting plan', async () => {
    const imported = vi.fn();
    const previewPlan = plan();
    previewMock.mockResolvedValueOnce({ kind: 'success', value: previewPlan });
    saveMock.mockResolvedValueOnce(undefined);

    render(
      <ImportWorkflowDialog
        open
        projectName="repo"
        projectPath="/repo"
        onCancel={vi.fn()}
        onImported={imported}
      />,
    );

    fireEvent.change(screen.getByLabelText('Workflow URL'), {
      target: { value: 'https://example.com/deploy.yaml' },
    });
    fireEvent.click(screen.getByText('Preview'));

    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith('https://example.com/deploy.yaml', '/repo'),
    );
    expect(await screen.findByText('Deploy')).toBeInTheDocument();
    expect(screen.getByText('/repo/.threadterm/workflows/deploy.yaml')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Import'));

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(previewPlan));
    expect(imported).toHaveBeenCalledWith(previewPlan);
  });

  it('shows preview errors and keeps import disabled', async () => {
    previewMock.mockResolvedValueOnce({
      kind: 'error',
      error: { reason: 'unsupported-scheme', message: 'Only HTTPS workflow URLs are allowed.' },
    });

    render(
      <ImportWorkflowDialog
        open
        projectName="repo"
        projectPath="/repo"
        onCancel={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Workflow URL'), {
      target: { value: 'http://example.com/deploy.yaml' },
    });
    fireEvent.click(screen.getByText('Preview'));

    expect(await screen.findByText('Only HTTPS workflow URLs are allowed.')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeDisabled();
  });
});
