import type { Session, WorktreeSetupRun } from '@threadterm/protocol';
import { sameCanonicalScope } from './projectScope';

/** The reserved launch port is useful before the readiness watcher has observed it. */
export function allocatedRunPort(session: Pick<Session, 'run'>): number | undefined {
 // An allocated ${port} is the run's port. Otherwise the readiness port is shown only while it is the
 // run's address, so `:port` never contradicts a URL the run printed itself.
 return session.run?.allocatedPort ?? (session.run?.urlSource === 'port' ? session.run.port : undefined);
}

type SequenceRun = WorktreeSetupRun & { error?: string };

/** The setup panel owns setup runs only; dependency sequences are presented beside their command. */
export function setupRunForRoot(runs: readonly SequenceRun[], root: string): WorktreeSetupRun | undefined {
 return runs.filter(run => run.trigger !== 'depends_on' && sameCanonicalScope(run.root, root))
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0];
}

/** A compact, localized progress chip for an active dependency chain. */
export function sequenceChipText(run: SequenceRun | undefined, zh: boolean): string | undefined {
 if (!run || run.trigger !== 'depends_on') return undefined;
 const name = run.names[run.step] ?? run.names.at(-1) ?? (zh ? '命令' : 'command');
 const progress = `${Math.min(run.step + 1, run.commandIds.length)}/${run.commandIds.length}`;
 if (run.state === 'running') return zh ? `正在启动 ${name}（${progress}）…` : `Starting ${name} (${progress})…`;
 if (run.state === 'failed') {
  const failed = run.error?.replace(/^dependency_failed:\s*/, '') || name;
  return zh ? `依赖失败：${failed}` : `Dependency failed: ${failed}`;
 }
 return undefined;
}

export function activeSequenceForCommand(runs: readonly SequenceRun[], root: string, commandId: string): SequenceRun | undefined {
 return runs.filter(run => run.trigger === 'depends_on' && run.targetCommandId === commandId && ['running','failed'].includes(run.state) && sameCanonicalScope(run.root, root))
  .sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt)||right.createdAt.localeCompare(left.createdAt))[0];
}
