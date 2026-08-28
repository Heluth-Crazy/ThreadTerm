import { describe, expect, it, vi } from 'vitest';
import {
  applyPinDialogDragEnd,
  PIN_ZONE_ID,
} from './ProjectPinDialog';

describe('applyPinDialogDragEnd', () => {
  const visibleProjectPaths = ['/a', '/b', '/c'];

  function options(overrides: {
    pinnedProjects?: string[];
    pinProject?: (projectPath: string) => void;
    moveProject?: (
      activeProjectPath: string,
      overProjectPath: string,
      visibleProjectPaths: readonly string[],
    ) => void;
    onPinFull?: () => void;
  } = {}) {
    return {
      pinnedProjects: overrides.pinnedProjects ?? [],
      visibleProjectPaths,
      pinProject: overrides.pinProject ?? vi.fn(),
      moveProject: overrides.moveProject ?? vi.fn(),
      onPinFull: overrides.onPinFull ?? vi.fn(),
    };
  }

  it('pins a project dropped on the pin zone', () => {
    const pinProject = vi.fn();
    const moveProject = vi.fn();
    applyPinDialogDragEnd(
      { active: { id: '/b' }, over: { id: PIN_ZONE_ID } } as never,
      options({ pinProject, moveProject }),
    );
    expect(pinProject).toHaveBeenCalledWith('/b');
    expect(moveProject).not.toHaveBeenCalled();
  });

  it('does not pin a new project when the zone is full', () => {
    const pinProject = vi.fn();
    const onPinFull = vi.fn();
    applyPinDialogDragEnd(
      { active: { id: '/new' }, over: { id: PIN_ZONE_ID } } as never,
      options({
        pinnedProjects: ['/1', '/2', '/3', '/4', '/5', '/6'],
        pinProject,
        onPinFull,
      }),
    );
    expect(pinProject).not.toHaveBeenCalled();
    expect(onPinFull).toHaveBeenCalledTimes(1);
  });

  it('reorders when dropped on another project row', () => {
    const pinProject = vi.fn();
    const moveProject = vi.fn();
    applyPinDialogDragEnd(
      { active: { id: '/a' }, over: { id: '/c' } } as never,
      options({ pinProject, moveProject }),
    );
    expect(pinProject).not.toHaveBeenCalled();
    expect(moveProject).toHaveBeenCalledWith('/a', '/c', visibleProjectPaths);
  });

  it('ignores a drop with no target', () => {
    const pinProject = vi.fn();
    const moveProject = vi.fn();
    applyPinDialogDragEnd(
      { active: { id: '/a' }, over: null } as never,
      options({ pinProject, moveProject }),
    );
    expect(pinProject).not.toHaveBeenCalled();
    expect(moveProject).not.toHaveBeenCalled();
  });
});
