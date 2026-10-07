export type TerminalControlState = { phase: 'disabled' | 'recovering' | 'ready' | 'blocked' | 'failed' | 'incompatible'; epoch?: number; error?: unknown };
type Control = { epoch: number; release(): void; check(): Promise<void> };

/** Recover input ownership without replacing the PTY, screen or output subscription. */
export function createTerminalControl(
  acquire: (onLost: () => void) => Promise<Control>,
  changed: (state: TerminalControlState) => void,
  retryDelays = [250, 1000, 3000],
) {
  let enabled = false, disposed = false, generation = 0, attempts = 0, inFlight = false, requested = false;
  let control: Control | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
  const release = () => { const old = control; control = undefined; old?.release(); };
  const schedule = (error?: unknown) => {
    if (!enabled || disposed) return;
    cancelTimer();
    if (attempts >= retryDelays.length) { changed({ phase: 'failed', error }); return; }
    changed({ phase: 'recovering' });
    timer = setTimeout(() => { timer = undefined; void take(); }, retryDelays[attempts++]);
  };
  async function take() {
    if (!enabled || disposed || control) return;
    if (inFlight) { requested = true; return; }
    inFlight = true; requested = false;
    const token = generation;
    changed({ phase: 'recovering' });
    try {
      const claim = await acquire(() => {
        if (!enabled || disposed || token !== generation) return;
        generation++; release(); schedule();
      });
      if (!enabled || disposed || token !== generation) { claim.release(); return; }
      control = claim; attempts = 0;
      changed({ phase: 'ready', epoch: claim.epoch });
    } catch (error) {
      if (!enabled || disposed || token !== generation) return;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'lease_held' || /lease_held|lease held|held by another/i.test(String(error))) changed({ phase: 'blocked', error });
      else schedule(error);
    } finally {
      inFlight = false;
      if (requested && enabled && !disposed && !control) { requested = false; cancelTimer(); void take(); }
    }
  }
  async function retry(claimIfMissing = true) {
    if (!enabled || disposed) return;
    if (!control && (!claimIfMissing || inFlight)) return;
    cancelTimer(); attempts = 0;
    const current = control, token = generation;
    if (!current) { void take(); return; }
    changed({ phase: 'recovering', epoch: current.epoch });
    try {
      await current.check();
      if (enabled && !disposed && token === generation && control === current) changed({ phase: 'ready', epoch: current.epoch });
    } catch (error) {
      if (enabled && !disposed && token === generation && control === current) { generation++; release(); schedule(error); }
    }
  }
  function setEnabled(next: boolean) {
    if (disposed || next === enabled) return;
    enabled = next; generation++; cancelTimer(); attempts = 0; release();
    if (next) void take(); else changed({ phase: 'disabled' });
  }
  return { setEnabled, retry: () => retry(), wake: () => retry(false), dispose() { setEnabled(false); disposed = true; } };
}
