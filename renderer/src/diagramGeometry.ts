export function diagramDimensions(svg: string) {
  const values = /\bviewBox=["']([^"']+)["']/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return values?.length === 4 && values.every(Number.isFinite) && values[2]! > 0 && values[3]! > 0 ? { width: values[2]!, height: values[3]! } : { width: 300, height: 150 };
}
export function diagramRasterSize(size: { width: number; height: number }, limit = 4096) {
  const scale = Math.min(1, limit / size.width, limit / size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}
