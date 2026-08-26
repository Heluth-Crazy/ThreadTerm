/**
 * A surface may become geometrically usable after its snapshot drains.  This
 * gate joins those two facts and consumes the ready transition exactly once
 * for a daemon presentation revision/attachment epoch.
 */
export class SurfaceReadyGate {
  private key: string | null = null;
  private snapshotWritten = false;
  private claimed = false;

  arm(key: string): void {
    if (this.key === key) return;
    this.key = key;
    this.snapshotWritten = false;
    this.claimed = false;
  }

  markSnapshotWritten(key: string): void {
    if (this.key === key) this.snapshotWritten = true;
  }

  takeIfReady(key: string, geometryUsable: boolean): boolean {
    if (this.key !== key || !this.snapshotWritten || !geometryUsable || this.claimed) {
      return false;
    }
    this.claimed = true;
    return true;
  }

  releaseClaim(key: string): void {
    if (this.key === key) this.claimed = false;
  }
}
