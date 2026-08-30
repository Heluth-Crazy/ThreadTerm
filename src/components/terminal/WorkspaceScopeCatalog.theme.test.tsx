import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '../../lib/workspace/types';
import { useTerminalStore } from '../../stores/terminalStore';
import { applyResolvedTheme, resolveTheme } from '../../theme/applyTheme';
import { parseCustomThemePack, toPortableThemePack } from '../../theme/customThemePacks';
import { themePacks } from '../../theme/themePacks';
import type {
  WorkspaceCatalogController,
  WorkspaceCatalogEntry,
} from '../workspace/useWorkspaceCatalog';
import { WorkspaceCatalogProvider } from '../workspace/useWorkspaceCatalog';
import {
  __resetWorkspaceSidebarDisclosureForTests,
} from '../workspace/useWorkspaceSidebarDisclosure';
import { WorkspaceScopeCatalog } from './WorkspaceScopeCatalog';

const fileTab: WorkspaceTab = {
  id: 'file:src/app.ts',
  workspaceId: 'ws-theme',
  kind: 'file',
  title: 'app.ts',
  cardId: null,
  relativePath: 'src/app.ts',
  sharedOrder: 1,
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

function themeController(): WorkspaceCatalogController {
  const entry: WorkspaceCatalogEntry = {
    requestedRoot: '/repo',
    rootKey: '/repo',
    workspaceId: 'ws-theme',
    canonicalRoot: '/repo',
    tabs: [fileTab],
    dirtyByTabId: { [fileTab.id]: true },
    conflictByTabId: {},
    activeTabId: fileTab.id,
    loading: false,
    error: null,
  };
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

beforeEach(() => {
  localStorage.clear();
  __resetWorkspaceSidebarDisclosureForTests();
  useTerminalStore.setState({ cards: [] });
});

afterEach(() => {
  const root = document.documentElement;
  root.removeAttribute('data-theme-pack');
  root.classList.remove('dark');
  root.removeAttribute('style');
});

describe('WorkspaceScopeCatalog theme adaptation', () => {
  it('updates semantic variables in place across light, dark, and valid custom themes', () => {
    const lightPack = themePacks.find((pack) => pack.modes.light);
    const darkPack = themePacks.find((pack) => pack.modes.dark);
    expect(lightPack).toBeDefined();
    expect(darkPack).toBeDefined();
    if (!lightPack || !darkPack) return;

    render(
      <WorkspaceCatalogProvider controller={themeController()}>
        <WorkspaceScopeCatalog rootPath="/repo" onActivate={() => {}} />
      </WorkspaceCatalogProvider>,
    );
    const catalog = screen.getByTestId('workspace-scope-catalog');
    const filesCategory = screen.getByTestId('workspace-catalog-category-files');
    const filesHeader = within(filesCategory).getByRole('button');
    fireEvent.click(filesHeader);
    const selectedRow = screen.getByTitle('src/app.ts');
    expect(selectedRow).toHaveAttribute('aria-current', 'page');
    expect(selectedRow.className).toContain('bg-primary/10');
    expect(selectedRow.querySelector('.bg-warning')).not.toBeNull();

    applyResolvedTheme(resolveTheme(lightPack.id, 'light'));
    const lightBackground = document.documentElement.style.getPropertyValue('--background');
    expect(lightBackground).not.toBe('');
    expect(screen.getByTestId('workspace-scope-catalog')).toBe(catalog);
    expect(filesHeader).toHaveAttribute('aria-expanded', 'true');

    applyResolvedTheme(resolveTheme(darkPack.id, 'dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).not.toBe('');
    expect(screen.getByTestId('workspace-scope-catalog')).toBe(catalog);
    expect(selectedRow).toHaveAttribute('aria-current', 'page');

    const customPack = parseCustomThemePack(JSON.stringify({
      ...toPortableThemePack(lightPack),
      id: 'catalog-custom',
      name: 'Catalog custom',
    }));
    const customMode = customPack.modes.light ? 'light' : 'dark';
    applyResolvedTheme(resolveTheme(customPack.id, customMode, [customPack]));
    expect(document.documentElement.dataset.themePack).toBe(customPack.id);
    expect(screen.getByTestId('workspace-scope-catalog')).toBe(catalog);
    expect(filesHeader).toHaveAttribute('aria-expanded', 'true');
    expect(selectedRow).toHaveAttribute('aria-current', 'page');
  });
});
