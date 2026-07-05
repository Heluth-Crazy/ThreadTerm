import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceCodeEditor } from './WorkspaceCodeEditor';

vi.mock('@uiw/react-codemirror', () => ({
  default: () => <textarea aria-label="mock editor" readOnly />,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('WorkspaceCodeEditor HTML service preview', () => {
  it('shows URL controls and blocks non-local service URLs for service-required HTML', () => {
    render(
      <WorkspaceCodeEditor
        value='<div id="root"></div><script type="module" src="/src/main.tsx"></script>'
        path="/repo/index.html"
        rootPath="/repo"
        active
      />,
    );

    fireEvent.click(screen.getByText('workspace.previewPreview'));
    const input = screen.getByLabelText('workspace.previewServiceUrlLabel');

    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByText('workspace.previewServiceUrlOpen'));

    expect(screen.getByText('workspace.previewServiceUrlInvalid')).toBeInTheDocument();
    expect(screen.queryByTitle('workspace.previewServiceUrlFrameTitle')).not.toBeInTheDocument();
  });
});
