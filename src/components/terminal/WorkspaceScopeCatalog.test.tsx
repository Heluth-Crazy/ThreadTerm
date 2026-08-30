import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '../../lib/workspace/types';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  __resetMetadataCacheForTests,
  useAgentSessionMetadataCache,
} from '../../stores/agentSessionMetadataCache';
import { agentSessionMetadataCacheKey } from '../../types/agentSession';
import type {
  WorkspaceCatalogController,
  WorkspaceCatalogEntry,
  WorkspaceCatalogTabRef,
} from '../workspace/useWorkspaceCatalog';
import { WorkspaceCatalogProvider } from '../workspace/useWorkspaceCatalog';
import {
  __resetWorkspaceSidebarDisclosureForTests,
} from '../workspace/useWorkspaceSidebarDisclosure';
import { WorkspaceScopeCatalog } from './WorkspaceScopeCatalog';

function tab(
  id: string,
  kind: 'terminal' | 'file' | 'diff',
  order: number,
  path: string | null = null,
): WorkspaceTab {
  return {
    id,
    workspaceId: 'ws-1',
    kind,
    title: path?.split('/').pop() ?? id,
    cardId: kind === 'terminal' ? id.slice('terminal:'.length) : null,
    relativePath: path,
    sharedOrder: order,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
}

function controllerFor(entry: WorkspaceCatalogEntry): WorkspaceCatalogController {
  return {
    mount: vi.fn(),
    unmount: vi.fn(),
    registerRoot: vi.fn(),
    unregisterRoot: vi.fn(),
    getEntry: () => entry,
    getEntries: () => [entry],
    getRegisteredRootKeys: () => [entry.rootKey],
    getRevision: () => 0,
    subscribe: () => () => {},
    invalidateWorkspace: vi.fn(),
    retryRoot: vi.fn(),
    setSelectedOverlay: vi.fn(),
  };
}

function renderCatalog(entry: Partial<WorkspaceCatalogEntry> = {}) {
  const complete: WorkspaceCatalogEntry = {
    requestedRoot: '/repo',
    rootKey: '/repo',
    workspaceId: 'ws-1',
    canonicalRoot: '/repo',
    tabs: [],
    dirtyByTabId: {},
    conflictByTabId: {},
    activeTabId: null,
    loading: false,
    error: null,
    ...entry,
  };
  const controller = controllerFor(complete);
  const onActivate = vi.fn<(ref: WorkspaceCatalogTabRef) => void>();
  render(
    <WorkspaceCatalogProvider controller={controller}>
      <WorkspaceScopeCatalog rootPath="/repo" onActivate={onActivate} />
    </WorkspaceCatalogProvider>,
  );
  return { controller, onActivate };
}

beforeEach(() => {
  localStorage.clear();
  __resetWorkspaceSidebarDisclosureForTests();
  __resetMetadataCacheForTests();
  useTerminalStore.setState({ cards: [] });
});

afterEach(() => cleanup());

describe('WorkspaceScopeCatalog', () => {
  it('shows fixed headers with zero counts and persisted default disclosure', () => {
    const { controller } = renderCatalog();
    const headers = screen.getAllByRole('button');
    expect(headers.map((button) => button.textContent?.slice(-1))).toEqual(['0', '0', '0']);
    expect(headers[0]).toHaveAttribute('aria-expanded', 'true');
    expect(headers[1]).toHaveAttribute('aria-expanded', 'false');
    expect(headers[2]).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByTestId('workspace-catalog-category-sessions').querySelector('[id]'),
    ).not.toBeNull();
    expect(controller.registerRoot).toHaveBeenCalledWith('/repo');
  });

  it('keeps missing-card terminals visible with an exact activation reference', () => {
    const { onActivate } = renderCatalog({
      tabs: [tab('terminal:gone', 'terminal', 1)],
      activeTabId: 'terminal:gone',
    });
    const row = screen.getByTestId('workspace-catalog-row-terminal:gone');
    expect(row).toHaveTextContent('terminal:gone');
    expect(row).toHaveAttribute('aria-current', 'page');

    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      rootPath: '/repo',
      tabId: 'terminal:gone',
      kind: 'terminal',
      cardId: 'gone',
      relativePath: null,
    });
  });

  it('exposes full duplicate paths and non-color dirty/conflict state', () => {
    renderCatalog({
      tabs: [
        tab('file:one', 'file', 1, 'src/client/index.ts'),
        tab('file:two', 'file', 2, 'tests/client/index.ts'),
      ],
      activeTabId: 'file:two',
      dirtyByTabId: { 'file:two': true },
      conflictByTabId: { 'file:two': true },
    });
    fireEvent.click(within(
      screen.getByTestId('workspace-catalog-category-files'),
    ).getByRole('button'));

    expect(screen.getByTitle('src/client/index.ts')).toHaveTextContent('src/client');
    const selected = screen.getByTitle('tests/client/index.ts');
    expect(selected).toHaveAttribute('aria-current', 'page');
    expect(selected).toHaveTextContent('tests/client');
    expect(selected.querySelector('.bg-warning')).not.toBeNull();
    expect(selected.querySelector('.text-destructive')).not.toBeNull();
    expect(selected.getAttribute('aria-label')).toContain('tests/client/index.ts');
  });

  it('uses native buttons in visual category and row order', () => {
    renderCatalog({ tabs: [tab('terminal:one', 'terminal', 1)] });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons[0].textContent?.endsWith('1')).toBe(true);
    expect(buttons[1]).toHaveTextContent('terminal:one');
    expect(buttons[2].textContent?.endsWith('0')).toBe(true);
    expect(buttons[3].textContent?.endsWith('0')).toBe(true);
  });

  it('reuses provider metadata presentation and the official agent icon', () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'Fallback card title',
      projectPath: '/repo',
      terminalType: 'codex',
    });
    useTerminalStore.getState().markProviderSessionBound(cardId, 'session-1234567890');
    const key = agentSessionMetadataCacheKey('codex', 'session-1234567890', '/repo');
    useAgentSessionMetadataCache.setState({
      entries: new Map([[key, {
        key: {
          provider: 'codex',
          sessionId: 'session-1234567890',
          projectPath: '/repo',
        },
        status: 'found',
        summary: {
          provider: 'codex',
          id: 'session-1234567890',
          projectPath: '/repo',
          nativeTitle: 'Native catalog session',
          titleKind: 'explicit',
          resumable: true,
        },
        warning: null,
        updatedAt: Date.now(),
        generation: 1,
        expiresAt: Date.now() + 60_000,
      }]]),
    });

    renderCatalog({ tabs: [tab(`terminal:${cardId}`, 'terminal', 1)] });

    const row = screen.getByTestId(`workspace-catalog-row-terminal:${cardId}`);
    expect(row).toHaveTextContent('Native catalog session');
    expect(row.querySelector('[data-agent-icon="codex"]')).not.toBeNull();
    expect(row.title).toContain('…67890');
  });
});
