import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWorkbenchOverview } from '../../lib/workbench/types';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import { ProjectOverviewGrid } from './ProjectOverviewGrid';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } & Record<string, string | number>) => {
      let value = options?.defaultValue ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        value = value.split(`{{${name}}}`).join(String(replacement));
      }
      return value;
    },
    i18n: { language: 'en' },
  }),
}));

function makeProject(
  overrides: Partial<ProjectWorkbenchOverview> = {},
): ProjectWorkbenchOverview {
  return {
    projectPath: '/repo',
    projectName: 'Repo',
    followedCount: 1,
    runningCount: 2,
    attentionCount: 3,
    reviewCount: 1,
    failedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useWorkbenchStore.setState({
    projectOrder: [],
    pinnedProjects: [],
  });
});

describe('ProjectOverviewGrid', () => {
  it('renders pinned project cards in pinned order and opens the project scope', () => {
    const onSelectProject = vi.fn();
    useWorkbenchStore.setState({
      pinnedProjects: ['/beta', '/alpha', '/missing'],
    });

    render(
      <ProjectOverviewGrid
        projects={[
          makeProject({ projectPath: '/alpha', projectName: 'Alpha' }),
          makeProject({ projectPath: '/beta', projectName: 'Beta' }),
        ]}
        onSelectProject={onSelectProject}
      />,
    );

    const cards = screen.getAllByTestId('workbench-pinned-project-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-project-path', '/beta');
    expect(cards[1]).toHaveAttribute('data-project-path', '/alpha');

    fireEvent.click(screen.getByTitle('/alpha'));
    expect(onSelectProject).toHaveBeenCalledWith('/alpha');
  });

  it('renders at most six pinned cards', () => {
    const projects = Array.from({ length: 8 }, (_, index) =>
      makeProject({
        projectPath: `/p${index}`,
        projectName: `P${index}`,
      }),
    );
    for (const project of projects) {
      useWorkbenchStore.getState().pinProject(project.projectPath);
    }

    render(
      <ProjectOverviewGrid projects={projects} onSelectProject={vi.fn()} />,
    );

    expect(
      screen.getAllByTestId('workbench-pinned-project-card'),
    ).toHaveLength(6);
  });

  it('shows an empty state whose call to action opens the pin dialog', () => {
    render(
      <ProjectOverviewGrid
        projects={[makeProject()]}
        onSelectProject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('workbench-pinned-empty')).toBeInTheDocument();
    expect(screen.getByText('No pinned projects yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pin a project' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('workbench-pin-zone')).toBeInTheDocument();
    expect(screen.getByText('All projects')).toBeInTheDocument();
  });

  it('opens the pin dialog from the view-all button and closes it', () => {
    render(
      <ProjectOverviewGrid
        projects={[makeProject()]}
        onSelectProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /View all/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks pinned rows inside the dialog and unpins from the pin zone chip', () => {
    useWorkbenchStore.setState({ pinnedProjects: ['/repo'] });

    render(
      <ProjectOverviewGrid
        projects={[makeProject()]}
        onSelectProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /View all/ }));

    expect(screen.getAllByText('Pinned').length).toBeGreaterThan(0);
    expect(screen.getByTestId('workbench-pinned-chip')).toHaveAttribute(
      'data-project-path',
      '/repo',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unpin Repo' }));

    expect(useWorkbenchStore.getState().pinnedProjects).toEqual([]);
    expect(screen.queryByTestId('workbench-pinned-chip')).toBeNull();
  });
});
