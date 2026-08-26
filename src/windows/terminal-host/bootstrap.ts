import type { SurfaceBootstrap, TerminalHostRequest } from './protocol';

function eventKey(surface: SurfaceBootstrap): string {
  return [
    surface.runtimeId,
    surface.handle,
    surface.revision,
    surface.streamId,
    surface.attachId,
    surface.barrierSeq,
  ].join(':');
}

/** Rejects duplicate native bootstrap events without suppressing a newer resync barrier. */
export class BootstrapEventGuard {
  private lastKey: string | null = null;

  take(surface: SurfaceBootstrap): boolean {
    const nextKey = eventKey(surface);
    if (nextKey === this.lastKey) return false;
    this.lastKey = nextKey;
    return true;
  }
}

export function matchesSurfaceIdentity(
  surface: SurfaceBootstrap,
  identity: TerminalHostRequest,
): boolean {
  return surface.runtimeId === identity.runtimeId
    && surface.handle === identity.handle
    && surface.revision === identity.revision
    && surface.streamId === identity.streamId
    && surface.attachId === identity.attachId;
}
