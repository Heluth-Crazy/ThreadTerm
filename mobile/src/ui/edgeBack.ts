/** Reserve only the leading 24pt; terminal and diff panning elsewhere stay native. */
export const BACK_EDGE_WIDTH = 24;

export function shouldStartEdgeBack(startX: number, dx: number, dy: number, touches: number): boolean {
  return touches === 1 && startX >= 0 && startX <= BACK_EDGE_WIDTH && dx > 6 && dx > Math.abs(dy) * 1.5;
}

export function shouldFinishEdgeBack(dx: number, vx: number, width: number): boolean {
  // A reversal cancels even after crossing the distance threshold.
  return vx >= -0.1 && (dx >= width / 3 || (dx >= 24 && vx >= 0.5));
}
