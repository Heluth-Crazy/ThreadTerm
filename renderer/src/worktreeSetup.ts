import type { Session, WorktreeSetupRun } from '@threadterm/protocol';
import { sameCanonicalScope } from './projectScope';

export type WorktreeSetupAction = 'open'|'retry'|'run';

export function setupForRoot(runs: readonly WorktreeSetupRun[], root: string): WorktreeSetupRun | undefined {
 return runs.filter(run => sameCanonicalScope(run.root, root)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))[0];
}

export function setupStepLabel(run: WorktreeSetupRun, zh: boolean): string {
 const name = run.names[run.step] ?? run.commandIds[run.step] ?? (zh ? '命令' : 'command');
 return `${run.step + 1}/${run.commandIds.length} · ${name}`;
}

export function setupStatusLine(run: WorktreeSetupRun, zh: boolean): string {
 const step = setupStepLabel(run, zh);
 switch (run.state) {
  case 'running': return zh ? `正在初始化 · ${step}` : `Setting up · ${step}`;
  case 'completed': return zh ? '已初始化' : 'Set up';
  case 'failed': { const name = run.names[run.step] ?? run.commandIds[run.step] ?? (zh ? '命令' : 'command'); return run.exitCode === undefined ? (zh ? `初始化失败：${name}` : `Setup failed at ${name}`) : (zh ? `初始化失败：${name}（退出码 ${run.exitCode}）` : `Setup failed at ${name} (exit ${run.exitCode})`); }
  case 'cancelled': return zh ? '初始化已取消' : 'Setup cancelled';
  case 'interrupted': return zh ? '初始化已中断' : 'Setup interrupted';
 }
}

export function setupCurrentSessionId(run: WorktreeSetupRun | undefined, sessions: readonly Session[]): string | undefined {
 return run ? sessions.find(session => session.run?.setup?.runId === run.id && session.run.setup.step === run.step)?.id : undefined;
}

export function setupActions(run: WorktreeSetupRun, currentSessionId?: string): readonly WorktreeSetupAction[] {
 if (run.state === 'running') return currentSessionId ? ['open'] : [];
 if (run.state === 'failed') return currentSessionId ? ['open', 'retry', 'run'] : ['retry', 'run'];
 return ['run'];
}
