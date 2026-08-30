import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HOME_TAB_ID, type WorkspaceTab } from '../../lib/workspace/types';
import { WorkspaceTabStrip } from './WorkspaceTabStrip';

function workspaceTab(
  id: string,
  kind: WorkspaceTab['kind'],
  sharedOrder: number,
): WorkspaceTab {
  return {
    id,
    workspaceId: 'ws-1',
    kind,
    title: kind === 'home' ? 'Home' : id,
    cardId: kind === 'terminal' ? id.slice('terminal:'.length) : null,
    relativePath: kind === 'file' || kind === 'diff' ? id.slice(id.indexOf(':') + 1) : null,
    sharedOrder,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
}

describe('WorkspaceTabStrip desktop Home filtering', () => {
  it('renders and reorders only concrete authority tabs', () => {
    const onReorder = vi.fn();
    const onActivate = vi.fn();
    render(
      <WorkspaceTabStrip
        tabs={[
          workspaceTab(HOME_TAB_ID, 'home', 0),
          workspaceTab('terminal:card-1', 'terminal', 1),
          workspaceTab('file:src/app.ts', 'file', 2),
        ]}
        activeTabId={HOME_TAB_ID}
        dirtyTabIds={{}}
        closeLabel="Close"
        closeCurrentLabel="Close current"
        closeAllLabel="Close all"
        closeOthersLabel="Close others"
        onActivate={onActivate}
        onClose={() => {}}
        onCloseAll={() => {}}
        onCloseOthers={() => {}}
        onReorder={onReorder}
      />,
    );

    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.queryByTestId('workspace-tab-home')).toBeNull();
    fireEvent.click(screen.getByText('file:src/app.ts'));
    expect(onActivate).toHaveBeenCalledWith('file:src/app.ts');

    const terminal = screen.getByTestId('workspace-tab-terminal');
    const file = screen.getByTestId('workspace-tab-file');
    fireEvent.dragStart(file);
    fireEvent.drop(terminal);
    expect(onReorder).toHaveBeenCalledWith([
      'file:src/app.ts',
      'terminal:card-1',
    ]);
  });
});
