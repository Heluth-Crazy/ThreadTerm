import { useEffect, useRef, useState } from 'react';
import { request, operationId } from '../bridge';
import { conflictStageReason } from '../workbench/conflictStage';
import { workbenchError } from '../workbench/errors';
import type { WorkbenchScope } from '../workbench/types';
import { useConflictStates } from './useConflictStates';
import { useConflictStageGuard } from './useConflictStageGuard';

export function ConflictStageAction({ scope, path, revision, disabled, zh, onStaged }: {
  scope: Pick<WorkbenchScope, 'projectId' | 'worktreePath'>; path: string; revision: unknown;
  disabled: boolean; zh: boolean; onStaged: () => void;
}) {
  const states = useConflictStates(scope, [path], revision);
  const guard = useConflictStageGuard(scope, zh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const key = JSON.stringify([scope.projectId, scope.worktreePath, path]);
  const liveKey = useRef(key);
  liveKey.current = key;
  useEffect(() => () => { liveKey.current = ''; }, []);
  useEffect(() => { setError(undefined); }, [key]);
  const reason = conflictStageReason(states[path], zh);
  const stage = async () => {
    setBusy(true); setError(undefined);
    try {
      const expectedFingerprints = await guard.check([path]);
      if (!expectedFingerprints || liveKey.current !== key) return;
      await request('git.stage', { ...scope, paths: [path], ...(Object.keys(expectedFingerprints).length ? { expectedFingerprints } : {}), operationId: operationId() });
      if (liveKey.current === key) onStaged();
    } catch (error) { if (liveKey.current === key) setError(workbenchError(error, zh)); }
    finally { if (liveKey.current === key) setBusy(false); }
  };
  return <>
    <button type="button" className="btn btn-sm" disabled={disabled || busy || !!reason} title={reason} onClick={() => void stage()}>{zh ? '标记已解决（暂存）' : 'Mark resolved (stage)'}</button>
    {error && <span role="alert">{error}</span>}
    {guard.dialog}
  </>;
}
