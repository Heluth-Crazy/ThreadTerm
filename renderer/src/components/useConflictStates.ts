import { useEffect, useRef, useState } from 'react';
import { FILES_CHANGED_EVENT, type WorkbenchScope } from '../workbench/types';
import { readConflictState, type ConflictSavedState } from '../workbench/conflictStage';
import { ConflictRefreshDebouncer, MAX_CONFLICT_STATE_PATHS, conflictStateScheduler, eventTouchesPaths, shouldDebounceConflictRefresh } from './conflictStateScan';

const PATHLESS_REFRESH_DELAY_MS = 300;

/** Refresh on saved-file notifications and status polling; ignore old scope/read responses. */
export function useConflictStates(scope: Pick<WorkbenchScope, 'projectId' | 'worktreePath'>, paths: string[], revision: unknown) {
  const key = JSON.stringify([scope.projectId, scope.worktreePath, paths]);
  const [snapshot, setSnapshot] = useState<{ key: string; states: Record<string, ConflictSavedState> }>({ key: '', states: {} });
  const generation = useRef(0);
  const previousKey = useRef<string | undefined>(undefined);
  const refreshRef = useRef<() => void>(() => {});
  const debouncer = useRef<ConflictRefreshDebouncer | undefined>(undefined);
  if (!debouncer.current) debouncer.current = new ConflictRefreshDebouncer(PATHLESS_REFRESH_DELAY_MS);
  useEffect(() => () => { debouncer.current?.cancel(); }, []);
  useEffect(() => {
    let alive = true;
    const checking = () => setSnapshot({key, states:Object.fromEntries(paths.slice(MAX_CONFLICT_STATE_PATHS).map(path=>[path,{kind:'unknown'} as ConflictSavedState]))});
    const refresh = async () => {
      debouncer.current?.cancel();
      const ticket = ++generation.current;
      checking();
      const states = await conflictStateScheduler.scan(paths, path => readConflictState(scope, path), () => alive && ticket === generation.current);
      if (alive && ticket === generation.current) setSnapshot({ key, states });
    };
    refreshRef.current = () => { void refresh(); };
    const defer = () => {
      // Invalidate queued reads now, rather than when the timer eventually fires.
      generation.current++;
      checking();
      debouncer.current?.schedule(() => refreshRef.current());
    };
    if (previousKey.current !== key) { previousKey.current = key; void refresh(); }
    else defer();
    const changed = (event: Event) => {
      if (!eventTouchesPaths(event, paths)) return;
      if (!shouldDebounceConflictRefresh(event, paths)) void refresh();
      else defer();
    };
    addEventListener(FILES_CHANGED_EVENT, changed);
    return () => { alive = false; removeEventListener(FILES_CHANGED_EVENT, changed); };
  }, [key, revision]);
  return snapshot.key === key ? snapshot.states : {};
}
