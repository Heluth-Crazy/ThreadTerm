import type { ProviderSessionLaunchAction } from '../components/terminal/providerSession';
import type { AgentSessionProvider } from './agentSession';
import type { TerminalExecutionMode } from './terminal';

/** Optional process-at-creation launch data shared with the Rust PTY API. */
export interface PtyLaunchDescriptor {
  executionMode?: TerminalExecutionMode;
  command?: string;
}

export type PtyStartupSideEffectPlan =
  | { kind: 'bind'; providerSessionId: string }
  | { kind: 'discover' };

export type PtyStartupIntent =
  | { kind: 'none' }
  | { kind: 'oneShot'; descriptor: PtyLaunchDescriptor }
  | {
      kind: 'provider';
      provider: AgentSessionProvider;
      command: string;
      cardId: string;
      action: ProviderSessionLaunchAction;
      sideEffectPlan: PtyStartupSideEffectPlan;
    };

export interface PtyCreateSessionV2Request {
  id: string;
  workingDir: string;
  rows: number;
  cols: number;
  launchAttemptId?: string;
  startup: PtyStartupIntent;
}

export type PtyShellFamily = 'pwsh' | 'windowsPowerShell' | 'cmd' | 'posix';

export type PtyStartupState =
  | 'notRequired'
  | 'waiting'
  | 'ready'
  | 'timedOut'
  | 'dispatching'
  | 'sent'
  | 'cancelled'
  | 'failed';

export type PtyStartupTrigger =
  | 'marker'
  | 'firstOutput'
  | 'timeout'
  | 'immediate'
  | 'ptyExit'
  | 'killed';

export interface PtyStartupSnapshot {
  ptyId: string;
  generation: string;
  revision: number;
  state: PtyStartupState;
  trigger?: PtyStartupTrigger;
}

export type PtyCreateSessionV2Disposition = 'created' | 'attached';

export type PtyStartupDescriptorDisposition =
  | 'accepted'
  | 'matched'
  | 'legacyClaimed'
  | 'notApplicable';

export interface PtyCreateSessionV2Result {
  ptyId: string;
  generation: string;
  disposition: PtyCreateSessionV2Disposition;
  shellFamily: PtyShellFamily;
  descriptorDisposition: PtyStartupDescriptorDisposition;
  startup: PtyStartupSnapshot;
}

export type PtyProviderStartupIntent = Extract<PtyStartupIntent, { kind: 'provider' }>;
