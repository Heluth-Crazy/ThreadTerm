export type FloatMode = "manual" | "tile" | "cycle";
export type FloatIdentity = { sessionId?: string; workspaceId?: string };
export type Rect = { x: number; y: number; width: number; height: number };

export function floatIdentity({ sessionId, workspaceId }: FloatIdentity): string | undefined {
  return sessionId ? `session:${sessionId}` : workspaceId ? `workspace:${workspaceId}` : undefined;
}

export function nextFloatKey(keys: readonly string[], current?: string): string | undefined {
  if (!keys.length) return undefined;
  const currentIndex = current ? keys.indexOf(current) : -1;
  return keys[(currentIndex + 1 + keys.length) % keys.length];
}

export function tiledFloatBounds(area: Rect, count: number, minWidth = 520, minHeight = 400): Rect[] {
  if (!count) return [];
  const columns = Math.max(1, Math.min(count, Math.floor(area.width / minWidth) || 1));
  const rows = Math.max(1, Math.floor(area.height / minHeight) || 1);
  const capacity = columns * rows;
  const width = Math.min(area.width, Math.max(1, Math.floor(area.width / columns)));
  const height = Math.min(area.height, Math.max(1, Math.floor(area.height / rows)));
  return Array.from({ length: count }, (_, index) => ({
    // More windows than visible slots intentionally stack on the same slot;
    // all bounds stay inside the monitor work area.
    x: area.x + ((index % capacity) % columns) * width,
    y: area.y + Math.floor((index % capacity) / columns) * height,
    width,
    height,
  }));
}
