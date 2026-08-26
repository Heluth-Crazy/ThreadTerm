import type { Presentation } from './protocol';

/** Background creates are visible, but focus remains exclusively backend-owned. */
export function shouldFocusAfterSurfaceReady(presentation: Presentation): boolean {
  return presentation === 'focused';
}
