export type ProcessReading = { pid: number; started: string; cpuSeconds?: number; memoryBytes: number };

export class ResourceUsage {
  private previous?: { time: number; cpu: Map<string, number> };

  measure(readings: ProcessReading[], time: number, logicalCores: number) {
    const prior = this.previous;
    const cpu = new Map<string, number>();
    const seen = new Set<number>();
    let memoryBytes = 0;
    let cpuSeconds = 0;
    let missingCpu = false;
    let matched = false;
    for (const { pid, started, cpuSeconds: total, memoryBytes: memory } of readings) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      memoryBytes += memory;
      if (total === undefined) {
        missingCpu = true;
        continue;
      }
      const key = `${pid}:${started}`;
      cpu.set(key, total);
      const before = prior?.cpu.get(key);
      if (before !== undefined && total >= before) {
        matched = true;
        cpuSeconds += total - before;
      }
    }
    this.previous = { time, cpu };
    const elapsed = prior ? time - prior.time : 0;
    const cpuPercent = !missingCpu && matched && elapsed > 0 && elapsed < 10_000
      ? Math.min(100, cpuSeconds * 100_000 / (elapsed * logicalCores))
      : undefined;
    return { cpuPercent, memoryBytes };
  }
}
