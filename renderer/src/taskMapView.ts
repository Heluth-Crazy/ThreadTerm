import type { TaskMapCopy, TaskMapStatus } from './taskMapTypes';

/** The consistent, bilingual label used by map nodes, lanes and the inspector. */
export function taskMapStatusLabel(status: TaskMapStatus, copy: TaskMapCopy): string {
  if (status === 'running') return copy('Running', '运行中');
  if (status === 'waiting') return copy('Waiting for you', '等待你操作');
  if (status === 'failed') return copy('Failed', '失败');
  if (status === 'cancelled') return copy('Cancelled', '已取消');
  return copy('Done', '完成');
}

export interface RebuildScheduler {
  schedule(): void;
  flush(): void;
  dispose(): void;
}

/** Coalesce bursts of updates without leaving a timer alive after disposal. */
export function createRebuildScheduler(delayMs: number, run: () => void): RebuildScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const invoke = () => {
    timer = undefined;
    if (!disposed) run();
  };
  return {
    schedule() {
      if (!disposed && timer === undefined) timer = setTimeout(invoke, Math.max(0, delayMs));
    },
    flush() {
      if (disposed || timer === undefined) return;
      clearTimeout(timer);
      invoke();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
