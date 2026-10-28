import { useEffect, useRef, useState } from 'react';
import { malformedConflictWarning, reviewConflictStage, unknownConflictWarning, type ConflictSavedState } from '../workbench/conflictStage';
import type { WorkbenchScope } from '../workbench/types';
import { SurfaceDialog } from './SurfaceDialog';
import { request } from '../bridge';
import { isConflict } from '../workbench/gitDecorations';

/** One confirmation flow shared by whole-file, batch and hunk staging. */
export function useConflictStageGuard(scope: Pick<WorkbenchScope, 'projectId' | 'worktreePath'>, zh: boolean) {
  const key = JSON.stringify([scope.projectId, scope.worktreePath]);
  const live = useRef({key, epoch:0});
  if (live.current.key !== key) live.current = {key, epoch:live.current.epoch + 1};
  const [pending, setPending] = useState<{epoch:number; warnings:Record<string,ConflictSavedState>}>();
  const waiter = useRef<((accepted:boolean)=>void) | undefined>(undefined);
  useEffect(() => () => { live.current.epoch++; waiter.current?.(false); waiter.current=undefined; }, [key]);
  const settle = (accepted:boolean) => { waiter.current?.(accepted); waiter.current=undefined; setPending(undefined); };
  const check = async (paths:readonly string[], knownConflicts:readonly string[] = paths) => {
    if (waiter.current) return undefined;
    const epoch=live.current.epoch;
    if (!paths.length) return {};
    const status = await request('git.status', {projectId:scope.projectId, worktreePath:scope.worktreePath});
    if (epoch !== live.current.epoch) return undefined;
    const conflicted = new Set([...knownConflicts, ...status.changes.filter(isConflict).map(change=>change.path)]);
    const checkedPaths = paths.filter(path=>conflicted.has(path));
    let reviewed = await reviewConflictStage(scope, checkedPaths, zh);
    if (epoch !== live.current.epoch) return undefined;
    while (Object.keys(reviewed.warnings).length) {
      const warnings=reviewed.warnings;
      const accepted = await new Promise<boolean>(resolve => { waiter.current=resolve; setPending({epoch,warnings}); });
      if (!accepted || epoch !== live.current.epoch) return undefined;
      reviewed=await reviewConflictStage(scope, checkedPaths, zh, warnings);
      if (epoch !== live.current.epoch) return undefined;
    }
    return reviewed.fingerprints;
  };
  const dialog = pending && pending.epoch === live.current.epoch ? <SurfaceDialog size="sm"
    title={zh ? '仍要暂存此文件？' : 'Stage anyway?'} subtitle={Object.keys(pending.warnings).join(', ')} onClose={() => settle(false)}
    footer={<><button className="btn" onClick={() => settle(false)}>{zh ? '取消' : 'Cancel'}</button><button className="btn btn-primary" onClick={() => settle(true)}>{zh ? '仍然暂存' : 'Stage anyway'}</button></>}>
    {Object.values(pending.warnings).some(state=>state.kind==='unknown') && <p role="alert">{unknownConflictWarning(zh)}</p>}
    {Object.values(pending.warnings).some(state=>state.kind==='unparseable') && <p role="alert">{malformedConflictWarning(zh)}</p>}
  </SurfaceDialog> : null;
  return {check, dialog};
}
